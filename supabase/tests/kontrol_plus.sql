-- Контроль+ gating (20261022090000_kontrol_plus_access.sql, 20261022091000_kontrol_plus_clients_reports.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(35);

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

-- Spoofed claims. A user can put anything into user_metadata (auth.updateUser), and app_metadata is shown in the
-- JWT too: neither makes is_service_role() true; only the top-level role of a JWT signed by Supabase does.
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","user_role":"service_role",'
  '"user_metadata":{"role":"service_role"},"app_metadata":{"role":"service_role","claims_admin":true}}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.is_service_role(), false, 'spoofed claims: metadata role does not make service role');
SELECT throws_ok(
  $$UPDATE public.organizations SET plan = 'company' WHERE id = '40000000-0000-0000-0000-00000000000a'$$,
  '42501',
  NULL,
  'spoofed claims: owner still cannot change the plan'
);
RESET ROLE;
-- Even a top-level service_role claim inside an authenticated session (PostgREST never does this: it switches the
-- role from the verified JWT) does not pass the Контроль+ guards — they check the session role.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"service_role"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$UPDATE public.organizations SET plan = 'company' WHERE id = '40000000-0000-0000-0000-00000000000a'$$,
  '42501',
  NULL,
  'service_role claim in an authenticated session: plan guard holds'
);
SELECT throws_ok(
  $$INSERT INTO public.org_directors (org_id, user_id)
    VALUES ('40000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c3')$$,
  '42501',
  NULL,
  'service_role claim in an authenticated session: directors guard holds'
);
SELECT throws_ok(
  $$SELECT public.set_org_plan('40000000-0000-0000-0000-00000000000b', 'control_plus')$$,
  '42501',
  NULL,
  'service_role claim in an authenticated session: set_org_plan refused'
);
RESET ROLE;

-- Site flows on the company plan work as before: signup, accepting an invite (old org removed), deleting an org.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"service_role"}', true);
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c7', 'authenticated', 'authenticated',
   'invitee.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 7"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c8', 'authenticated', 'authenticated',
   'cp-invitee.kp@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"KP 8"}', now(), now());
SELECT is(
  (SELECT o.plan FROM public.profiles AS p JOIN public.organizations AS o ON o.id = p.org_id
   WHERE p.id = '00000000-0000-0000-0000-0000000000c7'),
  'company',
  'signup: new company starts on the company plan'
);
CREATE TEMP TABLE kp_old_orgs AS
SELECT id AS user_id, org_id FROM public.profiles
WHERE id IN ('00000000-0000-0000-0000-0000000000c7', '00000000-0000-0000-0000-0000000000c8');
INSERT INTO public.org_invites (org_id, email, token_hash, invited_by, expires_at)
VALUES ('40000000-0000-0000-0000-00000000000a', 'invitee.kp@example.com', 'kp-test-token-7',
        '00000000-0000-0000-0000-0000000000c1', now() + interval '1 day'),
       ('40000000-0000-0000-0000-00000000000a', 'cp-invitee.kp@example.com', 'kp-test-token-8',
        '00000000-0000-0000-0000-0000000000c1', now() + interval '1 day');
SELECT lives_ok(
  $$SELECT * FROM public.accept_org_invite('kp-test-token-7', '00000000-0000-0000-0000-0000000000c7', 'invitee.kp@example.com')$$,
  'accept invite: user from a company-plan org joins'
);
SELECT is(
  (SELECT count(*)::integer FROM public.organizations
   WHERE id = (SELECT org_id FROM kp_old_orgs WHERE user_id = '00000000-0000-0000-0000-0000000000c7')),
  0,
  'accept invite: the empty company-plan org is removed as before'
);
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('40000000-0000-0000-0000-00000000000d', 'KP delete me', 'solo');
INSERT INTO public.org_directors (org_id, user_id)
VALUES ('40000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000c5');
SELECT lives_ok(
  $$DELETE FROM public.organizations WHERE id = '40000000-0000-0000-0000-00000000000d'$$,
  'delete org: a company-plan org (with a director row) is deleted as before'
);
-- Documented limit (ON DELETE RESTRICT): an org that has clients is not deleted silently.
SELECT public.set_org_plan((SELECT org_id FROM kp_old_orgs WHERE user_id = '00000000-0000-0000-0000-0000000000c8'), 'control_plus');
INSERT INTO public.clients (org_id, name)
SELECT org_id, 'Client of an old org' FROM kp_old_orgs WHERE user_id = '00000000-0000-0000-0000-0000000000c8';
SELECT throws_ok(
  $$SELECT * FROM public.accept_org_invite('kp-test-token-8', '00000000-0000-0000-0000-0000000000c8', 'cp-invitee.kp@example.com')$$,
  '23503',
  NULL,
  'accept invite: refused while the old Контроль+ org has clients'
);
SELECT throws_ok(
  format('DELETE FROM public.organizations WHERE id = %L',
         (SELECT org_id FROM kp_old_orgs WHERE user_id = '00000000-0000-0000-0000-0000000000c8')),
  '23503',
  NULL,
  'delete org: refused while it has clients'
);

SELECT * FROM finish();
ROLLBACK;
