-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: тара й макс. дозволена маса причепа (fleet_trailers) — для ТТН і подорожніх листів.
--
-- Проблема: ТТН рахує масу автопоїзда (тара = авто + причіп), але в картці причепа не було ні тари, ні макс. маси, тож тара й
-- брутто автопоїзда були неповні («немає маси причепа в картці»).
--
-- Що робить (ідемпотентно, існуючі ТТН НЕ перераховуються — знімок у kp_doc_ttn лишається як був):
--   1. fleet_trailers.tare_t, max_mass_t numeric(8,3) NULL + CHECK: > 0 (≤ 100 т, як у ТТН), max_mass_t >= tare_t. Права й RLS — як
--      у решти ТТН-колонок причепа: пишуть власник і (kp_trailer_save, право «Автопарк») логіст; fleet_trailers_guard пускає логіста до цих колонок.
--   2. kp_trailers_list повертає tare_t, max_mass_t (в кінці; старі колонки й виклики без змін); kp_trailer_save приймає tare_t, max_mass_t
--      (ключа немає — значення лишається; тара більша за макс. масу — TRAILER_FIELD_INVALID:max_mass_t).
--   3. kp_ttn_prefill: tare_t / max_mass_t = авто + причіп автопарку (причіп без маси в картці не додається) + trailer_tare_t,
--      trailer_max_mass_t, trailer_masses_missing.
--   4. kp_ttn_create: якщо тару / макс. масу не передано, а vehicle_id відомий, сервер бере їх із карток: авто + причіп (тара причепа,
--      знайденого за номером у знімку чи за причепом за замовчуванням). Передані значення не чіпає. Загальна маса, як і раніше,
--      = тара + брутто вантажу (numeric — без похибок).
--
-- Відкат (ручний, після перевірки; старі версії функцій — у 20261026130623 / 20261028095429 / 20261028155128):
--   BEGIN;
--   ALTER TABLE public.fleet_trailers DROP CONSTRAINT IF EXISTS fleet_trailers_tare_t_check, DROP CONSTRAINT IF EXISTS fleet_trailers_max_mass_t_check,
--     DROP CONSTRAINT IF EXISTS fleet_trailers_mass_order_check;
--   ALTER TABLE public.fleet_trailers DROP COLUMN IF EXISTS tare_t, DROP COLUMN IF EXISTS max_mass_t;
--   -- далі перестворити kp_trailers_list, kp_trailer_save, fleet_trailers_guard, kp_ttn_prefill, kp_ttn_create з їхніх попередніх міграцій
--   COMMIT;

BEGIN;

ALTER TABLE public.fleet_trailers
  ADD COLUMN IF NOT EXISTS tare_t numeric(8, 3) NULL,
  ADD COLUMN IF NOT EXISTS max_mass_t numeric(8, 3) NULL;

ALTER TABLE public.fleet_trailers DROP CONSTRAINT IF EXISTS fleet_trailers_tare_t_check;
ALTER TABLE public.fleet_trailers ADD CONSTRAINT fleet_trailers_tare_t_check CHECK (tare_t IS NULL OR (tare_t > 0 AND tare_t <= 100));
ALTER TABLE public.fleet_trailers DROP CONSTRAINT IF EXISTS fleet_trailers_max_mass_t_check;
ALTER TABLE public.fleet_trailers ADD CONSTRAINT fleet_trailers_max_mass_t_check CHECK (max_mass_t IS NULL OR (max_mass_t > 0 AND max_mass_t <= 100));
ALTER TABLE public.fleet_trailers DROP CONSTRAINT IF EXISTS fleet_trailers_mass_order_check;
ALTER TABLE public.fleet_trailers ADD CONSTRAINT fleet_trailers_mass_order_check CHECK (tare_t IS NULL OR max_mass_t IS NULL OR max_mass_t >= tare_t);

