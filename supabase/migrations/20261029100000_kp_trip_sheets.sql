-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: подорожній лист вантажного автомобіля (таблиця kp_doc_trip_sheet, функції kp_trip_sheet_*).
-- НЕ плутати з ТТН: у коді ТТН — kp_doc_ttn / kp_ttn_*, подорожній лист — trip_sheet / kp_trip_sheet_*.
--
-- Форма: поля типової форми № 2 «Подорожній лист вантажного автомобіля» (спільний наказ Мінтрансу та Мінстату від
-- 29.12.1995 № 488/346): номер і дата, водій (табельний номер, ПІБ, посвідчення), автомобіль (марка, держномер,
-- гаражний номер), причіп (марка, держномер), рух пального (марка, видано, залишок при виїзді й поверненні),
-- завдання водієві (замовник, звідки / куди, вантаж), показання спідометра (виїзд / повернення, пробіг), відмітки про
-- медогляд і технічний стан, результати роботи (витрата за нормою й фактична). Правовий статус форми неоднозначний
-- (джерела розходяться щодо скасування наказу 2013 року), тому документ — первинний облікової політики компанії з
-- цими реквізитами. Персональні дані водія (телефон, паспорт, ІПН, адреса) сюди не потрапляють.
--
-- Статуси: issued («Видано») → closed («Закрито», внесено дані повернення) | cancelled («Анульовано», лише власник,
-- з причиною, номер лишається). Після видачі шапка, ТЗ, водій і завдання незмінні (знімок, як у ТТН); до закриття
-- змінюються лише поля повернення; закритий і анульований — незмінні. DELETE заборонено. Доступ лише через функції.
--
-- Нумерація — kp_doc_counters (kind 'trip_sheet', окрема від рахунків, актів і ТТН). Створити / закрити — kp_docs_org('write')
-- (власник і логіст), анулювати — kp_docs_org('owner'), читати — kp_docs_org('read') (директор лише читає).
-- Рейс: calculation_id (при видаленні рейсу → NULL). Документ із рейсу створюється лише з ПРИЙНЯТОЇ заявки
-- (calculations.status accepted | done) — те саме тепер вимагає й ТТН з рейсу (тригер kp_doc_ttn_calc_accepted).
-- kp_calc_doc_prefill(p_calculation) — усе, що форма ТТН / подорожнього листа підставляє із заявки.
--
-- Відкат (ручний):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_kp_doc_ttn_calc_accepted ON public.kp_doc_ttn;
--   DROP FUNCTION IF EXISTS public.kp_doc_ttn_calc_accepted();
--   DROP FUNCTION IF EXISTS public.kp_calc_doc_prefill(uuid);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_cancel(uuid, text);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_list(date, date, text, uuid);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_get(uuid);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_close(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_create(date, integer, jsonb, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_next_number(date);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_alloc_number(uuid, integer, integer);
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_fuel_norm(numeric, numeric, numeric, numeric);
--   DROP TABLE IF EXISTS public.kp_doc_trip_sheet;
--   DROP FUNCTION IF EXISTS public.kp_doc_trip_sheet_guard();
--   DELETE FROM public.kp_doc_counters WHERE kind = 'trip_sheet';
--   ALTER TABLE public.kp_doc_counters DROP CONSTRAINT IF EXISTS kp_doc_counters_kind_check;
--   ALTER TABLE public.kp_doc_counters ADD CONSTRAINT kp_doc_counters_kind_check CHECK (kind IN ('invoice', 'act', 'ttn'));
--   COMMIT;
-- Після відкату виписані листи зникають разом із таблицею; зробіть вивантаження перед відкатом.
--
-- Ідемпотентно. Після 20261026130623_kp_docs_ttn.sql і 20261028110000_kp_fleet_trailers.sql.

BEGIN;

-- Лічильник: новий вид 'trip_sheet' (усі CHECK-и по kind лічильника замінюємо одним іменованим).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.kp_doc_counters'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.kp_doc_counters DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.kp_doc_counters
    ADD CONSTRAINT kp_doc_counters_kind_check CHECK (kind IN ('invoice', 'act', 'ttn', 'trip_sheet'));
END;
$$;

-- driver — {full_name, license_no, tab_no}; vehicle — {make_model, reg_number, garage_no, trailer_make_model,
-- trailer_reg_number, fuel_load, fuel_empty} (норми л/100 км — знімок на момент видачі); task — {customer, route_from,
-- route_to, feed_point, via[], cargo, tonnage, loaded_km, planned_km}.
CREATE TABLE IF NOT EXISTS public.kp_doc_trip_sheet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  number integer NOT NULL,
  doc_year smallint NOT NULL,
  prefix text NULL,
  doc_date date NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  client_id uuid NULL REFERENCES public.clients (id) ON DELETE SET NULL,
  calculation_id uuid NULL REFERENCES public.calculations (id) ON DELETE SET NULL,
  vehicle_id uuid NULL REFERENCES public.fleet_vehicles (id) ON DELETE SET NULL,
  trailer_id uuid NULL REFERENCES public.fleet_trailers (id) ON DELETE SET NULL,
  carrier jsonb NOT NULL,
  driver jsonb NOT NULL,
  vehicle jsonb NOT NULL,
  task jsonb NOT NULL,
  depart_at timestamptz NOT NULL,
  depart_odometer integer NOT NULL,
  depart_fuel_left numeric(8, 1) NOT NULL,
  fuel_issued numeric(8, 1) NOT NULL DEFAULT 0,
  fuel_kind text NULL,
  medical_by text NULL,
  medical_at timestamptz NULL,
  tech_by text NULL,
  tech_at timestamptz NULL,
  tech_ok boolean NULL,
  return_at timestamptz NULL,
  return_odometer integer NULL,
  return_fuel_left numeric(8, 1) NULL,
  distance_km integer NULL,
  fuel_actual numeric(8, 1) NULL,
  fuel_norm numeric(8, 1) NULL,
  fuel_diff numeric(8, 1) NULL,
  closed_at timestamptz NULL,
  closed_by uuid NULL,
  status text NOT NULL DEFAULT 'issued',
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL,
  cancelled_reason text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_doc_trip_sheet_number_range CHECK (number BETWEEN 1 AND 999999999),
  CONSTRAINT kp_doc_trip_sheet_year_matches CHECK (doc_year = extract(year FROM doc_date)),
  CONSTRAINT kp_doc_trip_sheet_valid CHECK (valid_to >= valid_from AND valid_to - valid_from <= 366),
  CONSTRAINT kp_doc_trip_sheet_objects CHECK (
    jsonb_typeof(carrier) = 'object' AND jsonb_typeof(driver) = 'object' AND jsonb_typeof(vehicle) = 'object' AND jsonb_typeof(task) = 'object'),
  CONSTRAINT kp_doc_trip_sheet_numbers CHECK (
    depart_odometer BETWEEN 0 AND 9999999 AND depart_fuel_left BETWEEN 0 AND 5000 AND fuel_issued BETWEEN 0 AND 5000
    AND (return_odometer IS NULL OR (return_odometer BETWEEN 0 AND 9999999 AND return_odometer >= depart_odometer))
    AND (return_fuel_left IS NULL OR return_fuel_left BETWEEN 0 AND 5000)
    AND (return_at IS NULL OR return_at >= depart_at)),
  CONSTRAINT kp_doc_trip_sheet_text_len CHECK (
    coalesce(char_length(prefix), 0) <= 10 AND coalesce(char_length(fuel_kind), 0) <= 50
    AND coalesce(char_length(medical_by), 0) <= 200 AND coalesce(char_length(tech_by), 0) <= 200),
  CONSTRAINT kp_doc_trip_sheet_status_check CHECK (
    status IN ('issued', 'closed', 'cancelled')
    AND ((status = 'cancelled') = (cancelled_at IS NOT NULL))
    AND ((status = 'closed') = (closed_at IS NOT NULL))
    AND (status <> 'closed' OR (return_at IS NOT NULL AND return_odometer IS NOT NULL AND return_fuel_left IS NOT NULL AND distance_km IS NOT NULL AND fuel_actual IS NOT NULL))),
  CONSTRAINT kp_doc_trip_sheet_reason_len CHECK (cancelled_reason IS NULL OR char_length(cancelled_reason) <= 500),
  CONSTRAINT kp_doc_trip_sheet_number_key UNIQUE (org_id, doc_year, number)
);

CREATE INDEX IF NOT EXISTS kp_doc_trip_sheet_org_date_idx ON public.kp_doc_trip_sheet (org_id, doc_date DESC);
CREATE INDEX IF NOT EXISTS kp_doc_trip_sheet_calc_idx ON public.kp_doc_trip_sheet (calculation_id) WHERE calculation_id IS NOT NULL;

-- Незмінність: DELETE заборонено; закриття (лише поля повернення й розрахунок), анулювання, обнулення звʼязків.
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
  IF OLD.status = 'issued' AND NEW.status = 'closed' AND (v_new - v_close) = (v_old - v_close) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'issued' AND NEW.status = 'cancelled' AND (v_new - v_cancel) = (v_old - v_cancel) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_kp_doc_trip_sheet_guard ON public.kp_doc_trip_sheet;
CREATE TRIGGER trg_kp_doc_trip_sheet_guard
  BEFORE UPDATE OR DELETE ON public.kp_doc_trip_sheet
  FOR EACH ROW EXECUTE FUNCTION public.kp_doc_trip_sheet_guard();

ALTER TABLE public.kp_doc_trip_sheet ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kp_doc_trip_sheet FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.kp_doc_trip_sheet TO service_role;

-- Нормативна витрата, л: завантажений пробіг × норма з вантажем + порожній × норма порожнього (л / 100 км).
-- p_loaded_km NULL — весь пробіг за нормою з вантажем (якщо її немає — за порожнім). Немає потрібної норми → NULL.
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
  IF p_loaded_km IS NULL THEN
    v_loaded := CASE WHEN p_fuel_load IS NOT NULL THEN p_distance ELSE 0 END;
  ELSE
    v_loaded := least(greatest(p_loaded_km, 0), p_distance);
  END IF;
  v_empty := p_distance - v_loaded;
  IF (v_loaded > 0 AND p_fuel_load IS NULL) OR (v_empty > 0 AND p_fuel_empty IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN round(v_loaded * coalesce(p_fuel_load, 0) / 100 + v_empty * coalesce(p_fuel_empty, 0) / 100, 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_trip_sheet_alloc_number(p_org uuid, p_year integer, p_manual integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_no integer;
BEGIN
  IF p_manual IS NOT NULL THEN
    IF p_manual < 1 OR p_manual > 999999999 THEN
      RAISE EXCEPTION 'DOC_BAD_NUMBER' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.kp_doc_counters AS c (org_id, kind, year, next_no)
    VALUES (p_org, 'trip_sheet', p_year, p_manual + 1)
    ON CONFLICT (org_id, kind, year) DO UPDATE SET next_no = greatest(c.next_no, EXCLUDED.next_no), updated_at = now();
    IF EXISTS (SELECT 1 FROM public.kp_doc_trip_sheet AS t WHERE t.org_id = p_org AND t.doc_year = p_year AND t.number = p_manual) THEN
      RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = p_manual::text;
    END IF;
    RETURN p_manual;
  END IF;
  LOOP
    INSERT INTO public.kp_doc_counters AS c (org_id, kind, year, next_no)
    VALUES (p_org, 'trip_sheet', p_year, 2)
    ON CONFLICT (org_id, kind, year) DO UPDATE SET next_no = c.next_no + 1, updated_at = now()
    RETURNING c.next_no - 1 INTO v_no;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.kp_doc_trip_sheet AS t WHERE t.org_id = p_org AND t.doc_year = p_year AND t.number = v_no);
  END LOOP;
  RETURN v_no;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_trip_sheet_next_number(p_doc_date date)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_year integer;
  v_no integer;
BEGIN
  IF p_doc_date IS NULL THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  v_year := extract(year FROM p_doc_date)::integer;
  SELECT c.next_no INTO v_no FROM public.kp_doc_counters AS c WHERE c.org_id = v_org AND c.kind = 'trip_sheet' AND c.year = v_year;
  v_no := coalesce(v_no, 1);
  WHILE EXISTS (SELECT 1 FROM public.kp_doc_trip_sheet AS t WHERE t.org_id = v_org AND t.doc_year = v_year AND t.number = v_no) LOOP
    v_no := v_no + 1;
  END LOOP;
  RETURN v_no;
END;
$$;

-- Заявка прийнята (accepted | done) — інакше документ із неї не створюється.
CREATE OR REPLACE FUNCTION public.kp_calc_is_accepted(p_calculation uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.calculations AS c WHERE c.id = p_calculation AND c.status IN ('accepted', 'done'));
$$;

-- ТТН з рейсу — лише з прийнятої заявки (і для kp_ttn_create, і для будь-якого іншого запису).
CREATE OR REPLACE FUNCTION public.kp_doc_ttn_calc_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.calculation_id IS NOT NULL AND NOT public.kp_calc_is_accepted(NEW.calculation_id) THEN
    RAISE EXCEPTION 'CALC_NOT_ACCEPTED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kp_doc_ttn_calc_accepted ON public.kp_doc_ttn;
CREATE TRIGGER trg_kp_doc_ttn_calc_accepted
  BEFORE INSERT ON public.kp_doc_ttn
  FOR EACH ROW EXECUTE FUNCTION public.kp_doc_ttn_calc_accepted();

-- Видача. p_data: див. шапку (series, valid_from, valid_to, driver, vehicle_id, trailer_id, vehicle, task, depart, medical, tech).
-- Знімок водія — лише ПІБ, посвідчення, табельний номер. Помилка до вставки не зсуває лічильник (відкат).
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_create(
  p_doc_date date, p_number integer DEFAULT NULL, p_data jsonb DEFAULT NULL, p_calculation uuid DEFAULT NULL, p_client uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_req public.kp_org_requisites%ROWTYPE;
  v_doc uuid := gen_random_uuid();
  v_d jsonb := p_data;
  v_series text;
  v_from date;
  v_to date;
  v_drv_in jsonb;
  v_drv_id uuid;
  v_drv public.kp_drivers%ROWTYPE;
  v_driver jsonb;
  v_veh_in jsonb;
  v_veh_id uuid;
  v_fv public.fleet_vehicles%ROWTYPE;
  v_tr_id uuid;
  v_tr public.fleet_trailers%ROWTYPE;
  v_vehicle jsonb;
  v_task_in jsonb;
  v_task jsonb;
  v_via jsonb;
  v_dep jsonb;
  v_med jsonb;
  v_tech jsonb;
  v_reg text;
  v_make text;
  v_load text;
  v_unload text;
  v_depart_at timestamptz;
  v_odo numeric;
  v_left numeric;
  v_issued numeric;
  v_med_at timestamptz;
  v_tech_at timestamptz;
  v_year integer;
  v_no integer;
BEGIN
  IF p_doc_date IS NULL OR p_doc_date < DATE '2000-01-01' OR p_doc_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  IF v_d IS NULL OR jsonb_typeof(v_d) <> 'object' THEN
    RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  IF NOT FOUND OR v_req.legal_name IS NULL OR (v_req.edrpou IS NULL AND v_req.ipn IS NULL) THEN
    RAISE EXCEPTION 'REQUISITES_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_client IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clients AS c WHERE c.id = p_client AND c.org_id = v_org) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_calculation IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.calculations AS c WHERE c.id = p_calculation AND c.org_id = v_org AND public.kp_trip_visible(c.user_id)) THEN
      RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    IF NOT public.kp_calc_is_accepted(p_calculation) THEN
      RAISE EXCEPTION 'CALC_NOT_ACCEPTED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Серія і строк дії.
  v_series := public.kp_ttn_text(v_d ->> 'series', 10, 'series');
  BEGIN
    v_from := coalesce(nullif(v_d ->> 'valid_from', '')::date, p_doc_date);
    v_to := coalesce(nullif(v_d ->> 'valid_to', '')::date, v_from);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:valid_from' USING ERRCODE = 'P0001';
  END;
  IF v_to < v_from OR v_to - v_from > 366 THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:valid_to' USING ERRCODE = 'P0001';
  END IF;

  -- Водій: з довідника (свого) або вручну; у знімок лише ПІБ, посвідчення, табельний номер.
  v_drv_in := coalesce(v_d -> 'driver', '{}'::jsonb);
  IF jsonb_typeof(v_drv_in) <> 'object' THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:driver' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_drv_id := nullif(v_drv_in ->> 'id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:driver.id' USING ERRCODE = 'P0001';
  END;
  IF v_drv_id IS NOT NULL THEN
    SELECT * INTO v_drv FROM public.kp_drivers WHERE id = v_drv_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DRIVER_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_driver := jsonb_strip_nulls(jsonb_build_object(
    'full_name', coalesce(public.kp_ttn_text(v_drv_in ->> 'full_name', 200, 'driver.full_name'), v_drv.full_name),
    'license_no', coalesce(public.kp_ttn_text(v_drv_in ->> 'license_no', 30, 'driver.license_no'), v_drv.license_no),
    'tab_no', public.kp_ttn_text(v_drv_in ->> 'tab_no', 30, 'driver.tab_no')));
  IF v_driver ->> 'full_name' IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:driver.full_name' USING ERRCODE = 'P0001';
  END IF;
  IF v_driver ->> 'license_no' IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:driver.license_no' USING ERRCODE = 'P0001';
  END IF;

  -- ТЗ: авто з автопарку (своє) і причіп з fleet_trailers; поля можна уточнити вручну (знімок).
  v_veh_in := coalesce(v_d -> 'vehicle', '{}'::jsonb);
  IF jsonb_typeof(v_veh_in) <> 'object' THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:vehicle' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_veh_id := nullif(v_d ->> 'vehicle_id', '')::uuid;
    v_tr_id := nullif(v_d ->> 'trailer_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:vehicle_id' USING ERRCODE = 'P0001';
  END;
  IF v_veh_id IS NOT NULL THEN
    SELECT * INTO v_fv FROM public.fleet_vehicles WHERE id = v_veh_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF v_tr_id IS NOT NULL THEN
    SELECT * INTO v_tr FROM public.fleet_trailers WHERE id = v_tr_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TRAILER_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_make := coalesce(public.kp_ttn_text(v_veh_in ->> 'make_model', 100, 'vehicle.make_model'), v_fv.make_model);
  v_reg := upper(coalesce(public.kp_ttn_text(v_veh_in ->> 'reg_number', 20, 'vehicle.reg_number'), v_fv.label));
  IF v_make IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:vehicle.make_model' USING ERRCODE = 'P0001';
  END IF;
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:vehicle.reg_number' USING ERRCODE = 'P0001';
  END IF;
  v_vehicle := jsonb_strip_nulls(jsonb_build_object(
    'make_model', v_make, 'reg_number', v_reg,
    'garage_no', public.kp_ttn_text(v_veh_in ->> 'garage_no', 30, 'vehicle.garage_no'),
    'trailer_make_model', coalesce(public.kp_ttn_text(v_veh_in ->> 'trailer_make_model', 100, 'vehicle.trailer_make_model'), v_tr.make_model),
    'trailer_reg_number', upper(coalesce(public.kp_ttn_text(v_veh_in ->> 'trailer_reg_number', 20, 'vehicle.trailer_reg_number'), v_tr.plate)),
    'fuel_load', coalesce(public.kp_ttn_num(v_veh_in ->> 'fuel_load', 0, 200, 1, 'vehicle.fuel_load', 'TS_FIELD_INVALID'), v_fv.fuel_load),
    'fuel_empty', coalesce(public.kp_ttn_num(v_veh_in ->> 'fuel_empty', 0, 200, 1, 'vehicle.fuel_empty', 'TS_FIELD_INVALID'), v_fv.fuel_empty)));

  -- Завдання водієві.
  v_task_in := coalesce(v_d -> 'task', '{}'::jsonb);
  IF jsonb_typeof(v_task_in) <> 'object' THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:task' USING ERRCODE = 'P0001';
  END IF;
  v_load := public.kp_ttn_text(v_task_in ->> 'route_from', 500, 'task.route_from');
  v_unload := public.kp_ttn_text(v_task_in ->> 'route_to', 500, 'task.route_to');
  IF v_load IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:task.route_from' USING ERRCODE = 'P0001';
  END IF;
  IF v_unload IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:task.route_to' USING ERRCODE = 'P0001';
  END IF;
  v_via := coalesce(v_task_in -> 'via', '[]'::jsonb);
  IF jsonb_typeof(v_via) <> 'array' OR jsonb_array_length(v_via) > 10
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_via) AS e(value) WHERE jsonb_typeof(e.value) <> 'string' OR char_length(e.value #>> '{}') > 300 OR (e.value #>> '{}') ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:task.via' USING ERRCODE = 'P0001';
  END IF;
  v_task := jsonb_strip_nulls(jsonb_build_object(
    'customer', public.kp_ttn_text(v_task_in ->> 'customer', 300, 'task.customer'),
    'route_from', v_load, 'route_to', v_unload,
    'feed_point', public.kp_ttn_text(v_task_in ->> 'feed_point', 500, 'task.feed_point'),
    'via', CASE WHEN jsonb_array_length(v_via) = 0 THEN NULL ELSE v_via END,
    'cargo', public.kp_ttn_text(v_task_in ->> 'cargo', 500, 'task.cargo'),
    'tonnage', public.kp_ttn_num(v_task_in ->> 'tonnage', 0, 1000, 3, 'task.tonnage', 'TS_FIELD_INVALID'),
    'loaded_km', public.kp_ttn_num(v_task_in ->> 'loaded_km', -0.001, 100000, 0, 'task.loaded_km', 'TS_FIELD_INVALID'),
    'planned_km', public.kp_ttn_num(v_task_in ->> 'planned_km', -0.001, 100000, 0, 'task.planned_km', 'TS_FIELD_INVALID')));

  -- Виїзд.
  v_dep := coalesce(v_d -> 'depart', '{}'::jsonb);
  IF jsonb_typeof(v_dep) <> 'object' THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:depart' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_depart_at := nullif(v_dep ->> 'at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:depart.at' USING ERRCODE = 'P0001';
  END;
  IF v_depart_at IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:depart.at' USING ERRCODE = 'P0001';
  END IF;
  v_odo := public.kp_ttn_num(v_dep ->> 'odometer', -1, 9999999, 0, 'depart.odometer', 'TS_FIELD_INVALID');
  v_left := public.kp_ttn_num(v_dep ->> 'fuel_left', -0.001, 5000, 1, 'depart.fuel_left', 'TS_FIELD_INVALID');
  v_issued := coalesce(public.kp_ttn_num(v_dep ->> 'fuel_issued', -0.001, 5000, 1, 'depart.fuel_issued', 'TS_FIELD_INVALID'), 0);
  IF v_odo IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:depart.odometer' USING ERRCODE = 'P0001';
  END IF;
  IF v_left IS NULL THEN
    RAISE EXCEPTION 'TS_FIELD_REQUIRED:depart.fuel_left' USING ERRCODE = 'P0001';
  END IF;

  -- Відмітки: лише факт і час (без медичних даних).
  v_med := coalesce(v_d -> 'medical', '{}'::jsonb);
  v_tech := coalesce(v_d -> 'tech', '{}'::jsonb);
  IF jsonb_typeof(v_med) <> 'object' OR jsonb_typeof(v_tech) <> 'object' THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:marks' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_med_at := nullif(v_med ->> 'at', '')::timestamptz;
    v_tech_at := nullif(v_tech ->> 'at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:marks.at' USING ERRCODE = 'P0001';
  END;

  v_year := extract(year FROM p_doc_date)::integer;
  v_no := public.kp_trip_sheet_alloc_number(v_org, v_year, p_number);
  BEGIN
    INSERT INTO public.kp_doc_trip_sheet (
      id, org_id, number, doc_year, prefix, doc_date, valid_from, valid_to, client_id, calculation_id, vehicle_id, trailer_id,
      carrier, driver, vehicle, task, depart_at, depart_odometer, depart_fuel_left, fuel_issued, fuel_kind,
      medical_by, medical_at, tech_by, tech_at, tech_ok, created_by
    ) VALUES (
      v_doc, v_org, v_no, v_year, v_series, p_doc_date, v_from, v_to, p_client, p_calculation, v_veh_id, v_tr_id,
      jsonb_strip_nulls(jsonb_build_object('name', v_req.legal_name, 'code', coalesce(v_req.edrpou, v_req.ipn), 'address', v_req.legal_address)),
      v_driver, v_vehicle, v_task, v_depart_at, v_odo::integer, v_left, v_issued,
      public.kp_ttn_text(v_dep ->> 'fuel_kind', 50, 'depart.fuel_kind'),
      public.kp_ttn_text(v_med ->> 'by', 200, 'medical.by'), v_med_at,
      public.kp_ttn_text(v_tech ->> 'by', 200, 'tech.by'), v_tech_at,
      CASE WHEN v_tech ? 'ok' AND jsonb_typeof(v_tech -> 'ok') = 'boolean' THEN (v_tech ->> 'ok')::boolean END,
      auth.uid()
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = v_no::text;
  END;
  RETURN v_doc;
END;
$$;

-- Закриття: дані повернення (return_at, return_odometer, return_fuel_left). Пробіг, фактична й нормативна витрата рахує сервер.
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
BEGIN
  SELECT * INTO v_t FROM public.kp_doc_trip_sheet WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN (to_jsonb(v_t) - 'org_id') || jsonb_build_object(
    'kind', 'trip_sheet',
    'number_text', coalesce(v_t.prefix, '') || v_t.number::text,
    'client_name', (SELECT cl.name FROM public.clients AS cl WHERE cl.id = v_t.client_id),
    'created_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.created_by),
    'closed_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.closed_by),
    'cancelled_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.cancelled_by)
  );
END;
$$;

-- p_status: issued | closed | cancelled | NULL. p_calculation — листи одного рейсу.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_list(p_from date, p_to date, p_status text DEFAULT NULL, p_calculation uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, kind text, number integer, prefix text, number_text text, doc_date date, client_id uuid, client_name text,
  calculation_id uuid, vehicle_reg text, driver_name text, load_point text, unload_point text, status text,
  distance_km integer, cancelled_at timestamptz, created_at timestamptz
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
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('issued', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'DOC_BAD_STATUS' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT t.id, 'trip_sheet'::text, t.number, t.prefix, coalesce(t.prefix, '') || t.number::text, t.doc_date, t.client_id,
         coalesce(cl.name, t.task ->> 'customer'), t.calculation_id, t.vehicle ->> 'reg_number', t.driver ->> 'full_name',
         t.task ->> 'route_from', t.task ->> 'route_to', t.status, t.distance_km, t.cancelled_at, t.created_at
  FROM public.kp_doc_trip_sheet AS t
  LEFT JOIN public.clients AS cl ON cl.id = t.client_id
  WHERE t.org_id = v_org
    AND t.doc_date BETWEEN p_from AND p_to
    AND (p_status IS NULL OR t.status = p_status)
    AND (p_calculation IS NULL OR t.calculation_id = p_calculation)
  ORDER BY t.doc_date DESC, t.number DESC
  LIMIT 5000;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_trip_sheet_cancel(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_t public.kp_doc_trip_sheet%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO v_t FROM public.kp_doc_trip_sheet WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_t.status = 'cancelled' THEN
    RAISE EXCEPTION 'DOC_ALREADY_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  IF v_t.status = 'closed' THEN
    RAISE EXCEPTION 'TS_CLOSED_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'DOC_CANCEL_REASON' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_doc_trip_sheet
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancelled_reason = v_reason
  WHERE id = p_id;
  RETURN true;
END;
$$;

-- Усе, що форми ТТН і подорожнього листа підставляють із ПРИЙНЯТОЇ заявки. Нічого не пише. Інакше — CALC_NOT_ACCEPTED.
-- Поля inputs, яких немає (проміжні точки, вантаж), лишаються порожніми — їх вводить користувач.
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
      'dist_km', v_dist, 'feed_km', v_feed, 'variant', v_inp -> 'routeVariant'),
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
    'cargo', jsonb_build_object('tonnage', coalesce(v_tonnage, v_calc.tonnage), 'unit', 'т', 'rate', v_rate),
    'dates', jsonb_build_object('trip_date', v_calc.trip_date, 'days', v_days),
    'plan_fuel_l', v_plan));
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.kp_doc_trip_sheet_guard()',
    'public.kp_doc_ttn_calc_accepted()',
    'public.kp_trip_sheet_alloc_number(uuid, integer, integer)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.kp_trip_sheet_fuel_norm(numeric, numeric, numeric, numeric)',
    'public.kp_calc_is_accepted(uuid)',
    'public.kp_trip_sheet_next_number(date)',
    'public.kp_trip_sheet_create(date, integer, jsonb, uuid, uuid)',
    'public.kp_trip_sheet_close(uuid, jsonb)',
    'public.kp_trip_sheet_get(uuid)',
    'public.kp_trip_sheet_list(date, date, text, uuid)',
    'public.kp_trip_sheet_cancel(uuid, text)',
    'public.kp_calc_doc_prefill(uuid)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;

COMMIT;
