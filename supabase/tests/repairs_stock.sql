-- Контроль+ ремонти і склад, етап 3a (*_repairs_stock.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally (no Supabase stack) apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(122);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);

-- A: control_plus (owner e1, logists e2 / e3, director e4); B: control_plus (owner e8); C: company (owner e9).
-- e5, e6, e7 — майбутні менеджери з ремонтів (власні організації на company).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('60000000-0000-0000-0000-00000000000a', 'RS plan', 'team'),
       ('60000000-0000-0000-0000-00000000000b', 'RS other', 'solo'),
       ('60000000-0000-0000-0000-00000000000c', 'RS company', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-0000000000' || k)::uuid, 'authenticated', 'authenticated',
       'rs-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'RS ' || k), now(), now()
FROM unnest(ARRAY['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']) AS k;

UPDATE public.profiles
SET org_id = CASE id
      WHEN '00000000-0000-0000-0000-0000000000e8' THEN '60000000-0000-0000-0000-00000000000b'::uuid
      WHEN '00000000-0000-0000-0000-0000000000e9' THEN '60000000-0000-0000-0000-00000000000c'::uuid
      ELSE '60000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id IN ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3') THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3',
             '00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-0000000000e9');

SELECT public.set_org_plan('60000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('60000000-0000-0000-0000-00000000000b', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e4');
INSERT INTO public.fleet_vehicles (id, org_id, label)
VALUES ('61000000-0000-0000-0000-0000000000a1', '60000000-0000-0000-0000-00000000000a', 'RS-A1'),
       ('61000000-0000-0000-0000-0000000000b1', '60000000-0000-0000-0000-00000000000b', 'RS-B1');
INSERT INTO public.clients (org_id, name) VALUES ('60000000-0000-0000-0000-00000000000a', 'RS client');
INSERT INTO public.calculations (org_id, user_id, name, inputs, results, status)
VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'RS trip', '{}'::jsonb, '{}'::jsonb, 'accepted');

CREATE TEMP TABLE t_ids (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_ids TO PUBLIC;

-- 1. Менеджер з ремонтів (службова роль): обмеження «не учасник, не директор», місце.
SELECT lives_ok(
  $$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e5', 'repair_manager')$$,
  'service_role: adds a repair manager');
SELECT throws_ok(
  $$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e3', 'repair_manager')$$,
  'P0001', NULL, 'repair manager cannot be an active member of the org');
SELECT throws_ok(
  $$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e4', 'repair_manager')$$,
  'P0001', NULL, 'repair manager cannot be a director of the org');
SELECT lives_ok(
  $$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e6', 'repair_manager')$$,
  'service_role: second repair manager');
SELECT throws_ok(
  $$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e7', 'repair_manager')$$,
  'P0001', NULL, 'third repair manager — REPAIR_MANAGER_LIMIT');
SELECT throws_ok(
  $$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000e7', 'repair_manager')$$,
  '42501', NULL, 'company-plan org cannot have repair handlers');

-- 2. Власник.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role || '|' || can_write::text || '|' || can_manage_handlers::text FROM public.kp_repairs_context()), 'owner|true|true', 'owner: repairs context');
SELECT is((SELECT role FROM public.kp_context()), 'owner', 'owner: kp_context unchanged');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'p1', public.kp_part_upsert(NULL, 'Фільтр масляний', 'F-1', 'шт', NULL, NULL)$$, 'owner: new part');
SELECT throws_ok($$SELECT public.kp_part_upsert(NULL, 'Інший', ' f-1 ', 'шт', NULL, NULL)$$, 'P0001', NULL, 'owner: article is unique (lower/btrim)');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p1'), 10, 100, public.ua_today())$$, 'owner: receipt 10 × 100');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p1'), 10, 130, public.ua_today())$$, 'owner: receipt 10 × 130');
SELECT is((SELECT qty::text || '|' || avg_cost::text FROM public.parts WHERE id = (SELECT id FROM t_ids WHERE k = 'p1')), '20.000|115.0000',
  'moving average after two receipts: (10·100 + 10·130) / 20 = 115');