-- Guard: ТТН-колонки (які може змінювати логіст) тепер включають tare_t і max_mass_t.
CREATE OR REPLACE FUNCTION public.fleet_trailers_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_ttn text[] := ARRAY['make_model', 'capacity_t', 'volume_m3', 'tare_t', 'max_mass_t', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.is_service_role() OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    IF NOT public.is_org_owner() OR OLD.org_id IS DISTINCT FROM public.current_org_id() THEN
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT (public.is_service_role() OR pg_trigger_depth() > 1) THEN
    IF NOT public.is_org_owner() THEN
      IF TG_OP = 'UPDATE'
         AND public.kp_can_write()
         AND OLD.org_id = public.current_org_id()
         AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
         AND (to_jsonb(NEW) - v_ttn) = (to_jsonb(OLD) - v_ttn) THEN
        NEW.updated_at := now();
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.org_id := public.current_org_id();
    IF NEW.org_id IS NULL THEN
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.plate := btrim(coalesce(NEW.plate, ''));
  IF char_length(NEW.plate) < 1 OR char_length(NEW.plate) > 40 OR NEW.plate ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'TRAILER_PLATE' USING ERRCODE = 'P0001';
  END IF;
  NEW.plate_norm := public.kp_plate_norm(NEW.plate);
  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_count FROM public.fleet_trailers WHERE org_id = NEW.org_id;
    IF v_count >= 100 THEN
      RAISE EXCEPTION 'FLEET_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Список причепів: + tare_t, max_mass_t (тип результату змінюється — функцію перестворюємо).
DROP FUNCTION IF EXISTS public.kp_trailers_list();
CREATE OR REPLACE FUNCTION public.kp_trailers_list()
RETURNS TABLE (
  id uuid, plate text, type text, make_model text, capacity_t numeric, volume_m3 numeric, active boolean,
  oscpv_on date, kasko_on date, green_card_on date, inspection_on date, tachograph_on date, service_on date,
  vehicle_ids uuid[], vehicle_labels text[], tare_t numeric, max_mass_t numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY
  SELECT ft.id, ft.plate, ft.type, ft.make_model, ft.capacity_t, ft.volume_m3, ft.active,
         ft.oscpv_on, ft.kasko_on, ft.green_card_on, ft.inspection_on, ft.tachograph_on, ft.service_on,
         coalesce(array_agg(fv.id ORDER BY lower(fv.label)) FILTER (WHERE fv.id IS NOT NULL), ARRAY[]::uuid[]),
         coalesce(array_agg(fv.label ORDER BY lower(fv.label)) FILTER (WHERE fv.id IS NOT NULL), ARRAY[]::text[]),
         ft.tare_t, ft.max_mass_t
  FROM public.fleet_trailers AS ft
  LEFT JOIN public.fleet_vehicles AS fv ON fv.default_trailer_id = ft.id AND fv.org_id = v_org
  WHERE ft.org_id = v_org
  GROUP BY ft.id
  ORDER BY lower(ft.plate)
  LIMIT 1000;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_trailer_save(p_trailer uuid, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.fleet_trailers%ROWTYPE;
  v_make text;
  v_cap numeric;
  v_vol numeric;
  v_tare numeric;
  v_max numeric;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'TRAILER_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_old FROM public.fleet_trailers WHERE id = p_trailer AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRAILER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_make := CASE WHEN p_data ? 'make_model' THEN public.kp_ttn_text(p_data ->> 'make_model', 100, 'make_model') ELSE v_old.make_model END;
  v_cap := CASE WHEN p_data ? 'capacity_t' THEN public.kp_ttn_num(p_data ->> 'capacity_t', 0, 100, 3, 'capacity_t', 'TRAILER_FIELD_INVALID') ELSE v_old.capacity_t END;
  v_vol := CASE WHEN p_data ? 'volume_m3' THEN public.kp_ttn_num(p_data ->> 'volume_m3', 0, 200, 2, 'volume_m3', 'TRAILER_FIELD_INVALID') ELSE v_old.volume_m3 END;
  v_tare := CASE WHEN p_data ? 'tare_t' THEN public.kp_ttn_num(p_data ->> 'tare_t', 0, 100, 3, 'tare_t', 'TRAILER_FIELD_INVALID') ELSE v_old.tare_t END;
  v_max := CASE WHEN p_data ? 'max_mass_t' THEN public.kp_ttn_num(p_data ->> 'max_mass_t', 0, 100, 3, 'max_mass_t', 'TRAILER_FIELD_INVALID') ELSE v_old.max_mass_t END;
  IF v_tare IS NOT NULL AND v_max IS NOT NULL AND v_tare > v_max THEN
    RAISE EXCEPTION 'TRAILER_FIELD_INVALID:max_mass_t' USING ERRCODE = 'P0001', DETAIL = 'max mass must not be below the tare';
  END IF;
  UPDATE public.fleet_trailers SET make_model = v_make, capacity_t = v_cap, volume_m3 = v_vol, tare_t = v_tare, max_mass_t = v_max WHERE id = p_trailer AND org_id = v_org;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_ttn_prefill(p_calculation uuid, p_client uuid, p_vehicle uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_req public.kp_org_requisites%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_calc public.calculations%ROWTYPE;
  v_vehicle_id uuid;
  v_tonnage numeric;
  v_fv public.fleet_vehicles%ROWTYPE;
  v_trl public.fleet_trailers%ROWTYPE;
  v_driver public.kp_drivers%ROWTYPE;
  v_ours jsonb;
  v_theirs jsonb;
  v_vehicles jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_client FROM public.clients WHERE id = p_client AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  v_ours := CASE WHEN v_req.org_id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'name', v_req.legal_name, 'code', coalesce(v_req.edrpou, v_req.ipn), 'address', v_req.legal_address)) END;
  v_theirs := jsonb_strip_nulls(jsonb_build_object(
    'name', coalesce(v_client.legal_name, v_client.name), 'code', coalesce(v_client.edrpou, v_client.ipn), 'address', v_client.legal_address));

  IF p_calculation IS NOT NULL THEN
    SELECT c.* INTO v_calc
    FROM public.calculations AS c JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
    WHERE c.id = p_calculation AND c.org_id = v_org AND cc.client_id = p_client AND public.kp_trip_visible(c.user_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', fv.id, 'label', fv.label, 'tonnage', cv.tonnage) ORDER BY cv.tonnage DESC, fv.label), '[]'::jsonb)
    INTO v_vehicles
    FROM public.calc_vehicles AS cv JOIN public.fleet_vehicles AS fv ON fv.id = cv.vehicle_id AND fv.org_id = v_org
    WHERE cv.calc_id = p_calculation;
    SELECT cv.vehicle_id, cv.tonnage INTO v_vehicle_id, v_tonnage
    FROM public.calc_vehicles AS cv JOIN public.fleet_vehicles AS fv ON fv.id = cv.vehicle_id AND fv.org_id = v_org
    WHERE cv.calc_id = p_calculation AND (p_vehicle IS NULL OR cv.vehicle_id = p_vehicle)
    ORDER BY cv.tonnage DESC, fv.label
    LIMIT 1;
  END IF;
  IF v_vehicle_id IS NULL AND p_vehicle IS NOT NULL THEN
    v_vehicle_id := p_vehicle;
  END IF;
  IF v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_fv FROM public.fleet_vehicles WHERE id = v_vehicle_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_driver FROM public.kp_drivers WHERE id = v_fv.default_driver_id AND org_id = v_org AND active;
    IF v_fv.default_trailer_id IS NOT NULL THEN
      SELECT * INTO v_trl FROM public.fleet_trailers WHERE id = v_fv.default_trailer_id AND org_id = v_org AND active;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'next_number', public.kp_ttn_next_number(public.ua_today()),
    'prefix', v_req.ttn_prefix,
    'place_of_issue', v_req.doc_place,
    'carrier', v_ours,
    'customer', v_theirs,
    'party_options', jsonb_build_object('client', v_theirs, 'ours', v_ours),
    'calculation', CASE WHEN v_calc.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_calc.id, 'trip_date', v_calc.trip_date, 'name', v_calc.name, 'route_from', v_calc.route_from,
      'route_to', v_calc.route_to, 'tonnage', v_calc.tonnage) END,
    'load_point', v_calc.route_from,
    'unload_point', v_calc.route_to,
    'cargo_net_t', CASE WHEN v_tonnage > 0 THEN round(v_tonnage, 3) WHEN v_calc.tonnage > 0 AND jsonb_array_length(v_vehicles) <= 1 THEN round(v_calc.tonnage, 3) END,
    'vehicles', v_vehicles,
    'vehicle_id', v_fv.id,
    'vehicle', CASE WHEN v_fv.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
      'make_model', v_fv.make_model, 'type', v_fv.vehicle_type, 'reg_number', v_fv.label,
      'trailer_make_model', v_fv.trailer_make_model, 'trailer_type', v_fv.trailer_type, 'trailer_reg_number', v_fv.trailer_plate,
      'length_m', v_fv.length_m, 'width_m', v_fv.width_m, 'height_m', v_fv.height_m)) END,
    -- Маса автопоїзда = авто + причіп (numeric — точні суми). Причіп без своєї маси в картці не додається: лишається маса авто,
    -- а trailer_masses_missing просить форму показати попередження.
    'tare_t', CASE WHEN v_trl.tare_t IS NULL THEN v_fv.tare_t ELSE v_fv.tare_t + v_trl.tare_t END,
    'max_mass_t', CASE WHEN v_trl.max_mass_t IS NULL THEN v_fv.max_mass_t ELSE v_fv.max_mass_t + v_trl.max_mass_t END,
    'trailer_tare_t', v_trl.tare_t,
    'trailer_max_mass_t', v_trl.max_mass_t,
    'trailer_masses_missing', v_trl.id IS NOT NULL AND (v_trl.tare_t IS NULL OR v_trl.max_mass_t IS NULL),
    'driver', CASE WHEN v_driver.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
      'id', v_driver.id, 'full_name', v_driver.full_name, 'license_no', v_driver.license_no)) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_ttn_create(
  p_client uuid, p_doc_date date, p_number integer DEFAULT NULL, p_data jsonb DEFAULT NULL,
  p_calculation uuid DEFAULT NULL, p_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_req public.kp_org_requisites%ROWTYPE;
  v_can_sign boolean := public.member_can('sign');
  v_client public.clients%ROWTYPE;
  v_doc uuid := coalesce(p_id, gen_random_uuid());
  v_data jsonb := p_data;
  v_place text;
  v_shipper jsonb;
  v_consignee jsonb;
  v_customer jsonb;
  v_forwarder jsonb;
  v_carrier jsonb;
  v_driver_in jsonb;
  v_driver_id uuid;
  v_drv public.kp_drivers%ROWTYPE;
  v_driver_name text;
  v_driver_license text;
  v_vin jsonb;
  v_vehicle_id uuid;
  v_vehicle jsonb;
  v_make text;
  v_type text;
  v_reg text;
  v_t_make text;
  v_t_type text;
  v_t_reg text;
  v_len numeric;
  v_wid numeric;
  v_hgt numeric;
  v_fvc public.fleet_vehicles%ROWTYPE;
  v_trc public.fleet_trailers%ROWTYPE;
  v_has_trl boolean;
  v_tare numeric;
  v_max numeric;
  v_net numeric;
  v_gross numeric;
  v_load text;
  v_unload text;
  v_places integer;
  v_total numeric;
  v_vat numeric;
  v_ops jsonb := '[]'::jsonb;
  v_op jsonb;
  v_op_kind text;
  v_lines jsonb;
  v_line jsonb;
  v_n integer := 0;
  v_line_gross numeric;
  v_gross_sum numeric := 0;
  v_all_gross boolean := true;
  v_sig text;
  v_stamp text;
  v_year integer;
  v_no integer;
BEGIN
  IF p_doc_date IS NULL OR p_doc_date < DATE '2000-01-01' OR p_doc_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  IF NOT FOUND OR (v_req.edrpou IS NULL AND v_req.ipn IS NULL) THEN
    RAISE EXCEPTION 'REQUISITES_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_client FROM public.clients WHERE id = p_client AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_client.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'CLIENT_ARCHIVED' USING ERRCODE = 'P0001';
  END IF;
  IF v_data IS NULL OR jsonb_typeof(v_data) <> 'object' THEN
    RAISE EXCEPTION 'TTN_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  IF p_calculation IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calculations AS c JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
    WHERE c.id = p_calculation AND c.org_id = v_org AND cc.client_id = p_client AND public.kp_trip_visible(c.user_id)
  ) THEN
    RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  -- Місце складання і сторони.
  v_place := public.kp_ttn_text(v_data ->> 'place_of_issue', 200, 'place_of_issue');
  IF v_place IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:place_of_issue' USING ERRCODE = 'P0001';
  END IF;
  v_shipper := public.kp_ttn_party(v_data -> 'shipper', 'shipper', true);
  v_consignee := public.kp_ttn_party(v_data -> 'consignee', 'consignee', true);
  v_customer := public.kp_ttn_party(v_data -> 'customer', 'customer', false);
  v_forwarder := public.kp_ttn_party(v_data -> 'forwarder', 'forwarder', false);

  -- Водій: з довідника (свого) або вручну; надруковане — знімок.
  v_driver_in := coalesce(v_data -> 'driver', '{}'::jsonb);
  IF jsonb_typeof(v_driver_in) <> 'object' THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:driver' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_driver_id := nullif(v_driver_in ->> 'id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:driver.id' USING ERRCODE = 'P0001';
  END;
  IF v_driver_id IS NOT NULL THEN
    SELECT * INTO v_drv FROM public.kp_drivers WHERE id = v_driver_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TTN_DRIVER_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_driver_name := coalesce(public.kp_ttn_text(v_driver_in ->> 'full_name', 200, 'driver.full_name'), v_drv.full_name);
  v_driver_license := coalesce(public.kp_ttn_text(v_driver_in ->> 'license_no', 30, 'driver.license_no'), v_drv.license_no);
  IF v_driver_name IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:driver.full_name' USING ERRCODE = 'P0001';
  END IF;
  IF v_driver_license IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:driver.license_no' USING ERRCODE = 'P0001';
  END IF;

  -- Транспортний засіб.
  v_vin := coalesce(v_data -> 'vehicle', '{}'::jsonb);
  IF jsonb_typeof(v_vin) <> 'object' THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:vehicle' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_vehicle_id := nullif(v_data ->> 'vehicle_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:vehicle_id' USING ERRCODE = 'P0001';
  END;
  IF v_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fleet_vehicles AS fv WHERE fv.id = v_vehicle_id AND fv.org_id = v_org) THEN
    RAISE EXCEPTION 'TTN_VEHICLE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  v_make := public.kp_ttn_text(v_vin ->> 'make_model', 100, 'vehicle.make_model');
  v_type := public.kp_ttn_text(v_vin ->> 'type', 100, 'vehicle.type');
  v_reg := upper(public.kp_ttn_text(v_vin ->> 'reg_number', 20, 'vehicle.reg_number'));
  v_t_make := public.kp_ttn_text(v_vin ->> 'trailer_make_model', 100, 'vehicle.trailer_make_model');
  v_t_type := public.kp_ttn_text(v_vin ->> 'trailer_type', 100, 'vehicle.trailer_type');
  v_t_reg := upper(public.kp_ttn_text(v_vin ->> 'trailer_reg_number', 20, 'vehicle.trailer_reg_number'));
  IF v_make IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.make_model' USING ERRCODE = 'P0001';
  END IF;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.type' USING ERRCODE = 'P0001';
  END IF;
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.reg_number' USING ERRCODE = 'P0001';
  END IF;
  -- Причіп / напівпричіп — якщо він є (вказано номер або марку): марка / модель, тип і номер обовʼязкові.
  IF v_t_reg IS NOT NULL OR v_t_make IS NOT NULL THEN
    IF v_t_make IS NULL THEN
      RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.trailer_make_model' USING ERRCODE = 'P0001';
    END IF;
    IF v_t_type IS NULL THEN
      RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.trailer_type' USING ERRCODE = 'P0001';
    END IF;
    IF v_t_reg IS NULL THEN
      RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.trailer_reg_number' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_len := public.kp_ttn_num(v_vin ->> 'length_m', 0, 30, 2, 'vehicle.length_m', 'TTN_FIELD_INVALID');
  v_wid := public.kp_ttn_num(v_vin ->> 'width_m', 0, 30, 2, 'vehicle.width_m', 'TTN_FIELD_INVALID');
  v_hgt := public.kp_ttn_num(v_vin ->> 'height_m', 0, 30, 2, 'vehicle.height_m', 'TTN_FIELD_INVALID');
  IF v_len IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.length_m' USING ERRCODE = 'P0001';
  END IF;
  IF v_wid IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.width_m' USING ERRCODE = 'P0001';
  END IF;
  IF v_hgt IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.height_m' USING ERRCODE = 'P0001';
  END IF;

  -- Маса: тара ТЗ + маса брутто вантажу = загальна маса з вантажем (рахує сервер).
  v_tare := public.kp_ttn_num(v_data ->> 'tare_t', 0, 100, 3, 'tare_t', 'TTN_FIELD_INVALID');
  v_max := public.kp_ttn_num(v_data ->> 'max_mass_t', 0, 100, 3, 'max_mass_t', 'TTN_FIELD_INVALID');
  -- Тара й макс. маса не передані, а авто з автопарку відоме: беремо їх із карток — тара автопоїзда = тара авто + тара причепа,
  -- так само макс. маса. Причіп є, а в його картці порожньо — суми немає (тара лишається обовʼязковою, тож форма просить її ввести).
  -- Передані значення (виправлені в формі для цієї ТТН) не чіпаємо; без причепа — лише авто.
  IF (v_tare IS NULL OR v_max IS NULL) AND v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_fvc FROM public.fleet_vehicles WHERE id = v_vehicle_id AND org_id = v_org;
    v_has_trl := v_t_reg IS NOT NULL OR v_t_make IS NOT NULL;
    IF v_has_trl THEN
      SELECT * INTO v_trc FROM public.fleet_trailers
      WHERE org_id = v_org AND ((v_t_reg IS NOT NULL AND plate_norm = public.kp_plate_norm(v_t_reg)) OR (v_t_reg IS NULL AND id = v_fvc.default_trailer_id))
      LIMIT 1;
    END IF;
    IF v_tare IS NULL THEN
      v_tare := CASE WHEN NOT v_has_trl THEN v_fvc.tare_t WHEN v_trc.tare_t IS NULL THEN NULL ELSE v_fvc.tare_t + v_trc.tare_t END;
    END IF;
    IF v_max IS NULL THEN
      v_max := CASE WHEN NOT v_has_trl THEN v_fvc.max_mass_t WHEN v_trc.max_mass_t IS NULL THEN NULL ELSE v_fvc.max_mass_t + v_trc.max_mass_t END;
    END IF;
  END IF;
  v_net := public.kp_ttn_num(v_data ->> 'cargo_net_t', 0, 1000, 3, 'cargo_net_t', 'TTN_FIELD_INVALID');
  v_gross := public.kp_ttn_num(v_data ->> 'cargo_gross_t', 0, 1000, 3, 'cargo_gross_t', 'TTN_FIELD_INVALID');
  IF v_tare IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:tare_t' USING ERRCODE = 'P0001';
  END IF;
  IF v_gross IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:cargo_gross_t' USING ERRCODE = 'P0001';
  END IF;
  IF v_net IS NOT NULL AND v_net > v_gross THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:cargo_net_t' USING ERRCODE = 'P0001', DETAIL = 'net above gross';
  END IF;

  v_load := public.kp_ttn_text(v_data ->> 'load_point', 500, 'load_point');
  v_unload := public.kp_ttn_text(v_data ->> 'unload_point', 500, 'unload_point');
  IF v_load IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:load_point' USING ERRCODE = 'P0001';
  END IF;
  IF v_unload IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:unload_point' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_places := nullif(btrim(coalesce(v_data ->> 'places_count', '')), '')::integer;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:places_count' USING ERRCODE = 'P0001';
  END;
  IF v_places IS NOT NULL AND (v_places < 0 OR v_places > 1000000) THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:places_count' USING ERRCODE = 'P0001';
  END IF;
  v_total := public.kp_ttn_num(v_data ->> 'total_amount', -0.001, 999999999.99, 2, 'total_amount', 'TTN_FIELD_INVALID');
  v_vat := public.kp_ttn_num(v_data ->> 'vat_amount', -0.001, 999999999.99, 2, 'vat_amount', 'TTN_FIELD_INVALID');
  IF v_vat IS NOT NULL AND (v_total IS NULL OR v_vat > v_total) THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:vat_amount' USING ERRCODE = 'P0001';
  END IF;

  -- Вантажно-розвантажувальні операції: до двох рядків (load / unload), маса брутто / тара / нетто і час.
  IF v_data ? 'operations' AND jsonb_typeof(v_data -> 'operations') <> 'null' THEN
    IF jsonb_typeof(v_data -> 'operations') <> 'array' OR jsonb_array_length(v_data -> 'operations') > 2 THEN
      RAISE EXCEPTION 'TTN_FIELD_INVALID:operations' USING ERRCODE = 'P0001';
    END IF;
    FOR v_op IN SELECT e.value FROM jsonb_array_elements(v_data -> 'operations') WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
      v_op_kind := v_op ->> 'op';
      IF jsonb_typeof(v_op) <> 'object' OR v_op_kind IS NULL OR v_op_kind NOT IN ('load', 'unload')
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ops) AS x(o) WHERE x.o ->> 'op' = v_op_kind) THEN
        RAISE EXCEPTION 'TTN_FIELD_INVALID:operations' USING ERRCODE = 'P0001';
      END IF;
      v_ops := v_ops || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'op', v_op_kind,
        'gross_t', public.kp_ttn_num(v_op ->> 'gross_t', 0, 1000, 3, 'operations.gross_t', 'TTN_FIELD_INVALID'),
        'tare_t', public.kp_ttn_num(v_op ->> 'tare_t', 0, 1000, 3, 'operations.tare_t', 'TTN_FIELD_INVALID'),
        'net_t', public.kp_ttn_num(v_op ->> 'net_t', 0, 1000, 3, 'operations.net_t', 'TTN_FIELD_INVALID'),
        'arrival', public.kp_ttn_text(v_op ->> 'arrival', 20, 'operations.arrival'),
        'departure', public.kp_ttn_text(v_op ->> 'departure', 20, 'operations.departure'),
        'idle', public.kp_ttn_text(v_op ->> 'idle', 20, 'operations.idle'))));
    END LOOP;
  END IF;

  -- Рядки вантажу: 1…50, усе перевіряємо до будь-якого запису.
  v_lines := v_data -> 'lines';
  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'TTN_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'count';
  END IF;
  FOR v_line IN SELECT e.value FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(v_line) <> 'object' OR public.kp_ttn_text(v_line ->> 'cargo_name', 500, 'lines.cargo_name') IS NULL THEN
      RAISE EXCEPTION 'TTN_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n;
    END IF;
    PERFORM public.kp_ttn_text(v_line ->> 'animal_id', 100, 'lines.animal_id'),
            public.kp_ttn_text(v_line ->> 'animal_kind', 100, 'lines.animal_kind'),
            public.kp_ttn_text(v_line ->> 'temperature', 50, 'lines.temperature'),
            public.kp_ttn_text(v_line ->> 'unit', 20, 'lines.unit'),
            public.kp_ttn_text(v_line ->> 'packaging', 100, 'lines.packaging'),
            public.kp_ttn_text(v_line ->> 'docs', 300, 'lines.docs'),
            public.kp_ttn_num(v_line ->> 'places', -1, 1000000, 0, 'lines.places', 'TTN_BAD_LINES'),
            public.kp_ttn_num(v_line ->> 'price', -0.001, 1000000000, 2, 'lines.price', 'TTN_BAD_LINES'),
            public.kp_ttn_num(v_line ->> 'amount', -0.001, 999999999.99, 2, 'lines.amount', 'TTN_BAD_LINES');
    IF coalesce((v_line ->> 'owner_price')::boolean, false) AND nullif(v_line ->> 'price', '') IS NOT NULL THEN
      RAISE EXCEPTION 'TTN_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n || ': owner price without a price';
    END IF;
    v_line_gross := public.kp_ttn_num(v_line ->> 'gross_t', 0, 1000, 3, 'lines.gross_t', 'TTN_BAD_LINES');
    IF v_line_gross IS NULL THEN
      v_all_gross := false;
    ELSE
      v_gross_sum := v_gross_sum + v_line_gross;
    END IF;
  END LOOP;
  -- Маса брутто в рядках (якщо вказана в кожному) = маса брутто вантажу.
  IF v_all_gross AND v_gross_sum <> v_gross THEN
    RAISE EXCEPTION 'TTN_MASS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = v_gross_sum::text || ' <> ' || v_gross::text;
  END IF;

  -- Знімок підпису й печатки перевізника (як у kp_doc_create).
  IF p_id IS NOT NULL AND (EXISTS (SELECT 1 FROM public.kp_doc_ttn AS t WHERE t.id = p_id)
                           OR EXISTS (SELECT 1 FROM public.kp_documents AS d WHERE d.id = p_id)) THEN
    RAISE EXCEPTION 'DOC_ID_TAKEN' USING ERRCODE = 'P0001';
  END IF;
  v_sig := CASE WHEN v_req.signature_path IS NOT NULL AND v_can_sign
    THEN v_org::text || '/docs/' || v_doc::text || '/signature.' || substring(v_req.signature_path FROM '\.(png|jpg)$') END;
  v_stamp := CASE WHEN v_req.stamp_path IS NOT NULL AND v_can_sign
    THEN v_org::text || '/docs/' || v_doc::text || '/stamp.' || substring(v_req.stamp_path FROM '\.(png|jpg)$') END;
  IF (v_sig IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_sig))
     OR (v_stamp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_stamp)) THEN
    RAISE EXCEPTION 'DOC_ASSETS_NOT_COPIED' USING ERRCODE = 'P0001';
  END IF;

  v_carrier := jsonb_strip_nulls(jsonb_build_object(
    'name', v_req.legal_name, 'code', coalesce(v_req.edrpou, v_req.ipn), 'address', v_req.legal_address,
    'signer_name', v_req.signer_name, 'signer_position', v_req.signer_position,
    'signature_path', v_sig, 'stamp_path', v_stamp));
  v_vehicle := jsonb_strip_nulls(jsonb_build_object(
    'make_model', v_make, 'type', v_type, 'reg_number', v_reg,
    'trailer_make_model', v_t_make, 'trailer_type', v_t_type, 'trailer_reg_number', v_t_reg,
    'length_m', v_len, 'width_m', v_wid, 'height_m', v_hgt, 'gross_total_t', v_tare + v_gross));

  v_year := extract(year FROM p_doc_date)::integer;
  v_no := public.kp_ttn_alloc_number(v_org, v_year, p_number);
  BEGIN
    INSERT INTO public.kp_doc_ttn (
      id, org_id, number, doc_year, prefix, doc_date, client_id, calculation_id, vehicle_id,
      place_of_issue, transport_kind, vehicle_parking_place, readdressing, seal_note,
      shipper, carrier, consignee, customer, forwarder, driver, vehicle, load_point, unload_point,
      places_count, cargo_net_t, cargo_gross_t, tare_t, total_mass_t, max_mass_t, accompanying_docs, total_amount, vat_amount,
      received_by, released_by, accepted_by, operations, created_by
    ) VALUES (
      v_doc, v_org, v_no, v_year, v_req.ttn_prefix, p_doc_date, p_client, p_calculation, v_vehicle_id,
      v_place,
      public.kp_ttn_text(v_data ->> 'transport_kind', 100, 'transport_kind'),
      public.kp_ttn_text(v_data ->> 'vehicle_parking_place', 500, 'vehicle_parking_place'),
      public.kp_ttn_text(v_data ->> 'readdressing', 500, 'readdressing'),
      public.kp_ttn_text(v_data ->> 'seal_note', 300, 'seal_note'),
      v_shipper, v_carrier, v_consignee, v_customer, v_forwarder,
      jsonb_build_object('full_name', v_driver_name, 'license_no', v_driver_license), v_vehicle, v_load, v_unload,
      v_places, v_net, v_gross, v_tare, v_tare + v_gross, v_max,
      public.kp_ttn_text(v_data ->> 'accompanying_docs', 500, 'accompanying_docs'), v_total, v_vat,
      public.kp_ttn_text(v_data ->> 'received_by', 300, 'received_by'),
      public.kp_ttn_text(v_data ->> 'released_by', 300, 'released_by'),
      public.kp_ttn_text(v_data ->> 'accepted_by', 300, 'accepted_by'),
      v_ops, auth.uid()
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = v_no::text;
  END;

  IF (v_sig IS NOT NULL OR v_stamp IS NOT NULL) AND public.kp_role() = 'logist' THEN
    PERFORM public.org_notify(v_org, 'signature_used', 'ttn', v_doc, auth.uid(),
      jsonb_build_object('doc_kind', 'ttn', 'number', v_no, 'prefix', v_req.ttn_prefix));
  END IF;

  INSERT INTO public.kp_doc_ttn_lines (
    ttn_id, org_id, sort, cargo_name, animal_id, animal_kind, temperature, unit, places, price, owner_price, amount,
    packaging, docs, gross_t, bulk
  )
  SELECT v_doc, v_org, e.ord::smallint,
         public.kp_ttn_text(e.value ->> 'cargo_name', 500, 'lines.cargo_name'),
         public.kp_ttn_text(e.value ->> 'animal_id', 100, 'lines.animal_id'),
         public.kp_ttn_text(e.value ->> 'animal_kind', 100, 'lines.animal_kind'),
         public.kp_ttn_text(e.value ->> 'temperature', 50, 'lines.temperature'),
         public.kp_ttn_text(e.value ->> 'unit', 20, 'lines.unit'),
         public.kp_ttn_num(e.value ->> 'places', -1, 1000000, 0, 'lines.places', 'TTN_BAD_LINES')::integer,
         public.kp_ttn_num(e.value ->> 'price', -0.001, 1000000000, 2, 'lines.price', 'TTN_BAD_LINES'),
         coalesce((e.value ->> 'owner_price')::boolean, false),
         public.kp_ttn_num(e.value ->> 'amount', -0.001, 999999999.99, 2, 'lines.amount', 'TTN_BAD_LINES'),
         public.kp_ttn_text(e.value ->> 'packaging', 100, 'lines.packaging'),
         public.kp_ttn_text(e.value ->> 'docs', 300, 'lines.docs'),
         public.kp_ttn_num(e.value ->> 'gross_t', 0, 1000, 3, 'lines.gross_t', 'TTN_BAD_LINES'),
         coalesce((e.value ->> 'bulk')::boolean, false)
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(value, ord);
  RETURN v_doc;
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.kp_trailers_list()', 'public.kp_trailer_save(uuid, jsonb)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;

COMMIT;
