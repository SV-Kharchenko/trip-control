-- Директори Контроль+ (20261114090000_registry_directors.sql): реєстр і заявки компанії через org_directors + control_plus.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Тест від суперкористувача: auth.uid() із request.jwt.claims; RLS перевіряється явним SET LOCAL ROLE authenticated.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(26);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A — компанія директора на control_plus; P — власна компанія директора (company); Q — компанія з директором, але на company;
-- C — чужа control_plus без цього директора.
INSERT INTO public.organizations (id, name, work_mode) VALUES
  ('70000000-0000-0000-0000-00000000000a', 'Dir A', 'team'),
  ('70000000-0000-0000-0000-00000000000b', 'Dir P own', 'solo'),
  ('70000000-0000-0000-0000-00000000000c', 'Dir C foreign', 'solo'),
  ('70000000-0000-0000-0000-00000000000d', 'Dir Q company plan', 'solo');
SELECT public.set_org_plan('70000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('70000000-0000-0000-0000-00000000000c', 'control_plus');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email, '', now(),
       '{"provider":"email","providers":["email"]}', '{"company_name":"Dir fixture"}', now(), now()
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'owner.a.dir@example.com'),
  ('00000000-0000-0000-0000-0000000000e2', 'logist.a.dir@example.com'),
  ('00000000-0000-0000-0000-0000000000e3', 'director.dir@example.com'),
  ('00000000-0000-0000-0000-0000000000e4', 'owner.c.dir@example.com')
) AS u(id, email);

UPDATE public.profiles AS p
SET org_id = m.org::uuid, org_role = m.role, member_status = 'active', is_approved = true
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000e1', '70000000-0000-0000-0000-00000000000a', 'owner'),
  ('00000000-0000-0000-0000-0000000000e2', '70000000-0000-0000-0000-00000000000a', 'logist'),
  ('00000000-0000-0000-0000-0000000000e3', '70000000-0000-0000-0000-00000000000b', 'owner'),
  ('00000000-0000-0000-0000-0000000000e4', '70000000-0000-0000-0000-00000000000c', 'owner')
) AS m(id, org, role)
WHERE p.id = m.id::uuid;

INSERT INTO public.org_directors (org_id, user_id) VALUES
  ('70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e3'),
  ('70000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000e3');

INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000a', 'AA7001KA');
INSERT INTO public.clients (id, org_id, name) VALUES ('72000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000a', 'Клієнт A');

-- Заявки: A — прийнята a1 (автор owner, є факт, авто, клієнт), скасована a2 і чернетка a3 (автор логіст); Q, P, C — по одній прийнятій.
CREATE FUNCTION pg_temp.mk(p_id uuid, p_org uuid, p_user uuid, p_status text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, decided_at)
  VALUES (p_id, p_org, p_user, 'dir ' || left(p_id::text, 8), '{"dist":"100"}'::jsonb, '{"grossIncome":1000,"netProfit":100}'::jsonb,
          CASE WHEN p_status IN ('cancelled', 'done') THEN 'accepted' ELSE p_status END, CASE WHEN p_status = 'draft' THEN NULL ELSE now() END);
  IF p_status = 'cancelled' THEN
    UPDATE public.calculations SET status = 'cancelled', cancel_reason = 'setup' WHERE id = p_id;
  ELSIF p_status = 'done' THEN
    UPDATE public.calculations SET status = 'done' WHERE id = p_id;
  END IF;
  RETURN p_id;
