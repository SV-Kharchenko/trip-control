-- Контроль+ документи, етап 4a (*_kp_documents.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim and a minimal
-- storage schema stub (and applies the migration several times — idempotency).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(234);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"service_role"}', true);

-- P: control_plus (owner d001, logist d002, директор d009, менеджер з ремонтів d005); Q: control_plus (owner d008);
-- R: тариф «Компанія» (owner d007); S: control_plus для боргів (owner d010).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('80000000-0000-0000-0000-00000000000a', 'KD plan', 'team'),
       ('80000000-0000-0000-0000-00000000000b', 'KD other', 'solo'),
       ('80000000-0000-0000-0000-00000000000c', 'KD company', 'solo'),
       ('80000000-0000-0000-0000-00000000000d', 'KD debts', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'kd-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'KD ' || k), now(), now()
FROM unnest(ARRAY['d001', 'd002', 'd005', 'd007', 'd008', 'd009', 'd010']) AS k;

UPDATE public.profiles
SET org_id = CASE id
               WHEN '00000000-0000-0000-0000-00000000d008' THEN '80000000-0000-0000-0000-00000000000b'::uuid
               WHEN '00000000-0000-0000-0000-00000000d007' THEN '80000000-0000-0000-0000-00000000000c'::uuid
               WHEN '00000000-0000-0000-0000-00000000d010' THEN '80000000-0000-0000-0000-00000000000d'::uuid
               ELSE '80000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000d002' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000d007',
             '00000000-0000-0000-0000-00000000d008', '00000000-0000-0000-0000-00000000d010');

SELECT public.set_org_plan('80000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('80000000-0000-0000-0000-00000000000b', 'control_plus');
SELECT public.set_org_plan('80000000-0000-0000-0000-00000000000d', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('80000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000d009');
INSERT INTO public.org_repair_handlers (org_id, user_id, kind)
VALUES ('80000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000d005', 'repair_manager');

-- Клієнти: c11 — ТОВ з договором і строком 10 днів; c12 — ФОП без строку (5 днів); c13 — архівний; c21 — чужа org Q;
-- c31…c33 — org S (борги).
INSERT INTO public.clients (id, org_id, name, legal_name, legal_form, edrpou, ipn, signer_name, signer_position, legal_address,
                            contract_no, contract_date, payment_terms_days, archived_at)
VALUES
  ('81000000-0000-0000-0000-000000000011', '80000000-0000-0000-0000-00000000000a', 'Зерно', 'ТОВ «Зерно Трейд»', 'tov', '23456789', NULL,
   'Іваненко Іван', 'Директор', 'м. Одеса, вул. Портова, 7', 'Д-15/2026', DATE '2026-01-15', 10, NULL),
  ('81000000-0000-0000-0000-000000000012', '80000000-0000-0000-0000-00000000000a', 'ФОП Ґудзь', 'ФОП Ґудзь Євгенія Їжакова', 'fop', NULL, '1234567890',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('81000000-0000-0000-0000-000000000013', '80000000-0000-0000-0000-00000000000a', 'Архівний', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, now()),
  ('81000000-0000-0000-0000-000000000021', '80000000-0000-0000-0000-00000000000b', 'Клієнт Q', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('81000000-0000-0000-0000-000000000031', '80000000-0000-0000-0000-00000000000d', 'S-перший', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('81000000-0000-0000-0000-000000000032', '80000000-0000-0000-0000-00000000000d', 'S-другий', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('81000000-0000-0000-0000-000000000033', '80000000-0000-0000-0000-00000000000d', 'S-третій', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- Рейси P (жовтень 2026): k1–k3 клієнта c11 від логіста d002 (k2 з фактом 21 000), k4 клієнта c12 від власника,
-- k5 — чернетка c11, k6 — без клієнта; kq — рейс org Q.
INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, trip_date)
SELECT ('82000000-0000-0000-0000-0000000000' || k)::uuid, o::uuid, ('00000000-0000-0000-0000-00000000' || u)::uuid,
       nm, '{}'::jsonb, jsonb_build_object('grossIncome', rev), st, d::date
FROM (VALUES
  ('01', '80000000-0000-0000-0000-00000000000a', 'd002', 'Київ — Одеса', '10000', 'accepted', '2026-10-01'),
  ('02', '80000000-0000-0000-0000-00000000000a', 'd002', 'Київ — Львів', '20000', 'done',     '2026-10-02'),
  ('03', '80000000-0000-0000-0000-00000000000a', 'd002', 'Умань — Миколаїв', '30000', 'accepted', '2026-10-03'),
  ('04', '80000000-0000-0000-0000-00000000000a', 'd001', 'Житомир — Рівне', '5000', 'accepted', '2026-10-04'),
  ('05', '80000000-0000-0000-0000-00000000000a', 'd002', 'Чернетка', '7000', 'draft', '2026-10-05'),
  ('06', '80000000-0000-0000-0000-00000000000a', 'd002', 'Без клієнта', '8000', 'accepted', '2026-10-06'),
  ('21', '80000000-0000-0000-0000-00000000000b', 'd008', 'Чужий рейс', '9000', 'accepted', '2026-10-01')
) AS t(k, o, u, nm, rev, st, d);
INSERT INTO public.calculation_clients (calculation_id, client_id)
VALUES ('82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000011'),
       ('82000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-000000000011'),
       ('82000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000011'),
       ('82000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000012'),
       ('82000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000011'),
       ('82000000-0000-0000-0000-000000000021', '81000000-0000-0000-0000-000000000021');
INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by)
VALUES ('82000000-0000-0000-0000-000000000002', 21000, 0, 0, 0, '00000000-0000-0000-0000-00000000d002');

INSERT INTO storage.buckets (id, name, public) VALUES ('kd-other', 'kd-other', false) ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE t_kd (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_kd TO PUBLIC;
-- Реквізити P (повний набір полів; kp_requisites_save замінює всі поля, окрім шляхів до підпису й печатки).
CREATE TEMP TABLE t_kd_req (k text PRIMARY KEY, j jsonb);
GRANT ALL ON t_kd_req TO PUBLIC;
INSERT INTO t_kd_req VALUES
  ('P', '{"legal_name":"ТОВ «Тест Перевезення»","legal_form":"tov","edrpou":"12345678","vat_payer":true,"vat_number":"123456789012",
          "iban":"UA21 3223 1300 0002 6007 2335 6600 1","bank_name":"АТ «Тест Банк»","legal_address":"м. Київ, вул. Тестова, 1",
          "signer_name":"Петренко Петро","signer_position":"Директор","doc_place":"м. Київ","invoice_prefix":"РФ-","act_prefix":"АКТ-",
          "default_currency":"UAH","default_vat_mode":"net"}'),
  ('Q', '{"legal_name":"ФОП Квітка","legal_form":"fop","ipn":"2345678901","vat_payer":false,"iban":"UA213223130000026007233566001"}'),
  ('S', '{"legal_name":"ТОВ «Борги»","edrpou":"34567890","vat_payer":false,"iban":"UA213223130000026007233566001"}');

-- Повідомлення помилки запиту (або 'ok') і документ / номер / суми за ключем t_kd.
CREATE OR REPLACE FUNCTION pg_temp.kd_msg(q text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE q;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$f$;
CREATE OR REPLACE FUNCTION pg_temp.kd_doc(p_k text) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT public.kp_doc_get((SELECT t.id FROM t_kd AS t WHERE t.k = p_k)) $f$;
CREATE OR REPLACE FUNCTION pg_temp.kd_num(p_k text) RETURNS integer LANGUAGE sql AS
  $f$ SELECT (pg_temp.kd_doc(p_k) ->> 'number')::integer $f$;
CREATE OR REPLACE FUNCTION pg_temp.kd_sums(p_k text) RETURNS text LANGUAGE sql AS
  $f$ SELECT d ->> 'subtotal' || '|' || (d ->> 'vat_amount') || '|' || (d ->> 'total') FROM pg_temp.kd_doc(p_k) AS d $f$;
CREATE OR REPLACE FUNCTION pg_temp.kd_rows(q text) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  n integer;
BEGIN
  EXECUTE q;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$f$;
CREATE OR REPLACE FUNCTION pg_temp.kd_id(p_k text) RETURNS uuid LANGUAGE sql AS
  $f$ SELECT t.id FROM t_kd AS t WHERE t.k = p_k $f$;
GRANT EXECUTE ON FUNCTION pg_temp.kd_msg(text), pg_temp.kd_doc(text), pg_temp.kd_num(text), pg_temp.kd_sums(text), pg_temp.kd_id(text), pg_temp.kd_rows(text) TO PUBLIC;

-- 1. Права: anon нічого; таблиці без прямого доступу; внутрішні хелпери закриті; менеджер з ремонтів і тариф «Компанія».
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.kp_doc_list(NULL, DATE '2026-01-01', DATE '2026-12-31')$$, '42501', NULL, 'anon cannot call kp_doc_list');
SELECT throws_ok($$SELECT count(*) FROM public.kp_documents$$, '42501', NULL, 'anon cannot read kp_documents');
SELECT throws_ok($$SELECT * FROM public.kp_requisites_get()$$, '42501', NULL, 'anon cannot read requisites');
SELECT throws_ok($$SELECT * FROM public.kp_client_debts(NULL)$$, '42501', NULL, 'anon cannot read debts');
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 0, 'anon sees no storage objects of the bucket');
RESET ROLE;
SELECT ok(NOT has_function_privilege('authenticated', 'public.kp_docs_org(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_docs_org(text)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.kp_docs_org(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_doc_alloc_number(uuid, text, integer, integer)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.kp_doc_alloc_number(uuid, text, integer, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_doc_pay_status(text, text, numeric, numeric, date, date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_doc_paid(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_documents_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_document_lines_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.kp_document_payments_guard()', 'EXECUTE'),
  'internal helpers and trigger functions are closed to every API role');
SELECT ok(has_function_privilege('authenticated', 'public.kp_doc_create(text, uuid, date, text, integer, jsonb, uuid, date, text, numeric, date, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_doc_create(text, uuid, date, text, integer, jsonb, uuid, date, text, numeric, date, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_client_debts(date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_client_debts(date)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_requisites_save(jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_payment_void(uuid)', 'EXECUTE'),
  'client RPCs: authenticated yes, anon no');
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM pg_class AS c
           WHERE c.oid IN ('public.kp_org_requisites'::regclass, 'public.kp_doc_counters'::regclass, 'public.kp_documents'::regclass,
                           'public.kp_document_lines'::regclass, 'public.kp_document_payments'::regclass)),
  'RLS is enabled on every new table');
SELECT ok(NOT has_table_privilege('authenticated', 'public.kp_documents', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.kp_documents', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.kp_document_lines', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.kp_document_payments', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.kp_org_requisites', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.kp_doc_counters', 'INSERT'),
  'no table grants to clients (reads and writes only through the functions)');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO public.kp_documents (org_id) VALUES ('80000000-0000-0000-0000-00000000000a')$$, '42501', NULL, 'owner: no direct INSERT into kp_documents');
SELECT throws_ok($$UPDATE public.kp_documents SET total = 1$$, '42501', NULL, 'owner: no direct UPDATE of kp_documents');
SELECT throws_ok($$DELETE FROM public.kp_documents$$, '42501', NULL, 'owner: no direct DELETE of kp_documents');
SELECT throws_ok($$DELETE FROM public.kp_document_payments$$, '42501', NULL, 'owner: no direct DELETE of payments');
SELECT throws_ok($$INSERT INTO public.kp_doc_counters (org_id, kind, year) VALUES ('80000000-0000-0000-0000-00000000000a', 'invoice', 2026)$$,
  '42501', NULL, 'owner: no direct INSERT into counters');
SELECT throws_ok($$SELECT public.kp_doc_alloc_number('80000000-0000-0000-0000-00000000000a', 'invoice', 2026, NULL)$$, '42501', NULL,
  'owner: kp_doc_alloc_number is internal');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d005","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_doc_list(NULL, DATE '2026-01-01', DATE '2026-12-31')$$), 'KP_FORBIDDEN', 'repair manager: kp_doc_list — KP_FORBIDDEN');
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_requisites_get()$$), 'KP_FORBIDDEN', 'repair manager: requisites — KP_FORBIDDEN');
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_client_debts(NULL)$$), 'KP_FORBIDDEN', 'repair manager: debts — KP_FORBIDDEN');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1}]')$$), 'KP_FORBIDDEN', 'repair manager: create — KP_FORBIDDEN');
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 0, 'repair manager: no storage objects');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d007","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_doc_list(NULL, DATE '2026-01-01', DATE '2026-12-31')$$), 'CONTROL_PLUS_REQUIRED',
  'org on the company plan: CONTROL_PLUS_REQUIRED');

