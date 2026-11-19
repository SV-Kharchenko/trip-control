-- Контроль+ GPS: групи юнітів, тип юніта, провайдер agrocontrol (20261128090000_kp_gps_groups.sql).
-- Run with pgTAP against a database that has all migrations and supabase_vault: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim and a Vault stub.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(39);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"7a000000-0000-0000-0000-0000000000e1","role":"service_role"}',
  true
);

-- A, C: control_plus (A: owner e1 «Директор», logist e2, director e4 «Менеджер»; C: owner e5), B: company (owner e3).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('7a100000-0000-0000-0000-00000000000a', 'GPS groups A', 'team'),
       ('7a100000-0000-0000-0000-00000000000b', 'GPS groups B', 'solo'),
       ('7a100000-0000-0000-0000-00000000000c', 'GPS groups C', 'team');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '7a000000-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated',
   'owner.gg@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GG 1"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '7a000000-0000-0000-0000-0000000000e2', 'authenticated', 'authenticated',
   'logist.gg@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GG 2"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '7a000000-0000-0000-0000-0000000000e3', 'authenticated', 'authenticated',
   'company.gg@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GG 3"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '7a000000-0000-0000-0000-0000000000e4', 'authenticated', 'authenticated',
   'director.gg@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GG 4"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '7a000000-0000-0000-0000-0000000000e5', 'authenticated', 'authenticated',
   'ownerc.gg@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GG 5"}', now(), now());

UPDATE public.profiles
SET org_id = CASE id
      WHEN '7a000000-0000-0000-0000-0000000000e3' THEN '7a100000-0000-0000-0000-00000000000b'::uuid
      WHEN '7a000000-0000-0000-0000-0000000000e5' THEN '7a100000-0000-0000-0000-00000000000c'::uuid
      ELSE '7a100000-0000-0000-0000-00000000000a'::uuid
    END,
    is_approved = true,
    org_role = CASE id WHEN '7a000000-0000-0000-0000-0000000000e2' THEN 'logist' ELSE 'owner' END,
    member_status = 'active'
WHERE id IN ('7a000000-0000-0000-0000-0000000000e1', '7a000000-0000-0000-0000-0000000000e2',
             '7a000000-0000-0000-0000-0000000000e3', '7a000000-0000-0000-0000-0000000000e5');

