-- TRIP-CONTROL week-1 security: RLS + demo save limit + usage RPC
-- Apply in Supabase Dashboard → SQL Editor (or `supabase db push`).
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_is_approved()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT is_approved FROM public.profiles WHERE id = auth.uid() LIMIT 1), false);
$$;

REVOKE ALL ON FUNCTION public.current_is_approved() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_is_approved() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Protect privileged profile / org columns (client cannot self-approve)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.is_service_role() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.is_approved IS DISTINCT FROM OLD.is_approved
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'profiles: role / is_approved / org_id змінює лише service_role'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileges ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileges
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileges();

CREATE OR REPLACE FUNCTION public.protect_org_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.is_service_role() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'organizations: status змінює лише service_role'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_org_privileges ON public.organizations;
CREATE TRIGGER trg_protect_org_privileges
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.protect_org_privileges();

-- ---------------------------------------------------------------------------
-- Calculations: force own org + demo save cap (server-side, not client isDemo)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.calculations_enforce_owner_and_demo_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_cnt int;
  v_limit int := 3;
BEGIN
  IF public.is_service_role() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'calculations: потрібна авторизація' USING ERRCODE = '42501';
  END IF;

  SELECT org_id INTO v_org FROM public.profiles WHERE id = auth.uid();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'calculations: профіль без org_id' USING ERRCODE = '42501';
  END IF;

  NEW.user_id := auth.uid();
  NEW.org_id := v_org;

  IF NOT public.current_is_approved() THEN
    SELECT count(*)::int INTO v_cnt
    FROM public.calculations
    WHERE org_id = v_org;
    IF v_cnt >= v_limit THEN
      RAISE EXCEPTION 'DEMO_SAVE_LIMIT'
        USING ERRCODE = 'P0001',
              DETAIL = format('Демо: максимум %s збережених розрахунків', v_limit);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_calculations_enforce_owner_and_demo_limit ON public.calculations;
CREATE TRIGGER trg_calculations_enforce_owner_and_demo_limit
  BEFORE INSERT ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_enforce_owner_and_demo_limit();

-- ---------------------------------------------------------------------------
-- Daily demo calc counter (used by /api/calculate via service_role)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS usage_counters_org_day_uidx
  ON public.usage_counters (org_id, day);

CREATE OR REPLACE FUNCTION public.bump_calc_usage(p_org uuid, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day date := (timezone('Europe/Kyiv', now()))::date;
  v_count integer;
BEGIN
  IF p_org IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RETURN false;
  END IF;

  INSERT INTO public.usage_counters (org_id, day, calc_count)
  VALUES (p_org, v_day, 1)
  ON CONFLICT (org_id, day)
  DO UPDATE
    SET calc_count = public.usage_counters.calc_count + 1
    WHERE public.usage_counters.calc_count < p_limit
  RETURNING calc_count INTO v_count;

  IF v_count IS NULL THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_calc_usage(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_calc_usage(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS + drop common wide-open wizard policies (if any)
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.usage_counters ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('profiles', 'organizations', 'company_settings', 'calculations', 'usage_counters')
      AND policyname IN (
        'Enable read access for all users',
        'Enable insert for authenticated users only',
        'Enable update for users based on email',
        'Enable delete for users based on email',
        'Allow all for authenticated'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS profiles_update_own_safe ON public.profiles;
CREATE POLICY profiles_update_own_safe ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- INSERT/DELETE: немає політики для authenticated → заборонено (signup через trigger/service_role)

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS organizations_select_own ON public.organizations;
CREATE POLICY organizations_select_own ON public.organizations
  FOR SELECT TO authenticated
  USING (id = public.current_org_id());

DROP POLICY IF EXISTS organizations_update_own ON public.organizations;
CREATE POLICY organizations_update_own ON public.organizations
  FOR UPDATE TO authenticated
  USING (id = public.current_org_id())
  WITH CHECK (id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- company_settings
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS company_settings_select_own ON public.company_settings;
CREATE POLICY company_settings_select_own ON public.company_settings
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

DROP POLICY IF EXISTS company_settings_insert_own ON public.company_settings;
CREATE POLICY company_settings_insert_own ON public.company_settings
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());

DROP POLICY IF EXISTS company_settings_update_own ON public.company_settings;
CREATE POLICY company_settings_update_own ON public.company_settings
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- calculations
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS calculations_select_own_org ON public.calculations;
CREATE POLICY calculations_select_own_org ON public.calculations
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

DROP POLICY IF EXISTS calculations_insert_own_org ON public.calculations;
CREATE POLICY calculations_insert_own_org ON public.calculations
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());

DROP POLICY IF EXISTS calculations_update_own_org ON public.calculations;
CREATE POLICY calculations_update_own_org ON public.calculations
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());

DROP POLICY IF EXISTS calculations_delete_own_org ON public.calculations;
CREATE POLICY calculations_delete_own_org ON public.calculations
  FOR DELETE TO authenticated
  USING (org_id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- usage_counters: read own org only; writes only via bump_calc_usage (service_role)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS usage_counters_select_own ON public.usage_counters;
CREATE POLICY usage_counters_select_own ON public.usage_counters
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

-- no INSERT/UPDATE/DELETE policies for authenticated
