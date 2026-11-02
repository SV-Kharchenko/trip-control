-- Подорожній лист: дозаправки в дорозі (*_kp_trip_sheet_refuels.sql): таблиця, RPC, факт пального, права.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim. Усі дані — вигадані.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(48);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A: owner e101, logist e102; B: owner e103.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('c2000000-0000-4000-8000-00000000000a', 'RF A', 'team'),
       ('c2000000-0000-4000-8000-00000000000b', 'RF B', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'rf-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'RF ' || k), now(), now()
FROM unnest(ARRAY['e101', 'e102', 'e103']) AS k;

UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000e103' THEN 'c2000000-0000-4000-8000-00000000000b'::uuid
                     ELSE 'c2000000-0000-4000-8000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000e102' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-00000000e103');

SELECT public.set_org_plan('c2000000-0000-4000-8000-00000000000a', 'control_plus');
SELECT public.set_org_plan('c2000000-0000-4000-8000-00000000000b', 'control_plus');
INSERT INTO public.kp_org_requisites (org_id, legal_name, edrpou)
VALUES ('c2000000-0000-4000-8000-00000000000a', 'ТОВ Перевізник RF', '12345678'),
       ('c2000000-0000-4000-8000-00000000000b', 'ТОВ Інший RF', '87654321');

CREATE TEMP TABLE t_rf (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_rf TO PUBLIC;

-- 1. Схема й права.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.kp_trip_sheet_refuels'::regclass)
  AND has_table_privilege('authenticated', 'public.kp_trip_sheet_refuels', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.kp_trip_sheet_refuels', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.kp_trip_sheet_refuels', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.kp_trip_sheet_refuels', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.kp_trip_sheet_refuels', 'SELECT'),
  'refuels: RLS on, authenticated only reads, anon nothing');
SELECT ok(NOT has_function_privilege('anon', 'public.kp_trip_sheet_refuels_save(uuid, jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_trip_sheet_refuels_save(uuid, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_trip_sheet_refuels_guard()', 'EXECUTE'),
  'refuels_save: authenticated yes, anon no; the guard is closed');
SELECT is((SELECT string_agg(policyname, ',') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kp_trip_sheet_refuels'), 'kp_trip_sheet_refuels_select', 'refuels: one select policy');

-- 2. Листи: «ts» (з дозаправками), «plain» (старий лист без дозаправок), «neg» (перевірка від'ємного факту).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);
INSERT INTO t_rf
SELECT k, public.kp_trip_sheet_create('2026-10-28', NULL, $j${
  "valid_from":"2026-10-28","valid_to":"2026-10-30",
  "driver":{"full_name":"Тестовий Водій","license_no":"AB123456"},
  "vehicle":{"make_model":"DAF XF","reg_number":"AA1234RF","fuel_load":"30","fuel_empty":"20"},
  "task":{"customer":"Агро","route_from":"Луцьк","route_to":"Одеса","cargo":"Пшениця","tonnage":"22","loaded_km":"300"},
  "depart":{"at":"2026-10-28T06:00:00+03:00","odometer":"100000","fuel_left":"80","fuel_issued":"200","fuel_kind":"ДП"}}$j$::jsonb)
FROM unnest(ARRAY['ts', 'plain', 'neg']) AS k;
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'plain')) -> 'refuels'), '[]'::jsonb, 'old sheet: no refuels, empty array');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'plain')) #>> '{totals,refuel_l}'), '0', 'old sheet: refuel total is 0');

-- 3. Збереження: сума рахується базою, порядок, підсумок.
SELECT lives_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[
  {"refuel_at":"2026-10-28T14:00:00+03:00","place":"АЗС WOG, Житомир","liters":"100","price_per_l":"55,5","pay_method":"card","receipt_no":"№1234"},
  {"refuel_at":"2026-10-28T20:00:00+03:00","place":"АЗС OKKO, Умань","liters":"50,5","pay_method":"cash"}]')$$, 'save: two refuels');
SELECT is((SELECT string_agg(position::text || ':' || place, ',' ORDER BY position) FROM public.kp_trip_sheet_refuels), '1:АЗС WOG, Житомир,2:АЗС OKKO, Умань', 'save: order = array order');
SELECT is((SELECT amount FROM public.kp_trip_sheet_refuels WHERE position = 1), 5550.00::numeric, 'amount = liters × price (100 × 55.5)');
SELECT is((SELECT amount FROM public.kp_trip_sheet_refuels WHERE position = 2), NULL, 'no price → no amount');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'ts')) #>> '{totals,refuel_l}')::numeric, 150.5::numeric, 'totals: Σ refuel litres');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'ts')) -> 'refuels' -> 0 ->> 'pay_method'), 'card', 'get: refuel rows with the payment method');
SELECT throws_ok($$UPDATE public.kp_trip_sheet_refuels SET amount = 1$$, '428C9', NULL, 'amount is a generated column');
SELECT throws_ok($$UPDATE public.kp_trip_sheet_refuels SET liters = 1$$, '42501', NULL, 'no direct UPDATE');
SELECT throws_ok($$INSERT INTO public.kp_trip_sheet_refuels (sheet_id, org_id, position, liters) VALUES ((SELECT id FROM t_rf WHERE k = 'ts'), 'c2000000-0000-4000-8000-00000000000a', 9, 5)$$, '42501', NULL, 'no direct INSERT');

