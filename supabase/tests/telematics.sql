-- «Власний парк», етап 2 (*_telematics.sql): джерела, денні звіти, заправки / зливи, зіставлення техніки, RLS, прапорець own_fleet.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(56);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d6f00a1","role":"service_role"}', true);

-- A: control_plus + own_fleet (owner a1, logist a2, director a3, requester a4); B: control_plus БЕЗ прапорця (owner b1); C: інша компанія з прапорцем (owner c1).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('6f000000-0000-0000-0000-00000000000a', 'TM A', 'team'),
       ('6f000000-0000-0000-0000-00000000000b', 'TM B', 'solo'),
       ('6f000000-0000-0000-0000-00000000000c', 'TM C', 'solo');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d6f00' || k)::uuid, 'authenticated', 'authenticated',
       'tm-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'TM ' || k), now(), now()
FROM unnest(ARRAY['a1', 'a2', 'a3', 'a4', 'b1', 'c1']) AS k;
UPDATE public.profiles
SET org_id = CASE WHEN id = '00000000-0000-0000-0000-00000d6f00b1' THEN '6f000000-0000-0000-0000-00000000000b'::uuid
                  WHEN id = '00000000-0000-0000-0000-00000d6f00c1' THEN '6f000000-0000-0000-0000-00000000000c'::uuid
                  ELSE '6f000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000d6f00a2' THEN 'logist' ELSE 'owner' END, member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000d6f00a1', '00000000-0000-0000-0000-00000d6f00a2', '00000000-0000-0000-0000-00000d6f00b1', '00000000-0000-0000-0000-00000d6f00c1');
