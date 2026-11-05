-- Контроль+ «Власний парк», етап 1 (*_own_fleet.sql): прапорець, підрозділи, точки, роль requester, заявки.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(122);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a1","role":"service_role"}', true);

-- A: control_plus + own_fleet (owner a1, logist a2, director a3, requesters a4 [unit U1] and a5 [unit U2]);
-- B: control_plus БЕЗ прапорця (owner b1; b2 — кандидат у requester); C: control_plus + own_fleet, інша компанія (owner c1).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('8f000000-0000-0000-0000-00000000000a', 'OF A', 'team'),
       ('8f000000-0000-0000-0000-00000000000b', 'OF B', 'solo'),
       ('8f000000-0000-0000-0000-00000000000c', 'OF C', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d0f00' || k)::uuid, 'authenticated', 'authenticated',
       'of-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'OF ' || k), now(), now()
FROM unnest(ARRAY['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2', 'c1']) AS k;

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d0e' || lpad(n::text, 4, '0'))::uuid, 'authenticated', 'authenticated',
       'of-fill-' || n || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'OF fill ' || n), now(), now()
FROM generate_series(1, 30) AS n;

UPDATE public.profiles
SET org_id = CASE WHEN id = '00000000-0000-0000-0000-00000d0f00b1' THEN '8f000000-0000-0000-0000-00000000000b'::uuid
                  WHEN id = '00000000-0000-0000-0000-00000d0f00c1' THEN '8f000000-0000-0000-0000-00000000000c'::uuid
                  ELSE '8f000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000d0f00a2' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000d0f00a1', '00000000-0000-0000-0000-00000d0f00a2', '00000000-0000-0000-0000-00000d0f00b1',
             '00000000-0000-0000-0000-00000d0f00c1');

