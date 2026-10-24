-- Контроль+ GPS, етап 2a (20261024111415_gps_integrations.sql).
-- Run with pgTAP against a database that has all migrations and supabase_vault: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim and a Vault stub.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(26);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"service_role"}',
  true
);

-- A: control_plus (owner d1, logist d2, director d4), B: company (owner d3).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('50000000-0000-0000-0000-00000000000a', 'GPS plan', 'team'),
       ('50000000-0000-0000-0000-00000000000b', 'GPS company', 'solo');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d1', 'authenticated', 'authenticated',
   'owner.gps@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GPS 1"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d2', 'authenticated', 'authenticated',
   'logist.gps@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GPS 2"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d3', 'authenticated', 'authenticated',
   'company.gps@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GPS 3"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d4', 'authenticated', 'authenticated',
   'director.gps@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{"company_name":"GPS 4"}', now(), now());

UPDATE public.profiles
SET org_id = CASE id
      WHEN '00000000-0000-0000-0000-0000000000d3' THEN '50000000-0000-0000-0000-00000000000b'::uuid
      ELSE '50000000-0000-0000-0000-00000000000a'::uuid
    END,
    is_approved = true,
    org_role = CASE id WHEN '00000000-0000-0000-0000-0000000000d2' THEN 'logist' ELSE 'owner' END,
    member_status = 'active'
WHERE id IN ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2',
             '00000000-0000-0000-0000-0000000000d3');

SELECT public.set_org_plan('50000000-0000-0000-0000-00000000000a', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id)
VALUES ('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d4');

INSERT INTO public.fleet_vehicles (id, org_id, label)
VALUES ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000a', 'GPS-AA-1'),
       ('51000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-00000000000b', 'GPS-BB-1');
INSERT INTO public.gps_integrations (id, org_id, provider, host_kind, api_host, status)
VALUES ('52000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-00000000000a', 'wialon', 'hosting', 'hst-api.wialon.com', 'active'),
       ('52000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-00000000000b', 'wialon', 'hosting', 'hst-api.wialon.eu', 'active');
INSERT INTO public.gps_vehicles (id, org_id, integration_id, external_id, name)
VALUES ('53000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000a', '52000000-0000-0000-0000-00000000000a', '1', 'Unit 1'),
       ('53000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-00000000000a', '52000000-0000-0000-0000-00000000000a', '2', 'Unit 2'),
       ('53000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-00000000000b', '52000000-0000-0000-0000-00000000000b', '3', 'Unit B');
INSERT INTO public.gps_positions (org_id, gps_vehicle_id, recorded_at, lat, lon)
VALUES ('50000000-0000-0000-0000-00000000000a', '53000000-0000-0000-0000-000000000001', now() - interval '20 days', 50.4, 30.5),
       ('50000000-0000-0000-0000-00000000000a', '53000000-0000-0000-0000-000000000001', now() - interval '1 day', 50.4, 30.5);

-- Vault: service_role only; the table keeps a mask and a reference, never the token.
SELECT is(
  public.gps_store_token('52000000-0000-0000-0000-00000000000a', 'FAKEtokenForPgTap000000000000000000000001a2b'),
  '…1a2b',
  'service_role: store_token returns the mask'
);
SELECT is(
  (SELECT position('FAKEtoken' IN row_to_json(gi)::text) FROM public.gps_integrations AS gi
   WHERE gi.id = '52000000-0000-0000-0000-00000000000a'),
  0,
  'service_role: no token in gps_integrations'
);
SELECT is(
  public.gps_read_token('52000000-0000-0000-0000-00000000000a'),
  'FAKEtokenForPgTap000000000000000000000001a2b',
  'service_role: reads the token back from Vault'
);