SELECT public.set_org_plan('6f000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('6f000000-0000-0000-0000-00000000000b', 'control_plus');
SELECT public.set_org_plan('6f000000-0000-0000-0000-00000000000c', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('6f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d6f00a3');
INSERT INTO public.app_settings (key, enabled) VALUES ('own_fleet', true) ON CONFLICT (key) DO UPDATE SET enabled = true;
UPDATE public.organizations SET features = '{"own_fleet": true}'
WHERE id IN ('6f000000-0000-0000-0000-00000000000a', '6f000000-0000-0000-0000-00000000000c');
INSERT INTO public.org_requesters (org_id, user_id) VALUES ('6f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d6f00a4');

INSERT INTO public.org_units (id, org_id, name, kind) VALUES
  ('6f100000-0000-0000-0000-000000000001', '6f000000-0000-0000-0000-00000000000a', 'Північ', 'agro'),
  ('6f100000-0000-0000-0000-00000000000c', '6f000000-0000-0000-0000-00000000000c', 'Чужий', 'agro');
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES
  ('6f300000-0000-0000-0000-000000000001', '6f000000-0000-0000-0000-00000000000a', 'AA 1234 BB'),
  ('6f300000-0000-0000-0000-000000000002', '6f000000-0000-0000-0000-00000000000a', 'KE 5555 AX'),
  ('6f300000-0000-0000-0000-00000000000c', '6f000000-0000-0000-0000-00000000000c', 'CC 7777 CC');

CREATE FUNCTION pg_temp.tm_err(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.tm_err(text) TO PUBLIC;
CREATE FUNCTION pg_temp.tm_as(k text) RETURNS void LANGUAGE sql AS
  $f$ SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d6f00' || k || '","role":"authenticated"}', true) $f$;
-- Скільки з усіх tm_* RPC відмовили з 42501 для поточного користувача.
CREATE FUNCTION pg_temp.tm_denied() RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  n integer := 0;
  q text;
BEGIN
  FOREACH q IN ARRAY ARRAY[
    'SELECT public.tm_ensure_source(''file_import'')',
    'SELECT public.tm_import_reports(''6f400000-0000-0000-0000-000000000001'', ''[]'')',
    'SELECT public.tm_import_fuel_events(''6f400000-0000-0000-0000-000000000001'', ''[]'')',
    'SELECT public.tm_set_vehicle_map(''AA1'', NULL)',
    'SELECT public.tm_set_vehicle_unit(''6f300000-0000-0000-0000-000000000001'', NULL)',
    'SELECT public.tm_save_template(''reports'', ''{}'')',
    'SELECT * FROM public.tm_summary(''2026-01-01'', ''2026-12-31'')'] LOOP
    BEGIN
      EXECUTE q;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      n := n + 1;
    END;
  END LOOP;
  RETURN n;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.tm_denied() TO PUBLIC;

-- 1. Нормалізація держномера (кирилиця / латиниця, пробіли, дефіси).
SELECT is(public.telematics_norm_plate('аа 1234 вв'), 'AA1234BB', 'кирилиця → латиниця, регістр і пробіли');
SELECT is(public.telematics_norm_plate('KE-5555‐AX'), 'KE5555AX', 'дефіси відкидаються');
SELECT is(public.telematics_norm_plate('АВЕІКМНОРСТХ'), 'ABEIKMHOPCTX', 'усі дванадцять літер');
SELECT is(public.telematics_norm_plate(NULL), '', 'NULL → порожньо');

-- 2. Імпорт звітів: додано / оновлено / пропущено / незмеплено.
SELECT pg_temp.tm_as('a1');
CREATE TEMP TABLE tm_src AS SELECT public.tm_ensure_source('file_import') AS id;
GRANT ALL ON tm_src TO PUBLIC;
SELECT ok((SELECT id FROM tm_src) IS NOT NULL, 'owner створює джерело file_import');
SELECT is(public.tm_ensure_source('file_import'), (SELECT id FROM tm_src), 'повторне створення джерела віддає те саме');
SELECT is(pg_temp.tm_err($$SELECT public.tm_ensure_source('agrocontrol_x')$$), '22023 TELEMATICS_INVALID_KIND', 'невідомий вид джерела відхилено');
SELECT is(public.tm_import_reports((SELECT id FROM tm_src), $j$[
  {"date":"2026-05-01","ref":"AA 1234 BB","mileage_km":"120.5","fuel_used_l":"40","idle_minutes":"90","engine_hours":"6.5"},
  {"date":"2026-05-02","ref":"аа-1234-вв","mileage_km":"80","fuel_used_l":"30","idle_minutes":"30"},
  {"date":"2026-05-01","ref":"КЕ 5555 АХ","mileage_km":"200","fuel_used_l":"70"},
  {"date":"2026-05-01","ref":"ZZ 0000 ZZ","mileage_km":"10","fuel_used_l":"4"},
  {"date":"31.12.2026","ref":"AA 1234 BB","mileage_km":"1"},
  {"date":"2026-05-03","ref":"","mileage_km":"1"},
  {"date":"2026-05-03","ref":"AA 1234 BB","mileage_km":"-5"},
  "рядок"]$j$::jsonb)::text,
  '{"added": 5, "skipped": 3, "updated": 0, "unmapped": 1}', 'додано 5 (кирилиця теж), пропущено 3 (дата, порожній номер, не об''єкт), незмеплено 1; «-5» лишає порожній пробіг, не псує рядок');
SELECT is((SELECT count(*)::integer FROM public.telematics_reports WHERE external_vehicle_ref = 'AA1234BB'), 3, 'дві написання одного номера — один ключ');
SELECT is((SELECT vehicle_id FROM public.telematics_reports WHERE external_vehicle_ref = 'KE5555AX'), '6f300000-0000-0000-0000-000000000002'::uuid, 'кириличний номер зіставлено з авто за нормалізованим держномером');
SELECT is((SELECT count(*)::integer FROM public.telematics_reports WHERE vehicle_id IS NULL), 1, 'ZZ 0000 ZZ без авто');

-- 3. Повторний імпорт оновлює, а не дублює.
SELECT is(public.tm_import_reports((SELECT id FROM tm_src), $j$[
  {"date":"2026-05-01","ref":"AA 1234 BB","mileage_km":"130","fuel_used_l":"42","idle_minutes":"60"},
  {"date":"2026-05-01","ref":"AA 1234 BB","mileage_km":"131","fuel_used_l":"43","idle_minutes":"61"},
  {"date":"2026-05-04","ref":"AA 1234 BB","mileage_km":"50"}]$j$::jsonb)::text,
  '{"added": 1, "skipped": 1, "updated": 1, "unmapped": 0}', 'повтор: дубль у файлі пропущено (лишається останній), існуючий оновлено, новий додано');
SELECT is((SELECT count(*)::integer FROM public.telematics_reports), 6, 'усього 6 рядків, без дублів');
SELECT is((SELECT mileage_km FROM public.telematics_reports WHERE external_vehicle_ref = 'AA1234BB' AND date = '2026-05-01'), 131.0, 'значення оновилось');
SELECT is(pg_temp.tm_err($$SELECT public.tm_import_reports('6f400000-0000-0000-0000-000000000009', '[]')$$), 'P0002 TELEMATICS_SOURCE_NOT_FOUND', 'чуже / відсутнє джерело');
SELECT is(pg_temp.tm_err($$SELECT public.tm_import_reports((SELECT id FROM tm_src), '{}')$$), '22023 TELEMATICS_INVALID_ROWS', 'не масив');

-- 4. Заправки / зливи.
SELECT is(public.tm_import_fuel_events((SELECT id FROM tm_src), $j$[
  {"ts":"2026-05-02T10:15:00Z","ref":"AA 1234 BB","kind":"drain","liters":"45.5","location":"Поле 12"},
  {"ts":"2026-05-02 08:00","ref":"AA 1234 BB","kind":"refuel","liters":"200"},
  {"ts":"2026-05-03T11:00:00Z","ref":"KE 5555 AX","kind":"drain","liters":"30"},
  {"ts":"2026-05-03T11:00:00Z","ref":"KE 5555 AX","kind":"steal","liters":"30"},
  {"ts":"2026-05-03T11:00:00Z","ref":"KE 5555 AX","kind":"drain","liters":"0"}]$j$::jsonb)::text,
  '{"added": 3, "skipped": 2, "updated": 0, "unmapped": 0}', 'події: додано 3, пропущено 2 (невідомий вид, 0 літрів)');
SELECT is(public.tm_import_fuel_events((SELECT id FROM tm_src), '[{"ts":"2026-05-02T10:15:00Z","ref":"аа 1234 вв","kind":"drain","liters":"46"}]')::text,
  '{"added": 0, "skipped": 0, "updated": 1, "unmapped": 0}', 'повторний імпорт події оновлює');
SELECT is((SELECT count(*)::integer FROM public.telematics_fuel_events), 3, 'події не дублюються');

-- 5. Зведення.
SELECT is((SELECT mileage_km FROM public.tm_summary('2026-05-01', '2026-05-31') WHERE ref = 'AA1234BB'), 261.0, 'пробіг AA1234BB за період (131 + 80 + 50)');
SELECT is((SELECT drain_count FROM public.tm_summary('2026-05-01', '2026-05-31') WHERE ref = 'AA1234BB'), 1, 'один злив');
SELECT is((SELECT drain_l FROM public.tm_summary('2026-05-01', '2026-05-31') WHERE ref = 'AA1234BB'), 46.0, 'злив 46 л');
SELECT is((SELECT count(*)::integer FROM public.tm_summary('2026-05-02', '2026-05-02')), 1, 'за 2 травня — лише AA1234BB (KE5555AX має подію 3 травня)');

-- 6. Ручне зіставлення.
SELECT is(public.tm_set_vehicle_map('zz-0000-zz', '6f300000-0000-0000-0000-000000000001'), 1, 'ручне зіставлення оновлює вже імпортовані рядки');
SELECT is((SELECT vehicle_id FROM public.telematics_reports WHERE external_vehicle_ref = 'ZZ0000ZZ'), '6f300000-0000-0000-0000-000000000001'::uuid, 'ZZ0000ZZ тепер на авто AA 1234 BB');
SELECT is(public.tm_set_vehicle_map('ZZ0000ZZ', NULL), 1, 'зняття зіставлення');
SELECT is((SELECT vehicle_id FROM public.telematics_reports WHERE external_vehicle_ref = 'ZZ0000ZZ'), NULL, 'знову без авто');
SELECT is(pg_temp.tm_err($$SELECT public.tm_set_vehicle_map('ZZ0000ZZ', '6f300000-0000-0000-0000-00000000000c')$$), 'P0002 TELEMATICS_VEHICLE_NOT_FOUND', 'авто чужої компанії не приймається');
SELECT is(pg_temp.tm_err($$SELECT public.tm_set_vehicle_map('---', NULL)$$), '22023 TELEMATICS_INVALID_REF', 'порожня позначка');

-- 7. Підрозділи авто й фільтри зведення.
SELECT lives_ok($$SELECT public.tm_set_vehicle_unit('6f300000-0000-0000-0000-000000000001', '6f100000-0000-0000-0000-000000000001')$$, 'авто → підрозділ');
SELECT is(pg_temp.tm_err($$SELECT public.tm_set_vehicle_unit('6f300000-0000-0000-0000-000000000001', '6f100000-0000-0000-0000-00000000000c')$$), 'P0002 TELEMATICS_UNIT_NOT_FOUND', 'чужий підрозділ відхилено');
SELECT is((SELECT count(*)::integer FROM public.tm_summary('2026-05-01', '2026-05-31', '6f100000-0000-0000-0000-000000000001')), 1, 'фільтр підрозділу: лише авто підрозділу');
SELECT is((SELECT count(*)::integer FROM public.tm_summary('2026-05-01', '2026-05-31', NULL, '6f300000-0000-0000-0000-000000000002')), 1, 'фільтр авто');

-- 8. Шаблон мапінгу.
SELECT lives_ok($$SELECT public.tm_save_template('reports', '{"date":"Дата","ref":"Держномер"}')$$, 'шаблон збережено');
SELECT lives_ok($$SELECT public.tm_save_template('reports', '{"date":"Дата1","ref":"Держномер"}')$$, 'шаблон оновлено (upsert)');
SELECT is((SELECT count(*)::integer FROM public.telematics_templates), 1, 'шаблон один на (організація, вид)');
SELECT is(pg_temp.tm_err($$SELECT public.tm_save_template('other', '{}')$$), '22023 TELEMATICS_INVALID_TEMPLATE', 'невідомий вид шаблону');

-- 9. Хто що бачить (RLS), прямий запис закритий.
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_reports), 6, 'owner A бачить звіти');
SELECT throws_ok($$INSERT INTO public.telematics_reports (org_id, source_id, external_vehicle_ref, date) VALUES ('6f000000-0000-0000-0000-00000000000a', (SELECT id FROM tm_src), 'X', '2026-05-01')$$, '42501', NULL, 'прямий INSERT закрито');
SELECT throws_ok($$UPDATE public.telematics_reports SET mileage_km = 1$$, '42501', NULL, 'прямий UPDATE закрито');
SELECT throws_ok($$DELETE FROM public.telematics_sources$$, '42501', NULL, 'прямий DELETE закрито');
RESET ROLE;
SELECT pg_temp.tm_as('a2');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_reports), 6, 'логіст бачить звіти');
RESET ROLE;
SELECT pg_temp.tm_as('a3');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_fuel_events), 3, 'менеджер (director) бачить події');
RESET ROLE;
SELECT pg_temp.tm_as('a4');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_reports) + (SELECT count(*)::integer FROM public.telematics_sources) + (SELECT count(*)::integer FROM public.telematics_fuel_events)
  + (SELECT count(*)::integer FROM public.telematics_templates), 0, 'замовник підрозділу не бачить нічого');
