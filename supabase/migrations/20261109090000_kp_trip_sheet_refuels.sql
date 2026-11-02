-- Apply manually after review. This file is not applied to production by the agent.
-- Подорожній лист: дозаправки в дорозі. Без них факт пального хибний, якщо авто заправлялось у рейсі.
-- Старі міграції не змінюються; старі листи лишаються як були (дозаправок немає → сума 0, факт рахується як раніше).
--
-- Що додано:
--   * kp_trip_sheet_refuels (org_id, sheet_id ON DELETE CASCADE, RLS через kp_org_id(), запис лише через RPC, сума рахується базою);
--   * kp_trip_sheet_refuels_save(uuid, jsonb): повна заміна списку дозаправок, лише поки лист «Видано»;
--   * kp_trip_sheet_get(): + refuels і totals.refuel_l;
--   * kp_trip_sheet_close(): факт = залишок на виїзді + видано на виїзді + сума дозаправок − залишок на поверненні;
--     залишок на поверненні більший за все, що було, → TS_FUEL_NEGATIVE (факт не буває від'ємним);
--   * kp_calc_doc_prefill(): норми л/100 км для листа — картка авто → дані заявки → «Витратна частина» компанії
--     (раніше брались лише з картки авто, тому «Норми: — / —» при порожній картці); план пального рахується з тими самими нормами.
--
-- РУЧНИЙ ВІДКАТ (дані дозаправок буде втрачено):
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_refuels_save(uuid, jsonb);
--   DROP TABLE IF EXISTS public.kp_trip_sheet_refuels;
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_refuels_guard();
--   і повторно застосувати визначення kp_trip_sheet_get / kp_trip_sheet_close з 20261107090000, kp_calc_doc_prefill з 20261028140901.

-- ---------------------------------------------------------------------------
-- 1. Таблиця дозаправок
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kp_trip_sheet_refuels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES public.kp_doc_trip_sheet (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  refuel_at timestamptz NULL,
  place text NULL CHECK (place IS NULL OR char_length(place) <= 300),
  liters numeric(8, 1) NOT NULL CHECK (liters > 0 AND liters <= 5000),
  price_per_l numeric(8, 2) NULL CHECK (price_per_l IS NULL OR (price_per_l >= 0 AND price_per_l <= 9999)),
  -- Сума = літри × ціна за л; рахує база, вручну не задається.
  amount numeric(14, 2) GENERATED ALWAYS AS (round(liters * price_per_l, 2)) STORED,
  pay_method text NULL CHECK (pay_method IS NULL OR pay_method IN ('card', 'cash', 'coupons')),
  receipt_no text NULL CHECK (receipt_no IS NULL OR char_length(receipt_no) <= 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_trip_sheet_refuels_pos_key UNIQUE (sheet_id, position)
);

CREATE INDEX IF NOT EXISTS kp_trip_sheet_refuels_org_idx ON public.kp_trip_sheet_refuels (org_id);

ALTER TABLE public.kp_trip_sheet_refuels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kp_trip_sheet_refuels FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.kp_trip_sheet_refuels TO authenticated;
GRANT ALL ON TABLE public.kp_trip_sheet_refuels TO service_role;

DROP POLICY IF EXISTS kp_trip_sheet_refuels_select ON public.kp_trip_sheet_refuels;
CREATE POLICY kp_trip_sheet_refuels_select ON public.kp_trip_sheet_refuels
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- Дозаправки змінюються лише в листі «Видано» (захист і для службової ролі). Каскадне видалення разом із листом (рядка листа вже немає) дозволене.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_refuels_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sheet_id ELSE NEW.sheet_id END;
  v_org uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  v_status text;
BEGIN
  SELECT t.status INTO v_status FROM public.kp_doc_trip_sheet AS t WHERE t.id = v_sheet AND t.org_id = v_org;
  IF TG_OP = 'DELETE' THEN
    IF v_status IS NOT NULL AND v_status <> 'issued' THEN
      RAISE EXCEPTION 'TS_NOT_ISSUED' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF v_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'TS_NOT_ISSUED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kp_trip_sheet_refuels_guard ON public.kp_trip_sheet_refuels;
CREATE TRIGGER trg_kp_trip_sheet_refuels_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.kp_trip_sheet_refuels
  FOR EACH ROW EXECUTE FUNCTION public.kp_trip_sheet_refuels_guard();

-- ---------------------------------------------------------------------------
-- 2. Збереження списку дозаправок (повна заміна), лише лист «Видано»
-- ---------------------------------------------------------------------------
-- p_rows: масив до 50 об'єктів {refuel_at, place, liters (обов'язково, > 0), price_per_l, pay_method (card|cash|coupons), receipt_no};
-- порядок масиву = порядок рядків. Помилки: TS_BAD_DATA, TS_FIELD_REQUIRED:refuels.liters, TS_FIELD_INVALID:refuels.<поле>, TS_NOT_ISSUED.

