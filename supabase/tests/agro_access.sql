-- Доступ до AGRO (*_agro_access.sql): app_settings('agro'), agro_user_access, agro_access_for, agro_access_me, sa_set_user_agro, sa_list_org_agro_users.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(59);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000a9a0001","role":"service_role"}', true);

CREATE FUNCTION pg_temp.ag_as(k text) RETURNS void LANGUAGE sql AS
  $f$ SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000a9a00' || k || '","role":"authenticated"}', true) $f$;
CREATE FUNCTION pg_temp.ag_svc() RETURNS void LANGUAGE sql AS
  $f$ SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000a9a0001","role":"service_role"}', true) $f$;
CREATE FUNCTION pg_temp.ag_for(k text) RETURNS text LANGUAGE sql AS
  $f$ SELECT (public.agro_access_for(('00000000-0000-0000-0000-00000a9a00' || k)::uuid) ->> 'allowed') || ' ' || (public.agro_access_for(('00000000-0000-0000-0000-00000a9a00' || k)::uuid) ->> 'reason') $f$;
GRANT EXECUTE ON FUNCTION pg_temp.ag_as(text), pg_temp.ag_svc(), pg_temp.ag_for(text) TO PUBLIC;

-- 01 суперадмін (підтверджена пошта); 02 директор (owner) компанії A; 03 логіст A; 04 користувач компанії B; 05 непідтверджена пошта (A);
-- 06 забанений (A); 07 без компанії.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('9a9a0000-0000-0000-0000-00000000000a', 'AGRO Північ', 'team'),
       ('9a9a0000-0000-0000-0000-00000000000b', 'AGRO Інша', 'solo');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000a9a00' || k)::uuid, 'authenticated', 'authenticated',
       'ag-' || k || '@example.com', '', CASE WHEN k = '05' THEN NULL ELSE now() END, '{"provider":"email","providers":["email"]}',
       jsonb_build_object('company_name', 'AG ' || k), now(), now()
FROM unnest(ARRAY['01', '02', '03', '04', '05', '06', '07']) AS k;
UPDATE public.profiles
SET org_id = CASE WHEN id = '00000000-0000-0000-0000-00000a9a0004' THEN '9a9a0000-0000-0000-0000-00000000000b'::uuid ELSE '9a9a0000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000a9a0003' THEN 'logist' WHEN id IN ('00000000-0000-0000-0000-00000a9a0002', '00000000-0000-0000-0000-00000a9a0004') THEN 'owner' ELSE 'logist' END, member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000a9a0002', '00000000-0000-0000-0000-00000a9a0003', '00000000-0000-0000-0000-00000a9a0004',
             '00000000-0000-0000-0000-00000a9a0005', '00000000-0000-0000-0000-00000a9a0006');
UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '00000000-0000-0000-0000-00000a9a0006';
UPDATE public.profiles SET org_id = NULL WHERE id = '00000000-0000-0000-0000-00000a9a0007';
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-0000-0000-00000a9a0001');

-- 1. Міграція: рядок-засів вимкнений, таблиця закрита, функції без зайвих грантів.
SELECT is((SELECT enabled FROM public.app_settings WHERE key = 'agro'), false, 'app_settings.agro додано вимкненим');
SELECT is(public.feature_enabled('agro'), false, 'feature_enabled(agro) = false');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.agro_user_access'::regclass), true, 'RLS на agro_user_access увімкнено');
SELECT is(has_table_privilege('anon', 'public.agro_user_access', 'SELECT'), false, 'anon: немає SELECT на agro_user_access');
SELECT is(has_table_privilege('authenticated', 'public.agro_user_access', 'SELECT'), false, 'authenticated: немає SELECT');
SELECT is(has_table_privilege('authenticated', 'public.agro_user_access', 'INSERT'), false, 'authenticated: немає INSERT');
SELECT is(has_table_privilege('authenticated', 'public.agro_user_access', 'UPDATE'), false, 'authenticated: немає UPDATE');
SELECT is(has_table_privilege('authenticated', 'public.agro_user_access', 'DELETE'), false, 'authenticated: немає DELETE');
SELECT is(has_table_privilege('service_role', 'public.agro_user_access', 'SELECT'), true, 'service_role: є доступ');
SELECT is(has_function_privilege('anon', 'public.agro_access_for(uuid)', 'EXECUTE'), false, 'anon: agro_access_for недоступна');
SELECT is(has_function_privilege('authenticated', 'public.agro_access_for(uuid)', 'EXECUTE'), false, 'authenticated: agro_access_for недоступна');
SELECT is(has_function_privilege('service_role', 'public.agro_access_for(uuid)', 'EXECUTE'), true, 'service_role: agro_access_for доступна');
SELECT is(has_function_privilege('anon', 'public.agro_access_me()', 'EXECUTE'), false, 'anon: agro_access_me недоступна');
SELECT is(has_function_privilege('authenticated', 'public.agro_access_me()', 'EXECUTE'), true, 'authenticated: agro_access_me доступна');
SELECT is(has_function_privilege('anon', 'public.sa_set_user_agro(uuid, boolean)', 'EXECUTE'), false, 'anon: sa_set_user_agro недоступна');
SELECT is(has_function_privilege('anon', 'public.sa_list_org_agro_users(uuid)', 'EXECUTE'), false, 'anon: sa_list_org_agro_users недоступна');

