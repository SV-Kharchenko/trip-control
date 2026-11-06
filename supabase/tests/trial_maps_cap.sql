-- Ліміт маршрутів Google на тріалі (*_trial_maps_cap.sql): 20 на компанію за добу Europe/Kyiv, оплата / is_approved без ліміту, повтор маршруту не рахується.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(21);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- T: активний тріал; P: оплачена; A: ручне схвалення; X: тріал скінчився, оплати немає; K: тріал для перевірки доби.
INSERT INTO public.organizations (id, name) VALUES
  ('7c000000-0000-0000-0000-00000000000a', 'MC T'),
  ('7c000000-0000-0000-0000-00000000000b', 'MC P'),
  ('7c000000-0000-0000-0000-00000000000c', 'MC A'),
  ('7c000000-0000-0000-0000-00000000000d', 'MC X'),
  ('7c000000-0000-0000-0000-00000000000e', 'MC K');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d7c00' || k)::uuid, 'authenticated', 'authenticated',
       'mc-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'MC ' || k), now(), now()
FROM unnest(ARRAY['a1', 'b1', 'c1', 'd1', 'e1']) AS k;
UPDATE public.profiles SET org_role = 'owner', member_status = 'active',
  org_id = CASE right(id::text, 2) WHEN 'a1' THEN '7c000000-0000-0000-0000-00000000000a'::uuid WHEN 'b1' THEN '7c000000-0000-0000-0000-00000000000b'::uuid
                                   WHEN 'c1' THEN '7c000000-0000-0000-0000-00000000000c'::uuid WHEN 'd1' THEN '7c000000-0000-0000-0000-00000000000d'::uuid
                                   ELSE '7c000000-0000-0000-0000-00000000000e'::uuid END,
  is_approved = (right(id::text, 2) = 'c1')
WHERE id::text LIKE '00000000-0000-0000-0000-00000d7c00%';
DELETE FROM public.org_subscriptions WHERE org_id::text LIKE '7c000000-%';
INSERT INTO public.org_subscriptions (org_id, paid_until, trial_ends_at) VALUES
  ('7c000000-0000-0000-0000-00000000000a', NULL, now() + interval '3 days'),
  ('7c000000-0000-0000-0000-00000000000b', now() + interval '20 days', now() - interval '1 day'),
  ('7c000000-0000-0000-0000-00000000000c', NULL, now() - interval '1 day'),
  ('7c000000-0000-0000-0000-00000000000d', NULL, now() - interval '1 day'),
  ('7c000000-0000-0000-0000-00000000000e', NULL, now() + interval '3 days');

CREATE FUNCTION pg_temp.mc_as(k text) RETURNS void LANGUAGE sql AS
  $f$ SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d7c00' || k || '","role":"authenticated"}', true) $f$;
-- Скільки з n різних маршрутів компанії org дозволено (take_at, «зараз» = p_at).
CREATE FUNCTION pg_temp.mc_allowed(p_org uuid, n integer, p_at timestamptz, p_prefix text) RETURNS integer LANGUAGE sql AS
  $f$ SELECT count(*)::int FROM generate_series(1, n) AS g WHERE (public.trial_maps_take_at(p_org, p_prefix || g, p_at, true) ->> 'allowed')::boolean $f$;