-- 2. Реквізити: пише лише owner; формат; без реквізитів документів немає.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_requisites_get()), 0, 'requisites: none yet');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1}]')$$), 'REQUISITES_REQUIRED', 'create without company requisites — REQUISITES_REQUIRED');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P'))$$), 'KP_FORBIDDEN', 'logist cannot change requisites');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P'))$$), 'KP_FORBIDDEN', 'director cannot change requisites');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P'))$$, 'owner saves requisites');
SELECT is((SELECT iban || '|' || vat_payer::text || '|' || invoice_prefix FROM public.kp_requisites_get()), 'UA213223130000026007233566001|true|РФ-',
  'requisites: IBAN normalized, VAT payer, prefix');
SELECT throws_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"iban":"UA12"}')$$, '23514', NULL, 'requisites: bad IBAN refused');
SELECT throws_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"edrpou":"1234567"}')$$, '23514', NULL, 'requisites: ЄДРПОУ of 7 digits refused');
SELECT throws_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"invoice_prefix":"ЗАДОВГИЙПРЕФІКС"}')$$, '23514', NULL, 'requisites: prefix longer than 10 refused');
SELECT throws_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"default_vat_mode":"mixed"}')$$, '23514', NULL, 'requisites: unknown default VAT mode refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"signature_path":"80000000-0000-0000-0000-00000000000a/signature.png"}')$$),
  'REQUISITES_ASSET_MISSING', 'requisites: signature path without an uploaded file refused');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT is((SELECT legal_name FROM public.kp_requisites_get()), 'ТОВ «Тест Перевезення»', 'director reads the requisites');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_requisites_get()), 0, 'another org does not see the requisites');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'Q'))$$, 'owner Q saves own requisites (not a VAT payer)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d010","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'S'))$$, 'owner S saves own requisites');

