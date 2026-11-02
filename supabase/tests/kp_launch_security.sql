-- Безпека перед запуском (*_api_rate_limits, *_security_audit_fixes, *_company_settings_merge, *_ts_pretrip_marks_lock).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim. Усі дані — вигадані.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(32);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A: owner b101, logist b102; B: owner b103.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('c3000000-0000-4000-8000-00000000000a', 'LS A', 'team'),
       ('c3000000-0000-4000-8000-00000000000b', 'LS B', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'ls-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'LS ' || k), now(), now()
FROM unnest(ARRAY['b101', 'b102', 'b103']) AS k;

UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000b103' THEN 'c3000000-0000-4000-8000-00000000000b'::uuid
                     ELSE 'c3000000-0000-4000-8000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000b102' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-00000000b103');

SELECT public.set_org_plan('c3000000-0000-4000-8000-00000000000a', 'control_plus');
INSERT INTO public.kp_org_requisites (org_id, legal_name, edrpou) VALUES ('c3000000-0000-4000-8000-00000000000a', 'ТОВ Перевізник LS', '12345678');

CREATE TEMP TABLE t_ls (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_ls TO PUBLIC;

-- 1. Ліміт запитів: таблиця й функція закриті від клієнтів, рахує вікно, після ліміту allowed = false.
SELECT ok(NOT has_function_privilege('anon', 'public.api_rate_hit(text, integer, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.api_rate_hit(text, integer, integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.api_rate_hit(text, integer, integer)', 'EXECUTE'),
  'api_rate_hit: service_role only');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_rate_limits'::regclass)
  AND NOT has_table_privilege('authenticated', 'public.api_rate_limits', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.api_rate_limits', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.api_rate_limits', 'SELECT'),
  'api_rate_limits: RLS on, no client access');
SET LOCAL ROLE service_role;
SELECT is((SELECT allowed FROM public.api_rate_hit('t:a', 3, 60)), true, 'rate: 1st hit allowed');
SELECT is((SELECT allowed FROM public.api_rate_hit('t:a', 3, 60)), true, 'rate: 2nd hit allowed');
SELECT is((SELECT allowed FROM public.api_rate_hit('t:a', 3, 60)), true, 'rate: 3rd hit (the limit) allowed');
SELECT is((SELECT allowed FROM public.api_rate_hit('t:a', 3, 60)), false, 'rate: 4th hit refused');
SELECT ok((SELECT retry_after FROM public.api_rate_hit('t:a', 3, 60)) BETWEEN 1 AND 60, 'rate: retry_after is within the window');
SELECT is((SELECT allowed FROM public.api_rate_hit('t:b', 3, 60)), true, 'rate: another bucket is counted separately');
SELECT throws_ok($$SELECT * FROM public.api_rate_hit('', 3, 60)$$, 'P0001', 'RATE_BAD_ARGS', 'rate: empty bucket refused');
SELECT throws_ok($$SELECT * FROM public.api_rate_hit('t:c', 0, 60)$$, 'P0001', 'RATE_BAD_ARGS', 'rate: bad limit refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.api_rate_hit('t:d', 3, 60)$$, '42501', NULL, 'rate: authenticated cannot call it');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.api_rate_hit('t:d', 3, 60)$$, '42501', NULL, 'rate: anon cannot call it');
RESET ROLE;

-- 2. Аудит: bump_calc_usage недоступна клієнтам, trailer_presets під RLS.
SELECT ok(NOT has_function_privilege('anon', 'public.bump_calc_usage(uuid, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.bump_calc_usage(uuid, integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.bump_calc_usage(uuid, integer)', 'EXECUTE'),
  'bump_calc_usage: service_role only (anyone could exhaust another company''s demo counter)');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.bump_calc_usage('c3000000-0000-4000-8000-00000000000a', 1)$$, '42501', NULL, 'bump_calc_usage: anon refused');
RESET ROLE;
SELECT ok(to_regclass('public.trailer_presets') IS NULL OR (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trailer_presets'::regclass), 'trailer_presets: RLS enabled');
SELECT is((SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'api_rate_limits' AND NOT c.relrowsecurity), 0, 'the new table is under RLS');

-- 3. Налаштування компанії: серверний merge не затирає чужі ключі.
INSERT INTO public.company_settings (org_id, settings)
VALUES ('c3000000-0000-4000-8000-00000000000a', '{"fuelLoad": 36.5, "amort": 120000, "doc_warn_days": 45, "lastFuelPrice": 55}'::jsonb)
ON CONFLICT (org_id) DO UPDATE SET settings = excluded.settings;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b101","role":"authenticated"}', true);
SELECT is(public.kp_company_settings_merge('{"amort": 130000}'::jsonb, ARRAY[]::text[]),
  '{"fuelLoad": 36.5, "amort": 130000, "doc_warn_days": 45, "lastFuelPrice": 55}'::jsonb, 'merge: only the sent key changes');
RESET ROLE;
-- «Інша вкладка» тим часом дописала ключ напряму (як kp_set_last_fuel_prices).
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.company_settings SET settings = settings || '{"lastFuelPrice": 61, "other_tab": true}'::jsonb WHERE org_id = 'c3000000-0000-4000-8000-00000000000a';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b101","role":"authenticated"}', true);
SELECT is(public.kp_company_settings_merge('{"fuelLoad": 40}'::jsonb, ARRAY['doc_warn_days']),
  '{"fuelLoad": 40, "amort": 130000, "lastFuelPrice": 61, "other_tab": true}'::jsonb,
  'merge: a stale tab keeps the keys written meanwhile (lastFuelPrice 61, other_tab) and removes only what it asked for');
SELECT is((SELECT settings FROM public.company_settings WHERE org_id = 'c3000000-0000-4000-8000-00000000000a'),
  '{"fuelLoad": 40, "amort": 130000, "lastFuelPrice": 61, "other_tab": true}'::jsonb, 'merge: the stored object is the merged one');
SELECT throws_ok($$SELECT public.kp_company_settings_merge('[1]'::jsonb, ARRAY[]::text[])$$, 'P0001', 'SETTINGS_BAD_DATA', 'merge: not an object refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b102","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_company_settings_merge('{"fuelLoad": 1}'::jsonb, ARRAY[]::text[])$$, '42501', 'SETTINGS_OWNER_ONLY', 'merge: the logist cannot change company settings');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b103","role":"authenticated"}', true);
SELECT is(public.kp_company_settings_merge('{"fuelLoad": 25}'::jsonb, ARRAY[]::text[]), '{"fuelLoad": 25}'::jsonb, 'merge: another company writes only its own row');
RESET ROLE;
SELECT is((SELECT settings ->> 'fuelLoad' FROM public.company_settings WHERE org_id = 'c3000000-0000-4000-8000-00000000000a'), '40', 'merge: company A is untouched by company B');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.kp_company_settings_merge('{"a":1}'::jsonb, ARRAY[]::text[])$$, '42501', NULL, 'merge: anon refused');
RESET ROLE;

-- 4. Передрейсові відмітки: після виїзду лише читання (сервер).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b101","role":"authenticated"}', true);
INSERT INTO t_ls
SELECT 'ts', public.kp_trip_sheet_create('2026-10-28', NULL, $j${
  "valid_from":"2026-10-28","valid_to":"2026-10-30",
  "driver":{"full_name":"Тестовий Водій","license_no":"AB123456"},
  "vehicle":{"make_model":"DAF XF","reg_number":"AA1234LS","fuel_load":"30","fuel_empty":"20"},
  "task":{"customer":"Агро","route_from":"Луцьк","route_to":"Одеса","cargo":"Пшениця","tonnage":"22","loaded_km":"300"},
  "depart":{"at":"2026-10-28T06:00:00+03:00","odometer":"100000","fuel_left":"80","fuel_issued":"200","fuel_kind":"ДП"}}$j$::jsonb);
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_ls WHERE k = 'ts'),
  '{"medical_by":"Медик","medical_at":"2026-10-28T05:30:00+03:00","medical_ok":true,"tech_by":"Механік","tech_ok":true}')$$,
  'pre-trip marks: within the first minutes after issue they can still be filled in');
