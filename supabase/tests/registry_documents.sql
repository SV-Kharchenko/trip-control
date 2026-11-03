-- Документи й оплати в реєстрі (20261116090000_registry_documents.sql): registry_doc_set_paid (група заявки / parent_id), registry_documents, доступ.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(25);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A — компанія на control_plus (owner, два логісти, директор КП); C — чужа control_plus; D — компанія на тарифі company.
INSERT INTO public.organizations (id, name, work_mode) VALUES
  ('76000000-0000-0000-0000-00000000000a', 'Docs A', 'team'),
  ('76000000-0000-0000-0000-00000000000b', 'Docs P director own', 'solo'),
  ('76000000-0000-0000-0000-00000000000c', 'Docs C foreign', 'solo'),
  ('76000000-0000-0000-0000-00000000000d', 'Docs D company plan', 'solo');
SELECT public.set_org_plan('76000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('76000000-0000-0000-0000-00000000000c', 'control_plus');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email, '', now(),
       '{"provider":"email","providers":["email"]}', '{"company_name":"Docs fixture"}', now(), now()
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'owner.a.docs@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'logist.ok.docs@example.com'),
  ('00000000-0000-0000-0000-0000000000a3', 'logist.no.docs@example.com'),
  ('00000000-0000-0000-0000-0000000000a4', 'director.docs@example.com'),
  ('00000000-0000-0000-0000-0000000000a5', 'owner.c.docs@example.com'),
  ('00000000-0000-0000-0000-0000000000a6', 'owner.d.docs@example.com')
) AS u(id, email);
UPDATE public.profiles AS p SET org_id = m.org::uuid, org_role = m.role, member_status = CASE WHEN p.id = '00000000-0000-0000-0000-0000000000a3' THEN 'disabled' ELSE 'active' END, is_approved = true
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-00000000000a', 'owner'),
  ('00000000-0000-0000-0000-0000000000a2', '76000000-0000-0000-0000-00000000000a', 'logist'),
  ('00000000-0000-0000-0000-0000000000a3', '76000000-0000-0000-0000-00000000000a', 'logist'),
  ('00000000-0000-0000-0000-0000000000a4', '76000000-0000-0000-0000-00000000000b', 'owner'),
  ('00000000-0000-0000-0000-0000000000a5', '76000000-0000-0000-0000-00000000000c', 'owner'),
  ('00000000-0000-0000-0000-0000000000a6', '76000000-0000-0000-0000-00000000000d', 'owner')
) AS m(id, org, role) WHERE p.id = m.id::uuid;
INSERT INTO public.org_directors (org_id, user_id) VALUES ('76000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a4');
INSERT INTO public.org_member_permissions (org_id, user_id, can_acts) VALUES
  ('76000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', true),
  ('76000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', false);

INSERT INTO public.clients (id, org_id, name) VALUES ('77000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-00000000000a', 'Клієнт Docs');
-- Заявка (accepted) автора-логіста a2 з клієнтом; договір клієнта чинний на дату рейсу.
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, decided_at)
VALUES ('78000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'docs trip',
        '{"dist":"100"}'::jsonb, '{"grossIncome":1000,"netProfit":100}'::jsonb, 'accepted', now());
UPDATE public.calculations SET trip_date = DATE '2026-11-10' WHERE id = '78000000-0000-0000-0000-000000000001';
-- Друга заявка: її рахунок і акти БЕЗ parent_id (як на проді) — група лише через заявку.
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, decided_at)
VALUES ('78000000-0000-0000-0000-000000000002', '76000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'docs trip 2',
        '{"dist":"50"}'::jsonb, '{"grossIncome":500,"netProfit":50}'::jsonb, 'accepted', now());
INSERT INTO public.calculation_clients (calculation_id, client_id, org_id)
VALUES ('78000000-0000-0000-0000-000000000001', '77000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-00000000000a');
INSERT INTO public.kp_contracts (id, org_id, client_id, number, contract_date, valid_until) VALUES
  ('79000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-00000000000a', '77000000-0000-0000-0000-000000000001', 'Д-1/2026', DATE '2026-01-01', DATE '2026-12-31'),
  ('79000000-0000-0000-0000-000000000002', '76000000-0000-0000-0000-00000000000a', '77000000-0000-0000-0000-000000000001', 'Д-0/2024', DATE '2024-01-01', DATE '2024-12-31');

