-- Контроль+ ТО і вартість на км, етап 3b (*_repairs_maintenance.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim
-- (and applies the migration twice — idempotency).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(135);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"service_role"}', true);

-- M: control_plus (owner f1, logist f2 — відповідальний, logist f3 — ні, менеджер з ремонтів f5);
-- N: control_plus (owner f8); Q: control_plus, директор f9 (хвіст 3).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('70000000-0000-0000-0000-00000000000a', 'RM plan', 'team'),
       ('70000000-0000-0000-0000-00000000000b', 'RM other', 'solo'),
       ('70000000-0000-0000-0000-00000000000c', 'RM directors', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-0000000000' || k)::uuid, 'authenticated', 'authenticated',
       'rm-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'RM ' || k), now(), now()
FROM unnest(ARRAY['f1', 'f2', 'f3', 'f5', 'f8', 'f9']) AS k;

UPDATE public.profiles
SET org_id = CASE WHEN id = '00000000-0000-0000-0000-0000000000f8' THEN '70000000-0000-0000-0000-00000000000b'::uuid
                  ELSE '70000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id IN ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3') THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3',
             '00000000-0000-0000-0000-0000000000f8');

SELECT public.set_org_plan('70000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('70000000-0000-0000-0000-00000000000b', 'control_plus');
SELECT public.set_org_plan('70000000-0000-0000-0000-00000000000c', 'control_plus');
INSERT INTO public.org_repair_handlers (org_id, user_id, kind)
VALUES ('70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f2', 'logist'),
       ('70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f5', 'repair_manager');
INSERT INTO public.fleet_vehicles (id, org_id, label)
SELECT ('71000000-0000-0000-0000-0000000000' || k)::uuid, '70000000-0000-0000-0000-00000000000a', 'RM-' || k
FROM unnest(ARRAY['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab']) AS k;
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('71000000-0000-0000-0000-0000000000b1', '70000000-0000-0000-0000-00000000000b', 'RM-b1');

CREATE TEMP TABLE t_m (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_m TO PUBLIC;
-- Статус поточного користувача (claims) з ключами тестових типів; v — останні 2 символи id авто.
CREATE TEMP VIEW t_st AS
  SELECT s.*, right(s.vehicle_id::text, 2) AS v, t.k FROM public.kp_maintenance_status() AS s JOIN t_m AS t ON t.id = s.type_id;
GRANT ALL ON t_st TO PUBLIC;

-- Рейси (фіксовані дати вересня 2026). Разовий рейс dist 100 на одне авто = 100 км.
-- c_two: циклічний dist 100 — a1 50 т (вантажність 25 → 2 ходки = 300 км), a2 25 т (1 ходка = 100 км).
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, trip_date)
SELECT ('72000000-0000-0000-0000-0000000000' || k)::uuid, '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1',
       'RM ' || k, inputs::jsonb, '{}'::jsonb, st, d::date
FROM (VALUES
  ('01', 'accepted', '2026-09-01', '{"returnMode":"разовий","dist":"100"}'),
  ('02', 'accepted', '2026-09-02', '{"returnMode":"разовий","dist":"100"}'),
  ('03', 'done',     '2026-09-03', '{"returnMode":"разовий","dist":"100"}'),
  ('04', 'accepted', '2026-09-04', '{"returnMode":"разовий","dist":"100","carsCount":"1"}'),
  ('05', 'accepted', '2026-09-05', '{"returnMode":"разовий","dist":"100"}'),
  ('06', 'accepted', '2026-09-06', '{"returnMode":"циклічний","dist":"100","normWeight":"20"}'),
  ('07', 'accepted', '2026-09-07', '{"returnMode":"циклічний","dist":"100","normWeight":"20"}'),
  ('08', 'accepted', '2026-09-08', '{}'),
  ('10', 'accepted', '2026-09-10', '{"returnMode":"разовий","dist":"100"}'),
  ('11', 'draft',    '2026-09-11', '{"returnMode":"разовий","dist":"100"}'),
  ('12', 'proposed', '2026-09-12', '{"returnMode":"разовий","dist":"100"}'),
  ('13', 'rejected', '2026-09-13', '{"returnMode":"разовий","dist":"100"}'),
  ('14', 'accepted', '2026-09-14', '{"returnMode":"циклічний","dist":"100","normWeight":"25","isRoundTrip":true,"rtTransferDist":"20","rtBackhaulDist":"80","rtReturnDist":"30","rtTotalVolume":"25"}')
) AS t(k, st, d, inputs);
INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage, snapshot)
SELECT ('72000000-0000-0000-0000-0000000000' || c)::uuid, ('71000000-0000-0000-0000-0000000000' || v)::uuid, tons, snap::jsonb
FROM (VALUES
  ('01', 'a1', 20, '{}'), ('02', 'a1', 20, '{}'), ('03', 'a1', 20, '{}'), ('05', 'a1', 20, '{}'),
  ('06', 'a1', 50, '{"resolved":{"payloadTons":25}}'), ('06', 'a2', 25, '{"resolved":{"payloadTons":25}}'),
  ('07', 'a1', 50, '{"resolved":{"payloadTons":25}}'), ('07', 'a2', 25, '{"resolved":{"payloadTons":25}}'),
  ('08', 'a1', 10, '{}'), ('08', 'a2', 30, '{}'),
  ('10', 'a1', 20, '{}'), ('11', 'a1', 20, '{}'), ('12', 'a1', 20, '{}'), ('13', 'a1', 20, '{}'),
  ('14', 'a3', 50, '{"resolved":{"payloadTons":25}}')
) AS t(c, v, tons, snap);
-- Факт v2 (на всю заявку): 05 — 300 + 50; 07 — 600 + 200 на два авто; 08 — 500 при нульовому плані (рівні частки).
INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by, fact_version, fact_days,
                                 fact_loaded_km, fact_empty_km, paid_idle_days, idle_rate, extra_costs)