SELECT lives_ok($$SELECT public.kp_repair_handler_add('00000000-0000-0000-0000-0000000000e2', 'logist')$$, 'owner: assigns logist e2');
SELECT throws_ok($$SELECT public.kp_repair_handler_add('00000000-0000-0000-0000-0000000000e7', 'repair_manager')$$, 'P0001', NULL, 'owner: a manager only via invite');
SELECT throws_ok($$SELECT public.kp_repair_handler_add('00000000-0000-0000-0000-0000000000e8', 'logist')$$, 'P0001', NULL, 'owner: handler must be an active logist of the org');
SELECT throws_ok($$INSERT INTO public.parts (org_id, name) VALUES ('60000000-0000-0000-0000-00000000000a', 'x')$$, '42501', NULL, 'no direct INSERT into parts');
SELECT throws_ok($$UPDATE public.parts SET qty = 1000$$, '42501', NULL, 'no direct UPDATE of parts');
SELECT throws_ok($$DELETE FROM public.part_receipts$$, '42501', NULL, 'no direct DELETE of receipts');
SELECT throws_ok($$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e3', 'logist')$$,
  '42501', NULL, 'no direct INSERT into org_repair_handlers');
SELECT throws_ok($$UPDATE public.repairs SET works = 'x'$$, '42501', NULL, 'no direct UPDATE of repairs');
SELECT throws_ok($$INSERT INTO public.stock_adjustments (org_id, part_id, qty_delta, unit_cost, reason) VALUES ('60000000-0000-0000-0000-00000000000a', (SELECT id FROM t_ids WHERE k = 'p1'), 1, 1, 'x')$$,
  '42501', NULL, 'no direct INSERT into stock_adjustments');
SELECT throws_ok($$SELECT public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'x@y.ua', repeat('a', 64), NULL, now() + interval '7 days')$$,
  '42501', NULL, 'owner (authenticated) cannot call invite functions');
SELECT throws_ok($$SELECT public.kp_repair_post('61000000-0000-0000-0000-0000000000b1', public.ua_today(), 1, 'x', NULL, 0, '[]'::jsonb)$$,
  'P0001', NULL, 'vehicle of another org — REPAIR_VEHICLE_NOT_FOUND');
RESET ROLE;

-- 3. Призначений логіст пише; не призначений лише читає.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT can_write FROM public.kp_repairs_context()), true, 'assigned logist: can write');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'r1', public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), 120500, 'Заміна фільтра', 'СТО-1', 300,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p1'), 'qty', 5)))$$, 'assigned logist: posts a repair');
SELECT is((SELECT parts_cost::text || '|' || total::text || '|' || vehicle_label FROM public.repairs WHERE id = (SELECT id FROM t_ids WHERE k = 'r1')),
  '575.00|875.00|RS-A1', 'repair: parts at avg 115 × 5 + service 300');
SELECT is((SELECT qty::text || '|' || avg_cost::text FROM public.parts WHERE id = (SELECT id FROM t_ids WHERE k = 'p1')), '15.000|115.0000', 'write-off keeps the average');
SELECT throws_ok($$SELECT public.kp_stock_adjust((SELECT id FROM t_ids WHERE k = 'p1'), -1, NULL, 'x')$$, '42501', NULL, 'logist: no adjustments');
SELECT is((SELECT count(*)::integer FROM public.repair_manager_invites), 0, 'logist: sees no invites');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.parts), 1, 'unassigned logist: reads the stock');
SELECT throws_ok($$SELECT public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'x', NULL, 0, '[]'::jsonb)$$,
  '42501', NULL, 'unassigned logist: REPAIRS_FORBIDDEN');
SELECT throws_ok($$SELECT public.kp_parts_import('[]'::jsonb, false)$$, '42501', NULL, 'unassigned logist: no import');
RESET ROLE;

-- 4. Директор пише, керує відповідальними.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role || '|' || can_write::text FROM public.kp_repairs_context()), 'director|true', 'director: context');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'p2', public.kp_part_upsert(NULL, 'Колодки', 'B-2', 'компл', NULL, NULL)$$, 'director: new part');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p2'), 4, 500, public.ua_today())$$, 'director: receipt');
SELECT is((SELECT count(*)::integer FROM public.kp_repair_vehicles()), 1, 'director: vehicles of the org via RPC');
RESET ROLE;

