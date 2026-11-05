-- Apply manually after review. This file is not applied to production by the agent.
--
-- Кабінет суперадміна платформи (Контроль+). Суперадмін — НЕ роль організації, а окрема сутність платформи.
--
-- * platform_admins(user_id, created_at): заповнюється ЛИШЕ вручну SQL (docs/SUPERADMIN.md). Без UI, без RPC на додавання, без політик і грантів
--   для anon / authenticated. Ця міграція нікого в таблицю не вписує.
-- * is_platform_superadmin(): чи поточний користувач у platform_admins. Назва навмисно НЕ is_platform_admin(): така функція вже є (профіль із
--   role = 'admin', адмін-CRM сайту) і використовується в політиках RLS; її семантику не змінюємо.
-- * RPC кабінету sa_*: першим рядком перевіряють is_platform_superadmin() (інакше 42501), SECURITY DEFINER, search_path = public, без доступу
--   anon / PUBLIC. Кожна зміна пише platform_audit_log (хто, що, до / після). Ключ модуля — лише з app_settings (довільні ключі не приймаються).
-- * Дій, окрім перемикання модулів (глобально й для компанії), у кабінеті немає: ні видалення компаній, ні зміни користувачів, ні перегляду їхніх даних.
-- * app_settings.updated_by — хто востаннє змінив глобальний перемикач. Рядок own_fleet додається як вимкнений (так само, як «немає рядка»).
--
-- Лише адитивно: нові таблиці й функції, колонка app_settings.updated_by, рядок-засів вимкненого модуля. Ідемпотентно.

CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  admin_id uuid NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before jsonb NULL,
  after jsonb NULL
);