-- Документи: I1 з актами A1, A2 і скасованим A5; I2 з актом A3; окремий акт A4.
CREATE FUNCTION pg_temp.doc(p_id text, p_kind text, p_no int, p_parent text, p_status text DEFAULT 'issued', p_calc text DEFAULT '1') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.kp_documents (id, org_id, kind, number, doc_year, doc_date, client_id, parent_id, seller, buyer, rate_date, subtotal, vat_amount, total, total_uah, status, cancelled_at)
  VALUES (('7a000000-0000-0000-0000-0000000000' || p_id)::uuid, '76000000-0000-0000-0000-00000000000a', p_kind, p_no, 2026, DATE '2026-11-12', '77000000-0000-0000-0000-000000000001',
          CASE WHEN p_parent IS NULL THEN NULL ELSE ('7a000000-0000-0000-0000-0000000000' || p_parent)::uuid END,
          '{}'::jsonb, '{}'::jsonb, DATE '2026-11-12', 100, 0, 100, 100, p_status, CASE WHEN p_status = 'cancelled' THEN now() END);
  INSERT INTO public.kp_document_lines (doc_id, org_id, kind, active, sort, calculation_id, title, qty, price, amount)
  VALUES (('7a000000-0000-0000-0000-0000000000' || p_id)::uuid, '76000000-0000-0000-0000-00000000000a', p_kind, p_id IN ('11', '21'), 1,
          ('78000000-0000-0000-0000-00000000000' || p_calc)::uuid, 'послуга', 1, 100, 100);
END;
$$;
-- Один активний рядок на пару (заявка, kind): активні лише у I1 і A1; решта документів — з неактивними рядками (для даних реєстру достатньо посилання).
SELECT pg_temp.doc('11', 'invoice', 1, NULL);
SELECT pg_temp.doc('21', 'act', 1, '11');
SELECT pg_temp.doc('22', 'act', 2, '11');
SELECT pg_temp.doc('23', 'act', 3, '11', 'cancelled');
SELECT pg_temp.doc('12', 'invoice', 2, NULL, 'cancelled');
SELECT pg_temp.doc('24', 'act', 4, NULL, 'cancelled');
-- Заявка 2: рахунок I3 і акти A6, A7 без parent_id.
SELECT pg_temp.doc('61', 'invoice', 7, NULL, 'issued', '2');
SELECT pg_temp.doc('62', 'act', 7, NULL, 'issued', '2');
SELECT pg_temp.doc('63', 'act', 8, NULL, 'issued', '2');

-- Ще один рахунок із актом (I2 / A3) і окремий акт A4: без рядків на заявку — оплата лише через RPC.
INSERT INTO public.kp_documents (id, org_id, kind, number, doc_year, doc_date, client_id, parent_id, seller, buyer, rate_date, subtotal, vat_amount, total, total_uah)
VALUES
  ('7a000000-0000-0000-0000-000000000031', '76000000-0000-0000-0000-00000000000a', 'invoice', 3, 2026, DATE '2026-11-12', '77000000-0000-0000-0000-000000000001', NULL, '{}', '{}', DATE '2026-11-12', 100, 0, 100, 100),
  ('7a000000-0000-0000-0000-000000000041', '76000000-0000-0000-0000-00000000000a', 'act', 5, 2026, DATE '2026-11-12', '77000000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000031', '{}', '{}', DATE '2026-11-12', 100, 0, 100, 100),
  ('7a000000-0000-0000-0000-000000000051', '76000000-0000-0000-0000-00000000000a', 'act', 6, 2026, DATE '2026-11-12', '77000000-0000-0000-0000-000000000001', NULL, '{}', '{}', DATE '2026-11-12', 100, 0, 100, 100);

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
-- Стан оплат: мітки документів у порядку міток (t — оплачено).
CREATE FUNCTION pg_temp.paid_state() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(m.label || '=' || (d.paid_at IS NOT NULL)::text, ' ' ORDER BY m.ord)
  FROM (VALUES
    (1, 'I1', '7a000000-0000-0000-0000-000000000011'::uuid), (2, 'A1', '7a000000-0000-0000-0000-000000000021'::uuid),
    (3, 'A2', '7a000000-0000-0000-0000-000000000022'::uuid), (4, 'A5', '7a000000-0000-0000-0000-000000000023'::uuid),
    (5, 'I2', '7a000000-0000-0000-0000-000000000031'::uuid), (6, 'A3', '7a000000-0000-0000-0000-000000000041'::uuid),
    (7, 'A4', '7a000000-0000-0000-0000-000000000051'::uuid), (8, 'I3', '7a000000-0000-0000-0000-000000000061'::uuid),
    (9, 'A6', '7a000000-0000-0000-0000-000000000062'::uuid), (10, 'A7', '7a000000-0000-0000-0000-000000000063'::uuid)
  ) AS m(ord, label, id) JOIN public.kp_documents AS d ON d.id = m.id;
$$;
SELECT is(pg_temp.paid_state(), 'I1=false A1=false A2=false A5=false I2=false A3=false A4=false I3=false A6=false A7=false', '1: початково нічого не оплачено');