SELECT public.set_org_plan('7a100000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('7a100000-0000-0000-0000-00000000000c', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id)
VALUES ('7a100000-0000-0000-0000-00000000000a', '7a000000-0000-0000-0000-0000000000e4');

INSERT INTO public.gps_integrations (id, org_id, provider, host_kind, api_host, status)
VALUES ('7a200000-0000-0000-0000-00000000000a', '7a100000-0000-0000-0000-00000000000a', 'wialon', 'hosting', 'hst-api.wialon.com', 'active'),
       ('7a200000-0000-0000-0000-00000000000c', '7a100000-0000-0000-0000-00000000000c', 'wialon', 'hosting', 'hst-api.wialon.eu', 'active');
INSERT INTO public.gps_vehicles (id, org_id, integration_id, external_id, name)
VALUES ('7a300000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-00000000000a', '7a200000-0000-0000-0000-00000000000a', '101', 'DAF XF'),
       ('7a300000-0000-0000-0000-000000000002', '7a100000-0000-0000-0000-00000000000a', '7a200000-0000-0000-0000-00000000000a', '102', 'John Deere 8R'),
       ('7a300000-0000-0000-0000-000000000003', '7a100000-0000-0000-0000-00000000000a', '7a200000-0000-0000-0000-00000000000a', '103', 'Sprinter'),
       ('7a300000-0000-0000-0000-000000000009', '7a100000-0000-0000-0000-00000000000c', '7a200000-0000-0000-0000-00000000000c', '901', 'Unit C');

-- Provider / kind constraints (service_role).
SELECT lives_ok(
  $$INSERT INTO public.gps_integrations (org_id, provider, host_kind, api_host, status)
    VALUES ('7a100000-0000-0000-0000-00000000000b', 'agrocontrol', 'hosting', 'not-configured', 'pending')$$,
  'service_role: provider agrocontrol is allowed'
);
SELECT throws_ok(
  $$INSERT INTO public.gps_integrations (org_id, provider, host_kind, api_host, status)
    VALUES ('7a100000-0000-0000-0000-00000000000c', 'other', 'hosting', 'x', 'pending')$$,
  '23514', NULL, 'service_role: an unknown provider is refused'
);
SELECT throws_ok(
  $$UPDATE public.gps_vehicles SET kind = 'bus' WHERE id = '7a300000-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'service_role: an unknown kind is refused'
);

-- gps_sync_groups: mirror of the Wialon groups; manual groups stay.
INSERT INTO public.gps_groups (id, org_id, source, name)
VALUES ('7a400000-0000-0000-0000-0000000000f1', '7a100000-0000-0000-0000-00000000000a', 'manual', 'Моя група');
INSERT INTO public.gps_group_members (group_id, gps_vehicle_id, org_id)
VALUES ('7a400000-0000-0000-0000-0000000000f1', '7a300000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-00000000000a');

SELECT is(
  (SELECT groups_total || '/' || members_total FROM public.gps_sync_groups('7a200000-0000-0000-0000-00000000000a',
    '[{"external_id":"g1","name":"Тягачі","units":["101","103"]},{"external_id":"g2","name":"Трактори","units":["102","999"]}]'::jsonb)),
  '2/3',
  'service_role: gps_sync_groups creates groups and members (unknown unit ignored)'
);
SELECT is(
  (SELECT groups_removed || '/' || groups_total || '/' || members_total FROM public.gps_sync_groups('7a200000-0000-0000-0000-00000000000a',
    '[{"external_id":"g1","name":"Тягачі 2","units":["101"]}]'::jsonb)),
  '1/1/1',
  'service_role: the second sync renames, drops a vanished group and a vanished member'
);
SELECT is(
  (SELECT name FROM public.gps_groups WHERE integration_id = '7a200000-0000-0000-0000-00000000000a' AND external_id = 'g1'),
  'Тягачі 2',
  'service_role: group name is updated by sync'
);
SELECT is(
  (SELECT count(*)::integer FROM public.gps_groups WHERE id = '7a400000-0000-0000-0000-0000000000f1'),
  1,
  'sync keeps the manual group'
);
SELECT is(
  (SELECT count(*)::integer FROM public.gps_group_members WHERE group_id = '7a400000-0000-0000-0000-0000000000f1'),
  1,
  'sync keeps the members of the manual group'
);
SELECT is(
  (SELECT count(*)::integer FROM public.gps_vehicles WHERE integration_id = '7a200000-0000-0000-0000-00000000000a'),
  3,
  'sync of groups never deletes units'
);
SELECT is(
  (SELECT count(*)::integer FROM public.gps_groups WHERE org_id = '7a100000-0000-0000-0000-00000000000c'),
  0,
  'sync of A does not create groups in another org'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_sync_groups('7a200000-0000-0000-0000-00000000000a', '{}'::jsonb)$$,
  'P0001', NULL, 'service_role: gps_sync_groups needs an array'
);

-- Owner «Директор» of A.
SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_groups), 2, 'owner: reads groups of own org only');
SELECT is((SELECT count(*)::integer FROM public.gps_group_members), 2, 'owner: reads members of own org only');
SELECT lives_ok(
  $$INSERT INTO public.gps_groups (id, org_id, source, name)
    VALUES ('7a400000-0000-0000-0000-0000000000f2', '7a100000-0000-0000-0000-00000000000a', 'manual', 'Від директора')$$,
  'owner: creates a manual group'
);
SELECT throws_ok(
  $$INSERT INTO public.gps_groups (org_id, integration_id, source, external_id, name)
    VALUES ('7a100000-0000-0000-0000-00000000000a', '7a200000-0000-0000-0000-00000000000a', 'wialon', 'gx', 'Підробна')$$,
  '42501', NULL, 'owner: cannot create a wialon group'
);
SELECT throws_ok(
  $$INSERT INTO public.gps_groups (org_id, source, name)
    VALUES ('7a100000-0000-0000-0000-00000000000c', 'manual', 'У чужу організацію')$$,
  '42501', NULL, 'owner: cannot create a group in another org'
);
SELECT lives_ok(
  $$INSERT INTO public.gps_group_members (group_id, gps_vehicle_id, org_id)
    VALUES ('7a400000-0000-0000-0000-0000000000f2', '7a300000-0000-0000-0000-000000000002', '7a100000-0000-0000-0000-00000000000a')$$,
  'owner: adds a unit to a manual group'
);
SELECT throws_ok(
  $$INSERT INTO public.gps_group_members (group_id, gps_vehicle_id, org_id)
    VALUES ('7a400000-0000-0000-0000-0000000000f2', '7a300000-0000-0000-0000-000000000009', '7a100000-0000-0000-0000-00000000000a')$$,
  '42501', NULL, 'owner: a unit of another org cannot join a group'
);
SELECT throws_ok(
  $$INSERT INTO public.gps_group_members (group_id, gps_vehicle_id, org_id)
    SELECT g.id, '7a300000-0000-0000-0000-000000000003', g.org_id FROM public.gps_groups AS g
    WHERE g.source = 'wialon' AND g.external_id = 'g1'$$,
  '42501', NULL, 'owner: cannot change the members of a wialon group'
);
SELECT lives_ok(
  $$UPDATE public.gps_groups SET name = 'Перейменована' WHERE id = '7a400000-0000-0000-0000-0000000000f2'$$,
  'owner: renames a manual group'
);
SELECT lives_ok(
  $$UPDATE public.gps_groups SET name = 'Злам' WHERE source = 'wialon'$$,
  'owner: update of wialon groups runs but touches no row'
);
SELECT is(
  (SELECT name FROM public.gps_groups WHERE source = 'wialon' AND external_id = 'g1'),
  'Тягачі 2',
  'owner: the wialon group keeps its name'
);
SELECT lives_ok(
  $$DELETE FROM public.gps_groups WHERE source = 'wialon'$$,
  'owner: delete of wialon groups runs but touches no row'
);
SELECT is((SELECT count(*)::integer FROM public.gps_groups WHERE source = 'wialon'), 1, 'owner: the wialon group is still there');
SELECT throws_ok(
  $$UPDATE public.gps_vehicles SET kind = 'truck' WHERE id = '7a300000-0000-0000-0000-000000000001'$$,
  '42501', NULL, 'owner: no direct write of gps_vehicles.kind'
);
SELECT is(
  (SELECT kind || '/' || kind_manual::text FROM public.gps_set_kind('7a300000-0000-0000-0000-000000000002', 'tractor')),
  'tractor/true',
  'owner: gps_set_kind sets the kind and kind_manual'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_set_kind('7a300000-0000-0000-0000-000000000002', 'bus')$$,
  'P0001', NULL, 'owner: gps_set_kind refuses an unknown kind'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_set_kind('7a300000-0000-0000-0000-000000000009', 'truck')$$,
  'P0001', NULL, 'owner: gps_set_kind does not see a unit of another org'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_sync_groups('7a200000-0000-0000-0000-00000000000a', '[]'::jsonb)$$,
  '42501', NULL, 'owner: cannot call gps_sync_groups'
);
RESET ROLE;

