-- Security hardening. Review this file before applying it.
-- Do not apply to production until the owner says so.
--
-- anon currently inherits EXECUTE on several SECURITY DEFINER functions and
-- holds full table grants (including TRUNCATE) on company data. This migration
-- closes those grants, keeps one active owner, and locks function search_path.

-- ---------------------------------------------------------------------------
-- Audit writer: service role only. The profile trigger is SECURITY DEFINER
-- and runs as the function owner, so it can still record changes.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.write_security_audit(text, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_security_audit(text, text, text, uuid, jsonb)
  TO service_role;
ALTER FUNCTION public.write_security_audit(text, text, text, uuid, jsonb)
  SET search_path = public;

-- ---------------------------------------------------------------------------
-- Remaining SECURITY DEFINER helpers used by policies and triggers.
-- anon loses EXECUTE. authenticated keeps it, because RLS and triggers run
-- as the signed-in user.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;
ALTER FUNCTION public.is_platform_admin() SET search_path = public;

REVOKE ALL ON FUNCTION public.current_is_approved() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_is_approved() TO authenticated, service_role;
ALTER FUNCTION public.current_is_approved() SET search_path = public;

REVOKE ALL ON FUNCTION public.calculations_enforce_owner_and_demo_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculations_enforce_owner_and_demo_limit() TO authenticated, service_role;
ALTER FUNCTION public.calculations_enforce_owner_and_demo_limit() SET search_path = public;

REVOKE ALL ON FUNCTION public.audit_org_company_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_org_company_profiles() TO authenticated, service_role;
ALTER FUNCTION public.audit_org_company_profiles() SET search_path = public;

-- These three exist on production from earlier SQL that is not in this repo.
-- Skip them on a database that never had them.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.my_org_id()',
    'public.is_admin()',
    'public.enforce_demo_save_limit()'
  ]
  LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn);
    END IF;
  END LOOP;
END $$;

-- Dead signup function. The live auth.users trigger is handle_new_tripcontrol_user.
DROP FUNCTION IF EXISTS public.handle_new_user();

-- Any other public SECURITY DEFINER function keeps a fixed search_path.
DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Policies: one org check, current_org_id(). Drop the my_org_id / is_admin copy.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS usage_counters_select ON public.usage_counters;

DO $$
BEGIN
  IF to_regclass('public.trailer_presets') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS trailer_presets_all ON public.trailer_presets';
    EXECUTE $policy$
      CREATE POLICY trailer_presets_all ON public.trailer_presets
        FOR ALL TO authenticated
        USING (org_id = public.current_org_id())
        WITH CHECK (org_id = public.current_org_id())
    $policy$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- One active owner. Service role is not exempt: the team API uses it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_single_active_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_others integer;
BEGIN
  IF NEW.org_role IS DISTINCT FROM 'owner' OR NEW.member_status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.org_role = 'owner'
     AND OLD.member_status = 'active'
     AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id
  THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.organizations
  WHERE id = NEW.org_id
  FOR UPDATE;

  SELECT count(*)::integer
  INTO v_others
  FROM public.profiles
  WHERE org_id = NEW.org_id
    AND id IS DISTINCT FROM NEW.id
    AND org_role = 'owner'
    AND member_status = 'active';

  IF v_others >= 1 THEN
    RAISE EXCEPTION 'SECOND_ACTIVE_OWNER'
      USING ERRCODE = 'P0001',
            DETAIL = 'Organization already has an active owner';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_single_active_owner() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_enforce_single_active_owner ON public.profiles;
CREATE TRIGGER trg_enforce_single_active_owner
  BEFORE INSERT OR UPDATE OF org_role, member_status, org_id
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_active_owner();

-- ---------------------------------------------------------------------------
-- anon must not touch company profile, invites, templates, or the audit log.
-- authenticated grants stay as they are.
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE public.org_company_profiles FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.org_invites FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.route_templates FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.security_audit_log FROM PUBLIC, anon;
