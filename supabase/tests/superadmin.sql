-- Кабінет суперадміна (*_superadmin.sql): platform_admins, is_platform_superadmin, sa_* RPC, platform_audit_log.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(80);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d3f00a1","role":"service_role"}', true);

-- Текст помилки (виклик без SET ROLE: функції SECURITY DEFINER, особу задають claims).
CREATE FUNCTION pg_temp.sax_err(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.sax_err(text) TO PUBLIC;
CREATE FUNCTION pg_temp.sax_as(k text) RETURNS void LANGUAGE sql AS
  $f$ SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d3f00' || k || '","role":"authenticated"}', true) $f$;
-- Скільки з шести sa_* відмовили з 42501 для поточного користувача.
CREATE FUNCTION pg_temp.sax_denied() RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  n integer := 0;
  q text;
BEGIN
  FOREACH q IN ARRAY ARRAY[
    'SELECT * FROM public.sa_list_settings()',
    'SELECT public.sa_set_setting(''own_fleet'', true)',
    'SELECT * FROM public.sa_search_orgs(''x'', 5, 0)',
    'SELECT public.sa_get_org(''9b000000-0000-0000-0000-00000000000a'')',
    'SELECT public.sa_set_org_feature(''9b000000-0000-0000-0000-00000000000a'', ''own_fleet'', true)',
    'SELECT * FROM public.sa_list_audit()',
    'SELECT public.sa_create_setting(''own_fleet'', false)'] LOOP
    BEGIN
      EXECUTE q;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      n := n + 1;
    END;
  END LOOP;
  RETURN n;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.sax_denied() TO PUBLIC;

-- Користувачі: a1 суперадмін; a2 директор (owner) компанії A; a3 менеджер (director) A; a4 логіст A; a5 звичайний користувач; a6 теж без ролі.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('9b000000-0000-0000-0000-00000000000a', 'SA Agro Північ', 'team'),
       ('9b000000-0000-0000-0000-00000000000b', 'SA Інша компанія', 'solo');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d3f00' || k)::uuid, 'authenticated', 'authenticated',
       'sa-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'SA ' || k), now(), now()
FROM unnest(ARRAY['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) AS k;
UPDATE public.profiles
SET org_id = '9b000000-0000-0000-0000-00000000000a',
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000d3f00a4' THEN 'logist' ELSE 'owner' END, member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000d3f00a2', '00000000-0000-0000-0000-00000d3f00a4');
SELECT public.set_org_plan('9b000000-0000-0000-0000-00000000000a', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('9b000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d3f00a3');
INSERT INTO public.org_company_profiles (org_id, edrpou, ownership) VALUES ('9b000000-0000-0000-0000-00000000000a', '90909091', 'ТОВ');
-- Єдиний спосіб стати суперадміном — рядок у platform_admins, який додає людина SQL-ом.
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-0000-0000-00000d3f00a1');
INSERT INTO public.app_settings (key, enabled) VALUES ('sa_demo', false) ON CONFLICT (key) DO NOTHING;

-- 1. Не-адмін: жодна sa_* не доступна (42501), таблиць не бачить, сам себе адміном не зробить.
SELECT pg_temp.sax_as('a2');
SELECT is(pg_temp.sax_denied(), 7, 'owner (Директор): усі сім sa_* → 42501');
SELECT is(public.is_platform_superadmin(), false, 'owner: is_platform_superadmin() = false');
SELECT pg_temp.sax_as('a3');
SELECT is(pg_temp.sax_denied(), 7, 'director (Менеджер): усі сім sa_* → 42501');
SELECT pg_temp.sax_as('a4');
SELECT is(pg_temp.sax_denied(), 7, 'logist (Логіст): усі сім sa_* → 42501');
SELECT pg_temp.sax_as('a5');
SELECT is(pg_temp.sax_denied(), 7, 'звичайний користувач (у т. ч. замовник підрозділу без ролі в компанії): усі сім sa_* → 42501');
SELECT is(pg_temp.sax_err($$SELECT * FROM public.sa_list_settings()$$), '42501 SUPERADMIN_REQUIRED', 'текст помилки — SUPERADMIN_REQUIRED');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d3f00a2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.platform_admins$$, '42501', NULL, 'owner не читає platform_admins');
SELECT throws_ok($$SELECT * FROM public.platform_audit_log$$, '42501', NULL, 'owner не читає platform_audit_log');
SELECT throws_ok($$INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-0000-0000-00000d3f00a2')$$, '42501', NULL, 'owner не додає себе в platform_admins');
SELECT throws_ok($$DELETE FROM public.platform_admins$$, '42501', NULL, 'не видаляє записів platform_admins');
SELECT throws_ok($$UPDATE public.platform_audit_log SET action = 'x'$$, '42501', NULL, 'не змінює журнал');
SELECT throws_ok($$SELECT public.sa_audit('x', 'y', 'z', NULL, NULL)$$, '42501', NULL, 'внутрішній sa_audit клієнтам недоступний');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.sa_list_settings()$$, '42501', NULL, 'anon: sa_list_settings');
SELECT throws_ok($$SELECT public.sa_set_setting('own_fleet', true)$$, '42501', NULL, 'anon: sa_set_setting');
SELECT throws_ok($$SELECT * FROM public.sa_search_orgs('x', 5, 0)$$, '42501', NULL, 'anon: sa_search_orgs');
SELECT throws_ok($$SELECT public.sa_get_org('9b000000-0000-0000-0000-00000000000a')$$, '42501', NULL, 'anon: sa_get_org');
SELECT throws_ok($$SELECT public.sa_set_org_feature('9b000000-0000-0000-0000-00000000000a', 'own_fleet', true)$$, '42501', NULL, 'anon: sa_set_org_feature');
SELECT throws_ok($$SELECT * FROM public.sa_list_audit()$$, '42501', NULL, 'anon: sa_list_audit');
SELECT throws_ok($$SELECT public.sa_create_setting('own_fleet', false)$$, '42501', NULL, 'anon: sa_create_setting');
SELECT throws_ok($$SELECT public.is_platform_superadmin()$$, '42501', NULL, 'anon: is_platform_superadmin');
SELECT throws_ok($$SELECT * FROM public.platform_admins$$, '42501', NULL, 'anon не читає platform_admins');
RESET ROLE;

-- Немає жодної функції додавання адмінів, а sa_* рівно сім.
SELECT is((SELECT count(*)::integer FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'sa\_%' AND p.proname <> 'sa_audit'), 7, 'рівно сім sa_* RPC');
SELECT is((SELECT count(*)::integer FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosrc ~* 'INSERT INTO public\.platform_admins' AND p.proname <> 'is_platform_superadmin'), 0, 'жодна функція не вписує в platform_admins');
SELECT is((SELECT count(*)::integer FROM public.platform_admins), 1, 'у platform_admins лише рядок, доданий вручну (міграція нікого не вписала)');

-- 2. Адмін: глобальні перемикачі.
SELECT pg_temp.sax_as('a1');
SELECT is(public.is_platform_superadmin(), true, 'адмін: is_platform_superadmin() = true');
SELECT is((SELECT count(*)::integer FROM public.sa_list_settings() WHERE key IN ('own_fleet', 'sa_demo')), 2, 'адмін бачить перемикачі (own_fleet із міграції й тестовий)');
SELECT is((SELECT enabled FROM public.sa_list_settings() WHERE key = 'sa_demo'), false, 'sa_demo вимкнений');
SELECT is((public.sa_set_setting('sa_demo', true) ->> 'changed'), 'true', 'увімкнення: changed');
SELECT is(public.feature_enabled('sa_demo'), true, 'feature_enabled бачить зміну');
SELECT is((SELECT updated_by FROM public.sa_list_settings() WHERE key = 'sa_demo'), '00000000-0000-0000-0000-00000d3f00a1'::uuid, 'хто змінив — адмін');
SELECT is((SELECT updated_by_email FROM public.sa_list_settings() WHERE key = 'sa_demo'), 'sa-a1@example.com', 'і його пошта');
SELECT is((SELECT before || after FROM public.platform_audit_log WHERE target_type = 'app_setting' AND target_id = 'sa_demo' ORDER BY id DESC LIMIT 1), '{"enabled": true}'::jsonb, 'журнал: перемикач (before false → after true)');
SELECT is((SELECT concat_ws('|', action, admin_id, jsonb_extract_path_text(before, 'enabled'), jsonb_extract_path_text(after, 'enabled')) FROM public.platform_audit_log WHERE target_id = 'sa_demo' ORDER BY id DESC LIMIT 1),
  'setting.set|00000000-0000-0000-0000-00000d3f00a1|false|true', 'журнал: дія, адмін, до й після');
SELECT is((public.sa_set_setting('sa_demo', true) ->> 'changed'), 'false', 'повторне те саме значення — без змін');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE target_id = 'sa_demo'), 1, 'і без запису в журнал');
SELECT is((public.sa_set_setting('sa_demo', false) ->> 'changed'), 'true', 'вимкнення');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE target_id = 'sa_demo'), 2, 'кожна зміна пише журнал');
SELECT is(public.org_has_feature('9b000000-0000-0000-0000-00000000000a', 'sa_demo'), false, 'глобально вимкнено — org_has_feature = false');

