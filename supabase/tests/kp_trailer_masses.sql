-- Контроль+: тара й макс. маса причепа (*_trailer_tare_masses.sql) і маса автопоїзда в ТТН: тара = авто + причіп, макс. маса = авто + причіп,
-- загальна маса = тара автопоїзда + брутто вантажу (рахує сервер, суми numeric — без float). Усі дані вигадані.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(31);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e301","role":"service_role"}', true);

-- Фікстури: компанія X (власник e301, логіст e302), чужа компанія Y (власник e303).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('94000000-0000-0000-0000-00000000000a', 'TM X', 'team'),
       ('94000000-0000-0000-0000-00000000000b', 'TM Y', 'solo');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'tm-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'TM ' || k), now(), now()
FROM unnest(ARRAY['e301', 'e302', 'e303']) AS k;
UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000e303' THEN '94000000-0000-0000-0000-00000000000b'::uuid ELSE '94000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000e302' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000e301', '00000000-0000-0000-0000-00000000e302', '00000000-0000-0000-0000-00000000e303');
SELECT public.set_org_plan('94000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('94000000-0000-0000-0000-00000000000b', 'control_plus');

INSERT INTO public.clients (id, org_id, name, legal_name, legal_form, edrpou, legal_address)
VALUES ('95000000-0000-0000-0000-000000000011', '94000000-0000-0000-0000-00000000000a', 'Агро', 'ТОВ «Агро Тест»', 'tov', '34567812', 'с. Тестове, вул. Польова, 1');

-- Авто: V1 з причепом (маси причепа додамо), V2 без причепа, V3 з причепом без мас, V4 для перевірки float (0,1 + 0,2).
INSERT INTO public.fleet_vehicles (id, org_id, label, make_model, vehicle_type, length_m, width_m, height_m, tare_t, max_mass_t, trailer_plate, trailer_type, trailer_make_model)
VALUES ('96000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-00000000000a', 'MA1111TT', 'DAF XF 480', 'Тягач сідловий', 16.5, 2.55, 4, 6.7, 17.2, 'MA2222XT', 'зерновоз', 'Schmitz SKO'),
       ('96000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-00000000000a', 'MA3333TT', 'Volvo FH', 'Вантажний', 10, 2.5, 3.5, 8, 18, NULL, 'тент', NULL),
       ('96000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-00000000000a', 'MA4444TT', 'MAN TGX', 'Тягач сідловий', 16.5, 2.55, 4, 6.5, 16, 'MA5555XT', 'зерновоз', 'Krone'),
       ('96000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-00000000000a', 'MA6666TT', 'Iveco', 'Тягач сідловий', 16.5, 2.55, 4, 0.1, 1, 'MA7777XT', 'зерновоз', 'Wielton');

CREATE TEMP TABLE t_tm_j (k text PRIMARY KEY, j jsonb);
GRANT ALL ON t_tm_j TO PUBLIC;
INSERT INTO t_tm_j VALUES
  ('req', '{"legal_name":"ТОВ «Тест Логістик»","legal_form":"tov","edrpou":"12345670","vat_payer":false,
            "iban":"UA213223130000026007233566001","legal_address":"м. Біла Церква, вул. Тестова, 5","doc_place":"м. Біла Церква",
            "signer_name":"Коваль Ганна","signer_position":"Директор","ttn_prefix":"ТТН-"}'),
  -- Базова ТТН без tare_t / max_mass_t: масу має підставити сервер із карток авто й причепа.
  ('base', '{"place_of_issue":"м. Біла Церква",
            "shipper":{"name":"ТОВ «Агро Тест»","code":"34567812","address":"с. Тестове"},
            "consignee":{"name":"ТОВ «Порт Тест»","code":"45678123"},
            "driver":{"full_name":"Мельник Олег Іванович","license_no":"ВХА123456"},
            "vehicle":{"make_model":"DAF XF 480","type":"Тягач сідловий","reg_number":"MA1111TT",
                       "trailer_make_model":"Schmitz SKO","trailer_type":"Напівпричіп-зерновоз","trailer_reg_number":"MA2222XT",
                       "length_m":16.5,"width_m":2.55,"height_m":4},
            "cargo_net_t":24.09,"cargo_gross_t":24.09,
            "load_point":"с. Тестове","unload_point":"м. Одеса, порт",
            "lines":[{"cargo_name":"Пшениця 3 клас","unit":"т","owner_price":true,"packaging":"Насипом","gross_t":24.09,"bulk":true}]}');

CREATE OR REPLACE FUNCTION pg_temp.tm_msg(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$f$;
-- Створення ТТН: базові дані + патч; повертає id.
CREATE OR REPLACE FUNCTION pg_temp.tm_create(p_patch jsonb) RETURNS uuid LANGUAGE sql AS $f$
  SELECT public.kp_ttn_create('95000000-0000-0000-0000-000000000011', DATE '2026-10-20', NULL, (SELECT j FROM t_tm_j WHERE k = 'base') || p_patch)
$f$;
CREATE OR REPLACE FUNCTION pg_temp.tm_masses(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT concat_ws('|', (d ->> 'tare_t')::numeric, (d ->> 'total_mass_t')::numeric, (d ->> 'max_mass_t')::numeric)
  FROM (SELECT public.kp_ttn_get(p_id) AS d) AS x
$f$;
CREATE TEMP TABLE t_tm (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_tm TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.tm_msg(text), pg_temp.tm_create(jsonb), pg_temp.tm_masses(uuid) TO PUBLIC;

-- 1. Колонки й CHECK-и (виконує сервіс).
SELECT is((SELECT count(*)::integer FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fleet_trailers' AND is_nullable = 'YES' AND column_name IN ('tare_t', 'max_mass_t')
             AND numeric_precision = 8 AND numeric_scale = 3), 2, 'fleet_trailers: tare_t and max_mass_t are nullable numeric(8,3)');
SELECT is((SELECT count(*)::integer FROM public.fleet_trailers WHERE tare_t IS NOT NULL OR max_mass_t IS NOT NULL), 0, 'existing trailers keep the new columns empty');
SELECT is(pg_temp.tm_msg($$UPDATE public.fleet_trailers SET tare_t = 0 WHERE plate = 'MA2222XT'$$) ~ 'fleet_trailers_tare_t_check', true, 'CHECK: tare 0 refused');
SELECT is(pg_temp.tm_msg($$UPDATE public.fleet_trailers SET tare_t = -1 WHERE plate = 'MA2222XT'$$) ~ 'fleet_trailers_tare_t_check', true, 'CHECK: negative tare refused');
SELECT is(pg_temp.tm_msg($$UPDATE public.fleet_trailers SET max_mass_t = 0 WHERE plate = 'MA2222XT'$$) ~ 'fleet_trailers_max_mass_t_check', true, 'CHECK: max mass 0 refused');
SELECT is(pg_temp.tm_msg($$UPDATE public.fleet_trailers SET max_mass_t = 101 WHERE plate = 'MA2222XT'$$) ~ 'fleet_trailers_max_mass_t_check', true, 'CHECK: max mass over 100 t refused');
SELECT is(pg_temp.tm_msg($$UPDATE public.fleet_trailers SET tare_t = 9, max_mass_t = 8 WHERE plate = 'MA2222XT'$$) ~ 'fleet_trailers_mass_order_check', true, 'CHECK: max mass below the tare refused');
SELECT is(pg_temp.tm_msg($$UPDATE public.fleet_trailers SET tare_t = 8, max_mass_t = 8 WHERE plate = 'MA2222XT'$$), 'ok', 'CHECK: max mass equal to the tare is allowed');
UPDATE public.fleet_trailers SET tare_t = NULL, max_mass_t = NULL WHERE plate = 'MA2222XT';

-- 2. kp_trailer_save: логіст (право «Автопарк») і власник; чужа компанія — ні; ключа немає — значення лишається.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e302","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.tm_msg(format($$SELECT public.kp_trailer_save(%L, '{"tare_t":"7,3","max_mass_t":"22.8"}'::jsonb)$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))), 'ok', 'logist saves tare and max mass of the trailer');
SELECT is((SELECT tare_t::text || '|' || max_mass_t::text FROM public.fleet_trailers WHERE plate = 'MA2222XT'), '7.300|22.800', 'saved with three decimals');
SELECT is(pg_temp.tm_msg(format($$SELECT public.kp_trailer_save(%L, '{"make_model":"Schmitz SKO 24"}'::jsonb)$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))), 'ok', 'saving other fields...');
SELECT is((SELECT tare_t::text || '|' || max_mass_t::text FROM public.fleet_trailers WHERE plate = 'MA2222XT'), '7.300|22.800', '...keeps the masses (no key — value stays)');
SELECT is(pg_temp.tm_msg(format($$SELECT public.kp_trailer_save(%L, '{"tare_t":"23"}'::jsonb)$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))), 'TRAILER_FIELD_INVALID:max_mass_t', 'tare above the stored max mass — TRAILER_FIELD_INVALID:max_mass_t');
SELECT is(pg_temp.tm_msg(format($$SELECT public.kp_trailer_save(%L, '{"tare_t":"0"}'::jsonb)$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))) ~ 'TRAILER_FIELD_INVALID|tare_t', true, 'tare 0 refused by the function');
SELECT is(pg_temp.tm_msg(format($$SELECT public.kp_trailer_save(%L, '{"tare_t":null}'::jsonb)$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))), 'ok', 'null clears the tare');
SELECT public.kp_trailer_save((SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'), '{"tare_t":"7.3"}'::jsonb);
SELECT is(pg_temp.tm_msg(format($$UPDATE public.fleet_trailers SET plate = 'ZZ0000ZZ' WHERE id = %L$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))) ~ 'FLEET_FORBIDDEN', true, 'the logist still cannot change the plate');
SELECT is((SELECT tare_t::text || '|' || max_mass_t::text FROM public.kp_trailers_list() WHERE plate = 'MA2222XT'), '7.300|22.800', 'kp_trailers_list returns tare_t and max_mass_t');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e303","role":"authenticated"}', true);
SELECT is(pg_temp.tm_msg(format($$SELECT public.kp_trailer_save(%L, '{"tare_t":"1"}'::jsonb)$$, (SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'))), 'TRAILER_NOT_FOUND', 'another company cannot save the masses');
SET LOCAL ROLE anon;
SELECT is(pg_temp.tm_msg($$SELECT * FROM public.kp_trailers_list()$$) ~ 'permission denied', true, 'anon cannot call kp_trailers_list');
RESET ROLE;

-- Маси інших причепів: V3 — причіп без мас у картці; V4 — для float.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e301","role":"service_role"}', true);
UPDATE public.fleet_trailers SET tare_t = 0.2, max_mass_t = 1 WHERE plate = 'MA7777XT';

-- 3. kp_ttn_prefill: авто + причіп.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e301","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_tm_j WHERE k = 'req'))$$, 'owner saves requisites');
SELECT is((SELECT concat_ws('|', p ->> 'tare_t', p ->> 'max_mass_t', p ->> 'trailer_tare_t', p ->> 'trailer_masses_missing')
           FROM (SELECT public.kp_ttn_prefill(NULL, '95000000-0000-0000-0000-000000000011', '96000000-0000-0000-0000-000000000001') AS p) AS x),
  '14.000|40.000|7.300|false', 'prefill: tare and max mass of the road train = vehicle + trailer');
SELECT is((SELECT concat_ws('|', p ->> 'tare_t', p ->> 'max_mass_t', p ->> 'trailer_masses_missing')
           FROM (SELECT public.kp_ttn_prefill(NULL, '95000000-0000-0000-0000-000000000011', '96000000-0000-0000-0000-000000000003') AS p) AS x),
  '6.500|16.000|true', 'prefill: a trailer without masses is not added (vehicle only) and is flagged');
SELECT is((SELECT concat_ws('|', p ->> 'tare_t', p ->> 'max_mass_t', p ->> 'trailer_masses_missing')
           FROM (SELECT public.kp_ttn_prefill(NULL, '95000000-0000-0000-0000-000000000011', '96000000-0000-0000-0000-000000000002') AS p) AS x),
  '8.000|18.000|false', 'prefill: without a trailer — the vehicle only');

-- 4. kp_ttn_create: маса з карток, сума на сервері.
INSERT INTO t_tm VALUES ('train', pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000001"}'::jsonb));
SELECT is(pg_temp.tm_masses((SELECT id FROM t_tm WHERE k = 'train')), '14.000|38.090|40.000', 'create: tare = 6.7 + 7.3, total = tare + gross 24.09, max = 17.2 + 22.8');
INSERT INTO t_tm VALUES ('float', pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000004","cargo_gross_t":0.1,"cargo_net_t":0.1,"vehicle":{"make_model":"Iveco","type":"Тягач сідловий","reg_number":"MA6666TT","trailer_make_model":"Wielton","trailer_type":"Напівпричіп","trailer_reg_number":"MA7777XT","length_m":16,"width_m":2.5,"height_m":4},"lines":[{"cargo_name":"Палети","gross_t":0.1}]}'::jsonb));
SELECT is(pg_temp.tm_masses((SELECT id FROM t_tm WHERE k = 'float')), '0.300|0.400|2.000', 'create: 0.1 + 0.2 = 0.3 exactly, total 0.4 (no float drift)');
INSERT INTO t_tm VALUES ('solo', pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000002","vehicle":{"make_model":"Volvo FH","type":"Вантажний","reg_number":"MA3333TT","length_m":10,"width_m":2.5,"height_m":3.5}}'::jsonb));
SELECT is(pg_temp.tm_masses((SELECT id FROM t_tm WHERE k = 'solo')), '8.000|32.090|18.000', 'create: without a trailer — the vehicle only (8 + 24.09)');
INSERT INTO t_tm VALUES ('explicit', pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000001","tare_t":15.75,"max_mass_t":38}'::jsonb));
SELECT is(pg_temp.tm_masses((SELECT id FROM t_tm WHERE k = 'explicit')), '15.750|39.840|38.000', 'create: values corrected in the form win over the cards');
SELECT is(pg_temp.tm_msg($$SELECT pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000003","vehicle":{"make_model":"MAN TGX","type":"Тягач сідловий","reg_number":"MA4444TT","trailer_make_model":"Krone","trailer_type":"Напівпричіп","trailer_reg_number":"MA5555XT","length_m":16,"width_m":2.5,"height_m":4}}'::jsonb)$$),
  'TTN_FIELD_REQUIRED:tare_t', 'create: the trailer is chosen but its card has no masses — the tare must be entered (no half sum)');
SELECT is(pg_temp.tm_msg($$SELECT pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000003","tare_t":6.5,"vehicle":{"make_model":"MAN TGX","type":"Тягач сідловий","reg_number":"MA4444TT","trailer_make_model":"Krone","trailer_type":"Напівпричіп","trailer_reg_number":"MA5555XT","length_m":16,"width_m":2.5,"height_m":4}}'::jsonb)$$),
  'ok', 'create: the user may still enter the tare by hand');

-- 5. Існуючі ТТН не перераховуються: після зміни маси причепа знімок старої ТТН лишається.
SELECT public.kp_trailer_save((SELECT id FROM public.fleet_trailers WHERE plate = 'MA2222XT'), '{"tare_t":"9"}'::jsonb);
SELECT is(pg_temp.tm_masses((SELECT id FROM t_tm WHERE k = 'train')), '14.000|38.090|40.000', 'a TTN created earlier keeps its masses after the trailer card changes');
INSERT INTO t_tm VALUES ('after', pg_temp.tm_create('{"vehicle_id":"96000000-0000-0000-0000-000000000001"}'::jsonb));
SELECT is(pg_temp.tm_masses((SELECT id FROM t_tm WHERE k = 'after')), '15.700|39.790|40.000', 'a new TTN takes the new trailer tare (6.7 + 9)');

SELECT * FROM finish();
ROLLBACK;
