-- Контроль+ ТТН, етап 4b (*_kp_docs_ttn.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim and a minimal
-- storage schema stub (and applies the migration several times — idempotency). Усі дані — вигадані.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(186);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"service_role"}', true);

-- 1. Колонки fleet_vehicles: міграція не заповнює наявні рядки (перевіряємо до тестових даних).
SELECT is((SELECT count(*)::integer FROM public.fleet_vehicles
           WHERE vehicle_type IS NOT NULL OR trailer_make_model IS NOT NULL OR length_m IS NOT NULL OR width_m IS NOT NULL
              OR height_m IS NOT NULL OR tare_t IS NOT NULL OR max_mass_t IS NOT NULL OR default_driver_id IS NOT NULL), 0,
  'fleet_vehicles: existing rows keep the new columns empty');
SELECT is((SELECT count(*)::integer FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fleet_vehicles' AND is_nullable = 'YES'
             AND column_name IN ('vehicle_type', 'trailer_make_model', 'length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t', 'default_driver_id')), 8,
  'fleet_vehicles: eight new nullable columns');
SELECT is((SELECT string_agg(policyname || ':' || cmd || ':' || permissive, ',' ORDER BY policyname) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'fleet_vehicles'),
  'fleet_vehicles_delete:DELETE:PERMISSIVE,fleet_vehicles_insert:INSERT:PERMISSIVE,fleet_vehicles_not_blocked_delete:DELETE:RESTRICTIVE,fleet_vehicles_not_blocked_insert:INSERT:RESTRICTIVE,fleet_vehicles_not_blocked_update:UPDATE:RESTRICTIVE,fleet_vehicles_select:SELECT:PERMISSIVE,fleet_vehicles_update:UPDATE:PERMISSIVE',
  'fleet_vehicles: the site policies are unchanged');