-- Невідомий ключ відхиляється (і нічого не пишеться).
SELECT is(pg_temp.sax_err($$SELECT public.sa_set_setting('made_up', true)$$), 'P0001 SA_UNKNOWN_MODULE', 'sa_set_setting: невідомий ключ');
SELECT is(pg_temp.sax_err($$SELECT public.sa_set_org_feature('9b000000-0000-0000-0000-00000000000a', 'made_up', true)$$), 'P0001 SA_UNKNOWN_MODULE', 'sa_set_org_feature: невідомий ключ');
SELECT is(pg_temp.sax_err($$SELECT public.sa_set_setting('sa_demo', NULL)$$), 'P0001 SA_INVALID', 'NULL замість enabled');
SELECT is((SELECT count(*)::integer FROM public.app_settings WHERE key = 'made_up'), 0, 'довільний ключ не створюється');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE target_id IN ('made_up')), 0, 'відхилене не потрапляє в журнал');

-- 3. Компанії: пошук і прапорці.
SELECT is((SELECT count(*)::integer FROM public.sa_search_orgs('SA AGRO')), 1, 'пошук за назвою (без урахування регістру)');
SELECT is((SELECT edrpou || '|' || legal_form || '|' || members FROM public.sa_search_orgs('sa agro')), '90909091|ТОВ|2', 'ЄДРПОУ, тип і кількість учасників (активні профілі)');
SELECT is((SELECT count(*)::integer FROM public.sa_search_orgs('90909')), 1, 'пошук за ЄДРПОУ');
SELECT is((SELECT max(total)::integer FROM public.sa_search_orgs('')), (SELECT count(*)::integer FROM public.organizations), 'порожній запит — усі компанії (total)');
SELECT is((SELECT count(*)::integer FROM public.sa_search_orgs('', 1, 0)), 1, 'limit');
SELECT is((SELECT max(total)::integer FROM public.sa_search_orgs('', 1, 0)), (SELECT count(*)::integer FROM public.organizations), 'total — усього збігів, не лише на сторінці');
SELECT is((SELECT count(*)::integer FROM public.sa_search_orgs('%')), 0, '% не є шаблоном');
SELECT is((public.sa_get_org('9b000000-0000-0000-0000-00000000000a') ->> 'name'), 'SA Agro Північ', 'sa_get_org: назва');
SELECT is((SELECT m ->> 'global_enabled' FROM jsonb_array_elements(public.sa_get_org('9b000000-0000-0000-0000-00000000000a') -> 'modules') AS m WHERE m ->> 'key' = 'sa_demo'), 'false', 'у вікні компанії видно, що модуль глобально вимкнено');
SELECT is(pg_temp.sax_err($$SELECT public.sa_get_org(gen_random_uuid())$$), 'P0002 SA_ORG_NOT_FOUND', 'невідома компанія');
SELECT is((public.sa_set_org_feature('9b000000-0000-0000-0000-00000000000a', 'sa_demo', true) ->> 'enabled'), 'true', 'прапорець компанії ввімкнено');
SELECT is((SELECT features ->> 'sa_demo' FROM public.organizations WHERE id = '9b000000-0000-0000-0000-00000000000a'), 'true', 'organizations.features оновлено');
SELECT is(public.org_has_feature('9b000000-0000-0000-0000-00000000000a', 'sa_demo'), false, 'прапорець є, але глобально вимкнено → модуль не діє');
SELECT is((SELECT m ->> 'org_enabled' FROM jsonb_array_elements(public.sa_get_org('9b000000-0000-0000-0000-00000000000a') -> 'modules') AS m WHERE m ->> 'key' = 'sa_demo'), 'true', 'sa_get_org показує прапорець компанії');
SELECT is((SELECT concat_ws('|', action, target_type, target_id, before ->> 'sa_demo', after ->> 'sa_demo') FROM public.platform_audit_log WHERE target_type = 'organization' ORDER BY id DESC LIMIT 1),
  'org.feature.set|organization|9b000000-0000-0000-0000-00000000000a|true', 'журнал: компанія, до (null — прапорця не було, concat_ws його пропускає) і після');