-- 1. Тріал: рівно 20 маршрутів, 21-й — відмова (клієнт тоді рахує через OpenStreetMap).
SELECT is(pg_temp.mc_allowed('7c000000-0000-0000-0000-00000000000a', 20, now(), 'r'), 20, 'тріал: 20 різних маршрутів дозволено');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000a', 'r21', now(), true) ->> 'allowed', 'false', 'тріал: 21-й маршрут відхилено');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000a', 'r21', now(), true) ->> 'reason', 'limit', 'причина відмови — limit');
SELECT is((SELECT count(*)::int FROM public.trial_maps_routes WHERE org_id = '7c000000-0000-0000-0000-00000000000a'), 20, 'відмова лічильник не збільшує');
-- 2. Повтор уже порахованого маршруту («кеш»): дозволено, лічильник той самий, навіть коли ліміт вичерпано.
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000a', 'r5', now(), true) ->> 'allowed', 'true', 'повтор маршруту дозволено при вичерпаному ліміті');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000a', 'r5', now(), true) ->> 'cached', 'true', 'повтор позначений як cached');
SELECT is((SELECT count(*)::int FROM public.trial_maps_routes WHERE org_id = '7c000000-0000-0000-0000-00000000000a'), 20, 'повтор лічильник не збільшує');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000a', NULL, now(), false) ->> 'left', '0', 'статус: залишилось 0');
-- 3. Оплачена компанія й ручне схвалення: без ліміту, лічильник не чіпається.
SELECT is(pg_temp.mc_allowed('7c000000-0000-0000-0000-00000000000b', 25, now(), 'p'), 25, 'оплачена компанія: 25 з 25 без ліміту');
SELECT is(pg_temp.mc_allowed('7c000000-0000-0000-0000-00000000000c', 25, now(), 'a'), 25, 'is_approved: 25 з 25 без ліміту');
SELECT is((SELECT count(*)::int FROM public.trial_maps_routes WHERE org_id IN ('7c000000-0000-0000-0000-00000000000b', '7c000000-0000-0000-0000-00000000000c')), 0, 'для безлімітних компаній лічильник не пишеться');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000b', 'x', now(), true) ->> 'unlimited', 'true', 'оплачена: unlimited = true');
-- 4. Тріал скінчився, оплати немає: Google не дозволено.
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000d', 'x', now(), true) ->> 'reason', 'no_access', 'тріал скінчився: no_access');
-- 5. Доба за Києвом (літо UTC+3): 15.07 20:59 UTC = 23:59 Київ, 21:01 UTC = 00:01 16.07.
SELECT is(pg_temp.mc_allowed('7c000000-0000-0000-0000-00000000000e', 20, '2026-07-15 20:59:00+00', 'k'), 20, 'доба Київ (літо): 20 маршрутів до півночі');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000e', 'k21', '2026-07-15 20:59:30+00', true) ->> 'allowed', 'false', 'доба Київ (літо): 21-й до півночі відхилено');
SELECT is(public.trial_maps_take_at('7c000000-0000-0000-0000-00000000000e', 'k21', '2026-07-15 21:01:00+00', true) ->> 'allowed', 'true', 'доба Київ (літо): після півночі за Києвом лічильник новий');
-- Зима UTC+2: 15.01 21:59 UTC = 23:59 Київ, 22:00 UTC = 00:00 16.01.
SELECT is(public.trial_maps_kyiv_day('2026-01-15 21:59:00+00')::text || ' ' || public.trial_maps_kyiv_day('2026-01-15 22:00:00+00')::text, '2026-01-15 2026-01-16', 'доба Київ (зима): межа о 22:00 UTC');
-- 6. Клієнтські RPC беруть компанію з профілю; refund повертає дозвіл.
SELECT pg_temp.mc_as('a1');
SELECT is(public.maps_route_take('r6') ->> 'allowed', 'true', 'maps_route_take: уже порахований маршрут своєї компанії');
SELECT pg_temp.mc_as('e1');
SELECT is(public.maps_route_take('own-1') ->> 'used', (SELECT count(*) + 1 FROM public.trial_maps_routes WHERE org_id = '7c000000-0000-0000-0000-00000000000e' AND day = public.trial_maps_kyiv_day(now()))::text, 'maps_route_take: лічильник своєї компанії за сьогодні');
SELECT public.maps_route_refund('own-1');
SELECT is((SELECT count(*)::int FROM public.trial_maps_routes WHERE org_id = '7c000000-0000-0000-0000-00000000000e' AND route_key = md5('own-1')), 0, 'maps_route_refund повертає дозвіл');
-- 7. Права: таблиця й ядро закриті, RPC — лише для authenticated.
SELECT ok(NOT has_table_privilege('authenticated', 'public.trial_maps_routes', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.trial_maps_routes', 'INSERT')
  AND NOT has_function_privilege('authenticated', 'public.trial_maps_take_at(uuid,text,timestamptz,boolean)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.maps_route_take(text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.maps_route_take(text)', 'EXECUTE'),
  'таблиця й ядро закриті для клієнтів, RPC лише для authenticated');

SELECT * FROM finish();
ROLLBACK;
