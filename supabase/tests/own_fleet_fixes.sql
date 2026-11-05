-- Контроль+ «Власний парк», етап 1 — виправлення за рев'ю (*_own_fleet_fixes.sql): звʼязок із подорожнім листом, архівні авто / причепи,
-- «працює в іншій компанії», зняття призначення, список замовників.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(56);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d1f00a1","role":"service_role"}', true);

-- Текст помилки запиту (виклик без SET ROLE: функції модуля SECURITY DEFINER, особу задають claims).
CREATE FUNCTION pg_temp.fx_err(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.fx_err(text) TO PUBLIC;
CREATE FUNCTION pg_temp.fx_as(k text) RETURNS void LANGUAGE sql AS
  $f$ SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d1f00' || k || '","role":"authenticated"}', true) $f$;

-- X: control_plus + own_fleet (owner a1, logist a2, director a3, requester a4 [unit UX]); Y: control_plus + own_fleet, інша компанія (owner b1, director c4 — «чужий директор»);
-- Z: звичайна компанія (logist c1); W: control_plus без прапорця (owner c2 — власний Контроль+); c3 — власник власної пробної організації.
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('9f000000-0000-0000-0000-00000000000a', 'FX X', 'team'),
       ('9f000000-0000-0000-0000-00000000000b', 'FX Y', 'team'),
       ('9f000000-0000-0000-0000-00000000000c', 'FX Z', 'team'),
       ('9f000000-0000-0000-0000-00000000000d', 'FX W', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000d1f00' || k)::uuid, 'authenticated', 'authenticated',
       'fx-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}',
       CASE WHEN k = 'a4' THEN '{"full_name": "Замовник Тест"}'::jsonb ELSE jsonb_build_object('company_name', 'FX ' || k) END, now(), now()
FROM unnest(ARRAY['a1', 'a2', 'a3', 'a4', 'b1', 'c1', 'c2', 'c3', 'c4']) AS k;

UPDATE public.profiles
SET org_id = CASE WHEN id IN ('00000000-0000-0000-0000-00000d1f00a1', '00000000-0000-0000-0000-00000d1f00a2') THEN '9f000000-0000-0000-0000-00000000000a'::uuid
                  WHEN id = '00000000-0000-0000-0000-00000d1f00b1' THEN '9f000000-0000-0000-0000-00000000000b'::uuid
                  WHEN id = '00000000-0000-0000-0000-00000d1f00c1' THEN '9f000000-0000-0000-0000-00000000000c'::uuid
                  WHEN id = '00000000-0000-0000-0000-00000d1f00c2' THEN '9f000000-0000-0000-0000-00000000000d'::uuid
                  ELSE org_id END,
    org_role = CASE WHEN id IN ('00000000-0000-0000-0000-00000d1f00a2', '00000000-0000-0000-0000-00000d1f00c1') THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000d1f00a1', '00000000-0000-0000-0000-00000d1f00a2', '00000000-0000-0000-0000-00000d1f00b1', '00000000-0000-0000-0000-00000d1f00c1',
             '00000000-0000-0000-0000-00000d1f00c2', '00000000-0000-0000-0000-00000d1f00c4');

SELECT public.set_org_plan('9f000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('9f000000-0000-0000-0000-00000000000b', 'control_plus');
SELECT public.set_org_plan('9f000000-0000-0000-0000-00000000000d', 'control_plus');
UPDATE public.organizations SET features = '{"own_fleet": true}' WHERE id IN ('9f000000-0000-0000-0000-00000000000a', '9f000000-0000-0000-0000-00000000000b');
-- Глобальний вимикач (app_settings) увімкнено: org_has_feature = feature_enabled AND прапорець організації; без рядка модуль вимкнено для всіх.
INSERT INTO public.app_settings (key, enabled) VALUES ('own_fleet', true) ON CONFLICT (key) DO UPDATE SET enabled = true;
INSERT INTO public.org_directors (org_id, user_id) VALUES ('9f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d1f00a3');
-- c4: директор організації Y (власний профіль у Y прибираємо: директор не може бути її учасником).
UPDATE public.profiles SET org_id = '9f000000-0000-0000-0000-00000000000c', org_role = 'owner' WHERE id = '00000000-0000-0000-0000-00000d1f00c4';
INSERT INTO public.org_directors (org_id, user_id) VALUES ('9f000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000d1f00c4');

INSERT INTO public.org_units (id, org_id, name) VALUES
  ('9f100000-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-00000000000a', 'FX Північ'),
  ('9f100000-0000-0000-0000-000000000002', '9f000000-0000-0000-0000-00000000000a', 'FX Південь');
INSERT INTO public.org_requesters (org_id, user_id) VALUES ('9f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d1f00a4');
INSERT INTO public.org_unit_members (unit_id, user_id, org_id) VALUES
  ('9f100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000d1f00a4', '9f000000-0000-0000-0000-00000000000a');
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES
  ('9f300000-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-00000000000a', 'FX 1111 AA'),
  ('9f300000-0000-0000-0000-000000000003', '9f000000-0000-0000-0000-00000000000b', 'FX Y 3333');
INSERT INTO public.fleet_trailers (id, org_id, plate, plate_norm, active) VALUES
  ('9f400000-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-00000000000a', 'FX 9001 XX', 'FX9001XX', true),
  ('9f400000-0000-0000-0000-000000000002', '9f000000-0000-0000-0000-00000000000a', 'FX 9002 XX', 'FX9002XX', false);
INSERT INTO public.kp_drivers (id, org_id, full_name) VALUES ('9f500000-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-00000000000a', 'Фікс Водій');
-- Подорожні листи: один власної організації (X), один чужої (Y).
INSERT INTO public.kp_doc_trip_sheet (id, org_id, number, doc_year, doc_date, valid_from, valid_to, carrier, driver, vehicle, task, depart_at, depart_odometer, depart_fuel_left)
SELECT ('9f600000-0000-0000-0000-00000000000' || n)::uuid, org, n, 2026, DATE '2026-11-05', DATE '2026-11-05', DATE '2026-11-06', '{}', '{}', '{}', '{}', now(), 0, 0
FROM (VALUES (1, '9f000000-0000-0000-0000-00000000000a'::uuid), (2, '9f000000-0000-0000-0000-00000000000b'::uuid)) AS t (n, org);

CREATE TEMP TABLE t_fx (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_fx TO PUBLIC;

-- Заявки: R1, R2 — підрозділ UX; створює директор a1.
SELECT pg_temp.fx_as('a1');
INSERT INTO t_fx SELECT 'R1', public.fleet_request_create('9f100000-0000-0000-0000-000000000001', 'Пшениця', 20, NULL, NULL, 'a', 'b', now() + interval '1 day');
INSERT INTO t_fx SELECT 'R2', public.fleet_request_create('9f100000-0000-0000-0000-000000000001', 'Ячмінь', 20, NULL, NULL, 'a', 'b', now() + interval '3 days');
SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted');
SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R2'), 'accepted');

-- 2. Призначення: архівні авто й причіп.
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_assign((SELECT id FROM t_fx WHERE k = 'R1'), '9f300000-0000-0000-0000-000000000001', '9f400000-0000-0000-0000-000000000002', '9f500000-0000-0000-0000-000000000001')$$),
  'FLEET_REQUEST_TRAILER_ARCHIVED', 'an archived trailer cannot be assigned');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_assign((SELECT id FROM t_fx WHERE k = 'R1'), gen_random_uuid(), NULL, '9f500000-0000-0000-0000-000000000001')$$),
  'FLEET_REQUEST_BAD_ASSIGNMENT', 'a deleted / unknown vehicle (fleet_vehicles has no archive state) is a bad assignment');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_assign((SELECT id FROM t_fx WHERE k = 'R1'), '9f300000-0000-0000-0000-000000000003', NULL, '9f500000-0000-0000-0000-000000000001')$$),
  'FLEET_REQUEST_BAD_ASSIGNMENT', 'a vehicle of another org cannot be assigned');