SELECT is(pg_temp.sax_err($$SELECT public.sa_set_org_feature(gen_random_uuid(), 'sa_demo', true)$$), 'P0002 SA_ORG_NOT_FOUND', 'невідома компанія в sa_set_org_feature');
SELECT is((public.sa_set_org_feature('9b000000-0000-0000-0000-00000000000a', 'sa_demo', true) ->> 'enabled'), 'true', 'повторне те саме значення');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE target_type = 'organization'), 1, 'без запису в журнал');
SELECT public.sa_set_setting('sa_demo', true);
SELECT is(public.org_has_feature('9b000000-0000-0000-0000-00000000000a', 'sa_demo'), true, 'глобально ввімкнено + прапорець компанії → модуль працює');
SELECT public.sa_set_org_feature('9b000000-0000-0000-0000-00000000000a', 'sa_demo', false);
SELECT is((SELECT features ->> 'sa_demo' FROM public.organizations WHERE id = '9b000000-0000-0000-0000-00000000000a'), 'false', 'вимкнення прапорця компанії');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE target_type = 'organization'), 2, 'кожна зміна — запис');

-- 4. Журнал: фільтри за типом і датою, лише читання.
SELECT is((SELECT count(*)::integer FROM public.sa_list_audit(NULL, NULL, 'organization')), 2, 'фільтр за типом: organization');
SELECT is((SELECT count(*)::integer FROM public.sa_list_audit(NULL, NULL, 'app_setting')), 3, 'фільтр за типом: app_setting (увімкнення, вимкнення, повторне увімкнення sa_demo)');
SELECT is((SELECT count(*)::integer FROM public.sa_list_audit(now() + interval '1 day', NULL)), 0, 'фільтр «від» у майбутньому — порожньо');
SELECT is((SELECT count(*)::integer FROM public.sa_list_audit(NULL, now() - interval '1 day')), 0, 'фільтр «до» у минулому — порожньо');
SELECT is((SELECT count(*)::integer FROM public.sa_list_audit(now() - interval '1 hour', now() + interval '1 hour')), (SELECT count(*)::integer FROM public.platform_audit_log), 'за останню годину — усі записи');
SELECT is((SELECT id FROM public.sa_list_audit() ORDER BY at DESC, id DESC LIMIT 1), (SELECT max(id) FROM public.platform_audit_log), 'найновіші зверху');
SELECT is((SELECT admin_email FROM public.sa_list_audit() LIMIT 1), 'sa-a1@example.com', 'у журналі пошта адміна');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE admin_id IS NULL), 0, 'кожен запис має адміна');
SELECT is((SELECT count(*)::integer FROM public.sa_list_audit(NULL, NULL, NULL, 2, 0)), 2, 'limit журналу');

