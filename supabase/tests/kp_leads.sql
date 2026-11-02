-- kp_leads (20261111090000_kp_leads.sql): RLS увімкнено, політик немає, anon/authenticated не мають доступу, service_role пише.
-- Run with pgTAP: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(9);

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.kp_leads'::regclass), 'RLS увімкнено');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kp_leads'), 0, 'політик немає');
SELECT ok(NOT has_table_privilege('anon', 'public.kp_leads', 'INSERT'), 'anon не має INSERT');
SELECT ok(NOT has_table_privilege('anon', 'public.kp_leads', 'SELECT'), 'anon не має SELECT');
SELECT ok(NOT has_table_privilege('authenticated', 'public.kp_leads', 'SELECT'), 'authenticated не має SELECT');
SELECT ok(has_table_privilege('service_role', 'public.kp_leads', 'INSERT'), 'service_role має INSERT');

SET LOCAL ROLE service_role;
INSERT INTO public.kp_leads (name, company, phone) VALUES ('Іван', 'ТОВ Тест', '+380501112233');
SELECT is((SELECT status FROM public.kp_leads WHERE company = 'ТОВ Тест'), 'new', 'status за замовчуванням new');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok($$INSERT INTO public.kp_leads (name, company, phone) VALUES ('x', 'y', '+380501112233')$$, '42501', NULL, 'anon не може вставити');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.kp_leads$$, '42501', NULL, 'authenticated не може читати');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