SELECT ('72000000-0000-0000-0000-0000000000' || c)::uuid, 0, 0, 0, 0, '00000000-0000-0000-0000-0000000000f1', 'v2', 1, l, e, 0, 0, 0
FROM (VALUES ('05', 300, 50), ('07', 600, 200), ('08', 400, 100)) AS t(c, l, e);
-- Ручний факт (без v2) не переважає план.
INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by)
VALUES ('72000000-0000-0000-0000-000000000003', 0, 0, 0, 0, '00000000-0000-0000-0000-0000000000f1');

-- 1. Права: anon нічого; прямого запису немає; внутрішні функції клієнтам недоступні.
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_status()$$, '42501', NULL, 'anon cannot call kp_maintenance_status');
SELECT throws_ok($$SELECT count(*) FROM public.maintenance_types$$, '42501', NULL, 'anon cannot read maintenance_types');
SELECT throws_ok($$SELECT count(*) FROM public.vehicle_odometer_readings$$, '42501', NULL, 'anon cannot read odometer readings');
RESET ROLE;
SELECT ok(NOT has_function_privilege('authenticated', 'public.kp_vehicle_trip_km(uuid, uuid, date, date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_vehicle_trip_km(uuid, uuid, date, date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_vehicle_mileage_at(uuid, uuid, date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_trip_plan_km(jsonb, numeric, numeric, numeric)', 'EXECUTE'),
  'internal trip-km / mileage functions are not granted to clients');
SELECT ok(has_function_privilege('authenticated', 'public.kp_maintenance_status(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_maintenance_status(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_repair_cost_per_km(date, date, uuid)', 'EXECUTE'),
  'client functions: authenticated yes, anon no');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO public.maintenance_types (org_id, name, interval_km) VALUES ('70000000-0000-0000-0000-00000000000a', 'x', 1)$$,
  '42501', NULL, 'owner: no direct INSERT into maintenance_types');
SELECT throws_ok($$INSERT INTO public.vehicle_odometer_readings (org_id, vehicle_id, read_on, odometer_km) VALUES ('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', public.ua_today(), 1)$$,
  '42501', NULL, 'owner: no direct INSERT into odometer readings');
SELECT throws_ok($$DELETE FROM public.repair_maintenance$$, '42501', NULL, 'owner: no direct DELETE of repair_maintenance');
SELECT throws_ok($$UPDATE public.vehicle_maintenance_overrides SET disabled = true$$, '42501', NULL, 'owner: no direct UPDATE of overrides');
SELECT throws_ok($$SELECT public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', DATE '2026-01-01', DATE '2026-12-31')$$,
  '42501', NULL, 'owner: kp_vehicle_trip_km is internal');

