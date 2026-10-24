-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+ (Етап 3b): ТО і вартість на км.
--
-- * maintenance_types — шаблон типів ТО організації (інтервал км і/або місяців); vehicle_maintenance_overrides —
--   перевизначення на авто (NULL = з шаблону, disabled = тип для авто не відстежується). Архівування — м'яке.
-- * vehicle_odometer_readings — показання одометра (source 'manual'; 'gps' зарезервовано, поки ніхто не пише).
-- * Бази пробігу (kp_vehicle_odometer_bases — єдиний перелік): ручні показання (source 'manual') І ремонти
--   status = 'posted' цього авто з odometer_km (дата бази = repair_date). Сторнований ремонт базою бути перестає.
--   Пробіг на дату = остання база з read_on <= дата + км з рейсів після дати бази (kp_vehicle_mileage_at).
--   Однакова дата — перемагає пізніше створена (created_at показання / ремонту), далі більший id: порядок
--   детермінований. Старт відліку без виконань ТО — найраніша база з обох джерел.
--   GPS пізніше підмінить лише kp_vehicle_mileage_at; решта функцій викликає тільки її і kp_vehicle_trip_km.
-- * Показання не зменшуються (kp_odometer_guard): нове значення — ручне (kp_odometer_add) чи з ремонту (тригер
--   BEFORE INSERT / UPDATE на repairs) — не менше за найпізнішу базу з датою <= його дати і не більше за найранішу
--   базу з датою > його дати (вставка «в минуле» між показаннями). Рівне — можна. Інакше ODOMETER_DECREASE
--   (DETAIL 'км|дата' межі, HINT 'prev' / 'next').
-- * repair_maintenance — які типи ТО виконано ремонтом (done_on = дата ремонту, done_km = одометр ремонту або
--   розрахунковий пробіг на дату ремонту). Останнє виконання — лише обчисленням серед ремонтів 'posted': сторно
--   ремонту нічого не видаляє, відлік сам повертається до попереднього виконання (або до першої бази одометра).
--   Зміна дати, одометра чи авто ремонту перераховує done_on / done_km (тригер). Авто прибрали (vehicle_id NULL —
--   так робить видалення авто на сайті, ON DELETE SET NULL) — ТО цього ремонту видаляються: без авто вони нічого не
--   означають, а відмова зламала б видалення авто на сайті.
-- * Ремонт разом із ТО — одна транзакція (kp_repair_save_with_maintenance викликає kp_repair_post / kp_repair_update
--   і kp_repair_set_maintenance): будь-яка помилка — не зберігається нічого, склад не списано.
-- * Статус ТО «що раніше»: гірший з вимірів км (≤ 0 red, ≤ 5000 yellow) і часу (due ≤ сьогодні red, ≤ 14 днів yellow).
-- * Вартість на км: запчастини (списання без сторно) + СТО ремонтів 'posted' за період / км рейсів за період.
--
-- Км рейсів (kp_vehicle_trip_km). Що є в даних:
--   calculations.results — публічний результат /api/calculate: планових км (planLoadedKm / planEmptyKm / tripsCount)
--   там немає (це computeTrip().raw, у збережений результат не потрапляє); results.vehicleBreakdown — без км.
--   calc_vehicles — рядок на авто заявки: tonnage (його тоннаж) і snapshot.resolved.payloadTons (його вантажність);
--   API рахує заявку з авто саме так: кожне авто — окремий зріз computeTrip (vehicleSlicePayload).
--   trip_actuals (fact_version = 'v2') — fact_loaded_km + fact_empty_km на ВСЮ заявку (усі авто, усі ходки), без подачі.
-- Формула для авто V у (p_from, p_to] — заявки org зі статусом accepted / done, trip_date у вікні, з рядком
-- calc_vehicles для V (без такого рядка заявка не рахується, навіть якщо vehicles_count = 1):
--   план зрізу авто = kp_trip_plan_km: дзеркало computeTrip для зрізу (carsCount = 1; разовий — 1 ходка dist;
--   циклічний — ходок ceil(tonnage / норма), норма = payloadTons або inputs.normWeight, з вантажем dist·ходки,
--   порожнім dist·(ходки − 1); кругорейс — частка зворотного вантажу жадібно за порядком inputs.vehicles, як
--   returnCargoShares) + подача. Подача авто = podachaDist один раз на заявку (computeTrip: totalPodachaKm =
--   podachaDist × carsCount, у зрізі carsCount = 1), не на кожну ходку. Разом = tripFactBasis: loadedKm + emptyKm
--   + podachaKm.
--   Факт v2 подачі не містить, тому:
--     без факту — км авто = план авто (з подачею);
--     з фактом — км авто = факт × план_без_подачі авто / Σ план_без_подачі усіх рядків заявки + подача авто
--     (частка факту — як vehicleFactShares; подачу додаємо окремо: її у факті немає, і вона однакова для всіх авто);
--     Σ план без подачі = 0 — факт / кількість рядків calc_vehicles з vehicle_id + подача авто.
--   NULL — 0; від'ємних не буває.
--
-- Хвости 3a (CREATE OR REPLACE тієї самої сигнатури, права ті самі):
-- * kp_repair_invite_reserve — на початку видаляє записи repair_invite_sends старші за добу (sent_at); ліміти як були.
-- * kp_user_has_own_kp — директор заблокованої організації (organizations.status = 'blocked') власного КП не має.
--
-- Лише адитивно: нові таблиці, функції, тригери на repairs і політики на нових таблицях. calculations, calc_vehicles,
-- trip_actuals, fleet_vehicles, kp_org_id / kp_role / kp_can_write / kp_context не змінюються. Ідемпотентно.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.maintenance_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  interval_km integer NULL CHECK (interval_km IS NULL OR interval_km BETWEEN 1 AND 1000000),
  interval_months integer NULL CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_types_interval_required CHECK (interval_km IS NOT NULL OR interval_months IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS maintenance_types_org_name_uidx
  ON public.maintenance_types (org_id, lower(name)) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.vehicle_maintenance_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES public.fleet_vehicles (id) ON DELETE CASCADE,
  type_id uuid NOT NULL REFERENCES public.maintenance_types (id) ON DELETE CASCADE,
  interval_km integer NULL CHECK (interval_km IS NULL OR interval_km BETWEEN 1 AND 1000000),
  interval_months integer NULL CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 120),
  disabled boolean NOT NULL DEFAULT false,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_maintenance_overrides_vehicle_type_key UNIQUE (vehicle_id, type_id)
);