SELECT is((SELECT status FROM public.fleet_requests WHERE id = (SELECT id FROM t_fx WHERE k = 'R1')), 'accepted', 'a refused assignment leaves the request accepted');
SELECT is((public.fleet_request_assign((SELECT id FROM t_fx WHERE k = 'R1'), '9f300000-0000-0000-0000-000000000001', '9f400000-0000-0000-0000-000000000001', '9f500000-0000-0000-0000-000000000001') ->> 'ok'), 'true',
  'active vehicle + trailer + driver: assigned');
SELECT is((public.fleet_request_assign((SELECT id FROM t_fx WHERE k = 'R2'), '9f300000-0000-0000-0000-000000000001', NULL, '9f500000-0000-0000-0000-000000000001') ->> 'ok'), 'true', 'second request, no trailer');

-- 1. Звʼязок із подорожнім листом.
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), '9f600000-0000-0000-0000-000000000002')$$),
  'FLEET_REQUEST_BAD_TRIP', 'a trip sheet of another organization is refused');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), gen_random_uuid())$$),
  'FLEET_REQUEST_BAD_TRIP', 'a non-existent trip is refused');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), '9f600000-0000-0000-0000-000000000001')$$), 'no error', 'owner links a trip sheet of own org');
SELECT is((SELECT trip_id FROM public.fleet_requests WHERE id = (SELECT id FROM t_fx WHERE k = 'R1')), '9f600000-0000-0000-0000-000000000001'::uuid, 'trip_id stored');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), NULL)$$), 'no error', 'NULL unlinks');
SELECT is((SELECT trip_id FROM public.fleet_requests WHERE id = (SELECT id FROM t_fx WHERE k = 'R1')), NULL::uuid, 'unlinked');
SELECT pg_temp.fx_as('a2');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), '9f600000-0000-0000-0000-000000000001')$$), 'no error', 'logist links too');
SELECT pg_temp.fx_as('a3');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R2'), '9f600000-0000-0000-0000-000000000001')$$), 'no error', 'director links too');
SELECT pg_temp.fx_as('a4');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), '9f600000-0000-0000-0000-000000000001')$$), 'OWN_FLEET_FORBIDDEN', 'requester cannot link a trip');
SELECT pg_temp.fx_as('b1');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_set_trip((SELECT id FROM t_fx WHERE k = 'R1'), '9f600000-0000-0000-0000-000000000002')$$), 'FLEET_REQUEST_NOT_FOUND', 'owner of another org cannot touch the request');