-- 2. Шаблон ТО: засів (ідемпотентний), типи, архів.
SELECT is((SELECT count(*)::integer FROM public.kp_maintenance_seed_defaults()), 5, 'seed: five default types');
SELECT is((SELECT count(*)::integer FROM public.kp_maintenance_seed_defaults()), 5, 'seed again: still five (idempotent)');
SELECT is((SELECT interval_km::text || '/' || interval_months::text FROM public.maintenance_types WHERE name = 'Масло двигуна'), '15000/12', 'seed: oil 15000 km / 12 months');
SELECT lives_ok($$INSERT INTO t_m SELECT 'T_KM', id FROM public.kp_maintenance_type_upsert(NULL, 'Тест км', 10000, NULL) WHERE name = 'Тест км'$$, 'type with km interval only');
SELECT lives_ok($$INSERT INTO t_m SELECT 'T_MON', id FROM public.kp_maintenance_type_upsert(NULL, 'Тест міс', NULL, 6) WHERE name = 'Тест міс'$$, 'type with months only');
SELECT lives_ok($$INSERT INTO t_m SELECT 'T_BOTH', id FROM public.kp_maintenance_type_upsert(NULL, 'Тест обидва', 10000, 12) WHERE name = 'Тест обидва'$$, 'type with both intervals');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_type_upsert(NULL, ' тест КМ ', 5000, NULL)$$, 'P0001', NULL, 'name is unique among active (lower/btrim) — MAINT_TYPE_EXISTS');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_type_upsert(NULL, 'Без інтервалу', NULL, NULL)$$, 'P0001', NULL, 'at least one interval — MAINT_TYPE_INTERVAL');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_type_upsert(NULL, 'Забагато місяців', NULL, 121)$$, 'P0001', NULL, 'months 1..120');
SELECT lives_ok($$INSERT INTO t_m SELECT 'T_OLD', id FROM public.kp_maintenance_type_upsert(NULL, 'Архівний', 1000, NULL) WHERE name = 'Архівний'$$, 'type to archive');
SELECT lives_ok($$SELECT * FROM public.kp_maintenance_type_archive((SELECT id FROM t_m WHERE k = 'T_OLD'))$$, 'archive');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_type_upsert((SELECT id FROM t_m WHERE k = 'T_OLD'), 'Архівний', 2000, NULL)$$, 'P0001', NULL, 'archived type cannot be edited — MAINT_TYPE_ARCHIVED');
SELECT lives_ok($$SELECT * FROM public.kp_maintenance_type_upsert(NULL, 'Архівний', 1000, NULL)$$, 'archived name can be reused');
SELECT is((SELECT count(*)::integer FROM public.maintenance_types WHERE NOT is_active), 1, 'archived type is kept (soft delete)');
RESET ROLE;

-- 3. Км рейсів (внутрішня функція; викликає БД-власник).
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-01', '2026-09-02'), 100.0,
  'trip on the base day is not counted, the next day is (accepted counts)');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-08-31', '2026-09-01'), 100.0,
  'base the day before → trip of 09-01 counted');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-02', '2026-09-03'), 100.0,
  'done counts; a manual (non-v2) fact does not replace the plan');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-03', '2026-09-04'), 0.0,
  'trip without a calc_vehicles row is not counted (even with carsCount 1)');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-04', '2026-09-05'), 350.0,
  'v2 fact (300 + 50) wins over the plan (100)');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-05', '2026-09-06')::text
  || '|' || public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a2', '2026-09-05', '2026-09-06')::text,
  '300.0|100.0', 'two vehicles, no fact: each its own planned slice (2 trips → 300, 1 trip → 100)');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-06', '2026-09-07')::text
  || '|' || public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a2', '2026-09-06', '2026-09-07')::text,
  '600.0|200.0', 'two vehicles with a v2 fact of 800: split by planned km 300 : 100');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a2', '2026-09-07', '2026-09-08'), 250.0,
  'zero plan: the fact is split equally between the vehicles');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-01', '2026-09-09'), 1700.0,
  'window (09-01, 09-09]: 100 + 100 + 350 + 300 + 600 + 250; trip after p_to not counted');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-09', '2026-09-10'), 100.0,
  'the later trip counts once p_to reaches it');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', '2026-09-10', '2026-09-13'), 0.0,
  'draft / proposed / rejected are not counted');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a3', '2026-09-13', '2026-09-14'), 330.0,
  'round trip: 200 loaded + 100 empty → one empty return replaced by the loop: 280 + 50');
SELECT is(public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000b', '71000000-0000-0000-0000-0000000000a1', '2026-09-01', '2026-09-30'), 0.0,
  'another org id → 0');