-- Показання одометра. Видалення авто на сайті працює як раніше (CASCADE): без авто показання нічого не означають.
CREATE TABLE IF NOT EXISTS public.vehicle_odometer_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES public.fleet_vehicles (id) ON DELETE CASCADE,
  read_on date NOT NULL,
  odometer_km integer NOT NULL CHECK (odometer_km BETWEEN 0 AND 10000000),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'gps')),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 200),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_odometer_readings_vehicle_idx
  ON public.vehicle_odometer_readings (vehicle_id, read_on DESC);

CREATE TABLE IF NOT EXISTS public.repair_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  repair_id uuid NOT NULL REFERENCES public.repairs (id) ON DELETE RESTRICT,
  type_id uuid NOT NULL REFERENCES public.maintenance_types (id) ON DELETE RESTRICT,
  done_on date NOT NULL,
  done_km integer NULL CHECK (done_km IS NULL OR done_km BETWEEN 0 AND 20000000),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repair_maintenance_repair_type_key UNIQUE (repair_id, type_id)
);

CREATE INDEX IF NOT EXISTS repair_maintenance_org_type_idx
  ON public.repair_maintenance (org_id, type_id, done_on DESC);

-- Клієнти лише читають свою організацію (як 3a); пишуть лише функції нижче (SECURITY DEFINER) і service_role.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_types', 'vehicle_maintenance_overrides', 'vehicle_odometer_readings', 'repair_maintenance'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (org_id = public.kp_repairs_org_id())', t || '_select', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trip km and mileage (internal: not callable by clients)
-- ---------------------------------------------------------------------------

