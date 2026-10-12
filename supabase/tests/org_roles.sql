BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(26);

-- Fixed fixture IDs keep the assertions readable. Everything is rolled back.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"service_role"}',
  true
);

INSERT INTO public.organizations (id, name, work_mode)
VALUES ('10000000-0000-0000-0000-000000000001', 'RLS fixture target', 'solo');

INSERT INTO public.company_settings (org_id, settings)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '{"fuelPrice":45,"logists_see_all":false}'::jsonb
);

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
   'owner.rls@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"RLS owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
   'manager.rls@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"RLS manager"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated',
   'logist.rls@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"RLS logist"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated',
   'disabled.rls@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"RLS disabled"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated',
   'foreign.rls@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"RLS foreign"}', now(), now());

UPDATE public.profiles
SET org_id = '10000000-0000-0000-0000-000000000001',
    is_approved = true,
    org_role = CASE id
      WHEN '00000000-0000-0000-0000-000000000001' THEN 'owner'
      WHEN '00000000-0000-0000-0000-000000000002' THEN 'manager'
      ELSE 'logist'
    END,
    member_status = CASE
      WHEN id = '00000000-0000-0000-0000-000000000004' THEN 'disabled'
      ELSE 'active'
    END
WHERE id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004'
);

DELETE FROM public.organizations
WHERE name LIKE 'RLS %'
  AND id <> '10000000-0000-0000-0000-000000000001'
  AND id <> (SELECT org_id FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000005');

INSERT INTO public.calculations (org_id, user_id, name, inputs, results)
VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner calc', '{}'::jsonb, '{"routeName":"owner"}'::jsonb),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'manager calc', '{}'::jsonb, '{"routeName":"manager"}'::jsonb),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'logist calc', '{}'::jsonb, '{"routeName":"logist"}'::jsonb),
  ((SELECT org_id FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000005'),
   '00000000-0000-0000-0000-000000000005', 'foreign calc', '{}'::jsonb, '{"routeName":"foreign"}'::jsonb);

-- owner: all rows in own organization, never foreign rows
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.calculations), 3, 'owner sees all organization calculations');
SELECT is((SELECT count(*)::integer FROM public.profiles), 4, 'owner sees active and disabled organization members');
RESET ROLE;

-- manager: same data visibility as owner
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.calculations), 3, 'manager sees all organization calculations');
SELECT is((SELECT count(*)::integer FROM public.profiles), 4, 'manager sees the organization directory');
RESET ROLE;

-- logist: own calculations only while logists_see_all=false
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq(
  'SELECT name FROM public.calculations ORDER BY name',
  ARRAY['logist calc']::text[],
  'logist sees only own calculations by default'
);
RESET ROLE;

-- foreign and disabled users do not leak organization data
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq(
  'SELECT name FROM public.calculations ORDER BY name',
  ARRAY['foreign calc']::text[],
  'foreign user sees only their organization'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.calculations), 0, 'disabled member sees no calculations');
SELECT is((SELECT count(*)::integer FROM public.organizations), 0, 'disabled member sees no organization');
RESET ROLE;

-- company settings: owner and manager edit norms; visibility remains owner-only
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$UPDATE public.company_settings SET settings = jsonb_set(settings, '{fuelPrice}', '46') WHERE org_id = '10000000-0000-0000-0000-000000000001'$$,
  'owner updates operational settings'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$UPDATE public.company_settings SET settings = jsonb_set(settings, '{fuelPrice}', '50') WHERE org_id = '10000000-0000-0000-0000-000000000001'$$,
  'manager updates operational settings'
);
SELECT throws_ok(
  $$UPDATE public.company_settings SET settings = jsonb_set(settings, '{logists_see_all}', 'true') WHERE org_id = '10000000-0000-0000-0000-000000000001'$$,
  '42501',
  'LOGIST_VISIBILITY_OWNER_ONLY',
  'manager cannot change logist visibility'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
UPDATE public.company_settings
SET settings = jsonb_set(settings, '{fuelPrice}', '99')
WHERE org_id = '10000000-0000-0000-0000-000000000001';
RESET ROLE;
SELECT is(
  (SELECT settings ->> 'fuelPrice' FROM public.company_settings WHERE org_id = '10000000-0000-0000-0000-000000000001'),
  '50',
  'logist cannot update company settings'
);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$UPDATE public.company_settings SET settings = jsonb_set(settings, '{logists_see_all}', 'true') WHERE org_id = '10000000-0000-0000-0000-000000000001'$$,
  'owner enables shared calculation visibility'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.calculations), 3, 'logist sees team calculations after owner opt-in');
SELECT lives_ok(
  $$INSERT INTO public.calculations (org_id, user_id, name, inputs, results)
    VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            'logist forced ownership', '{}'::jsonb, '{"routeName":"forced"}'::jsonb)$$,
  'logist can insert a calculation'
);
SELECT is(
  (SELECT count(*)::integer FROM public.calculations WHERE name = 'logist forced ownership' AND user_id = auth.uid()),
  1,
  'insert trigger forces calculation author to current user'
);
RESET ROLE;

-- mode and last-owner invariants
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
UPDATE public.organizations SET work_mode = 'team' WHERE id = '10000000-0000-0000-0000-000000000001';
RESET ROLE;
SELECT is(
  (SELECT work_mode FROM public.organizations WHERE id = '10000000-0000-0000-0000-000000000001'),
  'solo',
  'manager cannot change organization mode'
);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$UPDATE public.organizations SET work_mode = 'team' WHERE id = '10000000-0000-0000-0000-000000000001'$$,
  'owner enables team mode'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"service_role"}', true);
SELECT throws_ok(
  $$UPDATE public.profiles SET org_role = 'manager' WHERE id = '00000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'LAST_ACTIVE_OWNER',
  'last active owner cannot be demoted'
);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$UPDATE public.organizations SET work_mode = 'solo' WHERE id = '10000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'SOLO_HAS_ACTIVE_MEMBERS',
  'team cannot become solo while other active members exist'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"service_role"}', true);
SELECT lives_ok(
  $$UPDATE public.profiles SET member_status = 'disabled'
    WHERE org_id = '10000000-0000-0000-0000-000000000001'
      AND id <> '00000000-0000-0000-0000-000000000001'$$,
  'trusted API can disable the remaining team members'
);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$UPDATE public.organizations SET work_mode = 'solo' WHERE id = '10000000-0000-0000-0000-000000000001'$$,
  'owner returns to solo after disabling other members'
);
RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM public.calculations WHERE org_id = '10000000-0000-0000-0000-000000000001'),
  4,
  'mode switching preserves calculations'
);
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE org_id = '10000000-0000-0000-0000-000000000001'),
  4,
  'disabling members preserves their profiles'
);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"service_role"}', true);
UPDATE public.organizations
SET status = 'blocked'
WHERE id = '10000000-0000-0000-0000-000000000001';

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.calculations), 0, 'blocked organization cannot read calculations directly');
SELECT is((SELECT count(*)::integer FROM public.company_settings), 0, 'blocked organization cannot read settings directly');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