SELECT public.set_org_plan('8f000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('8f000000-0000-0000-0000-00000000000b', 'control_plus');
SELECT public.set_org_plan('8f000000-0000-0000-0000-00000000000c', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0f00a3');

-- 1. Прапорець.
SELECT is(public.org_has_feature('8f000000-0000-0000-0000-00000000000a', 'own_fleet'), false, 'no flag by default');
UPDATE public.organizations SET features = '{"own_fleet": true}' WHERE id IN ('8f000000-0000-0000-0000-00000000000a', '8f000000-0000-0000-0000-00000000000c');
SELECT is(public.org_has_feature('8f000000-0000-0000-0000-00000000000a', 'own_fleet'), true, 'flag set by SQL (service_role)');
SELECT is(public.org_has_feature('8f000000-0000-0000-0000-00000000000b', 'own_fleet'), false, 'org B has no flag');
SELECT is(public.org_has_feature(NULL, 'own_fleet'), false, 'unknown org → false');
SELECT is(has_function_privilege('authenticated', 'public.org_has_feature(uuid, text)', 'EXECUTE'), false, 'org_has_feature is not callable by clients');

-- Фікстури A: підрозділи, точки, авто, водії.
INSERT INTO public.org_units (id, org_id, name, kind) VALUES
  ('8f100000-0000-0000-0000-000000000001', '8f000000-0000-0000-0000-00000000000a', 'Північ', 'agro'),
  ('8f100000-0000-0000-0000-000000000002', '8f000000-0000-0000-0000-00000000000a', 'Елеватор', 'elevator'),
  ('8f100000-0000-0000-0000-00000d0f00c1', '8f000000-0000-0000-0000-00000000000c', 'Чужий підрозділ', 'agro');
INSERT INTO public.org_points (id, org_id, unit_id, name, kind) VALUES
  ('8f200000-0000-0000-0000-000000000001', '8f000000-0000-0000-0000-00000000000a', '8f100000-0000-0000-0000-000000000001', 'Поле 1', 'field'),
  ('8f200000-0000-0000-0000-000000000002', '8f000000-0000-0000-0000-00000000000a', '8f100000-0000-0000-0000-000000000002', 'Склад елеватора', 'warehouse'),
  ('8f200000-0000-0000-0000-000000000003', '8f000000-0000-0000-0000-00000000000a', NULL, 'Спільний елеватор', 'elevator');
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES
  ('8f300000-0000-0000-0000-000000000001', '8f000000-0000-0000-0000-00000000000a', 'AA 1111 AA'),
  ('8f300000-0000-0000-0000-000000000002', '8f000000-0000-0000-0000-00000000000a', 'AA 2222 AA'),
  ('8f300000-0000-0000-0000-00000d0f00c1', '8f000000-0000-0000-0000-00000000000c', 'CC 3333 CC');
INSERT INTO public.kp_drivers (id, org_id, full_name) VALUES
  ('8f400000-0000-0000-0000-000000000001', '8f000000-0000-0000-0000-00000000000a', 'Іваненко Іван'),
  ('8f400000-0000-0000-0000-000000000002', '8f000000-0000-0000-0000-00000000000a', 'Петренко Петро');

-- 2. Роль requester: guard-тригери.
SELECT throws_ok($$INSERT INTO public.org_requesters (org_id, user_id) VALUES ('8f000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000d0f00b2')$$,
  'P0001', NULL, 'requester cannot be assigned in an org without own_fleet — REQUESTER_REQUIRES_OWN_FLEET');
SELECT throws_ok($$INSERT INTO public.org_requesters (org_id, user_id) VALUES ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0f00a2')$$,
  'P0001', NULL, 'an active member (logist) cannot be a requester — REQUESTER_IS_MEMBER');
SELECT throws_ok($$INSERT INTO public.org_requesters (org_id, user_id) VALUES ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0f00a3')$$,
  'P0001', NULL, 'a director cannot be a requester — REQUESTER_IS_MEMBER');
INSERT INTO public.org_requesters (org_id, user_id) VALUES
  ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0f00a4'),
  ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0f00a5');
INSERT INTO public.org_unit_members (unit_id, user_id, org_id) VALUES
  ('8f100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000d0f00a4', '8f000000-0000-0000-0000-00000000000a'),
  ('8f100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000d0f00a5', '8f000000-0000-0000-0000-00000000000a');
SELECT throws_ok($$INSERT INTO public.org_unit_members (unit_id, user_id, org_id) VALUES ('8f100000-0000-0000-0000-00000d0f00c1', '00000000-0000-0000-0000-00000d0f00a4', '8f000000-0000-0000-0000-00000000000a')$$,
  'P0001', NULL, 'a unit of another org cannot be attached — OWN_FLEET_UNIT_NOT_IN_ORG');
-- Ліміт «1 директор + 3 логісти» не діє: 2 + 28 = 30 requesters при 1 owner + 1 logist + 1 director; 31-й — REQUESTER_LIMIT.
INSERT INTO public.org_requesters (org_id, user_id)
SELECT '8f000000-0000-0000-0000-00000000000a', ('00000000-0000-0000-0000-00000d0e' || lpad(n::text, 4, '0'))::uuid FROM generate_series(1, 28) AS n;
SELECT is((SELECT count(*)::integer FROM public.org_requesters WHERE org_id = '8f000000-0000-0000-0000-00000000000a'), 30, '30 requesters fit (separate limit)');
SELECT throws_ok($$INSERT INTO public.org_requesters (org_id, user_id) VALUES ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0e0029')$$,
  'P0001', NULL, 'the 31st requester — REQUESTER_LIMIT');
DELETE FROM public.org_requesters WHERE user_id::text LIKE '00000000-0000-0000-0000-00000d0e%';

-- 3. Контекст: хто що бачить.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role FROM public.own_fleet_context()), 'owner', 'owner A: role owner');
SELECT is((SELECT count(*)::integer FROM public.org_units), 2, 'owner A sees the two units of A only');
SELECT is((SELECT count(*)::integer FROM public.org_points), 3, 'owner A sees the three points');
SELECT is((SELECT count(*)::integer FROM public.org_requesters), 2, 'owner A sees its requesters');
SELECT throws_ok($$UPDATE public.organizations SET features = '{"own_fleet": true, "x": 1}' WHERE id = '8f000000-0000-0000-0000-00000000000a'$$,
  '42501', NULL, 'owner cannot change features');
