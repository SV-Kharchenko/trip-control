-- «Документи»: реєстр договорів (*_kp_contracts_register.sql) і вкладка «Інше» (*_kp_other_docs.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim and a minimal storage stub. Усі дані — вигадані.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(77);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"service_role"}', true);

-- A: control_plus (owner f101, logist f102, директор f103); B: control_plus (owner f104).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('a1000000-0000-4000-8000-00000000000a', 'DP plan', 'team'),
       ('a1000000-0000-4000-8000-00000000000b', 'DP other', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'dp-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'DP ' || k), now(), now()
FROM unnest(ARRAY['f101', 'f102', 'f103', 'f104']) AS k;

UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000f104' THEN 'a1000000-0000-4000-8000-00000000000b'::uuid
                     ELSE 'a1000000-0000-4000-8000-00000000000a'::uuid END,
    org_role = CASE WHEN id = '00000000-0000-0000-0000-00000000f102' THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f104');

SELECT public.set_org_plan('a1000000-0000-4000-8000-00000000000a', 'control_plus');
SELECT public.set_org_plan('a1000000-0000-4000-8000-00000000000b', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('a1000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000f103');

INSERT INTO public.clients (id, org_id, name)
VALUES ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-00000000000a', 'Агро DP'),
       ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-00000000000a', 'Логістик DP'),
       ('a2000000-0000-4000-8000-000000000021', 'a1000000-0000-4000-8000-00000000000b', 'Чужий DP');
INSERT INTO public.fleet_vehicles (id, org_id, label)
VALUES ('a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-00000000000a', 'AA7777DP'),
       ('a3000000-0000-4000-8000-000000000021', 'a1000000-0000-4000-8000-00000000000b', 'BB7777DP');
INSERT INTO public.kp_drivers (id, org_id, full_name)
VALUES ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-00000000000a', 'Тестовий Водій');

-- Договори: діє безстроково, діє до далекої дати, закінчується за ~10 днів, закінчився, чужий.
INSERT INTO public.kp_contracts (id, org_id, client_id, number, contract_date, valid_until, status)
VALUES ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'Д-1', DATE '2026-01-10', NULL, 'draft'),
       ('a5000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'Д-2', DATE '2026-02-10', DATE '2099-12-31', 'signed'),
       ('a5000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000002', 'Д-3', DATE '2026-03-10', (now() AT TIME ZONE 'Europe/Kyiv')::date + 10, 'sent'),
       ('a5000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000002', 'Д-4', DATE '2020-01-10', DATE '2021-01-10', 'signed'),
       ('a5000000-0000-4000-8000-000000000021', 'a1000000-0000-4000-8000-00000000000b', 'a2000000-0000-4000-8000-000000000021', 'Д-21', DATE '2026-01-10', NULL, 'draft');

-- 1. Схема й права.
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'kp_contracts' AND column_name = 'cancelled_at')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'kp_contracts' AND column_name = 'cancel_reason'),
  'kp_contracts: cancelled_at and cancel_reason columns');
SELECT ok(NOT has_function_privilege('anon', 'public.kp_contract_list_all(uuid, date, date, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_contract_cancel(uuid, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_contract_cancel(uuid, text)', 'EXECUTE'),
  'contracts: list / cancel are not callable by anon');
SELECT ok(NOT has_function_privilege('anon', 'public.kp_other_save(uuid, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_other_list(date, date, text, uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_other_cancel(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.kp_other_delete(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.kp_other_save(uuid, jsonb)', 'EXECUTE'),
  'other docs: RPCs are not callable by anon');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.kp_other_docs'::regclass)
  AND has_table_privilege('authenticated', 'public.kp_other_docs', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.kp_other_docs', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.kp_other_docs', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.kp_other_docs', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.kp_other_docs', 'SELECT'),
  'kp_other_docs: RLS on, authenticated only reads, anon nothing');
SELECT ok((SELECT NOT public AND file_size_limit = 10485760 FROM storage.buckets WHERE id = 'kp-other-docs'),
  'kp-other-docs: private bucket, 10 MB');