SELECT ok(has_table_privilege('authenticated', 'public.fleet_vehicles', 'SELECT') AND has_table_privilege('authenticated', 'public.fleet_vehicles', 'UPDATE')
  AND has_table_privilege('authenticated', 'public.fleet_vehicles', 'INSERT') AND has_table_privilege('authenticated', 'public.fleet_vehicles', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.fleet_vehicles', 'SELECT'),
  'fleet_vehicles: the site grants are unchanged (authenticated CRUD under RLS, anon nothing)');
SELECT ok((SELECT tgenabled = 'O' FROM pg_trigger WHERE tgname = 'trg_fleet_vehicles_guard')
  AND (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.fleet_vehicles'::regclass AND NOT tgisinternal) = 'trg_fleet_vehicles_guard,trg_fleet_vehicles_guard_driver,trg_fleet_vehicles_trailer_sync',
  'fleet_vehicles: the guard trigger (still enabled), the driver-org trigger and the trailer mirror trigger (20261028110000) only');

-- T: control_plus (owner e001, logist e002, директор e009, менеджер з ремонтів e005); U: control_plus (owner e008);
-- V: тариф «Компанія» (owner e007).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('90000000-0000-0000-0000-00000000000a', 'TT plan', 'team'),
       ('90000000-0000-0000-0000-00000000000b', 'TT other', 'solo'),
       ('90000000-0000-0000-0000-00000000000c', 'TT company', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'tt-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'TT ' || k), now(), now()
FROM unnest(ARRAY['e001', 'e002', 'e005', 'e007', 'e008', 'e009']) AS k;

UPDATE public.profiles
SET org_id = CASE id
               WHEN '00000000-0000-0000-0000-00000000e008' THEN '90000000-0000-0000-0000-00000000000b'::uuid
               WHEN '00000000-0000-0000-0000-00000000e007' THEN '90000000-0000-0000-0000-00000000000c'::uuid
               ELSE '90000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000e002' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000e007',
             '00000000-0000-0000-0000-00000000e008');

SELECT public.set_org_plan('90000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('90000000-0000-0000-0000-00000000000b', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('90000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000e009');
INSERT INTO public.org_repair_handlers (org_id, user_id, kind)
VALUES ('90000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000e005', 'repair_manager');

INSERT INTO public.clients (id, org_id, name, legal_name, legal_form, edrpou, legal_address, archived_at)
VALUES ('91000000-0000-0000-0000-000000000011', '90000000-0000-0000-0000-00000000000a', 'Агро', 'ТОВ «Агро Тест»', 'tov', '34567812', 'с. Тестове, вул. Польова, 1', NULL),
       ('91000000-0000-0000-0000-000000000012', '90000000-0000-0000-0000-00000000000a', 'Інший', 'ФОП Ґава Їжак', 'fop', NULL, NULL, NULL),
       ('91000000-0000-0000-0000-000000000013', '90000000-0000-0000-0000-00000000000a', 'Архів', NULL, NULL, NULL, NULL, now()),
       ('91000000-0000-0000-0000-000000000021', '90000000-0000-0000-0000-00000000000b', 'Клієнт U', NULL, NULL, NULL, NULL, NULL);

INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, trip_date)
VALUES ('92000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000e002',
        'Тестове — Одеса', '{"origin":"с. Тестове","destination":"м. Одеса, порт"}'::jsonb, '{}'::jsonb, 'accepted', DATE '2026-10-20'),
       ('92000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000e002',
        'Рейс іншого клієнта', '{"origin":"м. Біла Церква","destination":"м. Умань"}'::jsonb, '{}'::jsonb, 'accepted', DATE '2026-10-21'),
       ('92000000-0000-0000-0000-000000000021', '90000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000e008',
        'Чужий рейс', '{"origin":"A","destination":"B"}'::jsonb, '{}'::jsonb, 'accepted', DATE '2026-10-20');
INSERT INTO public.calculation_clients (calculation_id, client_id)
VALUES ('92000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000011'),
       ('92000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000012'),
       ('92000000-0000-0000-0000-000000000021', '91000000-0000-0000-0000-000000000021');

INSERT INTO public.fleet_vehicles (id, org_id, label, make_model, trailer_plate, trailer_type, oscpv_on)
VALUES ('93000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-00000000000a', 'AA1111TT', 'DAF XF 480', 'AA2222XT', 'зерновоз', DATE '2027-01-10'),
       ('93000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-00000000000a', 'AA3333TT', 'Volvo FH', NULL, 'тент', NULL),
       ('93000000-0000-0000-0000-000000000021', '90000000-0000-0000-0000-00000000000b', 'BB0000UU', 'MAN TGX', NULL, 'тент', NULL);
INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage)
VALUES ('92000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 24.09),
       ('92000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000002', 24.09);

CREATE TEMP TABLE t_tt (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_tt TO PUBLIC;
CREATE TEMP TABLE t_tt_j (k text PRIMARY KEY, j jsonb);
GRANT ALL ON t_tt_j TO PUBLIC;
CREATE TEMP TABLE t_tt_pre (p jsonb);
CREATE TEMP TABLE t_tt_snap (d jsonb);
GRANT ALL ON t_tt_pre, t_tt_snap TO PUBLIC;
INSERT INTO t_tt_j VALUES
  ('req', '{"legal_name":"ТОВ «Тест Логістик»","legal_form":"tov","edrpou":"12345670","vat_payer":false,
            "iban":"UA213223130000026007233566001","legal_address":"м. Біла Церква, вул. Тестова, 5","doc_place":"м. Біла Церква",
            "signer_name":"Коваль Ганна","signer_position":"Директор","ttn_prefix":"ТТН-"}'),
  ('reqU', '{"legal_name":"ФОП Тест Ю","legal_form":"fop","ipn":"2345678901","vat_payer":false}'),
  ('base', '{"place_of_issue":"м. Біла Церква",
             "shipper":{"name":"ТОВ «Агро Тест»","code":"34567812","address":"с. Тестове"},
             "consignee":{"name":"ТОВ «Порт Тест»","code":"45678123"},
             "driver":{"full_name":"Мельник Олег Іванович","license_no":"ВХА123456"},
             "vehicle":{"make_model":"DAF XF 480","type":"Тягач сідловий","reg_number":"aa1111tt",
                        "trailer_make_model":"Schmitz SKO","trailer_type":"Напівпричіп-зерновоз","trailer_reg_number":"AA2222XT",
                        "length_m":16.5,"width_m":2.55,"height_m":4},
             "tare_t":15.75,"max_mass_t":40,"cargo_net_t":24.09,"cargo_gross_t":24.09,
             "load_point":"с. Тестове, Київська обл.","unload_point":"м. Одеса, порт",
             "lines":[{"cargo_name":"Пшениця 3 клас","unit":"т","owner_price":true,"packaging":"Насипом","gross_t":24.09,"bulk":true}],
             "operations":[{"op":"load","gross_t":39.84,"tare_t":15.75,"net_t":24.09,"arrival":"08:00","departure":"09:30","idle":"0 год 30 хв"},{"op":"unload"}]}'),
  ('min', '{"place_of_issue":"м. Київ","shipper":{"name":"Відправник","code":"1234567890"},"consignee":{"name":"Одержувач","code":"АБ123456"},
            "driver":{"full_name":"Водій","license_no":"ABC000001"},"vehicle":{"make_model":"MAN","type":"Вантажний","reg_number":"AA0000AA",
            "length_m":"10","width_m":"2,5","height_m":"3"},"tare_t":"8","cargo_gross_t":"5,5","load_point":"Київ","unload_point":"Житомир",
            "lines":[{"cargo_name":"Палети"}]}');

CREATE OR REPLACE FUNCTION pg_temp.tt_msg(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$f$;
CREATE OR REPLACE FUNCTION pg_temp.tt_id(p_k text) RETURNS uuid LANGUAGE sql AS $f$ SELECT t.id FROM t_tt AS t WHERE t.k = p_k $f$;
CREATE OR REPLACE FUNCTION pg_temp.tt_j(p_k text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT t.j FROM t_tt_j AS t WHERE t.k = p_k $f$;
-- Створення з базових даних без поля (шлях) — повідомлення помилки.
CREATE OR REPLACE FUNCTION pg_temp.tt_without(p_path text[]) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.tt_msg(format('SELECT public.kp_ttn_create(%L, DATE %L, NULL, %L::jsonb)',
    '91000000-0000-0000-0000-000000000011', '2026-10-20', (pg_temp.tt_j('base') #- p_path)::text))
$f$;
CREATE OR REPLACE FUNCTION pg_temp.tt_with(p_patch jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.tt_msg(format('SELECT public.kp_ttn_create(%L, DATE %L, NULL, %L::jsonb)',
    '91000000-0000-0000-0000-000000000011', '2026-10-20', (pg_temp.tt_j('base') || p_patch)::text))
$f$;
CREATE OR REPLACE FUNCTION pg_temp.tt_new(p_k text, p_date date, p_number integer, p_data jsonb, p_calc uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  v uuid;
BEGIN
  v := public.kp_ttn_create('91000000-0000-0000-0000-000000000011', p_date, p_number, p_data, p_calc);
  INSERT INTO t_tt VALUES (p_k, v);
  RETURN (public.kp_ttn_get(v) ->> 'number')::integer;
END
$f$;
CREATE OR REPLACE FUNCTION pg_temp.tt_rows(q text) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  n integer;
BEGIN
  EXECUTE q;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.tt_rows(text), pg_temp.tt_msg(text), pg_temp.tt_id(text), pg_temp.tt_j(text), pg_temp.tt_without(text[]), pg_temp.tt_with(jsonb),
  pg_temp.tt_new(text, date, integer, jsonb, uuid) TO PUBLIC;

-- 2. Права: anon нічого; таблиці без прямого доступу; внутрішні хелпери закриті.
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.kp_ttn_list(DATE '2026-01-01', DATE '2026-12-31')$$, '42501', NULL, 'anon cannot call kp_ttn_list');
SELECT throws_ok($$SELECT * FROM public.kp_vehicles_list()$$, '42501', NULL, 'anon cannot call kp_vehicles_list');
SELECT throws_ok($$SELECT * FROM public.kp_driver_list(true)$$, '42501', NULL, 'anon cannot call kp_driver_list');
SELECT throws_ok($$SELECT count(*) FROM public.kp_doc_ttn$$, '42501', NULL, 'anon cannot read kp_doc_ttn');
SELECT throws_ok($$SELECT count(*) FROM public.kp_drivers$$, '42501', NULL, 'anon cannot read kp_drivers');
RESET ROLE;
SELECT ok(NOT has_function_privilege('authenticated', 'public.kp_ttn_alloc_number(uuid, integer, integer)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.kp_ttn_alloc_number(uuid, integer, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_ttn_text(text, integer, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_ttn_num(text, numeric, numeric, integer, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_ttn_party(jsonb, text, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_ttn_party(jsonb, text, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_doc_ttn_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_doc_ttn_lines_guard()', 'EXECUTE'),
  'internal helpers and trigger functions are closed to every API role');
SELECT ok(has_function_privilege('authenticated', 'public.kp_ttn_create(uuid, date, integer, jsonb, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_ttn_create(uuid, date, integer, jsonb, uuid, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_vehicle_save(uuid, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_vehicle_save(uuid, jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_ttn_prefill(uuid, uuid, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_ttn_cancel(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_driver_save(uuid, text, text, boolean)', 'EXECUTE'),
  'client RPCs: authenticated yes, anon no');
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM pg_class AS c
           WHERE c.oid IN ('public.kp_drivers'::regclass, 'public.kp_doc_ttn'::regclass, 'public.kp_doc_ttn_lines'::regclass)),
  'RLS is enabled on every new table');
SELECT ok(NOT has_table_privilege('authenticated', 'public.kp_doc_ttn', 'SELECT') AND NOT has_table_privilege('anon', 'public.kp_doc_ttn', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.kp_doc_ttn_lines', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.kp_drivers', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.kp_drivers', 'SELECT'),
  'no table grants to clients (reads and writes only through the functions)');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO public.kp_doc_ttn (org_id) VALUES ('90000000-0000-0000-0000-00000000000a')$$, '42501', NULL, 'owner: no direct INSERT into kp_doc_ttn');
SELECT throws_ok($$UPDATE public.kp_doc_ttn SET status = 'cancelled'$$, '42501', NULL, 'owner: no direct UPDATE of kp_doc_ttn');
SELECT throws_ok($$DELETE FROM public.kp_doc_ttn$$, '42501', NULL, 'owner: no direct DELETE of kp_doc_ttn');
SELECT throws_ok($$DELETE FROM public.kp_doc_ttn_lines$$, '42501', NULL, 'owner: no direct DELETE of lines');
SELECT throws_ok($$INSERT INTO public.kp_drivers (org_id, full_name) VALUES ('90000000-0000-0000-0000-00000000000a', 'X')$$, '42501', NULL, 'owner: no direct INSERT into kp_drivers');
SELECT throws_ok($$SELECT public.kp_ttn_alloc_number('90000000-0000-0000-0000-00000000000a', 2026, NULL)$$, '42501', NULL, 'owner: kp_ttn_alloc_number is internal');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e005","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT * FROM public.kp_ttn_list(DATE '2026-01-01', DATE '2026-12-31')$$), 'KP_FORBIDDEN', 'repair manager: kp_ttn_list — KP_FORBIDDEN');
SELECT is(pg_temp.tt_msg($$SELECT * FROM public.kp_vehicles_list()$$), 'KP_FORBIDDEN', 'repair manager: kp_vehicles_list — KP_FORBIDDEN');
SELECT is(pg_temp.tt_msg($$SELECT * FROM public.kp_driver_list(true)$$), 'KP_FORBIDDEN', 'repair manager: kp_driver_list — KP_FORBIDDEN');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_driver_save(NULL, 'X', NULL, true)$$), 'KP_FORBIDDEN', 'repair manager: kp_driver_save — KP_FORBIDDEN');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', '{"tare_t":1}')$$), 'KP_FORBIDDEN', 'repair manager: kp_vehicle_save — KP_FORBIDDEN');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-20', NULL, pg_temp.tt_j('base'))$$), 'KP_FORBIDDEN',
  'repair manager: kp_ttn_create — KP_FORBIDDEN');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_prefill(NULL, '91000000-0000-0000-0000-000000000011')$$), 'KP_FORBIDDEN', 'repair manager: kp_ttn_prefill — KP_FORBIDDEN');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e007","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT * FROM public.kp_ttn_list(DATE '2026-01-01', DATE '2026-12-31')$$), 'CONTROL_PLUS_REQUIRED', 'company plan: CONTROL_PLUS_REQUIRED');