-- 5. Менеджер з ремонтів: розділ «Ремонти» так, решта Контроль+ — ні.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT role || '|' || can_write::text || '|' || can_manage_handlers::text FROM public.kp_repairs_context()), 'repair_manager|true|false', 'manager: context');
SELECT is((SELECT coalesce(control_plus, false) FROM public.kp_context()), false, 'manager: kp_context as before (no Контроль+)');
SELECT ok(public.kp_org_id() IS NULL AND public.kp_role() IS NULL AND NOT public.kp_can_write(), 'manager: kp_org_id / kp_role / kp_can_write unchanged');
SELECT is((SELECT count(*)::integer FROM public.clients) + (SELECT count(*)::integer FROM public.calculations WHERE org_id = '60000000-0000-0000-0000-00000000000a')
  + (SELECT count(*)::integer FROM public.gps_integrations), 0, 'manager: no clients, trips or GPS settings');
SELECT is((SELECT count(*)::integer FROM public.parts), 2, 'manager: sees the stock');
SELECT is((SELECT count(*)::integer FROM public.repair_manager_invites), 0, 'manager: sees no invites');
SELECT throws_ok($$SELECT public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Ремонт', NULL, 0,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p2'), 'qty', 1),
                    jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p1'), 'qty', 100)))$$,
  'P0001', NULL, 'manager: two parts, one short — STOCK_INSUFFICIENT');
SELECT is((SELECT string_agg(qty::text, '|' ORDER BY name) FROM public.parts) || '|' || (SELECT count(*) FROM public.repairs)::text,
  '4.000|15.000|1', 'all or nothing: no stock moved, no repair written');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'r2', public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Ремонт', NULL, 0,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p2'), 'qty', 1),
                    jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p1'), 'qty', 2)))$$, 'manager: posts a repair with two parts');
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'r2'), 'помилка')$$, 'manager: voids own repair within 24 h');
SELECT is((SELECT string_agg(qty::text, '|' ORDER BY name) FROM public.parts), '4.000|15.000', 'void returns the quantities');
SELECT throws_ok($$SELECT public.kp_repair_handler_add('00000000-0000-0000-0000-0000000000e3', 'logist')$$, '42501', NULL, 'manager: cannot manage handlers');
RESET ROLE;

-- 6. Середня собівартість при сторно ремонту; сторно приходу після використання; коригування.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO t_ids SELECT 'p3', public.kp_part_upsert(NULL, 'Масло', 'M-3', 'л', NULL, NULL)$$, 'p3');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p3'), 10, 100, public.ua_today())$$, 'p3: 10 × 100');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'r3', public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Масло', NULL, 0,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p3'), 'qty', 4)))$$, 'p3: write-off 4 at 100');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'rc3', public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p3'), 6, 200, public.ua_today())$$, 'p3: 6 × 200 → avg 150');
SELECT is((SELECT avg_cost::text FROM public.parts WHERE id = (SELECT id FROM t_ids WHERE k = 'p3')), '150.0000', 'avg (6·100 + 6·200) / 12 = 150');
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'r3'))$$, 'owner: void');
SELECT is((SELECT qty::text || '|' || avg_cost::text FROM public.parts WHERE id = (SELECT id FROM t_ids WHERE k = 'p3')), '16.000|137.5000',
  'void = receipt at the write-off cost: (12·150 + 4·100) / 16 = 137.5');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'p4', public.kp_part_upsert(NULL, 'Лампа', NULL, 'шт', NULL, NULL)$$, 'p4');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'rc4', public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p4'), 3, 50, public.ua_today())$$, 'p4: 3 × 50');