-- 4. Пробіг: база + км рейсів; без бази — NULL.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT odometer_km IS NULL AND base_read_on IS NULL FROM public.kp_vehicle_mileage('71000000-0000-0000-0000-0000000000a1')), 'no base → mileage NULL');
SELECT lives_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000a1', DATE '2026-09-01', 120000, 'Початок')$$, 'odometer base on 09-01');
SELECT is((SELECT odometer_km::text || '|' || base_km::text || '|' || trips_km::text || '|' || source FROM public.kp_vehicle_mileage('71000000-0000-0000-0000-0000000000a1', DATE '2026-09-09')),
  '121700|120000|1700.0|manual', 'mileage on 09-09 = base + trips after the base day');
SELECT throws_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000a1', public.ua_today() + 1, 1, NULL)$$, 'P0001', NULL, 'odometer date in the future — BAD_DATE');
SELECT throws_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000a1', public.ua_today(), -1, NULL)$$, 'P0001', NULL, 'negative odometer — ODOMETER_BAD_VALUES');
SELECT throws_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000b1', public.ua_today(), 1, NULL)$$, 'P0001', NULL, 'vehicle of another org — REPAIR_VEHICLE_NOT_FOUND');
SELECT is((SELECT count(*)::integer FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000a1', DATE '2026-09-05', 125000, NULL)), 2,
  'odometer_add returns the updated history');
SELECT is((SELECT odometer_km FROM public.kp_vehicle_mileage('71000000-0000-0000-0000-0000000000a1', DATE '2026-09-09')), 126150,
  'the latest base wins: 125000 + trips after 09-05 (300 + 600 + 250)');

-- 5. Межі статусу (чисте правило).
RESET ROLE;
SELECT is((SELECT status || '|' || coalesce(reason, '-') FROM public.kp_maintenance_eval(5001, NULL)), 'ok|km', 'km left 5001 → ok');
SELECT is((SELECT status FROM public.kp_maintenance_eval(5000, NULL)), 'yellow', 'km left 5000 → yellow');
SELECT is((SELECT status FROM public.kp_maintenance_eval(0, NULL)), 'red', 'km left 0 → red');
SELECT is((SELECT status FROM public.kp_maintenance_eval(-1, NULL)), 'red', 'km left −1 → red');
SELECT is((SELECT status || '|' || reason FROM public.kp_maintenance_eval(NULL, 15)), 'ok|time', '15 days → ok');
SELECT is((SELECT status FROM public.kp_maintenance_eval(NULL, 14)), 'yellow', '14 days → yellow');
SELECT is((SELECT status FROM public.kp_maintenance_eval(NULL, 0)), 'red', 'due today (0 days) → red');
SELECT is((SELECT status || '|' || reason FROM public.kp_maintenance_eval(20000, 10)), 'yellow|time', 'km ok + time yellow → yellow (time)');
SELECT is((SELECT status || '|' || reason FROM public.kp_maintenance_eval(0, 200)), 'red|km', 'km red + time ok → red (km)');
SELECT is((SELECT status || '|' || coalesce(reason, '-') FROM public.kp_maintenance_eval(NULL, NULL)), 'unknown|-', 'both unknown → unknown');

-- 6. Статус по авто (сьогодні за Києвом). a4..a7 — без ремонтів: старт = найраніша база (вчора), поточна = база сьогодні.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$
  SELECT count(*) FROM (VALUES ('a4', 104999), ('a5', 105000), ('a6', 110000), ('a7', 110001)) AS t(v, km),
    LATERAL public.kp_odometer_add(('71000000-0000-0000-0000-0000000000' || t.v)::uuid, public.ua_today() - 1, 100000, 'старт') AS a,
    LATERAL public.kp_odometer_add(('71000000-0000-0000-0000-0000000000' || t.v)::uuid, public.ua_today(), t.km, NULL) AS b
$$, 'bases for a4..a7');
SELECT is((SELECT left_km::text || '|' || status || '|' || coalesce(left_days::text, 'null') FROM t_st WHERE v = 'a4' AND k = 'T_KM'), '5001|ok|null',
  'a4: km interval only, 5001 left → ok, no time dimension');
SELECT is((SELECT left_km::text || '|' || status FROM t_st WHERE v = 'a5' AND k = 'T_KM'), '5000|yellow', 'a5: 5000 left → yellow');
SELECT is((SELECT left_km::text || '|' || status FROM t_st WHERE v = 'a6' AND k = 'T_KM'), '0|red', 'a6: 0 left → red');
SELECT is((SELECT left_km::text || '|' || status || '|' || last_source FROM t_st WHERE v = 'a7' AND k = 'T_KM'), '-1|red|start', 'a7: −1 → red, counted from the first base');
SELECT is((SELECT status || '|' || reason || '|' || coalesce(left_km::text, 'null') FROM t_st WHERE v = 'a6' AND k = 'T_MON'), 'ok|time|null',
  'months-only type: time dimension only');