-- 3. Водії: пишуть owner / logist, директор лише читає, чужа організація не бачить; деактивація замість видалення.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
INSERT INTO t_tt VALUES ('drv1', public.kp_driver_save(NULL, '  Мельник   Олег Іванович ', 'вха 123456', true));
INSERT INTO t_tt VALUES ('drv2', public.kp_driver_save(NULL, 'Ткачук Ігор', NULL, true));
SELECT is((SELECT full_name || '|' || license_no FROM public.kp_driver_list(true) WHERE id = pg_temp.tt_id('drv1')), 'Мельник Олег Іванович|ВХА123456',
  'logist adds a driver (spaces collapsed, licence normalized)');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_driver_save(NULL, '   ', NULL, true)$$), 'DRIVER_BAD_NAME', 'driver without a name refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_driver_save(NULL, 'X', repeat('1', 31), true)$$), 'DRIVER_BAD_LICENSE', 'licence longer than 30 refused');
SELECT is(pg_temp.tt_msg(format('SELECT public.kp_driver_save(NULL, %L, NULL, true)', 'Ім' || chr(7) || 'я')), 'DRIVER_BAD_NAME', 'control characters in the name refused');
SELECT lives_ok($$SELECT public.kp_driver_save(pg_temp.tt_id('drv2'), 'Ткачук Ігор', 'АВС000002', false)$$, 'logist deactivates a driver');
SELECT is((SELECT count(*)::integer FROM public.kp_driver_list(true)), 1, 'active-only list hides the deactivated driver');
SELECT is((SELECT count(*)::integer FROM public.kp_driver_list(false)), 2, 'full list keeps the deactivated driver');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e009","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_driver_list(false)), 2, 'director reads the drivers');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_driver_save(NULL, 'Директорський', NULL, true)$$), 'KP_FORBIDDEN', 'director cannot add drivers');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e008","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_driver_list(false)), 0, 'another org does not see the drivers');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_driver_save(pg_temp.tt_id('drv1'), 'Чужий', NULL, true)$$), 'DRIVER_NOT_FOUND', 'another org cannot change a driver');
INSERT INTO t_tt VALUES ('drvU', public.kp_driver_save(NULL, 'Водій Ю', 'UUU000001', true));

