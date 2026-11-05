-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: «Власний парк», етап 1 — виправлення за рев'ю PR #128. Нова міграція поверх 20261120090000_own_fleet.sql (той файл не
-- змінено: невідомо, чи його вже застосовано; функції нижче лише переозначаються через CREATE OR REPLACE).
--
-- 1. fleet_request_set_trip: trip_id — це подорожній лист (kp_doc_trip_sheet.id, на нього веде кнопка «Відкрити подорожній лист»).
--    Перед записом перевіряємо, що він існує й належить організації користувача (FLEET_REQUEST_BAD_TRIP); NULL знімає звʼязок.
--    FK не додаємо навмисно: наявний тест відкату міграції подорожніх (DROP TABLE kp_doc_trip_sheet) тоді б падав.
-- 2. fleet_request_assign: причіп — лише активний (як водії): FLEET_REQUEST_TRAILER_ARCHIVED. У авто (fleet_vehicles, таблиця сайту) стану «архів» немає —
--    «Деактивувати» в автопарку видаляє рядок, і таке авто призначити не можна (FLEET_REQUEST_BAD_ASSIGNMENT); колонку на таблиці сайту не додаємо.
-- 3. own_fleet_invite_accept і тригер requester: акаунт, який уже працює в іншій компанії, відхиляється окремою помилкою
--    REQUESTER_WORKS_ELSEWHERE. «Працює» = активний логіст чужої організації, директор чужої організації або учасник чужої організації
--    на control_plus (власний Контроль+, як у відповідального за ремонти). Власник власної пробної / «Компанія» організації — не вважається.
-- 4. own_fleet_requesters_list(): замовники організації з поштою, ПІБ (з метаданих акаунта, якщо є) і підрозділами — для блоку
--    «Замовники підрозділів» у «Команді» (auth.users клієнту не читається).
-- 5. fleet_request_transition: assigned → accepted («Зняти призначення»): очищає авто / причіп / водія, пише в журнал. Лише персонал.
--
-- Лише адитивно: нові функції й CREATE OR REPLACE власних функцій модуля. Ідемпотентно.

-- 4. Список замовників для персоналу.
CREATE OR REPLACE FUNCTION public.own_fleet_requesters_list()
RETURNS TABLE (user_id uuid, email text, full_name text, unit_ids uuid[], created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.user_id,
         u.email::text,
         nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ''),
         ARRAY(SELECT m.unit_id FROM public.org_unit_members AS m WHERE m.user_id = r.user_id AND m.org_id = r.org_id ORDER BY m.created_at),
         r.created_at
  FROM public.org_requesters AS r
  JOIN auth.users AS u ON u.id = r.user_id
  WHERE r.org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage()
  ORDER BY lower(u.email::text);
$$;

REVOKE ALL ON FUNCTION public.own_fleet_requesters_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.own_fleet_requesters_list() TO authenticated, service_role;

-- 3. «Працює в іншій компанії».
CREATE OR REPLACE FUNCTION public.own_fleet_user_works_elsewhere(p_user uuid, p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = p_user AND p.member_status = 'active' AND p.org_id IS NOT NULL AND p.org_id <> p_org
      AND (p.org_role = 'logist' OR public.org_has_plan(p.org_id, 'control_plus'))
  ) OR EXISTS (
    SELECT 1 FROM public.org_directors AS d WHERE d.user_id = p_user AND d.org_id <> p_org
  );
$$;

