-- Лічильник неоплачених рахунків (20261118090000_kp_unpaid_invoices_count.sql): що рахується, доступ, відсутність прав у anon.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(8);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A — компанія на control_plus (owner, логіст, директор КП); C — чужа control_plus; D — тариф company.
INSERT INTO public.organizations (id, name, work_mode) VALUES
  ('7a100000-0000-0000-0000-00000000000a', 'Unpaid A', 'team'),
  ('7a100000-0000-0000-0000-00000000000b', 'Unpaid P director own', 'solo'),
  ('7a100000-0000-0000-0000-00000000000c', 'Unpaid C foreign', 'solo'),
  ('7a100000-0000-0000-0000-00000000000d', 'Unpaid D company plan', 'solo');
SELECT public.set_org_plan('7a100000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('7a100000-0000-0000-0000-00000000000c', 'control_plus');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email, '', now(),
       '{"provider":"email","providers":["email"]}', '{"company_name":"Unpaid fixture"}', now(), now()
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'owner.a.unpaid@example.com'),
  ('00000000-0000-0000-0000-0000000000d2', 'logist.a.unpaid@example.com'),
  ('00000000-0000-0000-0000-0000000000d4', 'director.unpaid@example.com'),
  ('00000000-0000-0000-0000-0000000000d5', 'owner.c.unpaid@example.com'),
  ('00000000-0000-0000-0000-0000000000d6', 'owner.d.unpaid@example.com')
) AS u(id, email);
UPDATE public.profiles AS p SET org_id = m.org::uuid, org_role = m.role, member_status = 'active', is_approved = true
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000d1', '7a100000-0000-0000-0000-00000000000a', 'owner'),
  ('00000000-0000-0000-0000-0000000000d2', '7a100000-0000-0000-0000-00000000000a', 'logist'),
  ('00000000-0000-0000-0000-0000000000d4', '7a100000-0000-0000-0000-00000000000b', 'owner'),
  ('00000000-0000-0000-0000-0000000000d5', '7a100000-0000-0000-0000-00000000000c', 'owner'),
  ('00000000-0000-0000-0000-0000000000d6', '7a100000-0000-0000-0000-00000000000d', 'owner')
) AS m(id, org, role) WHERE p.id = m.id::uuid;
INSERT INTO public.org_directors (org_id, user_id) VALUES ('7a100000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d4');
INSERT INTO public.clients (id, org_id, name) VALUES ('7a200000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-00000000000a', 'Клієнт Unpaid');

-- Рахунки: I1 неоплачений; I2 частково оплачений; I3 повністю оплачений (журнал); I4 позначений оплаченим (paid_at); I5 анульований; I6 прострочений; A1 — акт.
CREATE FUNCTION pg_temp.doc(p_id text, p_kind text, p_no int, p_status text DEFAULT 'issued', p_due date DEFAULT NULL, p_date date DEFAULT DATE '2026-11-12') RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.kp_documents (id, org_id, kind, number, doc_year, doc_date, client_id, seller, buyer, rate_date, subtotal, vat_amount, total, total_uah, due_date, status, cancelled_at)
  VALUES (('7a300000-0000-0000-0000-0000000000' || p_id)::uuid, '7a100000-0000-0000-0000-00000000000a', p_kind, p_no, 2026, p_date, '7a200000-0000-0000-0000-000000000001',
          '{}'::jsonb, '{}'::jsonb, LEAST(p_date, DATE '2026-11-12'), 100, 0, 100, 100, p_due, p_status, CASE WHEN p_status = 'cancelled' THEN now() END);
$$;
SELECT pg_temp.doc('01', 'invoice', 1);
SELECT pg_temp.doc('02', 'invoice', 2);
SELECT pg_temp.doc('03', 'invoice', 3);
SELECT pg_temp.doc('04', 'invoice', 4);
SELECT pg_temp.doc('05', 'invoice', 5, 'cancelled');
SELECT pg_temp.doc('06', 'invoice', 6, 'issued', DATE '2026-01-10', DATE '2026-01-01');
SELECT pg_temp.doc('07', 'act', 7);
INSERT INTO public.kp_document_payments (org_id, doc_id, paid_on, amount) VALUES
  ('7a100000-0000-0000-0000-00000000000a', '7a300000-0000-0000-0000-000000000002', DATE '2026-11-13', 40),
  ('7a100000-0000-0000-0000-00000000000a', '7a300000-0000-0000-0000-000000000003', DATE '2026-11-13', 100);
UPDATE public.kp_documents SET paid_at = now() WHERE id = '7a300000-0000-0000-0000-000000000004';

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

SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'SELECT public.kp_unpaid_invoices_count()::text'), '3',
  '1: owner: неоплачений, частково оплачений і прострочений (оплачені, позначений paid_at, анульований і акт не рахуються)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d2', 'SELECT public.kp_unpaid_invoices_count()::text'), '3', '2: логіст бачить те саме');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d4', 'SELECT public.kp_unpaid_invoices_count()::text'), '3', '3: директор КП (org_directors) — теж');

-- Позначка «оплачено» з реєстру заявок (registry_doc_set_paid) і повна оплата за журналом зменшують лічильник.
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', $$SELECT (public.registry_doc_set_paid('7a300000-0000-0000-0000-000000000001', true) ->> 'count')$$), '1', '4: позначили рахунок оплаченим');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'SELECT public.kp_unpaid_invoices_count()::text'), '2', '5: лічильник зменшився (без вибірки документів)');

SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d5', 'SELECT public.kp_unpaid_invoices_count()::text'), '0',
  '6: чужа компанія рахує лише свої рахунки (0), чужі не бачить');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000d6', 'SELECT public.kp_unpaid_invoices_count()::text'), '42501', '7: тариф без control_plus — 42501');
SELECT ok(has_function_privilege('authenticated', 'public.kp_unpaid_invoices_count()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.kp_unpaid_invoices_count()', 'EXECUTE'),
  '8: EXECUTE лише для authenticated / service_role, anon без прав');

SELECT * FROM finish();
ROLLBACK;