-- ---------------------------------------------------------------------------
-- Зв'язка рахунок ↔ акти
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', true) ->> 'count')$$), '3',
  '2: рахунок позначено оплаченим — оплачуються рахунок і обидва акти (3 документи; група: заявка + parent_id)');
SELECT is(pg_temp.paid_state(), 'I1=true A1=true A2=true A5=false I2=false A3=false A4=false I3=false A6=false A7=false',
  '3: анульований акт A5 і документи інших груп не чіпаються');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000021', false) ->> 'count')$$), '3', '4: зняли оплату з акта');
SELECT is(pg_temp.paid_state(), 'I1=false A1=false A2=false A5=false I2=false A3=false A4=false I3=false A6=false A7=false', '5: оплата знялась з рахунку і всіх актів групи');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000022', true) ->> 'count')$$), '3', '6: акт позначено оплаченим');
SELECT is(pg_temp.paid_state(), 'I1=true A1=true A2=true A5=false I2=false A3=false A4=false I3=false A6=false A7=false', '7: «навпаки»: акт тягне рахунок і всі акти того ж рахунку');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', false) ->> 'count')$$), '3', '8: зняли оплату з рахунку');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000051', true)::text$$), '{"paid": true, "count": 1, "doc_ids": ["7a000000-0000-0000-0000-000000000051"]}',
  '9: акт без рахунку — лише він сам');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000031', true) ->> 'count')$$), '2',
  '10: інша група (I2 + A3) окремо від першої');
SELECT is(pg_temp.paid_state(), 'I1=false A1=false A2=false A5=false I2=true A3=true A4=true I3=false A6=false A7=false', '11: стан після кількох груп');

-- ---------------------------------------------------------------------------
-- Група через заявку БЕЗ parent_id: рахунок I3 і акти A6, A7 мають лише рядки на заявку 2
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000061', true) ->> 'count')$$), '3',
  '12a: заявка без parent_id: рахунок → оплачуються рахунок і обидва акти');
SELECT is(pg_temp.paid_state(), 'I1=false A1=false A2=false A5=false I2=true A3=true A4=true I3=true A6=true A7=true', '12b: усі три документи заявки 2 оплачені, заявка 1 не чіпається');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000063', false) ->> 'count')$$), '3',
  '12c: зняли оплату з акта — знімається з рахунку й обох актів');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000062', true) ->> 'count')$$), '3',
  '12d: акт → оплачуються рахунок і другий акт (навпаки)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000061', false) ->> 'count')$$), '3', '12e: знімаємо оплату з усієї групи');
SELECT is(pg_temp.paid_state(), 'I1=false A1=false A2=false A5=false I2=true A3=true A4=true I3=false A6=false A7=false', '12f: після зняття група заявки 2 неоплачена');

-- ---------------------------------------------------------------------------
-- Доступ
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a4', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', true) ->> 'count')$$), '3',
  '12: директор КП (org_directors, control_plus) ставить оплату');
SELECT is((SELECT paid_by::text FROM public.kp_documents WHERE id = '7a000000-0000-0000-0000-000000000011'), '00000000-0000-0000-0000-0000000000a4', '13: paid_by — той, хто позначив');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a2', $$SELECT (public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', false) ->> 'count')$$), '3',
  '14: логіст (kp_can_write, без окремого права can_acts) знімає оплату');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a3', $$SELECT public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', true)::text$$), '42501',
  '15: логіст без доступу (вимкнений, disabled) — відмова (42501)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a5', $$SELECT public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', true)::text$$), '42501',
  '16: чужа організація — 42501 DOC_FORBIDDEN');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a6', $$SELECT public.registry_doc_set_paid('7a000000-0000-0000-0000-000000000011', true)::text$$), '42501',
  '17: організація без control_plus — 42501');

-- ---------------------------------------------------------------------------
-- Дані для реєстру
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a1',
  $$SELECT contract_no || '/' || jsonb_array_length(docs) || '/' || (SELECT string_agg(x ->> 'number' || ':' || (x ->> 'paid'), ',' ORDER BY x ->> 'number') FROM jsonb_array_elements(docs) AS x)
    FROM public.registry_documents(ARRAY['78000000-0000-0000-0000-000000000001'::uuid])$$), 'Д-1/2026/6/1:false,1:false,2:false,2:false,3:false,4:false',
  '18: registry_documents: договір чинний на дату рейсу (Д-1/2026, не прострочений Д-0/2024), документи заявки з номерами, статусом і ознакою оплати');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000a5', $$SELECT count(*)::text FROM public.registry_documents(ARRAY['78000000-0000-0000-0000-000000000001'::uuid])$$), '0',
  '19: чужа організація документів заявки не бачить');

SELECT * FROM finish();
ROLLBACK;
