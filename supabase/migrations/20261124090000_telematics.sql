-- Apply manually after review. This file is not applied to production by the agent.
--
-- «Власний парк», етап 2: телематика (Агроконтроль, лише read-only звіти). Модуль за прапорцем own_fleet (org_has_feature).
-- * telematics_sources: джерело даних організації (agrocontrol_mock | agrocontrol_api | file_import). Токенів у таблиці немає:
--   для майбутнього API лише ІМ'Я змінної середовища / секрету (api_secret_name), не значення.
-- * telematics_reports: денний звіт по авто (пробіг, пальне, простій, мотогодини). Унікальність (org_id, source_id, external_vehicle_ref, date):
--   повторний імпорт оновлює рядок. external_vehicle_ref зберігається нормалізованим (telematics_norm_plate), оригінал — у raw.
-- * telematics_fuel_events: заправки / зливи. Унікальність (org_id, source_id, external_vehicle_ref, ts, kind).
-- * telematics_vehicle_map: ручне зіставлення «позначка з Агроконтролю → авто» (автозіставлення — за нормалізованим держномером).
-- * telematics_vehicle_units: до якого підрозділу належить авто (для фільтра звіту).
-- * telematics_templates: збережений мапінг колонок імпорту (на організацію).
-- Читають owner / director / logist своєї організації (own_fleet_can_manage()); замовник підрозділу й чужі організації — ні.
-- Писати напряму не можна нікому: лише RPC tm_* (SECURITY DEFINER, search_path = public). Без прапорця own_fleet (або без доступу) вони дають 42501.

-- Держномер: верхній регістр, без пробілів і дефісів, схожа кирилиця → латиниця (А В Е І К М Н О Р С Т Х).
CREATE OR REPLACE FUNCTION public.telematics_norm_plate(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT translate(regexp_replace(upper(coalesce(p, '')), '[[:space:]‐-―-]+', '', 'g'), 'АВЕІКМНОРСТХ', 'ABEIKMHOPCTX');
$$;

CREATE TABLE IF NOT EXISTS public.telematics_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('agrocontrol_mock', 'agrocontrol_api', 'file_import')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  api_secret_name text CHECK (api_secret_name IS NULL OR api_secret_name ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind)
);

CREATE TABLE IF NOT EXISTS public.telematics_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.telematics_sources(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES public.fleet_vehicles(id) ON DELETE SET NULL,
  external_vehicle_ref text NOT NULL CHECK (char_length(external_vehicle_ref) BETWEEN 1 AND 40),
  date date NOT NULL,
  mileage_km numeric(10, 1) CHECK (mileage_km IS NULL OR mileage_km >= 0),
  fuel_used_l numeric(10, 1) CHECK (fuel_used_l IS NULL OR fuel_used_l >= 0),
  idle_minutes integer CHECK (idle_minutes IS NULL OR idle_minutes >= 0),
  engine_hours numeric(8, 1) CHECK (engine_hours IS NULL OR engine_hours >= 0),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source_id, external_vehicle_ref, date)
);
CREATE INDEX IF NOT EXISTS telematics_reports_org_date_idx ON public.telematics_reports (org_id, date);
CREATE INDEX IF NOT EXISTS telematics_reports_vehicle_idx ON public.telematics_reports (vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.telematics_fuel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.telematics_sources(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES public.fleet_vehicles(id) ON DELETE SET NULL,
  external_vehicle_ref text NOT NULL CHECK (char_length(external_vehicle_ref) BETWEEN 1 AND 40),
  ts timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('refuel', 'drain')),
  liters numeric(10, 1) NOT NULL CHECK (liters > 0),
  location text CHECK (location IS NULL OR char_length(location) <= 200),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source_id, external_vehicle_ref, ts, kind)
);
CREATE INDEX IF NOT EXISTS telematics_fuel_events_org_ts_idx ON public.telematics_fuel_events (org_id, ts);