SELECT is((SELECT status || '|' || reason FROM t_st WHERE v = 'a6' AND k = 'T_BOTH'), 'red|km', 'a6 both: km red + time ok → red (km)');
SELECT is((SELECT status FROM t_st WHERE v = 'a9' AND k = 'T_KM'), 'unknown', 'no base, no repair → unknown');
SELECT ok((SELECT bool_and(status IN ('red', 'yellow')) FROM (SELECT status FROM public.kp_maintenance_status() LIMIT 3) AS f), 'problems come first');

-- Перевизначення на авто переважає шаблон; disabled прибирає тип.
SELECT lives_ok($$SELECT * FROM public.kp_maintenance_override_set('71000000-0000-0000-0000-0000000000a4', (SELECT id FROM t_m WHERE k = 'T_KM'), 20000, NULL)$$, 'override a4: 20000 km');
SELECT is((SELECT interval_km::text || '|' || left_km::text || '|' || overridden::text FROM t_st WHERE v = 'a4' AND k = 'T_KM'), '20000|15001|true',
  'override wins over the template');
SELECT lives_ok($$SELECT * FROM public.kp_maintenance_override_set('71000000-0000-0000-0000-0000000000a5', (SELECT id FROM t_m WHERE k = 'T_KM'), NULL, NULL, true)$$, 'disable a5 / T_KM');
SELECT is((SELECT count(*)::integer FROM t_st WHERE v = 'a5' AND k = 'T_KM'), 0, 'disabled type is not tracked for the vehicle');
SELECT is((SELECT count(*)::integer FROM public.kp_maintenance_override_clear('71000000-0000-0000-0000-0000000000a5', (SELECT id FROM t_m WHERE k = 'T_KM'))), 0, 'clear returns the remaining overrides');
SELECT is((SELECT count(*)::integer FROM t_st WHERE v = 'a5' AND k = 'T_KM'), 1, 'cleared → tracked again');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_override_set('71000000-0000-0000-0000-0000000000a4', (SELECT id FROM t_m WHERE k = 'T_OLD'), 1, NULL)$$, 'P0001', NULL, 'override of an archived type — MAINT_TYPE_ARCHIVED');
SELECT is((SELECT count(*)::integer FROM t_st WHERE k = 'T_OLD'), 0, 'archived type is not in the status');