SELECT lives_ok($$SELECT public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Лампи', NULL, 0,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p4'), 'qty', 2)))$$, 'p4: 2 used');
SELECT throws_ok($$SELECT public.kp_receipt_reverse((SELECT id FROM t_ids WHERE k = 'rc4'))$$, 'P0001', NULL, 'reverse a used receipt — RECEIPT_ALREADY_USED');
SELECT lives_ok($$SELECT public.kp_receipt_reverse((SELECT id FROM t_ids WHERE k = 'rc3'))$$, 'reverse an unused receipt');
SELECT is((SELECT qty::text || '|' || avg_cost::text FROM public.parts WHERE id = (SELECT id FROM t_ids WHERE k = 'p3')), '10.000|100.0000',
  'receipt reversal: (16·137.5 − 6·200) / 10 = 100');
SELECT lives_ok($$SELECT public.kp_stock_adjust((SELECT id FROM t_ids WHERE k = 'p3'), -1, NULL, 'Інвентаризація')$$, 'owner: adjustment −1');
SELECT throws_ok($$SELECT public.kp_stock_adjust((SELECT id FROM t_ids WHERE k = 'p3'), -100, NULL, 'x')$$, 'P0001', NULL, 'adjustment cannot make the stock negative');
-- Остання одиниця — двома послідовними ремонтами: друге списання — STOCK_INSUFFICIENT.
SELECT lives_ok($$INSERT INTO t_ids SELECT 'p5', public.kp_part_upsert(NULL, 'Датчик', 'D-5', 'шт', NULL, NULL)$$, 'p5');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p5'), 1, 900, public.ua_today())$$, 'p5: one unit');
SELECT lives_ok($$SELECT public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Датчик', NULL, 0,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p5'), 'qty', 1)))$$, 'first write-off of the last unit');
SELECT throws_ok($$SELECT public.kp_repair_post('61000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Датчик', NULL, 0,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ids WHERE k = 'p5'), 'qty', 1)))$$, 'P0001', NULL, 'second write-off — STOCK_INSUFFICIENT');
RESET ROLE;
SELECT ok((SELECT prosrc FROM pg_proc WHERE proname = 'kp_repair_post') ~ 'ORDER BY p\.id\s+FOR UPDATE', 'kp_repair_post locks parts FOR UPDATE in id order');

-- 7. Сторно за 24 години (межа — created_at на сервері; «старі» ремонти вставляє службова роль).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);
WITH ins AS (
  INSERT INTO public.repairs (org_id, vehicle_id, repair_date, works, created_by, created_at)
  SELECT '60000000-0000-0000-0000-00000000000a', '61000000-0000-0000-0000-0000000000a1', public.ua_today(), 'old ' || k, '00000000-0000-0000-0000-0000000000e2', now() - age
  FROM (VALUES ('v_23', interval '23:59:59'), ('v_24', interval '24 hours'), ('v_25', interval '25 hours'), ('v_30d', interval '30 days'),
               ('v_30d_dir', interval '30 days'), ('v_other', interval '1 hour')) AS t(k, age)
  RETURNING id, works
)
INSERT INTO t_ids SELECT substr(works, 5), id FROM ins;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'v_23'))$$, 'author: created_at = now − 23:59:59 → void ok');
SELECT throws_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'v_24'))$$, 'P0001', NULL, 'author: exactly 24:00:00 → REPAIR_VOID_EXPIRED');
SELECT throws_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'v_25'))$$, 'P0001', NULL, 'author: later → REPAIR_VOID_EXPIRED');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'v_other'))$$, '42501', NULL, 'another handler (not the author) → 42501');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'v_30d'))$$, 'owner: void after 30 days');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e4","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ids WHERE k = 'v_30d_dir'))$$, 'director: void after 30 days');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);
SELECT throws_ok($$UPDATE public.repairs SET created_at = now() WHERE id = (SELECT id FROM t_ids WHERE k = 'v_25')$$, '42501', NULL, 'created_at cannot be changed');