-- 3. Клієнти: нові CHECK-и (запис клієнтів — як і раніше, напряму через RLS).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT throws_ok($$UPDATE public.clients SET payment_terms_days = 366 WHERE id = '81000000-0000-0000-0000-000000000011'$$, '23514', NULL, 'clients: payment terms 366 refused');
SELECT throws_ok($$UPDATE public.clients SET payment_terms_days = -1 WHERE id = '81000000-0000-0000-0000-000000000011'$$, '23514', NULL, 'clients: payment terms −1 refused');
SELECT throws_ok($$UPDATE public.clients SET contract_no = repeat('x', 101) WHERE id = '81000000-0000-0000-0000-000000000011'$$, '23514', NULL, 'clients: contract № of 101 chars refused');
SELECT throws_ok($$UPDATE public.clients SET contract_no = '   ' WHERE id = '81000000-0000-0000-0000-000000000011'$$, '23514', NULL, 'clients: blank contract № refused');
SELECT lives_ok($$UPDATE public.clients SET payment_terms_days = 365, contract_no = repeat('x', 100) WHERE id = '81000000-0000-0000-0000-000000000012'$$,
  'clients: 365 days and a 100-char contract № are fine');
SELECT lives_ok($$UPDATE public.clients SET payment_terms_days = NULL, contract_no = NULL WHERE id = '81000000-0000-0000-0000-000000000012'$$, 'clients: back to defaults');