-- 4. Поля ТЗ: CHECK-и, запис сайту напряму (власник, RLS), kp_vehicle_save для owner / logist лише нових колонок.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SELECT throws_ok($$UPDATE public.fleet_vehicles SET length_m = 0 WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: length 0 refused');
SELECT throws_ok($$UPDATE public.fleet_vehicles SET width_m = -1 WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: negative width refused');
SELECT throws_ok($$UPDATE public.fleet_vehicles SET height_m = 30.01 WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: height above 30 m refused');
SELECT throws_ok($$UPDATE public.fleet_vehicles SET max_mass_t = 100.5 WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: maximum mass above 100 t refused');
SELECT throws_ok($$UPDATE public.fleet_vehicles SET tare_t = 0 WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: tare 0 refused');
SELECT throws_ok($$UPDATE public.fleet_vehicles SET tare_t = 40, max_mass_t = 40 WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: tare equal to the maximum mass refused');
SELECT throws_ok($$UPDATE public.fleet_vehicles SET vehicle_type = repeat('т', 101) WHERE id = '93000000-0000-0000-0000-000000000002'$$, '23514', NULL, 'CHECK: vehicle type longer than 100 refused');
SELECT throws_ok(format('UPDATE public.fleet_vehicles SET trailer_make_model = %L WHERE id = %L', 'Schmitz' || chr(9), '93000000-0000-0000-0000-000000000002'), '23514', NULL,
  'CHECK: control characters in the trailer make refused');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET vehicle_type = 'Тягач сідловий', length_m = 16.5, width_m = 2.55, height_m = 4, tare_t = 7.5, max_mass_t = 40
  WHERE id = '93000000-0000-0000-0000-000000000002'$$), 'ok', 'site: the owner writes the new columns directly (RLS)');
SELECT is((SELECT vehicle_type || '|' || length_m || '|' || tare_t FROM public.fleet_vehicles WHERE id = '93000000-0000-0000-0000-000000000002'), 'Тягач сідловий|16.50|7.500',
  'site: the new columns are saved');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
SELECT is(pg_temp.tt_rows($$UPDATE public.fleet_vehicles SET tare_t = 1 WHERE id = '93000000-0000-0000-0000-000000000001'$$), 0,
  'site: a logist still cannot write fleet_vehicles directly (site RLS unchanged)');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001',
  jsonb_build_object('vehicle_type', 'Тягач сідловий', 'trailer_make_model', 'Schmitz SKO', 'length_m', '16,5', 'width_m', 2.55, 'height_m', 4,
                     'tare_t', 15.75, 'max_mass_t', 40, 'default_driver_id', pg_temp.tt_id('drv1'), 'label', 'ЗЛАМ', 'oscpv_on', '2020-01-01'))$$), 'ok',
  'logist saves the waybill fields through kp_vehicle_save');
SELECT is((SELECT label || '|' || oscpv_on || '|' || vehicle_type || '|' || length_m || '|' || tare_t || '|' || max_mass_t || '|' || (default_driver_id = pg_temp.tt_id('drv1'))
           FROM public.fleet_vehicles WHERE id = '93000000-0000-0000-0000-000000000001'),
  'AA1111TT|2027-01-10|Тягач сідловий|16.50|15.750|40.000|true', 'kp_vehicle_save changes only the new columns (label and dates untouched)');
SELECT ok(pg_get_functiondef('public.kp_vehicle_save(uuid, jsonb)'::regprocedure) !~ '(set_config|service_role|request.jwt)',
  'kp_vehicle_save does not touch JWT claims (no service_role substitution)');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', '{"max_mass_t":15}')$$), 'VEHICLE_FIELD_INVALID:tare_t',
  'kp_vehicle_save: tare not below the maximum mass refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', '{"length_m":31}')$$), 'VEHICLE_FIELD_INVALID:length_m',
  'kp_vehicle_save: length above 30 m refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', '{"tare_t":"abc"}')$$), 'VEHICLE_FIELD_INVALID:tare_t',
  'kp_vehicle_save: not a number refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', jsonb_build_object('default_driver_id', pg_temp.tt_id('drvU')))$$),
  'VEHICLE_DRIVER_FORBIDDEN', 'kp_vehicle_save: default driver from another org refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000021', '{"tare_t":5}')$$), 'VEHICLE_NOT_FOUND',
  'kp_vehicle_save: another org vehicle — VEHICLE_NOT_FOUND');
SELECT ok(current_setting('request.jwt.claims') LIKE '%e002%', 'claims stay the caller''s after a refused save');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e009","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', '{"tare_t":5}')$$), 'KP_FORBIDDEN', 'director cannot save vehicles');
SELECT is((SELECT label || '|' || default_driver_name || '|' || oscpv_on FROM public.kp_vehicles_list() WHERE id = '93000000-0000-0000-0000-000000000001'),
  'AA1111TT|Мельник Олег Іванович|2027-01-10', 'director reads vehicles with the waybill fields, driver and document dates');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e008","role":"authenticated"}', true);
SELECT is((SELECT string_agg(label, ',') FROM public.kp_vehicles_list()), 'BB0000UU', 'another org sees only its own vehicles');

-- 4a. fleet_vehicles_guard: логіст — лише ТТН-колонки авто своєї компанії; усе інше — як раніше лише власник / service_role.
-- Запис без RLS (як із SECURITY DEFINER-функції): перевіряє саме guard.
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET tare_t = 15.8, length_m = 16.6, width_m = 2.5, height_m = 4.1, max_mass_t = 41,
  vehicle_type = 'Тягач', trailer_make_model = 'Krone', default_driver_id = NULL WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'ok',
  'guard: a logist may change all eight TTN columns of an own vehicle');
SELECT is((SELECT tare_t || '|' || vehicle_type || '|' || coalesce(default_driver_id::text, '-') FROM public.fleet_vehicles WHERE id = '93000000-0000-0000-0000-000000000001'),
  '15.800|Тягач|-', 'guard: the TTN columns are saved');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET label = 'ЗЛАМ' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot change label');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET make_model = 'Інша' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot change make_model');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET oscpv_on = DATE '2020-01-01' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot change document dates');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET tare_t = 16, trailer_plate = 'XX0000XX' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'FLEET_FORBIDDEN',
  'guard: a TTN column together with another column is refused');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET org_id = '90000000-0000-0000-0000-00000000000b' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot move a vehicle to another org');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET tare_t = 5 WHERE id = '93000000-0000-0000-0000-000000000021'$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot change another company''s vehicle');
