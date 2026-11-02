-- Подорожній лист, повний первинний документ (*_kp_trip_sheet_full.sql): відмітки лицьового боку, етапи зворотного боку, закриття.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim. Усі дані — вигадані.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(54);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f201","role":"service_role"}', true);

-- X: control_plus (owner f201, logist f202, директор f203); Y: control_plus (owner f204).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('c1000000-0000-4000-8000-00000000000a', 'TF plan', 'team'),
       ('c1000000-0000-4000-8000-00000000000b', 'TF other', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'tf-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'TF ' || k), now(), now()
FROM unnest(ARRAY['f201', 'f202', 'f203', 'f204']) AS k;

UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000f204' THEN 'c1000000-0000-4000-8000-00000000000b'::uuid
                     ELSE 'c1000000-0000-4000-8000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000f202' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000f202', '00000000-0000-0000-0000-00000000f204');

SELECT public.set_org_plan('c1000000-0000-4000-8000-00000000000a', 'control_plus');
SELECT public.set_org_plan('c1000000-0000-4000-8000-00000000000b', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('c1000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000f203');
INSERT INTO public.kp_org_requisites (org_id, legal_name, edrpou)
VALUES ('c1000000-0000-4000-8000-00000000000a', 'ТОВ Перевізник TF', '12345678'),
       ('c1000000-0000-4000-8000-00000000000b', 'ТОВ Інший TF', '87654321');

CREATE TEMP TABLE t_tf (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_tf TO PUBLIC;

-- 1. Схема й права.
SELECT is((SELECT count(*)::integer FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'kp_doc_trip_sheet'
           AND column_name IN ('medical_ok', 'medical_post_by', 'medical_post_at', 'medical_post_ok', 'mech_return_by', 'mech_return_at', 'mech_return_accepted', 'dispatcher_name')),
  8, 'kp_doc_trip_sheet: eight new mark columns');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.kp_trip_sheet_stages'::regclass)
  AND has_table_privilege('authenticated', 'public.kp_trip_sheet_stages', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.kp_trip_sheet_stages', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.kp_trip_sheet_stages', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.kp_trip_sheet_stages', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.kp_trip_sheet_stages', 'SELECT'),
  'stages: RLS on, authenticated only reads, anon nothing');
SELECT ok(NOT has_function_privilege('anon', 'public.kp_trip_sheet_extra_save(uuid, jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_trip_sheet_extra_save(uuid, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_ts_time(text, text)', 'EXECUTE'),
  'extra_save: authenticated yes, anon no; the helpers are closed');
SELECT is((SELECT string_agg(policyname, ',') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kp_trip_sheet_stages'), 'kp_trip_sheet_stages_select', 'stages: one select policy');

-- 2. Лист (старий формат: без нових відміток і без етапів).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f201","role":"authenticated"}', true);
INSERT INTO t_tf
SELECT 'old', public.kp_trip_sheet_create('2026-10-28', NULL, $j${
  "valid_from":"2026-10-28","valid_to":"2026-10-30",
  "driver":{"full_name":"Тестовий Водій","license_no":"AB123456"},
  "vehicle":{"make_model":"DAF XF","reg_number":"AA1234TF","fuel_load":"30","fuel_empty":"20"},
  "task":{"customer":"Агро","route_from":"Луцьк","route_to":"Одеса","cargo":"Пшениця","tonnage":"22","loaded_km":"300"},
  "depart":{"at":"2026-10-28T06:00:00+03:00","odometer":"100000","fuel_left":"80","fuel_issued":"200","fuel_kind":"ДП"}}$j$::jsonb);
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'status'), 'issued', 'old format: the sheet opens');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) -> 'stages'), '[]'::jsonb, 'old format: no stages, empty array');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) #>> '{totals,trips}'), '0', 'old format: totals with zero trips');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'medical_post_by'), NULL, 'old format: the new marks are empty');

