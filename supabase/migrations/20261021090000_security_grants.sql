-- Function privileges and search_path (Supabase security advisor).
--
-- a) Trigger functions audit_org_company_profiles, calculations_enforce_owner_and_demo_limit and
--    enforce_demo_save_limit: no EXECUTE for PUBLIC / anon / authenticated. Postgres checks EXECUTE on a
--    trigger function when the trigger is created, not when it fires, so the triggers keep working.
-- b) SECURITY DEFINER helpers. RLS policies run as the signed-in user, so a helper used in a policy keeps
--    EXECUTE for authenticated. All policies are TO authenticated: anon needs none of them.
--      keep for authenticated (used in RLS policies): current_org_id, is_org_owner, is_platform_admin,
--        is_user_blocked, org_logists_see_all;
--      close for authenticated (no policy, view or SECURITY INVOKER function uses them, the client never
--        calls them through rpc): current_org_role, current_is_approved (both only called inside
--        SECURITY DEFINER functions, which run as the owner), is_admin, my_org_id (unused);
--      anon loses EXECUTE on all of them; service_role keeps it.
--    A guard runs first: if anything on the target database still references a helper that is closed here
--    (e.g. a production-only policy), the migration stops before changing anything.
-- c) touch_route_template(p_id): same body as in 20261016130000_user_block_rls.sql — it already updates
--    only a template of the caller's own company (org_id = current_org_id()), and a personal one only of
--    its owner; recreated here with search_path = '' so the check is in place whatever version runs now.
-- d) search_path = '' with fully qualified names (objects schema-qualified; built-ins such as coalesce,
--    operators and casts resolve from pg_catalog, which is always searched): is_service_role, tc_num (recreated), ua_today
--    (production-only, body not in the repo: search_path set and the function called once as a check —
--    a body that relies on unqualified names fails here and the migration does not apply).
--
-- my_org_id, is_admin, enforce_demo_save_limit and ua_today exist on production from SQL that is not in
-- the repo; each is skipped on a database that does not have it.
--
-- New file only. Idempotent. Not applied to production by this PR.

-- ---------------------------------------------------------------------------
-- Guard: nothing may still need the helpers closed for authenticated below.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_fn text;
  v_pattern text;
  v_uses text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['current_org_role', 'current_is_approved', 'is_admin', 'my_org_id'] LOOP
    v_pattern := '\m' || v_fn || '\s*\(';
    SELECT string_agg(x.what, ', ') INTO v_uses
    FROM (
      SELECT format('policy %I on %I.%I', p.policyname, p.schemaname, p.tablename) AS what
      FROM pg_catalog.pg_policies AS p
      WHERE coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') ~ v_pattern
      UNION ALL
      SELECT format('view %I.%I', v.schemaname, v.viewname)
      FROM pg_catalog.pg_views AS v
      WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema') AND v.definition ~ v_pattern
      UNION ALL
      SELECT format('security invoker function %s', f.oid::pg_catalog.regprocedure)
      FROM pg_catalog.pg_proc AS f
      JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
      WHERE n.nspname = 'public' AND NOT f.prosecdef AND f.proname <> v_fn AND f.prosrc ~ v_pattern
    ) AS x;
    IF v_uses IS NOT NULL THEN
      RAISE EXCEPTION 'public.%() is still used by: % — not closing it for authenticated', v_fn, v_uses;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- a) Trigger functions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.audit_org_company_profiles()',
    'public.calculations_enforce_owner_and_demo_limit()',
    'public.enforce_demo_save_limit()'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- b) SECURITY DEFINER helpers
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_fn text;
BEGIN
  -- Used in RLS policies: authenticated keeps EXECUTE, anon does not need it.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.current_org_id()',
    'public.is_org_owner()',
    'public.is_platform_admin()',
    'public.is_user_blocked()',
    'public.org_logists_see_all()'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn);
    END IF;
  END LOOP;

  -- Not used by policies, views or invoker functions, not called by the client: server only.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.current_org_role()',
    'public.current_is_approved()',
    'public.is_admin()',
    'public.my_org_id()'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- c) touch_route_template: only a template of the caller's own company
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_route_template(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_org uuid;
BEGIN
  IF public.is_user_blocked() THEN
    RAISE EXCEPTION 'USER_BLOCKED' USING ERRCODE = '42501';
  END IF;

  -- current_org_id(): active member of a non-blocked company only.
  v_org := public.current_org_id();
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Same rows the caller can see (route_templates_select): own company, company scope or own personal one.
  UPDATE public.route_templates
  SET use_count = use_count + 1,
      last_used_at = pg_catalog.now()
  WHERE id = p_id
    AND org_id = v_org
    AND (scope = 'company' OR owner_user_id = auth.uid())
  RETURNING use_count INTO v_count;

  IF v_count IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_route_template(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_route_template(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- d) search_path = '' with fully qualified names
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

CREATE OR REPLACE FUNCTION public.tc_num(p jsonb, k text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN coalesce(p, '{}'::jsonb) ->> k ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (p ->> k)::numeric
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.tc_num(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ua_today: production-only. Fix search_path on every overload and call the argument-less one as a check.
DO $$
DECLARE
  v_fn record;
  v_check date;
BEGIN
  FOR v_fn IN
    SELECT f.oid::pg_catalog.regprocedure AS sig, f.pronargs
    FROM pg_catalog.pg_proc AS f
    JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
    WHERE n.nspname = 'public' AND f.proname = 'ua_today'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %L', v_fn.sig, '');
    IF v_fn.pronargs = 0 THEN
      EXECUTE 'SELECT public.ua_today()::date' INTO v_check;
    END IF;
  END LOOP;
END;
$$;
