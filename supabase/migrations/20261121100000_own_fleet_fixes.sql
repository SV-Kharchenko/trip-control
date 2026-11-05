-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: «Власний парк», етап 1 — друге виправлення за рев'ю PR #128. Нова міграція поверх 20261121090000_own_fleet_fixes.sql (той файл не
-- змінено: невідомо, чи його вже застосовано; функції нижче лише переозначаються через CREATE OR REPLACE).
--
-- 1. Замовників підрозділів бачать і ними керують лише директор (owner) і менеджер (director): own_fleet_requesters_list() для логіста й
--    замовника — помилка доступу OWN_FLEET_FORBIDDEN (раніше повертав порожній список лише тим, хто не керує). Ті самі права — в
--    own_fleet_requester_set_units / own_fleet_requester_remove / own_fleet_invite_reserve (логіст більше не запрошує й не змінює замовників).
--    Керування командою — зона директора й менеджера, логіст її не отримує.
-- 3. fleet_request_transition: accepted_at ставиться лише при new → accepted. «Зняти призначення» (assigned → accepted) час прийняття не перезаписує.
--
-- Лише CREATE OR REPLACE власних функцій модуля. Ідемпотентно.

CREATE OR REPLACE FUNCTION public.own_fleet_requesters_list()
RETURNS TABLE (user_id uuid, email text, full_name text, unit_ids uuid[], created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.own_fleet_org_id() IS NULL OR NOT coalesce(public.own_fleet_role() IN ('owner', 'director'), false) THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.user_id,
         u.email::text,
         nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ''),
         ARRAY(SELECT m.unit_id FROM public.org_unit_members AS m WHERE m.user_id = r.user_id AND m.org_id = r.org_id ORDER BY m.created_at),
         r.created_at
  FROM public.org_requesters AS r
  JOIN auth.users AS u ON u.id = r.user_id
  WHERE r.org_id = public.own_fleet_org_id()
  ORDER BY lower(u.email::text);
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_requesters_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.own_fleet_requesters_list() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.own_fleet_requester_set_units(p_user uuid, p_unit_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
BEGIN
  IF v_org IS NULL OR NOT coalesce(public.own_fleet_role() IN ('owner', 'director'), false) THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_requesters AS r WHERE r.org_id = v_org AND r.user_id = p_user) THEN
    RAISE EXCEPTION 'REQUESTER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.org_unit_members WHERE org_id = v_org AND user_id = p_user AND unit_id <> ALL (coalesce(p_unit_ids, '{}'));
  INSERT INTO public.org_unit_members (unit_id, user_id, org_id)
  SELECT DISTINCT u, p_user, v_org FROM unnest(coalesce(p_unit_ids, '{}')) AS u
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_requester_remove(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
BEGIN
  IF v_org IS NULL OR NOT coalesce(public.own_fleet_role() IN ('owner', 'director'), false) THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.org_requesters WHERE org_id = v_org AND user_id = p_user;
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_requester_set_units(uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.own_fleet_requester_remove(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.own_fleet_requester_set_units(uuid, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_requester_remove(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.own_fleet_invite_reserve(
  p_org uuid, p_invite uuid, p_email text, p_token_hash text, p_invited_by uuid, p_expires_at timestamptz, p_unit_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_access record;
  v_email text := lower(btrim(p_email));
BEGIN
  SELECT * INTO v_access FROM public.own_fleet_access_for(p_invited_by);
  IF v_access.org_id IS DISTINCT FROM p_org OR v_access.role NOT IN ('owner', 'director') THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR UPDATE;
  IF coalesce(cardinality(p_unit_ids), 0) = 0 OR EXISTS (
    SELECT 1 FROM unnest(p_unit_ids) AS u WHERE NOT EXISTS (SELECT 1 FROM public.org_units AS x WHERE x.id = u AND x.org_id = p_org AND NOT x.archived)
  ) THEN
    RAISE EXCEPTION 'OWN_FLEET_UNIT_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF public.own_fleet_requester_seats(p_org, NULL, p_invite) >= 30 THEN
    RAISE EXCEPTION 'REQUESTER_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.requester_invites (id, org_id, email, token_hash, unit_ids, invited_by, expires_at)
  VALUES (p_invite, p_org, v_email, p_token_hash, p_unit_ids, p_invited_by, p_expires_at)
  ON CONFLICT (id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, unit_ids = EXCLUDED.unit_ids, last_sent_at = now()
    WHERE public.requester_invites.org_id = p_org AND public.requester_invites.accepted_at IS NULL;
  RETURN p_invite;
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_invite_reserve(uuid, uuid, text, text, uuid, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.own_fleet_invite_reserve(uuid, uuid, text, text, uuid, timestamptz, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.fleet_request_transition(p_id uuid, p_to text, p_reason text DEFAULT NULL)
RETURNS public.fleet_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
  v_role text := public.own_fleet_role();
  v_row public.fleet_requests;
  v_from text;
  v_reason text := nullif(btrim(p_reason), '');
  v_old_label text;
BEGIN
  IF v_org IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.fleet_requests WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND OR (v_role = 'requester' AND v_row.unit_id NOT IN (SELECT public.own_fleet_unit_ids())) THEN
    RAISE EXCEPTION 'FLEET_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_from := v_row.status;
  v_old_label := v_row.vehicle_label;
  IF p_to = 'assigned' THEN
    RAISE EXCEPTION 'FLEET_REQUEST_USE_ASSIGN' USING ERRCODE = 'P0001';
  END IF;
  IF v_role = 'requester' THEN
    -- Замовник: лише скасувати свою нову заявку.
    IF NOT (p_to = 'cancelled' AND v_from = 'new' AND v_row.created_by = auth.uid()) THEN
      RAISE EXCEPTION 'FLEET_REQUEST_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NOT (
    (v_from = 'new' AND p_to IN ('accepted', 'cancelled'))
    OR (v_from = 'accepted' AND p_to = 'cancelled')
    OR (v_from = 'assigned' AND p_to IN ('in_progress', 'cancelled', 'accepted'))
    OR (v_from = 'in_progress' AND p_to IN ('done', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_TRANSITION' USING ERRCODE = 'P0001', DETAIL = v_from || ' -> ' || coalesce(p_to, 'NULL');
  END IF;
  IF p_to = 'cancelled' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'FLEET_REQUEST_REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.fleet_requests SET
    status = p_to,
    cancel_reason = CASE WHEN p_to = 'cancelled' THEN left(v_reason, 500) END,
    -- accepted_at ставиться лише при new → accepted; «Зняти призначення» (assigned → accepted) час прийняття не перезаписує.
    accepted_at = CASE WHEN p_to = 'accepted' AND v_from = 'new' THEN now() ELSE accepted_at END,
    started_at = CASE WHEN p_to = 'in_progress' THEN now() ELSE started_at END,
    done_at = CASE WHEN p_to = 'done' THEN now() ELSE done_at END,
    cancelled_at = CASE WHEN p_to = 'cancelled' THEN now() ELSE cancelled_at END,
    -- Зняти призначення: авто, причіп і водій очищаються (звʼязок із рейсом теж: він був би хибним).
    vehicle_id = CASE WHEN p_to = 'accepted' THEN NULL ELSE vehicle_id END,
    trailer_id = CASE WHEN p_to = 'accepted' THEN NULL ELSE trailer_id END,
    driver_id = CASE WHEN p_to = 'accepted' THEN NULL ELSE driver_id END,
    vehicle_label = CASE WHEN p_to = 'accepted' THEN NULL ELSE vehicle_label END,
    trailer_label = CASE WHEN p_to = 'accepted' THEN NULL ELSE trailer_label END,
    driver_name = CASE WHEN p_to = 'accepted' THEN NULL ELSE driver_name END,
    assigned_at = CASE WHEN p_to = 'accepted' THEN NULL ELSE assigned_at END,
    trip_id = CASE WHEN p_to = 'accepted' AND v_from = 'assigned' THEN NULL ELSE trip_id END,
    updated_at = now()
  WHERE id = p_id RETURNING * INTO v_row;
  PERFORM public.fleet_request_log_add(v_row, v_from,
    CASE WHEN p_to = 'cancelled' THEN v_reason WHEN p_to = 'accepted' AND v_from = 'assigned' THEN 'Призначення знято: ' || coalesce(v_old_label, 'авто') END);
  RETURN v_row;
END;
$$;