-- 4. Валідація: все перевіряється до заміни списку.
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"place":"без літрів"}]')$$, 'P0001', 'TS_FIELD_REQUIRED:refuels.liters', 'liters are required');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"0"}]')$$, 'P0001', 'TS_FIELD_INVALID:refuels.liters', 'zero litres refused');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"10"},{"liters":"-5"}]')$$, 'P0001', 'TS_FIELD_INVALID:refuels.liters', 'a bad second row refuses the whole save');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"10","pay_method":"bitcoin"}]')$$, 'P0001', 'TS_FIELD_INVALID:refuels.pay_method', 'unknown payment method refused');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"10","price_per_l":"abc"}]')$$, 'P0001', 'TS_FIELD_INVALID:refuels.price_per_l', 'bad price refused');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"10","refuel_at":"не дата"}]')$$, 'P0001', 'TS_FIELD_INVALID:refuels.refuel_at', 'bad time refused');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '"x"')$$, 'P0001', 'TS_BAD_DATA', 'not an array refused');
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_refuels), 2, 'refused saves keep the previous list');

-- 5. Закриття: факт = виїзд + видано + дозаправки − залишок.
SELECT is((public.kp_trip_sheet_close((SELECT id FROM t_rf WHERE k = 'ts'),
  '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100600","return_fuel_left":"50"}') ->> 'fuel_actual')::numeric, 380.5::numeric,
  'close: actual = 80 + 200 + 150.5 − 50 = 380.5');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'ts')) ->> 'fuel_actual')::numeric, 380.5::numeric, 'close: the actual is stored');
SELECT is((public.kp_trip_sheet_close((SELECT id FROM t_rf WHERE k = 'plain'),
  '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100600","return_fuel_left":"50"}') ->> 'fuel_actual')::numeric, 230.0::numeric,
  'old sheet without refuels: actual = 80 + 200 − 50 = 230 as before');

-- 6. Від'ємний факт: залишок більший за все, що було.
SELECT throws_ok($$SELECT public.kp_trip_sheet_close((SELECT id FROM t_rf WHERE k = 'neg'),
  '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100600","return_fuel_left":"281"}')$$, 'P0001', 'TS_FUEL_NEGATIVE', 'close: return fuel above departure + issued is refused (no refuels)');
SELECT lives_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'neg'), '[{"liters":"10"}]')$$, 'neg: a refuel of 10 l');
SELECT throws_ok($$SELECT public.kp_trip_sheet_close((SELECT id FROM t_rf WHERE k = 'neg'),
  '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100600","return_fuel_left":"291"}')$$, 'P0001', 'TS_FUEL_NEGATIVE', 'close: return fuel above departure + issued + refuels is refused');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'neg')) ->> 'status'), 'issued', 'close: a refused close leaves the sheet issued');
SELECT is((public.kp_trip_sheet_close((SELECT id FROM t_rf WHERE k = 'neg'),
  '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100600","return_fuel_left":"290"}') ->> 'fuel_actual')::numeric, 0.0::numeric, 'close: actual 0 is allowed, never negative');

-- 7. Закритий лист не редагується.
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[]')$$, 'P0001', 'TS_NOT_ISSUED', 'closed: the list cannot be replaced');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"1"}]')$$, 'P0001', 'TS_NOT_ISSUED', 'closed: no new refuel');
RESET ROLE;
SELECT throws_ok($$DELETE FROM public.kp_trip_sheet_refuels WHERE sheet_id = (SELECT id FROM t_rf WHERE k = 'ts')$$, 'P0001', 'TS_NOT_ISSUED', 'closed: even the service role cannot delete refuels');
SELECT throws_ok($$UPDATE public.kp_trip_sheet_refuels SET liters = 999 WHERE sheet_id = (SELECT id FROM t_rf WHERE k = 'ts')$$, 'P0001', 'TS_NOT_ISSUED', 'closed: even the service role cannot change refuels');
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_refuels WHERE sheet_id = (SELECT id FROM t_rf WHERE k = 'ts')), 2, 'closed: the refuels are still there');

