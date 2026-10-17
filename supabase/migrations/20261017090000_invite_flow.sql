-- Invite flow: declined invites, and a safe accept that never drops a company with data.
-- Idempotent. Apply only after review; not applied to production by this PR.

-- ---------------------------------------------------------------------------
-- «Відхилити»: the invitee declines; the row stays for the owner's history.
-- ---------------------------------------------------------------------------

ALTER TABLE public.org_invites
  ADD COLUMN IF NOT EXISTS declined_at timestamptz;

-- ---------------------------------------------------------------------------
-- Does the account's current company hold anything worth keeping?
-- Other members (any status), saved data in any org table, company settings
-- beyond the signup default, or a filled company profile.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_has_user_data(p_org_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table text;
  v_found boolean;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.org_id = p_org_id AND p.id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN true;
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'calculations', 'calc_vehicles', 'trip_actuals', 'route_templates',
    'fleet_vehicles', 'trailer_presets', 'weekly_reports'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns AS c
      WHERE c.table_schema = 'public' AND c.table_name = v_table AND c.column_name = 'org_id'
    ) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE org_id = $1)', v_table)
        INTO v_found
        USING p_org_id;
      IF v_found THEN
        RETURN true;
      END IF;
    END IF;
  END LOOP;

  -- Signup writes {"logists_see_all": false}; the first sign-in autosaves the
  -- starter template (STARTER_SETTINGS in index.html, same values here). Neither
  -- is user data. Any other key or any changed value was set by the user.
  IF EXISTS (
    SELECT 1 FROM public.company_settings AS s
    WHERE s.org_id = p_org_id
      AND NOT (
        jsonb_build_object(
          'totalFleet', 5, 'fuelLoad', 37, 'fuelEmpty', 32, 'fuelPrice', 57,
          'adblueEnable', 'on', 'adblueConsumption', 2.85, 'adbluePrice', 18,
          'driverPayMode', 'km', 'driverRateLoad', 4.03, 'driverRateEmpty', 2.3,
          'driverPctVal', 12, 'perDiem', 850, 'toCost', 18000, 'toPeriod', 50000,
          'tireCost', 16500, 'tireCount', 14, 'tireMileage', 150000
        ) @> coalesce((
          SELECT jsonb_object_agg(e.key, e.value)
          FROM jsonb_each(coalesce(s.settings, '{}'::jsonb) - 'logists_see_all') AS e
          WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb)
        ), '{}'::jsonb)
      )
  ) THEN
    RETURN true;
  END IF;

  -- Signup fills only ownership; EDRPOU, phone, address and the rest come from the cabinet.
  IF EXISTS (
    SELECT 1
    FROM public.org_company_profiles AS ocp,
         jsonb_each(to_jsonb(ocp) - ARRAY['org_id', 'ownership', 'lang', 'updated_at', 'updated_by', 'created_at']) AS f
    WHERE ocp.org_id = p_org_id
      AND f.value NOT IN ('null'::jsonb, '""'::jsonb)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.org_has_user_data(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_user_data(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- accept_org_invite: same contract, plus
--   * a declined invite cannot be accepted (INVITE_DECLINED);
--   * the old company is removed only when it is empty, otherwise OLD_ORG_HAS_DATA
--     (the API answers 409 with a human message).
-- ---------------------------------------------------------------------------

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
  v_target_member_count integer;
  v_owner_approved boolean;
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
  IF v_invite.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_DECLINED' USING ERRCODE = 'P0001';
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
    AND p.org_role = 'logist'
    AND p.id <> p_user_id;
  IF v_target_member_count >= 3 THEN
    RAISE EXCEPTION 'MEMBER_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  -- A logist works under the owner's approval: approved owner → approved logist,
  -- otherwise the flag is reset (an approved solo account does not carry it over).
  SELECT coalesce(bool_or(p.is_approved), false)
  INTO v_owner_approved
  FROM public.profiles AS p
  WHERE p.org_id = v_invite.org_id
    AND p.org_role = 'owner'
    AND p.member_status = 'active'
    AND p.id <> p_user_id;

  IF v_profile.org_id IS DISTINCT FROM v_invite.org_id THEN
    IF v_profile.org_id IS NOT NULL THEN
      PERFORM 1
      FROM public.organizations AS old_org
      WHERE old_org.id = v_profile.org_id
      FOR UPDATE;

      IF public.org_has_user_data(v_profile.org_id, p_user_id) THEN
        RAISE EXCEPTION 'OLD_ORG_HAS_DATA' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    UPDATE public.profiles AS p
    SET org_id = v_invite.org_id,
        org_role = v_invite.org_role,
        member_status = 'active',
        is_approved = v_owner_approved
    WHERE p.id = p_user_id;

    IF v_profile.org_id IS NOT NULL THEN
      -- Empty signup company: drop its default rows, then the company itself.
      DELETE FROM public.company_settings AS s WHERE s.org_id = v_profile.org_id;
      DELETE FROM public.usage_counters AS u WHERE u.org_id = v_profile.org_id;
      DELETE FROM public.organizations AS o WHERE o.id = v_profile.org_id;
    END IF;
  ELSE
    UPDATE public.profiles AS p
    SET org_role = v_invite.org_role,
        member_status = 'active',
        is_approved = v_owner_approved
    WHERE p.id = p_user_id;
  END IF;

  UPDATE public.org_invites AS oi
  SET accepted_at = now()
  WHERE oi.id = v_invite.id;

  INSERT INTO public.security_audit_log (
    actor, org_id, action, entity, entity_id, detail
  ) VALUES (
    p_user_id, v_invite.org_id, 'accept_invite', 'org_invites', v_invite.id::text,
    jsonb_build_object('org_role', v_invite.org_role, 'is_approved', v_owner_approved, 'old_org_removed', v_profile.org_id IS DISTINCT FROM v_invite.org_id)
  );

  RETURN QUERY SELECT v_invite.org_id, v_invite.org_role;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_org_invite(text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text, uuid, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Seat trigger (from 20261012210000): a declined invite no longer holds a seat,
-- same as in the team API. CREATE OR REPLACE keeps the owner and the
-- trg_enforce_logist_activation_limit trigger on public.profiles as they are.
-- ---------------------------------------------------------------------------

-- Service role is not exempt: the team API updates profiles with that role.
-- A pending invite for this same email is the seat being accepted, so it is
-- not counted twice. A different person's invite still occupies a seat.
CREATE OR REPLACE FUNCTION public.enforce_logist_activation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
BEGIN
  IF NOT (NEW.org_role = 'logist' AND NEW.member_status = 'active') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.org_role = 'logist'
     AND OLD.member_status = 'active'
     AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id
  THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.organizations
  WHERE id = NEW.org_id
  FOR UPDATE;

  SELECT
    (SELECT count(*)::integer FROM public.profiles AS p
      WHERE p.org_id = NEW.org_id
        AND p.id IS DISTINCT FROM NEW.id
        AND p.member_status = 'active'
        AND p.org_role = 'logist')
    +
    (SELECT count(*)::integer FROM public.org_invites AS oi
      WHERE oi.org_id = NEW.org_id
        AND oi.accepted_at IS NULL
        AND oi.revoked_at IS NULL
        AND oi.declined_at IS NULL
        AND oi.expires_at > now()
        AND (
          NEW.email IS NULL
          OR lower(oi.email) IS DISTINCT FROM lower(NEW.email)
        ))
  INTO v_used;

  IF v_used >= 3 THEN
    RAISE EXCEPTION 'MEMBER_LIMIT'
      USING ERRCODE = 'P0001',
            DETAIL = 'One owner and at most three logists, including live invitations';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_logist_activation_limit()
  FROM PUBLIC, anon, authenticated, service_role;