-- 3. Закриття без повернення відмовляє на сервері.
SELECT throws_ok($$SELECT public.kp_trip_sheet_close((SELECT id FROM t_tf WHERE k = 'old'), '{}')$$, 'P0001', 'TS_FIELD_REQUIRED:return_at', 'close: refused without the return date and time');
SELECT throws_ok($$SELECT public.kp_trip_sheet_close((SELECT id FROM t_tf WHERE k = 'old'), '{"return_at":"2026-10-29T20:00:00+03:00"}')$$, 'P0001', 'TS_FIELD_REQUIRED:return_odometer', 'close: refused without the return odometer');
SELECT throws_ok($$SELECT public.kp_trip_sheet_close((SELECT id FROM t_tf WHERE k = 'old'), '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100500"}')$$, 'P0001', 'TS_FIELD_REQUIRED:return_fuel_left', 'close: refused without the return fuel');
SELECT throws_ok($$SELECT public.kp_trip_sheet_close((SELECT id FROM t_tf WHERE k = 'old'), '{"return_at":"2026-10-27T20:00:00+03:00","return_odometer":"100500","return_fuel_left":"50"}')$$, 'P0001', 'TS_RETURN_BEFORE_DEPART', 'close: return before departure refused');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'status'), 'issued', 'close: a refused close leaves the sheet issued');

-- 4. Відмітки лицьового боку.
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{
  "medical_by":"Медик Іваненко","medical_at":"2026-10-28T05:30:00+03:00","medical_ok":true,
  "tech_by":"Механік Петренко","tech_at":"2026-10-28T05:40:00+03:00","tech_ok":true,
  "dispatcher_name":"Диспетчер Сидоренко"}')$$, 'marks: the logist-side marks before the trip are saved');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'medical_ok')::boolean, true, 'marks: medical_ok is saved');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'dispatcher_name'), 'Диспетчер Сидоренко', 'marks: dispatcher is saved');
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{
  "medical_post_by":"Медик Коваль","medical_post_at":"2026-10-29T20:30:00+03:00","medical_post_ok":true,
  "mech_return_by":"Механік Мельник","mech_return_at":"2026-10-29T20:40:00+03:00","mech_return_accepted":true}')$$, 'marks: the marks after the trip are saved');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'mech_return_by'), 'Механік Мельник', 'marks: mechanic on return is saved');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'medical_by'), 'Медик Іваненко', 'marks: a later save keeps the earlier marks');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"medical_at":"не дата"}')$$, 'P0001', 'TS_FIELD_INVALID:medical_at', 'marks: a bad time is refused');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"medical_ok":"так"}')$$, 'P0001', 'TS_FIELD_INVALID:medical_ok', 'marks: a bad flag is refused');
SELECT throws_ok($$UPDATE public.kp_doc_trip_sheet SET dispatcher_name = 'прямо'$$, '42501', NULL, 'marks: no direct UPDATE');

-- 5. Етапи: т·км рахує база, порядок, заміна.
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[
  {"customer":"Агро","ttn_no":"ТТН-1","load_point":"Луцьк","unload_point":"Рівне","arrive_load_at":"2026-10-28T07:00:00+03:00","depart_load_at":"2026-10-28T08:00:00+03:00",
   "arrive_unload_at":"2026-10-28T11:00:00+03:00","depart_unload_at":"2026-10-28T12:00:00+03:00","loaded_km":"150,5","tonnage":"22"},
  {"customer":"Біо","ttn_no":"ТТН-2","load_point":"Рівне","unload_point":"Одеса","loaded_km":"400","tonnage":"20,5"},
  {"customer":"Порожній","load_point":"Одеса","unload_point":"Луцьк"}]}')$$, 'stages: three stages are saved');
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 3, 'stages: three rows');
SELECT is((SELECT string_agg(position::text || ':' || customer, ',' ORDER BY position) FROM public.kp_trip_sheet_stages), '1:Агро,2:Біо,3:Порожній', 'stages: order = array order');
SELECT is((SELECT tkm FROM public.kp_trip_sheet_stages WHERE position = 1), 3311.0::numeric, 'stages: t·km = km × t (150.5 × 22 = 3311.0)');
SELECT is((SELECT tkm FROM public.kp_trip_sheet_stages WHERE position = 2), 8200.0::numeric, 'stages: t·km 400 × 20.5 = 8200.0');
SELECT is((SELECT tkm FROM public.kp_trip_sheet_stages WHERE position = 3), NULL, 'stages: no km or tonnage → no t·km');
SELECT throws_ok($$UPDATE public.kp_trip_sheet_stages SET tkm = 1$$, '428C9', NULL, 'stages: t·km is a generated column and cannot be edited');
SELECT throws_ok($$UPDATE public.kp_trip_sheet_stages SET customer = 'прямо'$$, '42501', NULL, 'stages: no direct UPDATE');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) #>> '{totals,tkm}')::numeric, 11511.0::numeric, 'totals: Σ t·km');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) #>> '{totals,loaded_km}')::numeric, 550.5::numeric, 'totals: Σ loaded km');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) #>> '{totals,trips}'), '3', 'totals: trips = number of stages');
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[{"customer":"Один","loaded_km":"10","tonnage":"1"}]}')$$, 'stages: the list is replaced as a whole');
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 1, 'stages: replaced, not appended');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[{"loaded_km":"-5"}]}')$$, 'P0001', NULL, 'stages: negative km refused');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[{"arrive_load_at":"2026-10-28T09:00:00+03:00","depart_load_at":"2026-10-28T08:00:00+03:00"}]}')$$,
  'P0001', 'TS_FIELD_INVALID:stages.depart_load_at', 'stages: departure before arrival refused');
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 1, 'stages: a refused save keeps the previous list');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":"x"}')$$, 'P0001', 'TS_BAD_DATA', 'stages: not an array refused');
SELECT throws_ok($$INSERT INTO public.kp_trip_sheet_stages (sheet_id, org_id, position) VALUES ((SELECT id FROM t_tf WHERE k = 'old'), 'c1000000-0000-4000-8000-00000000000a', 9)$$, '42501', NULL, 'stages: no direct INSERT');