SELECT is((SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'kp_other_docs_storage_%'),
  'kp_other_docs_storage_delete,kp_other_docs_storage_insert,kp_other_docs_storage_select', 'kp-other-docs: select / insert / delete policies');

-- 2. Договори: owner бачить усіх, фільтри й статуси.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all()), 4, 'contracts: the list shows only own organisation (4 of 5)');
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all(p_client => 'a2000000-0000-4000-8000-000000000001')), 2, 'contracts: filter by client');
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all(p_from => DATE '2026-02-01', p_to => DATE '2026-03-31')), 2, 'contracts: filter by period (contract date)');
SELECT is((SELECT string_agg(number, ',' ORDER BY number) FROM public.kp_contract_list_all(p_status => 'expired')), 'Д-4', 'contracts: expired = valid_until in the past');
SELECT is((SELECT string_agg(number, ',' ORDER BY number) FROM public.kp_contract_list_all(p_status => 'active')), 'Д-1,Д-2,Д-3', 'contracts: active excludes expired');
SELECT is((SELECT number FROM public.kp_contract_list_all() WHERE expiring_soon), 'Д-3', 'contracts: expiring_soon = valid for ≤ 30 more days');
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all(p_status => 'cancelled')), 0, 'contracts: nothing cancelled yet');
SELECT throws_ok($$SELECT * FROM public.kp_contract_list_all(p_status => 'paid')$$, 'P0001', 'CONTRACT_BAD_STATUS', 'contracts: unknown status refused');

-- 3. Анулювання договору: лише власник, з причиною, один раз; редагування після цього заблоковано.
SELECT throws_ok($$SELECT public.kp_contract_cancel('a5000000-0000-4000-8000-000000000001', '  ')$$, 'P0001', 'CONTRACT_REASON', 'contracts: cancel needs a reason');
SELECT throws_ok($$SELECT public.kp_contract_cancel('a5000000-0000-4000-8000-000000000021', 'чужий')$$, 'P0001', 'CONTRACT_NOT_FOUND', 'contracts: cannot cancel a foreign contract');
SELECT lives_ok($$SELECT public.kp_contract_cancel('a5000000-0000-4000-8000-000000000002', 'Дубль')$$, 'contracts: owner cancels a signed contract');
SELECT throws_ok($$SELECT public.kp_contract_cancel('a5000000-0000-4000-8000-000000000002', 'ще раз')$$, 'P0001', 'CONTRACT_ALREADY_CANCELLED', 'contracts: second cancel refused');
SELECT is((SELECT string_agg(number, ',') FROM public.kp_contract_list_all(p_status => 'cancelled')), 'Д-2', 'contracts: cancelled filter');
SELECT is((SELECT string_agg(number, ',' ORDER BY number) FROM public.kp_contract_list_all(p_status => 'active')), 'Д-1,Д-3', 'contracts: a cancelled contract is not active');
SELECT throws_ok($$SELECT public.kp_contract_save('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', '{"number":"X"}')$$, 'P0001', 'CONTRACT_LOCKED', 'contracts: a cancelled contract cannot be edited');
SELECT throws_ok($$UPDATE public.kp_contracts SET status = 'draft'$$, '42501', NULL, 'contracts: no direct UPDATE');

-- 4. Логіст створює, але не анулює; директор лише читає.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f102","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_contract_cancel('a5000000-0000-4000-8000-000000000001', 'логіст')$$, '42501', 'KP_FORBIDDEN', 'contracts: a logist cannot cancel');
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all()), 4, 'contracts: a logist reads the list');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f103","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all()), 4, 'contracts: the director reads the list');
SELECT throws_ok($$SELECT public.kp_contract_cancel('a5000000-0000-4000-8000-000000000001', 'директор')$$, '42501', 'KP_FORBIDDEN', 'contracts: the director cannot cancel');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f104","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_contract_list_all()), 1, 'contracts: another organisation sees only its own');
RESET ROLE;