-- 8. Деактивований / заблокований логіст втрачає запис; інша організація й тариф «Компанія» нічого не бачать.
UPDATE public.profiles SET member_status = 'disabled' WHERE id = '00000000-0000-0000-0000-0000000000e2';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p1'), 1, 1, public.ua_today())$$, '42501', NULL, 'deactivated logist loses write');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);
UPDATE public.profiles SET member_status = 'active' WHERE id = '00000000-0000-0000-0000-0000000000e2';
UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '00000000-0000-0000-0000-0000000000e2';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ids WHERE k = 'p1'), 1, 1, public.ua_today())$$, '42501', NULL, 'blocked user cannot write');
RESET ROLE;
UPDATE auth.users SET banned_until = NULL WHERE id = '00000000-0000-0000-0000-0000000000e2';
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e8","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.parts) + (SELECT count(*)::integer FROM public.repairs) + (SELECT count(*)::integer FROM public.org_repair_handlers),
  0, 'another org: 0 rows');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e9","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT org_id IS NULL FROM public.kp_repairs_context()) AND (SELECT count(*) FROM public.parts) = 0, 'company plan: no repairs org, 0 rows');
SELECT throws_ok($$SELECT * FROM public.kp_repairs_list(public.ua_today() - 30, public.ua_today())$$, '42501', NULL, 'company plan: reader → 42501');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.kp_repairs_context()$$, '42501', NULL, 'anon cannot call kp_repairs_*');
RESET ROLE;

-- 9. Запрошення менеджерів: ліміт 2 (менеджери + чинні запрошення), звільнення місця, прийняття, email.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);
SELECT throws_ok($$SELECT public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'new1@example.com', repeat('1', 64), NULL, now() + interval '7 days')$$,
  'P0001', NULL, '2 managers → no invite (REPAIR_MANAGER_LIMIT)');
DELETE FROM public.org_repair_handlers WHERE user_id = '00000000-0000-0000-0000-0000000000e6';
SELECT lives_ok($$INSERT INTO t_ids SELECT 'i1', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'New1@Example.com', repeat('1', 64), '00000000-0000-0000-0000-0000000000e1', now() + interval '7 days')$$,
  '1 manager + first invite');
SELECT throws_ok($$SELECT public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'new2@example.com', repeat('2', 64), NULL, now() + interval '7 days')$$,
  'P0001', NULL, '1 manager + 1 pending → limit');
DELETE FROM public.org_repair_handlers WHERE user_id = '00000000-0000-0000-0000-0000000000e5';
SELECT lives_ok($$INSERT INTO t_ids SELECT 'i2', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'new2@example.com', repeat('2', 64), NULL, now() + interval '7 days')$$, 'second pending invite');
SELECT throws_ok($$SELECT public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'new3@example.com', repeat('3', 64), NULL, now() + interval '7 days')$$,
  'P0001', NULL, '2 pending invites → third — REPAIR_MANAGER_LIMIT');