END;
$$;
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'accepted');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e2', 'cancelled');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e2', 'draft');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000004', '70000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000e1', 'accepted');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000005', '70000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e3', 'accepted');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000006', '70000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000e4', 'accepted');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000007', '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'pending');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000008', '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'rejected');
SELECT pg_temp.mk('73000000-0000-0000-0000-000000000009', '70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'done');
INSERT INTO public.clients (id, org_id, name) VALUES ('72000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-00000000000c', 'Клієнт C');
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('71000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-00000000000c', 'CC7002KA');
INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage) VALUES ('73000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 20);
INSERT INTO public.calculation_clients (calculation_id, client_id, org_id) VALUES ('73000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000a');
INSERT INTO public.trip_actuals (org_id, calculation_id, revenue, costs, planned_overhead, profit, entered_by)
VALUES ('70000000-0000-0000-0000-00000000000a', '73000000-0000-0000-0000-000000000001', 1000, 900, 20, 80, '00000000-0000-0000-0000-0000000000e1');

-- Під роллю authenticated: що бачить користувач (рядок результатів), помилка — SQLSTATE.
CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN others THEN
    v := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN v;
END;
$$;

-- ---------------------------------------------------------------------------
-- Директор Контроль+ (control_plus)
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000a"}'::jsonb)$$), '3',
  '1: директор бачить реєстр своєї компанії (accepted + done + cancelled)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT string_agg(id::text, ',') FROM public.registry_list('{}'::jsonb)$$), '73000000-0000-0000-0000-000000000005',
  '2: без org_id — як раніше, власна організація директора');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT total_count || '/' || cancelled_count || '/' || profit_fact FROM public.registry_totals('{"org_id":"70000000-0000-0000-0000-00000000000a"}'::jsonb)$$), '3/1/180',
  '3: registry_totals компанії: кількість, скасовані, прибуток факт = факт, інакше план (80 + 100 плану done без факту)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000a","vehicle":"71000000-0000-0000-0000-000000000001"}'::jsonb)$$), '1',
  '4: фільтр «авто» працює для директора (calc_vehicles)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000a","client":"72000000-0000-0000-0000-000000000001"}'::jsonb)$$), '1',
  '5: фільтр «клієнт» працює для директора (calculation_clients)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT fact_profit::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000a","status":"accepted"}'::jsonb)$$), '80',
  '6: прибуток факт з trip_actuals видно директору');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT 'A=' || (SELECT count(*) FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000a')
      || ' Q=' || (SELECT count(*) FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000d')
      || ' C=' || (SELECT count(*) FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000c')
      || ' P=' || (SELECT count(*) FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000b')$$), 'A=4 Q=0 C=0 P=1',
  '7: SELECT calculations: директор бачить 4 заявки A (pending, accepted, done, cancelled) і свою P; Q (company) і C — ні');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$WITH x AS (SELECT 1) SELECT (SELECT count(*) FROM public.trip_actuals WHERE org_id = '70000000-0000-0000-0000-00000000000a')::text$$), '1',
  '8: SELECT trip_actuals компанії директора');
-- UPDATE не розширено: директор не змінює заявку компанії (RLS відсікає рядок; 0 змінених).
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$WITH u AS (UPDATE public.calculations SET name = 'змінено директором' WHERE id = '73000000-0000-0000-0000-000000000001' RETURNING 1) SELECT count(*)::text FROM u$$), '0',
  '9: UPDATE заявки директором не проходить (статуси міняє API)');
-- Статуси: чернетки й відхилені логістів директор не бачить, решту — бачить.
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT string_agg(status, ',' ORDER BY status) FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000a'$$), 'accepted,cancelled,done,pending',
  '22: директор бачить pending / accepted / done / cancelled компанії');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.calculations WHERE id IN ('73000000-0000-0000-0000-000000000003', '73000000-0000-0000-0000-000000000008')$$), '0',
  '23: чернетка (a3) і відхилена (a5) чужої компанії директору не видно');
-- clients і fleet_vehicles: лише читання власної КП-компанії.
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT (SELECT count(*) FROM public.clients WHERE org_id = '70000000-0000-0000-0000-00000000000a') || '/' ||
           (SELECT count(*) FROM public.fleet_vehicles WHERE org_id = '70000000-0000-0000-0000-00000000000a') || '/' ||
           (SELECT count(*) FROM public.clients WHERE org_id = '70000000-0000-0000-0000-00000000000c') || '/' ||
           (SELECT count(*) FROM public.fleet_vehicles WHERE org_id = '70000000-0000-0000-0000-00000000000c')$$), '1/1/0/0',
  '24: директор бачить clients і fleet_vehicles своєї компанії, не чужої');