-- 8. Чужа організація не бачить і не пише.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e103","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_refuels), 0, 'another organisation sees no refuels');
SELECT throws_ok($$SELECT public.kp_trip_sheet_get((SELECT id FROM t_rf WHERE k = 'ts'))$$, 'P0001', 'DOC_NOT_FOUND', 'another organisation cannot read the sheet');
SELECT throws_ok($$SELECT public.kp_trip_sheet_refuels_save((SELECT id FROM t_rf WHERE k = 'ts'), '[{"liters":"5"}]')$$, 'P0001', 'DOC_NOT_FOUND', 'another organisation cannot write refuels');
RESET ROLE;

-- 9. Норми в префілі: картка авто → заявка → «Витратна частина» компанії.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
INSERT INTO public.company_settings (org_id, settings)
VALUES ('c2000000-0000-4000-8000-00000000000a', '{"fuelLoad": 36.5, "fuelEmpty": 28}'::jsonb)
ON CONFLICT (org_id) DO UPDATE SET settings = excluded.settings;
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, trip_date)
VALUES ('c2000000-0000-4000-8000-0000000000c1', 'c2000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000e101',
        'RF trip', '{}'::jsonb, '{}'::jsonb, 'accepted', '2026-10-28');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') #>> '{norms,fuel_load}')::numeric, 36.5::numeric, 'prefill: no card, no request norms → the company norm with cargo');
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') #>> '{norms,fuel_empty}')::numeric, 28::numeric, 'prefill: the company norm when empty');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.calculations SET inputs = '{"fuelLoad": 31, "fuelEmpty": 22}'::jsonb WHERE id = 'c2000000-0000-4000-8000-0000000000c1';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') #>> '{norms,fuel_load}')::numeric, 31::numeric, 'prefill: the norms of the request win over the company ones');
RESET ROLE;

-- 9a. План пального і норми — один пріоритет: картка авто → заявка → «Витратна частина». Рейс 100 км, подачі немає: план = fuelLoad + fuelEmpty.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.calculations SET inputs = '{"dist": 100, "fuelLoad": 31, "fuelEmpty": 22}'::jsonb WHERE id = 'c2000000-0000-4000-8000-0000000000c1';
INSERT INTO public.fleet_vehicles (id, org_id, label, fuel_load, fuel_empty)
VALUES ('c2000000-0000-4000-8000-0000000000d1', 'c2000000-0000-4000-8000-00000000000a', 'RF-CARD', 30, 20);
INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage)
VALUES ('c2000000-0000-4000-8000-0000000000c1', 'c2000000-0000-4000-8000-0000000000d1', 20);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') ->> 'plan_fuel_l')::numeric, 50::numeric, 'card and request differ: both from the card (30 + 20): plan');
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') #>> '{norms,fuel_load}')::numeric, 30::numeric, 'card and request differ: both from the card (30 + 20): norms');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.fleet_vehicles SET fuel_load = NULL, fuel_empty = NULL WHERE id = 'c2000000-0000-4000-8000-0000000000d1';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') ->> 'plan_fuel_l')::numeric, 53::numeric, 'no norms on the card: both from the request (31 + 22): plan');
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') #>> '{norms,fuel_load}')::numeric, 31::numeric, 'no norms on the card: both from the request (31 + 22): norms');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.calculations SET inputs = '{"dist": 100}'::jsonb WHERE id = 'c2000000-0000-4000-8000-0000000000c1';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') ->> 'plan_fuel_l')::numeric, 64.5::numeric, 'neither card nor request: both from the company (36.5 + 28): plan');
SELECT is((public.kp_calc_doc_prefill('c2000000-0000-4000-8000-0000000000c1') #>> '{norms,fuel_load}')::numeric, 36.5::numeric, 'neither card nor request: both from the company (36.5 + 28): norms');
RESET ROLE;

-- 10. Каскад: разом із листом зникають і дозаправки (тригер заборони DELETE листа вимикаємо лише в тесті).
ALTER TABLE public.kp_doc_trip_sheet DISABLE TRIGGER trg_kp_doc_trip_sheet_guard;
DELETE FROM public.kp_doc_trip_sheet WHERE id = (SELECT id FROM t_rf WHERE k = 'ts');
ALTER TABLE public.kp_doc_trip_sheet ENABLE TRIGGER trg_kp_doc_trip_sheet_guard;
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_refuels WHERE sheet_id = (SELECT id FROM t_rf WHERE k = 'ts')), 0, 'cascade: the refuels are removed with the sheet');

SELECT * FROM finish();
ROLLBACK;
