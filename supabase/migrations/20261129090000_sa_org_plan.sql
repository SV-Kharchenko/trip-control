-- Apply manually after review. This file is not applied to any database by the agent.
-- Кабінет суперадміна: перемикач тарифу компанії («Сайт» = company / «Контроль+» = control_plus) із записом у platform_audit_log.
-- * public.sa_set_org_plan(p_org, p_plan) — лише суперадмін (is_platform_superadmin()); повторне те саме значення нічого не пише.
-- * sa_search_orgs і sa_get_org додатково повертають organizations.plan (решта полів і поведінка без змін).
-- * public.set_org_plan (service_role) і її гранти НЕ змінюються. Оплата (org_subscriptions.paid_until) і тариф лишаються незалежними.
-- * kp_guard_org_plan: клієнтським ролям зміна plan заборонена й далі; єдиний виняток — виклик із sa_set_org_plan (транзакційний прапорець
--   + is_platform_superadmin()), бо SECURITY DEFINER не змінює роль сесії (current_setting('role') лишається authenticated).
-- Ідемпотентно (CREATE OR REPLACE / DROP IF EXISTS), усі UPDATE із явним WHERE.

-- 1. Тригер-страж плану: та сама логіка + виняток для sa_set_org_plan.
CREATE OR REPLACE FUNCTION public.kp_guard_org_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client boolean := public.kp_is_client_role();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_client THEN
      NEW.plan := 'company';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan AND v_client
     AND NOT (coalesce(current_setting('kp.sa_plan_org', true), '') = NEW.id::text AND public.is_platform_superadmin()) THEN
    RAISE EXCEPTION 'PLAN_SERVICE_ROLE_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_guard_org_plan() FROM PUBLIC, anon, authenticated, service_role;

-- 2. Зміна тарифу.
CREATE OR REPLACE FUNCTION public.sa_set_org_plan(p_org uuid, p_plan text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old text;
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('company', 'control_plus') THEN
    RAISE EXCEPTION 'SA_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT o.plan INTO v_old FROM public.organizations AS o WHERE o.id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SA_ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_old IS DISTINCT FROM p_plan THEN
    PERFORM set_config('kp.sa_plan_org', p_org::text, true);
    UPDATE public.organizations SET plan = p_plan WHERE id = p_org;
    PERFORM set_config('kp.sa_plan_org', '', true);
    PERFORM public.sa_audit('org.plan.set', 'organization', p_org::text, jsonb_build_object('plan', v_old), jsonb_build_object('plan', p_plan));
  END IF;
  RETURN jsonb_build_object('org_id', p_org, 'plan', p_plan);
END;
$$;

REVOKE ALL ON FUNCTION public.sa_set_org_plan(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_set_org_plan(uuid, text) TO authenticated;

-- 3. Список компаній із тарифом (змінюється RETURNS TABLE → DROP + CREATE).
DROP FUNCTION IF EXISTS public.sa_search_orgs(text, integer, integer);
CREATE FUNCTION public.sa_search_orgs(p_q text DEFAULT '', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, name text, edrpou text, legal_form text, members integer, created_at timestamptz, features jsonb, plan text, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH base AS (
    SELECT o.id, o.name, coalesce(nullif(r.edrpou, ''), nullif(c.edrpou, '')) AS edrpou, coalesce(nullif(r.legal_form, ''), nullif(c.ownership, '')) AS legal_form,
           (SELECT count(*)::integer FROM public.profiles AS p WHERE p.org_id = o.id AND p.member_status = 'active') AS members,
           o.created_at, o.features, o.plan
    FROM public.organizations AS o
    LEFT JOIN public.kp_org_requisites AS r ON r.org_id = o.id
    LEFT JOIN public.org_company_profiles AS c ON c.org_id = o.id
  ), hit AS (
    SELECT b.* FROM base AS b
    WHERE v_q = '' OR position(v_q IN lower(coalesce(b.name, ''))) > 0 OR (length(v_digits) >= 3 AND position(v_digits IN coalesce(b.edrpou, '')) > 0)
  )
  SELECT h.id, h.name, h.edrpou, h.legal_form, h.members, h.created_at, h.features, h.plan, count(*) OVER ()
  FROM hit AS h
  ORDER BY lower(coalesce(h.name, '')), h.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.sa_search_orgs(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_search_orgs(text, integer, integer) TO authenticated;

-- 4. Компанія з тарифом (сигнатура та сама → CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.sa_get_org(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org public.organizations%ROWTYPE;
  v_modules jsonb;
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_org FROM public.organizations AS o WHERE o.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SA_ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'global_enabled', s.enabled, 'org_enabled', coalesce(v_org.features ->> s.key = 'true', false)) ORDER BY s.key), '[]'::jsonb)
  INTO v_modules FROM public.app_settings AS s;
  RETURN jsonb_build_object(
    'id', v_org.id, 'name', v_org.name, 'created_at', v_org.created_at, 'features', v_org.features, 'plan', v_org.plan, 'modules', v_modules,
    'edrpou', (SELECT coalesce(nullif(r.edrpou, ''), nullif(c.edrpou, '')) FROM (SELECT 1) AS x
               LEFT JOIN public.kp_org_requisites AS r ON r.org_id = v_org.id LEFT JOIN public.org_company_profiles AS c ON c.org_id = v_org.id),
    'legal_form', (SELECT coalesce(nullif(r.legal_form, ''), nullif(c.ownership, '')) FROM (SELECT 1) AS x
                   LEFT JOIN public.kp_org_requisites AS r ON r.org_id = v_org.id LEFT JOIN public.org_company_profiles AS c ON c.org_id = v_org.id),
    'members', (SELECT count(*) FROM public.profiles AS p WHERE p.org_id = v_org.id AND p.member_status = 'active')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sa_get_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_get_org(uuid) TO authenticated;