-- 2. Анонім і звичайний користувач нічого не читають і не пишуть.
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.agro_user_access$$, '42501', NULL, 'anon не читає agro_user_access');
SELECT throws_ok($$SELECT public.agro_access_for('00000000-0000-0000-0000-00000a9a0002')$$, '42501', NULL, 'anon: agro_access_for');
SELECT throws_ok($$SELECT public.agro_access_me()$$, '42501', NULL, 'anon: agro_access_me');
SELECT throws_ok($$SELECT public.sa_set_user_agro('00000000-0000-0000-0000-00000a9a0002', true)$$, '42501', NULL, 'anon: sa_set_user_agro');
SELECT throws_ok($$SELECT * FROM public.sa_list_org_agro_users('9a9a0000-0000-0000-0000-00000000000a')$$, '42501', NULL, 'anon: sa_list_org_agro_users');
RESET ROLE;
SELECT pg_temp.ag_as('02');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.agro_user_access$$, '42501', NULL, 'owner не читає agro_user_access');
SELECT throws_ok($$INSERT INTO public.agro_user_access (user_id, allowed) VALUES ('00000000-0000-0000-0000-00000a9a0002', true)$$, '42501', NULL, 'owner не дає собі доступ напряму');
SELECT throws_ok($$SELECT public.agro_access_for('00000000-0000-0000-0000-00000a9a0003')$$, '42501', NULL, 'owner не викликає agro_access_for');
SELECT throws_ok($$SELECT public.sa_set_user_agro('00000000-0000-0000-0000-00000a9a0002', true)$$, '42501', 'SUPERADMIN_REQUIRED', 'owner не викликає sa_set_user_agro');
SELECT throws_ok($$SELECT * FROM public.sa_list_org_agro_users('9a9a0000-0000-0000-0000-00000000000a')$$, '42501', 'SUPERADMIN_REQUIRED', 'owner не викликає sa_list_org_agro_users');
RESET ROLE;
SELECT pg_temp.ag_as('03');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.sa_set_user_agro('00000000-0000-0000-0000-00000a9a0003', true)$$, '42501', 'SUPERADMIN_REQUIRED', 'логіст не викликає sa_set_user_agro');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.agro_user_access), 0, 'жодного перевизначення не створено');

-- 3. Комбінації: глобально вимкнено → org on → override → org blocked.
SELECT pg_temp.ag_svc();
SELECT is(pg_temp.ag_for('02'), 'false global_off', 'глобально вимкнено: owner — global_off');
SELECT pg_temp.ag_as('01');
SELECT is((public.sa_set_setting('agro', true) ->> 'changed'), 'true', 'суперадмін вмикає глобальний agro');
SELECT pg_temp.ag_svc();
SELECT is(pg_temp.ag_for('02'), 'false org', 'глобально увімкнено, компанія без прапорця: false org');
SELECT pg_temp.ag_as('01');
SELECT is((public.sa_set_org_feature('9a9a0000-0000-0000-0000-00000000000a', 'agro', true) ->> 'enabled'), 'true', 'суперадмін вмикає agro компанії A (наявна sa_set_org_feature)');
SELECT pg_temp.ag_svc();
SELECT is(pg_temp.ag_for('02'), 'true org', 'компанія A on: owner — true org');
SELECT is(pg_temp.ag_for('03'), 'true org', 'компанія A on: логіст — true org');
SELECT is(pg_temp.ag_for('04'), 'false org', 'компанія B без прапорця: false org');
SELECT is(pg_temp.ag_for('05'), 'false email_unconfirmed', 'непідтверджена пошта: email_unconfirmed');
SELECT is(pg_temp.ag_for('06'), 'false user_blocked', 'забанений: user_blocked');
SELECT is(pg_temp.ag_for('07'), 'false no_org', 'без компанії: no_org');
SELECT is(pg_temp.ag_for('99'), 'false user_blocked', 'невідомий користувач: user_blocked');