SELECT lives_ok($$INSERT INTO public.org_units (org_id, name, kind) VALUES ('8f000000-0000-0000-0000-00000000000a', 'Тваринництво', 'livestock')$$, 'owner creates a unit');
SELECT lives_ok($$UPDATE public.org_units SET archived = true WHERE name = 'Тваринництво'$$, 'owner archives it');
SELECT lives_ok($$INSERT INTO public.org_points (org_id, unit_id, name, kind, lat, lng, crop, area_ha) VALUES ('8f000000-0000-0000-0000-00000000000a', '8f100000-0000-0000-0000-000000000001', 'Поле 2', 'field', 50.45, 30.52, 'пшениця', 120.5)$$, 'owner creates a point');
SELECT throws_ok($$INSERT INTO public.org_points (org_id, unit_id, name, kind, lat) VALUES ('8f000000-0000-0000-0000-00000000000a', NULL, 'Без lng', 'field', 50)$$,
  '23514', NULL, 'lat without lng is rejected');
SELECT throws_ok($$INSERT INTO public.org_points (org_id, unit_id, name) VALUES ('8f000000-0000-0000-0000-00000000000a', '8f100000-0000-0000-0000-00000d0f00c1', 'Чужий підрозділ')$$,
  'P0001', NULL, 'a point cannot reference a unit of another org');
SELECT throws_ok($$INSERT INTO public.org_units (org_id, name) VALUES ('8f000000-0000-0000-0000-00000000000c', 'Не в моїй орг')$$,
  '42501', NULL, 'owner A cannot insert into org C');
SELECT throws_ok($$INSERT INTO public.org_requesters (org_id, user_id) VALUES ('8f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d0f00a6')$$,
  '42501', NULL, 'no direct INSERT into org_requesters from clients');
SELECT throws_ok($$INSERT INTO public.fleet_requests (org_id, number, unit_id, cargo, wanted_at) VALUES ('8f000000-0000-0000-0000-00000000000a', 99, '8f100000-0000-0000-0000-000000000001', 'x', now())$$,
  '42501', NULL, 'no direct INSERT into fleet_requests from clients');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role FROM public.own_fleet_context()), 'logist', 'logist: role logist');
SELECT lives_ok($$INSERT INTO public.org_points (org_id, name, kind) VALUES ('8f000000-0000-0000-0000-00000000000a', 'Склад логіста', 'warehouse')$$, 'logist creates a point');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role FROM public.own_fleet_context()), 'director', 'director: role director («Менеджер»)');
SELECT lives_ok($$INSERT INTO public.org_units (org_id, name) VALUES ('8f000000-0000-0000-0000-00000000000a', 'Склад')$$, 'director creates a unit');
RESET ROLE;

-- requester a4 (U1): лише своє.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role FROM public.own_fleet_context()), 'requester', 'requester a4: role requester');
SELECT is((SELECT unit_ids FROM public.own_fleet_context()), ARRAY['8f100000-0000-0000-0000-000000000001']::uuid[], 'requester a4: only unit U1');
SELECT is((SELECT count(*)::integer FROM public.org_units), 1, 'requester sees only own unit');
SELECT is((SELECT count(*)::integer FROM public.org_points), 4, 'requester sees shared points and points of own unit (Поле 1, Поле 2, Спільний елеватор, Склад логіста)');
SELECT is((SELECT count(*)::integer FROM public.org_requesters), 1, 'requester sees only itself');
SELECT is((SELECT count(*)::integer FROM public.fleet_vehicles), 0, 'requester sees no vehicles');
SELECT is((CASE WHEN has_table_privilege('authenticated', 'public.kp_drivers', 'SELECT') THEN 1 ELSE 0 END), 0, 'requester sees no drivers');
SELECT is((SELECT count(*)::integer FROM public.clients), 0, 'requester sees no clients');
SELECT is((CASE WHEN has_table_privilege('authenticated', 'public.kp_documents', 'SELECT') THEN 1 ELSE 0 END), 0, 'requester sees no documents');
SELECT is((SELECT count(*)::integer FROM public.requester_invites), 0, 'requester sees no invites');
SELECT is(public.kp_role(), NULL, 'requester has no Контроль+ role (kp_role)');
SELECT throws_ok($$INSERT INTO public.org_units (org_id, name) VALUES ('8f000000-0000-0000-0000-00000000000a', 'Хитрий')$$, '42501', NULL, 'requester cannot create units');
UPDATE public.org_units SET name = 'Взламаний';
SELECT is((SELECT count(*)::integer FROM public.org_units WHERE name = 'Взламаний'), 0, 'requester cannot edit units (no rows pass the UPDATE policy)');
RESET ROLE;