-- Подача зрізу одного авто: podachaDist один раз на заявку (computeTrip: podachaDist × carsCount, carsCount = 1).
-- Зріз без тоннажу не рахується взагалі (як у kp_trip_plan_km).
CREATE OR REPLACE FUNCTION public.kp_trip_podacha_km(p_inputs jsonb, p_tonnage numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_tonnage > 0 THEN greatest(coalesce(public.tc_num(coalesce(p_inputs, '{}'::jsonb), 'podachaDist'), 0), 0) ELSE 0 END;
$$;

-- Плановий пробіг (з вантажем + порожній + подача) зрізу заявки на одне авто — дзеркало computeTrip
-- (api/calculate.js) для vehicleSlicePayload: carsCount = 1; p_rt_volume — частка авто у зворотному вантажі.
-- Подача зрізу — kp_trip_podacha_km (podachaDist один раз).
CREATE OR REPLACE FUNCTION public.kp_trip_plan_km(p_inputs jsonb, p_tonnage numeric, p_payload numeric, p_rt_volume numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  inp jsonb := coalesce(p_inputs, '{}'::jsonb);
  v_one_off boolean := coalesce(inp ->> 'returnMode', '') = 'разовий';
  v_dist numeric := greatest(coalesce(public.tc_num(inp, 'dist'), 0), 0);
  v_norm numeric;
  v_trips numeric;
  v_loaded numeric;
  v_empty numeric;
  v_legs numeric;
  v_replaced numeric;
BEGIN
  IF p_tonnage IS NULL OR p_tonnage <= 0 THEN
    RETURN 0;
  END IF;
  IF v_one_off THEN
    v_norm := p_tonnage;
    v_trips := 1;
    v_loaded := v_dist;
    v_empty := 0;
  ELSE
    v_norm := CASE WHEN p_payload > 0 THEN p_payload ELSE public.tc_num(inp, 'normWeight') END;
    v_trips := CASE WHEN v_norm > 0 THEN ceil(p_tonnage / v_norm) ELSE 0 END;
    v_loaded := v_dist * v_trips;
    v_empty := v_dist * greatest(0, v_trips - 1);
  END IF;
  -- Кругорейс: зворотні ходки замінюють порожні повернення контуром B→C (порожнім) → C→D (з вантажем) → D→A (порожнім).
  IF inp -> 'isRoundTrip' = 'true'::jsonb AND coalesce(p_rt_volume, 0) > 0 AND v_norm > 0 THEN
    v_legs := least(v_trips, ceil(p_rt_volume / v_norm - 1e-9));
    v_replaced := least(v_legs, CASE WHEN v_one_off THEN 0 ELSE greatest(0, v_trips - 1) END);
    v_empty := greatest(0, v_empty - v_replaced * v_dist
      + v_legs * (greatest(coalesce(public.tc_num(inp, 'rtTransferDist'), 0), 0) + greatest(coalesce(public.tc_num(inp, 'rtReturnDist'), 0), 0)));
    v_loaded := v_loaded + v_legs * greatest(coalesce(public.tc_num(inp, 'rtBackhaulDist'), 0), 0);
  END IF;
  RETURN greatest(0, v_loaded + v_empty) + public.kp_trip_podacha_km(inp, p_tonnage);
END;
$$;

-- Км з рейсів авто p_vehicle у (p_from, p_to]: лише агрегат (число). Формула — у шапці файлу.
CREATE OR REPLACE FUNCTION public.kp_vehicle_trip_km(p_org uuid, p_vehicle uuid, p_from date, p_to date)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH trips AS (
    SELECT c.id, coalesce(c.inputs, '{}'::jsonb) AS inputs,
           CASE WHEN ta.fact_version = 'v2' THEN greatest(0, coalesce(ta.fact_loaded_km, 0) + coalesce(ta.fact_empty_km, 0)) END AS fact_km
    FROM public.calculations AS c
    LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
    WHERE c.org_id = p_org
      AND c.status IN ('accepted', 'done')
      AND c.trip_date > p_from AND c.trip_date <= p_to
      AND EXISTS (SELECT 1 FROM public.calc_vehicles AS mine WHERE mine.calc_id = c.id AND mine.vehicle_id = p_vehicle)
  ), slices AS (
    SELECT t.id, t.inputs, t.fact_km, cv.vehicle_id, cv.tonnage,
           public.tc_num(coalesce(cv.snapshot -> 'resolved', '{}'::jsonb), 'payloadTons') AS payload,
           -- Порядок авто — як у inputs.vehicles (від нього залежить жадібний розподіл зворотного вантажу).
           (SELECT e.ord FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.inputs -> 'vehicles') = 'array' THEN t.inputs -> 'vehicles' ELSE '[]'::jsonb END)
                              WITH ORDINALITY AS e(item, ord)
            WHERE e.item ->> 'id' = cv.vehicle_id::text LIMIT 1) AS pos,
           cv.created_at, cv.id AS row_id
    FROM trips AS t
    JOIN public.calc_vehicles AS cv ON cv.calc_id = t.id
  ), capacity AS (
    SELECT s.*,
           CASE WHEN coalesce(s.inputs ->> 'returnMode', '') = 'разовий' THEN s.tonnage
                WHEN coalesce(nullif(s.payload, 0), public.tc_num(s.inputs, 'normWeight')) > 0
                  THEN ceil(s.tonnage / coalesce(nullif(s.payload, 0), public.tc_num(s.inputs, 'normWeight')))
                       * coalesce(nullif(s.payload, 0), public.tc_num(s.inputs, 'normWeight'))
                ELSE 0 END AS cap
    FROM slices AS s
  ), shared AS (
    SELECT c.*,
           greatest(0, least(c.cap, coalesce(public.tc_num(c.inputs, 'rtTotalVolume'), 0)
             - coalesce(sum(c.cap) OVER (PARTITION BY c.id ORDER BY c.pos NULLS LAST, c.created_at, c.row_id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS rt_share
    FROM capacity AS c
  ), planned AS (
    SELECT s.id, s.fact_km, s.vehicle_id, public.kp_trip_plan_km(s.inputs, s.tonnage, s.payload, s.rt_share) AS plan_km,
           public.kp_trip_podacha_km(s.inputs, s.tonnage) AS podacha_km
    FROM shared AS s
  ), per_trip AS (
    SELECT p.id, max(p.fact_km) AS fact_km,
           sum(p.plan_km - p.podacha_km) AS plan_total,
           sum(p.plan_km) FILTER (WHERE p.vehicle_id = p_vehicle) AS plan_mine,
           sum(p.plan_km - p.podacha_km) FILTER (WHERE p.vehicle_id = p_vehicle) AS road_mine,
           sum(p.podacha_km) FILTER (WHERE p.vehicle_id = p_vehicle) AS podacha_mine,
           count(*) FILTER (WHERE p.vehicle_id IS NOT NULL) AS vehicles
    FROM planned AS p
    GROUP BY p.id
  )
  -- plan_total / road_mine — план без подачі (база частки факту); подача авто додається окремо.
  SELECT coalesce(round(sum(greatest(0,
    CASE WHEN t.fact_km IS NULL THEN coalesce(t.plan_mine, 0)
         WHEN t.plan_total > 0 THEN t.fact_km * coalesce(t.road_mine, 0) / t.plan_total + coalesce(t.podacha_mine, 0)
         ELSE t.fact_km / greatest(t.vehicles, 1) + coalesce(t.podacha_mine, 0) END)), 1), 0)
  FROM per_trip AS t;
$$;

-- Бази пробігу авто — єдиний перелік: ручні показання і ремонти 'posted' з одометром (дата = repair_date).
-- Порядок у межах дати — created_at, далі ref_id (показання або ремонт): пізніше створена база перемагає.
CREATE OR REPLACE FUNCTION public.kp_vehicle_odometer_bases(p_org uuid, p_vehicle uuid)
RETURNS TABLE (read_on date, odometer_km integer, source text, ref_id uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.read_on, r.odometer_km, 'manual'::text, r.id, r.created_at
  FROM public.vehicle_odometer_readings AS r
  WHERE r.org_id = p_org AND r.vehicle_id = p_vehicle AND r.source = 'manual'
  UNION ALL
  SELECT rp.repair_date, rp.odometer_km, 'repair'::text, rp.id, rp.created_at
  FROM public.repairs AS rp
  WHERE rp.org_id = p_org AND rp.vehicle_id = p_vehicle AND rp.status = 'posted' AND rp.odometer_km IS NOT NULL;
$$;

-- Пробіг авто на дату: остання база (read_on <= p_on) + км рейсів після дати бази. Без бази — рядок з NULL.
-- source — 'manual' або 'repair' (звідки база). Єдине джерело пробігу: GPS підмінить лише цю функцію.
CREATE OR REPLACE FUNCTION public.kp_vehicle_mileage_at(p_org uuid, p_vehicle uuid, p_on date)
RETURNS TABLE (odometer_km integer, base_read_on date, base_km integer, trips_km numeric, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_read_on date;
  v_km integer;
  v_source text;
  v_trips numeric;
BEGIN
  SELECT b.read_on, b.odometer_km, b.source INTO v_read_on, v_km, v_source
  FROM public.kp_vehicle_odometer_bases(p_org, p_vehicle) AS b
  WHERE b.read_on <= p_on
  ORDER BY b.read_on DESC, b.created_at DESC, b.ref_id DESC
  LIMIT 1;
  IF v_read_on IS NULL THEN
    RETURN QUERY SELECT NULL::integer, NULL::date, NULL::integer, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  v_trips := public.kp_vehicle_trip_km(p_org, p_vehicle, v_read_on, p_on);
  RETURN QUERY SELECT (v_km + round(v_trips))::integer, v_read_on, v_km, v_trips, v_source;
END;
$$;

-- Нове показання p_km на дату p_on (ручне або з ремонту p_skip_repair — сам ремонт не порівнюється з собою) не
-- менше за найпізнішу базу з датою <= p_on і не більше за найранішу базу з датою > p_on. Рівне — можна.
-- Advisory-lock на авто: паралельні записи одного авто перевіряються по черзі (fleet_vehicles не блокуємо).
CREATE OR REPLACE FUNCTION public.kp_odometer_guard(p_org uuid, p_vehicle uuid, p_on date, p_km integer, p_skip_repair uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b record;
BEGIN
  IF p_vehicle IS NULL OR p_on IS NULL OR p_km IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kp_odometer:' || p_vehicle::text, 0));
  SELECT b.read_on, b.odometer_km INTO v_b
  FROM public.kp_vehicle_odometer_bases(p_org, p_vehicle) AS b
  WHERE b.read_on <= p_on AND NOT (b.source = 'repair' AND b.ref_id IS NOT DISTINCT FROM p_skip_repair)
  ORDER BY b.read_on DESC, b.created_at DESC, b.ref_id DESC
  LIMIT 1;
  IF FOUND AND p_km < v_b.odometer_km THEN
    RAISE EXCEPTION 'ODOMETER_DECREASE' USING ERRCODE = 'P0001',
      DETAIL = v_b.odometer_km::text || '|' || to_char(v_b.read_on, 'YYYY-MM-DD'), HINT = 'prev';
  END IF;
  SELECT b.read_on, b.odometer_km INTO v_b
  FROM public.kp_vehicle_odometer_bases(p_org, p_vehicle) AS b
  WHERE b.read_on > p_on AND NOT (b.source = 'repair' AND b.ref_id IS NOT DISTINCT FROM p_skip_repair)
  ORDER BY b.read_on, b.created_at, b.ref_id
  LIMIT 1;
  IF FOUND AND p_km > v_b.odometer_km THEN
    RAISE EXCEPTION 'ODOMETER_DECREASE' USING ERRCODE = 'P0001',
      DETAIL = v_b.odometer_km::text || '|' || to_char(v_b.read_on, 'YYYY-MM-DD'), HINT = 'next';
  END IF;
END;
$$;

-- Статус одного виміру й загальний («що раніше» = гірший). Межі включні: 5000 км / 14 днів — yellow, 0 — red.
-- Вимір без значення (немає інтервалу або бази) ігнорується; обидва без значення — unknown. JS-копія:
-- apps/kontrol-plus/src/lib/maintenance.js (для сортування й тестів; джерело істини — тут).
CREATE OR REPLACE FUNCTION public.kp_maintenance_eval(p_left_km integer, p_left_days integer)
RETURNS TABLE (status text, reason text)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE greatest(r.km, r.tm) WHEN 3 THEN 'red' WHEN 2 THEN 'yellow' WHEN 1 THEN 'ok' ELSE 'unknown' END,
         CASE WHEN r.km = 0 AND r.tm = 0 THEN NULL WHEN r.tm > r.km THEN 'time' ELSE 'km' END
  FROM (
    SELECT CASE WHEN p_left_km IS NULL THEN 0 WHEN p_left_km <= 0 THEN 3 WHEN p_left_km <= 5000 THEN 2 ELSE 1 END AS km,
           CASE WHEN p_left_days IS NULL THEN 0 WHEN p_left_days <= 0 THEN 3 WHEN p_left_days <= 14 THEN 2 ELSE 1 END AS tm
  ) AS r;
$$;

-- Авто організації (для функцій ТО); інакше — REPAIR_VEHICLE_NOT_FOUND (як у формі ремонту 3a).
CREATE OR REPLACE FUNCTION public.kp_maintenance_require_vehicle(p_org uuid, p_vehicle uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vehicle IS NULL OR NOT EXISTS (SELECT 1 FROM public.fleet_vehicles AS fv WHERE fv.id = p_vehicle AND fv.org_id = p_org) THEN
    RAISE EXCEPTION 'REPAIR_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_trip_podacha_km(jsonb, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_trip_plan_km(jsonb, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_vehicle_trip_km(uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_vehicle_odometer_bases(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_vehicle_mileage_at(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_odometer_guard(uuid, uuid, date, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_maintenance_eval(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_maintenance_require_vehicle(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Maintenance types (template) and per-vehicle overrides
-- ---------------------------------------------------------------------------

-- Шаблон організації: активні, потім архівні.
CREATE OR REPLACE FUNCTION public.kp_maintenance_types_of(p_org uuid)
RETURNS SETOF public.maintenance_types
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.maintenance_types AS t WHERE t.org_id = p_org ORDER BY NOT t.is_active, t.sort, lower(t.name);
$$;

REVOKE ALL ON FUNCTION public.kp_maintenance_types_of(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Дефолтний шаблон — лише якщо в організації ще немає жодного типу (повторний виклик нічого не змінює).
-- Цифри — редаговані дефолти, логіка від них не залежить.
CREATE OR REPLACE FUNCTION public.kp_maintenance_seed_defaults()
RETURNS SETOF public.maintenance_types
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = v_org FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.maintenance_types AS t WHERE t.org_id = v_org) THEN
    INSERT INTO public.maintenance_types (org_id, name, interval_km, interval_months, sort, created_by)
    VALUES (v_org, 'Масло двигуна', 15000, 12, 10, auth.uid()),
           (v_org, 'Фільтри (масляний, паливний, повітряний)', 15000, 12, 20, auth.uid()),
           (v_org, 'Гальма (колодки)', 40000, 24, 30, auth.uid()),
           (v_org, 'Трансмісія/мости', 60000, 24, 40, auth.uid()),
           (v_org, 'Охолоджувальна рідина', 100000, 24, 50, auth.uid());
  END IF;
  RETURN QUERY SELECT * FROM public.kp_maintenance_types_of(v_org);
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_maintenance_type_upsert(
  p_id uuid, p_name text, p_interval_km integer, p_interval_months integer, p_sort integer DEFAULT NULL
)
RETURNS SETOF public.maintenance_types
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_name text := btrim(coalesce(p_name, ''));
  v_active boolean;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'MAINT_TYPE_NAME' USING ERRCODE = 'P0001';
  END IF;
  IF (p_interval_km IS NULL AND p_interval_months IS NULL)
     OR (p_interval_km IS NOT NULL AND p_interval_km NOT BETWEEN 1 AND 1000000)
     OR (p_interval_months IS NOT NULL AND p_interval_months NOT BETWEEN 1 AND 120)
     OR (p_sort IS NOT NULL AND p_sort NOT BETWEEN 0 AND 100000) THEN
    RAISE EXCEPTION 'MAINT_TYPE_INTERVAL' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    IF p_id IS NULL THEN
      IF (SELECT count(*) FROM public.maintenance_types AS t WHERE t.org_id = v_org) >= 100 THEN
        RAISE EXCEPTION 'MAINT_TYPES_LIMIT' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.maintenance_types (org_id, name, interval_km, interval_months, sort, created_by)
      VALUES (v_org, v_name, p_interval_km, p_interval_months,
              coalesce(p_sort, (SELECT coalesce(max(t.sort), 0) + 10 FROM public.maintenance_types AS t WHERE t.org_id = v_org)), auth.uid());
    ELSE
      SELECT t.is_active INTO v_active FROM public.maintenance_types AS t WHERE t.id = p_id AND t.org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'MAINT_TYPE_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
      IF NOT v_active THEN
        RAISE EXCEPTION 'MAINT_TYPE_ARCHIVED' USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.maintenance_types AS t
      SET name = v_name, interval_km = p_interval_km, interval_months = p_interval_months, sort = coalesce(p_sort, t.sort)
      WHERE t.id = p_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MAINT_TYPE_EXISTS' USING ERRCODE = 'P0001';
  END;
  RETURN QUERY SELECT * FROM public.kp_maintenance_types_of(v_org);
END;
$$;

-- М'яке видалення: тип зникає зі статусів і з вибору в ремонті; виконання в історії лишаються.
CREATE OR REPLACE FUNCTION public.kp_maintenance_type_archive(p_id uuid)
RETURNS SETOF public.maintenance_types
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
BEGIN
  UPDATE public.maintenance_types AS t SET is_active = false WHERE t.id = p_id AND t.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAINT_TYPE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT * FROM public.kp_maintenance_types_of(v_org);
END;
$$;

-- Перевизначення на авто: NULL — з шаблону; disabled — тип для авто не відстежується. Усі NULL і не disabled = скинути.
CREATE OR REPLACE FUNCTION public.kp_maintenance_override_set(
  p_vehicle uuid, p_type uuid, p_interval_km integer, p_interval_months integer, p_disabled boolean DEFAULT false
)
RETURNS SETOF public.vehicle_maintenance_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
BEGIN
  PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  IF NOT EXISTS (SELECT 1 FROM public.maintenance_types AS t WHERE t.id = p_type AND t.org_id = v_org) THEN
    RAISE EXCEPTION 'MAINT_TYPE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.maintenance_types AS t WHERE t.id = p_type AND t.is_active) THEN
    RAISE EXCEPTION 'MAINT_TYPE_ARCHIVED' USING ERRCODE = 'P0001';
  END IF;
  IF (p_interval_km IS NOT NULL AND p_interval_km NOT BETWEEN 1 AND 1000000)
     OR (p_interval_months IS NOT NULL AND p_interval_months NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'MAINT_TYPE_INTERVAL' USING ERRCODE = 'P0001';
  END IF;
  IF p_interval_km IS NULL AND p_interval_months IS NULL AND NOT coalesce(p_disabled, false) THEN
    DELETE FROM public.vehicle_maintenance_overrides AS o WHERE o.vehicle_id = p_vehicle AND o.type_id = p_type AND o.org_id = v_org;
  ELSE
    INSERT INTO public.vehicle_maintenance_overrides (org_id, vehicle_id, type_id, interval_km, interval_months, disabled, updated_by)
    VALUES (v_org, p_vehicle, p_type, p_interval_km, p_interval_months, coalesce(p_disabled, false), auth.uid())
    ON CONFLICT ON CONSTRAINT vehicle_maintenance_overrides_vehicle_type_key DO UPDATE
    SET interval_km = EXCLUDED.interval_km, interval_months = EXCLUDED.interval_months, disabled = EXCLUDED.disabled,
        updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  RETURN QUERY SELECT * FROM public.vehicle_maintenance_overrides AS o WHERE o.vehicle_id = p_vehicle AND o.org_id = v_org ORDER BY o.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_maintenance_override_clear(p_vehicle uuid, p_type uuid)
RETURNS SETOF public.vehicle_maintenance_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
BEGIN
  PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  DELETE FROM public.vehicle_maintenance_overrides AS o WHERE o.vehicle_id = p_vehicle AND o.type_id = p_type AND o.org_id = v_org;
  RETURN QUERY SELECT * FROM public.vehicle_maintenance_overrides AS o WHERE o.vehicle_id = p_vehicle AND o.org_id = v_org ORDER BY o.updated_at;
END;
$$;

-- ---------------------------------------------------------------------------
-- Odometer and mileage (clients)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_vehicle_mileage(p_vehicle uuid, p_on date DEFAULT NULL)
RETURNS TABLE (odometer_km integer, base_read_on date, base_km integer, trips_km numeric, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  RETURN QUERY SELECT * FROM public.kp_vehicle_mileage_at(v_org, p_vehicle, coalesce(p_on, public.ua_today()));
END;
$$;

-- Історія показань: ручні / GPS і одометри проведених ремонтів (source 'repair'). Від ремонту — лише дата, км і
-- repair_id (без робіт, сум і запчастин).
CREATE OR REPLACE FUNCTION public.kp_odometer_list(p_vehicle uuid)
RETURNS TABLE (id uuid, read_on date, odometer_km integer, source text, note text, created_at timestamptz, repair_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  RETURN QUERY
  SELECT x.id, x.read_on, x.odometer_km, x.source, x.note, x.created_at, x.repair_id
  FROM (
    SELECT r.id, r.read_on, r.odometer_km, r.source, r.note, r.created_at, NULL::uuid AS repair_id
    FROM public.vehicle_odometer_readings AS r
    WHERE r.org_id = v_org AND r.vehicle_id = p_vehicle
    UNION ALL
    SELECT b.ref_id, b.read_on, b.odometer_km, b.source, NULL::text, b.created_at, b.ref_id
    FROM public.kp_vehicle_odometer_bases(v_org, p_vehicle) AS b
    WHERE b.source = 'repair'
  ) AS x
  ORDER BY x.read_on DESC, x.created_at DESC, x.id DESC
  LIMIT 200;
END;
$$;

-- Ручне показання (база пробігу): дата не в майбутньому (Київ), не менше попередньої бази й не більше наступної
-- (kp_odometer_guard). Повертає оновлену історію авто.
CREATE OR REPLACE FUNCTION public.kp_odometer_add(p_vehicle uuid, p_read_on date, p_odometer integer, p_note text DEFAULT NULL)
RETURNS TABLE (id uuid, read_on date, odometer_km integer, source text, note text, created_at timestamptz, repair_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
BEGIN
  PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  IF p_read_on IS NULL OR p_read_on < DATE '2000-01-01' OR p_read_on > public.ua_today() THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  IF p_odometer IS NULL OR p_odometer NOT BETWEEN 0 AND 10000000 OR char_length(coalesce(p_note, '')) > 200 THEN
    RAISE EXCEPTION 'ODOMETER_BAD_VALUES' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.vehicle_odometer_readings AS r WHERE r.vehicle_id = p_vehicle) >= 5000 THEN
    RAISE EXCEPTION 'ODOMETER_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.kp_odometer_guard(v_org, p_vehicle, p_read_on, p_odometer, NULL);
  INSERT INTO public.vehicle_odometer_readings (org_id, vehicle_id, read_on, odometer_km, source, note, created_by)
  VALUES (v_org, p_vehicle, p_read_on, p_odometer, 'manual', nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  RETURN QUERY SELECT * FROM public.kp_odometer_list(p_vehicle);
END;
$$;

-- ---------------------------------------------------------------------------
-- Maintenance done by a repair
-- ---------------------------------------------------------------------------

-- Набір виконаних типів ТО ремонту (замінює попередній). Ремонт 'posted' з авто; власник / директор або автор
-- (як kp_repair_update). Нові типи — лише активні; уже привʼязаний архівний тип можна лишити.
CREATE OR REPLACE FUNCTION public.kp_repair_set_maintenance(p_repair uuid, p_type_ids uuid[])
RETURNS TABLE (type_id uuid, type_name text, done_on date, done_km integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_r public.repairs%ROWTYPE;
  v_ids uuid[];
  v_km integer;
BEGIN
  SELECT * INTO v_r FROM public.repairs AS r WHERE r.id = p_repair AND r.org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPAIR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'posted' THEN
    RAISE EXCEPTION 'REPAIR_ALREADY_VOID' USING ERRCODE = 'P0001';
  END IF;
  IF public.kp_repairs_role() NOT IN ('owner', 'director') AND v_r.created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_r.vehicle_id IS NULL THEN
    RAISE EXCEPTION 'REPAIR_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[]) INTO v_ids FROM unnest(coalesce(p_type_ids, '{}'::uuid[])) AS x(id) WHERE x.id IS NOT NULL;
  IF cardinality(v_ids) > 50 THEN
    RAISE EXCEPTION 'MAINT_BAD_TYPES' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM public.maintenance_types AS t WHERE t.id = x.id AND t.org_id = v_org)) THEN
    RAISE EXCEPTION 'MAINT_TYPE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS x(id) JOIN public.maintenance_types AS t ON t.id = x.id
             WHERE NOT t.is_active
               AND NOT EXISTS (SELECT 1 FROM public.repair_maintenance AS rm WHERE rm.repair_id = v_r.id AND rm.type_id = x.id)) THEN
    RAISE EXCEPTION 'MAINT_TYPE_ARCHIVED' USING ERRCODE = 'P0001';
  END IF;
  v_km := coalesce(v_r.odometer_km, (SELECT m.odometer_km FROM public.kp_vehicle_mileage_at(v_org, v_r.vehicle_id, v_r.repair_date) AS m));
  DELETE FROM public.repair_maintenance AS rm WHERE rm.repair_id = v_r.id AND rm.type_id <> ALL (v_ids);
  INSERT INTO public.repair_maintenance (org_id, repair_id, type_id, done_on, done_km, created_by)
  SELECT v_org, v_r.id, x.id, v_r.repair_date, v_km, auth.uid() FROM unnest(v_ids) AS x(id)
  ON CONFLICT ON CONSTRAINT repair_maintenance_repair_type_key DO UPDATE SET done_on = EXCLUDED.done_on, done_km = EXCLUDED.done_km;
  RETURN QUERY
  SELECT rm.type_id, t.name, rm.done_on, rm.done_km
  FROM public.repair_maintenance AS rm JOIN public.maintenance_types AS t ON t.id = rm.type_id
  WHERE rm.repair_id = v_r.id
  ORDER BY t.sort, lower(t.name);
END;
$$;

-- Дата, одометр або авто ремонту змінились (kp_repair_update, видалення авто на сайті) — перерахувати done_on /
-- done_km його ТО (тригер, а не в kp_repair_update: функцію 3a не чіпаємо). Авто прибрали (NULL) — ТО ремонту
-- видаляються: без авто вони нічого не означають, а відмова зламала б видалення авто (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION public.kp_repair_maintenance_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.vehicle_id IS NULL THEN
    DELETE FROM public.repair_maintenance AS rm WHERE rm.repair_id = NEW.id;
    RETURN NULL;
  END IF;
  UPDATE public.repair_maintenance AS rm
  SET done_on = NEW.repair_date,
      done_km = coalesce(NEW.odometer_km, (SELECT m.odometer_km FROM public.kp_vehicle_mileage_at(NEW.org_id, NEW.vehicle_id, NEW.repair_date) AS m))
  WHERE rm.repair_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_repair_maintenance_sync() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_repair_maintenance_sync ON public.repairs;
CREATE TRIGGER trg_kp_repair_maintenance_sync
  AFTER UPDATE OF repair_date, odometer_km, vehicle_id ON public.repairs
  FOR EACH ROW
  WHEN (OLD.repair_date IS DISTINCT FROM NEW.repair_date OR OLD.odometer_km IS DISTINCT FROM NEW.odometer_km
        OR OLD.vehicle_id IS DISTINCT FROM NEW.vehicle_id)
  EXECUTE FUNCTION public.kp_repair_maintenance_sync();

-- Одометр ремонту — база пробігу, тож він теж не може зменшуватися (kp_odometer_guard). Лише для проведеного
-- ремонту з авто й одометром і лише коли дата / одометр / авто справді змінились: правка робіт старого ремонту
-- не ламається через історичні дані.
CREATE OR REPLACE FUNCTION public.kp_repair_odometer_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'posted' AND NEW.vehicle_id IS NOT NULL AND NEW.odometer_km IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.repair_date IS DISTINCT FROM NEW.repair_date OR OLD.odometer_km IS DISTINCT FROM NEW.odometer_km
          OR OLD.vehicle_id IS DISTINCT FROM NEW.vehicle_id) THEN
    PERFORM public.kp_odometer_guard(NEW.org_id, NEW.vehicle_id, NEW.repair_date, NEW.odometer_km, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_repair_odometer_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_repair_odometer_guard ON public.repairs;
CREATE TRIGGER trg_kp_repair_odometer_guard
  BEFORE INSERT OR UPDATE OF repair_date, odometer_km, vehicle_id ON public.repairs
  FOR EACH ROW EXECUTE FUNCTION public.kp_repair_odometer_guard();

-- Ремонт разом із виконаним ТО — один виклик, одна транзакція: p_repair NULL — kp_repair_post (новий, зі
-- списанням), інакше kp_repair_update (описові поля; авто й списання 3a не змінює — p_vehicle ігнорується, рядки
-- запчастин відхиляються). Потім kp_repair_set_maintenance (p_type_ids NULL — набір ТО не чіпаємо). Будь-яка
-- помилка — не зберігається нічого. Права — ті самі, що в kp_repair_post / kp_repair_update (їх і викликаємо).
CREATE OR REPLACE FUNCTION public.kp_repair_save_with_maintenance(
  p_repair uuid, p_vehicle uuid, p_date date, p_odometer integer, p_works text, p_provider text, p_service_cost numeric,
  p_parts jsonb, p_type_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.kp_repairs_require_write();
  IF p_repair IS NULL THEN
    v_id := public.kp_repair_post(p_vehicle, p_date, p_odometer, p_works, p_provider, p_service_cost, p_parts);
  ELSE
    IF p_parts IS NOT NULL AND (jsonb_typeof(p_parts) <> 'array' OR jsonb_array_length(p_parts) > 0) THEN
      RAISE EXCEPTION 'REPAIR_BAD_PARTS' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.kp_repair_update(p_repair, p_date, p_odometer, p_works, p_provider, p_service_cost);
    v_id := p_repair;
  END IF;
  IF p_type_ids IS NOT NULL
     AND (cardinality(p_type_ids) > 0 OR EXISTS (SELECT 1 FROM public.repair_maintenance AS rm WHERE rm.repair_id = v_id)) THEN
    PERFORM 1 FROM public.kp_repair_set_maintenance(v_id, p_type_ids);
  END IF;
  RETURN v_id;
END;
$$;

-- ТО, виконане проведеними ремонтами за період (для списку ремонтів); ТО сторнованих ремонтів не повертаємо.
CREATE OR REPLACE FUNCTION public.kp_repair_maintenance_list(p_from date, p_to date)
RETURNS TABLE (repair_id uuid, type_id uuid, type_name text, done_on date, done_km integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT rm.repair_id, rm.type_id, t.name, rm.done_on, rm.done_km
  FROM public.repair_maintenance AS rm
  JOIN public.repairs AS r ON r.id = rm.repair_id
  JOIN public.maintenance_types AS t ON t.id = rm.type_id
  WHERE rm.org_id = v_org AND r.status = 'posted' AND r.repair_date BETWEEN p_from AND p_to
  ORDER BY rm.repair_id, t.sort, lower(t.name)
  LIMIT 5000;
END;
$$;

-- ---------------------------------------------------------------------------
-- Maintenance status
-- ---------------------------------------------------------------------------

-- Пари (авто, активний не вимкнений тип). Останнє виконання — найпізніший done_on (далі created_at) серед ремонтів
-- 'posted'; без виконань — найраніша база (ручна або ремонт, last_source = 'start'); без бази — unknown.
-- done_km = NULL (ремонт без одометра й без бази на той момент) — пробіг на done_on, якщо база зʼявилась пізніше.
-- Продуктивність: пробіг (kp_vehicle_mileage_at → kp_vehicle_trip_km) і старт рахуються один раз на авто
-- (MATERIALIZED) і лише для авто, що мають хоч один відстежуваний тип; з p_vehicle — лише для нього.
CREATE OR REPLACE FUNCTION public.kp_maintenance_status(p_vehicle uuid DEFAULT NULL)
RETURNS TABLE (
  vehicle_id uuid, vehicle_label text, type_id uuid, type_name text, interval_km integer, interval_months integer,
  overridden boolean, last_on date, last_km integer, last_source text, odometer_km integer, due_on date, due_km integer,
  left_days integer, left_km integer, status text, reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
  v_today date := public.ua_today();
BEGIN
  IF p_vehicle IS NOT NULL THEN
    PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  END IF;
  RETURN QUERY
  WITH v AS (
    SELECT fv.id AS vid, fv.label
    FROM public.fleet_vehicles AS fv
    WHERE fv.org_id = v_org AND (p_vehicle IS NULL OR fv.id = p_vehicle)
    ORDER BY lower(fv.label)
    LIMIT 1000
  ), pairs AS MATERIALIZED (
    SELECT v.vid, v.label, t.id AS tid, t.name AS tname, t.sort AS tsort,
           coalesce(o.interval_km, t.interval_km) AS ikm,
           coalesce(o.interval_months, t.interval_months) AS imon,
           coalesce(o.interval_km IS NOT NULL OR o.interval_months IS NOT NULL, false) AS over
    FROM v
    CROSS JOIN public.maintenance_types AS t
    LEFT JOIN public.vehicle_maintenance_overrides AS o ON o.vehicle_id = v.vid AND o.type_id = t.id
    WHERE t.org_id = v_org AND t.is_active AND NOT coalesce(o.disabled, false)
  ), odo AS MATERIALIZED (
    SELECT tv.vid, m.odometer_km AS now_km, s.read_on AS start_on, s.odometer_km AS start_km
    FROM (SELECT DISTINCT p.vid FROM pairs AS p) AS tv
    LEFT JOIN LATERAL public.kp_vehicle_mileage_at(v_org, tv.vid, v_today) AS m ON true
    LEFT JOIN LATERAL (
      SELECT b.read_on, b.odometer_km FROM public.kp_vehicle_odometer_bases(v_org, tv.vid) AS b
      WHERE b.read_on <= v_today
      ORDER BY b.read_on, b.created_at, b.ref_id
      LIMIT 1
    ) AS s ON true
  ), lastdone AS (
    SELECT p.*, l.done_on AS ldone_on, l.done_km AS ldone_km
    FROM pairs AS p
    LEFT JOIN LATERAL (
      SELECT rm.done_on, rm.done_km
      FROM public.repair_maintenance AS rm
      JOIN public.repairs AS r ON r.id = rm.repair_id
      WHERE rm.org_id = v_org AND rm.type_id = p.tid AND r.vehicle_id = p.vid AND r.status = 'posted'
      ORDER BY rm.done_on DESC, rm.created_at DESC
      LIMIT 1
    ) AS l ON true
  ), base AS (
    SELECT d.vid, d.label, d.tid, d.tname, d.tsort, d.ikm, d.imon, d.over, o.now_km,
           CASE WHEN d.ldone_on IS NOT NULL THEN 'repair' WHEN o.start_on IS NOT NULL THEN 'start' END AS src,
           coalesce(d.ldone_on, o.start_on) AS lon,
           CASE WHEN d.ldone_on IS NOT NULL
                THEN coalesce(d.ldone_km, (SELECT mm.odometer_km FROM public.kp_vehicle_mileage_at(v_org, d.vid, d.ldone_on) AS mm))
                ELSE o.start_km END AS lkm
    FROM lastdone AS d
    JOIN odo AS o ON o.vid = d.vid
  ), due AS (
    SELECT b.*,
           CASE WHEN b.imon IS NOT NULL AND b.lon IS NOT NULL THEN (b.lon + make_interval(months => b.imon))::date END AS don,
           CASE WHEN b.ikm IS NOT NULL AND b.lkm IS NOT NULL THEN b.lkm + b.ikm END AS dkm
    FROM base AS b
  ), lefts AS (
    SELECT d.*, (d.don - v_today) AS ldays,
           CASE WHEN d.dkm IS NOT NULL AND d.now_km IS NOT NULL THEN d.dkm - d.now_km END AS lkms
    FROM due AS d
  )
  SELECT x.vid, x.label, x.tid, x.tname, x.ikm, x.imon, x.over, x.lon, x.lkm, x.src, x.now_km, x.don, x.dkm,
         x.ldays, x.lkms, e.status, e.reason
  FROM lefts AS x
  CROSS JOIN LATERAL public.kp_maintenance_eval(x.lkms, x.ldays) AS e
  ORDER BY CASE e.status WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END, lower(x.label), x.tsort, lower(x.tname);
END;
$$;

-- ---------------------------------------------------------------------------
-- Cost per km
-- ---------------------------------------------------------------------------

-- По авто за [p_from, p_to]: запчастини (списання без сторно) + СТО ремонтів 'posted'; км — kp_vehicle_trip_km
-- (той самий механізм, що й пробіг; база одометра не потрібна). Період ≤ 3 роки. Авто без витрат і без км — не показуємо.
CREATE OR REPLACE FUNCTION public.kp_repair_cost_per_km(p_from date, p_to date, p_vehicle uuid DEFAULT NULL)
RETURNS TABLE (
  vehicle_id uuid, vehicle_label text, repairs_count integer, parts_cost numeric, service_cost numeric, cost numeric,
  km numeric, cost_per_km numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  IF p_to >= (p_from + interval '3 years')::date THEN
    RAISE EXCEPTION 'PERIOD_TOO_LONG' USING ERRCODE = 'P0001';
  END IF;
  IF p_vehicle IS NOT NULL THEN
    PERFORM public.kp_maintenance_require_vehicle(v_org, p_vehicle);
  END IF;
  RETURN QUERY
  WITH v AS (
    SELECT fv.id AS vid, fv.label
    FROM public.fleet_vehicles AS fv
    WHERE fv.org_id = v_org AND (p_vehicle IS NULL OR fv.id = p_vehicle)
    ORDER BY lower(fv.label)
    LIMIT 1000
  ), costs AS (
    SELECT r.vehicle_id AS vid, count(*)::integer AS n, sum(r.service_cost) AS service,
           sum((SELECT coalesce(sum(w.total), 0) FROM public.part_writeoffs AS w WHERE w.repair_id = r.id AND w.reversed_at IS NULL)) AS parts
    FROM public.repairs AS r
    WHERE r.org_id = v_org AND r.status = 'posted' AND r.repair_date BETWEEN p_from AND p_to AND r.vehicle_id IS NOT NULL
    GROUP BY r.vehicle_id
  ), kms AS (
    SELECT v.vid, v.label, public.kp_vehicle_trip_km(v_org, v.vid, p_from - 1, p_to) AS km
    FROM v
  )
  SELECT k.vid, k.label, coalesce(c.n, 0),
         coalesce(c.parts, 0)::numeric(14,2), coalesce(c.service, 0)::numeric(14,2),
         (coalesce(c.parts, 0) + coalesce(c.service, 0))::numeric(14,2),
         k.km,
         CASE WHEN k.km > 0 THEN round((coalesce(c.parts, 0) + coalesce(c.service, 0)) / k.km, 2) END
  FROM kms AS k
  LEFT JOIN costs AS c ON c.vid = k.vid
  WHERE coalesce(c.n, 0) > 0 OR k.km > 0
  ORDER BY lower(k.label);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3a follow-ups (same signatures and grants)
-- ---------------------------------------------------------------------------

-- Як у 3a, але директор заблокованої організації (status = 'blocked') власного Контроль+ не має — як і учасник.
CREATE OR REPLACE FUNCTION public.kp_user_has_own_kp(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles AS p JOIN public.organizations AS o ON o.id = p.org_id
    WHERE p.id = p_user AND p.member_status = 'active' AND o.status <> 'blocked'
      AND public.org_has_plan(p.org_id, 'control_plus')
  ) OR EXISTS (
    SELECT 1 FROM public.org_directors AS d JOIN public.organizations AS o ON o.id = d.org_id
    WHERE d.user_id = p_user AND o.status <> 'blocked' AND public.org_has_plan(d.org_id, 'control_plus')
  );
$$;

REVOKE ALL ON FUNCTION public.kp_user_has_own_kp(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Як у 3a, плюс на початку — прибирання журналу відправлень старше доби (ліміти рахують лише останню годину).
CREATE OR REPLACE FUNCTION public.kp_repair_invite_reserve(
  p_org uuid, p_invite uuid, p_email text, p_token_hash text, p_invited_by uuid, p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing public.repair_manager_invites%ROWTYPE;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.repair_invite_sends AS s WHERE s.sent_at < now() - interval '1 day';
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR UPDATE;
  IF NOT public.org_has_plan(p_org, 'control_plus') THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_existing FROM public.repair_manager_invites WHERE id = p_invite AND org_id = p_org FOR UPDATE;
  IF FOUND THEN
    IF v_existing.accepted_at IS NOT NULL OR v_existing.revoked_at IS NOT NULL OR v_existing.declined_at IS NOT NULL THEN
      RAISE EXCEPTION 'REPAIR_INVITE_CLOSED' USING ERRCODE = 'P0001';
    END IF;
    IF v_existing.last_sent_at > now() - interval '60 seconds' THEN
      RAISE EXCEPTION 'REPAIR_INVITE_RATE_LIMIT' USING ERRCODE = 'P0001', DETAIL = 'At most one send per invite per 60 s';
    END IF;
    v_email := v_existing.email;
  ELSE
    IF EXISTS (SELECT 1 FROM public.repair_manager_invites WHERE id = p_invite) THEN
      RAISE EXCEPTION 'REPAIR_INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.repair_manager_invites AS i
      WHERE i.org_id = p_org AND i.email = v_email
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at > now()
    ) THEN
      RAISE EXCEPTION 'REPAIR_INVITE_EXISTS' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.org_repair_handlers AS h JOIN auth.users AS u ON u.id = h.user_id
      WHERE h.org_id = p_org AND h.kind = 'repair_manager' AND lower(u.email) = v_email
    ) THEN
      RAISE EXCEPTION 'REPAIR_MANAGER_EXISTS' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF public.kp_repair_manager_seats(p_org, NULL, p_invite) >= 2 THEN
    RAISE EXCEPTION 'REPAIR_MANAGER_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.repair_invite_sends AS s WHERE s.org_id = p_org AND s.sent_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'REPAIR_INVITE_RATE_LIMIT' USING ERRCODE = 'P0001', DETAIL = 'At most 10 invite sends per organization per hour';
  END IF;
  INSERT INTO public.repair_manager_invites (id, org_id, email, token_hash, invited_by, expires_at, last_sent_at)
  VALUES (p_invite, p_org, v_email, p_token_hash, p_invited_by, p_expires_at, now())
  ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, last_sent_at = now();
  INSERT INTO public.repair_invite_sends (org_id, invite_id) VALUES (p_org, p_invite);
  RETURN p_invite;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_repair_invite_reserve(uuid, uuid, text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kp_repair_invite_reserve(uuid, uuid, text, text, uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Grants on client functions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.kp_maintenance_seed_defaults()',
    'public.kp_maintenance_type_upsert(uuid, text, integer, integer, integer)',
    'public.kp_maintenance_type_archive(uuid)',
    'public.kp_maintenance_override_set(uuid, uuid, integer, integer, boolean)',
    'public.kp_maintenance_override_clear(uuid, uuid)',
    'public.kp_vehicle_mileage(uuid, date)',
    'public.kp_odometer_list(uuid)',
    'public.kp_odometer_add(uuid, date, integer, text)',
    'public.kp_repair_set_maintenance(uuid, uuid[])',
    'public.kp_repair_save_with_maintenance(uuid, uuid, date, integer, text, text, numeric, jsonb, uuid[])',
    'public.kp_repair_maintenance_list(date, date)',
    'public.kp_maintenance_status(uuid)',
    'public.kp_repair_cost_per_km(date, date, uuid)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;
