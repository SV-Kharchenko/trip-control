-- Кабінет суперадміна, вкладка «Активність» (20261130090000_sa_user_activity.sql): sa_list_user_activity.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(23);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d5f00c1","role":"service_role"}', true);

INSERT INTO public.organizations (id, name, work_mode)
VALUES ('9e000000-0000-0000-0000-00000000000a', 'SAU Компанія', 'team');
-- c1 суперадмін; c2 директор (owner) компанії A з розрахунками; c3 без розрахунків, ніколи не входив; c4 звичайний користувач.
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000d5f00c1', 'authenticated', 'authenticated', 'sau-c1@example.com', '', now(), now(), '{"provider":"email","providers":["email"]}', '{"company_name":"SAU c1"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000d5f00c2', 'authenticated', 'authenticated', 'sau-c2@example.com', '', now() - interval '5 days', now() - interval '3 days', '{"provider":"email","providers":["email"]}', '{"company_name":"SAU c2"}', now() - interval '40 days', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000d5f00c3', 'authenticated', 'authenticated', 'sau-c3@example.com', '', NULL, NULL, '{"provider":"email","providers":["email"]}', '{"company_name":"SAU c3"}', now() - interval '2 days', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000d5f00c4', 'authenticated', 'authenticated', 'sau-c4@example.com', '', now(), now() - interval '50 days', '{"provider":"email","providers":["email"]}', '{"company_name":"SAU c4"}', now() - interval '60 days', now());
UPDATE public.profiles
SET org_id = '9e000000-0000-0000-0000-00000000000a', org_role = 'owner', member_status = 'active', is_approved = true
WHERE id = '00000000-0000-0000-0000-00000d5f00c2';
UPDATE public.profiles SET org_id = NULL WHERE id = '00000000-0000-0000-0000-00000d5f00c4';
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-0000-0000-00000d5f00c1');
-- c2: 3 розрахунки — 2 дні тому, 20 днів тому, 100 днів тому (7д = 1, 30д = 2, усього = 3).
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, created_at)
VALUES
  ('9e100000-0000-0000-0000-000000000001', '9e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d5f00c2', 'c-1', '{}', '{}', now() - interval '2 days'),
  ('9e100000-0000-0000-0000-000000000002', '9e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d5f00c2', 'c-2', '{}', '{}', now() - interval '20 days'),
  ('9e100000-0000-0000-0000-000000000003', '9e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d5f00c2', 'c-3', '{}', '{}', now() - interval '100 days');

-- Знімок таблиць до викликів: функція нічого не пише.
CREATE TEMP TABLE sau_before AS
SELECT (SELECT count(*) FROM public.calculations) AS calcs, (SELECT count(*) FROM public.profiles) AS profiles,
       (SELECT count(*) FROM public.organizations) AS orgs, (SELECT count(*) FROM public.platform_audit_log) AS audit,
       (SELECT count(*) FROM auth.users) AS users, (SELECT max(last_sign_in_at) FROM auth.users) AS last_in;
GRANT SELECT ON sau_before TO PUBLIC;

-- 1. Гранти.
SELECT is(has_function_privilege('anon', 'public.sa_list_user_activity(integer)', 'EXECUTE'), false, 'anon: без EXECUTE');
SELECT is(has_function_privilege('authenticated', 'public.sa_list_user_activity(integer)', 'EXECUTE'), true, 'authenticated: EXECUTE є');
SELECT is((SELECT p.prosecdef FROM pg_proc AS p WHERE p.proname = 'sa_list_user_activity'), true, 'SECURITY DEFINER');
SELECT ok((SELECT p.proconfig::text FROM pg_proc AS p WHERE p.proname = 'sa_list_user_activity') ~ 'search_path=public, pg_temp', 'search_path = public, pg_temp');

-- 2. Не суперадмін (authenticated owner) і anon — відмова 42501.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d5f00c2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.sa_list_user_activity()$$, '42501', 'SUPERADMIN_REQUIRED', 'owner: SUPERADMIN_REQUIRED');
SELECT throws_ok($$SELECT * FROM public.sa_list_user_activity(7)$$, '42501', 'SUPERADMIN_REQUIRED', 'owner: з аргументом теж');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.sa_list_user_activity()$$, '42501', NULL, 'anon: відмова');
RESET ROLE;

-- 3. Суперадмін: рядки й лічильники.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d5f00c1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT count(*) FROM public.sa_list_user_activity()) >= 4, 'суперадмін отримує рядки (усі користувачі)');
SELECT is((SELECT concat_ws('|', email, org_name, org_plan, org_role, member_status) FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'),
  'sau-c2@example.com|SAU Компанія|company|owner|active', 'email, компанія, тариф, роль, статус учасника');
SELECT is((SELECT concat_ws('|', calcs_7d, calcs_30d, calcs_total) FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'),
  '1|2|3', 'лічильники 7д / 30д / усього');
SELECT is((SELECT concat_ws('|', calcs_7d, calcs_30d, calcs_total) FROM public.sa_list_user_activity(90) WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'),
  '1|2|3', 'p_days = 90: ті самі 2 розрахунки у вікні (100 днів — поза ним)');
SELECT is((SELECT calcs_30d FROM public.sa_list_user_activity(1) WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'), 0, 'p_days = 1: у вікні нічого');
SELECT is((SELECT calcs_30d FROM public.sa_list_user_activity(500) WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'), 3, 'p_days обмежено 365: усі три');
SELECT is((SELECT concat_ws('|', calcs_7d, calcs_30d, calcs_total, last_calc_at IS NULL) FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c3'),
  '0|0|0|t', 'без розрахунків: нулі, last_calc_at порожній');
SELECT is((SELECT (last_calc_at >= now() - interval '2 days 1 minute') FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'),
  true, 'last_calc_at — найсвіжіший розрахунок');
SELECT is((SELECT last_activity_at = greatest(last_sign_in_at, last_calc_at) FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c2'), true, 'last_activity_at = greatest(вхід, розрахунок)');
SELECT is((SELECT last_activity_at IS NULL AND last_sign_in_at IS NULL AND email_confirmed_at IS NULL FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c3'), true, 'не входив і не підтвердив пошту: порожні дати');
SELECT is((SELECT registered_at IS NOT NULL FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c4'), true, 'registered_at є');
SELECT is((SELECT concat_ws('|', org_id IS NULL, org_name IS NULL, org_plan IS NULL) FROM public.sa_list_user_activity() WHERE user_id = '00000000-0000-0000-0000-00000d5f00c4'), 't|t|t', 'користувач без компанії: компанія порожня');
SELECT is((SELECT user_id FROM public.sa_list_user_activity() LIMIT 1), '00000000-0000-0000-0000-00000d5f00c1'::uuid, 'порядок: найсвіжіша активність першою');
RESET ROLE;

-- 4. Функція нічого не пише.
SELECT is((SELECT concat_ws('|', (SELECT count(*) FROM public.calculations), (SELECT count(*) FROM public.profiles), (SELECT count(*) FROM public.organizations),
                          (SELECT count(*) FROM public.platform_audit_log), (SELECT count(*) FROM auth.users))), (SELECT concat_ws('|', calcs, profiles, orgs, audit, users) FROM sau_before), 'таблиці не змінилися (і журнал не пишеться)');
SELECT is((SELECT max(last_sign_in_at) FROM auth.users), (SELECT last_in FROM sau_before), 'auth.users не змінено');
SELECT is((SELECT p.provolatile FROM pg_proc AS p WHERE p.proname = 'sa_list_user_activity'), 's', 'функція STABLE (лише читання)');

SELECT * FROM finish();
ROLLBACK;