CREATE OR REPLACE FUNCTION public.kp_trip_sheet_refuels_save(p_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_t public.kp_doc_trip_sheet%ROWTYPE;
  v_r jsonb;
  v_i integer;
  v_n integer := 0;
  v_liters numeric;
  v_sum numeric := 0;
  v_pay text;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 50 THEN
    RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_t FROM public.kp_doc_trip_sheet WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_t.status <> 'issued' THEN
    RAISE EXCEPTION 'TS_NOT_ISSUED' USING ERRCODE = 'P0001';
  END IF;
  -- Спочатку перевіряємо всі рядки, потім замінюємо список: помилка в будь-якому рядку не залишає лист напівзбереженим.
  FOR v_i IN 0 .. jsonb_array_length(p_rows) - 1 LOOP
    v_r := p_rows -> v_i;
    IF jsonb_typeof(v_r) <> 'object' THEN
      RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.kp_ts_time(v_r ->> 'refuel_at', 'refuels.refuel_at');
    PERFORM public.kp_ts_text(v_r ->> 'place', 300, 'refuels.place');
    PERFORM public.kp_ts_text(v_r ->> 'receipt_no', 50, 'refuels.receipt_no');
    v_liters := public.kp_ttn_num(v_r ->> 'liters', 0, 5000, 1, 'refuels.liters', 'TS_FIELD_INVALID');
    IF v_liters IS NULL THEN
      RAISE EXCEPTION 'TS_FIELD_REQUIRED:refuels.liters' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.kp_ttn_num(v_r ->> 'price_per_l', -0.001, 9999, 2, 'refuels.price_per_l', 'TS_FIELD_INVALID');
    v_pay := nullif(btrim(coalesce(v_r ->> 'pay_method', '')), '');
    IF v_pay IS NOT NULL AND v_pay NOT IN ('card', 'cash', 'coupons') THEN
      RAISE EXCEPTION 'TS_FIELD_INVALID:refuels.pay_method' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  DELETE FROM public.kp_trip_sheet_refuels WHERE sheet_id = p_id;
  FOR v_i IN 0 .. jsonb_array_length(p_rows) - 1 LOOP
    v_r := p_rows -> v_i;
    v_liters := public.kp_ttn_num(v_r ->> 'liters', 0, 5000, 1, 'refuels.liters', 'TS_FIELD_INVALID');
    INSERT INTO public.kp_trip_sheet_refuels (sheet_id, org_id, position, refuel_at, place, liters, price_per_l, pay_method, receipt_no)
    VALUES (p_id, v_org, v_i + 1,
            public.kp_ts_time(v_r ->> 'refuel_at', 'refuels.refuel_at'), public.kp_ts_text(v_r ->> 'place', 300, 'refuels.place'),
            v_liters, public.kp_ttn_num(v_r ->> 'price_per_l', -0.001, 9999, 2, 'refuels.price_per_l', 'TS_FIELD_INVALID'),
            nullif(btrim(coalesce(v_r ->> 'pay_method', '')), ''), public.kp_ts_text(v_r ->> 'receipt_no', 50, 'refuels.receipt_no'));
    v_n := v_n + 1;
    v_sum := v_sum + v_liters;
  END LOOP;
  RETURN jsonb_build_object('refuels', v_n, 'liters', v_sum);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Читання: + дозаправки й їхня сума
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_trip_sheet_get(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_t public.kp_doc_trip_sheet%ROWTYPE;
  v_stages jsonb;
  v_loaded numeric;
  v_tkm numeric;
  v_trips integer;
  v_refuels jsonb;
  v_refuel_l numeric;
BEGIN
  SELECT * INTO v_t FROM public.kp_doc_trip_sheet WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'position', s.position, 'customer', s.customer, 'ttn_no', s.ttn_no, 'load_point', s.load_point, 'unload_point', s.unload_point,
           'arrive_load_at', s.arrive_load_at, 'depart_load_at', s.depart_load_at, 'arrive_unload_at', s.arrive_unload_at,
           'depart_unload_at', s.depart_unload_at, 'loaded_km', s.loaded_km, 'tonnage', s.tonnage, 'tkm', s.tkm) ORDER BY s.position), '[]'::jsonb),
         sum(s.loaded_km), sum(s.tkm), count(*)::integer
    INTO v_stages, v_loaded, v_tkm, v_trips
  FROM public.kp_trip_sheet_stages AS s WHERE s.sheet_id = p_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'position', r.position, 'refuel_at', r.refuel_at, 'place', r.place, 'liters', r.liters, 'price_per_l', r.price_per_l,
           'amount', r.amount, 'pay_method', r.pay_method, 'receipt_no', r.receipt_no) ORDER BY r.position), '[]'::jsonb),
         coalesce(sum(r.liters), 0)
    INTO v_refuels, v_refuel_l
  FROM public.kp_trip_sheet_refuels AS r WHERE r.sheet_id = p_id;
  RETURN (to_jsonb(v_t) - 'org_id') || jsonb_build_object(
    'kind', 'trip_sheet',
    'number_text', coalesce(v_t.prefix, '') || v_t.number::text,
    'client_name', (SELECT cl.name FROM public.clients AS cl WHERE cl.id = v_t.client_id),
    'created_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.created_by),
    'closed_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.closed_by),
    'cancelled_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.cancelled_by),
    'stages', v_stages,
    'refuels', v_refuels,
    'totals', jsonb_build_object(
      'distance_km', coalesce(v_t.distance_km, v_t.return_odometer - v_t.depart_odometer),
      'loaded_km', v_loaded, 'tkm', v_tkm, 'trips', v_trips,
      'refuel_l', v_refuel_l,
      'fuel_norm', v_t.fuel_norm, 'fuel_actual', v_t.fuel_actual, 'fuel_diff', v_t.fuel_diff)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Закриття: факт пального з урахуванням дозаправок
-- ---------------------------------------------------------------------------

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
  v_loaded numeric;
  v_refuel numeric;
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
  -- Лист закривається лише з датою/часом повернення й одометром повернення.
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
  -- Факт = залишок на виїзді + видано на виїзді + дозаправки в дорозі − залишок на поверненні. Залишок більший за все, що було, — помилка.
  SELECT coalesce(sum(r.liters), 0) INTO v_refuel FROM public.kp_trip_sheet_refuels AS r WHERE r.sheet_id = p_id;
  v_actual := round(v_t.depart_fuel_left + v_t.fuel_issued + v_refuel - v_left, 1);
  IF v_actual < 0 THEN
    RAISE EXCEPTION 'TS_FUEL_NEGATIVE' USING ERRCODE = 'P0001';
  END IF;
  -- Км з вантажем: сума з етапів, якщо вони внесені; інакше план із завдання.
  SELECT nullif(sum(s.loaded_km), 0) INTO v_loaded FROM public.kp_trip_sheet_stages AS s WHERE s.sheet_id = p_id;
  v_loaded := coalesce(v_loaded, (v_t.task ->> 'loaded_km')::numeric);
  v_norm := public.kp_trip_sheet_fuel_norm(v_dist, v_loaded, (v_t.vehicle ->> 'fuel_load')::numeric, (v_t.vehicle ->> 'fuel_empty')::numeric);
  UPDATE public.kp_doc_trip_sheet
  SET status = 'closed', return_at = v_at, return_odometer = v_odo::integer, return_fuel_left = v_left, distance_km = v_dist,
      fuel_actual = v_actual, fuel_norm = v_norm, fuel_diff = CASE WHEN v_norm IS NULL THEN NULL ELSE round(v_actual - v_norm, 1) END,
      closed_at = now(), closed_by = auth.uid()
  WHERE id = p_id;
  RETURN jsonb_build_object('distance_km', v_dist, 'fuel_actual', v_actual, 'fuel_norm', v_norm,
                            'fuel_diff', CASE WHEN v_norm IS NULL THEN NULL ELSE round(v_actual - v_norm, 1) END);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Норми пального в префілі подорожнього листа (картка авто → заявка → «Витратна частина»)
-- ---------------------------------------------------------------------------

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
  v_set jsonb;
  v_nl numeric;
  v_ne numeric;
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
  -- Норми для листа: картка авто → дані заявки → «Витратна частина» компанії (company_settings, ключі fuelLoad / fuelEmpty).
  SELECT cs.settings INTO v_set FROM public.company_settings AS cs WHERE cs.org_id = v_org;
  v_set := coalesce(v_set, '{}'::jsonb);
  -- Один пріоритет і для норм, і для плану пального нижче.
  v_fl := coalesce(v_fv.fuel_load, public.tc_num(v_inp, 'fuelLoad'), public.tc_num(v_set, 'fuelLoad'));
  v_fe := coalesce(v_fv.fuel_empty, public.tc_num(v_inp, 'fuelEmpty'), public.tc_num(v_set, 'fuelEmpty'));
  v_nl := v_fl;
  v_ne := v_fe;
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
      'fuel_load', v_nl, 'fuel_empty', v_ne) END,
    'norms', jsonb_build_object('fuel_load', v_nl, 'fuel_empty', v_ne),
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

-- ---------------------------------------------------------------------------
-- 6. Права
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.kp_trip_sheet_refuels_guard() FROM PUBLIC, anon, authenticated, service_role';
  FOREACH f IN ARRAY ARRAY[
    'public.kp_trip_sheet_refuels_save(uuid, jsonb)',
    'public.kp_trip_sheet_get(uuid)',
    'public.kp_trip_sheet_close(uuid, jsonb)',
    'public.kp_calc_doc_prefill(uuid)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;
