-- Keep the organization model deliberately small: owner + logist only.
-- Pending, non-expired invitations reserve one of the three team seats.

UPDATE public.profiles
SET org_role = CASE WHEN org_role = 'owner' THEN 'owner' ELSE 'logist' END
WHERE org_role IS NULL OR org_role NOT IN ('owner', 'logist');

UPDATE public.org_invites
SET org_role = 'logist'
WHERE org_role IS DISTINCT FROM 'logist';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_org_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_org_role_check
  CHECK (org_role IN ('owner', 'logist'));

ALTER TABLE public.org_invites
  DROP CONSTRAINT IF EXISTS org_invites_org_role_check;
ALTER TABLE public.org_invites
  ADD CONSTRAINT org_invites_org_role_check
  CHECK (org_role = 'logist');

-- ---------------------------------------------------------------------------
-- Owner-only policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_invites_select_admin ON public.org_invites;
DROP POLICY IF EXISTS org_invites_select_owner ON public.org_invites;
CREATE POLICY org_invites_select_owner ON public.org_invites
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner());

DROP POLICY IF EXISTS company_settings_insert_admin ON public.company_settings;
DROP POLICY IF EXISTS company_settings_update_admin ON public.company_settings;
DROP POLICY IF EXISTS company_settings_insert_owner ON public.company_settings;
DROP POLICY IF EXISTS company_settings_update_owner ON public.company_settings;
CREATE POLICY company_settings_insert_owner ON public.company_settings
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());
CREATE POLICY company_settings_update_owner ON public.company_settings
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner())
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());

DROP POLICY IF EXISTS calculations_select_role ON public.calculations;
DROP POLICY IF EXISTS calculations_insert_role ON public.calculations;
DROP POLICY IF EXISTS calculations_update_role ON public.calculations;
DROP POLICY IF EXISTS calculations_delete_role ON public.calculations;

CREATE POLICY calculations_select_role ON public.calculations
  FOR SELECT TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (
      public.is_org_owner()
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
    AND (public.is_org_owner() OR user_id = auth.uid())
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND (public.is_org_owner() OR user_id = auth.uid())
  );

CREATE POLICY calculations_delete_role ON public.calculations
  FOR DELETE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (public.is_org_owner() OR user_id = auth.uid())
  );

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

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_company_settings_privileges()
  FROM PUBLIC, anon, authenticated, service_role;

-- No policy or trigger depends on the legacy broad-role helper after the
-- owner-only policies above are installed.
DROP FUNCTION IF EXISTS public.is_org_admin();

-- ---------------------------------------------------------------------------
-- Three seats, including live invitations
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_org_seat_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
BEGIN
  IF NEW.accepted_at IS NOT NULL
     OR NEW.revoked_at IS NOT NULL
     OR NEW.expires_at <= now()
  THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.organizations
  WHERE id = NEW.org_id
  FOR UPDATE;

  SELECT
    (SELECT count(*) FROM public.profiles AS p
      WHERE p.org_id = NEW.org_id AND p.member_status = 'active')
    +
    (SELECT count(*) FROM public.org_invites AS oi
      WHERE oi.org_id = NEW.org_id
        AND oi.id IS DISTINCT FROM NEW.id
        AND oi.accepted_at IS NULL
        AND oi.revoked_at IS NULL
        AND oi.expires_at > now())
  INTO v_used;

  IF v_used >= 3 THEN
    RAISE EXCEPTION 'MEMBER_LIMIT'
      USING ERRCODE = 'P0001',
            DETAIL = 'Active members and live invitations may use at most three seats';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_org_seat_limit()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_enforce_org_seat_limit ON public.org_invites;
CREATE TRIGGER trg_enforce_org_seat_limit
  BEFORE INSERT OR UPDATE OF org_id, expires_at, accepted_at, revoked_at
  ON public.org_invites
  FOR EACH ROW EXECUTE FUNCTION public.enforce_org_seat_limit();

-- Invitation acceptance keeps its organization lock and enforces the same
-- three-active-member ceiling transactionally.
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
  IF v_target_member_count >= 3 THEN
    RAISE EXCEPTION 'MEMBER_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  IF v_profile.org_id IS DISTINCT FROM v_invite.org_id THEN
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

REVOKE ALL ON FUNCTION public.accept_org_invite(text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text, uuid, text)
  TO service_role;