-- 7. Ремонт з ТО скидає відлік; сторно — відкат; повторний set_maintenance замінює набір.
SELECT lives_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000ab', public.ua_today() - 30, 50000, NULL)$$, 'ab: base −30 d 50000');
SELECT lives_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000ab', public.ua_today() - 10, 58000, NULL)$$, 'ab: base −10 d 58000');
SELECT lives_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000ab', public.ua_today(), 60000, NULL)$$, 'ab: base today 60000');
SELECT lives_ok($$INSERT INTO t_m SELECT 'R1', public.kp_repair_post('71000000-0000-0000-0000-0000000000ab', public.ua_today() - 20, 52000, 'ТО', NULL, 0, '[]'::jsonb)$$, 'R1 −20 d, odometer 52000');
SELECT is((SELECT string_agg(done_km::text, ',') FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R1'), ARRAY[(SELECT id FROM t_m WHERE k = 'T_KM')])),
  '52000', 'done_km from the repair odometer');
SELECT is((SELECT left_km::text || '|' || status || '|' || last_source || '|' || (last_on = public.ua_today() - 20)::text FROM t_st WHERE v = 'ab' AND k = 'T_KM'),
  '2000|yellow|repair|true', 'R1 resets the countdown: 52000 + 10000 − 60000');
SELECT lives_ok($$INSERT INTO t_m SELECT 'R2', public.kp_repair_post('71000000-0000-0000-0000-0000000000ab', public.ua_today() - 5, NULL, 'ТО 2', NULL, 0, '[]'::jsonb)$$, 'R2 −5 d without odometer');
SELECT is((SELECT string_agg(done_km::text, ',') FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R2'), ARRAY[(SELECT id FROM t_m WHERE k = 'T_KM')])),
  '58000', 'done_km from the computed mileage on the repair date');
SELECT is((SELECT left_km::text || '|' || status FROM t_st WHERE v = 'ab' AND k = 'T_KM'), '8000|ok', 'the latest posted repair counts');
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_m WHERE k = 'R2'), NULL)$$, 'void R2');
SELECT is((SELECT left_km::text || '|' || status || '|' || last_km::text FROM t_st WHERE v = 'ab' AND k = 'T_KM'), '2000|yellow|52000', 'void → back to the previous execution');
SELECT is((SELECT count(*)::integer FROM public.repair_maintenance WHERE repair_id = (SELECT id FROM t_m WHERE k = 'R2')), 1, 'void deletes nothing');
SELECT throws_ok($$SELECT * FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R2'), '{}'::uuid[])$$, 'P0001', NULL, 'void repair — REPAIR_ALREADY_VOID');
SELECT is((SELECT string_agg(type_name, ',') FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R1'), ARRAY[(SELECT id FROM t_m WHERE k = 'T_BOTH')])),
  'Тест обидва', 'set_maintenance again replaces the set');
SELECT is((SELECT left_km::text || '|' || status || '|' || last_source FROM t_st WHERE v = 'ab' AND k = 'T_KM'), '0|red|start', 'no executions left → from the first base');
SELECT lives_ok($$SELECT public.kp_repair_update((SELECT id FROM t_m WHERE k = 'R1'), public.ua_today() - 20, 53000, 'ТО', NULL, 0)$$, 'kp_repair_update: odometer 53000');
SELECT is((SELECT done_km FROM public.repair_maintenance WHERE repair_id = (SELECT id FROM t_m WHERE k = 'R1')), 53000, 'trigger recomputes done_km after the update');
SELECT throws_ok($$SELECT * FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R1'), ARRAY[(SELECT id FROM t_m WHERE k = 'T_OLD')])$$, 'P0001', NULL, 'archived type cannot be added to a repair');
-- Без бази: ремонт без одометра → done_km NULL → лише часовий вимір (ремонт 12 міс − 10 днів тому → yellow за часом).
SELECT lives_ok($$INSERT INTO t_m SELECT 'R3', public.kp_repair_post('71000000-0000-0000-0000-0000000000aa', (public.ua_today() - interval '12 months' + interval '10 days')::date, NULL, 'ТО', NULL, 0, '[]'::jsonb)$$, 'aa: repair without a base');
SELECT is((SELECT coalesce(string_agg(coalesce(done_km::text, 'null'), ','), '') FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R3'), ARRAY[(SELECT id FROM t_m WHERE k = 'T_BOTH')])),
  'null', 'no odometer, no base → done_km NULL');
SELECT is((SELECT status || '|' || reason || '|' || coalesce(left_km::text, 'null') FROM t_st WHERE v = 'aa' AND k = 'T_BOTH'), 'yellow|time|null', 'no base → time dimension only');
-- км ok + час yellow → yellow (time): a8 — ремонт 12 міс − 10 днів тому з одометром 100000, сьогодні 101000.
SELECT lives_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000a8', public.ua_today(), 101000, NULL)$$, 'a8 base today');
SELECT lives_ok($$INSERT INTO t_m SELECT 'R4', public.kp_repair_post('71000000-0000-0000-0000-0000000000a8', (public.ua_today() - interval '12 months' + interval '10 days')::date, 100000, 'ТО', NULL, 0, '[]'::jsonb)$$, 'a8 repair');
SELECT lives_ok($$SELECT * FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R4'), ARRAY[(SELECT id FROM t_m WHERE k = 'T_BOTH')])$$, 'a8 TO');
SELECT is((SELECT status || '|' || reason || '|' || left_km::text FROM t_st WHERE v = 'a8' AND k = 'T_BOTH'), 'yellow|time|9000', 'km ok (9000) + time yellow → yellow (time)');
RESET ROLE;

-- 8. Інші ролі: інша організація, не призначений логіст, менеджер з ремонтів.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f8","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.maintenance_types) + (SELECT count(*)::integer FROM public.vehicle_odometer_readings)
  + (SELECT count(*)::integer FROM public.repair_maintenance) + (SELECT count(*)::integer FROM public.vehicle_maintenance_overrides), 0, 'another org: 0 rows');
SELECT is((SELECT count(*)::integer FROM public.kp_maintenance_status()), 0, 'another org: no status rows of M');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_status('71000000-0000-0000-0000-0000000000a1')$$, 'P0001', NULL, 'another org: vehicle of M — REPAIR_VEHICLE_NOT_FOUND');
SELECT throws_ok($$SELECT * FROM public.kp_vehicle_mileage('71000000-0000-0000-0000-0000000000a1')$$, 'P0001', NULL, 'another org: mileage of M — refused');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_type_archive((SELECT id FROM t_m WHERE k = 'T_KM'))$$, 'P0001', NULL, 'another org: type of M — MAINT_TYPE_NOT_FOUND');
SELECT throws_ok($$SELECT * FROM public.kp_repair_set_maintenance((SELECT id FROM t_m WHERE k = 'R1'), '{}'::uuid[])$$, 'P0001', NULL, 'another org: repair of M — REPAIR_NOT_FOUND');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_override_set('71000000-0000-0000-0000-0000000000a1', (SELECT id FROM t_m WHERE k = 'T_KM'), 1, NULL)$$, 'P0001', NULL, 'another org: override on M — refused');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT count(*) FROM public.kp_maintenance_status()) > 0, 'unassigned logist reads the status');
SELECT throws_ok($$SELECT * FROM public.kp_odometer_add('71000000-0000-0000-0000-0000000000a1', public.ua_today(), 1, NULL)$$, '42501', NULL, 'unassigned logist cannot add a reading');
SELECT throws_ok($$SELECT * FROM public.kp_maintenance_seed_defaults()$$, '42501', NULL, 'unassigned logist cannot seed');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f5","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT array_to_string(proargnames, ',') FROM pg_proc WHERE proname = 'kp_vehicle_mileage'),
  'p_vehicle,p_on,odometer_km,base_read_on,base_km,trips_km,source', 'mileage returns numbers and dates only (no routes, clients, sums)');