-- 4. Нумерація: окремо типи, організації й роки; ручний номер; анульовані не повторюються; помилка не зсуває лічильник.
INSERT INTO t_kd VALUES ('n_i1', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
INSERT INTO t_kd VALUES ('n_i2', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
INSERT INTO t_kd VALUES ('n_a1', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
SELECT is(pg_temp.kd_num('n_i1'), 1, 'numbering: first invoice of 2026 — 1');
SELECT is(pg_temp.kd_num('n_i2'), 2, 'numbering: the second call in the same transaction — 2, no duplicate');
SELECT is(pg_temp.kd_num('n_a1'), 1, 'numbering: acts have their own sequence — 1');
SELECT is(pg_temp.kd_doc('n_i1') ->> 'number_text', 'РФ-1', 'numbering: number text with the invoice prefix');
SELECT is(pg_temp.kd_doc('n_a1') ->> 'number_text', 'АКТ-1', 'numbering: number text with the act prefix');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('ttn', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"x","qty":1,"price":1}]')$$),
  'DOC_KIND_NOT_READY', 'ttn documents arrive in 4b');
SELECT is(public.kp_doc_next_number('ttn', DATE '2026-10-10'), 1, 'numbering: ttn already has its own (empty) sequence');
INSERT INTO t_kd VALUES ('y_30', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2024-12-30', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
INSERT INTO t_kd VALUES ('y_31', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2024-12-31', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
INSERT INTO t_kd VALUES ('y_01', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2025-01-01', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
SELECT is(pg_temp.kd_num('y_31'), 2, 'numbering: 31.12.2024 — 2 in the 2024 sequence');
SELECT is(pg_temp.kd_num('y_01'), 1, 'numbering: 01.01.2025 — a new sequence from 1');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', 2, '[{"title":"x","qty":1,"price":1}]')$$),
  'DOC_NUMBER_TAKEN', 'manual number already used — DOC_NUMBER_TAKEN');
INSERT INTO t_kd VALUES ('m_10', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', 10, '[{"title":"Послуга","qty":1,"price":100}]'));
SELECT is(pg_temp.kd_num('m_10'), 10, 'manual number 10 accepted');
SELECT is(public.kp_doc_next_number('invoice', DATE '2026-10-10'), 11, 'a manual number above the counter moves the counter');
INSERT INTO t_kd VALUES ('m_11', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
SELECT is(pg_temp.kd_num('m_11'), 11, 'next automatic number — 11');
INSERT INTO t_kd VALUES ('m_5', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', 5, '[{"title":"Послуга","qty":1,"price":100}]'));
SELECT is(public.kp_doc_next_number('invoice', DATE '2026-10-10'), 12, 'a free manual number below the counter does not move it');
INSERT INTO t_kd VALUES ('m_12', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":100}]'));
SELECT lives_ok($$SELECT public.kp_doc_cancel(pg_temp.kd_id('m_12'), 'Помилка в сумі')$$, 'owner cancels invoice 12');
SELECT is(public.kp_doc_next_number('invoice', DATE '2026-10-10'), 13, 'a cancelled number is not reused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', 12, '[{"title":"x","qty":1,"price":1}]')$$),
  'DOC_NUMBER_TAKEN', 'the number of a cancelled document cannot be taken manually');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', NULL, '[{"title":"x","qty":0,"price":1}]')$$),
  'DOC_BAD_LINES', 'a failing create (bad line) …');
SELECT is(public.kp_doc_next_number('invoice', DATE '2026-10-10'), 13, '… does not move the counter');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
INSERT INTO t_kd VALUES ('q_i1', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000021', DATE '2026-10-10', 'UAH', NULL, '[{"title":"Послуга Q","qty":1,"price":100}]'));
SELECT is(pg_temp.kd_num('q_i1'), 1, 'numbering: another organization starts from 1');
-- Відкат зсуву лічильника: лічильник штучно опущено, ручний зайнятий номер його зсунув би — помилка все відкочує.
RESET ROLE;
UPDATE public.kp_doc_counters SET next_no = 1 WHERE org_id = '80000000-0000-0000-0000-00000000000a' AND kind = 'invoice' AND year = 2026;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-10', 'UAH', 11, '[{"title":"x","qty":1,"price":1}]')$$),
  'DOC_NUMBER_TAKEN', 'taken manual number after the counter was lowered — DOC_NUMBER_TAKEN');
RESET ROLE;
SELECT is((SELECT next_no FROM public.kp_doc_counters WHERE org_id = '80000000-0000-0000-0000-00000000000a' AND kind = 'invoice' AND year = 2026), 1,
  'the failed create rolled the counter shift back');
UPDATE public.kp_doc_counters SET next_no = 13 WHERE org_id = '80000000-0000-0000-0000-00000000000a' AND kind = 'invoice' AND year = 2026;
SELECT lives_ok($$INSERT INTO public.kp_doc_counters (org_id, kind, year) VALUES ('80000000-0000-0000-0000-00000000000a', 'ttn', 2026)$$, 'counters accept kind ttn (4b is additive)');
SELECT throws_ok($$INSERT INTO public.kp_doc_counters (org_id, kind, year) VALUES ('80000000-0000-0000-0000-00000000000a', 'bill', 2026)$$, '23514', NULL, 'counters refuse an unknown kind');
SELECT throws_ok($$INSERT INTO public.kp_documents (org_id, kind, number, doc_year, doc_date, client_id, seller, buyer, rate_date, subtotal, vat_amount, total, total_uah)
  VALUES ('80000000-0000-0000-0000-00000000000a', 'invoice', 1, 2026, DATE '2026-10-10', '81000000-0000-0000-0000-000000000011', '{}', '{}', DATE '2026-10-10', 1, 0, 1, 1)$$,
  '23505', NULL, 'UNIQUE (org, kind, year, number) backs the counter up');

-- 5. ПДВ: платник — net / gross з округленням; NULL — режим компанії; неплатник — 0; знімок при зміні vat_payer.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_kd VALUES ('v_n001', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":0.01}]', NULL, NULL, 'net'));
INSERT INTO t_kd VALUES ('v_n003', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":0.03}]', NULL, NULL, 'net'));
INSERT INTO t_kd VALUES ('v_nbig', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":0.5,"price":2000000.01}]', NULL, NULL, 'net'));
INSERT INTO t_kd VALUES ('v_nhalf', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":1000000.005}]', NULL, NULL, 'net'));
INSERT INTO t_kd VALUES ('v_g120', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":120}]', NULL, NULL, 'gross'));
INSERT INTO t_kd VALUES ('v_g001', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":0.01}]', NULL, NULL, 'gross'));
INSERT INTO t_kd VALUES ('v_g100', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":100}]', NULL, NULL, 'gross'));
SELECT is(pg_temp.kd_sums('v_n001'), '0.01|0.00|0.01', 'VAT net: 0.01 → VAT 0.00, total 0.01');
SELECT is(pg_temp.kd_sums('v_n003'), '0.03|0.01|0.04', 'VAT net: 0.03 → VAT 0.01, total 0.04');
SELECT is(pg_temp.kd_sums('v_nbig'), '1000000.01|200000.00|1200000.01', 'VAT net: line 0.5 × 2 000 000.01 = 1 000 000.005 → 1 000 000.01, VAT 200 000.00');
SELECT is(pg_temp.kd_sums('v_nhalf'), '1000000.01|200000.00|1200000.01', 'VAT net: price 1 000 000.005 rounds half up to 1 000 000.01');
SELECT is(pg_temp.kd_sums('v_g120'), '100.00|20.00|120.00', 'VAT gross: 120.00 → VAT 20.00, total unchanged');
SELECT is(pg_temp.kd_sums('v_g001'), '0.01|0.00|0.01', 'VAT gross: 0.01 → VAT 0.00');
SELECT is(pg_temp.kd_sums('v_g100'), '83.33|16.67|100.00', 'VAT gross: 100.00 → VAT 16.67, subtotal 83.33');
SELECT is(pg_temp.kd_doc('n_i1') ->> 'vat_mode' || '|' || (pg_temp.kd_doc('n_i1') ->> 'vat_rate'), 'net|20', 'vat_mode NULL takes the company default (net), rate 20');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"default_vat_mode":"gross"}')$$, 'company default switched to gross');
INSERT INTO t_kd VALUES ('v_def', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":120}]'));
SELECT is(pg_temp.kd_doc('v_def') ->> 'vat_mode' || '|' || pg_temp.kd_sums('v_def'), 'gross|100.00|20.00|120.00', 'vat_mode NULL now takes gross');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P'))$$, 'company default back to net');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, NULL, 'mixed')$$),
  'DOC_BAD_VAT_MODE', 'unknown vat_mode refused');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
SELECT is(pg_temp.kd_sums('q_i1') || '|' || (pg_temp.kd_doc('q_i1') ->> 'vat_rate'), '100.00|0.00|100.00|0', 'not a VAT payer: VAT 0, rate 0');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"vat_payer":false}')$$, 'company stops being a VAT payer');
SELECT is(pg_temp.kd_doc('v_n003') ->> 'vat_rate' || '|' || (pg_temp.kd_doc('v_n003') -> 'seller' ->> 'vat_payer') || '|' || pg_temp.kd_sums('v_n003'),
  '20|true|0.03|0.01|0.04', 'an issued document keeps its VAT and seller snapshot');
INSERT INTO t_kd VALUES ('v_nonpayer', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-11', 'UAH', NULL, '[{"title":"a","qty":1,"price":100}]', NULL, NULL, 'gross'));
SELECT is(pg_temp.kd_sums('v_nonpayer') || '|' || (pg_temp.kd_doc('v_nonpayer') ->> 'vat_rate'), '100.00|0.00|100.00|0', 'new document after the change: no VAT');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P'))$$, 'VAT payer again');

-- 6. Валюта: UAH — курс 1; USD — межі курсу й дати; курс і дата курсу в документі.
SELECT is((pg_temp.kd_doc('n_i1') ->> 'rate')::numeric || '|' || (pg_temp.kd_doc('n_i1') ->> 'rate_date'), '1.000000|2026-10-10', 'UAH: rate 1 on the document date');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, NULL, NULL, 2)$$),
  'DOC_BAD_RATE', 'UAH with a rate other than 1 refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'USD', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, NULL, NULL, 0, DATE '2026-10-12')$$),
  'DOC_BAD_RATE', 'USD: rate 0 refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'USD', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, NULL, NULL, -41, DATE '2026-10-12')$$),
  'DOC_BAD_RATE', 'USD: negative rate refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'USD', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, NULL, NULL, 41.5, DATE '2026-10-13')$$),
  'DOC_BAD_RATE', 'USD: rate date after the document date refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'USD', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, NULL, NULL, 41.5, DATE '2026-10-04')$$),
  'DOC_BAD_RATE', 'USD: rate older than 7 days refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'USD', NULL, '[{"title":"a","qty":1,"price":1}]')$$),
  'DOC_BAD_RATE', 'USD without a rate refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'GBP', NULL, '[{"title":"a","qty":1,"price":1}]')$$),
  'DOC_BAD_CURRENCY', 'GBP refused');
INSERT INTO t_kd VALUES ('c_usd', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'usd', NULL, '[{"title":"Freight","qty":1,"price":100}]', NULL, NULL, NULL, 41.123456, DATE '2026-10-05'));
SELECT is(pg_temp.kd_doc('c_usd') ->> 'currency' || '|' || (pg_temp.kd_doc('c_usd') ->> 'rate') || '|' || (pg_temp.kd_doc('c_usd') ->> 'rate_date')
  || '|' || (pg_temp.kd_doc('c_usd') ->> 'total') || '|' || (pg_temp.kd_doc('c_usd') ->> 'total_uah'),
  'USD|41.123456|2026-10-05|120.00|4934.81', 'USD: rate 7 days old accepted; rate, rate date and UAH equivalent stored');
INSERT INTO t_kd VALUES ('c_eur', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'EUR', NULL, '[{"title":"Freight","qty":2,"price":50}]', NULL, NULL, NULL, 45.5, DATE '2026-10-12'));
SELECT is(pg_temp.kd_doc('c_eur') ->> 'currency' || '|' || (pg_temp.kd_doc('c_eur') ->> 'total_uah'), 'EUR|5460.00', 'EUR: rate on the document date');

-- 7. Рядки і рейси.
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[]')$$), 'DOC_BAD_LINES', 'lines: 0 lines refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '{"title":"a"}')$$), 'DOC_BAD_LINES', 'lines: not an array refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  (SELECT jsonb_agg(jsonb_build_object('title', 'Рядок ' || g, 'qty', 1, 'price', 1)) FROM generate_series(1, 201) AS g))$$), 'DOC_BAD_LINES', 'lines: 201 lines refused');
INSERT INTO t_kd VALUES ('l_200', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  (SELECT jsonb_agg(jsonb_build_object('title', 'Рядок ' || g, 'qty', 1, 'price', 1)) FROM generate_series(1, 200) AS g)));
SELECT is(jsonb_array_length(pg_temp.kd_doc('l_200') -> 'lines'), 200, 'lines: 200 lines accepted');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":0,"price":1}]')$$), 'DOC_BAD_LINES', 'lines: qty 0 refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":-1,"price":1}]')$$), 'DOC_BAD_LINES', 'lines: negative qty refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":1,"price":-0.01}]')$$), 'DOC_BAD_LINES', 'lines: negative price refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":" ","qty":1,"price":1}]')$$), 'DOC_BAD_LINES', 'lines: empty title refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  jsonb_build_array(jsonb_build_object('title', repeat('я', 501), 'qty', 1, 'price', 1)))$$), 'DOC_BAD_LINES', 'lines: title of 501 chars refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":"багато","price":1}]')$$), 'DOC_BAD_LINES', 'lines: qty not a number refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":1,"price":0}]')$$), 'DOC_ZERO_TOTAL', 'a document with a zero total refused');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_trips_for_client('81000000-0000-0000-0000-000000000011', DATE '2026-10-01', DATE '2026-10-31')), 3,
  'trips for an act: accepted / done trips of the client (draft excluded)');
