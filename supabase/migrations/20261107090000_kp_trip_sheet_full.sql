-- Apply manually after review. This file is not applied to production by the agent.
-- Подорожній лист як повноцінний первинний документ (форма № 2 / 2-ТН, ст. 9 Закону 996-XIV): відмітки лицьового боку
-- (допуск медика, медогляд після рейсу, механік на виїзді й при поверненні, диспетчер) і таблиця етапів зворотного боку
-- (замовник, № ТТН, пункти, час, км з вантажем, т, т·км). Старі міграції не змінюються; старі листи лишаються як були
-- (нові поля порожні, етапів немає). Таблиця листа — kp_doc_trip_sheet (20261028110121), закриття — 20261028140901.
--
-- Що додано:
--   * kp_doc_trip_sheet: medical_ok, medical_post_by / _at / _ok, mech_return_by / _at / _accepted, dispatcher_name;
--   * kp_trip_sheet_stages (org_id, RLS через kp_org_id(), каскадне видалення разом із листом; т·км — generated column);
--   * kp_trip_sheet_extra_save(uuid, jsonb): відмітки й етапи, лише поки лист «Видано»;
--   * kp_doc_trip_sheet_guard() — ті самі правила + нові відмітки редагуються до закриття; після закриття / анулювання — ні;
--   * kp_trip_sheet_get() — + stages і totals; kp_trip_sheet_close() — норма пального за сумою км з вантажем з етапів,
--     якщо вони є (інакше, як і раніше, за task.loaded_km). Закриття без дати/часу й одометра повернення відмовляє
--     (TS_FIELD_REQUIRED:return_at / :return_odometer) на сервері, не лише в UI.
--
-- РУЧНИЙ ВІДКАТ (дані етапів і нових відміток буде втрачено):
--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_extra_save(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.kp_ts_text(text, integer, text);
--   DROP FUNCTION IF EXISTS public.kp_ts_time(text, text);
--   DROP TABLE IF EXISTS public.kp_trip_sheet_stages;
--   ALTER TABLE public.kp_doc_trip_sheet DROP CONSTRAINT IF EXISTS kp_doc_trip_sheet_extra_len;
--   ALTER TABLE public.kp_doc_trip_sheet DROP COLUMN IF EXISTS medical_ok, DROP COLUMN IF EXISTS medical_post_by, DROP COLUMN IF EXISTS medical_post_at,
--     DROP COLUMN IF EXISTS medical_post_ok, DROP COLUMN IF EXISTS mech_return_by, DROP COLUMN IF EXISTS mech_return_at,
--     DROP COLUMN IF EXISTS mech_return_accepted, DROP COLUMN IF EXISTS dispatcher_name;
--   і повторно застосувати визначення kp_doc_trip_sheet_guard / kp_trip_sheet_close з 20261028140901 та kp_trip_sheet_get з 20261028110121.

-- ---------------------------------------------------------------------------
-- 1. Нові відмітки
-- ---------------------------------------------------------------------------

ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS medical_ok boolean NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS medical_post_by text NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS medical_post_at timestamptz NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS medical_post_ok boolean NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS mech_return_by text NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS mech_return_at timestamptz NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS mech_return_accepted boolean NULL;
ALTER TABLE public.kp_doc_trip_sheet ADD COLUMN IF NOT EXISTS dispatcher_name text NULL;

ALTER TABLE public.kp_doc_trip_sheet DROP CONSTRAINT IF EXISTS kp_doc_trip_sheet_extra_len;
ALTER TABLE public.kp_doc_trip_sheet ADD CONSTRAINT kp_doc_trip_sheet_extra_len CHECK (
  coalesce(char_length(medical_post_by), 0) <= 200 AND coalesce(char_length(mech_return_by), 0) <= 200
  AND coalesce(char_length(dispatcher_name), 0) <= 200);

-- ---------------------------------------------------------------------------
-- 2. Етапи (зворотний бік)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kp_trip_sheet_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES public.kp_doc_trip_sheet (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  customer text NULL CHECK (customer IS NULL OR char_length(customer) <= 300),
  ttn_no text NULL CHECK (ttn_no IS NULL OR char_length(ttn_no) <= 50),
  load_point text NULL CHECK (load_point IS NULL OR char_length(load_point) <= 500),
  unload_point text NULL CHECK (unload_point IS NULL OR char_length(unload_point) <= 500),
  arrive_load_at timestamptz NULL,
  depart_load_at timestamptz NULL,
  arrive_unload_at timestamptz NULL,
  depart_unload_at timestamptz NULL,
  loaded_km numeric(8, 1) NULL CHECK (loaded_km IS NULL OR loaded_km BETWEEN 0 AND 99999),
  tonnage numeric(8, 3) NULL CHECK (tonnage IS NULL OR tonnage BETWEEN 0 AND 999),
  -- т·км = км з вантажем × тонни; рахує база, вручну не задається.
  tkm numeric(14, 1) GENERATED ALWAYS AS (round(loaded_km * tonnage, 1)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_trip_sheet_stages_pos_key UNIQUE (sheet_id, position),
  CONSTRAINT kp_trip_sheet_stages_times CHECK (
    (arrive_load_at IS NULL OR depart_load_at IS NULL OR depart_load_at >= arrive_load_at)
    AND (arrive_unload_at IS NULL OR depart_unload_at IS NULL OR depart_unload_at >= arrive_unload_at))
);

CREATE INDEX IF NOT EXISTS kp_trip_sheet_stages_org_idx ON public.kp_trip_sheet_stages (org_id);

ALTER TABLE public.kp_trip_sheet_stages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kp_trip_sheet_stages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.kp_trip_sheet_stages TO authenticated;
GRANT ALL ON TABLE public.kp_trip_sheet_stages TO service_role;

DROP POLICY IF EXISTS kp_trip_sheet_stages_select ON public.kp_trip_sheet_stages;
CREATE POLICY kp_trip_sheet_stages_select ON public.kp_trip_sheet_stages
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- Етапи змінюються лише в листі «Видано» (захист і для службової ролі). Видалення разом із листом (каскад) не перевіряється.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_stages_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.kp_doc_trip_sheet AS t WHERE t.id = NEW.sheet_id AND t.org_id = NEW.org_id AND t.status = 'issued') THEN
    RAISE EXCEPTION 'TS_NOT_ISSUED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kp_trip_sheet_stages_guard ON public.kp_trip_sheet_stages;
CREATE TRIGGER trg_kp_trip_sheet_stages_guard
  BEFORE INSERT OR UPDATE ON public.kp_trip_sheet_stages
  FOR EACH ROW EXECUTE FUNCTION public.kp_trip_sheet_stages_guard();

-- ---------------------------------------------------------------------------
-- 3. Незмінність листа: до закриття редагуються поля повернення й відмітки лицьового боку
-- ---------------------------------------------------------------------------

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
  -- Поки лист «Видано»: повернення й відмітки (медогляд, механік, диспетчер).
  v_return text[] := ARRAY['return_at', 'return_odometer', 'return_fuel_left',
                           'medical_by', 'medical_at', 'medical_ok', 'tech_by', 'tech_at', 'tech_ok',
                           'medical_post_by', 'medical_post_at', 'medical_post_ok',
                           'mech_return_by', 'mech_return_at', 'mech_return_accepted', 'dispatcher_name'];
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

-- ---------------------------------------------------------------------------
-- 4. Допоміжні перевірки й збереження відміток та етапів
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_ts_time(p_val text, p_field text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_val IS NULL OR btrim(p_val) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN p_val::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:%', p_field USING ERRCODE = 'P0001';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_ts_text(p_val text, p_max integer, p_field text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := nullif(btrim(coalesce(p_val, '')), '');
BEGIN
  IF v IS NOT NULL AND (char_length(v) > p_max OR v ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'TS_FIELD_INVALID:%', p_field USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END;
$$;

-- Відмітки (лише передані ключі) і/або етапи (ключ stages: повна заміна списку) листа «Видано».
-- Відмітки: medical_by / medical_at / medical_ok (передрейсовий медогляд), tech_by / tech_at / tech_ok (механік на виїзді),
-- medical_post_by / _at / _ok (медогляд після рейсу), mech_return_by / _at / _accepted (механік при поверненні), dispatcher_name.
-- Етапи: масив до 50 об'єктів {customer, ttn_no, load_point, unload_point, arrive_load_at, depart_load_at, arrive_unload_at,
-- depart_unload_at, loaded_km, tonnage}; порядок масиву = порядок рядків, т·км рахує база.
CREATE OR REPLACE FUNCTION public.kp_trip_sheet_extra_save(p_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_t public.kp_doc_trip_sheet%ROWTYPE;
  v_text text[] := ARRAY['medical_by', 'tech_by', 'medical_post_by', 'mech_return_by', 'dispatcher_name'];
  v_time text[] := ARRAY['medical_at', 'tech_at', 'medical_post_at', 'mech_return_at'];
  v_bool text[] := ARRAY['medical_ok', 'tech_ok', 'medical_post_ok', 'mech_return_accepted'];
  v_patch jsonb := '{}'::jsonb;
  v_r public.kp_doc_trip_sheet%ROWTYPE;
  v_stages jsonb;
  v_s jsonb;
  v_n integer := 0;
  v_i integer;
  k text;
  b text;
  a1 timestamptz;
  d1 timestamptz;
  a2 timestamptz;
  d2 timestamptz;
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

  FOREACH k IN ARRAY v_text LOOP
    IF p_data ? k THEN
      v_patch := v_patch || jsonb_build_object(k, public.kp_ts_text(p_data ->> k, 200, k));
    END IF;
  END LOOP;
  FOREACH k IN ARRAY v_time LOOP
    IF p_data ? k THEN
      v_patch := v_patch || jsonb_build_object(k, public.kp_ts_time(p_data ->> k, k));
    END IF;
  END LOOP;
  FOREACH k IN ARRAY v_bool LOOP
    IF p_data ? k THEN
      b := nullif(p_data ->> k, '');
      IF b IS NOT NULL AND b NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'TS_FIELD_INVALID:%', k USING ERRCODE = 'P0001';
      END IF;
      v_patch := v_patch || jsonb_build_object(k, b::boolean);
    END IF;
  END LOOP;
  IF v_patch <> '{}'::jsonb THEN
    v_r := jsonb_populate_record(v_t, v_patch);
    UPDATE public.kp_doc_trip_sheet
    SET medical_by = v_r.medical_by, medical_at = v_r.medical_at, medical_ok = v_r.medical_ok,
        tech_by = v_r.tech_by, tech_at = v_r.tech_at, tech_ok = v_r.tech_ok,
        medical_post_by = v_r.medical_post_by, medical_post_at = v_r.medical_post_at, medical_post_ok = v_r.medical_post_ok,
        mech_return_by = v_r.mech_return_by, mech_return_at = v_r.mech_return_at, mech_return_accepted = v_r.mech_return_accepted,
        dispatcher_name = v_r.dispatcher_name
    WHERE id = p_id;
  END IF;

  IF p_data ? 'stages' THEN
    v_stages := p_data -> 'stages';
    IF v_stages IS NULL OR jsonb_typeof(v_stages) <> 'array' OR jsonb_array_length(v_stages) > 50 THEN
      RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.kp_trip_sheet_stages WHERE sheet_id = p_id;
    FOR v_i IN 0 .. jsonb_array_length(v_stages) - 1 LOOP
      v_s := v_stages -> v_i;
      IF jsonb_typeof(v_s) <> 'object' THEN
        RAISE EXCEPTION 'TS_BAD_DATA' USING ERRCODE = 'P0001';
      END IF;
      a1 := public.kp_ts_time(v_s ->> 'arrive_load_at', 'stages.arrive_load_at');
      d1 := public.kp_ts_time(v_s ->> 'depart_load_at', 'stages.depart_load_at');
      a2 := public.kp_ts_time(v_s ->> 'arrive_unload_at', 'stages.arrive_unload_at');
      d2 := public.kp_ts_time(v_s ->> 'depart_unload_at', 'stages.depart_unload_at');
      IF (a1 IS NOT NULL AND d1 IS NOT NULL AND d1 < a1) THEN
        RAISE EXCEPTION 'TS_FIELD_INVALID:stages.depart_load_at' USING ERRCODE = 'P0001';
      END IF;
      IF (a2 IS NOT NULL AND d2 IS NOT NULL AND d2 < a2) THEN
        RAISE EXCEPTION 'TS_FIELD_INVALID:stages.depart_unload_at' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.kp_trip_sheet_stages (sheet_id, org_id, position, customer, ttn_no, load_point, unload_point,
                                               arrive_load_at, depart_load_at, arrive_unload_at, depart_unload_at, loaded_km, tonnage)
      VALUES (p_id, v_org, v_i + 1,
              public.kp_ts_text(v_s ->> 'customer', 300, 'stages.customer'), public.kp_ts_text(v_s ->> 'ttn_no', 50, 'stages.ttn_no'),
              public.kp_ts_text(v_s ->> 'load_point', 500, 'stages.load_point'), public.kp_ts_text(v_s ->> 'unload_point', 500, 'stages.unload_point'),
              a1, d1, a2, d2,
              public.kp_ttn_num(v_s ->> 'loaded_km', -0.001, 99999, 1, 'stages.loaded_km', 'TS_FIELD_INVALID'),
              public.kp_ttn_num(v_s ->> 'tonnage', -0.001, 999, 3, 'stages.tonnage', 'TS_FIELD_INVALID'));
      v_n := v_n + 1;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('stages', v_n);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Читання: + етапи й підсумки
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
  RETURN (to_jsonb(v_t) - 'org_id') || jsonb_build_object(
    'kind', 'trip_sheet',
    'number_text', coalesce(v_t.prefix, '') || v_t.number::text,
    'client_name', (SELECT cl.name FROM public.clients AS cl WHERE cl.id = v_t.client_id),
    'created_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.created_by),
    'closed_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.closed_by),
    'cancelled_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.cancelled_by),
    'stages', v_stages,
    'totals', jsonb_build_object(
      'distance_km', coalesce(v_t.distance_km, v_t.return_odometer - v_t.depart_odometer),
      'loaded_km', v_loaded, 'tkm', v_tkm, 'trips', v_trips,
      'fuel_norm', v_t.fuel_norm, 'fuel_actual', v_t.fuel_actual, 'fuel_diff', v_t.fuel_diff)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Закриття: норма за сумою км з вантажем з етапів (якщо вони є)
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
  v_actual := round(v_t.depart_fuel_left + v_t.fuel_issued - v_left, 1);
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
-- 7. Права
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.kp_doc_trip_sheet_guard()',
    'public.kp_trip_sheet_stages_guard()',
    'public.kp_ts_time(text, text)',
    'public.kp_ts_text(text, integer, text)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.kp_trip_sheet_extra_save(uuid, jsonb)',
    'public.kp_trip_sheet_get(uuid)',
    'public.kp_trip_sheet_close(uuid, jsonb)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;
