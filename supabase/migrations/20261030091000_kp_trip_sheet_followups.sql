-- Apply manually after review. This file is not applied to production by the agent.
--
-- Подорожній лист і документи з заявки: доробки після 20261029100000_kp_trip_sheets.sql. Старі міграції не редагуються.
--  1. kp_calc_is_accepted(uuid): чужу заявку (іншої організації) не видно — повертає false. Сервісна роль не обмежується.
--  2. Поля повернення (дата й час, спідометр, залишок пального) зберігаються до закриття листа:
--     kp_trip_sheet_return_save(id, data) пише їх у виданий лист; тригер-захист дозволяє міняти лише ці три поля, доки статус
--     «Видано». kp_trip_sheet_close бере передані значення або раніше збережені. Закритий і анульований лист незмінні.
--  3. kp_trip_sheet_fuel_norm: порожній «пробіг із вантажем» → норма NULL (раніше весь пробіг ішов за нормою завантаженого).
--  4. kp_calc_doc_prefill: додано cargo.name (inputs.cargoName) і route.approved_variant (погоджений директором варіант).
-- Потребує 20261030090000_calc_approved_variant.sql (колонка calculations.approved_variant).
--
-- Відкат лише цієї міграції (ручний): прибрати kp_trip_sheet_return_save(uuid, jsonb) і виконати CREATE OR REPLACE цих функцій з
-- 20261029100000_kp_trip_sheets.sql: kp_calc_is_accepted(uuid), kp_doc_trip_sheet_guard(), kp_trip_sheet_fuel_norm(numeric, numeric,
-- numeric, numeric), kp_trip_sheet_close(uuid, jsonb), kp_calc_doc_prefill(uuid).
--
-- Повний відкат підрозділу листів. Виконувати ПЕРЕД відкатом 20261029100000: прибирає нову функцію і kp_calc_is_accepted(uuid)
-- (її немає в блоці відкату 20261029100000) разом із тригером ТТН, що її викликає:
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_return_save(uuid, jsonb);
--   DROP TRIGGER IF EXISTS trg_kp_doc_ttn_calc_accepted ON public.kp_doc_ttn;
--   DROP FUNCTION IF EXISTS public.kp_doc_ttn_calc_accepted();
--   DROP FUNCTION IF EXISTS public.kp_calc_is_accepted(uuid);
--   COMMIT;
-- Після нього виконується відкат з шапки 20261029100000 (прибирає таблицю листів, решту функцій і лічильник).
--
-- Ідемпотентно (CREATE OR REPLACE).

BEGIN;

-- 1. Заявка прийнята (accepted | done) і належить організації користувача.
CREATE OR REPLACE FUNCTION public.kp_calc_is_accepted(p_calculation uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.calculations AS c
    WHERE c.id = p_calculation
      AND c.status IN ('accepted', 'done')
      AND (c.org_id = public.current_org_id() OR public.is_service_role())
  );
$$;