SELECT ok(public.kp_repair_invite_revoke('60000000-0000-0000-0000-00000000000a', (SELECT id FROM t_ids WHERE k = 'i2')), 'revoke');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'i3', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'rs-e6@example.com', repeat('4', 64), NULL, now() + interval '7 days')$$, 'revoked frees a seat');
SELECT ok(public.kp_repair_invite_decline(repeat('4', 64), 'rs-e6@example.com'), 'decline');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'i4', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'rs-e6@example.com', repeat('5', 64), NULL, now() + interval '7 days')$$, 'declined frees a seat');
UPDATE public.repair_manager_invites SET expires_at = now() - interval '1 minute' WHERE id = (SELECT id FROM t_ids WHERE k = 'i1');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'i5', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'rs-e7@example.com', repeat('6', 64), NULL, now() + interval '7 days')$$, 'expired frees a seat');
SELECT throws_ok($$SELECT public.kp_repair_invite_accept(repeat('6', 64), '00000000-0000-0000-0000-0000000000e6', 'rs-e6@example.com')$$, 'P0001', NULL, 'email mismatch — INVITE_EMAIL_MISMATCH');
SELECT is(public.kp_repair_invite_accept(repeat('5', 64), '00000000-0000-0000-0000-0000000000e6', ' RS-E6@example.com '), '60000000-0000-0000-0000-00000000000a'::uuid, 'accept');
SELECT throws_ok($$SELECT public.kp_repair_invite_accept(repeat('5', 64), '00000000-0000-0000-0000-0000000000e6', 'rs-e6@example.com')$$, 'P0001', NULL, 'second accept — REPAIR_INVITE_USED');
SELECT is((SELECT count(*)::integer FROM public.org_repair_handlers WHERE user_id = '00000000-0000-0000-0000-0000000000e6'), 1, 'accept inserted the handler exactly once');
SELECT throws_ok($$SELECT public.kp_repair_invite_accept(repeat('1', 64), '00000000-0000-0000-0000-0000000000e6', 'new1@example.com')$$, 'P0001', NULL, 'expired invite cannot be accepted');
SELECT is((SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'repair_manager_invites' AND column_name LIKE '%token%'), 'token_hash', 'invites keep only the token hash');
SELECT is((SELECT profiles.org_id FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000e6')::text,
  (SELECT id::text FROM public.organizations WHERE id <> '60000000-0000-0000-0000-00000000000a' AND id = (SELECT org_id FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000e6')),
  'the manager keeps their own organization');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT count(*) FROM public.repair_manager_invites) >= 5, 'owner sees the invites');
SELECT throws_ok($$SELECT token_hash FROM public.repair_manager_invites$$, '42501', NULL, 'owner cannot read token_hash');
SELECT throws_ok($$SELECT * FROM public.repair_invite_sends$$, '42501', NULL, 'clients cannot read the send journal');
RESET ROLE;

-- 9b. Власний Контроль+ → менеджером з ремонтів бути не можна (kp_repairs_org_id віддав би власну організацію).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"service_role"}', true);
SELECT ok(public.kp_repair_invite_revoke('60000000-0000-0000-0000-00000000000a', (SELECT id FROM t_ids WHERE k = 'i5')), 'revoke frees a seat for the next case');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'i6', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'rs-e8@example.com', repeat('7', 64), '00000000-0000-0000-0000-0000000000e1', now() + interval '7 days')$$,
  'invite the owner of another control_plus org');
SELECT throws_ok($$SELECT public.kp_repair_invite_accept(repeat('7', 64), '00000000-0000-0000-0000-0000000000e8', 'rs-e8@example.com')$$,
  'P0001', 'REPAIR_MANAGER_HAS_OWN_KP', 'owner of another control_plus org — REPAIR_MANAGER_HAS_OWN_KP');
SELECT is((SELECT count(*)::integer FROM public.org_repair_handlers WHERE user_id = '00000000-0000-0000-0000-0000000000e8'), 0, 'own KP: handler not inserted');
SELECT ok((SELECT accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expires_at > now()
  FROM public.repair_manager_invites WHERE id = (SELECT id FROM t_ids WHERE k = 'i6')), 'own KP: the invite stays open');
SELECT throws_ok($$INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('60000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e4', 'repair_manager')$$,
  'P0001', 'REPAIR_MANAGER_HAS_OWN_KP', 'guard: a director of a control_plus org cannot be a repair manager elsewhere');

-- 9c. Ліміти відправлень (журнал repair_invite_sends, під блокуванням організації).
SELECT throws_ok($$SELECT public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000a', (SELECT id FROM t_ids WHERE k = 'i6'), 'rs-e8@example.com', repeat('8', 64), NULL, now() + interval '7 days')$$,
  'P0001', 'REPAIR_INVITE_RATE_LIMIT', 'resend of one invite within 60 s — REPAIR_INVITE_RATE_LIMIT');
SELECT lives_ok($$INSERT INTO t_ids SELECT 'b1', public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000b', gen_random_uuid(), 'b1@example.com', repeat('9', 64), NULL, now() + interval '7 days')$$,
  'org B: first send');
INSERT INTO public.repair_invite_sends (org_id, invite_id) SELECT '60000000-0000-0000-0000-00000000000b', (SELECT id FROM t_ids WHERE k = 'b1') FROM generate_series(1, 9);
SELECT throws_ok($$SELECT public.kp_repair_invite_reserve('60000000-0000-0000-0000-00000000000b', gen_random_uuid(), 'b2@example.com', repeat('b', 64), NULL, now() + interval '7 days')$$,
  'P0001', 'REPAIR_INVITE_RATE_LIMIT', '11th send of the org within an hour — REPAIR_INVITE_RATE_LIMIT');