RESET ROLE;
SELECT is(pg_temp.tm_denied(), 7, 'замовник підрозділу: усі сім tm_* RPC → 42501');
SELECT pg_temp.tm_as('b1');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_reports), 0, 'компанія без own_fleet нічого не бачить');
RESET ROLE;
SELECT is(pg_temp.tm_denied(), 7, 'компанія без own_fleet: усі сім tm_* RPC → 42501');
SELECT pg_temp.tm_as('c1');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_reports) + (SELECT count(*)::integer FROM public.telematics_fuel_events), 0, 'чужа організація не бачить даних A');
RESET ROLE;
SELECT is(pg_temp.tm_err($$SELECT public.tm_import_reports((SELECT id FROM tm_src), '[]')$$), 'P0002 TELEMATICS_SOURCE_NOT_FOUND', 'чужа організація не імпортує в джерело A');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.tm_ensure_source('file_import')$$, '42501', NULL, 'anon: tm_ensure_source');
SELECT throws_ok($$SELECT * FROM public.telematics_reports$$, '42501', NULL, 'anon не читає звіти');
RESET ROLE;

-- 10. Глобальний вимикач і прапорець організації знімають доступ.
SELECT pg_temp.tm_as('a1');
UPDATE public.app_settings SET enabled = false WHERE key = 'own_fleet';
SELECT is(pg_temp.tm_denied(), 7, 'глобально вимкнено own_fleet: усі сім tm_* RPC → 42501');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.telematics_reports), 0, 'глобально вимкнено: звітів не видно');
RESET ROLE;
UPDATE public.app_settings SET enabled = true WHERE key = 'own_fleet';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d6f00a1","role":"service_role"}', true);
UPDATE public.organizations SET features = '{}' WHERE id = '6f000000-0000-0000-0000-00000000000a';
SELECT pg_temp.tm_as('a1');
SELECT is(pg_temp.tm_denied(), 7, 'прапорець організації знято: усі сім tm_* RPC → 42501');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d6f00a1","role":"service_role"}', true);
UPDATE public.organizations SET features = '{"own_fleet": true}' WHERE id = '6f000000-0000-0000-0000-00000000000a';

-- 11. У таблиці джерел немає місця для токена: api_secret_name — лише ім'я змінної.
SELECT is(left(pg_temp.tm_err($$UPDATE public.telematics_sources SET api_secret_name = 'my secret token 123'$$), 5), '23514', 'api_secret_name приймає лише ім''я змінної середовища');
SELECT is((SELECT count(*)::integer FROM information_schema.columns WHERE table_name = 'telematics_sources' AND column_name ~* '(token|password|key$)'), 0, 'у telematics_sources немає колонок token / password / key');

SELECT * FROM finish();
ROLLBACK;