-- 2. Захист: до закриття (статус «Видано») можна змінювати лише поля повернення.
CREATE OR REPLACE FUNCTION public.kp_doc_trip_sheet_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_links text[] := ARRAY['calculation_id', 'vehicle_id', 'trailer_id', 'client_id'];
  v_close text[] := ARRAY['status', 'return_at', 'return_odometer', 'return_fuel_left', 'distance_km', 'fuel_actual', 'fuel_norm',
                          'fuel_diff', 'closed_at', 'closed_by'];
  v_cancel text[] := ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason'];
  v_return text[] := ARRAY['return_at', 'return_odometer', 'return_fuel_left'];
  v_old jsonb := to_jsonb(OLD) - v_links;
  v_new jsonb := to_jsonb(NEW) - v_links;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOC_DELETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Звʼязки можна лише обнулити (рейс чи авто видалили).
  IF (NEW.calculation_id IS NOT NULL AND NEW.calculation_id IS DISTINCT FROM OLD.calculation_id)
     OR (NEW.vehicle_id IS NOT NULL AND NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id)
     OR (NEW.trailer_id IS NOT NULL AND NEW.trailer_id IS DISTINCT FROM OLD.trailer_id)
     OR (NEW.client_id IS NOT NULL AND NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
    RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF v_old = v_new THEN
    RETURN NEW;
  END IF;
  -- Видано: поля повернення можна вносити й змінювати до закриття (статус лишається «Видано»).
  IF OLD.status = 'issued' AND NEW.status = 'issued' AND (v_new - v_return) = (v_old - v_return) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'issued' AND NEW.status = 'closed' AND (v_new - v_close) = (v_old - v_close) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'issued' AND NEW.status = 'cancelled' AND (v_new - v_cancel) = (v_old - v_cancel) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
END;
$$;

-- 2. Збереження полів повернення до закриття (чернетка повернення). Кожне поле необов'язкове; передані перевіряються так само, як
-- при закритті. Лист має бути «Видано». Пробіг і витрату рахує лише kp_trip_sheet_close.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_return_save(p_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_t public.kp_doc_trip_sheet%ROWTYPE;
  v_at timestamptz;
  v_odo numeric;
  v_left numeric;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_t FROM public.kp_doc_trip_sheet WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_t.status <> 'issued' THEN
    RAISE EXCEPTION 'TS_NOT_ISSUED' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_at := nullif(p_data ->> 'return_at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:return_at' USING ERRCODE = 'P0001';
  END;
  v_odo := public.kp_ttn_num(p_data ->> 'return_odometer', -1, 9999999, 0, 'return_odometer', 'TS_FIELD_INVALID');
  v_left := public.kp_ttn_num(p_data ->> 'return_fuel_left', -0.001, 5000, 1, 'return_fuel_left', 'TS_FIELD_INVALID');
  IF v_at IS NOT NULL AND v_at < v_t.depart_at THEN
    RAISE EXCEPTION 'TS_RETURN_BEFORE_DEPART' USING ERRCODE = 'P0001';
  END IF;
  IF v_odo IS NOT NULL AND v_odo < v_t.depart_odometer THEN
    RAISE EXCEPTION 'TS_ODOMETER_DECREASE' USING ERRCODE = 'P0001', DETAIL = v_t.depart_odometer::text;
  END IF;
  IF v_left IS NOT NULL AND v_t.depart_fuel_left + v_t.fuel_issued - v_left < 0 THEN
    RAISE EXCEPTION 'TS_FUEL_NEGATIVE' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_doc_trip_sheet
  SET return_at = v_at, return_odometer = v_odo::integer, return_fuel_left = v_left
  WHERE id = p_id;
  RETURN jsonb_build_object('return_at', v_at, 'return_odometer', v_odo::integer, 'return_fuel_left', v_left);
END;
$$;

-- 3. Норма: без пробігу з вантажем — NULL.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_fuel_norm(p_distance numeric, p_loaded_km numeric, p_fuel_load numeric, p_fuel_empty numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_loaded numeric;
  v_empty numeric;
BEGIN
  IF p_distance IS NULL OR p_distance < 0 THEN
    RETURN NULL;
  END IF;
  -- Без пробігу з вантажем норму не рахуємо (раніше весь пробіг ішов за нормою завантаженого).
  IF p_loaded_km IS NULL THEN
    RETURN NULL;
  END IF;
  v_loaded := least(greatest(p_loaded_km, 0), p_distance);
  v_empty := p_distance - v_loaded;
  IF (v_loaded > 0 AND p_fuel_load IS NULL) OR (v_empty > 0 AND p_fuel_empty IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN round(v_loaded * coalesce(p_fuel_load, 0) / 100 + v_empty * coalesce(p_fuel_empty, 0) / 100, 1);
END;
$$;

-- 2. Закриття: передані або раніше збережені дані повернення.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_close(p_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_t public.kp_doc_trip_sheet%ROWTYPE;
  v_at timestamptz;
  v_odo numeric;
  v_left numeric;
  v_dist integer;
  v_actual numeric;
  v_norm numeric;
BEGIN
  IF jsonb_typeof(coalesce(p_data, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_t FROM public.kp_doc_trip_sheet WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_t.status <> 'issued' THEN
    RAISE EXCEPTION 'TS_NOT_ISSUED' USING ERRCODE = 'P0001';
  END IF;
  -- Поля повернення, які не передано, беруться з раніше збережених (kp_trip_sheet_return_save).
  BEGIN
    v_at := coalesce(nullif(p_data ->> 'return_at', '')::timestamptz, v_t.return_at);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:return_at' USING ERRCODE = 'P0001';
  END;
  v_odo := coalesce(public.kp_ttn_num(p_data ->> 'return_odometer', -1, 9999999, 0, 'return_odometer', 'TS_FIELD_INVALID'), v_t.return_odometer);
  v_left := coalesce(public.kp_ttn_num(p_data ->> 'return_fuel_left', -0.001, 5000, 1, 'return_fuel_left', 'TS_FIELD_INVALID'), v_t.return_fuel_left);
  IF v_at IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:return_at' USING ERRCODE = 'P0001';
  END IF;
  IF v_odo IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:return_odometer' USING ERRCODE = 'P0001';
  END IF;
  IF v_left IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:return_fuel_left' USING ERRCODE = 'P0001';
  END IF;
  IF v_at < v_t.depart_at THEN
    RAISE EXCEPTION 'TS_RETURN_BEFORE_DEPART' USING ERRCODE = 'P0001';
  END IF;
  IF v_odo < v_t.depart_odometer THEN
    RAISE EXCEPTION 'TS_ODOMETER_DECREASE' USING ERRCODE = 'P0001', DETAIL = v_t.depart_odometer::text;
  END IF;
  v_dist := (v_odo - v_t.depart_odometer)::integer;
  v_actual := round(v_t.depart_fuel_left + v_t.fuel_issued - v_left, 1);
  IF v_actual < 0 THEN
    RAISE EXCEPTION 'TS_FUEL_NEGATIVE' USING ERRCODE = 'P0001';
  END IF;
  v_norm := public.kp_trip_sheet_fuel_norm(v_dist, (v_t.task ->> 'loaded_km')::numeric, (v_t.vehicle ->> 'fuel_load')::numeric, (v_t.vehicle ->> 'fuel_empty')::numeric);
  UPDATE public.kp_doc_trip_sheet
  SET status = 'closed', return_at = v_at, return_odometer = v_odo::integer, return_fuel_left = v_left, distance_km = v_dist,
      fuel_actual = v_actual, fuel_norm = v_norm, fuel_diff = CASE WHEN v_norm IS NULL THEN NULL ELSE round(v_actual - v_norm, 1) END,
      closed_at = now(), closed_by = auth.uid()
  WHERE id = p_id;
  RETURN jsonb_build_object('distance_km', v_dist, 'fuel_actual', v_actual, 'fuel_norm', v_norm,
                            'fuel_diff', CASE WHEN v_norm IS NULL THEN NULL ELSE round(v_actual - v_norm, 1) END);
END;
$$;

-- 4. Префіл ТТН / подорожнього листа: назва вантажу й погоджений варіант.
CREATE OR REPLACE FUNCTION public.kp_calc_doc_prefill(p_calculation uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_calc public.calculations%ROWTYPE;
  v_req public.kp_org_requisites%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_fv public.fleet_vehicles%ROWTYPE;
  v_tr public.fleet_trailers%ROWTYPE;
  v_drv public.kp_drivers%ROWTYPE;
  v_vehicle_id uuid;
  v_tonnage numeric;
  v_inp jsonb;
  v_dist numeric;
  v_feed numeric;
  v_days numeric;
  v_rate numeric;
  v_fl numeric;
  v_fe numeric;
  v_plan numeric;
BEGIN
  SELECT * INTO v_calc FROM public.calculations WHERE id = p_calculation AND org_id = v_org AND public.kp_trip_visible(user_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF v_calc.status NOT IN ('accepted', 'done') THEN
    RAISE EXCEPTION 'CALC_NOT_ACCEPTED' USING ERRCODE = 'P0001';
  END IF;
  v_inp := coalesce(v_calc.inputs, '{}'::jsonb);
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  SELECT cl.* INTO v_client FROM public.calculation_clients AS cc JOIN public.clients AS cl ON cl.id = cc.client_id AND cl.org_id = v_org
  WHERE cc.calculation_id = p_calculation ORDER BY cl.name LIMIT 1;
  SELECT cv.vehicle_id, cv.tonnage INTO v_vehicle_id, v_tonnage
  FROM public.calc_vehicles AS cv JOIN public.fleet_vehicles AS fv ON fv.id = cv.vehicle_id AND fv.org_id = v_org
  WHERE cv.calc_id = p_calculation ORDER BY cv.tonnage DESC, fv.label LIMIT 1;
  IF v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_fv FROM public.fleet_vehicles WHERE id = v_vehicle_id;
    SELECT * INTO v_tr FROM public.fleet_trailers WHERE id = v_fv.default_trailer_id AND org_id = v_org AND active;
    SELECT * INTO v_drv FROM public.kp_drivers WHERE id = v_fv.default_driver_id AND org_id = v_org AND active;
  END IF;
  v_dist := public.tc_num(v_inp, 'dist');
  v_feed := public.tc_num(v_inp, 'podachaDist');
  v_days := public.tc_num(v_inp, 'daysPerTrip');
  v_rate := public.tc_num(v_inp, 'rate');
  v_fl := coalesce(public.tc_num(v_inp, 'fuelLoad'), v_fv.fuel_load);
  v_fe := coalesce(public.tc_num(v_inp, 'fuelEmpty'), v_fv.fuel_empty);
  -- План пального (підказка): з вантажем — рейс, порожнім — подача й повернення.
  v_plan := CASE WHEN v_dist IS NULL OR v_fl IS NULL THEN NULL
                 ELSE round(v_dist * v_fl / 100 + (coalesce(v_feed, 0) + v_dist) * coalesce(v_fe, 0) / 100, 1) END;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'calculation', jsonb_build_object('id', v_calc.id, 'status', v_calc.status, 'name', v_calc.name, 'trip_date', v_calc.trip_date),
    'carrier', CASE WHEN v_req.org_id IS NULL THEN NULL ELSE jsonb_build_object(
      'name', v_req.legal_name, 'code', coalesce(v_req.edrpou, v_req.ipn), 'address', v_req.legal_address) END,
    'client', CASE WHEN v_client.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_client.id, 'name', v_client.name, 'legal_name', coalesce(v_client.legal_name, v_client.name),
      'code', coalesce(v_client.edrpou, v_client.ipn), 'address', v_client.legal_address) END,
    'route', jsonb_build_object(
      'from', v_calc.route_from, 'to', v_calc.route_to, 'base', nullif(v_inp ->> 'base', ''),
      'via', CASE WHEN jsonb_typeof(v_inp -> 'waypoints') = 'array' THEN v_inp -> 'waypoints' END,
      'dist_km', v_dist, 'feed_km', v_feed, 'variant', v_inp -> 'routeVariant', 'approved_variant', v_calc.approved_variant),
    'vehicle_id', v_fv.id,
    'vehicle', CASE WHEN v_fv.id IS NULL THEN NULL ELSE jsonb_build_object(
      'make_model', v_fv.make_model, 'type', v_fv.vehicle_type, 'reg_number', v_fv.label,
      'length_m', v_fv.length_m, 'width_m', v_fv.width_m, 'height_m', v_fv.height_m, 'tare_t', v_fv.tare_t, 'max_mass_t', v_fv.max_mass_t,
      'fuel_load', v_fv.fuel_load, 'fuel_empty', v_fv.fuel_empty) END,
    'trailer_id', v_tr.id,
    'trailer', CASE WHEN v_tr.id IS NULL THEN NULL ELSE jsonb_build_object(
      'plate', v_tr.plate, 'make_model', v_tr.make_model, 'type', v_tr.type) END,
    'driver', CASE WHEN v_drv.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_drv.id, 'full_name', v_drv.full_name, 'license_no', v_drv.license_no) END,
    'cargo', jsonb_build_object('tonnage', coalesce(v_tonnage, v_calc.tonnage), 'unit', 'т', 'rate', v_rate,
      'name', nullif(left(btrim(coalesce(v_inp ->> 'cargoName', '')), 500), '')),
    'dates', jsonb_build_object('trip_date', v_calc.trip_date, 'days', v_days),
    'plan_fuel_l', v_plan));
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.kp_doc_trip_sheet_guard() FROM PUBLIC, anon, authenticated, service_role';
  FOREACH f IN ARRAY ARRAY[
    'public.kp_calc_is_accepted(uuid)',
    'public.kp_trip_sheet_fuel_norm(numeric, numeric, numeric, numeric)',
    'public.kp_trip_sheet_close(uuid, jsonb)',
    'public.kp_trip_sheet_return_save(uuid, jsonb)',
    'public.kp_calc_doc_prefill(uuid)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;

COMMIT;