SELECT is((SELECT count(*)::integer FROM public.repair_invite_sends WHERE org_id = '60000000-0000-0000-0000-00000000000a'), 6, 'every successful create / resend is journaled');

-- 10. Імпорт: перевірка нічого не пише; помилка — нічого не записано; дублі; наявний артикул; ліміт.
CREATE TEMP TABLE t_before AS SELECT (SELECT count(*) FROM public.parts) AS parts, (SELECT count(*) FROM public.part_receipts) AS receipts,
  (SELECT qty FROM public.parts WHERE article = 'F-1') AS f_qty, (SELECT avg_cost FROM public.parts WHERE article = 'F-1') AS f_avg;
GRANT ALL ON t_before TO PUBLIC;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((public.kp_parts_import('[{"line":2,"name":"Ремінь","article":"R-9","qty":"2","unit_price":"300","date":"2026-10-01"},
  {"line":3,"name":"Фільтр масляний","article":"f-1","qty":"5","unit_price":"200"},
  {"line":4,"name":"","qty":"x","unit_price":"-1","date":"2026-02-30"}]'::jsonb, false) -> 'summary')::text,
  '{"total": 3, "errors": 1, "new_parts": 1, "receipts_existing": 1}', 'dry run: statuses and summary');
SELECT ok((SELECT count(*) FROM public.parts) = (SELECT parts FROM t_before) AND (SELECT count(*) FROM public.part_receipts) = (SELECT receipts FROM t_before),
  'dry run writes nothing');
SELECT throws_ok($$SELECT public.kp_parts_import('[{"line":2,"name":"Ремінь","article":"R-9","qty":"2","unit_price":"300"},{"line":3,"name":"","qty":"1","unit_price":"1"}]'::jsonb, true)$$,
  'P0001', NULL, 'commit with an error row — IMPORT_HAS_ERRORS');
SELECT ok((SELECT count(*) FROM public.parts) = (SELECT parts FROM t_before) AND (SELECT count(*) FROM public.part_receipts) = (SELECT receipts FROM t_before),
  'failed commit writes nothing');
SELECT is((SELECT string_agg(r ->> 'status', ',') FROM jsonb_array_elements(public.kp_parts_import(
  '[{"line":2,"name":"A","article":"DUP","qty":"1","unit_price":"1"},{"line":3,"name":"B","article":" dup ","qty":"1","unit_price":"1"},{"line":4,"name":"C","qty":"1","unit_price":"1"}]'::jsonb, false) -> 'rows') AS r),
  'error,error,new_part', 'duplicate article in the file: both rows are errors');
SELECT lives_ok($$SELECT public.kp_parts_import('[{"line":2,"name":"Ремінь","article":"R-9","qty":"2","unit_price":"300","date":"2026-10-01"},
  {"line":3,"name":"Фільтр масляний","article":"f-1","qty":"5","unit_price":"200"}]'::jsonb, true)$$, 'commit');
SELECT is((SELECT avg_cost FROM public.parts WHERE article = 'F-1'),
  (SELECT round((f_qty * f_avg + 5 * 200) / (f_qty + 5), 4) FROM t_before), 'existing article: receipt into the existing part, moving average');
SELECT is((SELECT count(*)::integer FROM public.part_receipts WHERE import_batch_id IS NOT NULL AND kind = 'opening'), 2, 'import receipts: opening balances with a batch id');
SELECT throws_ok($$SELECT public.kp_parts_import((SELECT jsonb_agg(jsonb_build_object('line', g, 'name', 'X' || g, 'qty', '1', 'unit_price', '1')) FROM generate_series(1, 2001) AS g), false)$$,
  'P0001', NULL, '2001 rows — IMPORT_TOO_LARGE');
SELECT throws_ok($$SELECT public.kp_parts_import(jsonb_build_array(jsonb_build_object('name', repeat('x', 2 * 1024 * 1024 + 1), 'qty', '1', 'unit_price', '1')), false)$$,
  'P0001', 'IMPORT_TOO_LARGE', 'over 2 MB of JSON — IMPORT_TOO_LARGE (not only on the client)');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