-- 4. Заявки: створення.
CREATE TEMP TABLE t_r (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_r TO PUBLIC;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO t_r SELECT 'R1', public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'Пшениця', 25, '8f200000-0000-0000-0000-000000000001', '8f200000-0000-0000-0000-000000000003', NULL, NULL, now() + interval '1 day', 'high', 'до 10:00')$$,
  'requester creates a request for own unit');
SELECT lives_ok($$INSERT INTO t_r SELECT 'R2', public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'Соняшник', NULL, NULL, NULL, 'Ферма 3', 'Порт', now() + interval '2 days')$$,
  'free-text points, no qty');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000002', 'Кукурудза', 10, NULL, NULL, 'a', 'b', now())$$,
  '42501', NULL, 'requester cannot create for a foreign unit');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'Кукурудза', 10, '8f200000-0000-0000-0000-000000000002', NULL, NULL, NULL, now())$$,
  'P0001', NULL, 'requester cannot use a point of a foreign unit — FLEET_REQUEST_BAD_POINT');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'Кукурудза', 10, NULL, NULL, 'a', 'b', now(), 'asap')$$,
  'P0001', NULL, 'bad priority — FLEET_REQUEST_INVALID');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'Кукурудза', -1, NULL, NULL, 'a', 'b', now())$$,
  '23514', NULL, 'qty must be positive');
SELECT is((SELECT array_agg(number ORDER BY number) FROM public.fleet_requests), ARRAY[1, 2], 'numbers are sequential per org');
SELECT is((SELECT count(*)::integer FROM public.fleet_request_log), 2, 'creation is logged');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a5","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.fleet_requests), 0, 'requester of another unit sees none of U1 requests');
SELECT is((SELECT count(*)::integer FROM public.fleet_request_log), 0, 'nor their log');
SELECT lives_ok($$INSERT INTO t_r SELECT 'R3', public.fleet_request_create('8f100000-0000-0000-0000-000000000002', 'Ячмінь', 12, NULL, NULL, 'a', 'b', now() + interval '1 day')$$,
  'a5 creates a request for U2');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'cancelled', 'чужа')$$,
  'P0002', NULL, 'a5 cannot cancel U1 request (not visible) — FLEET_REQUEST_NOT_FOUND');
RESET ROLE;

-- 5. Переходи: requester.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.fleet_requests), 2, 'a4 sees only own unit requests');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'accepted')$$,
  '42501', NULL, 'requester cannot accept');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'cancelled')$$,
  'P0001', NULL, 'cancel without a reason — FLEET_REQUEST_REASON_REQUIRED');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'cancelled', '   ')$$,
  'P0001', NULL, 'blank reason is not a reason');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R2'), 'cancelled', 'не потрібно')$$, 'requester cancels own new request');
SELECT is((SELECT status || '/' || cancel_reason FROM public.fleet_requests WHERE id = (SELECT id FROM t_r WHERE k = 'R2')), 'cancelled/не потрібно', 'status and reason stored');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R2'), 'accepted')$$,
  '42501', NULL, 'requester cannot reopen');
RESET ROLE;

-- Персонал: допустимі й заборонені переходи.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.fleet_requests), 3, 'owner sees all requests of A');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'done')$$, 'P0001', NULL, 'new → done is not allowed');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'in_progress')$$, 'P0001', NULL, 'new → in_progress is not allowed');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'assigned')$$, 'P0001', NULL, 'assigned only through fleet_request_assign');
SELECT throws_ok($$SELECT public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R1'), '8f300000-0000-0000-0000-000000000001', NULL, '8f400000-0000-0000-0000-000000000001')$$,
  'P0001', NULL, 'new → assigned (skipping accepted) is not allowed');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'accepted')$$, 'new → accepted');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'accepted')$$, 'P0001', NULL, 'accepted → accepted is not allowed');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'in_progress')$$, 'P0001', NULL, 'accepted → in_progress is not allowed');