SELECT pg_temp.ag_as('01');
SELECT is((public.sa_set_user_agro('00000000-0000-0000-0000-00000a9a0003', false) ->> 'override'), 'false', 'override false для логіста');
SELECT is((public.sa_set_user_agro('00000000-0000-0000-0000-00000a9a0004', true) ->> 'override'), 'true', 'override true для користувача компанії B');
SELECT pg_temp.ag_svc();
SELECT is(pg_temp.ag_for('03'), 'false user_override', 'override false перебиває компанію A on');
SELECT is(pg_temp.ag_for('04'), 'true user_override', 'override true перебиває компанію B off');
SELECT is(pg_temp.ag_for('02'), 'true org', 'інші в компанії A не зачеплені');
SELECT pg_temp.ag_as('01');
SELECT is((SELECT concat_ws('|', action, target_type, target_id, admin_id, before::text, after::text) FROM public.platform_audit_log WHERE action = 'user.agro.set' AND target_id = '00000000-0000-0000-0000-00000a9a0003'),
  'user.agro.set|user|00000000-0000-0000-0000-00000a9a0003|00000000-0000-0000-0000-00000a9a0001|{"allowed": null}|{"allowed": false}', 'журнал: дія, користувач, до й після');
SELECT is((SELECT concat_ws('|', email, org_role, override::text, allowed::text, reason) FROM public.sa_list_org_agro_users('9a9a0000-0000-0000-0000-00000000000a') WHERE user_id = '00000000-0000-0000-0000-00000a9a0003'),
  'ag-03@example.com|logist|false|false|user_override', 'sa_list_org_agro_users: логіст з перевизначенням');
SELECT is((SELECT count(*)::integer FROM public.sa_list_org_agro_users('9a9a0000-0000-0000-0000-00000000000a')), 4, 'список компанії A: чотири активні учасники');
SELECT is((SELECT override FROM public.sa_list_org_agro_users('9a9a0000-0000-0000-0000-00000000000a') WHERE user_id = '00000000-0000-0000-0000-00000a9a0002'), NULL, 'без перевизначення override = null');
SELECT is((public.sa_set_user_agro('00000000-0000-0000-0000-00000a9a0003', NULL) ->> 'override'), NULL, 'null прибирає перевизначення');
SELECT pg_temp.ag_svc();
SELECT is(pg_temp.ag_for('03'), 'true org', 'після null логіст знову успадковує компанію');
SELECT is((SELECT count(*)::integer FROM public.agro_user_access), 1, 'лишився лише override для компанії B');
SELECT pg_temp.ag_as('01');
SELECT throws_ok($$SELECT public.sa_set_user_agro('00000000-0000-0000-0000-00000a9aaaaa', true)$$, 'P0002', NULL, 'невідомий користувач: SA_USER_NOT_FOUND');

-- agro_access_me для самого користувача.
SELECT pg_temp.ag_as('02');
SELECT is(public.agro_access_me(), true, 'agro_access_me: owner компанії A — true');
SELECT pg_temp.ag_as('05');
SELECT is(public.agro_access_me(), false, 'agro_access_me: непідтверджена пошта — false');

-- Компанія заблокована: навіть override true не допомагає.
SELECT pg_temp.ag_svc();
UPDATE public.organizations SET status = 'blocked' WHERE id = '9a9a0000-0000-0000-0000-00000000000b';
SELECT is(pg_temp.ag_for('04'), 'false org_blocked', 'компанія заблокована: org_blocked навіть з override true');
UPDATE public.organizations SET status = 'blocked' WHERE id = '9a9a0000-0000-0000-0000-00000000000a';
SELECT is(pg_temp.ag_for('02'), 'false org_blocked', 'компанія A заблокована: owner — org_blocked');
UPDATE public.organizations SET status = 'active' WHERE id = '9a9a0000-0000-0000-0000-00000000000a';

-- Глобальний вимикач гасить усе, включно з override.
SELECT pg_temp.ag_as('01');
SELECT is((public.sa_set_setting('agro', false) ->> 'changed'), 'true', 'суперадмін вимикає глобальний agro');
SELECT pg_temp.ag_svc();
SELECT is(pg_temp.ag_for('02'), 'false global_off', 'global off: компанія A — global_off');
SELECT is(pg_temp.ag_for('04'), 'false global_off', 'global off: навіть override true — global_off');

SELECT * FROM finish();
ROLLBACK;
