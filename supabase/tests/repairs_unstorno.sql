-- Контроль+ ремонти: «Скасувати сторно» (*_repair_unstorno.sql).
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
-- Locally apps/kontrol-plus/db/check-db.mjs runs this file on PGlite with a pgTAP shim.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(30);

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab01","role":"service_role"}', true);

-- A: control_plus (owner f1, logists f2 / f3, director f4, repair manager f5); B: control_plus (owner f8).
INSERT INTO public.organizations (id, name, work_mode)
VALUES ('7e000000-0000-0000-0000-00000000000a', 'RU plan', 'team'),
       ('7e000000-0000-0000-0000-00000000000b', 'RU other', 'solo');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000' || k)::uuid, 'authenticated', 'authenticated',
       'ru-' || k || '@example.com', '', now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('company_name', 'RU ' || k), now(), now()
FROM unnest(ARRAY['ab01', 'ab02', 'ab03', 'ab04', 'ab05', 'ab08']) AS k;

UPDATE public.profiles
SET org_id = CASE id WHEN '00000000-0000-0000-0000-00000000ab08' THEN '7e000000-0000-0000-0000-00000000000b'::uuid ELSE '7e000000-0000-0000-0000-00000000000a'::uuid END,
    org_role = CASE WHEN id IN ('00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-00000000ab03') THEN 'logist' ELSE 'owner' END,
    member_status = 'active', is_approved = true
WHERE id IN ('00000000-0000-0000-0000-00000000ab01', '00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-00000000ab03', '00000000-0000-0000-0000-00000000ab08');

SELECT public.set_org_plan('7e000000-0000-0000-0000-00000000000a', 'control_plus');
SELECT public.set_org_plan('7e000000-0000-0000-0000-00000000000b', 'control_plus');
INSERT INTO public.org_directors (org_id, user_id) VALUES ('7e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000ab04');
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('7f000000-0000-0000-0000-0000000000a1', '7e000000-0000-0000-0000-00000000000a', 'RU-A1');
INSERT INTO public.org_repair_handlers (org_id, user_id, kind) VALUES ('7e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000ab05', 'repair_manager');

CREATE TEMP TABLE t_ru (k text PRIMARY KEY, id uuid);
GRANT ALL ON t_ru TO PUBLIC;

-- Власник: деталь, прихід 10 × 100, ремонти r1 (списано 4) і r2 (без запчастин); логіст f2 призначений (пише, але не скасовує сторно).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab01","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO t_ru SELECT 'p1', public.kp_part_upsert(NULL, 'Фільтр RU', 'RU-1', 'шт', NULL, NULL)$$, 'owner: new part');
SELECT lives_ok($$SELECT public.kp_part_receive((SELECT id FROM t_ru WHERE k = 'p1'), 10, 100, public.ua_today())$$, 'owner: receipt 10 × 100');
SELECT lives_ok($$SELECT public.kp_repair_handler_add('00000000-0000-0000-0000-00000000ab02', 'logist')$$, 'owner: assigns logist f2');
SELECT lives_ok($$INSERT INTO t_ru SELECT 'r1', public.kp_repair_post('7f000000-0000-0000-0000-0000000000a1', public.ua_today(), 1000, 'Фільтр', NULL, 50,
  jsonb_build_array(jsonb_build_object('part_id', (SELECT id FROM t_ru WHERE k = 'p1'), 'qty', 4)))$$, 'owner: posts r1 (4 pcs)');
SELECT lives_ok($$INSERT INTO t_ru SELECT 'r2', public.kp_repair_post('7f000000-0000-0000-0000-0000000000a1', public.ua_today(), NULL, 'Без запчастин', NULL, 10, '[]'::jsonb)$$, 'owner: posts r2');
SELECT is((SELECT qty::text FROM public.parts WHERE id = (SELECT id FROM t_ru WHERE k = 'p1')), '6.000', 'stock after r1: 6');
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ru WHERE k = 'r1'), 'помилка')$$, 'owner: voids r1');
SELECT is((SELECT status || '|' || coalesce(status_before_void, '-') FROM public.repairs WHERE id = (SELECT id FROM t_ru WHERE k = 'r1')), 'void|posted', 'void stores the status before the void');
SELECT is((SELECT qty::text FROM public.parts WHERE id = (SELECT id FROM t_ru WHERE k = 'p1')), '10.000', 'void returns the parts to stock');

-- Не-сторно статус.
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r2'))$$, 'P0001', 'REPAIR_NOT_VOID', 'posted repair: REPAIR_NOT_VOID');
RESET ROLE;