-- 5. «Інше»: файли в бакеті (як сервіс), створення через RPC.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"service_role"}', true);
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000001/file-c1000000-0000-4000-8000-000000000001.pdf', '{"size": 5000}'),
       ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000002/file-c1000000-0000-4000-8000-000000000002.png', '{"size": 6000}'),
       ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000003/file-c1000000-0000-4000-8000-000000000003.pdf', '{"size": 20000000}');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f102","role":"authenticated"}', true);
SELECT is(public.kp_other_save('b1000000-0000-4000-8000-000000000001', jsonb_build_object(
  'title', 'Довіреність на водія', 'category', 'power_of_attorney', 'doc_date', '2026-10-01', 'valid_until', (now() AT TIME ZONE 'Europe/Kyiv')::date + 5,
  'client_id', 'a2000000-0000-4000-8000-000000000001', 'vehicle_id', 'a3000000-0000-4000-8000-000000000001', 'driver_id', 'a4000000-0000-4000-8000-000000000001',
  'file_path', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000001/file-c1000000-0000-4000-8000-000000000001.pdf', 'file_name', 'dov.pdf')),
  'b1000000-0000-4000-8000-000000000001'::uuid, 'other: a logist adds a file linked to a client, a vehicle and a driver');
SELECT is(public.kp_other_save('b1000000-0000-4000-8000-000000000002', jsonb_build_object(
  'title', 'Страховка', 'category', 'insurance', 'doc_date', '2020-01-01', 'valid_until', '2021-01-01',
  'file_path', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000002/file-c1000000-0000-4000-8000-000000000002.png', 'file_name', 'pol.png')),
  'b1000000-0000-4000-8000-000000000002'::uuid, 'other: an expired policy without links');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000003', '{"title":"Великий","doc_date":"2026-10-01","file_path":"a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000003/file-c1000000-0000-4000-8000-000000000003.pdf","file_name":"big.pdf"}')$$,
  'P0001', 'OTHER_FILE_TOO_BIG', 'other: a file over 10 MB is refused on the server');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000004', '{"title":"Без файлу","doc_date":"2026-10-01","file_path":"a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000004/file-c1000000-0000-4000-8000-000000000004.pdf","file_name":"x.pdf"}')$$,
  'P0001', 'OTHER_FILE_MISSING', 'other: a file that is not in the bucket is refused');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000005', '{"title":"Чужий шлях","doc_date":"2026-10-01","file_path":"a1000000-0000-4000-8000-00000000000b/b1000000-0000-4000-8000-000000000005/file-c1000000-0000-4000-8000-000000000005.pdf","file_name":"x.pdf"}')$$,
  'P0001', 'OTHER_FILE_BAD', 'other: a path of another organisation is refused');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000006', '{"title":"Чужий клієнт","doc_date":"2026-10-01","client_id":"a2000000-0000-4000-8000-000000000021","file_path":"x","file_name":"x.pdf"}')$$,
  'P0001', 'OTHER_LINK_NOT_FOUND', 'other: a client of another organisation cannot be linked');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000007', '{"title":"Чуже авто","doc_date":"2026-10-01","vehicle_id":"a3000000-0000-4000-8000-000000000021","file_path":"x","file_name":"x.pdf"}')$$,
  'P0001', 'OTHER_LINK_NOT_FOUND', 'other: a vehicle of another organisation cannot be linked');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000008', '{"title":"","doc_date":"2026-10-01","file_path":"x","file_name":"x.pdf"}')$$,
  'P0001', 'OTHER_BAD', 'other: a title is required');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000009', '{"title":"Т","category":"zzz","doc_date":"2026-10-01","file_path":"x","file_name":"x.pdf"}')$$,
  'P0001', 'OTHER_BAD', 'other: an unknown category is refused');
SELECT throws_ok($$INSERT INTO public.kp_other_docs (org_id, title, doc_date, file_path, file_name, file_size) VALUES ('a1000000-0000-4000-8000-00000000000a', 'прямо', DATE '2026-01-01', 'x', 'x', 1)$$,
  '42501', NULL, 'other: no direct INSERT into the table');