RESET ROLE;
-- Минув час «на видачу»: створено давно, виїзд у минулому.
ALTER TABLE public.kp_doc_trip_sheet DISABLE TRIGGER trg_kp_doc_trip_sheet_guard;
UPDATE public.kp_doc_trip_sheet SET created_at = now() - interval '1 hour' WHERE id = (SELECT id FROM t_ls WHERE k = 'ts');
ALTER TABLE public.kp_doc_trip_sheet ENABLE TRIGGER trg_kp_doc_trip_sheet_guard;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b101","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_ls WHERE k = 'ts'), '{"medical_by":"Інший медик"}')$$, '42501', 'TS_PRETRIP_LOCKED', 'pre-trip marks: medical_by is read-only after departure');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_ls WHERE k = 'ts'), '{"medical_ok":false}')$$, '42501', 'TS_PRETRIP_LOCKED', 'pre-trip marks: medical_ok is read-only after departure');
SELECT throws_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_ls WHERE k = 'ts'), '{"tech_at":"2026-10-28T05:50:00+03:00"}')$$, '42501', 'TS_PRETRIP_LOCKED', 'pre-trip marks: tech_at is read-only after departure');
SELECT lives_ok($$SELECT public.kp_trip_sheet_extra_save((SELECT id FROM t_ls WHERE k = 'ts'),
  '{"medical_by":"Медик","medical_ok":true,"tech_by":"Механік","tech_ok":true,"medical_post_by":"Медик після","dispatcher_name":"Диспетчер"}')$$,
  'pre-trip marks: the same values may be re-sent; post-trip marks and the dispatcher stay editable');
SELECT is((public.kp_trip_sheet_get((SELECT id FROM t_ls WHERE k = 'ts')) ->> 'medical_post_by'), 'Медик після', 'post-trip mark was saved');
RESET ROLE;
SELECT throws_ok($$UPDATE public.kp_doc_trip_sheet SET medical_by = 'прямо' WHERE id = (SELECT id FROM t_ls WHERE k = 'ts')$$, '42501', 'TS_PRETRIP_LOCKED', 'pre-trip marks: even the service role cannot change them');
SELECT is((SELECT medical_by FROM public.kp_doc_trip_sheet WHERE id = (SELECT id FROM t_ls WHERE k = 'ts')), 'Медик', 'pre-trip marks: unchanged after the refused attempts');

SELECT * FROM finish();
ROLLBACK;