SELECT throws_ok($$SELECT public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R1'), '8f300000-0000-0000-0000-00000d0f00c1', NULL, '8f400000-0000-0000-0000-000000000001')$$,
  'P0001', NULL, 'a vehicle of another org cannot be assigned — FLEET_REQUEST_BAD_ASSIGNMENT');
SELECT throws_ok($$SELECT public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R1'), '8f300000-0000-0000-0000-000000000001', NULL, NULL)$$,
  'P0001', NULL, 'a driver is required');
SELECT is((public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R1'), '8f300000-0000-0000-0000-000000000001', NULL, '8f400000-0000-0000-0000-000000000001') ->> 'ok'), 'true',
  'accepted → assigned with vehicle and driver');
SELECT is((SELECT vehicle_label || '/' || driver_name FROM public.fleet_requests WHERE id = (SELECT id FROM t_r WHERE k = 'R1')), 'AA 1111 AA/Іваненко Іван', 'vehicle number and driver name are snapshotted');
SELECT lives_ok($$SELECT public.fleet_request_set_trip((SELECT id FROM t_r WHERE k = 'R1'), gen_random_uuid())$$, 'trip link on an assigned request');
RESET ROLE;

-- requester бачить номер авто й ПІБ водія в призначеній заявці, але не довідники.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT vehicle_label || '/' || driver_name FROM public.fleet_requests WHERE id = (SELECT id FROM t_r WHERE k = 'R1')), 'AA 1111 AA/Іваненко Іван', 'requester sees the vehicle number and driver name of the assigned request');
SELECT is((SELECT count(*)::integer FROM public.fleet_vehicles) + (CASE WHEN has_table_privilege('authenticated', 'public.kp_drivers', 'SELECT') THEN 1 ELSE 0 END), 0, 'but still no vehicle / driver directories');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'cancelled', 'вже призначена')$$,
  '42501', NULL, 'requester cannot cancel a non-new request');
SELECT throws_ok($$SELECT public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R1'), '8f300000-0000-0000-0000-000000000002', NULL, '8f400000-0000-0000-0000-000000000002')$$,
  '42501', NULL, 'requester cannot assign');
RESET ROLE;

-- Перетин у часі: попередження, не блок.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO t_r SELECT 'R4', public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'Ріпак', 20, NULL, NULL, 'a', 'b', (SELECT wanted_at + interval '2 hours' FROM public.fleet_requests WHERE id = (SELECT id FROM t_r WHERE k = 'R1')))$$,
  'logist creates an overlapping request');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R4'), 'accepted')$$, 'logist accepts it');
SELECT is((SELECT count(*)::integer FROM public.fleet_request_conflicts((SELECT id FROM t_r WHERE k = 'R4'), '8f300000-0000-0000-0000-000000000001', '8f400000-0000-0000-0000-000000000002')), 1, 'conflict preview: same vehicle at an overlapping time');
SELECT is((SELECT count(*)::integer FROM public.fleet_request_conflicts((SELECT id FROM t_r WHERE k = 'R4'), '8f300000-0000-0000-0000-000000000002', '8f400000-0000-0000-0000-000000000002')), 0, 'no conflict with another vehicle and driver');
SELECT is(jsonb_array_length(public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R4'), '8f300000-0000-0000-0000-000000000001', NULL, '8f400000-0000-0000-0000-000000000001') -> 'conflicts'), 2,
  'assign returns both vehicle and driver conflicts but does not block');
SELECT is((SELECT status FROM public.fleet_requests WHERE id = (SELECT id FROM t_r WHERE k = 'R4')), 'assigned', 'the overlapping request is assigned anyway');
SELECT is(jsonb_array_length(public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R4'), '8f300000-0000-0000-0000-000000000002', NULL, '8f400000-0000-0000-0000-000000000002') -> 'conflicts'), 0,
  're-assign to a free vehicle and driver: no conflicts');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'in_progress')$$, 'assigned → in_progress');