CREATE INDEX IF NOT EXISTS platform_audit_log_at_idx ON public.platform_audit_log (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS platform_audit_log_type_idx ON public.platform_audit_log (target_type, at DESC);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_admins FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.platform_audit_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.platform_admins TO service_role;
GRANT ALL ON public.platform_audit_log TO service_role;
GRANT USAGE ON SEQUENCE public.platform_audit_log_id_seq TO service_role;

ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS updated_by uuid NULL;
INSERT INTO public.app_settings (key, enabled) VALUES ('own_fleet', false) ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_platform_superadmin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins AS a WHERE a.user_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION public.is_platform_superadmin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_superadmin() TO authenticated, service_role;

-- Запис журналу (внутрішня функція, клієнтам недоступна).
CREATE OR REPLACE FUNCTION public.sa_audit(p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.platform_audit_log (admin_id, action, target_type, target_id, before, after)
  VALUES (auth.uid(), p_action, p_target_type, p_target_id, p_before, p_after);
$$;

REVOKE ALL ON FUNCTION public.sa_audit(text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- 1. Глобальні перемикачі модулів.
CREATE OR REPLACE FUNCTION public.sa_list_settings()
RETURNS TABLE (key text, enabled boolean, updated_at timestamptz, updated_by uuid, updated_by_email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.key, s.enabled, s.updated_at, s.updated_by, u.email::text
  FROM public.app_settings AS s
  LEFT JOIN auth.users AS u ON u.id = s.updated_by
  ORDER BY s.key;
END;
$$;

CREATE OR REPLACE FUNCTION public.sa_set_setting(p_key text, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old boolean;
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'SA_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT s.enabled INTO v_old FROM public.app_settings AS s WHERE s.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SA_UNKNOWN_MODULE' USING ERRCODE = 'P0001';
  END IF;
  IF v_old IS DISTINCT FROM p_enabled THEN
    UPDATE public.app_settings SET enabled = p_enabled, updated_by = auth.uid() WHERE key = p_key;
    PERFORM public.sa_audit('setting.set', 'app_setting', p_key, jsonb_build_object('enabled', v_old), jsonb_build_object('enabled', p_enabled));
  END IF;
  RETURN jsonb_build_object('key', p_key, 'enabled', p_enabled, 'changed', v_old IS DISTINCT FROM p_enabled);
END;
$$;

-- 2. Компанії.
CREATE OR REPLACE FUNCTION public.sa_search_orgs(p_q text DEFAULT '', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, name text, edrpou text, legal_form text, members integer, created_at timestamptz, features jsonb, total bigint)
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
           o.created_at, o.features
    FROM public.organizations AS o
    LEFT JOIN public.kp_org_requisites AS r ON r.org_id = o.id
    LEFT JOIN public.org_company_profiles AS c ON c.org_id = o.id
  ), hit AS (
    SELECT b.* FROM base AS b
    WHERE v_q = '' OR position(v_q IN lower(coalesce(b.name, ''))) > 0 OR (length(v_digits) >= 3 AND position(v_digits IN coalesce(b.edrpou, '')) > 0)
  )
  SELECT h.id, h.name, h.edrpou, h.legal_form, h.members, h.created_at, h.features, count(*) OVER ()
  FROM hit AS h
  ORDER BY lower(coalesce(h.name, '')), h.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

-- Компанія з її прапорцями й станом глобальних перемикачів (для вікна компанії).
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
    'id', v_org.id, 'name', v_org.name, 'created_at', v_org.created_at, 'features', v_org.features, 'modules', v_modules,
    'edrpou', (SELECT coalesce(nullif(r.edrpou, ''), nullif(c.edrpou, '')) FROM (SELECT 1) AS x
               LEFT JOIN public.kp_org_requisites AS r ON r.org_id = v_org.id LEFT JOIN public.org_company_profiles AS c ON c.org_id = v_org.id),
    'legal_form', (SELECT coalesce(nullif(r.legal_form, ''), nullif(c.ownership, '')) FROM (SELECT 1) AS x
                   LEFT JOIN public.kp_org_requisites AS r ON r.org_id = v_org.id LEFT JOIN public.org_company_profiles AS c ON c.org_id = v_org.id),
    'members', (SELECT count(*) FROM public.profiles AS p WHERE p.org_id = v_org.id AND p.member_status = 'active')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sa_set_org_feature(p_org uuid, p_key text, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_features jsonb;
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'SA_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_settings AS s WHERE s.key = p_key) THEN
    RAISE EXCEPTION 'SA_UNKNOWN_MODULE' USING ERRCODE = 'P0001';
  END IF;
  SELECT o.features INTO v_features FROM public.organizations AS o WHERE o.id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SA_ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_old := v_features -> p_key;
  IF coalesce(v_features ->> p_key = 'true', false) IS DISTINCT FROM p_enabled THEN
    UPDATE public.organizations SET features = jsonb_set(v_features, ARRAY[p_key], to_jsonb(p_enabled), true) WHERE id = p_org;
    PERFORM public.sa_audit('org.feature.set', 'organization', p_org::text, jsonb_build_object(p_key, v_old), jsonb_build_object(p_key, to_jsonb(p_enabled)));
  END IF;
  RETURN jsonb_build_object('org_id', p_org, 'key', p_key, 'enabled', p_enabled);
END;
$$;

-- 3. Журнал (лише читання).
CREATE OR REPLACE FUNCTION public.sa_list_audit(
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_target_type text DEFAULT NULL, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS TABLE (id bigint, at timestamptz, admin_id uuid, admin_email text, action text, target_type text, target_id text, before jsonb, after jsonb, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT l.id, l.at, l.admin_id, u.email::text, l.action, l.target_type, l.target_id, l.before, l.after, count(*) OVER ()
  FROM public.platform_audit_log AS l
  LEFT JOIN auth.users AS u ON u.id = l.admin_id
  WHERE (p_from IS NULL OR l.at >= p_from) AND (p_to IS NULL OR l.at < p_to)
    AND (nullif(btrim(coalesce(p_target_type, '')), '') IS NULL OR l.target_type = btrim(p_target_type))
  ORDER BY l.at DESC, l.id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500)) OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.sa_list_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_set_setting(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_search_orgs(text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_get_org(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_set_org_feature(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_list_audit(timestamptz, timestamptz, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_list_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_set_setting(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_search_orgs(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_get_org(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_set_org_feature(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_list_audit(timestamptz, timestamptz, text, integer, integer) TO authenticated;

-- Якщо модуль «Власний парк» уже застосовано, його тригер protect_org_features забороняє змінювати organizations.features користувачам із JWT,
-- крім service_role / is_platform_admin(). Суперадміну (platform_admins) дозволяємо — інакше sa_set_org_feature (SECURITY DEFINER, але з JWT адміна)
-- не зміг би перемкнути прапорець. Решта умов тригера без змін.
DO $do$
BEGIN
  IF to_regprocedure('public.protect_org_features()') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.protect_org_features()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      BEGIN
        IF NEW.features IS DISTINCT FROM OLD.features
           AND auth.uid() IS NOT NULL AND NOT public.is_service_role() AND NOT public.is_platform_admin() AND NOT public.is_platform_superadmin() THEN
          RAISE EXCEPTION 'organizations: features are server-managed' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END;
      $body$
    $fn$;
  END IF;
END;
$do$;

-- Створити відсутній рядок app_settings (немає рядка = модуль вимкнено). Ключ — лише з відомих модулів платформи; довільні ключі не приймаються.
CREATE OR REPLACE FUNCTION public.sa_create_setting(p_key text, p_enabled boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL OR p_key IS NULL OR NOT (p_key = ANY (ARRAY['own_fleet'])) THEN
    RAISE EXCEPTION 'SA_UNKNOWN_MODULE' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_settings AS s WHERE s.key = p_key) THEN
    RAISE EXCEPTION 'SA_ALREADY_EXISTS' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.app_settings (key, enabled, updated_by) VALUES (p_key, p_enabled, auth.uid());
  PERFORM public.sa_audit('setting.create', 'app_setting', p_key, NULL, jsonb_build_object('enabled', p_enabled));
  RETURN jsonb_build_object('key', p_key, 'enabled', p_enabled);
END;
$$;
REVOKE ALL ON FUNCTION public.sa_create_setting(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_create_setting(text, boolean) TO authenticated;
