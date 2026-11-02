-- Остання ціна дизпалива й AdBlue (*_kp_last_fuel_prices.sql): kp_set_last_fuel_prices пише лише lastFuelPrice / lastAdbluePrice.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim. Усі дані — вигадані.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(21);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f301","role":"service_role"}', true);

-- A: owner f301, logist f302; B: owner f304.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('d1000000-0000-4000-8000-00000000000a', 'LP A', 'team'),
       ('d1000000-0000-4000-8000-00000000000b', 'LP B', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'lp-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'LP ' || k), now(), now()
FROM unnest(ARRAY['f301', 'f302', 'f304']) AS k;

UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000f304' THEN 'd1000000-0000-4000-8000-00000000000b'::uuid
                     ELSE 'd1000000-0000-4000-8000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000f302' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000f301', '00000000-0000-0000-0000-00000000f302', '00000000-0000-0000-0000-00000000f304');

INSERT INTO public.company_settings (org_id, settings)
VALUES ('d1000000-0000-4000-8000-00000000000a', '{"fuelLoad": 36.5, "amort": 120000, "doc_warn_days": 45}'::jsonb),
       ('d1000000-0000-4000-8000-00000000000b', '{"fuelLoad": 40}'::jsonb)
ON CONFLICT (org_id) DO UPDATE SET settings = excluded.settings;

-- 1. Права.
SELECT ok(NOT has_function_privilege('anon', 'public.kp_set_last_fuel_prices(numeric, numeric)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_set_last_fuel_prices(numeric, numeric)', 'EXECUTE'),
  'kp_set_last_fuel_prices: authenticated yes, anon no');

-- 2. Логіст зберігає ціни; інші ключі не змінюються.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f302","role":"authenticated"}', true);
SELECT is(public.kp_set_last_fuel_prices(56.5, 21), '{"lastFuelPrice": 56.5, "lastAdbluePrice": 21}'::jsonb, 'logist: saves both prices');
RESET ROLE;
SELECT is((SELECT settings FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000a'),
  '{"fuelLoad": 36.5, "amort": 120000, "doc_warn_days": 45, "lastFuelPrice": 56.5, "lastAdbluePrice": 21}'::jsonb,
  'logist: only the two keys are added, the costs and other keys are untouched');
SELECT is((SELECT settings FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000b'), '{"fuelLoad": 40}'::jsonb,
  'another organisation does not get this price');

-- 3. Часткове оновлення і округлення.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f302","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_set_last_fuel_prices(57.555, NULL)$$, 'logist: only the fuel price');
RESET ROLE;
SELECT is((SELECT settings ->> 'lastFuelPrice' FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000a'), '57.56', 'the price is rounded to kopecks');
SELECT is((SELECT settings ->> 'lastAdbluePrice' FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000a'), '21', 'NULL leaves the other price');

-- 4. Межі й порожній виклик.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f301","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(0, NULL)$$, 'P0001', 'PRICE_BAD', '0 is refused');
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(-5, NULL)$$, 'P0001', 'PRICE_BAD', 'a negative price is refused');
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(1000, NULL)$$, 'P0001', 'PRICE_BAD', '1000 is refused');
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(NULL, 5000)$$, 'P0001', 'PRICE_BAD', 'a huge AdBlue price is refused');
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(55, 0)$$, 'P0001', 'PRICE_BAD', 'one bad price refuses the whole call');
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(NULL, NULL)$$, 'P0001', 'PRICE_EMPTY', 'an empty call is refused');
RESET ROLE;
SELECT is((SELECT settings ->> 'lastFuelPrice' FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000a'), '57.56', 'refused calls change nothing');

-- 5. Власник іншої організації пише лише в свою.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f304","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_set_last_fuel_prices(61, 19.5)$$, 'owner of B saves its own prices');
RESET ROLE;
SELECT is((SELECT settings FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000b'),
  '{"fuelLoad": 40, "lastFuelPrice": 61, "lastAdbluePrice": 19.5}'::jsonb, 'B: its own keys');
SELECT is((SELECT settings ->> 'lastFuelPrice' FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000a'), '57.56', 'A is not affected by B');

-- 6. Без рядка налаштувань — створюється з двома ключами.
DELETE FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000b';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f304","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_set_last_fuel_prices(62, NULL)$$, 'no settings row yet: it is created');
RESET ROLE;
SELECT is((SELECT settings FROM public.company_settings WHERE org_id = 'd1000000-0000-4000-8000-00000000000b'), '{"lastFuelPrice": 62}'::jsonb, 'only the price key is stored');

-- 7. Вимкнений учасник і анонім не пишуть.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f301","role":"service_role"}', true);
UPDATE public.profiles SET member_status = 'disabled' WHERE id = '00000000-0000-0000-0000-00000000f302';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f302","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(70, NULL)$$, '42501', 'KP_FORBIDDEN', 'a disabled member cannot write');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.kp_set_last_fuel_prices(70, NULL)$$, '42501', NULL, 'anon cannot call it');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