SELECT is((SELECT price::text || '|' || price_source FROM public.kp_doc_trips_for_client('81000000-0000-0000-0000-000000000011', DATE '2026-10-01', DATE '2026-10-31')
           WHERE calculation_id = '82000000-0000-0000-0000-000000000002'), '21000|fact', 'trips: price from the fact when there is one');
SELECT is((SELECT price::text || '|' || price_source FROM public.kp_doc_trips_for_client('81000000-0000-0000-0000-000000000011', DATE '2026-10-01', DATE '2026-10-31')
           WHERE calculation_id = '82000000-0000-0000-0000-000000000001'), '10000|plan', 'trips: otherwise the planned revenue');
INSERT INTO t_kd VALUES ('t_a1', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"Перевезення Київ — Одеса","qty":1,"price":10000,"calculation_id":"82000000-0000-0000-0000-000000000001"}]'));
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000001"}]')$$), 'TRIP_ALREADY_BILLED', 'a trip on an active act — TRIP_ALREADY_BILLED');
SELECT lives_ok($$INSERT INTO t_kd VALUES ('t_i1', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":10000,"calculation_id":"82000000-0000-0000-0000-000000000001"}]'))$$, 'the same trip on an invoice is fine (another kind)');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000001"}]')$$), 'TRIP_ALREADY_BILLED', '… but not on a second active invoice');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_trips_for_client('81000000-0000-0000-0000-000000000011', DATE '2026-10-01', DATE '2026-10-31', 'act')), 2,
  'trips for an act: the billed trip is gone');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_trips_for_client('81000000-0000-0000-0000-000000000011', DATE '2026-10-01', DATE '2026-10-31', NULL)
           WHERE act_doc_id IS NOT NULL AND invoice_doc_id IS NOT NULL), 1, 'trips (all): the billed trip shows its act and invoice');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000021"}]')$$), 'DOC_TRIP_FORBIDDEN', 'a trip of another organization refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000004"}]')$$), 'DOC_TRIP_FORBIDDEN', 'a trip of another client refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000006"}]')$$), 'DOC_TRIP_FORBIDDEN', 'a trip without a client refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000002"},{"title":"y","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000002"}]')$$),
  'DOC_BAD_LINES', 'the same trip twice in one document refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000013', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]')$$),
  'CLIENT_ARCHIVED', 'archived client refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000021', DATE '2026-10-12', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]')$$),
  'CLIENT_NOT_FOUND', 'a client of another organization refused');
SELECT lives_ok($$SELECT public.kp_doc_cancel(pg_temp.kd_id('t_a1'), 'Неправильний рейс')$$, 'owner cancels the act');
SELECT lives_ok($$INSERT INTO t_kd VALUES ('t_a2', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"Перевезення Київ — Одеса","qty":1,"price":10000,"calculation_id":"82000000-0000-0000-0000-000000000001"}]'))$$, 'after cancelling, the trip can be billed again');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000012', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"x","qty":1,"price":1,"calculation_id":"82000000-0000-0000-0000-000000000004"}]')$$), 'DOC_TRIP_FORBIDDEN', 'logist: a trip they cannot see refused');
INSERT INTO t_kd VALUES ('t_a3', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-12', 'UAH', NULL,
  '[{"title":"Київ — Львів","qty":1,"price":21000,"calculation_id":"82000000-0000-0000-0000-000000000002"},
    {"title":"Умань — Миколаїв","qty":1,"price":30000,"calculation_id":"82000000-0000-0000-0000-000000000003"},
    {"title":"Простій","unit":"доба","qty":1.5,"price":2000}]'));
SELECT is(pg_temp.kd_doc('t_a3') ->> 'total' || '|' || jsonb_array_length(pg_temp.kd_doc('t_a3') -> 'lines'), '64800.00|3', 'logist creates an act from two trips and a free line (VAT 20 %)');

-- 8. Рахунок і акт — окремо; акт може посилатися на рахунок; строк оплати.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
INSERT INTO t_kd VALUES ('p_inv', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":500}]'));
INSERT INTO t_kd VALUES ('p_act', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":500}]', pg_temp.kd_id('p_inv')));
SELECT is(pg_temp.kd_doc('p_act') -> 'parent' ->> 'id', pg_temp.kd_id('p_inv')::text, 'an act may refer to an invoice');
SELECT is(jsonb_array_length(pg_temp.kd_doc('p_inv') -> 'children'), 1, 'the invoice lists its act');
SELECT is(pg_temp.kd_num('p_inv'), pg_temp.kd_num('t_i1') + 1, 'invoice: the next number of the invoice sequence');
SELECT is(pg_temp.kd_num('p_act'), pg_temp.kd_num('t_a3') + 1, 'act: the next number of the act sequence (separate call, own number)');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]', pg_temp.kd_id('p_inv'))$$),
  'DOC_BAD_PARENT', 'an invoice cannot have a parent');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000012', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]', pg_temp.kd_id('p_inv'))$$),
  'DOC_BAD_PARENT', 'an act of another client cannot refer to the invoice');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]', pg_temp.kd_id('p_act'))$$),
  'DOC_BAD_PARENT', 'an act cannot refer to an act');
SELECT is(pg_temp.kd_doc('p_inv') ->> 'due_date', '2026-10-24', 'due date: client terms 10 days');
INSERT INTO t_kd VALUES ('p_inv5', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000012', DATE '2026-10-14', 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":500}]'));
SELECT is(pg_temp.kd_doc('p_inv5') ->> 'due_date', '2026-10-19', 'due date: no client terms — 5 days');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]', NULL, DATE '2026-10-13')$$),
  'DOC_BAD_DUE_DATE', 'due date before the document date refused');
SELECT ok(pg_temp.kd_doc('p_act') -> 'due_date' = 'null'::jsonb, 'an act has no due date');
SELECT is(pg_temp.kd_doc('p_act') -> 'buyer' ->> 'contract_no' || '|' || (pg_temp.kd_doc('p_act') -> 'buyer' ->> 'contract_date'), 'Д-15/2026|2026-01-15',
  'buyer snapshot carries the contract');