-- Director «Менеджер»: may change.
SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-0000000000e4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_groups), 3, 'director: reads the groups of the org');
SELECT lives_ok(
  $$INSERT INTO public.gps_groups (org_id, source, name) VALUES ('7a100000-0000-0000-0000-00000000000a', 'manual', 'Від менеджера')$$,
  'director: creates a manual group'
);
SELECT is(
  (SELECT kind_manual::text FROM public.gps_set_kind('7a300000-0000-0000-0000-000000000003', 'van')),
  'true',
  'director: gps_set_kind works'
);
RESET ROLE;

-- Logist: reads only.
SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_groups), 4, 'logist: reads the groups of the org');
SELECT throws_ok(
  $$INSERT INTO public.gps_groups (org_id, source, name) VALUES ('7a100000-0000-0000-0000-00000000000a', 'manual', 'Від логіста')$$,
  '42501', NULL, 'logist: cannot create a group'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_set_kind('7a300000-0000-0000-0000-000000000003', 'truck')$$,
  '42501', NULL, 'logist: cannot set the kind'
);
RESET ROLE;

-- Company plan: nothing.
SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-0000000000e3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_groups), 0, 'company plan: sees no groups');
RESET ROLE;

-- Other control_plus org: sees none of A.
SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_groups), 0, 'other org: sees no groups of A');
RESET ROLE;

-- kind_manual protects the kind from sync (service_role writes).
SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);
UPDATE public.gps_vehicles SET kind = 'truck', kind_manual = false WHERE id = '7a300000-0000-0000-0000-000000000002';
SELECT is(
  (SELECT kind || '/' || kind_manual::text FROM public.gps_vehicles WHERE id = '7a300000-0000-0000-0000-000000000002'),
  'tractor/true',
  'service_role: a sync write does not override a manual kind'
);
UPDATE public.gps_vehicles SET kind = 'truck' WHERE id = '7a300000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT kind FROM public.gps_vehicles WHERE id = '7a300000-0000-0000-0000-000000000001'),
  'truck',
  'service_role: sync sets the kind of a non-manual unit'
);

SELECT * FROM finish();
ROLLBACK;