SELECT is((SELECT title FROM public.kp_other_list() WHERE id = 'b1000000-0000-4000-8000-000000000001'), 'Довіреність на водія', 'other: the list returns the file');
SELECT is((SELECT client_name || '/' || vehicle_label || '/' || driver_name FROM public.kp_other_list() WHERE id = 'b1000000-0000-4000-8000-000000000001'),
  'Агро DP/AA7777DP/Тестовий Водій', 'other: the list resolves client, vehicle and driver names');
SELECT is((SELECT string_agg(title, ',') FROM public.kp_other_list(p_status => 'expired')), 'Страховка', 'other: expired filter');
SELECT is((SELECT string_agg(title, ',') FROM public.kp_other_list() WHERE expiring_soon), 'Довіреність на водія', 'other: expiring_soon flag (≤ 30 days)');
SELECT is((SELECT string_agg(title, ',') FROM public.kp_other_list(p_category => 'insurance')), 'Страховка', 'other: category filter');
SELECT is((SELECT count(*)::integer FROM public.kp_other_list(p_client => 'a2000000-0000-4000-8000-000000000001')), 1, 'other: client filter');
SELECT is((SELECT count(*)::integer FROM public.kp_other_list(p_from => DATE '2026-01-01')), 1, 'other: period filter');
SELECT lives_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000001', '{"title":"Довіреність (нова)","valid_until":""}')$$, 'other: metadata of an active file can be edited');
SELECT is((SELECT title || '/' || coalesce(valid_until::text, 'null') FROM public.kp_other_list() WHERE id = 'b1000000-0000-4000-8000-000000000001'), 'Довіреність (нова)/null', 'other: the edit is applied, empty valid_until clears the date');

-- 6. Анулювання й видалення «Іншого» — лише власник.
SELECT throws_ok($$SELECT public.kp_other_cancel('b1000000-0000-4000-8000-000000000001', 'логіст')$$, '42501', 'KP_FORBIDDEN', 'other: a logist cannot cancel');
SELECT throws_ok($$SELECT public.kp_other_delete('b1000000-0000-4000-8000-000000000001')$$, '42501', 'KP_FORBIDDEN', 'other: a logist cannot delete');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f103","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_other_list()), 2, 'other: the director reads the list');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000001', '{"title":"директор"}')$$, '42501', 'KP_FORBIDDEN', 'other: the director cannot write');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f104","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM public.kp_other_list()), 0, 'other: another organisation sees nothing');
SELECT throws_ok($$SELECT public.kp_other_cancel('b1000000-0000-4000-8000-000000000001', 'чужий')$$, 'P0001', 'OTHER_NOT_FOUND', 'other: cannot cancel a foreign file');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_other_cancel('b1000000-0000-4000-8000-000000000001', '')$$, 'P0001', 'OTHER_REASON', 'other: cancel needs a reason');
SELECT lives_ok($$SELECT public.kp_other_cancel('b1000000-0000-4000-8000-000000000001', 'Втратила чинність')$$, 'other: the owner cancels');
SELECT throws_ok($$SELECT public.kp_other_cancel('b1000000-0000-4000-8000-000000000001', 'ще')$$, 'P0001', 'OTHER_CANCELLED', 'other: second cancel refused');
SELECT throws_ok($$SELECT public.kp_other_save('b1000000-0000-4000-8000-000000000001', '{"title":"після анулювання"}')$$, 'P0001', 'OTHER_CANCELLED', 'other: a cancelled file cannot be edited');
SELECT is((SELECT string_agg(title, ',') FROM public.kp_other_list(p_status => 'cancelled')), 'Довіреність (нова)', 'other: cancelled filter');
SELECT is((SELECT count(*)::integer FROM public.kp_other_list(p_status => 'active')), 0, 'other: no active ones left (the other is expired)');