-- 9. Оплати (у валюті документа).
INSERT INTO t_kd VALUES ('pay', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', public.ua_today(), 'UAH', NULL, '[{"title":"Послуга","qty":1,"price":1000}]'));
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), 100)$$), 'KP_FORBIDDEN', 'director cannot add a payment');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
INSERT INTO t_kd VALUES ('pay_200', public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), 200, 'Аванс'));
SELECT is(pg_temp.kd_doc('pay') ->> 'paid' || '|' || (pg_temp.kd_doc('pay') ->> 'debt') || '|' || (pg_temp.kd_doc('pay') ->> 'pay_status'), '200.00|1000.00|partial',
  'logist adds a partial payment: debt 1000, status partial');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
INSERT INTO t_kd VALUES ('pay_rest', public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), 1000));
SELECT is(pg_temp.kd_doc('pay') ->> 'debt' || '|' || (pg_temp.kd_doc('pay') ->> 'pay_status'), '0.00|paid', 'full payment: debt 0, status paid');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), 0.01)$$), 'PAYMENT_EXCEEDS', 'a payment above the debt — PAYMENT_EXCEEDS');
SELECT lives_ok($$SELECT public.kp_payment_void(pg_temp.kd_id('pay_rest'))$$, 'void a wrong payment');
SELECT is(pg_temp.kd_doc('pay') ->> 'debt' || '|' || (pg_temp.kd_doc('pay') ->> 'pay_status'), '1000.00|partial', 'void returns the debt');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_void(pg_temp.kd_id('pay_rest'))$$), 'PAYMENT_ALREADY_VOIDED', 'void twice refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today() + 1, 1)$$), 'PAYMENT_BAD_DATE', 'a payment dated in the future refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), 0)$$), 'PAYMENT_BAD_AMOUNT', 'a zero payment refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), -5)$$), 'PAYMENT_BAD_AMOUNT', 'a negative payment refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('p_act'), public.ua_today(), 1)$$), 'PAYMENT_NOT_INVOICE', 'an act takes no payments');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('m_12'), public.ua_today(), 1)$$), 'DOC_CANCELLED', 'a cancelled invoice takes no payments');
INSERT INTO t_kd VALUES ('pay_usd', public.kp_payment_add(pg_temp.kd_id('c_usd'), public.ua_today(), 20));
SELECT is(pg_temp.kd_doc('c_usd') ->> 'currency' || '|' || (pg_temp.kd_doc('c_usd') ->> 'paid') || '|' || (pg_temp.kd_doc('c_usd') ->> 'debt'), 'USD|20.00|100.00',
  'USD invoice: payment and debt in USD, no exchange differences');
SELECT is((SELECT p ->> 'amount' FROM jsonb_array_elements(pg_temp.kd_doc('c_usd') -> 'payments') AS p), '20.00', 'the payment is stored in the document currency');

-- 10. Борги (org S): межа прострочки, анульовані, сортування.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d010","role":"authenticated"}', true);
INSERT INTO t_kd VALUES ('s_a', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000031', public.ua_today() - 20, 'UAH', NULL, '[{"title":"a","qty":1,"price":1000}]', NULL, public.ua_today() - 1));
INSERT INTO t_kd VALUES ('s_b', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000031', public.ua_today() - 5, 'UAH', NULL, '[{"title":"b","qty":1,"price":500}]', NULL, public.ua_today()));
INSERT INTO t_kd VALUES ('s_c', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000032', public.ua_today() - 30, 'UAH', NULL, '[{"title":"c","qty":1,"price":300}]', NULL, public.ua_today() - 10));
INSERT INTO t_kd VALUES ('s_c_pay', public.kp_payment_add(pg_temp.kd_id('s_c'), public.ua_today() - 3, 100));
INSERT INTO t_kd VALUES ('s_d', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000033', public.ua_today() - 2, 'UAH', NULL, '[{"title":"d","qty":1,"price":5000}]', NULL, public.ua_today() + 5));
INSERT INTO t_kd VALUES ('s_e', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000033', public.ua_today() - 2, 'UAH', NULL, '[{"title":"e","qty":1,"price":9999}]'));
SELECT lives_ok($$SELECT public.kp_doc_cancel(pg_temp.kd_id('s_e'), 'Дубль')$$, 'debts: a cancelled invoice …');
SELECT is((SELECT string_agg(d.client_name, ',' ORDER BY d.ordinality) FROM public.kp_client_debts() WITH ORDINALITY AS d), 'S-перший,S-другий,S-третій',
  'debts: sorted by overdue amount, then debt');
SELECT is((SELECT invoices || '|' || debt || '|' || overdue || '|' || overdue_invoices || '|' || overdue_days FROM public.kp_client_debts() WHERE client_name = 'S-перший'),
  '2|1500.00|1000.00|1|1', 'debts: due yesterday is overdue (1 day), due today is not');
SELECT is((SELECT invoiced || '|' || paid || '|' || debt || '|' || overdue || '|' || overdue_days FROM public.kp_client_debts() WHERE client_name = 'S-другий'),
  '300.00|100.00|200.00|200.00|10', 'debts: a partly paid overdue invoice');
SELECT is((SELECT invoices || '|' || debt || '|' || overdue || '|' || coalesce(oldest_due::text, '—') FROM public.kp_client_debts() WHERE client_name = 'S-третій'),
  '1|5000.00|0|—', '… is not counted; not overdue yet');
SELECT is((SELECT overdue::text FROM public.kp_client_debts(public.ua_today() - 1) WHERE client_name = 'S-перший'), '0',
  'debts on a date: due_date equal to the date is not overdue');
SELECT is((SELECT currency || '|' || debt FROM public.kp_client_debts() WHERE client_name = 'S-перший'), 'UAH|1500.00', 'debts: one row per client and currency');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
SELECT is((SELECT string_agg(client_name, ',') FROM public.kp_client_debts()), 'Клієнт Q', 'another organization sees only its own debts');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT ok((SELECT count(*) FROM public.kp_client_debts() WHERE currency = 'USD') = 1, 'director reads the debts (USD row of the USD invoice)');

-- 11. Анулювання: лише owner; причина; оплати; двічі; без DELETE; знімки незмінні.
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_cancel(pg_temp.kd_id('p_inv'), 'x')$$), 'KP_FORBIDDEN', 'director cannot cancel');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_cancel(pg_temp.kd_id('p_inv'), 'x')$$), 'KP_FORBIDDEN', 'logist cannot cancel');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_cancel(pg_temp.kd_id('p_inv'), '  ')$$), 'DOC_CANCEL_REASON', 'cancel without a reason refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_cancel(pg_temp.kd_id('pay'), 'x')$$), 'DOC_HAS_PAYMENTS', 'an invoice with active payments: void the payments first');
SELECT lives_ok($$SELECT public.kp_doc_cancel(pg_temp.kd_id('p_inv'), 'Клієнт відмовився')$$, 'owner cancels with a reason');
SELECT is(pg_temp.kd_doc('p_inv') ->> 'status' || '|' || (pg_temp.kd_doc('p_inv') ->> 'pay_status') || '|' || (pg_temp.kd_doc('p_inv') ->> 'cancelled_reason'),
  'cancelled|cancelled|Клієнт відмовився', 'cancelled: status, reason');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_cancel(pg_temp.kd_id('p_inv'), 'ще раз')$$), 'DOC_ALREADY_CANCELLED', 'cancel twice — DOC_ALREADY_CANCELLED');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_list('invoice', DATE '2026-10-01', DATE '2026-10-31', NULL, 'cancelled')), 2, 'list: filter by status cancelled');