-- 5. Зняти призначення (assigned → accepted).
SELECT pg_temp.fx_as('a4');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted')$$), 'FLEET_REQUEST_FORBIDDEN', 'requester cannot unassign (even a request of own unit)');
SELECT pg_temp.fx_as('b1');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted')$$), 'FLEET_REQUEST_NOT_FOUND', 'another org cannot unassign');
SELECT is((SELECT accepted_at > now() - interval '1 minute' FROM public.fleet_requests WHERE id = (SELECT id FROM t_fx WHERE k = 'R1')), true, 'new → accepted sets accepted_at');
UPDATE public.fleet_requests SET accepted_at = TIMESTAMPTZ '2026-01-01 10:00:00+00' WHERE id = (SELECT id FROM t_fx WHERE k = 'R1');
SELECT pg_temp.fx_as('a2');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted')$$), 'no error', 'logist unassigns');
SELECT is((SELECT accepted_at FROM public.fleet_requests WHERE id = (SELECT id FROM t_fx WHERE k = 'R1')), TIMESTAMPTZ '2026-01-01 10:00:00+00', 'unassign (assigned → accepted) does not overwrite accepted_at');
SELECT is((SELECT concat_ws('|', status, vehicle_id, trailer_id, driver_id, vehicle_label, trailer_label, driver_name, assigned_at, trip_id) FROM public.fleet_requests WHERE id = (SELECT id FROM t_fx WHERE k = 'R1')),
  'accepted', 'status accepted; vehicle, trailer, driver, labels, assigned_at and trip link are cleared');