SELECT is(
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$WITH u AS (UPDATE public.clients SET name = 'змінено' WHERE org_id = '70000000-0000-0000-0000-00000000000a' RETURNING 1) SELECT count(*)::text FROM u$$) || '/' ||
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$WITH u AS (UPDATE public.fleet_vehicles SET label = 'змінено' WHERE org_id = '70000000-0000-0000-0000-00000000000a' RETURNING 1) SELECT count(*)::text FROM u$$) || '/' ||
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$WITH d AS (DELETE FROM public.clients WHERE org_id = '70000000-0000-0000-0000-00000000000a' RETURNING 1) SELECT count(*)::text FROM d$$) || '/' ||
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$INSERT INTO public.clients (org_id, name) VALUES ('70000000-0000-0000-0000-00000000000a', 'вставлено директором') RETURNING 'вставлено'$$),
  '0/0/0/42501', '25: директор не змінює, не видаляє й не додає clients / fleet_vehicles (UPDATE, DELETE — 0 рядків, INSERT — 42501)');
SELECT is(
  has_function_privilege('authenticated', 'public.can_view_org(uuid)', 'EXECUTE')::text || '/' ||
  has_function_privilege('service_role', 'public.can_view_org(uuid)', 'EXECUTE')::text || '/' ||
  has_function_privilege('anon', 'public.can_view_org(uuid)', 'EXECUTE')::text,
  'true/true/false', '26: EXECUTE can_view_org: authenticated і service_role — так, anon — ні');

-- ---------------------------------------------------------------------------
-- Чужа компанія / тариф company
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000c"}'::jsonb)$$), '42501',
  '10: чужа компанія (директор не вказаний) — REGISTRY_FORBIDDEN');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_totals('{"org_id":"70000000-0000-0000-0000-00000000000c"}'::jsonb)$$), '42501',
  '11: registry_totals чужої компанії — 42501');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000d"}'::jsonb)$$), '42501',
  '12: директор без тарифу control_plus (компанія на company) реєстру не бачить');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT string_agg(o.label || '=' || public.can_view_org(o.id)::text, ' ' ORDER BY o.label) FROM (VALUES
      ('A', '70000000-0000-0000-0000-00000000000a'::uuid), ('C', '70000000-0000-0000-0000-00000000000c'::uuid),
      ('P', '70000000-0000-0000-0000-00000000000b'::uuid), ('Q', '70000000-0000-0000-0000-00000000000d'::uuid)) AS o(label, id)$$),
  'A=true C=false P=true Q=false', '13: can_view_org: власна й директорська (control_plus) — так, чужа й company — ні');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$SELECT public.can_view_org(NULL)::text$$), 'false', '14: can_view_org(NULL) = false');

-- ---------------------------------------------------------------------------
-- Логіст і власник: без змін
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e1', $$SELECT count(*)::text FROM public.registry_list('{}'::jsonb)$$), '3',
  '15: власник A: реєстр за замовчуванням (accepted + cancelled) — як раніше');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e1', $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000a"}'::jsonb)$$), '3',
  '16: власник A з явним org_id = своя компанія');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e1', $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000b"}'::jsonb)$$), '42501',
  '17: власник не бачить чужу компанію через org_id');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e2', $$SELECT count(*)::text FROM public.registry_list('{}'::jsonb)$$), '1',
  '18: логіст без права бачить лише свої (скасована a2) — без змін');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e2', $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000d"}'::jsonb)$$), '42501',
  '19: логіст не бачить компанію, де не директор');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e4', $$SELECT (SELECT count(*) FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000a')::text$$), '0',
  '20: власник чужої компанії не бачить заявок A (директорські політики на нього не діють)');

-- Тариф знижено: директор одразу втрачає доступ до реєстру й заявок компанії.
SELECT public.set_org_plan('70000000-0000-0000-0000-00000000000a', 'company');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000e3',
  $$SELECT count(*)::text FROM public.registry_list('{"org_id":"70000000-0000-0000-0000-00000000000a"}'::jsonb)$$) || '/' ||
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$SELECT count(*)::text FROM public.calculations WHERE org_id = '70000000-0000-0000-0000-00000000000a'$$) || '/' ||
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$SELECT count(*)::text FROM public.clients WHERE org_id = '70000000-0000-0000-0000-00000000000a'$$) || '/' ||
  pg_temp.as_user('00000000-0000-0000-0000-0000000000e3', $$SELECT count(*)::text FROM public.fleet_vehicles WHERE org_id = '70000000-0000-0000-0000-00000000000a'$$),
  '42501/0/0/0', '21: після зниження тарифу A до company директор нічого не бачить (реєстр, заявки, clients, fleet_vehicles)');

SELECT * FROM finish();
ROLLBACK;