SELECT is((SELECT count(*)::integer FROM public.kp_doc_list('act', DATE '2026-10-01', DATE '2026-10-31', '81000000-0000-0000-0000-000000000011', NULL)
           WHERE pay_status = 'issued'), 5, 'list: acts of the client');
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_doc_list(NULL, DATE '2026-10-31', DATE '2026-10-01')$$), 'BAD_PERIOD', 'list: bad period refused');
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_doc_list(NULL, DATE '2026-01-01', DATE '2026-12-31', NULL, 'lost')$$), 'DOC_BAD_STATUS', 'list: unknown status refused');
SELECT throws_ok($$DELETE FROM public.clients WHERE id = '81000000-0000-0000-0000-000000000011'$$, '23503', NULL, 'a client with documents cannot be deleted (archive instead)');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;
SELECT is(pg_temp.kd_msg($$DELETE FROM public.kp_documents WHERE id = pg_temp.kd_id('p_inv')$$), 'DOC_DELETE_FORBIDDEN', 'service_role: no DELETE of documents');
SELECT is(pg_temp.kd_msg($$DELETE FROM public.kp_document_lines WHERE doc_id = pg_temp.kd_id('p_act')$$), 'DOC_DELETE_FORBIDDEN', 'service_role: no DELETE of lines');
SELECT is(pg_temp.kd_msg($$DELETE FROM public.kp_document_payments WHERE id = pg_temp.kd_id('pay_200')$$), 'DOC_DELETE_FORBIDDEN', 'service_role: no DELETE of payments');
SELECT is(pg_temp.kd_msg($$UPDATE public.kp_documents SET total = total + 1, total_uah = total_uah + 1, subtotal = subtotal + 1 WHERE id = pg_temp.kd_id('p_act')$$), 'DOC_IMMUTABLE', 'service_role: sums are immutable');
SELECT is(pg_temp.kd_msg($$UPDATE public.kp_documents SET seller = seller || '{"legal_name":"Інша"}' WHERE id = pg_temp.kd_id('p_act')$$), 'DOC_IMMUTABLE', 'service_role: the seller snapshot is immutable');
SELECT is(pg_temp.kd_msg($$UPDATE public.kp_documents SET status = 'issued', cancelled_at = NULL, cancelled_by = NULL, cancelled_reason = NULL WHERE id = pg_temp.kd_id('p_inv')$$),
  'DOC_IMMUTABLE', 'service_role: a cancelled document cannot be restored');
SELECT is(pg_temp.kd_msg($$UPDATE public.kp_document_lines SET price = price + 1, amount = amount + 1 WHERE doc_id = pg_temp.kd_id('p_act')$$), 'DOC_IMMUTABLE', 'service_role: lines are immutable');
SELECT is(pg_temp.kd_msg($$UPDATE public.kp_document_payments SET amount = 1 WHERE id = pg_temp.kd_id('pay_200')$$), 'DOC_IMMUTABLE', 'service_role: payments are immutable');
RESET ROLE;
-- Видалення рейсу на сайті: рядок документа лишається без посилання на рейс.
DELETE FROM public.calculations WHERE id = '82000000-0000-0000-0000-000000000003';
SELECT is((SELECT count(*)::integer FROM public.kp_document_lines WHERE doc_id = pg_temp.kd_id('t_a3') AND calculation_id IS NULL), 2,
  'deleting a trip on the site keeps the document line (calculation_id → NULL)');

-- 12. Storage: бакет kp-doc-assets, шлях <org>/(signature|stamp).(png|jpg), пише лише owner.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/signature.png')$$, 'owner uploads the signature');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000b/signature.png')$$, '42501', NULL, 'owner: a path of another organization refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kd-other', '80000000-0000-0000-0000-00000000000a/stamp.png')$$, '42501', NULL, 'owner: another bucket refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', 'stamp.png')$$, '42501', NULL, 'owner: a path without org_id refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/logo.png')$$, '42501', NULL, 'owner: another file name refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/stamp.gif')$$, '42501', NULL, 'owner: another extension refused');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"signature_path":"80000000-0000-0000-0000-00000000000a/signature.png"}')$$,
  'owner saves the signature path');
SELECT is((SELECT signature_path || '|' || coalesce(stamp_path, '—') FROM public.kp_requisites_get()), '80000000-0000-0000-0000-00000000000a/signature.png|—', 'requisites keep the signature path');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P'))$$, 'saving without the key keeps the path');
SELECT is((SELECT signature_path FROM public.kp_requisites_get()), '80000000-0000-0000-0000-00000000000a/signature.png', '… still there');
SELECT is(pg_temp.kd_rows($$UPDATE storage.objects SET metadata = '{"size":1}' WHERE bucket_id = 'kp-doc-assets' AND name = '80000000-0000-0000-0000-00000000000a/signature.png'$$), 1, 'owner replaces own file (UPDATE)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/stamp.png')$$, '42501', NULL, 'logist cannot upload a stamp');
SELECT is(pg_temp.kd_rows($$UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = 'kp-doc-assets'$$), 0, 'logist cannot replace the signature');
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 1, 'logist sees the signature (for PDF)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 1, 'director sees the signature');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/stamp.jpg')$$, '42501', NULL, 'director cannot upload');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 0, 'another organization sees no files of the bucket');
SELECT is(pg_temp.kd_rows($$UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = 'kp-doc-assets'$$), 0, 'another organization cannot replace them');
RESET ROLE;
SELECT ok((SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kp_doc_assets_delete') ~ 'kp-doc-assets'
  AND (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kp_doc_assets_delete') ~ 'owner',
  'DELETE of the files: only this bucket, only the owner');

-- 12b. Знімок підпису й печатки: сервер (service_role) копіює файли реквізитів у <org>/docs/<doc_id>/…, документ
-- посилається лише на свою копію. metadata.copy_of — «вміст» файлу: заміна підпису в реквізитах старої копії не змінює.
SELECT ok(has_function_privilege('authenticated', 'public.kp_doc_assets_source()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_doc_assets_source()', 'EXECUTE'), 'kp_doc_assets_source: authenticated only, not anon');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kp_documents_asset_snapshot' AND conrelid = 'public.kp_documents'::regclass),
  'documents: CHECK — signature / stamp paths only of the own snapshot');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT org_id::text || '|' || signature_path || '|' || coalesce(stamp_path, '—') FROM public.kp_doc_assets_source()),
  '80000000-0000-0000-0000-00000000000a|80000000-0000-0000-0000-00000000000a/signature.png|—', 'logist: snapshot source — the current signature of the organization');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]')$$),
  'DOC_ASSETS_NOT_COPIED', 'signature in the requisites, no p_id — document refused');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]',
  NULL, NULL, NULL, NULL, NULL, '83000000-0000-4000-8000-000000000001')$$), 'DOC_ASSETS_NOT_COPIED', 'p_id without the copied file — document refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000001/signature.png')$$,
  '42501', NULL, 'logist cannot write a snapshot');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000001/signature.png')$$,
  '42501', NULL, 'owner cannot write a snapshot either (only the server)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_doc_assets_source()$$), 'KP_FORBIDDEN', 'director: no snapshot source');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000001/signature.png', '{"copy_of":"signature v1"}');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_kd VALUES ('s_old', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":10}]',
  NULL, NULL, NULL, NULL, NULL, '83000000-0000-4000-8000-000000000001'));