SELECT is((SELECT odometer_km FROM public.kp_vehicle_mileage('71000000-0000-0000-0000-0000000000a1', DATE '2026-09-09')), 126150, 'manager: mileage as a number');
SELECT throws_ok($$SELECT public.kp_vehicle_trip_km('70000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-0000000000a1', DATE '2026-09-01', DATE '2026-09-30')$$,
  '42501', NULL, 'manager: kp_vehicle_trip_km not callable');
SELECT is((SELECT count(*)::integer FROM public.calculations) + (SELECT count(*)::integer FROM public.calc_vehicles) + (SELECT count(*)::integer FROM public.trip_actuals),
  0, 'manager: still no trips, vehicles of trips or facts');
SELECT lives_ok($$SELECT * FROM public.kp_maintenance_type_upsert(NULL, 'Менеджерський', 5000, NULL)$$, 'manager writes the template');
RESET ROLE;

-- 9. Вартість на км (a2): лише posted, без сторнованих списань, межі періоду включні, km = 0 → NULL.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO t_m SELECT 'P', public.kp_part_upsert(NULL, 'Колодка RM', 'RM-P', 'шт', NULL, NULL)$$, 'part');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_m WHERE k = 'P'), 10, 100, DATE '2026-08-01')$$, 'receipt 10 × 100');
SELECT lives_ok($$SELECT public.kp_repair_post('71000000-0000-0000-0000-0000000000a2', DATE '2026-09-01', NULL, 'C1', NULL, 300,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_m WHERE k = 'P'), 'qty', 2)))$$, 'C1 on the first day: 300 + 2 × 100');
SELECT lives_ok($$INSERT INTO t_m SELECT 'C2', public.kp_repair_post('71000000-0000-0000-0000-0000000000a2', DATE '2026-09-08', NULL, 'C2', NULL, 100,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_m WHERE k = 'P'), 'qty', 1)))$$, 'C2 on the last day: 100 + 1 × 100');
SELECT lives_ok($$SELECT public.kp_repair_post('71000000-0000-0000-0000-0000000000a2', DATE '2026-09-09', NULL, 'C3', NULL, 1000, '[]'::jsonb)$$, 'C3 after the period');
SELECT lives_ok($$INSERT INTO t_m SELECT 'C4', public.kp_repair_post('71000000-0000-0000-0000-0000000000a2', DATE '2026-09-05', NULL, 'C4', NULL, 700,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_m WHERE k = 'P'), 'qty', 1)))$$, 'C4 in the period');
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_m WHERE k = 'C4'), NULL)$$, 'C4 void');
SELECT lives_ok($$SELECT public.kp_repair_post('71000000-0000-0000-0000-0000000000a5', DATE '2026-09-03', NULL, 'C5', NULL, 50, '[]'::jsonb)$$, 'a5: repair, no trips');
RESET ROLE;
-- Сторноване списання в проведеному ремонті не рахується (службова правка — лише для перевірки фільтра).
UPDATE public.part_writeoffs SET reversed_at = now() WHERE repair_id = (SELECT id FROM t_m WHERE k = 'C2');
SET LOCAL ROLE authenticated;
SELECT is((SELECT repairs_count::text || '|' || parts_cost::text || '|' || service_cost::text || '|' || cost::text || '|' || km::text || '|' || cost_per_km::text
           FROM public.kp_repair_cost_per_km(DATE '2026-09-01', DATE '2026-09-08') WHERE vehicle_id = '71000000-0000-0000-0000-0000000000a2'),
  '2|200.00|400.00|600.00|550.0|1.09', 'a2: posted only, reversed write-offs excluded, both period ends included; km 100 + 200 + 250');
