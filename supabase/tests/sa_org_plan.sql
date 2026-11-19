-- Кабінет суперадміна: перемикач тарифу компанії (20261129090000_sa_org_plan.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(30);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d4f00b1","role":"service_role"}', true);

CREATE FUNCTION pg_temp.sap_err(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.sap_err(text) TO PUBLIC;

-- b1 суперадмін; b2 директор (owner) компанії A (не суперадмін).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('9d000000-0000-0000-0000-00000000000a', 'SAPPLAN Компанія', 'team');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d4f00' || k)::uuid, 'authenticated', 'authenticated',
       'sap-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'SAP ' || k), now(), now()
FROM unnest(ARRAY['b1', 'b2']) AS k;
UPDATE public.profiles
SET org_id = '9d000000-0000-0000-0000-00000000000a', org_role = 'owner', member_status = 'active', is_approved = true
WHERE id = '00000000-0000-0000-0000-00000d4f00b2';
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-0000-0000-00000d4f00b1');

-- 1. Гранти: set_org_plan як і раніше лише service_role.
SELECT is(has_function_privilege('service_role', 'public.set_org_plan(uuid, text)', 'EXECUTE'), true, 'set_org_plan: service_role має EXECUTE');
SELECT is(has_function_privilege('authenticated', 'public.set_org_plan(uuid, text)', 'EXECUTE'), false, 'set_org_plan: authenticated без EXECUTE');
SELECT is(has_function_privilege('anon', 'public.set_org_plan(uuid, text)', 'EXECUTE'), false, 'set_org_plan: anon без EXECUTE');
SELECT is(has_function_privilege('anon', 'public.sa_set_org_plan(uuid, text)', 'EXECUTE'), false, 'sa_set_org_plan: anon без EXECUTE');
SELECT is(has_function_privilege('authenticated', 'public.sa_set_org_plan(uuid, text)', 'EXECUTE'), true, 'sa_set_org_plan: authenticated має EXECUTE');
SELECT is((SELECT plan FROM public.organizations WHERE id = '9d000000-0000-0000-0000-00000000000a'), 'company', 'стартовий тариф — company');

-- 2. Не-суперадмін (authenticated owner) отримує відмову, тариф не змінюється.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d4f00b2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', 'control_plus')$$, '42501', 'SUPERADMIN_REQUIRED', 'owner: sa_set_org_plan → SUPERADMIN_REQUIRED');
SELECT throws_ok($$SELECT public.set_org_plan('9d000000-0000-0000-0000-00000000000a', 'control_plus')$$, '42501', NULL, 'owner: set_org_plan недоступна');
SELECT throws_ok($$UPDATE public.organizations SET plan = 'control_plus' WHERE id = '9d000000-0000-0000-0000-00000000000a'$$, '42501', NULL, 'owner: прямий UPDATE plan заборонено');
SELECT throws_ok($$SELECT * FROM public.sa_search_orgs('SAPPLAN', 5, 0)$$, '42501', 'SUPERADMIN_REQUIRED', 'owner: sa_search_orgs відмовляє');
RESET ROLE;
SELECT is((SELECT plan FROM public.organizations WHERE id = '9d000000-0000-0000-0000-00000000000a'), 'company', 'після відмов тариф company');

-- 3. anon.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', 'control_plus')$$, '42501', NULL, 'anon: sa_set_org_plan відмовляє');
RESET ROLE;

-- 4. Суперадмін (роль authenticated, як у PostgREST): зміна тарифу + журнал.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d4f00b1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', 'control_plus') ->> 'plan'), 'control_plus', 'суперадмін: відповідь містить новий тариф');
RESET ROLE;
SELECT is((SELECT plan FROM public.organizations WHERE id = '9d000000-0000-0000-0000-00000000000a'), 'control_plus', 'тариф став control_plus');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE action = 'org.plan.set' AND target_id = '9d000000-0000-0000-0000-00000000000a'), 1, 'у журналі один рядок org.plan.set');
SELECT is((SELECT concat_ws('|', admin_id, target_type, before ->> 'plan', after ->> 'plan') FROM public.platform_audit_log WHERE action = 'org.plan.set' ORDER BY id DESC LIMIT 1),
  '00000000-0000-0000-0000-00000d4f00b1|organization|company|control_plus', 'журнал: хто, що, було → стало');

-- 5. Повторна та сама зміна нічого не пише.
SET LOCAL ROLE authenticated;
SELECT is((public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', 'control_plus') ->> 'plan'), 'control_plus', 'повторно те саме значення — без помилки');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE action = 'org.plan.set'), 1, 'повторна зміна не пише в журнал');

-- 6. Зворотна зміна; службовий прапорець не лишається, прямий UPDATE суперадміна теж закритий.
SET LOCAL ROLE authenticated;
SELECT is((public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', 'company') ->> 'plan'), 'company', 'повернення на company');
SELECT is(coalesce(current_setting('kp.sa_plan_org', true), ''), '', 'службовий прапорець тригера скинуто');
UPDATE public.organizations SET plan = 'control_plus' WHERE id = '9d000000-0000-0000-0000-00000000000a';
RESET ROLE;
SELECT is((SELECT plan FROM public.organizations WHERE id = '9d000000-0000-0000-0000-00000000000a'), 'company', 'суперадмін напряму UPDATE plan не змінює (RLS / тригер; лише через sa_set_org_plan)');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE action = 'org.plan.set'), 2, 'у журналі два записи');
SELECT is((SELECT concat_ws('|', before ->> 'plan', after ->> 'plan') FROM public.platform_audit_log WHERE action = 'org.plan.set' ORDER BY id DESC LIMIT 1), 'control_plus|company', 'журнал: control_plus → company');

-- 7. Помилки.
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.sap_err($$SELECT public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', 'gold')$$), 'P0001 SA_INVALID', 'неправильний план → SA_INVALID');
SELECT is(pg_temp.sap_err($$SELECT public.sa_set_org_plan('9d000000-0000-0000-0000-00000000000a', NULL)$$), 'P0001 SA_INVALID', 'NULL → SA_INVALID');
SELECT is(pg_temp.sap_err($$SELECT public.sa_set_org_plan(gen_random_uuid(), 'control_plus')$$), 'P0002 SA_ORG_NOT_FOUND', 'невідома компанія → SA_ORG_NOT_FOUND');

-- 8. sa_search_orgs і sa_get_org повертають plan; set_org_plan від service_role працює як раніше.
SELECT is((SELECT plan FROM public.sa_search_orgs('SAPPLAN') LIMIT 1), 'company', 'sa_search_orgs повертає plan');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d4f00b1","role":"service_role"}', true);
SELECT public.set_org_plan('9d000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT is((SELECT count(*)::integer FROM public.platform_audit_log WHERE action = 'org.plan.set'), 2, 'set_org_plan (service_role) працює й журнал не пише');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d4f00b1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT plan FROM public.sa_search_orgs('SAPPLAN') LIMIT 1), 'control_plus', 'sa_search_orgs: plan після set_org_plan');
SELECT is((public.sa_get_org('9d000000-0000-0000-0000-00000000000a') ->> 'plan'), 'control_plus', 'sa_get_org повертає plan');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
