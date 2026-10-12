-- TRIP-CONTROL: solo/team mode and organization roles.
-- Apply after 20261008_week2_admin_auth_audit.sql.
-- Idempotent: safe to re-run. This file is reviewed locally and is not applied by the agent.

-- ---------------------------------------------------------------------------
-- Columns and checks
-- ---------------------------------------------------------------------------

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS work_mode text NOT NULL DEFAULT 'solo';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS org_role text NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS member_status text NOT NULL DEFAULT 'active';

UPDATE public.organizations
SET work_mode = 'solo'
WHERE work_mode IS NULL OR work_mode NOT IN ('solo', 'team');

UPDATE public.profiles
SET org_role = 'owner'
WHERE org_role IS NULL OR org_role NOT IN ('owner', 'manager', 'logist');

UPDATE public.profiles
SET member_status = 'active'
WHERE member_status IS NULL OR member_status NOT IN ('active', 'disabled');

UPDATE public.org_company_profiles
SET ownership = 'tov'
WHERE ownership IS DISTINCT FROM 'tov'
  AND lower(coalesce(ownership, '')) IN ('тов', 'tov');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_work_mode_check'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_work_mode_check
      CHECK (work_mode IN ('solo', 'team'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_org_role_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_org_role_check
      CHECK (org_role IN ('owner', 'manager', 'logist'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_member_status_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_member_status_check
      CHECK (member_status IN ('active', 'disabled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS profiles_org_members_idx
  ON public.profiles (org_id, member_status, org_role);

CREATE INDEX IF NOT EXISTS calculations_org_user_idx
  ON public.calculations (org_id, user_id);

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.org_id
  FROM public.profiles AS p
  JOIN public.organizations AS o ON o.id = p.org_id
  WHERE p.id = auth.uid()
    AND p.member_status = 'active'
    AND o.status <> 'blocked'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_org_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.org_role
  FROM public.profiles AS p
  JOIN public.organizations AS o ON o.id = p.org_id
  WHERE p.id = auth.uid()
    AND p.member_status = 'active'
    AND o.status <> 'blocked'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_org_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_org_role() = 'owner', false);
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_org_role() IN ('owner', 'manager'), false);
$$;

CREATE OR REPLACE FUNCTION public.org_logists_see_all()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (
      SELECT (settings ->> 'logists_see_all')::boolean
      FROM public.company_settings
      WHERE org_id = public.current_org_id()
      LIMIT 1
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.current_org_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_org_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_org_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_org_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.org_logists_see_all() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_org_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_owner() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.org_logists_see_all() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privileged-column and invariant protection
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

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.is_approved IS DISTINCT FROM OLD.is_approved
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.org_role IS DISTINCT FROM OLD.org_role
    OR NEW.member_status IS DISTINCT FROM OLD.member_status
  ) THEN
    RAISE EXCEPTION 'profiles: privileged columns are server-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_profile_privileges() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.protect_last_active_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_other_owners integer;
BEGIN
  IF OLD.org_role <> 'owner' OR OLD.member_status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- Moving a newly invited user away from the empty organization created by
  -- the signup trigger is handled by the trusted team API.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RETURN NEW;
  END IF;

  IF NEW.org_role = 'owner' AND NEW.member_status = 'active' THEN
    RETURN NEW;
  END IF;

  -- Serialize owner changes inside one organization. Without this lock two
  -- owners could demote each other concurrently and both pass the count.
  PERFORM 1
  FROM public.organizations
  WHERE id = OLD.org_id
  FOR UPDATE;

  SELECT count(*)::integer
  INTO v_other_owners
  FROM public.profiles
  WHERE org_id = OLD.org_id
    AND id <> OLD.id
    AND org_role = 'owner'
    AND member_status = 'active';

  IF v_other_owners = 0 THEN
    RAISE EXCEPTION 'LAST_ACTIVE_OWNER'
      USING ERRCODE = 'P0001',
            DETAIL = 'Organization must keep at least one active owner';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_last_active_owner() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_profile_privileges ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileges
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileges();

DROP TRIGGER IF EXISTS trg_protect_last_active_owner ON public.profiles;
CREATE TRIGGER trg_protect_last_active_owner
  BEFORE UPDATE OF org_id, org_role, member_status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_last_active_owner();

CREATE OR REPLACE FUNCTION public.protect_org_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_members integer;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NOT public.is_service_role() AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'organizations: id/status are server-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.work_mode IS DISTINCT FROM OLD.work_mode THEN
    IF NOT public.is_service_role() AND NOT public.is_org_owner() THEN
      RAISE EXCEPTION 'WORK_MODE_OWNER_ONLY' USING ERRCODE = '42501';
    END IF;

    IF NEW.work_mode = 'solo' THEN
      SELECT count(*)::integer
      INTO v_active_members
      FROM public.profiles
      WHERE org_id = OLD.id
        AND member_status = 'active';

      IF v_active_members > 1 THEN
        RAISE EXCEPTION 'SOLO_HAS_ACTIVE_MEMBERS'
          USING ERRCODE = 'P0001',
                DETAIL = 'Disable other active members before switching to solo';
      END IF;

      UPDATE public.org_invites
      SET revoked_at = now()
      WHERE org_id = OLD.id
        AND accepted_at IS NULL
        AND revoked_at IS NULL;
    END IF;

    IF NOT public.is_service_role() THEN
      INSERT INTO public.security_audit_log (
        actor, org_id, action, entity, entity_id, detail
      ) VALUES (
        auth.uid(), OLD.id, 'set_work_mode', 'organizations', OLD.id::text,
        jsonb_build_object('old', OLD.work_mode, 'new', NEW.work_mode)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_org_privileges() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_org_privileges ON public.organizations;
CREATE TRIGGER trg_protect_org_privileges
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.protect_org_privileges();

CREATE OR REPLACE FUNCTION public.protect_company_settings_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.is_service_role() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'company_settings: org_id is server-managed'
      USING ERRCODE = '42501';
  END IF;

  IF public.current_org_role() = 'manager'
     AND coalesce(NEW.settings -> 'logists_see_all', 'false'::jsonb)
         IS DISTINCT FROM
         coalesce(CASE WHEN TG_OP = 'UPDATE' THEN OLD.settings -> 'logists_see_all' END, 'false'::jsonb)
  THEN
    RAISE EXCEPTION 'LOGIST_VISIBILITY_OWNER_ONLY'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_company_settings_privileges() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_company_settings_privileges ON public.company_settings;
CREATE TRIGGER trg_protect_company_settings_privileges
  BEFORE INSERT OR UPDATE ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.protect_company_settings_privileges();

CREATE OR REPLACE FUNCTION public.set_logists_visibility(
  p_org_id uuid,
  p_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_service_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.company_settings (org_id, settings, updated_at)
  VALUES (
    p_org_id,
    jsonb_build_object('logists_see_all', p_enabled),
    now()
  )
  ON CONFLICT (org_id) DO UPDATE
  SET settings = jsonb_set(
        coalesce(public.company_settings.settings, '{}'::jsonb),
        '{logists_see_all}',
        to_jsonb(p_enabled),
        true
      ),
      updated_at = now();

  RETURN p_enabled;
END;
$$;

REVOKE ALL ON FUNCTION public.set_logists_visibility(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_logists_visibility(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.protect_calculation_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_service_role() AND (
    NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
  ) THEN
    RAISE EXCEPTION 'CALCULATION_OWNERSHIP_IMMUTABLE'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_calculation_ownership() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_calculation_ownership ON public.calculations;
CREATE TRIGGER trg_protect_calculation_ownership
  BEFORE UPDATE OF org_id, user_id ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.protect_calculation_ownership();

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  org_role text NOT NULL DEFAULT 'logist'
    CHECK (org_role IN ('manager', 'logist')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS org_invites_org_pending_idx
  ON public.org_invites (org_id, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_invites_pending_email_uidx
  ON public.org_invites (org_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_invites_select_admin ON public.org_invites;
CREATE POLICY org_invites_select_admin ON public.org_invites
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_admin());

DROP POLICY IF EXISTS org_invites_insert_admin ON public.org_invites;
DROP POLICY IF EXISTS org_invites_update_admin ON public.org_invites;

-- Invitation mutations are server-only: otherwise a client could mint a
-- chosen token hash and bypass the email-delivery flow.

CREATE OR REPLACE FUNCTION public.accept_org_invite(
  p_token_hash text,
  p_user_id uuid,
  p_email text
)
RETURNS TABLE (org_id uuid, org_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.org_invites%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_old_member_count integer;
  v_old_calculation_count integer;
  v_target_member_count integer;
BEGIN
  IF NOT public.is_service_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_invite
  FROM public.org_invites AS oi
  WHERE oi.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND OR v_invite.accepted_at IS NOT NULL OR v_invite.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF lower(coalesce(p_email, '')) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize accepts for one organization so the member cap cannot race.
  PERFORM 1
  FROM public.organizations AS o
  WHERE o.id = v_invite.org_id
    AND o.status <> 'blocked'
    AND o.work_mode = 'team'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_ORG_BLOCKED' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
  INTO v_profile
  FROM public.profiles AS p
  WHERE p.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PROFILE' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)::integer
  INTO v_target_member_count
  FROM public.profiles AS p
  WHERE p.org_id = v_invite.org_id
    AND p.member_status = 'active'
    AND p.id <> p_user_id;
  IF v_target_member_count >= 20 THEN
    RAISE EXCEPTION 'MEMBER_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  IF v_profile.org_id IS DISTINCT FROM v_invite.org_id THEN
    -- Block new FK references (calculations/members) until the emptiness
    -- checks and orphan cleanup finish.
    PERFORM 1
    FROM public.organizations AS old_org
    WHERE old_org.id = v_profile.org_id
    FOR UPDATE;

    SELECT count(*)::integer
    INTO v_old_member_count
    FROM public.profiles AS p
    WHERE p.org_id = v_profile.org_id;

    SELECT count(*)::integer
    INTO v_old_calculation_count
    FROM public.calculations AS c
    WHERE c.org_id = v_profile.org_id;

    IF v_old_member_count > 1 OR v_old_calculation_count > 0 THEN
      RAISE EXCEPTION 'ACCOUNT_ALREADY_IN_ORG' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.profiles AS p
    SET org_id = v_invite.org_id,
        org_role = v_invite.org_role,
        member_status = 'active'
    WHERE p.id = p_user_id;

    DELETE FROM public.organizations AS o
    WHERE o.id = v_profile.org_id;
  ELSE
    UPDATE public.profiles AS p
    SET org_role = v_invite.org_role,
        member_status = 'active'
    WHERE p.id = p_user_id;
  END IF;

  UPDATE public.org_invites AS oi
  SET accepted_at = now()
  WHERE oi.id = v_invite.id;

  INSERT INTO public.security_audit_log (
    actor, org_id, action, entity, entity_id, detail
  ) VALUES (
    p_user_id, v_invite.org_id, 'accept_invite', 'org_invites', v_invite.id::text,
    jsonb_build_object('org_role', v_invite.org_role)
  );

  RETURN QUERY SELECT v_invite.org_id, v_invite.org_role;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_org_invite(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Signup: mode and legal form are preferences, never authorization claims.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_tripcontrol_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_name text;
  v_tax text;
  v_work_mode text;
  v_ownership text;
BEGIN
  v_name := coalesce(nullif(trim(NEW.raw_user_meta_data ->> 'company_name'), ''), '');
  v_tax := coalesce(nullif(NEW.raw_user_meta_data ->> 'tax_mode', ''), 'фоп');
  v_work_mode := coalesce(nullif(NEW.raw_user_meta_data ->> 'work_mode', ''), 'solo');
  v_ownership := coalesce(nullif(NEW.raw_user_meta_data ->> 'ownership', ''), 'fop');

  IF v_tax NOT IN ('безготівковий', 'фоп', 'готівка') THEN
    v_tax := 'фоп';
  END IF;
  IF v_work_mode NOT IN ('solo', 'team') THEN
    v_work_mode := 'solo';
  END IF;
  IF v_ownership NOT IN ('fop', 'tov', 'other') THEN
    v_ownership := 'other';
  END IF;

  INSERT INTO public.organizations (name, default_tax_mode, work_mode)
  VALUES (v_name, v_tax, v_work_mode)
  RETURNING id INTO v_org;

  INSERT INTO public.company_settings (org_id, settings)
  VALUES (v_org, jsonb_build_object('logists_see_all', false))
  ON CONFLICT (org_id) DO NOTHING;

  INSERT INTO public.profiles (
    id, email, org_id, is_approved, role, org_role, member_status
  ) VALUES (
    NEW.id, NEW.email, v_org, false, 'user', 'owner', 'active'
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        org_id = EXCLUDED.org_id,
        org_role = 'owner',
        member_status = 'active';

  INSERT INTO public.org_company_profiles (org_id, ownership, updated_by)
  VALUES (v_org, v_ownership, NEW.id)
  ON CONFLICT (org_id) DO UPDATE
    SET ownership = EXCLUDED.ownership,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_tripcontrol_user() FROM PUBLIC;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname
    FROM pg_trigger AS t
    JOIN pg_proc AS p ON p.oid = t.tgfoid
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE t.tgrelid = 'auth.users'::regclass
      AND NOT t.tgisinternal
      AND n.nspname = 'public'
      AND p.proname = 'handle_new_tripcontrol_user'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users', r.tgname);
  END LOOP;
END $$;

CREATE TRIGGER on_auth_user_created_tripcontrol
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_tripcontrol_user();

-- ---------------------------------------------------------------------------
-- RLS: remove legacy broad policies, then install the role-aware matrix.
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calculations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_select_same_org ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own_safe ON public.profiles;

CREATE POLICY profiles_select_same_org ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR org_id = public.current_org_id()
    OR public.is_platform_admin()
  );

CREATE POLICY profiles_update_own_safe ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() AND member_status = 'active')
  WITH CHECK (id = auth.uid() AND member_status = 'active');

DROP POLICY IF EXISTS organizations_select ON public.organizations;
DROP POLICY IF EXISTS organizations_select_own ON public.organizations;
DROP POLICY IF EXISTS organizations_update ON public.organizations;
DROP POLICY IF EXISTS organizations_update_own ON public.organizations;
DROP POLICY IF EXISTS organizations_update_owner ON public.organizations;

CREATE POLICY organizations_select_own ON public.organizations
  FOR SELECT TO authenticated
  USING (id = public.current_org_id() OR public.is_platform_admin());

CREATE POLICY organizations_update_owner ON public.organizations
  FOR UPDATE TO authenticated
  USING (id = public.current_org_id() AND public.is_org_owner())
  WITH CHECK (id = public.current_org_id() AND public.is_org_owner());

DROP POLICY IF EXISTS company_settings_all ON public.company_settings;
DROP POLICY IF EXISTS company_settings_select_own ON public.company_settings;
DROP POLICY IF EXISTS company_settings_insert_own ON public.company_settings;
DROP POLICY IF EXISTS company_settings_update_own ON public.company_settings;
DROP POLICY IF EXISTS company_settings_insert_admin ON public.company_settings;
DROP POLICY IF EXISTS company_settings_update_admin ON public.company_settings;

CREATE POLICY company_settings_select_own ON public.company_settings
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() OR public.is_platform_admin());

CREATE POLICY company_settings_insert_admin ON public.company_settings
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_admin());

CREATE POLICY company_settings_update_admin ON public.company_settings
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_admin());

DROP POLICY IF EXISTS ocp_select_own ON public.org_company_profiles;
DROP POLICY IF EXISTS ocp_insert_own ON public.org_company_profiles;
DROP POLICY IF EXISTS ocp_update_own ON public.org_company_profiles;
DROP POLICY IF EXISTS ocp_insert_owner ON public.org_company_profiles;
DROP POLICY IF EXISTS ocp_update_owner ON public.org_company_profiles;

CREATE POLICY ocp_select_own ON public.org_company_profiles
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() OR public.is_platform_admin());

CREATE POLICY ocp_insert_owner ON public.org_company_profiles
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());

CREATE POLICY ocp_update_owner ON public.org_company_profiles
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner())
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());

DROP POLICY IF EXISTS calculations_select ON public.calculations;
DROP POLICY IF EXISTS calculations_select_own_org ON public.calculations;
DROP POLICY IF EXISTS calculations_insert ON public.calculations;
DROP POLICY IF EXISTS calculations_insert_own_org ON public.calculations;
DROP POLICY IF EXISTS calculations_update ON public.calculations;
DROP POLICY IF EXISTS calculations_update_own_org ON public.calculations;
DROP POLICY IF EXISTS calculations_delete ON public.calculations;
DROP POLICY IF EXISTS calculations_delete_own_org ON public.calculations;
DROP POLICY IF EXISTS calculations_select_role ON public.calculations;
DROP POLICY IF EXISTS calculations_insert_role ON public.calculations;
DROP POLICY IF EXISTS calculations_update_role ON public.calculations;
DROP POLICY IF EXISTS calculations_delete_role ON public.calculations;

CREATE POLICY calculations_select_role ON public.calculations
  FOR SELECT TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (
      public.is_org_admin()
      OR user_id = auth.uid()
      OR public.org_logists_see_all()
    )
  );

CREATE POLICY calculations_insert_role ON public.calculations
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id = public.current_org_id()
    AND user_id = auth.uid()
  );

CREATE POLICY calculations_update_role ON public.calculations
  FOR UPDATE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (public.is_org_admin() OR user_id = auth.uid())
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND (public.is_org_admin() OR user_id = auth.uid())
  );

CREATE POLICY calculations_delete_role ON public.calculations
  FOR DELETE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (public.is_org_admin() OR user_id = auth.uid())
  );

-- Expose only the member directory fields needed by the UI. The invoker view
-- keeps the profiles RLS policy in force.
CREATE OR REPLACE VIEW public.org_members_v
WITH (security_invoker = true)
AS
SELECT id, email, org_id, org_role, member_status, created_at
FROM public.profiles;

REVOKE ALL ON public.org_members_v FROM anon;
GRANT SELECT ON public.org_members_v TO authenticated;