REVOKE ALL ON FUNCTION public.own_fleet_user_works_elsewhere(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.own_fleet_guard_requester()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = NEW.org_id FOR UPDATE;
  IF NOT public.org_has_feature(NEW.org_id, 'own_fleet') THEN
    RAISE EXCEPTION 'REQUESTER_REQUIRES_OWN_FLEET' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.org_has_plan(NEW.org_id, 'control_plus') THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id AND p.member_status = 'active')
     OR EXISTS (SELECT 1 FROM public.org_directors AS d WHERE d.org_id = NEW.org_id AND d.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'REQUESTER_IS_MEMBER' USING ERRCODE = 'P0001';
  END IF;
  IF public.own_fleet_user_works_elsewhere(NEW.user_id, NEW.org_id) THEN
    RAISE EXCEPTION 'REQUESTER_WORKS_ELSEWHERE' USING ERRCODE = 'P0001';
  END IF;
  IF public.own_fleet_requester_seats(NEW.org_id, NEW.user_id, NULL) >= 30 THEN
    RAISE EXCEPTION 'REQUESTER_LIMIT' USING ERRCODE = 'P0001', DETAIL = 'At most 30 requesters (incl. pending invites) per organization';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_invite_accept(p_token_hash text, p_user uuid, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.requester_invites%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.requester_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_inv.revoked_at IS NOT NULL OR v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'REQUESTER_INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'REQUESTER_INVITE_USED' USING ERRCODE = 'P0001';
  END IF;
  IF lower(btrim(p_email)) <> v_inv.email THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF public.own_fleet_user_works_elsewhere(p_user, v_inv.org_id) THEN
    RAISE EXCEPTION 'REQUESTER_WORKS_ELSEWHERE' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.requester_invites SET accepted_at = now(), accepted_by = p_user WHERE id = v_inv.id;
  INSERT INTO public.org_requesters (org_id, user_id, created_by) VALUES (v_inv.org_id, p_user, v_inv.invited_by)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.org_unit_members (unit_id, user_id, org_id)
  SELECT u, p_user, v_inv.org_id FROM unnest(v_inv.unit_ids) AS u
  WHERE EXISTS (SELECT 1 FROM public.org_units AS x WHERE x.id = u AND x.org_id = v_inv.org_id AND NOT x.archived)
  ON CONFLICT DO NOTHING;
  RETURN v_inv.org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_invite_accept(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.own_fleet_invite_accept(text, uuid, text) TO service_role;

-- 1. Звʼязок із подорожнім листом.
CREATE OR REPLACE FUNCTION public.fleet_request_set_trip(p_id uuid, p_trip uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
BEGIN
  IF v_org IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_trip IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.kp_doc_trip_sheet AS t WHERE t.id = p_trip AND t.org_id = v_org) THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_TRIP' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.fleet_requests SET trip_id = p_trip, updated_at = now()
  WHERE id = p_id AND org_id = v_org AND status IN ('assigned', 'in_progress', 'done');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- 2. Призначення: лише активні авто й причіп.
CREATE OR REPLACE FUNCTION public.fleet_request_assign(p_id uuid, p_vehicle uuid, p_trailer uuid, p_driver uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
  v_row public.fleet_requests;
  v_from text;
  v_veh text;
  v_trl text;
  v_trl_active boolean;
  v_drv text;
  v_conflicts jsonb;
BEGIN
  IF v_org IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.fleet_requests WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_from := v_row.status;
  IF v_from NOT IN ('accepted', 'assigned') THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_TRANSITION' USING ERRCODE = 'P0001', DETAIL = v_from || ' -> assigned';
  END IF;
  SELECT f.label INTO v_veh FROM public.fleet_vehicles AS f WHERE f.id = p_vehicle AND f.org_id = v_org;
  SELECT d.full_name INTO v_drv FROM public.kp_drivers AS d WHERE d.id = p_driver AND d.org_id = v_org AND d.active;
  IF v_veh IS NULL OR v_drv IS NULL THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_ASSIGNMENT' USING ERRCODE = 'P0001';
  END IF;
  IF p_trailer IS NOT NULL THEN
    SELECT t.plate, t.active INTO v_trl, v_trl_active FROM public.fleet_trailers AS t WHERE t.id = p_trailer AND t.org_id = v_org;
    IF v_trl IS NULL THEN
      RAISE EXCEPTION 'FLEET_REQUEST_BAD_ASSIGNMENT' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_trl_active THEN
      RAISE EXCEPTION 'FLEET_REQUEST_TRAILER_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('request_id', c.request_id, 'number', c.number, 'kind', c.kind, 'wanted_at', c.wanted_at)), '[]'::jsonb)
  INTO v_conflicts FROM public.fleet_request_conflicts(p_id, p_vehicle, p_driver) AS c;
  UPDATE public.fleet_requests SET
    status = 'assigned', vehicle_id = p_vehicle, trailer_id = p_trailer, driver_id = p_driver,
    vehicle_label = v_veh, trailer_label = v_trl, driver_name = v_drv, assigned_at = now(), updated_at = now()
  WHERE id = p_id RETURNING * INTO v_row;
  PERFORM public.fleet_request_log_add(v_row, v_from, v_veh || coalesce(' + ' || v_trl, '') || ', ' || v_drv);
  RETURN jsonb_build_object('ok', true, 'conflicts', v_conflicts);
END;
$$;

-- 5. Переходи + «Зняти призначення» (assigned → accepted).
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
    accepted_at = CASE WHEN p_to = 'accepted' THEN now() ELSE accepted_at END,
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