-- 5. Відсутній рядок app_settings: адмін створює його (лише відомий модуль), це пишеться в журнал.
SELECT pg_temp.sax_as('a1');
DELETE FROM public.app_settings WHERE key = 'own_fleet';
SELECT is(public.feature_enabled('own_fleet'), false, 'немає рядка → модуль вимкнено');
SELECT is((public.sa_create_setting('own_fleet') ->> 'enabled'), 'false', 'sa_create_setting створює рядок вимкненим');
SELECT is((SELECT enabled FROM public.app_settings WHERE key = 'own_fleet'), false, 'рядок з’явився');
SELECT is((SELECT concat_ws('|', action, admin_id, after ->> 'enabled') FROM public.platform_audit_log WHERE target_id = 'own_fleet' ORDER BY id DESC LIMIT 1),
  'setting.create|00000000-0000-0000-0000-00000d3f00a1|false', 'журнал: створення рядка');
SELECT is(pg_temp.sax_err($$SELECT public.sa_create_setting('own_fleet')$$), 'P0001 SA_ALREADY_EXISTS', 'другий раз — рядок уже є');
SELECT is(pg_temp.sax_err($$SELECT public.sa_create_setting('made_up')$$), 'P0001 SA_UNKNOWN_MODULE', 'довільний ключ не створюється');

-- Звичайний користувач далі нічого не бачить (навіть після змін).
SELECT pg_temp.sax_as('a2');
SELECT is(pg_temp.sax_denied(), 7, 'owner і після змін адміна: усе так само закрито');

SELECT * FROM finish();
ROLLBACK;