-- 7. Storage: політики за ролями й шляхом; автор видаляє лише власний файл без запису, власник — будь-який.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f102","role":"authenticated"}', true);
SELECT lives_ok($$INSERT INTO storage.objects (bucket_id, name, owner_id, metadata) VALUES ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000010/file-c1000000-0000-4000-8000-000000000010.pdf', '00000000-0000-0000-0000-00000000f102', '{"size": 100}')$$,
  'storage: a logist uploads into the own organisation path');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000b/b1000000-0000-4000-8000-000000000011/file-c1000000-0000-4000-8000-000000000011.pdf', '{"size": 100}')$$,
  '42501', NULL, 'storage: a path of another organisation is refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000012/evil.exe', '{"size": 100}')$$,
  '42501', NULL, 'storage: only file-<uuid>.(pdf|jpg|png|doc|docx|xls|xlsx) names are accepted');
SELECT lives_ok($$INSERT INTO storage.objects (bucket_id, name, owner_id, metadata) VALUES ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000014/file-c1000000-0000-4000-8000-000000000014.pdf', '00000000-0000-0000-0000-00000000f101', '{"size": 100}')$$,
  'storage: (fixture) a file whose author is the owner');
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs'), 5, 'storage: a logist reads the files of the organisation');
DELETE FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000001/%';
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000001/%'), 1, 'storage: a logist cannot delete a file that has a record');
DELETE FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000014/%';
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000014/%'), 1, 'storage: a logist cannot delete somebody else''s file');
DELETE FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000010/%';
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000010/%'), 0, 'storage: the author deletes the own file that has no record');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f103","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs'), 4, 'storage: the director reads the files');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('kp-other-docs', 'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000013/file-c1000000-0000-4000-8000-000000000013.pdf', '{"size": 100}')$$,
  '42501', NULL, 'storage: the director cannot upload');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f104","role":"authenticated"}', true);
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs'), 0, 'storage: another organisation sees no files');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.kp_other_delete('b1000000-0000-4000-8000-000000000002')$$, 'P0001', 'OTHER_FILE_STILL_THERE', 'other: the record is not deleted while the file is still in the bucket');
DELETE FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000002/%';
SELECT is(public.kp_other_delete('b1000000-0000-4000-8000-000000000002'),
  'a1000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-000000000002/file-c1000000-0000-4000-8000-000000000002.png', 'other: file first, then the owner deletes the record');
DELETE FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000014/%';
SELECT is((SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'kp-other-docs' AND name LIKE '%000000000014/%'), 0, 'storage: the owner deletes any file of the organisation');
SELECT throws_ok($$SELECT public.kp_other_delete('b1000000-0000-4000-8000-000000000002')$$, 'P0001', 'OTHER_NOT_FOUND', 'other: a deleted record is gone');

-- 8. Анульований договір не надсилається контрагенту (контекст листа і резервування відправки).
SELECT throws_ok($$SELECT public.kp_contract_email_context('a5000000-0000-4000-8000-000000000002')$$, 'P0001', 'CONTRACT_CANCELLED', 'contracts: the email context of a cancelled contract is refused');
SELECT throws_ok($$SELECT public.kp_contract_email_context('a5000000-0000-4000-8000-000000000001')$$, 'P0001', 'CONTRACT_FILE_MISSING', 'contracts: a draft without a scan still reports the missing file');
RESET ROLE;
SELECT throws_ok($$SELECT public.kp_mail_reserve('a1000000-0000-4000-8000-00000000000a', ARRAY[]::uuid[], '00000000-0000-0000-0000-00000000f101', 'a@example.com', 'Договір', 20, 'a5000000-0000-4000-8000-000000000002')$$,
  'P0001', 'CONTRACT_CANCELLED', 'contracts: sending is not reserved for a cancelled contract');
SELECT lives_ok($$SELECT public.kp_mail_reserve('a1000000-0000-4000-8000-00000000000a', ARRAY[]::uuid[], '00000000-0000-0000-0000-00000000f101', 'a@example.com', 'Договір', 20, 'a5000000-0000-4000-8000-000000000001')$$,
  'contracts: sending is reserved for a live contract');

SELECT * FROM finish();
ROLLBACK;
