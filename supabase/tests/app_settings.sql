-- Глобальний вимикач модулів (*_app_settings_kill_switch.sql): app_settings, feature_enabled, org_has_feature.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(33);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d2f00a1","role":"service_role"}', true);

INSERT INTO public.organizations (id, name, work_mode)
VALUES ('9a000000-0000-0000-0000-00000000000a', 'AS flagged', 'solo'),
       ('9a000000-0000-0000-0000-00000000000b', 'AS unflagged', 'solo');
UPDATE public.organizations SET features = '{"as_demo": true, "as_other": false}' WHERE id = '9a000000-0000-0000-0000-00000000000a';

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d2f00' || k)::uuid, 'authenticated', 'authenticated',
       'as-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'AS ' || k), now(), now()
FROM unnest(ARRAY['a1', 'a2']) AS k;

-- 1. Немає рядка → вимкнено; організаційний прапорець сам нічого не вмикає.
SELECT is(public.feature_enabled('as_demo'), false, 'no row → disabled');
SELECT is(public.feature_enabled(NULL), false, 'NULL key → disabled');
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_demo'), false, 'org flag set, no global row → disabled (global kill switch wins)');

-- 2. Рядок enabled=false → вимкнено; true → вмикає лише для організацій із прапорцем.
INSERT INTO public.app_settings (key, enabled) VALUES ('as_demo', false), ('as_other', true);
SELECT is(public.feature_enabled('as_demo'), false, 'row enabled=false → disabled');
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_demo'), false, 'enabled=false → org flag is not enough');
UPDATE public.app_settings SET enabled = true WHERE key = 'as_demo';
SELECT is(public.feature_enabled('as_demo'), true, 'row enabled=true → enabled');
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_demo'), true, 'global on + org flag → enabled');
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000b', 'as_demo'), false, 'global on, org without the flag → disabled');
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_other'), false, 'global on, org flag false → disabled');
SELECT is(public.org_has_feature(gen_random_uuid(), 'as_demo'), false, 'unknown org → disabled');
SELECT is(public.org_has_feature(NULL, 'as_demo'), false, 'NULL org → disabled');
SELECT is((SELECT updated_at > now() - interval '1 minute' FROM public.app_settings WHERE key = 'as_demo'), true, 'updated_at is maintained');

-- 3. Вимкнути одним UPDATE: усі організації одразу втрачають модуль.
UPDATE public.app_settings SET enabled = false WHERE key = 'as_demo';
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_demo'), false, 'one UPDATE switches the module off for everybody');
DELETE FROM public.app_settings WHERE key = 'as_demo';
SELECT is(public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_demo'), false, 'deleting the row also means off');
INSERT INTO public.app_settings (key, enabled) VALUES ('as_demo', true);

-- 4. Права: читати можуть authenticated, писати — ні; anon нічого.
SELECT throws_ok($$INSERT INTO public.app_settings (key, enabled) VALUES ('bad key', true)$$, '23514', NULL, 'key format is checked');
SELECT is(has_function_privilege('anon', 'public.feature_enabled(text)', 'EXECUTE'), false, 'anon cannot call feature_enabled');
SELECT is(has_function_privilege('authenticated', 'public.feature_enabled(text)', 'EXECUTE'), true, 'authenticated can call feature_enabled');
SELECT is(has_function_privilege('authenticated', 'public.org_has_feature(uuid, text)', 'EXECUTE'), false, 'org_has_feature is not callable by clients');
SELECT is(has_function_privilege('service_role', 'public.org_has_feature(uuid, text)', 'EXECUTE'), true, 'service_role can call org_has_feature');
SELECT is(has_table_privilege('anon', 'public.app_settings', 'SELECT'), false, 'anon cannot read app_settings');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d2f00a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.app_settings WHERE key IN ('as_demo', 'as_other')), 2, 'authenticated reads app_settings');
SELECT is(public.feature_enabled('as_demo'), true, 'authenticated: feature_enabled works');
SELECT throws_ok($$INSERT INTO public.app_settings (key, enabled) VALUES ('as_new', true)$$, '42501', NULL, 'authenticated cannot INSERT');
SELECT throws_ok($$UPDATE public.app_settings SET enabled = false WHERE key = 'as_demo'$$, '42501', NULL, 'authenticated cannot UPDATE');
SELECT throws_ok($$DELETE FROM public.app_settings$$, '42501', NULL, 'authenticated cannot DELETE');
SELECT throws_ok($$SELECT public.org_has_feature('9a000000-0000-0000-0000-00000000000a', 'as_demo')$$, '42501', NULL, 'authenticated cannot call org_has_feature');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.app_settings$$, '42501', NULL, 'anon cannot read app_settings');
SELECT throws_ok($$SELECT public.feature_enabled('as_demo')$$, '42501', NULL, 'anon cannot call feature_enabled');
RESET ROLE;

-- 5. service_role пише в app_settings.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d2f00a2","role":"service_role"}', true);
SELECT lives_ok($$UPDATE public.app_settings SET enabled = true WHERE key = 'as_other'$$, 'service_role writes app_settings');

-- 6. Глобальний вимикач керує справжнім модулем «Власний парк»: прапорець організації без рядка app_settings нічого не вмикає.
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d2f00a1","role":"service_role"}', true);
UPDATE public.profiles SET org_id = '9a000000-0000-0000-0000-00000000000a', org_role = 'owner', member_status = 'active', is_approved = true WHERE id = '00000000-0000-0000-0000-00000d2f00a1';
SELECT public.set_org_plan('9a000000-0000-0000-0000-00000000000a', 'control_plus');
UPDATE public.organizations SET features = '{"own_fleet": true}' WHERE id = '9a000000-0000-0000-0000-00000000000a';
DELETE FROM public.app_settings WHERE key = 'own_fleet';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d2f00a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.own_fleet_context()), 0, 'own_fleet: прапорець організації є, рядка app_settings немає → модуль вимкнено (контексту немає)');
RESET ROLE;
INSERT INTO public.app_settings (key, enabled) VALUES ('own_fleet', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role FROM public.own_fleet_context()), 'owner', 'own_fleet: рядок app_settings увімкнено + прапорець → директор бачить модуль');
RESET ROLE;
UPDATE public.app_settings SET enabled = false WHERE key = 'own_fleet';
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.own_fleet_context()), 0, 'own_fleet: один UPDATE enabled = false вимикає модуль для всіх');
SELECT is((SELECT count(*)::integer FROM public.org_units), 0, 'own_fleet: і таблиці модуля віддають 0 рядків');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