CREATE TABLE IF NOT EXISTS public.telematics_vehicle_map (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  external_vehicle_ref text NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES public.fleet_vehicles(id) ON DELETE CASCADE,
  PRIMARY KEY (org_id, external_vehicle_ref)
);

CREATE TABLE IF NOT EXISTS public.telematics_vehicle_units (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_id uuid PRIMARY KEY REFERENCES public.fleet_vehicles(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.org_units(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.telematics_templates (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reports', 'fuel_events')),
  mapping jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind)
);

-- ---------------------------------------------------------------------------
-- RLS: читання персоналом своєї організації, запису напряму немає.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telematics_sources', 'telematics_reports', 'telematics_fuel_events', 'telematics_vehicle_map',
                           'telematics_vehicle_units', 'telematics_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage())',
                   t || '_select', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

-- Організація викликача, якщо модуль увімкнено і роль owner / director / logist; інакше 42501.
CREATE OR REPLACE FUNCTION public.tm_org()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
BEGIN
  IF v_org IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'TELEMATICS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END;
$$;

-- Авто організації за позначкою: ручне зіставлення, інакше збіг нормалізованого держномера з fleet_vehicles.label.
CREATE OR REPLACE FUNCTION public.tm_resolve_vehicle(p_org uuid, p_ref text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT m.vehicle_id FROM public.telematics_vehicle_map AS m WHERE m.org_id = p_org AND m.external_vehicle_ref = public.telematics_norm_plate(p_ref)),
    (SELECT v.id FROM public.fleet_vehicles AS v WHERE v.org_id = p_org AND public.telematics_norm_plate(v.label) = public.telematics_norm_plate(p_ref)
      ORDER BY v.label, v.id LIMIT 1));
$$;

-- Джерело певного виду для організації (створює, якщо немає). Токени не приймаються.
CREATE OR REPLACE FUNCTION public.tm_ensure_source(p_kind text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
  v_id uuid;
BEGIN
  IF p_kind NOT IN ('agrocontrol_mock', 'agrocontrol_api', 'file_import') THEN
    RAISE EXCEPTION 'TELEMATICS_INVALID_KIND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.telematics_sources (org_id, kind, name, status)
  VALUES (v_org, p_kind,
          CASE p_kind WHEN 'agrocontrol_mock' THEN 'Агроконтроль (тестові дані)' WHEN 'agrocontrol_api' THEN 'Агроконтроль (API)' ELSE 'Файли звітів' END,
          CASE WHEN p_kind = 'agrocontrol_api' THEN 'paused' ELSE 'active' END)
  ON CONFLICT (org_id, kind) DO NOTHING;
  SELECT s.id INTO v_id FROM public.telematics_sources AS s WHERE s.org_id = v_org AND s.kind = p_kind;
  RETURN v_id;
END;
$$;

-- Імпорт денних звітів. p_rows: [{date, ref, mileage_km, fuel_used_l, idle_minutes, engine_hours, raw}].
-- → {added, updated, skipped, unmapped}. Повторний імпорт оновлює рядки; некоректні рядки пропускаються.
CREATE OR REPLACE FUNCTION public.tm_import_reports(p_source uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
  v_total integer;
  v_valid integer;
  v_added integer;
  v_updated integer;
  v_unmapped integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.telematics_sources AS s WHERE s.id = p_source AND s.org_id = v_org) THEN
    RAISE EXCEPTION 'TELEMATICS_SOURCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'TELEMATICS_INVALID_ROWS' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_rows);
  IF v_total > 5000 THEN
    RAISE EXCEPTION 'TELEMATICS_TOO_MANY_ROWS' USING ERRCODE = '22023';
  END IF;

  CREATE TEMP TABLE tm_in ON COMMIT DROP AS
  SELECT DISTINCT ON (ref, d) ref, d, km, fuel, idle, eng, raw
  FROM (
    SELECT public.telematics_norm_plate(e ->> 'ref') AS ref,
           CASE WHEN e ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (e ->> 'date')::date END AS d,
           CASE WHEN e ->> 'mileage_km' ~ '^[0-9]{1,8}(\.[0-9]+)?$' THEN (e ->> 'mileage_km')::numeric END AS km,
           CASE WHEN e ->> 'fuel_used_l' ~ '^[0-9]{1,8}(\.[0-9]+)?$' THEN (e ->> 'fuel_used_l')::numeric END AS fuel,
           CASE WHEN e ->> 'idle_minutes' ~ '^[0-9]{1,6}(\.[0-9]+)?$' THEN round((e ->> 'idle_minutes')::numeric)::integer END AS idle,
           CASE WHEN e ->> 'engine_hours' ~ '^[0-9]{1,6}(\.[0-9]+)?$' THEN (e ->> 'engine_hours')::numeric END AS eng,
           CASE WHEN jsonb_typeof(e -> 'raw') = 'object' THEN e -> 'raw' ELSE '{}'::jsonb END AS raw,
           n
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, n)
    WHERE jsonb_typeof(e) = 'object'
  ) AS x
  WHERE ref <> '' AND char_length(ref) <= 40 AND d IS NOT NULL
  ORDER BY ref, d, n DESC;
  SELECT count(*) INTO v_valid FROM tm_in;

  WITH up AS (
    INSERT INTO public.telematics_reports AS r (org_id, source_id, vehicle_id, external_vehicle_ref, date, mileage_km, fuel_used_l, idle_minutes, engine_hours, raw)
    SELECT v_org, p_source, public.tm_resolve_vehicle(v_org, i.ref), i.ref, i.d, i.km, i.fuel, i.idle, i.eng, i.raw FROM tm_in AS i
    ON CONFLICT (org_id, source_id, external_vehicle_ref, date) DO UPDATE
      SET mileage_km = EXCLUDED.mileage_km, fuel_used_l = EXCLUDED.fuel_used_l, idle_minutes = EXCLUDED.idle_minutes,
          engine_hours = EXCLUDED.engine_hours, raw = EXCLUDED.raw, vehicle_id = EXCLUDED.vehicle_id, updated_at = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_added, v_updated FROM up;

  SELECT count(DISTINCT i.ref) INTO v_unmapped FROM tm_in AS i WHERE public.tm_resolve_vehicle(v_org, i.ref) IS NULL;
  UPDATE public.telematics_sources SET last_sync_at = now() WHERE id = p_source;
  DROP TABLE tm_in;
  RETURN jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_total - v_valid, 'unmapped', v_unmapped);
END;
$$;

-- Імпорт заправок / зливів. p_rows: [{ts, ref, kind: refuel|drain, liters, location, raw}]. → {added, updated, skipped, unmapped}.
CREATE OR REPLACE FUNCTION public.tm_import_fuel_events(p_source uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
  v_total integer;
  v_valid integer;
  v_added integer;
  v_updated integer;
  v_unmapped integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.telematics_sources AS s WHERE s.id = p_source AND s.org_id = v_org) THEN
    RAISE EXCEPTION 'TELEMATICS_SOURCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'TELEMATICS_INVALID_ROWS' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_rows);
  IF v_total > 5000 THEN
    RAISE EXCEPTION 'TELEMATICS_TOO_MANY_ROWS' USING ERRCODE = '22023';
  END IF;

  CREATE TEMP TABLE tm_in ON COMMIT DROP AS
  SELECT DISTINCT ON (ref, t, k) ref, t, k, lit, loc, raw
  FROM (
    SELECT public.telematics_norm_plate(e ->> 'ref') AS ref,
           CASE WHEN e ->> 'ts' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$'
                THEN CASE WHEN e ->> 'ts' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN (e ->> 'ts')::timestamptz
                          ELSE ((e ->> 'ts')::timestamp AT TIME ZONE 'Europe/Kyiv') END END AS t,
           CASE WHEN e ->> 'kind' IN ('refuel', 'drain') THEN e ->> 'kind' END AS k,
           CASE WHEN e ->> 'liters' ~ '^[0-9]{1,8}(\.[0-9]+)?$' THEN (e ->> 'liters')::numeric END AS lit,
           left(nullif(btrim(e ->> 'location'), ''), 200) AS loc,
           CASE WHEN jsonb_typeof(e -> 'raw') = 'object' THEN e -> 'raw' ELSE '{}'::jsonb END AS raw,
           n
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS q(e, n)
    WHERE jsonb_typeof(e) = 'object'
  ) AS x
  WHERE ref <> '' AND char_length(ref) <= 40 AND t IS NOT NULL AND k IS NOT NULL AND lit > 0
  ORDER BY ref, t, k, n DESC;
  SELECT count(*) INTO v_valid FROM tm_in;

  WITH up AS (
    INSERT INTO public.telematics_fuel_events AS f (org_id, source_id, vehicle_id, external_vehicle_ref, ts, kind, liters, location, raw)
    SELECT v_org, p_source, public.tm_resolve_vehicle(v_org, i.ref), i.ref, i.t, i.k, i.lit, i.loc, i.raw FROM tm_in AS i
    ON CONFLICT (org_id, source_id, external_vehicle_ref, ts, kind) DO UPDATE
      SET liters = EXCLUDED.liters, location = EXCLUDED.location, raw = EXCLUDED.raw, vehicle_id = EXCLUDED.vehicle_id
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_added, v_updated FROM up;

  SELECT count(DISTINCT i.ref) INTO v_unmapped FROM tm_in AS i WHERE public.tm_resolve_vehicle(v_org, i.ref) IS NULL;
  UPDATE public.telematics_sources SET last_sync_at = now() WHERE id = p_source;
  DROP TABLE tm_in;
  RETURN jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_total - v_valid, 'unmapped', v_unmapped);
END;
$$;

-- Ручне зіставлення позначки з авто (p_vehicle NULL — зняти). Перераховує vehicle_id у вже імпортованих рядках. → кількість оновлених звітів.
CREATE OR REPLACE FUNCTION public.tm_set_vehicle_map(p_ref text, p_vehicle uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
  v_ref text := public.telematics_norm_plate(p_ref);
  v_n integer;
BEGIN
  IF v_ref = '' THEN
    RAISE EXCEPTION 'TELEMATICS_INVALID_REF' USING ERRCODE = '22023';
  END IF;
  IF p_vehicle IS NULL THEN
    DELETE FROM public.telematics_vehicle_map WHERE org_id = v_org AND external_vehicle_ref = v_ref;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.fleet_vehicles AS v WHERE v.id = p_vehicle AND v.org_id = v_org) THEN
      RAISE EXCEPTION 'TELEMATICS_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.telematics_vehicle_map (org_id, external_vehicle_ref, vehicle_id) VALUES (v_org, v_ref, p_vehicle)
    ON CONFLICT (org_id, external_vehicle_ref) DO UPDATE SET vehicle_id = EXCLUDED.vehicle_id;
  END IF;
  UPDATE public.telematics_reports SET vehicle_id = public.tm_resolve_vehicle(v_org, v_ref) WHERE org_id = v_org AND external_vehicle_ref = v_ref;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.telematics_fuel_events SET vehicle_id = public.tm_resolve_vehicle(v_org, v_ref) WHERE org_id = v_org AND external_vehicle_ref = v_ref;
  RETURN v_n;
END;
$$;

-- Підрозділ авто (p_unit NULL — зняти).
CREATE OR REPLACE FUNCTION public.tm_set_vehicle_unit(p_vehicle uuid, p_unit uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fleet_vehicles AS v WHERE v.id = p_vehicle AND v.org_id = v_org) THEN
    RAISE EXCEPTION 'TELEMATICS_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_unit IS NULL THEN
    DELETE FROM public.telematics_vehicle_units WHERE org_id = v_org AND vehicle_id = p_vehicle;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_units AS u WHERE u.id = p_unit AND u.org_id = v_org) THEN
    RAISE EXCEPTION 'TELEMATICS_UNIT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.telematics_vehicle_units (org_id, vehicle_id, unit_id) VALUES (v_org, p_vehicle, p_unit)
  ON CONFLICT (vehicle_id) DO UPDATE SET unit_id = EXCLUDED.unit_id;
