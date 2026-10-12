-- History snapshot columns. Run with pgTAP against a database that already has the
-- organization migrations. Not executed in CI here.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(4);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"service_role"}',
  true
);

INSERT INTO public.organizations (id, name, work_mode)
VALUES ('20000000-0000-0000-0000-000000000001', 'History fixture', 'solo');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000000aa',
  'authenticated',
  'authenticated',
  'history.owner@example.com',
  '',
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"company_name":"History fixture"}',
  now(),
  now()
);

UPDATE public.profiles
SET org_id = '20000000-0000-0000-0000-000000000001',
    org_role = 'owner',
    member_status = 'active',
    is_approved = true
WHERE id = '00000000-0000-0000-0000-0000000000aa';

INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results)
VALUES (
  '20000000-0000-0000-0000-000000000010',
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000aa',
  'Умань — Ізмаїл',
  jsonb_build_object(
    'returnMode', 'разовий',
    'dist', '100',
    'podachaDist', '10',
    'carsCount', '2',
    'normWeight', '20',
    'volume', '500',
    'daysPerTrip', '1.5',
    'rate', '1000',
    'trailerType', 'зерновоз',
    'origin', 'Умань',
    'destination', 'Ізмаїл'
  ),
  jsonb_build_object('grossIncome', 40000, 'netProfit', 5000, 'routeName', 'Умань — Ізмаїл')
);

SELECT results_eq(
  $$SELECT vehicles_count, tonnage, trip_days, distance_km, revenue, profit, route_from, route_to, status
    FROM public.calculations WHERE id = '20000000-0000-0000-0000-000000000010'$$,
  $$VALUES (2::numeric, 40::numeric, 1.5::numeric, 110::numeric, 40000::numeric, 5000::numeric, 'Умань'::text, 'Ізмаїл'::text, 'draft'::text)$$,
  'one-off snapshot stores cars, hauled tons, days and route km'
);

INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results)
VALUES (
  '20000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000aa',
  'Цикл',
  jsonb_build_object(
    'returnMode', 'циклічний',
    'dist', '80',
    'carsCount', '2',
    'normWeight', '20',
    'volume', '500',
    'daysPerTrip', '2'
  ),
  jsonb_build_object('grossIncome', 1, 'netProfit', -10)
);

SELECT results_eq(
  $$SELECT tonnage, profit FROM public.calculations WHERE id = '20000000-0000-0000-0000-000000000011'$$,
  $$VALUES (500::numeric, -10::numeric)$$,
  'cyclic tonnage stays the contract volume'
);

SELECT throws_ok(
  $$UPDATE public.calculations SET status = 'manager' WHERE id = '20000000-0000-0000-0000-000000000010'$$,
  '23514',
  NULL,
  'status accepts only the five trip states'
);

SELECT lives_ok(
  $$UPDATE public.calculations SET status = 'accepted' WHERE id = '20000000-0000-0000-0000-000000000010'$$,
  'a real status update does not rewrite the snapshot'
);

SELECT * FROM finish();
ROLLBACK;