SELECT is((SELECT cost::text || '|' || km::text || '|' || coalesce(cost_per_km::text, 'null') FROM public.kp_repair_cost_per_km(DATE '2026-09-01', DATE '2026-09-08')
           WHERE vehicle_id = '71000000-0000-0000-0000-0000000000a5'), '50.00|0|null', 'no trips → km 0, cost per km NULL');
SELECT is((SELECT parts_cost::text || '|' || km::text FROM public.kp_repair_cost_per_km(DATE '2026-09-01', DATE '2026-09-08', '71000000-0000-0000-0000-0000000000a1')),
  '0.00|1800.0', 'vehicle filter; km window [p_from, p_to] includes the trip on p_from (100 + 1700)');
SELECT throws_ok($$SELECT * FROM public.kp_repair_cost_per_km(DATE '2023-01-01', DATE '2026-01-01')$$, 'P0001', NULL, 'period over 3 years — PERIOD_TOO_LONG');
SELECT lives_ok($$SELECT * FROM public.kp_repair_cost_per_km(DATE '2023-01-02', DATE '2026-01-01')$$, 'period just under 3 years');
SELECT throws_ok($$SELECT * FROM public.kp_repair_cost_per_km(DATE '2026-09-02', DATE '2026-09-01')$$, 'P0001', NULL, 'from after to — BAD_PERIOD');
SELECT throws_ok($$SELECT * FROM public.kp_repair_cost_per_km(DATE '2026-09-01', DATE '2026-09-08', '71000000-0000-0000-0000-0000000000b1')$$, 'P0001', NULL, 'vehicle of another org — refused');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f8","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.kp_repair_cost_per_km(DATE '2026-09-01', DATE '2026-09-30')), 0, 'another org: no cost rows of M');
RESET ROLE;

-- 10. Хвіст 2: kp_repair_invite_reserve прибирає журнал відправлень старше доби.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f8","role":"service_role"}', true);
SELECT lives_ok($$INSERT INTO t_m SELECT 'I1', public.kp_repair_invite_reserve('70000000-0000-0000-0000-00000000000b', gen_random_uuid(), 'rm-i1@example.com', repeat('c', 64), NULL, now() + interval '7 days')$$,
  'org N: first invite');
INSERT INTO public.repair_invite_sends (org_id, invite_id, sent_at)
SELECT '70000000-0000-0000-0000-00000000000b', (SELECT id FROM t_m WHERE k = 'I1'), now() - interval '2 days' FROM generate_series(1, 12);
SELECT lives_ok($$SELECT public.kp_repair_invite_reserve('70000000-0000-0000-0000-00000000000b', gen_random_uuid(), 'rm-i2@example.com', repeat('d', 64), NULL, now() + interval '7 days')$$,
  'second invite: 12 old sends do not count');
SELECT is((SELECT count(*)::integer FROM public.repair_invite_sends WHERE sent_at < now() - interval '1 day'), 0, 'sends older than a day are deleted');
SELECT is((SELECT count(*)::integer FROM public.repair_invite_sends WHERE org_id = '70000000-0000-0000-0000-00000000000b'), 2, 'recent sends are kept');

-- 11. Хвіст 3: директор заблокованої організації не має власного Контроль+.
INSERT INTO public.org_directors (org_id, user_id) VALUES ('70000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000f9');
SELECT is(public.kp_user_has_own_kp('00000000-0000-0000-0000-0000000000f9'), true, 'director of an active control_plus org → own KP');
UPDATE public.organizations SET status = 'blocked' WHERE id = '70000000-0000-0000-0000-00000000000c';
SELECT is(public.kp_user_has_own_kp('00000000-0000-0000-0000-0000000000f9'), false, 'director of a blocked org → no own KP (as for members)');
SELECT is(public.kp_user_has_own_kp('00000000-0000-0000-0000-0000000000f1'), true, 'owner of an active control_plus org → own KP (unchanged)');

SELECT * FROM finish();
ROLLBACK;
