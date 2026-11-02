-- Apply manually after review. This file is not applied to production by the agent.
-- Передрейсові відмітки подорожнього листа (медогляд до рейсу, механік на виїзді: медпрацівник / час / допуск, механік / час / справний)
-- після виїзду доступні лише для читання — на сервері, а не лише в інтерфейсі:
--   * kp_trip_sheet_extra_save() відмовляє TS_PRETRIP_LOCKED, якщо змінюється будь-яке з цих полів (повторне надсилання тих самих
--     значень дозволене, тому форма відміток не ламається);
--   * kp_doc_trip_sheet_guard() не пускає такі зміни навіть службовій ролі (42501 TS_PRETRIP_LOCKED).
-- «Після виїзду» = now() ≥ depart_at І з моменту створення листа минуло понад 10 хвилин: перші 10 хвилин лишаються на дозаповнення
-- відміток під час видачі (форма видачі зберігає допуск окремим викликом після створення). Післярейсові відмітки (медогляд після
-- рейсу, механік при поверненні) і диспетчер змінюються до закриття, як і раніше. Старі листи не змінюються.
--
-- РУЧНИЙ ВІДКАТ:
--   DROP FUNCTION IF EXISTS public.kp_ts_pretrip_locked(timestamptz, timestamptz);
--   і повторно застосувати визначення kp_trip_sheet_extra_save / kp_doc_trip_sheet_guard з 20261107090000_kp_trip_sheet_full.sql.

CREATE OR REPLACE FUNCTION public.kp_ts_pretrip_locked(p_depart timestamptz, p_created timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT now() >= p_depart AND now() > p_created + interval '10 minutes';
$$;

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
  -- Передрейсові відмітки (медогляд, механік на виїзді) після виїзду не змінюються — і для службової ролі.
  IF OLD.status = 'issued' AND public.kp_ts_pretrip_locked(OLD.depart_at, OLD.created_at)
     AND (NEW.medical_by, NEW.medical_at, NEW.medical_ok, NEW.tech_by, NEW.tech_at, NEW.tech_ok)
         IS DISTINCT FROM (OLD.medical_by, OLD.medical_at, OLD.medical_ok, OLD.tech_by, OLD.tech_at, OLD.tech_ok) THEN
    RAISE EXCEPTION 'TS_PRETRIP_LOCKED' USING ERRCODE = '42501';
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
    -- Після виїзду передрейсові відмітки лише читаються: зміна будь-якої з них — помилка (незмінене значення повторно слати можна).
    IF public.kp_ts_pretrip_locked(v_t.depart_at, v_t.created_at)
       AND (v_r.medical_by, v_r.medical_at, v_r.medical_ok, v_r.tech_by, v_r.tech_at, v_r.tech_ok)
           IS DISTINCT FROM (v_t.medical_by, v_t.medical_at, v_t.medical_ok, v_t.tech_by, v_t.tech_at, v_t.tech_ok) THEN
      RAISE EXCEPTION 'TS_PRETRIP_LOCKED' USING ERRCODE = '42501';
    END IF;
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

DO $$
DECLARE
  f text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.kp_ts_pretrip_locked(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.kp_doc_trip_sheet_guard() FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.kp_trip_sheet_extra_save(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.kp_trip_sheet_extra_save(uuid, jsonb) TO authenticated, service_role';
END;
$$;
