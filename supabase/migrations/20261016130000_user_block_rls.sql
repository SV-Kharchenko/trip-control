-- Per-user block at the database level. Review this file before applying it.
-- Do not apply to production until the owner says so.
--
-- The admin panel blocks a user with a Supabase Auth ban
-- (auth.users.banned_until). The ban stops new sign-ins and the /api routes
-- refuse the user, but an access token issued before the ban stays valid until
-- it expires (up to about an hour). With it the user could still write to the
-- tables straight through PostgREST. This migration closes that window:
--
--   1. public.is_user_blocked() is true while auth.uid() has an active ban.
--   2. Every data table the user writes to gets RESTRICTIVE policies for
--      INSERT, UPDATE and DELETE with NOT is_user_blocked(). Postgres ANDs a
--      restrictive policy with every permissive policy of the same command, so
--      this is the same as adding "AND NOT is_user_blocked()" to each existing
--      write policy, without copying their conditions here. SELECT is unchanged.
--   3. touch_route_template() is SECURITY DEFINER and skips RLS, so it checks
--      the block itself.
--
-- The block flag lives in auth.users, which users cannot write: the auth schema
-- is not exposed through PostgREST and app_metadata / banned_until are not
-- user-editable through GoTrue. profiles.role, is_approved, org_id, org_role and
-- member_status are already server-managed by trg_protect_profile_privileges;
-- this migration only checks that the trigger is still in place.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Block check
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_user_blocked()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT u.banned_until IS NOT NULL AND u.banned_until > now()
      FROM auth.users AS u
      WHERE u.id = auth.uid()
    ),
    false
  );
$$;

COMMENT ON FUNCTION public.is_user_blocked() IS
  'True while the signed-in user has an active Supabase Auth ban (admin: Заблоковано).';

REVOKE ALL ON FUNCTION public.is_user_blocked() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_user_blocked() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Restrictive write policies
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT name FROM unnest(ARRAY[
      'calculations',
      'calc_vehicles',
      'route_templates',
      'trip_actuals',
      'fleet_vehicles',
      'trailer_presets',
      'company_settings',
      'org_company_profiles',
      'org_invites',
      'weekly_reports',
      'usage_counters',
      'organizations',
      'profiles'
    ]) AS name
    UNION
    -- Any other public table that already lets signed-in users write,
    -- including tables created on production outside this repo.
    SELECT p.tablename
    FROM pg_policies AS p
    WHERE p.schemaname = 'public'
      AND p.permissive = 'PERMISSIVE'
      AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      AND p.roles && ARRAY['authenticated', 'public']::name[]
  LOOP
    IF to_regclass(format('public.%I', tbl)) IS NULL THEN
      RAISE NOTICE 'is_user_blocked: table public.% does not exist, skipped', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_not_blocked_insert', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated
         WITH CHECK (NOT (SELECT public.is_user_blocked()))',
      tbl || '_not_blocked_insert', tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_not_blocked_update', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated
         USING (NOT (SELECT public.is_user_blocked()))
         WITH CHECK (NOT (SELECT public.is_user_blocked()))',
      tbl || '_not_blocked_update', tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_not_blocked_delete', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated
         USING (NOT (SELECT public.is_user_blocked()))',
      tbl || '_not_blocked_delete', tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. SECURITY DEFINER writer callable by users
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_route_template(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF public.is_user_blocked() THEN
    RAISE EXCEPTION 'USER_BLOCKED' USING ERRCODE = '42501';
  END IF;

  IF auth.uid() IS NULL OR public.current_org_id() IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.route_templates
  SET use_count = use_count + 1,
      last_used_at = now()
  WHERE id = p_id
    AND org_id = public.current_org_id()
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
-- 4. Users cannot change their own privileged profile columns
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.profiles'::regclass
      AND tgname = 'trg_protect_profile_privileges'
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'trg_protect_profile_privileges is missing on public.profiles; apply 20261012114133_org_roles.sql first';
  END IF;
END $$;
