-- Контроль+ gating (20261022090000_kontrol_plus_access.sql, 20261022091000_kontrol_plus_clients_reports.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(24);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"service_role"}',
  true
);

-- A: control_plus (owner c1, logist c2), B: company (owner c3), C: control_plus (owner c4), c5: director of A.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('40000000-0000-0000-0000-00000000000a', 'KP plan', 'team'),
       ('40000000-0000-0000-0000-00000000000b', 'KP company', 'solo'),
       ('40000000-0000-0000-0000-00000000000c', 'KP foreign', 'solo');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated',
   'owner.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 1"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated',
   'logist.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 2"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c3', 'authenticated', 'authenticated',
   'company.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 3"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c4', 'authenticated', 'authenticated',
   'foreign.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 4"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c5', 'authenticated', 'authenticated',
   'director.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 5"}', now(), now());

UPDATE public.profiles
SET org_id = CASE id
      WHEN '00000000-0000-0000-0000-0000000000c1' THEN '40000000-0000-0000-0000-00000000000a'::uuid
      WHEN '00000000-0000-0000-0000-0000000000c2' THEN '40000000-0000-0000-0000-00000000000a'::uuid
      WHEN '00000000-0000-0000-0000-0000000000c3' THEN '40000000-0000-0000-0000-00000000000b'::uuid
      ELSE '40000000-0000-0000-0000-00000000000c'::uuid
    END,
    is_approved = true,
    org_role = CASE id WHEN '00000000-0000-0000-0000-0000000000c2' THEN 'logist' ELSE 'owner' END,
    member_status = 'active'
WHERE id IN ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2',
             '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c4');

SELECT is(
  (SELECT plan FROM public.organizations WHERE id = '40000000-0000-0000-0000-00000000000a'),
  'company',
  'organizations start on the company plan'
);
SELECT public.set_org_plan('40000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('40000000-0000-0000-0000-00000000000c', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id)
VALUES ('40000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c5');

INSERT INTO public.clients (id, org_id, name, legal_form, edrpou)
VALUES ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-00000000000a', 'Client A', 'tov', '12345678'),
       ('41000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-00000000000c', 'Client C', 'fop', NULL);
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status)
VALUES ('42000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-00000000000a',
        '00000000-0000-0000-0000-0000000000c2', 'KP trip', '{}'::jsonb,
        '{"grossIncome":"1000","netProfit":"200"}'::jsonb, 'accepted');
INSERT INTO public.calculation_clients (calculation_id, client_id)
VALUES ('42000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001');

-- Owner of a control_plus org: full access, but the plan itself is server-managed.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.current_org_is_control_plus(), true, 'owner: own org is on Контроль+');
SELECT is((SELECT count(*)::integer FROM public.clients), 1, 'owner: sees own org clients only');
SELECT lives_ok(
  $$INSERT INTO public.clients (org_id, name) VALUES ('40000000-0000-0000-0000-00000000000a', 'Owner client')$$,
  'owner: adds a client'
);
SELECT throws_ok(
  $$UPDATE public.organizations SET plan = 'company' WHERE id = '40000000-0000-0000-0000-00000000000a'$$,
  '42501',
  NULL,
  'owner: cannot change the plan'
);
SELECT throws_ok(
  $$SELECT public.set_org_plan('40000000-0000-0000-0000-00000000000b', 'control_plus')$$,
  '42501',
  NULL,
  'owner: cannot call set_org_plan'
);
SELECT throws_ok(
  $$INSERT INTO public.org_directors (org_id, user_id)
    VALUES ('40000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c3')$$,
  '42501',
  NULL,
  'owner: cannot appoint directors'
);
SELECT is(
  (SELECT count(*)::integer FROM public.report_plan_fact(public.ua_today() - 30, public.ua_today() + 1, 'client')),
  1,
  'owner: plan/fact report works'
);
RESET ROLE;

-- Logist: writes, but cannot delete clients.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$UPDATE public.clients SET phone = '+380500000000' WHERE id = '41000000-0000-0000-0000-000000000001'$$,
  'logist: edits a client'
);
DELETE FROM public.clients WHERE id = '41000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT count(*)::integer FROM public.clients WHERE id = '41000000-0000-0000-0000-000000000001'),
  1,
  'logist: cannot delete a client'
);
RESET ROLE;

-- Director: read-only.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c5","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role FROM public.kp_context()), 'director', 'director: context role');
SELECT is((SELECT count(*)::integer FROM public.clients), 2, 'director: reads the org clients');
SELECT is((SELECT count(*)::integer FROM public.client_history('41000000-0000-0000-0000-000000000001')), 1,
  'director: reads client history');
SELECT throws_ok(
  $$INSERT INTO public.clients (org_id, name) VALUES ('40000000-0000-0000-0000-00000000000a', 'Director client')$$,
  '42501',
  NULL,
  'director: cannot add a client'
);
UPDATE public.clients SET notes = 'director' WHERE id = '41000000-0000-0000-0000-000000000001';
DELETE FROM public.calculation_clients WHERE calculation_id = '42000000-0000-0000-0000-000000000001';
RESET ROLE;
SELECT is(
  (SELECT notes FROM public.clients WHERE id = '41000000-0000-0000-0000-000000000001'),
  NULL,
  'director: cannot edit a client'
);
SELECT is(
  (SELECT count(*)::integer FROM public.calculation_clients WHERE calculation_id = '42000000-0000-0000-0000-000000000001'),
  1,
  'director: cannot unlink trips'
);

-- Org without the plan: sees nothing, cannot write, RPCs refuse.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.current_org_is_control_plus(), false, 'company plan: not Контроль+');
SELECT is((SELECT count(*)::integer FROM public.clients), 0, 'company plan: sees no clients');
SELECT is((SELECT count(*)::integer FROM public.calculation_clients), 0, 'company plan: sees no links');
SELECT throws_ok(
  $$INSERT INTO public.clients (org_id, name) VALUES ('40000000-0000-0000-0000-00000000000b', 'No plan client')$$,
  '42501',
  NULL,
  'company plan: cannot add a client'
);
SELECT throws_ok(
  $$SELECT * FROM public.report_plan_fact(public.ua_today() - 30, public.ua_today(), 'logist')$$,
  '42501',
  NULL,
  'company plan: report refused'
);
RESET ROLE;

-- Foreign control_plus org: sees only its own data.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT array_agg(name) FROM public.clients), ARRAY['Client C'], 'foreign org: sees only own clients');
SELECT throws_ok(
  $$SELECT * FROM public.client_history('41000000-0000-0000-0000-000000000001')$$,
  'P0001',
  NULL,
  'foreign org: no history of another org client'
);
SELECT throws_ok(
  $$INSERT INTO public.clients (org_id, name) VALUES ('40000000-0000-0000-0000-00000000000a', 'Foreign client')$$,
  '42501',
  NULL,
  'foreign org: cannot add a client into another org'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