SELECT is((SELECT to_status || ':' || from_status || ':' || coalesce(note, '') FROM public.fleet_request_log WHERE request_id = (SELECT id FROM t_fx WHERE k = 'R1') ORDER BY id DESC LIMIT 1),
  'accepted:assigned:Призначення знято: FX 1111 AA', 'the log records who/when and what was unassigned');
SELECT is((SELECT actor_id FROM public.fleet_request_log WHERE request_id = (SELECT id FROM t_fx WHERE k = 'R1') ORDER BY id DESC LIMIT 1), '00000000-0000-0000-0000-00000d1f00a2'::uuid, 'logged with the actor');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted')$$), 'FLEET_REQUEST_BAD_TRANSITION', 'accepted → accepted is still refused');
SELECT is((public.fleet_request_assign((SELECT id FROM t_fx WHERE k = 'R1'), '9f300000-0000-0000-0000-000000000001', NULL, '9f500000-0000-0000-0000-000000000001') ->> 'ok'), 'true', 'it can be assigned again');
SELECT pg_temp.fx_as('a3');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R2'), 'accepted')$$), 'no error', 'director unassigns');
SELECT pg_temp.fx_as('a1');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'in_progress')$$, 'assigned → in_progress');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted')$$), 'FLEET_REQUEST_BAD_TRANSITION', 'a started trip cannot be unassigned');
SELECT lives_ok($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'done')$$, 'in_progress → done');
SELECT is(pg_temp.fx_err($$SELECT public.fleet_request_transition((SELECT id FROM t_fx WHERE k = 'R1'), 'accepted')$$), 'FLEET_REQUEST_BAD_TRANSITION', 'done cannot be unassigned');

-- 3. Прийняття запрошення: «Цей акаунт уже працює в іншій компанії».
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d1f00a1","role":"service_role"}', true);
SELECT public.own_fleet_invite_reserve('9f000000-0000-0000-0000-00000000000a', ('9f700000-0000-0000-0000-00000000000' || n)::uuid, 'fx-' || k || '@example.com', 'fx-hash-' || k,
  '00000000-0000-0000-0000-00000d1f00a1', now() + interval '7 days', ARRAY['9f100000-0000-0000-0000-000000000001']::uuid[])
FROM (VALUES (1, 'c1'), (2, 'c2'), (3, 'c3'), (4, 'c4')) AS t (n, k);
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_accept('fx-hash-c1', '00000000-0000-0000-0000-00000d1f00c1', 'fx-c1@example.com')$$), 'REQUESTER_WORKS_ELSEWHERE', 'an active logist of another company is refused');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_accept('fx-hash-c2', '00000000-0000-0000-0000-00000d1f00c2', 'fx-c2@example.com')$$), 'REQUESTER_WORKS_ELSEWHERE', 'a member of a control_plus company (own Контроль+) is refused');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_accept('fx-hash-c4', '00000000-0000-0000-0000-00000d1f00c4', 'fx-c4@example.com')$$), 'REQUESTER_WORKS_ELSEWHERE', 'a director of another company is refused');
SELECT is((SELECT count(*)::integer FROM public.org_requesters WHERE user_id IN ('00000000-0000-0000-0000-00000d1f00c1', '00000000-0000-0000-0000-00000d1f00c2', '00000000-0000-0000-0000-00000d1f00c4')), 0, 'none of them became a requester');
SELECT is((SELECT count(*)::integer FROM public.requester_invites WHERE token_hash IN ('fx-hash-c1', 'fx-hash-c2', 'fx-hash-c4') AND accepted_at IS NULL), 3, 'the refused invites stay open (not marked accepted)');
SELECT throws_ok($$INSERT INTO public.org_requesters (org_id, user_id) VALUES ('9f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000d1f00c1')$$, 'P0001', NULL, 'the guard trigger refuses it on direct insert too');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_accept('fx-hash-c3', '00000000-0000-0000-0000-00000d1f00c3', 'fx-c3@example.com')$$), 'no error', 'the owner of an own trial company may accept');
SELECT is((SELECT count(*)::integer FROM public.org_unit_members WHERE user_id = '00000000-0000-0000-0000-00000d1f00c3'), 1, 'with the invited unit');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_accept('fx-hash-c3', '00000000-0000-0000-0000-00000d1f00c3', 'fx-c3@example.com')$$), 'REQUESTER_INVITE_USED', 'a used invite is still reported as used');