SELECT throws_ok($$SELECT public.fleet_request_assign((SELECT id FROM t_r WHERE k = 'R1'), '8f300000-0000-0000-0000-000000000002', NULL, '8f400000-0000-0000-0000-000000000002')$$,
  'P0001', NULL, 'in_progress cannot be re-assigned');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'done')$$, 'in_progress → done');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'cancelled', 'пізно')$$, 'P0001', NULL, 'done cannot be cancelled');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R4'), 'cancelled', 'зламалось авто')$$, 'staff cancels an assigned request with a reason');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R4'), 'in_progress')$$, 'P0001', NULL, 'cancelled is final');
SELECT is((SELECT string_agg(coalesce(from_status, '∅') || '>' || to_status, ',' ORDER BY id) FROM public.fleet_request_log WHERE request_id = (SELECT id FROM t_r WHERE k = 'R1')),
  '∅>new,new>accepted,accepted>assigned,assigned>in_progress,in_progress>done', 'the log keeps every transition');
SELECT is((SELECT count(*)::integer FROM public.fleet_request_log WHERE actor_id IS NULL), 0, 'every log row has an actor');
SELECT throws_ok($$UPDATE public.fleet_requests SET status = 'done'$$, '42501', NULL, 'no direct UPDATE of fleet_requests');
SELECT throws_ok($$DELETE FROM public.fleet_requests$$, '42501', NULL, 'no direct DELETE of fleet_requests');
SELECT throws_ok($$INSERT INTO public.fleet_request_log (request_id, org_id, to_status) VALUES (gen_random_uuid(), gen_random_uuid(), 'done')$$, '42501', NULL, 'no direct INSERT into the log');
RESET ROLE;

-- 6. Чужі організації: B без прапорця й C з прапорцем.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00b1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.own_fleet_context()), 0, 'owner of B (no flag): no context');
SELECT is((SELECT count(*)::integer FROM public.org_units) + (SELECT count(*)::integer FROM public.org_points) + (SELECT count(*)::integer FROM public.fleet_requests)
  + (SELECT count(*)::integer FROM public.fleet_request_log) + (SELECT count(*)::integer FROM public.org_requesters), 0, 'owner of B sees 0 rows everywhere');
SELECT throws_ok($$INSERT INTO public.org_units (org_id, name) VALUES ('8f000000-0000-0000-0000-00000000000b', 'Без прапорця')$$, '42501', NULL, 'owner of B cannot create units');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'x', 1, NULL, NULL, 'a', 'b', now())$$, '42501', NULL, 'owner of B cannot create requests');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00c1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.org_units), 1, 'owner of C (own flag) sees only its own unit');
SELECT is((SELECT count(*)::integer FROM public.fleet_requests), 0, 'and none of the requests of A');
SELECT throws_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_r WHERE k = 'R1'), 'cancelled', 'чужа')$$, 'P0002', NULL, 'C cannot touch a request of A');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'x', 1, NULL, NULL, 'a', 'b', now())$$, 'P0001', NULL, 'C cannot create a request in a unit of A');
RESET ROLE;

-- Прапорець вимкнено → навіть власник бачить 0 рядків і нічого не може.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a1","role":"service_role"}', true);
UPDATE public.organizations SET features = '{}' WHERE id = '8f000000-0000-0000-0000-00000000000a';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.own_fleet_context()), 0, 'flag off: owner has no context');
SELECT is((SELECT count(*)::integer FROM public.org_units) + (SELECT count(*)::integer FROM public.org_points) + (SELECT count(*)::integer FROM public.fleet_requests)
  + (SELECT count(*)::integer FROM public.fleet_request_log) + (SELECT count(*)::integer FROM public.org_requesters) + (SELECT count(*)::integer FROM public.org_unit_members), 0,
  'flag off: owner sees 0 rows in every own-fleet table');
SELECT throws_ok($$SELECT public.fleet_request_create('8f100000-0000-0000-0000-000000000001', 'x', 1, NULL, NULL, 'a', 'b', now())$$, '42501', NULL, 'flag off: owner cannot create requests');
SELECT throws_ok($$INSERT INTO public.org_units (org_id, name) VALUES ('8f000000-0000-0000-0000-00000000000a', 'Вимкнено')$$, '42501', NULL, 'flag off: owner cannot create units');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.own_fleet_context()) + (SELECT count(*)::integer FROM public.fleet_requests), 0, 'flag off: requester has nothing either');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a1","role":"service_role"}', true);
UPDATE public.organizations SET features = '{"own_fleet": true}' WHERE id = '8f000000-0000-0000-0000-00000000000a';