SELECT is(pg_temp.kd_id('s_old'), '83000000-0000-4000-8000-000000000001'::uuid, 'logist creates the document with the snapshot id');
SELECT is((pg_temp.kd_doc('s_old') -> 'seller' ->> 'signature_path') || '|' || coalesce(pg_temp.kd_doc('s_old') -> 'seller' ->> 'stamp_path', '—'),
  '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000001/signature.png|—', 'seller keeps the snapshot path, not the requisites file');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]',
  NULL, NULL, NULL, NULL, NULL, '83000000-0000-4000-8000-000000000001')$$), 'DOC_ID_TAKEN', 'the id of an existing document cannot be reused');
-- Власник замінює підпис (тепер JPEG), додає печатку і видаляє старий файл підпису.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
SELECT lives_ok($$INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/signature.jpg', '{"v":2}'),
  ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/stamp.png', '{"v":1}')$$, 'owner uploads a new signature and a stamp');
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P')
  || '{"signature_path":"80000000-0000-0000-0000-00000000000a/signature.jpg","stamp_path":"80000000-0000-0000-0000-00000000000a/stamp.png"}')$$,
  'owner replaces the signature and adds the stamp in the requisites');
SELECT is(pg_temp.kd_rows($$DELETE FROM storage.objects WHERE bucket_id = 'kp-doc-assets' AND name = '80000000-0000-0000-0000-00000000000a/signature.png'$$), 1,
  'owner deletes the old signature file');
SELECT is(pg_temp.kd_rows($$UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = 'kp-doc-assets' AND name LIKE '%/docs/%'$$), 0, 'owner cannot overwrite a snapshot');
SELECT is(pg_temp.kd_rows($$DELETE FROM storage.objects WHERE bucket_id = 'kp-doc-assets' AND name LIKE '%/docs/%'$$), 0, 'owner cannot delete a snapshot');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000002/signature.jpg', '{"copy_of":"signature v2"}');
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":10}]',
  NULL, NULL, NULL, NULL, NULL, '83000000-0000-4000-8000-000000000002')$$), 'DOC_ASSETS_NOT_COPIED', 'signature copied but the stamp not — document refused');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('kp-doc-assets', '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000002/stamp.png', '{"copy_of":"stamp v1"}');
SET LOCAL ROLE authenticated;
INSERT INTO t_kd VALUES ('s_new', public.kp_doc_create('act', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":10}]',
  NULL, NULL, NULL, NULL, NULL, '83000000-0000-4000-8000-000000000002'));
SELECT is((pg_temp.kd_doc('s_new') -> 'seller' ->> 'signature_path') || '|' || (pg_temp.kd_doc('s_new') -> 'seller' ->> 'stamp_path'),
  '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000002/signature.jpg|80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000002/stamp.png',
  'new document — the new signature and the stamp');
SELECT is((pg_temp.kd_doc('s_old') -> 'seller' ->> 'signature_path') || '|' || coalesce(pg_temp.kd_doc('s_old') -> 'seller' ->> 'stamp_path', '—'),
  '80000000-0000-0000-0000-00000000000a/docs/83000000-0000-4000-8000-000000000001/signature.png|—', 'old document still shows the old signature and no stamp');
SELECT is((SELECT o.metadata ->> 'copy_of' FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = pg_temp.kd_doc('s_old') -> 'seller' ->> 'signature_path'),
  'signature v1', 'the old snapshot file is in place and unchanged');
-- Без підпису й печатки.
SELECT lives_ok($$SELECT public.kp_requisites_save((SELECT j FROM t_kd_req WHERE k = 'P') || '{"signature_path":null,"stamp_path":null}')$$,
  'owner removes the signature and the stamp from the requisites');
INSERT INTO t_kd VALUES ('s_none', public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":10}]'));
SELECT is(coalesce(pg_temp.kd_doc('s_none') -> 'seller' ->> 'signature_path', '—') || '|' || coalesce(pg_temp.kd_doc('s_none') -> 'seller' ->> 'stamp_path', '—'),
  '—|—', 'without a signature / stamp the document is created without them');
SELECT is((SELECT count(*)::integer FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets'
           AND o.name IN (pg_temp.kd_doc('s_old') -> 'seller' ->> 'signature_path', pg_temp.kd_doc('s_new') -> 'seller' ->> 'signature_path',
                          pg_temp.kd_doc('s_new') -> 'seller' ->> 'stamp_path')), 3,
  'removing the signature in the requisites keeps the snapshots of issued documents');
-- Читання знімків — як документів.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets' AND name LIKE '%/docs/%'), 3, 'logist reads the snapshots (PDF)');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets' AND name LIKE '%/docs/%'), 3, 'director reads the snapshots');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d005","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 0, 'repair manager: no snapshots');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets' AND name LIKE '%/docs/%'), 0, 'another organization sees no snapshots');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-doc-assets'), 0, 'anon sees no snapshots');
RESET ROLE;

-- 13. Чужа організація: нічого з документів P.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d008","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_get(pg_temp.kd_id('n_i1'))$$), 'DOC_NOT_FOUND', 'another org: document not found');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_cancel(pg_temp.kd_id('n_i1'), 'x')$$), 'DOC_NOT_FOUND', 'another org: cannot cancel');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_add(pg_temp.kd_id('pay'), public.ua_today(), 1)$$), 'DOC_NOT_FOUND', 'another org: cannot pay');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_payment_void(pg_temp.kd_id('pay_200'))$$), 'PAYMENT_NOT_FOUND', 'another org: cannot void a payment');
SELECT is(pg_temp.kd_msg($$SELECT * FROM public.kp_doc_trips_for_client('81000000-0000-0000-0000-000000000011', DATE '2026-10-01', DATE '2026-10-31')$$), 'CLIENT_NOT_FOUND',
  'another org: no trips of the client');
SELECT is((SELECT string_agg(number_text, ',') FROM public.kp_doc_list(NULL, DATE '2024-12-01', DATE '2026-11-30')), '1', 'another org: the list has only its own document');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d009","role":"authenticated"}', true);
SELECT ok((SELECT count(*) FROM public.kp_doc_list(NULL, DATE '2024-12-01', DATE '2026-11-30')) > 25, 'director lists the documents of the organization');
SELECT is(pg_temp.kd_msg($$SELECT public.kp_doc_create('invoice', '81000000-0000-0000-0000-000000000011', DATE '2026-10-14', 'UAH', NULL, '[{"title":"a","qty":1,"price":1}]')$$),
  'KP_FORBIDDEN', 'director cannot create documents');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