END;
$$;

-- Шаблон мапінгу колонок імпорту (на організацію): { "date": "Дата", ... }.
CREATE OR REPLACE FUNCTION public.tm_save_template(p_kind text, p_mapping jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
BEGIN
  IF p_kind NOT IN ('reports', 'fuel_events') OR p_mapping IS NULL OR jsonb_typeof(p_mapping) <> 'object' OR length(p_mapping::text) > 2000 THEN
    RAISE EXCEPTION 'TELEMATICS_INVALID_TEMPLATE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.telematics_templates (org_id, kind, mapping) VALUES (v_org, p_kind, p_mapping)
  ON CONFLICT (org_id, kind) DO UPDATE SET mapping = EXCLUDED.mapping, updated_at = now();
END;
$$;

-- Зведення по авто за період: пробіг, пальне, простій, мотогодини, кількість і обсяг зливів. p_unit — лише авто цього підрозділу.
-- Тестові дані (джерело agrocontrol_mock) не змішуються з реальними: p_mock = false (за замовчуванням) — лише реальні, true — лише тестові.
-- Межі періоду для подій — київська доба (Europe/Kyiv, з літнім / зимовим часом); денні звіти мають звичайну дату.
DROP FUNCTION IF EXISTS public.tm_summary(date, date, uuid, uuid);
CREATE OR REPLACE FUNCTION public.tm_summary(p_from date, p_to date, p_unit uuid DEFAULT NULL, p_vehicle uuid DEFAULT NULL, p_mock boolean DEFAULT false)
RETURNS TABLE (ref text, vehicle_id uuid, unit_id uuid, days integer, mileage_km numeric, fuel_used_l numeric, idle_minutes bigint,
               engine_hours numeric, drain_count integer, drain_l numeric, refuel_l numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.tm_org();
  v_mock boolean := coalesce(p_mock, false);
BEGIN
  RETURN QUERY
  WITH rep AS (
    SELECT r.external_vehicle_ref AS rref, r.vehicle_id AS rveh, count(DISTINCT r.date)::integer AS rdays, sum(r.mileage_km) AS km, sum(r.fuel_used_l) AS fuel,
           sum(r.idle_minutes)::bigint AS idle, sum(r.engine_hours) AS eng
    FROM public.telematics_reports AS r
    JOIN public.telematics_sources AS s ON s.id = r.source_id AND s.org_id = v_org
    WHERE r.org_id = v_org AND r.date BETWEEN p_from AND p_to AND (s.kind = 'agrocontrol_mock') = v_mock
    GROUP BY r.external_vehicle_ref, r.vehicle_id
  ), ev AS (
    SELECT f.external_vehicle_ref AS eref, f.vehicle_id AS eveh,
           (count(*) FILTER (WHERE f.kind = 'drain'))::integer AS dn, coalesce(sum(f.liters) FILTER (WHERE f.kind = 'drain'), 0) AS dl,
           coalesce(sum(f.liters) FILTER (WHERE f.kind = 'refuel'), 0) AS rl
    FROM public.telematics_fuel_events AS f
    JOIN public.telematics_sources AS s ON s.id = f.source_id AND s.org_id = v_org
    WHERE f.org_id = v_org AND (s.kind = 'agrocontrol_mock') = v_mock
      AND f.ts >= (p_from::timestamp AT TIME ZONE 'Europe/Kyiv') AND f.ts < ((p_to + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')
    GROUP BY f.external_vehicle_ref, f.vehicle_id
  ), joined AS (
    SELECT coalesce(a.rref, b.eref) AS jref, coalesce(a.rveh, b.eveh) AS jveh, a.rdays, a.km, a.fuel, a.idle, a.eng, b.dn, b.dl, b.rl
    FROM rep AS a
    FULL JOIN ev AS b ON b.eref = a.rref AND b.eveh IS NOT DISTINCT FROM a.rveh
  )
  SELECT j.jref, j.jveh, vu.unit_id, coalesce(j.rdays, 0), j.km, j.fuel, j.idle, j.eng, coalesce(j.dn, 0), coalesce(j.dl, 0), coalesce(j.rl, 0)
  FROM joined AS j
  LEFT JOIN public.telematics_vehicle_units AS vu ON vu.vehicle_id = j.jveh AND vu.org_id = v_org
  WHERE (p_unit IS NULL OR vu.unit_id = p_unit)
    AND (p_vehicle IS NULL OR j.jveh = p_vehicle)
  ORDER BY j.jref
  LIMIT 1000;
END;
$$;

-- Зливи за період (київська доба), без змішування тестових і реальних даних; day — київський календарний день події.
CREATE OR REPLACE FUNCTION public.tm_drains(p_from date, p_to date, p_mock boolean DEFAULT false)
RETURNS TABLE (id uuid, ts timestamptz, day date, ref text, vehicle_id uuid, liters numeric, location text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.tm_org();
BEGIN
  RETURN QUERY
  SELECT f.id, f.ts, (f.ts AT TIME ZONE 'Europe/Kyiv')::date, f.external_vehicle_ref, f.vehicle_id, f.liters, f.location
  FROM public.telematics_fuel_events AS f
  JOIN public.telematics_sources AS s ON s.id = f.source_id AND s.org_id = v_org
  WHERE f.org_id = v_org AND f.kind = 'drain' AND (s.kind = 'agrocontrol_mock') = coalesce(p_mock, false)
    AND f.ts >= (p_from::timestamp AT TIME ZONE 'Europe/Kyiv') AND f.ts < ((p_to + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')
  ORDER BY f.ts DESC
  LIMIT 100;
END;
$$;

-- Видалення ТІЛЬКИ тестових даних (джерела agrocontrol_mock) своєї організації. Лише owner / director. → {reports, events} — скільки видалено.
CREATE OR REPLACE FUNCTION public.tm_clear_mock()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.tm_org();
  v_reports integer;
  v_events integer;
BEGIN
  IF public.own_fleet_role() NOT IN ('owner', 'director') THEN
    RAISE EXCEPTION 'TELEMATICS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.telematics_reports AS r
  WHERE r.org_id = v_org AND r.source_id IN (SELECT s.id FROM public.telematics_sources AS s WHERE s.org_id = v_org AND s.kind = 'agrocontrol_mock');
  GET DIAGNOSTICS v_reports = ROW_COUNT;
  DELETE FROM public.telematics_fuel_events AS f
  WHERE f.org_id = v_org AND f.source_id IN (SELECT s.id FROM public.telematics_sources AS s WHERE s.org_id = v_org AND s.kind = 'agrocontrol_mock');
  GET DIAGNOSTICS v_events = ROW_COUNT;
  RETURN jsonb_build_object('reports', v_reports, 'events', v_events);
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.tm_org()', 'public.tm_ensure_source(text)', 'public.tm_import_reports(uuid, jsonb)', 'public.tm_import_fuel_events(uuid, jsonb)',
                           'public.tm_set_vehicle_map(text, uuid)', 'public.tm_set_vehicle_unit(uuid, uuid)', 'public.tm_save_template(text, jsonb)',
                           'public.tm_summary(date, date, uuid, uuid, boolean)', 'public.tm_drains(date, date, boolean)', 'public.tm_clear_mock()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
  REVOKE ALL ON FUNCTION public.tm_resolve_vehicle(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.tm_resolve_vehicle(uuid, text) TO service_role;
END;
$$;