-- 4. Список замовників для «Команди».
SELECT pg_temp.fx_as('a1');
SELECT is((SELECT count(*)::integer FROM public.own_fleet_requesters_list()), 2, 'owner sees both requesters (a4 and the accepted c3)');
SELECT is((SELECT email || '|' || coalesce(full_name, '-') || '|' || cardinality(unit_ids) FROM public.own_fleet_requesters_list() WHERE user_id = '00000000-0000-0000-0000-00000d1f00a4'),
  'fx-a4@example.com|Замовник Тест|1', 'email, name from the account metadata and the units');
SELECT pg_temp.fx_as('a3');
SELECT is((SELECT count(*)::integer FROM public.own_fleet_requesters_list()), 2, 'director (Менеджер) sees them too');
SELECT pg_temp.fx_as('b1');
SELECT is((SELECT count(*)::integer FROM public.own_fleet_requesters_list()), 0, 'another org sees none');
SELECT pg_temp.fx_as('a4');
SELECT is(pg_temp.fx_err($$SELECT * FROM public.own_fleet_requesters_list()$$), 'OWN_FLEET_FORBIDDEN', 'a requester cannot list requesters (no emails of colleagues)');
SELECT pg_temp.fx_as('c1');
SELECT is(pg_temp.fx_err($$SELECT * FROM public.own_fleet_requesters_list()$$), 'OWN_FLEET_FORBIDDEN', 'a user without access cannot list');
SELECT pg_temp.fx_as('a2');
SELECT is(pg_temp.fx_err($$SELECT * FROM public.own_fleet_requesters_list()$$), 'OWN_FLEET_FORBIDDEN', 'a logist cannot list requesters');
SELECT throws_ok($$SELECT * FROM public.own_fleet_requesters_list()$$, '42501', NULL, 'the refusal is an access error (42501)');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_requester_set_units('00000000-0000-0000-0000-00000d1f00c3', ARRAY[]::uuid[])$$), 'OWN_FLEET_FORBIDDEN', 'a logist cannot change the units of a requester');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_requester_remove('00000000-0000-0000-0000-00000d1f00c3')$$), 'OWN_FLEET_FORBIDDEN', 'a logist cannot remove a requester');
SELECT is((SELECT count(*)::integer FROM public.org_requesters WHERE user_id = '00000000-0000-0000-0000-00000d1f00c3'), 1, 'the requester is still there');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000d1f00a1","role":"service_role"}', true);
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_reserve('9f000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'fx-new@example.com', 'fx-hash-new', '00000000-0000-0000-0000-00000d1f00a2', now() + interval '7 days', ARRAY['9f100000-0000-0000-0000-000000000001']::uuid[])$$), 'OWN_FLEET_FORBIDDEN', 'a logist cannot invite a requester (reserve)');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_invite_reserve('9f000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'fx-new2@example.com', 'fx-hash-new2', '00000000-0000-0000-0000-00000d1f00a3', now() + interval '7 days', ARRAY['9f100000-0000-0000-0000-000000000001']::uuid[])$$), 'no error', 'a director (Менеджер) can');
SELECT pg_temp.fx_as('a3');
SELECT is(pg_temp.fx_err($$SELECT public.own_fleet_requester_set_units('00000000-0000-0000-0000-00000d1f00c3', ARRAY['9f100000-0000-0000-0000-000000000001']::uuid[])$$), 'no error', 'a director changes units');
SELECT pg_temp.fx_as('a1');
SELECT is(pg_temp.fx_err($$SELECT * FROM public.own_fleet_requesters_list()$$), 'no error', 'the owner (Директор) can list');
SELECT is(has_function_privilege('anon', 'public.own_fleet_requesters_list()', 'EXECUTE'), false, 'anon cannot call it');

SELECT * FROM finish();
ROLLBACK;