SELECT is(pg_temp.tt_msg($$INSERT INTO public.fleet_vehicles (org_id, label, tare_t) VALUES ('90000000-0000-0000-0000-00000000000a', 'NEW1', 5)$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot add vehicles');
SELECT is(pg_temp.tt_msg($$DELETE FROM public.fleet_vehicles WHERE id = '93000000-0000-0000-0000-000000000002'$$), 'FLEET_FORBIDDEN',
  'guard: a logist cannot delete vehicles');
-- Директор і менеджер з ремонтів чужої організації (у тестовій базі кожен — власник своєї) не бачать авто під RLS сайту.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e009","role":"authenticated"}', true);
SELECT is(pg_temp.tt_rows($$UPDATE public.fleet_vehicles SET tare_t = 16 WHERE id = '93000000-0000-0000-0000-000000000001'$$), 0,
  'site: a director cannot change even the TTN columns (RLS; kp_vehicle_save — KP_FORBIDDEN)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e005","role":"authenticated"}', true);
SELECT is(pg_temp.tt_rows($$UPDATE public.fleet_vehicles SET tare_t = 16 WHERE id = '93000000-0000-0000-0000-000000000001'$$), 0,
  'site: a repair manager cannot change the TTN columns (RLS)');
-- Власник — як раніше: будь-які колонки своїх авто.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET label = 'AA1111TT', make_model = 'DAF XF 480', oscpv_on = DATE '2027-01-10', tare_t = 15.75, max_mass_t = 40,
  length_m = 16.5, width_m = 2.55, height_m = 4, vehicle_type = 'Тягач сідловий', trailer_make_model = 'Schmitz SKO', default_driver_id = '$$
  || pg_temp.tt_id('drv1') || $$' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'ok', 'owner: any column of an own vehicle, as before');
SELECT is(pg_temp.tt_rows($$UPDATE public.fleet_vehicles SET tare_t = 5 WHERE id = '93000000-0000-0000-0000-000000000021'$$), 0,
  'owner: another company''s vehicle stays invisible to the update (RLS)');

-- 4b. Водій за замовчуванням — лише своєї компанії (тригер, і для запису сайту, і для service_role).
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET default_driver_id = '$$ || pg_temp.tt_id('drvU') || $$' WHERE id = '93000000-0000-0000-0000-000000000002'$$),
  'VEHICLE_DRIVER_FORBIDDEN', 'site: owner cannot set a driver of another company');
SELECT is(pg_temp.tt_msg($$INSERT INTO public.fleet_vehicles (org_id, label, default_driver_id) VALUES ('90000000-0000-0000-0000-00000000000a', 'NEW2', '$$
  || pg_temp.tt_id('drvU') || $$')$$), 'VEHICLE_DRIVER_FORBIDDEN', 'site: a new vehicle with a driver of another company refused');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET default_driver_id = '$$ || pg_temp.tt_id('drv2') || $$' WHERE id = '93000000-0000-0000-0000-000000000002'$$),
  'ok', 'site: owner sets an own driver (even an inactive one)');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET default_driver_id = '$$ || pg_temp.tt_id('drvU') || $$' WHERE id = '93000000-0000-0000-0000-000000000001'$$),
  'VEHICLE_DRIVER_FORBIDDEN', 'service_role: a driver of another company refused too');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET label = 'AA1111TT' WHERE id = '93000000-0000-0000-0000-000000000001'$$), 'ok',
  'service_role: other columns as before (driver trigger only on default_driver_id)');
SELECT is(pg_temp.tt_msg($$UPDATE public.fleet_vehicles SET default_driver_id = NULL WHERE id = '93000000-0000-0000-0000-000000000002'$$), 'ok',
  'clearing the default driver is fine');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e008","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

-- 5. Реквізити й підказки.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-20', NULL, pg_temp.tt_j('base'))$$),
  'REQUISITES_REQUIRED', 'create without company requisites — REQUISITES_REQUIRED');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_requisites_save(pg_temp.tt_j('req'))$$, 'owner saves requisites');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e008","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_requisites_save(pg_temp.tt_j('reqU'))$$, 'owner U saves requisites');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
INSERT INTO t_tt_pre SELECT public.kp_ttn_prefill('92000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000011') AS p;
SELECT is((SELECT (p -> 'customer' ->> 'name') || '|' || (p -> 'customer' ->> 'code') FROM t_tt_pre), 'ТОВ «Агро Тест»|34567812', 'prefill: client → customer (payer)');
SELECT ok((SELECT NOT (p ? 'shipper') AND NOT (p ? 'consignee') AND p -> 'party_options' -> 'client' ->> 'code' = '34567812'
                  AND p -> 'party_options' -> 'ours' ->> 'code' = '12345670' FROM t_tt_pre),
  'prefill: shipper and consignee empty, only the «client» / «our company» options');
SELECT is((SELECT p -> 'carrier' ->> 'name' FROM t_tt_pre), 'ТОВ «Тест Логістик»', 'prefill: the carrier is always our company');
SELECT is((SELECT concat_ws('|', p -> 'vehicle' ->> 'reg_number', p -> 'vehicle' ->> 'make_model', p -> 'vehicle' ->> 'type', p -> 'vehicle' ->> 'trailer_reg_number',
                  p -> 'vehicle' ->> 'trailer_make_model', p -> 'vehicle' ->> 'length_m', p ->> 'tare_t', p ->> 'max_mass_t') FROM t_tt_pre),
  'AA1111TT|DAF XF 480|Тягач сідловий|AA2222XT|Schmitz SKO|16.50|15.750|40.000', 'prefill: vehicle of the trip with dimensions, tare and maximum mass');
SELECT is((SELECT concat_ws('|', p -> 'driver' ->> 'full_name', p -> 'driver' ->> 'license_no', p ->> 'load_point', p ->> 'unload_point', p ->> 'cargo_net_t',
                  jsonb_array_length(p -> 'vehicles'), p ->> 'place_of_issue', p ->> 'next_number') FROM t_tt_pre),
  'Мельник Олег Іванович|ВХА123456|с. Тестове|м. Одеса, порт|24.090|2|м. Біла Церква|1', 'prefill: default driver, route points, vehicle tonnage as net, place, next number');
SELECT is((SELECT public.kp_ttn_prefill('92000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000002')
           -> 'vehicle' ->> 'reg_number'), 'AA3333TT', 'prefill: the second vehicle of the trip on request');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_prefill('92000000-0000-0000-0000-000000000021', '91000000-0000-0000-0000-000000000011')$$), 'DOC_TRIP_FORBIDDEN',
  'prefill: another org trip refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_prefill('92000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000011')$$), 'DOC_TRIP_FORBIDDEN',
  'prefill: a trip of another client refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_prefill(NULL, '91000000-0000-0000-0000-000000000021')$$), 'CLIENT_NOT_FOUND', 'prefill: another org client refused');