-- 6. Закриття з етапами: норма за сумою км з вантажем з етапів.
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[{"loaded_km":"400","tonnage":"20"},{"loaded_km":"100","tonnage":"10"}]}')$$, 'close: stages for the norm');
SELECT is((public.kp_trip_sheet_close((SELECT id FROM t_tf WHERE k = 'old'),
  '{"return_at":"2026-10-29T20:00:00+03:00","return_odometer":"100600","return_fuel_left":"30"}') ->> 'fuel_norm')::numeric, 170.0::numeric,
  'close: norm = 500 km × 30 + 100 km × 20 per 100 km = 170.0 (loaded km from the stages)');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) #>> '{totals,distance_km}'), '600', 'totals: total mileage from the odometers');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old')) ->> 'status'), 'closed', 'close: closed');

-- 7. Закритий лист не змінюється: відмітки й етапи.
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"dispatcher_name":"після закриття"}')$$, 'P0001', 'TS_NOT_ISSUED', 'closed: marks cannot be changed');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[]}')$$, 'P0001', 'TS_NOT_ISSUED', 'closed: stages cannot be changed');
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 2, 'closed: the stages are still there');

-- 8. Чужа організація і ролі.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f204","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 0, 'another organisation sees no stages');
SELECT throws_ok($$SELECT public.kp_trip_sheet_get((SELECT id FROM t_tf WHERE k = 'old'))$$, 'P0001', 'DOC_NOT_FOUND', 'another organisation cannot read the sheet');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"dispatcher_name":"чужий"}')$$, 'P0001', 'DOC_NOT_FOUND', 'another organisation cannot write marks');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"stages":[{"customer":"чужий"}]}')$$, 'P0001', 'DOC_NOT_FOUND', 'another organisation cannot write stages');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f203","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 2, 'the director reads the stages');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_tf WHERE k = 'old'), '{"dispatcher_name":"директор"}')$$, '42501', 'KP_FORBIDDEN', 'the director cannot write');
RESET ROLE;

-- 9. Каскад: разом із листом (тригер заборони DELETE вимикаємо лише в тесті) зникають етапи.
ALTER TABLE public.kp_doc_trip_sheet DISABLE TRIGGER trg_kp_doc_trip_sheet_guard;
DELETE FROM public.kp_doc_trip_sheet WHERE id = (SELECT id FROM t_tf WHERE k = 'old');
ALTER TABLE public.kp_doc_trip_sheet ENABLE TRIGGER trg_kp_doc_trip_sheet_guard;
SELECT is((SELECT count(*)::integer FROM public.kp_trip_sheet_stages), 0, 'cascade: the stages are removed with the sheet');

SELECT * FROM finish();
ROLLBACK;