-- Права: director, logist (призначений і ні) — ні.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab04","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1'))$$, '42501', NULL, 'director: forbidden');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab02","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1'))$$, '42501', NULL, 'assigned logist: forbidden');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab03","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1'))$$, '42501', NULL, 'unassigned logist: forbidden');
RESET ROLE;
-- Чужа компанія.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab08","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1'))$$, 'P0001', 'REPAIR_NOT_FOUND', 'other company owner: REPAIR_NOT_FOUND');
RESET ROLE;
-- Без входу.
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1'))$$, '42501', NULL, 'anon: no execute');
RESET ROLE;
SELECT is((SELECT status FROM public.repairs WHERE id = (SELECT id FROM t_ru WHERE k = 'r1')), 'void', 'forbidden calls changed nothing');

-- Менеджер з ремонтів: скасовує сторно; склад, списання, суми, журнал.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab05","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1')), 'posted', 'repair manager: unstorno returns the status before the void');
RESET ROLE;
SELECT is((SELECT status || '|' || (voided_at IS NULL)::text || '|' || (void_reason IS NULL)::text || '|' || total::text FROM public.repairs WHERE id = (SELECT id FROM t_ru WHERE k = 'r1')),
  'posted|true|true|450.00', 'repair is active again, void fields cleared, total unchanged (4 × 100 + 50)');
SELECT is((SELECT qty::text FROM public.parts WHERE id = (SELECT id FROM t_ru WHERE k = 'p1')), '6.000', 'unstorno writes the parts off again');
SELECT is((SELECT count(*)::integer FROM public.part_writeoffs WHERE repair_id = (SELECT id FROM t_ru WHERE k = 'r1') AND reversed_at IS NULL), 1, 'write-off is active again');
SELECT is((SELECT count(*)::integer FROM public.repair_status_log WHERE repair_id = (SELECT id FROM t_ru WHERE k = 'r1') AND action = 'void' AND actor = '00000000-0000-0000-0000-00000000ab01'), 1, 'log: the void by the owner');
SELECT is((SELECT count(*)::integer FROM public.repair_status_log WHERE repair_id = (SELECT id FROM t_ru WHERE k = 'r1') AND action = 'unstorno' AND from_status = 'void' AND to_status = 'posted'
  AND actor = '00000000-0000-0000-0000-00000000ab05'), 1, 'log: who cancelled the void (repair manager)');

-- Не вистачає на складі: сторно ще раз, потім залишок менший за списання.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab01","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.kp_repair_void((SELECT id FROM t_ru WHERE k = 'r1'), NULL)$$, 'owner: voids r1 again');
SELECT lives_ok($$SELECT public.kp_stock_adjust((SELECT id FROM t_ru WHERE k = 'p1'), -8, NULL, 'інвентаризація')$$, 'owner: adjusts the stock down to 2');
SELECT throws_ok($$SELECT public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1'))$$, 'P0001', 'STOCK_INSUFFICIENT', 'not enough stock: STOCK_INSUFFICIENT');
SELECT is((SELECT r.status || '|' || (SELECT qty::text FROM public.parts WHERE id = (SELECT id FROM t_ru WHERE k = 'p1')) FROM public.repairs AS r WHERE r.id = (SELECT id FROM t_ru WHERE k = 'r1')),
  'void|2.000', 'failed unstorno changes nothing');
-- Старе сторно без збереженого статусу → posted.
SELECT lives_ok($$SELECT public.kp_stock_adjust((SELECT id FROM t_ru WHERE k = 'p1'), 8, NULL, 'повернення')$$, 'owner: stock back to 10');
RESET ROLE;
UPDATE public.repairs SET status_before_void = NULL WHERE id = (SELECT id FROM t_ru WHERE k = 'r1');
SET LOCAL ROLE authenticated;
SELECT is(public.repair_unstorno((SELECT id FROM t_ru WHERE k = 'r1')), 'posted', 'legacy void without a stored status: back to posted (owner allowed)');
RESET ROLE;

-- Гранти: лише authenticated і service_role.
SELECT ok(has_function_privilege('authenticated', 'public.repair_unstorno(uuid)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.repair_unstorno(uuid)', 'EXECUTE'),
  'repair_unstorno: execute for authenticated only');
SELECT ok(NOT has_table_privilege('authenticated', 'public.repair_status_log', 'INSERT'), 'repair_status_log: clients cannot write');

SELECT * FROM finish();
ROLLBACK;