-- 6. Обовʼязкові реквізити ст. 48 — кожен окремо; необовʼязкові порожні — ОК.
SELECT is(pg_temp.tt_without('{place_of_issue}'), 'TTN_FIELD_REQUIRED:place_of_issue', 'required: place of issue');
SELECT is(pg_temp.tt_without('{shipper,name}'), 'TTN_FIELD_REQUIRED:shipper.name', 'required: shipper name');
SELECT is(pg_temp.tt_without('{shipper,code}'), 'TTN_FIELD_REQUIRED:shipper.code', 'required: shipper code');
SELECT is(pg_temp.tt_without('{shipper}'), 'TTN_FIELD_REQUIRED:shipper.name', 'required: shipper itself');
SELECT is(pg_temp.tt_without('{consignee,name}'), 'TTN_FIELD_REQUIRED:consignee.name', 'required: consignee name');
SELECT is(pg_temp.tt_without('{consignee,code}'), 'TTN_FIELD_REQUIRED:consignee.code', 'required: consignee code');
SELECT is(pg_temp.tt_without('{driver,full_name}'), 'TTN_FIELD_REQUIRED:driver.full_name', 'required: driver name');
SELECT is(pg_temp.tt_without('{driver,license_no}'), 'TTN_FIELD_REQUIRED:driver.license_no', 'required: driver licence');
SELECT is(pg_temp.tt_without('{vehicle,make_model}'), 'TTN_FIELD_REQUIRED:vehicle.make_model', 'required: vehicle make and model');
SELECT is(pg_temp.tt_without('{vehicle,type}'), 'TTN_FIELD_REQUIRED:vehicle.type', 'required: vehicle type');
SELECT is(pg_temp.tt_without('{vehicle,reg_number}'), 'TTN_FIELD_REQUIRED:vehicle.reg_number', 'required: vehicle registration number');
SELECT is(pg_temp.tt_without('{vehicle,trailer_make_model}'), 'TTN_FIELD_REQUIRED:vehicle.trailer_make_model', 'required: trailer make when there is a trailer');
SELECT is(pg_temp.tt_without('{vehicle,trailer_type}'), 'TTN_FIELD_REQUIRED:vehicle.trailer_type', 'required: trailer type when there is a trailer');
SELECT is(pg_temp.tt_without('{vehicle,trailer_reg_number}'), 'TTN_FIELD_REQUIRED:vehicle.trailer_reg_number', 'required: trailer number when there is a trailer');
SELECT is(pg_temp.tt_without('{vehicle,length_m}'), 'TTN_FIELD_REQUIRED:vehicle.length_m', 'required: length');
SELECT is(pg_temp.tt_without('{vehicle,width_m}'), 'TTN_FIELD_REQUIRED:vehicle.width_m', 'required: width');
SELECT is(pg_temp.tt_without('{vehicle,height_m}'), 'TTN_FIELD_REQUIRED:vehicle.height_m', 'required: height');
SELECT is(pg_temp.tt_without('{tare_t}'), 'TTN_FIELD_REQUIRED:tare_t', 'required: tare (total mass with cargo)');
SELECT is(pg_temp.tt_without('{cargo_gross_t}'), 'TTN_FIELD_REQUIRED:cargo_gross_t', 'required: gross mass of the cargo');
SELECT is(pg_temp.tt_without('{load_point}'), 'TTN_FIELD_REQUIRED:load_point', 'required: loading point');
SELECT is(pg_temp.tt_without('{unload_point}'), 'TTN_FIELD_REQUIRED:unload_point', 'required: unloading point');
SELECT is(pg_temp.tt_with('{"shipper":{"name":"X","code":"1234"}}'), 'TTN_FIELD_INVALID:shipper.code', 'shipper code of 4 digits refused');
SELECT is(pg_temp.tt_with('{"cargo_gross_t":0}'), 'TTN_FIELD_INVALID:cargo_gross_t', 'cargo mass 0 refused');
SELECT is(pg_temp.tt_with('{"cargo_gross_t":-1}'), 'TTN_FIELD_INVALID:cargo_gross_t', 'negative cargo mass refused');
SELECT is(pg_temp.tt_with('{"tare_t":0}'), 'TTN_FIELD_INVALID:tare_t', 'tare 0 refused');
SELECT is(pg_temp.tt_with(jsonb_build_object('vehicle', pg_temp.tt_j('base') -> 'vehicle' || '{"length_m":30.5}')), 'TTN_FIELD_INVALID:vehicle.length_m', 'length above 30 m refused');
SELECT is(pg_temp.tt_with(jsonb_build_object('vehicle', pg_temp.tt_j('base') -> 'vehicle' || '{"height_m":0}')), 'TTN_FIELD_INVALID:vehicle.height_m', 'height 0 refused');
SELECT is(pg_temp.tt_with(jsonb_build_object('lines', (SELECT jsonb_agg(jsonb_build_object('cargo_name', 'В' || i)) FROM generate_series(1, 51) AS i))),
  'TTN_BAD_LINES', '51 cargo lines refused');
SELECT is(pg_temp.tt_with('{"lines":[]}'), 'TTN_BAD_LINES', 'no cargo lines refused');
SELECT is(pg_temp.tt_with('{"lines":[{"cargo_name":"А","gross_t":20}]}'), 'TTN_MASS_MISMATCH', 'gross mass in lines must add up to the cargo gross mass');
SELECT is(pg_temp.tt_with('{"cargo_net_t":30}'), 'TTN_FIELD_INVALID:cargo_net_t', 'net mass above gross refused');
SELECT is(pg_temp.tt_with(jsonb_build_object('place_of_issue', 'м. Київ' || chr(7))), 'TTN_FIELD_INVALID:place_of_issue', 'control characters refused');
SELECT is(pg_temp.tt_with('{"operations":[{"op":"load"},{"op":"load"}]}'), 'TTN_FIELD_INVALID:operations', 'two loading operations refused');
SELECT is(pg_temp.tt_with('{"lines":[{"cargo_name":"А","owner_price":true,"price":10,"gross_t":24.09}]}'), 'TTN_BAD_LINES', 'owner price together with a price refused');
SELECT is(pg_temp.tt_with('{"vat_amount":10}'), 'TTN_FIELD_INVALID:vat_amount', 'VAT without a total refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000013', DATE '2026-10-20', NULL, pg_temp.tt_j('base'))$$), 'CLIENT_ARCHIVED',
  'archived client refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', public.ua_today() + 2, NULL, pg_temp.tt_j('base'))$$), 'BAD_DATE',
  'date after tomorrow refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-20', NULL, pg_temp.tt_j('base'), '92000000-0000-0000-0000-000000000021')$$),
  'DOC_TRIP_FORBIDDEN', 'another org trip refused');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-20', NULL, pg_temp.tt_j('base'), '92000000-0000-0000-0000-000000000002')$$),
  'DOC_TRIP_FORBIDDEN', 'a trip of another client refused');