-- 7. Запрошення requester (API, service_role).
SELECT is((public.own_fleet_invite_reserve('8f000000-0000-0000-0000-00000000000a', '8f500000-0000-0000-0000-000000000001', ' New@Example.com ', 'hash-1',
  '00000000-0000-0000-0000-00000d0f00a1', now() + interval '7 days', ARRAY['8f100000-0000-0000-0000-000000000001']::uuid[]))::text, '8f500000-0000-0000-0000-000000000001',
  'owner reserves an invite with a unit');
SELECT throws_ok($$SELECT public.own_fleet_invite_reserve('8f000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'x@example.com', 'hash-2', '00000000-0000-0000-0000-00000d0f00a4', now() + interval '7 days', ARRAY['8f100000-0000-0000-0000-000000000001']::uuid[])$$,
  '42501', NULL, 'a requester cannot invite');
SELECT throws_ok($$SELECT public.own_fleet_invite_reserve('8f000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'x@example.com', 'hash-3', '00000000-0000-0000-0000-00000d0f00b1', now() + interval '7 days', ARRAY['8f100000-0000-0000-0000-000000000001']::uuid[])$$,
  '42501', NULL, 'the owner of another org cannot invite into A');
SELECT throws_ok($$SELECT public.own_fleet_invite_reserve('8f000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'x@example.com', 'hash-4', '00000000-0000-0000-0000-00000d0f00a1', now() + interval '7 days', ARRAY[]::uuid[])$$,
  'P0001', NULL, 'an invite needs at least one unit');
SELECT throws_ok($$SELECT public.own_fleet_invite_accept('hash-1', '00000000-0000-0000-0000-00000d0f00a6', 'other@example.com')$$, '42501', NULL, 'accept with another email — INVITE_EMAIL_MISMATCH');
SELECT throws_ok($$SELECT public.own_fleet_invite_accept('nope', '00000000-0000-0000-0000-00000d0f00a6', 'new@example.com')$$, 'P0001', NULL, 'unknown token — REQUESTER_INVITE_NOT_FOUND');
SELECT is((public.own_fleet_invite_accept('hash-1', '00000000-0000-0000-0000-00000d0f00a6', 'NEW@example.com'))::text, '8f000000-0000-0000-0000-00000000000a', 'accept (email compared case-insensitively)');
SELECT is((SELECT count(*)::integer FROM public.org_unit_members WHERE user_id = '00000000-0000-0000-0000-00000d0f00a6' AND unit_id = '8f100000-0000-0000-0000-000000000001'), 1, 'the invited unit is attached');
SELECT throws_ok($$SELECT public.own_fleet_invite_accept('hash-1', '00000000-0000-0000-0000-00000d0f00a6', 'new@example.com')$$, 'P0001', NULL, 'an invite cannot be accepted twice — REQUESTER_INVITE_USED');
SELECT is(has_function_privilege('authenticated', 'public.own_fleet_invite_accept(text, uuid, text)', 'EXECUTE'), false, 'invite functions are service_role only');

-- Керування замовниками персоналом.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.own_fleet_requester_set_units('00000000-0000-0000-0000-00000d0f00a6', ARRAY['8f100000-0000-0000-0000-000000000002']::uuid[])$$, 'director re-attaches a requester to another unit');
SELECT is((SELECT array_agg(unit_id) FROM public.org_unit_members WHERE user_id = '00000000-0000-0000-0000-00000d0f00a6'), ARRAY['8f100000-0000-0000-0000-000000000002']::uuid[], 'the unit list is replaced');
SELECT lives_ok($$SELECT public.own_fleet_requester_remove('00000000-0000-0000-0000-00000d0f00a6')$$, 'director removes a requester');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d0f00a4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.own_fleet_requester_remove('00000000-0000-0000-0000-00000d0f00a5')$$, '42501', NULL, 'a requester cannot remove requesters');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