-- gps_connect: fields and secret in one transaction; a Vault error changes nothing.
SELECT is(
  (SELECT token_hint FROM public.gps_connect('50000000-0000-0000-0000-00000000000b', 'wialon', 'local', 'gps.b-fleet.com',
     'viewer', 1, 'FAKEtokenForPgTapB00000000000000000000000000b0b0', '00000000-0000-0000-0000-0000000000d3')),
  '…b0b0',
  'service_role: gps_connect stores fields and token, returns the mask'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_connect('50000000-0000-0000-0000-00000000000b', 'wialon', 'hosting', 'hst-api.wialon.com',
      'viewer', 1, 'short', '00000000-0000-0000-0000-0000000000d3')$$,
  'P0001', NULL, 'service_role: gps_connect with a bad token fails'
);
SELECT is(
  (SELECT api_host || '|' || host_kind FROM public.gps_integrations WHERE id = '52000000-0000-0000-0000-00000000000b'),
  'gps.b-fleet.com|local',
  'service_role: the failed gps_connect left host and kind untouched'
);

-- Owner of the control_plus org.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_integrations), 1, 'owner: sees own integration');
SELECT throws_ok(
  $$SELECT public.gps_read_token('52000000-0000-0000-0000-00000000000a')$$,
  '42501', NULL, 'owner: cannot read the token'
);
SELECT throws_ok($$SELECT * FROM vault.secrets$$, '42501', NULL, 'owner: cannot read vault.secrets');
SELECT throws_ok(
  $$INSERT INTO public.gps_vehicles (org_id, integration_id, external_id, name)
    VALUES ('50000000-0000-0000-0000-00000000000a', '52000000-0000-0000-0000-00000000000a', '9', 'x')$$,
  '42501', NULL, 'owner: no direct writes to gps_vehicles'
);
SELECT lives_ok(
  $$SELECT * FROM public.gps_map_vehicle('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001')$$,
  'owner: maps a unit to a vehicle'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_map_vehicle('53000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001')$$,
  'P0001', NULL, 'owner: one vehicle cannot be mapped to two units'
);
SELECT throws_ok(
  $$SELECT * FROM public.gps_map_vehicle('53000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000003')$$,
  'P0001', NULL, 'owner: a vehicle of another org is refused'
);
SELECT is((SELECT count(*)::integer FROM public.gps_units()), 2, 'owner: gps_units lists the org units');
RESET ROLE;

-- Logist: all units of the org, no integration metadata, no mapping.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_integrations), 0, 'logist: does not see gps_integrations');
SELECT is((SELECT count(*)::integer FROM public.gps_vehicles), 2, 'logist: sees all units of the org');
SELECT is((SELECT count(*)::integer FROM public.gps_positions), 2, 'logist: sees all positions of the org');
SELECT throws_ok(
  $$SELECT * FROM public.gps_map_vehicle('53000000-0000-0000-0000-000000000002', NULL)$$,
  '42501', NULL, 'logist: cannot map'
);
RESET ROLE;

-- Director: read-only.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_integrations), 1, 'director: sees the integration');
SELECT is((SELECT count(*)::integer FROM public.gps_vehicles), 2, 'director: sees all units');
SELECT throws_ok(
  $$SELECT * FROM public.gps_map_vehicle('53000000-0000-0000-0000-000000000002', NULL)$$,
  '42501', NULL, 'director: cannot map'
);
RESET ROLE;

-- Company plan: nothing, even for its own rows.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.gps_vehicles), 0, 'company plan: sees no units');
SELECT throws_ok($$SELECT * FROM public.gps_units()$$, '42501', NULL, 'company plan: gps_units — CONTROL_PLUS_REQUIRED');
RESET ROLE;

-- Service role: purge and disconnect.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"service_role"}', true);
SELECT ok(public.gps_purge_old(14, 5000) >= 1, 'service_role: gps_purge_old removes points older than 14 days');
SELECT ok(public.gps_delete_token('52000000-0000-0000-0000-00000000000a'), 'service_role: delete_token');
SELECT is(public.gps_read_token('52000000-0000-0000-0000-00000000000a'), NULL::text, 'service_role: no token after delete_token');

SELECT * FROM finish();
ROLLBACK;