SELECT is(pg_temp.tt_with('{"vehicle_id":"93000000-0000-0000-0000-000000000021"}'), 'TTN_VEHICLE_FORBIDDEN', 'another org vehicle refused');
SELECT is(pg_temp.tt_with(jsonb_build_object('driver', jsonb_build_object('id', pg_temp.tt_id('drvU')))), 'TTN_DRIVER_FORBIDDEN', 'another org driver refused');
SELECT is((SELECT public.kp_ttn_next_number(DATE '2026-10-20')), 1, 'validation errors did not shift the counter');

-- 7. Нумерація, маса, знімок, кілька ТТН на рейс.
SELECT is(pg_temp.tt_new('t1', DATE '2026-10-20', NULL, pg_temp.tt_j('base'), '92000000-0000-0000-0000-000000000001'), 1, 'first waybill of 2026 — № 1');
SELECT is((SELECT concat_ws('|', d ->> 'number_text', d ->> 'tare_t', d ->> 'cargo_gross_t', d ->> 'total_mass_t', d -> 'vehicle' ->> 'gross_total_t',
                  d -> 'vehicle' ->> 'reg_number', d -> 'carrier' ->> 'name', d ->> 'client_name', d ->> 'status')
           FROM public.kp_ttn_get(pg_temp.tt_id('t1')) AS d),
  'ТТН-1|15.750|24.090|39.840|39.840|AA1111TT|ТОВ «Тест Логістик»|Агро|issued', 'total mass = tare + gross (15,75 + 24,09 = 39,84), carrier = our requisites');
SELECT is((SELECT concat_ws('|', d -> 'lines' -> 0 ->> 'cargo_name', d -> 'lines' -> 0 ->> 'owner_price', d -> 'lines' -> 0 ->> 'bulk', jsonb_array_length(d -> 'operations'),
                  d -> 'operations' -> 0 ->> 'gross_t', d -> 'operations' -> 1 ->> 'op') FROM public.kp_ttn_get(pg_temp.tt_id('t1')) AS d),
  'Пшениця 3 клас|true|true|2|39.840|unload', 'cargo lines and both operations are stored');
SELECT is(pg_temp.tt_new('t2', DATE '2026-10-20', NULL, pg_temp.tt_j('base'), '92000000-0000-0000-0000-000000000001'), 2, 'second waybill on the same trip allowed — № 2');
SELECT is((SELECT count(*)::integer FROM public.kp_ttn_list(DATE '2026-01-01', DATE '2026-12-31', NULL, NULL, '92000000-0000-0000-0000-000000000001')), 2,
  'two waybills of one trip in the list');
SELECT is(pg_temp.tt_new('tmin', DATE '2026-10-21', NULL, pg_temp.tt_j('min')), 3, 'optional fields empty (customer, trailer, amount, operations) — fine');
SELECT is((SELECT concat_ws('|', coalesce(d ->> 'customer', '-'), coalesce(d -> 'vehicle' ->> 'trailer_reg_number', '-'), coalesce(d ->> 'total_amount', '-'), d -> 'consignee' ->> 'code', d ->> 'cargo_gross_t', d -> 'vehicle' ->> 'width_m')
           FROM public.kp_ttn_get(pg_temp.tt_id('tmin')) AS d), '-|-|-|АБ123456|5.500|2.50', 'minimal waybill: empty optional fields, comma decimals accepted');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-21', 2, pg_temp.tt_j('min'))$$), 'DOC_NUMBER_TAKEN',
  'manual duplicate number — DOC_NUMBER_TAKEN');
SELECT is(pg_temp.tt_new('t10', DATE '2026-10-21', 10, pg_temp.tt_j('min')), 10, 'manual larger number allowed');
SELECT is(pg_temp.tt_new('t11', DATE '2026-10-21', NULL, pg_temp.tt_j('min')), 11, 'counter moved past the manual number');
SELECT is(pg_temp.tt_new('y1', DATE '2025-12-30', NULL, pg_temp.tt_j('min')), 1, '2025: own series from 1');
SELECT is(pg_temp.tt_new('y2', DATE '2025-12-31', NULL, pg_temp.tt_j('min')), 2, '2025-12-31 — № 2 of 2025');
SELECT is(pg_temp.tt_new('y3', DATE '2026-01-01', NULL, pg_temp.tt_j('min')), 12, '2026-01-01 continues the 2026 series (not 3)');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_list(NULL, DATE '2025-01-01', DATE '2026-12-31')), 0, 'no rows in kp_documents for waybills');
INSERT INTO t_tt VALUES ('inv', public.kp_doc_create('invoice', '91000000-0000-0000-0000-000000000011', DATE '2026-10-21', 'UAH', NULL,
  '[{"title":"Перевезення","qty":1,"price":100}]'));
SELECT is((public.kp_doc_get(pg_temp.tt_id('inv')) ->> 'number'), '1', 'invoice numbering is separate from waybills (invoice № 1)');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_doc_create('ttn', '91000000-0000-0000-0000-000000000011', DATE '2026-10-21', 'UAH', NULL, '[{"title":"x","qty":1,"price":1}]')$$),
  'DOC_KIND_NOT_READY', 'kp_doc_create(''ttn'') still DOC_KIND_NOT_READY (4a unchanged)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e008","role":"authenticated"}', true);
INSERT INTO t_tt VALUES ('u1', public.kp_ttn_create('91000000-0000-0000-0000-000000000021', DATE '2026-10-21', NULL, pg_temp.tt_j('min')));
SELECT is((SELECT number FROM public.kp_ttn_list(DATE '2026-01-01', DATE '2026-12-31') WHERE id = pg_temp.tt_id('u1')), 1, 'another company has its own series (№ 1)');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-21', NULL, pg_temp.tt_j('min'))$$), 'CLIENT_NOT_FOUND',
  'another org cannot use our client');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_get(pg_temp.tt_id('t1'))$$), 'DOC_NOT_FOUND', 'another org: waybill not found');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_cancel(pg_temp.tt_id('t1'), 'x')$$), 'DOC_NOT_FOUND', 'another org: cannot cancel');
SELECT is((SELECT count(*)::integer FROM public.kp_ttn_list(DATE '2025-01-01', DATE '2026-12-31')), 1, 'another org: only its own waybill in the list');

