-- Per-user block (20261016130000_user_block_rls.sql). Run with pgTAP against a
-- database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(12);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"service_role"}',
  true
);

INSERT INTO public.organizations (id, name, work_mode)
VALUES ('30000000-0000-0000-0000-000000000001', 'Block fixture', 'team');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated',
   'active.block@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"Block active"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated',
   'blocked.block@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"Block blocked"}', now(), now());

UPDATE public.profiles
SET org_id = '30000000-0000-0000-0000-000000000001',
    is_approved = true,
    org_role = CASE id WHEN '00000000-0000-0000-0000-0000000000b1' THEN 'owner' ELSE 'logist' END,
    member_status = 'active'
WHERE id IN ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2');

INSERT INTO public.calculations (org_id, user_id, name, inputs, results)
VALUES ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b2', 'blocked user calc', '{}'::jsonb, '{}'::jsonb);

-- What the admin panel does on «Заблоковано» (api/admin.js, ban_duration 876000h).
UPDATE auth.users
SET banned_until = now() + interval '876000 hours'
WHERE id = '00000000-0000-0000-0000-0000000000b2';

-- Active user: writes still work.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.is_user_blocked(), false, 'active user is not blocked');
SELECT lives_ok(
  $$INSERT INTO public.calculations (org_id, user_id, name, inputs, results)
    VALUES ('30000000-0000-0000-0000-000000000001', auth.uid(), 'active insert', '{}'::jsonb, '{}'::jsonb)$$,
  'active user inserts into calculations'
);
RESET ROLE;

-- Blocked user with a token issued before the ban.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.is_user_blocked(), true, 'banned user is blocked');
SELECT throws_ok(
  $$INSERT INTO public.calculations (org_id, user_id, name, inputs, results)
    VALUES ('30000000-0000-0000-0000-000000000001', auth.uid(), 'blocked insert', '{}'::jsonb, '{}'::jsonb)$$,
  '42501',
  NULL,
  'blocked user cannot insert into calculations'
);
SELECT is(
  (SELECT count(*)::integer FROM public.calculations WHERE name = 'blocked user calc'),
  1,
  'blocked user can still read own calculations'
);
UPDATE public.calculations SET name = 'blocked rename' WHERE name = 'blocked user calc';
DELETE FROM public.calculations WHERE name = 'blocked user calc';
SELECT is(
  (SELECT count(*)::integer FROM public.calculations WHERE name = 'blocked user calc'),
  1,
  'blocked user cannot update or delete own calculations'
);
SELECT throws_ok(
  $$INSERT INTO public.route_templates (org_id, owner_user_id, scope, name, params)
    VALUES ('30000000-0000-0000-0000-000000000001', auth.uid(), 'personal', 'blocked tpl', '{}'::jsonb)$$,
  '42501',
  NULL,
  'blocked user cannot insert route templates'
);
-- The restrictive UPDATE policy hides the row, so this changes nothing.
UPDATE public.profiles SET is_approved = false, role = 'admin' WHERE id = auth.uid();
RESET ROLE;
SELECT ok(
  (SELECT role IS DISTINCT FROM 'admin' AND is_approved FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000b2'),
  'blocked user cannot change own privileged profile columns'
);

-- Active user still cannot unlock themselves through profiles.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid()$$,
  '42501',
  NULL,
  'user cannot change own role'
);
SELECT throws_ok(
  $$UPDATE public.profiles SET is_approved = false WHERE id = auth.uid()$$,
  '42501',
  NULL,
  'user cannot change own is_approved'
);
RESET ROLE;

-- Unblock (ban_duration 'none') restores writes.
UPDATE auth.users SET banned_until = NULL WHERE id = '00000000-0000-0000-0000-0000000000b2';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.is_user_blocked(), false, 'unblocked user is not blocked');
SELECT lives_ok(
  $$INSERT INTO public.calculations (org_id, user_id, name, inputs, results)
    VALUES ('30000000-0000-0000-0000-000000000001', auth.uid(), 'unblocked insert', '{}'::jsonb, '{}'::jsonb)$$,
  'unblocked user inserts into calculations again'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
