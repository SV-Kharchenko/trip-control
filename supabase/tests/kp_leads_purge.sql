-- purge_old_kp_leads (20261112090000_kp_leads_purge.sql): старший за рік рядок видаляється, свіжий лишається, anon/authenticated не викликають.
-- Run with pgTAP: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(7);

INSERT INTO public.kp_leads (name, company, phone, created_at) VALUES
  ('Старий', 'purge-old', '+380501112233', now() - interval '13 months'),
  ('Свіжий', 'purge-fresh', '+380501112244', now() - interval '11 months');

SELECT ok(NOT has_function_privilege('anon', 'public.purge_old_kp_leads()', 'EXECUTE'), 'anon не має EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_old_kp_leads()', 'EXECUTE'), 'authenticated не має EXECUTE');
SELECT ok(has_function_privilege('service_role', 'public.purge_old_kp_leads()', 'EXECUTE'), 'service_role має EXECUTE');

SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.purge_old_kp_leads()$$, '42501', NULL, 'anon не може викликати');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.purge_old_kp_leads()$$, '42501', NULL, 'authenticated не може викликати');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT is(public.purge_old_kp_leads() >= 1, true, 'service_role видаляє старі');
RESET ROLE;

SELECT is((SELECT array_agg(company ORDER BY company) FROM public.kp_leads WHERE company LIKE 'purge-%'), ARRAY['purge-fresh']::text[], 'старий видалено, свіжий лишився');

SELECT * FROM finish();
ROLLBACK;