-- Знімок: зміна авто, водія й реквізитів після створення не змінює ТТН.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
INSERT INTO t_tt_snap SELECT public.kp_ttn_get(pg_temp.tt_id('t1')) AS d;
SELECT lives_ok($$SELECT public.kp_vehicle_save('93000000-0000-0000-0000-000000000001', '{"tare_t":16.2,"length_m":17}')$$, 'vehicle changed after the waybill');
SELECT lives_ok($$SELECT public.kp_driver_save(pg_temp.tt_id('drv1'), 'Мельник Олег (новий)', 'ВХА999999', true)$$, 'driver changed after the waybill');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_requisites_save(pg_temp.tt_j('req') || '{"legal_name":"ТОВ «Нова Назва»"}')$$, 'requisites changed after the waybill');
SELECT is((SELECT public.kp_ttn_get(pg_temp.tt_id('t1')) FROM t_tt_snap) - 'cancelled_by_email', (SELECT d FROM t_tt_snap) - 'cancelled_by_email',
  'snapshot: the waybill is unchanged after vehicle, driver and requisites changes');
SELECT is((SELECT public.kp_ttn_prefill(NULL, '91000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000001') ->> 'tare_t'), '16.200',
  'a new prefill takes the new tare');

-- 8. Анулювання: лише owner, причина, двічі не можна, DELETE і зміни неможливі.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_cancel(pg_temp.tt_id('t11'), 'помилка')$$), 'KP_FORBIDDEN', 'logist cannot cancel');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e009","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_cancel(pg_temp.tt_id('t11'), 'помилка')$$), 'KP_FORBIDDEN', 'director cannot cancel');
SELECT is((SELECT count(*)::integer FROM public.kp_ttn_list(DATE '2025-01-01', DATE '2026-12-31')), 8, 'director lists the waybills');
SELECT is((SELECT public.kp_ttn_get(pg_temp.tt_id('t1')) ->> 'number_text'), 'ТТН-1', 'director reads a waybill');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-21', NULL, pg_temp.tt_j('min'))$$), 'KP_FORBIDDEN',
  'director cannot create waybills');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_cancel(pg_temp.tt_id('t11'), '  ')$$), 'DOC_CANCEL_REASON', 'cancel without a reason refused');
SELECT lives_ok($$SELECT public.kp_ttn_cancel(pg_temp.tt_id('t11'), 'Помилка в масі')$$, 'owner cancels');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_cancel(pg_temp.tt_id('t11'), 'ще раз')$$), 'DOC_ALREADY_CANCELLED', 'second cancel — DOC_ALREADY_CANCELLED');
SELECT is((SELECT concat_ws('|', d ->> 'status', d ->> 'number', d ->> 'cancelled_reason') FROM public.kp_ttn_get(pg_temp.tt_id('t11')) AS d),
  'cancelled|11|Помилка в масі', 'cancelled waybill stays with its number and reason');
SELECT is(pg_temp.tt_new('t13', DATE '2026-10-22', NULL, pg_temp.tt_j('min')), 13, 'cancelled number is not reused');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT is(pg_temp.tt_msg($$DELETE FROM public.kp_doc_ttn WHERE id = pg_temp.tt_id('t1')$$), 'DOC_DELETE_FORBIDDEN', 'even service_role cannot DELETE a waybill');
SELECT is(pg_temp.tt_msg($$UPDATE public.kp_doc_ttn SET cargo_gross_t = 1, total_mass_t = 16.75 WHERE id = pg_temp.tt_id('t1')$$), 'DOC_IMMUTABLE', 'issued waybill data is immutable');
SELECT is(pg_temp.tt_msg($$UPDATE public.kp_doc_ttn SET status = 'issued', cancelled_at = NULL WHERE id = pg_temp.tt_id('t11')$$), 'DOC_IMMUTABLE', 'cancelled waybill cannot be restored');
SELECT is(pg_temp.tt_msg($$UPDATE public.kp_doc_ttn_lines SET cargo_name = 'Інше' WHERE ttn_id = pg_temp.tt_id('t1')$$), 'DOC_IMMUTABLE', 'cargo lines are immutable');
SELECT is(pg_temp.tt_msg($$DELETE FROM public.kp_doc_ttn_lines WHERE ttn_id = pg_temp.tt_id('t1')$$), 'DOC_DELETE_FORBIDDEN', 'cargo lines cannot be deleted');
SELECT is(pg_temp.tt_msg($$UPDATE public.kp_doc_ttn SET calculation_id = '92000000-0000-0000-0000-000000000002' WHERE id = pg_temp.tt_id('t1')$$), 'DOC_IMMUTABLE',
  'the trip link cannot be moved to another trip');
SELECT lives_ok($$DELETE FROM public.fleet_vehicles WHERE id = '93000000-0000-0000-0000-000000000002'$$, 'site: deleting a vehicle still works');
SELECT lives_ok($$DELETE FROM public.calc_vehicles WHERE calc_id = '92000000-0000-0000-0000-000000000001'$$, 'site: trip vehicles removed');
SELECT lives_ok($$DELETE FROM public.calculations WHERE id = '92000000-0000-0000-0000-000000000001'$$, 'site: deleting a trip with waybills still works');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_ttn WHERE id IN (pg_temp.tt_id('t1'), pg_temp.tt_id('t2')) AND calculation_id IS NULL), 2,
  'waybills stay, the trip link becomes empty');

-- 9. Підпис і печатка перевізника — знімок ТТН, як у 4a.
INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '90000000-0000-0000-0000-00000000000a/signature.png');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.kp_requisites_save(pg_temp.tt_j('req') || '{"signature_path":"90000000-0000-0000-0000-00000000000a/signature.png"}')$$, 'owner sets a signature');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-22', NULL, pg_temp.tt_j('min'))$$), 'DOC_ASSETS_NOT_COPIED',
  'signature in requisites but no snapshot — DOC_ASSETS_NOT_COPIED');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '90000000-0000-0000-0000-00000000000a/docs/94000000-0000-4000-8000-000000000001/signature.png');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_tt VALUES ('sig', public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-22', NULL, pg_temp.tt_j('min'), NULL,
  '94000000-0000-4000-8000-000000000001'));
SELECT is((SELECT public.kp_ttn_get(pg_temp.tt_id('sig')) -> 'carrier' ->> 'signature_path'),
  '90000000-0000-0000-0000-00000000000a/docs/94000000-0000-4000-8000-000000000001/signature.png', 'the carrier signature is the waybill snapshot');
SELECT is(pg_temp.tt_msg($$SELECT public.kp_ttn_create('91000000-0000-0000-0000-000000000011', DATE '2026-10-22', NULL, pg_temp.tt_j('min'), NULL,
  '94000000-0000-4000-8000-000000000001')$$), 'DOC_ID_TAKEN', 'the same id twice — DOC_ID_TAKEN');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
