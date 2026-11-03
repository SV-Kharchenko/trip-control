-- Тріал 7 днів (20261117090000_trial_7d.sql): старт для нової компанії, один тріал на email / ЄДРПОУ, «лише читання» після кінця, оплата знімає блок.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(26);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Реєстрація як у проді: рядок у auth.users → тригер створює компанію, профіль owner і profile компанії (+ тригер тріалу).
CREATE FUNCTION pg_temp.signup(p_id text, p_email text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000', p_id::uuid, 'authenticated', 'authenticated', p_email, '', now(),
          '{"provider":"email","providers":["email"]}', '{"company_name":"Trial fixture"}', now(), now());
  RETURN (SELECT org_id FROM public.profiles WHERE id = p_id::uuid);
END;
$$;

CREATE TEMP TABLE orgs AS SELECT
  pg_temp.signup('00000000-0000-0000-0000-0000000000b1', 'new.trial@example.com') AS a,
  pg_temp.signup('00000000-0000-0000-0000-0000000000b2', 'New.Trial+second@Example.com') AS repeat_email,
  pg_temp.signup('00000000-0000-0000-0000-0000000000b3', 'other.trial@example.com') AS b,
  pg_temp.signup('00000000-0000-0000-0000-0000000000b4', 'approved.trial@example.com') AS approved,
  pg_temp.signup('00000000-0000-0000-0000-0000000000b6', 'pay.trial@example.com') AS payer;
GRANT SELECT ON orgs TO authenticated;

SELECT public.set_org_plan((SELECT a FROM orgs), 'control_plus');
SELECT public.set_org_plan((SELECT payer FROM orgs), 'control_plus');

-- Наявна компанія (створена до міграції): рядок організації без тригера тріалу й без підписки.
INSERT INTO public.organizations (id, name) VALUES ('7b000000-0000-0000-0000-000000000001', 'Legacy');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b5', 'authenticated', 'authenticated', 'legacy.trial@example.com', '', now(),
        '{"provider":"email","providers":["email"]}', '{"company_name":"Legacy user"}', now(), now());
UPDATE public.profiles SET org_id = '7b000000-0000-0000-0000-000000000001', org_role = 'owner', member_status = 'active'
WHERE id = '00000000-0000-0000-0000-0000000000b5';
UPDATE public.profiles SET is_approved = true WHERE id = '00000000-0000-0000-0000-0000000000b4';

CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN others THEN
    v := SQLSTATE || ':' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN v;
END;
$$;
CREATE FUNCTION pg_temp.as_claims(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN others THEN
    v := SQLSTATE || ':' || SQLERRM;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN v;
END;
$$;
CREATE FUNCTION pg_temp.add_calc(p_uid uuid) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.as_user(p_uid, $q$INSERT INTO public.calculations (name, inputs, results) VALUES ('trial calc', '{"dist":"1"}'::jsonb, '{}'::jsonb) RETURNING 'ok'$q$);
$$;

-- ---------------------------------------------------------------------------
-- Старт тріалу
-- ---------------------------------------------------------------------------
SELECT ok((SELECT trial_ends_at IS NOT NULL FROM public.org_subscriptions WHERE org_id = (SELECT a FROM orgs)), '1: нова компанія отримує trial_ends_at');
SELECT ok((SELECT trial_ends_at > now() + interval '6 days' AND trial_ends_at <= now() + interval '8 days'
           AND trial_ends_at = date_trunc('day', trial_ends_at AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv'
           FROM public.org_subscriptions WHERE org_id = (SELECT a FROM orgs)), '2: 7 днів за Києвом, до кінця 7-го дня (початок доби)');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.org_subscriptions WHERE org_id = '7b000000-0000-0000-0000-000000000001') AND NOT public.org_readonly('7b000000-0000-0000-0000-000000000001'),
  '3: наявна компанія тріалу не отримує й не змінюється');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.org_subscriptions WHERE org_id = (SELECT repeat_email FROM orgs) AND trial_ends_at IS NOT NULL),
  '4: повторна реєстрація з тим самим email (регістр, +тег) тріал не дає');
UPDATE public.org_company_profiles SET edrpou = '12345678' WHERE org_id = (SELECT a FROM orgs);
UPDATE public.org_company_profiles SET edrpou = '12345678' WHERE org_id = (SELECT b FROM orgs);
SELECT ok((SELECT trial_ends_at IS NULL FROM public.org_subscriptions WHERE org_id = (SELECT b FROM orgs))
          AND (SELECT trial_ends_at IS NOT NULL FROM public.org_subscriptions WHERE org_id = (SELECT a FROM orgs)),
  '5: той самий ЄДРПОУ в іншій компанії — її тріал скасовано, першої лишається');

-- ---------------------------------------------------------------------------
-- Під час тріалу і після нього
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b1'), 'ok', '6: під час тріалу розрахунок створюється');
SELECT ok(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'SELECT public.current_is_approved()::text') = 'true', '7: під час тріалу повний доступ (не демо)');
-- Ще два розрахунки (разом 3 = демо-ліміт): після тріалу INSERT має дати саме TRIAL_EXPIRED, а не DEMO_SAVE_LIMIT.
INSERT INTO public.calculations (org_id, user_id, name, inputs, results) SELECT (SELECT a FROM orgs), '00000000-0000-0000-0000-0000000000b1', 'seed ' || g, '{}'::jsonb, '{}'::jsonb FROM generate_series(1, 2) AS g;
INSERT INTO public.clients (id, org_id, name) VALUES ('7d000000-0000-0000-0000-000000000001', (SELECT a FROM orgs), 'Клієнт');
INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('7d000000-0000-0000-0000-000000000002', (SELECT a FROM orgs), 'AA0001AA');

-- ---------------------------------------------------------------------------
-- Після закінчення тріалу: усе закрито, читання лишається
-- ---------------------------------------------------------------------------
UPDATE public.org_subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE org_id = (SELECT a FROM orgs);
SELECT like(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b1'), '42501:TRIAL_EXPIRED%', '8: INSERT розрахунку (демо-ліміт уже досягнуто) дає саме 42501 TRIAL_EXPIRED, а не DEMO_SAVE_LIMIT');
SELECT is(
  (SELECT string_agg(r, ',' ORDER BY r) FROM (
    SELECT left(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$UPDATE public.calculations SET name = 'changed' WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 20) AS r
    UNION ALL SELECT left(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$DELETE FROM public.calculations WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 20)
    UNION ALL SELECT left(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$UPDATE public.clients SET name = 'x' WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 20)
    UNION ALL SELECT left(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$DELETE FROM public.clients WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 20)
    UNION ALL SELECT left(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$UPDATE public.fleet_vehicles SET label = 'x' WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 20)
    UNION ALL SELECT left(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$DELETE FROM public.fleet_vehicles WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 20)
  ) AS x),
  '42501:TRIAL_EXPIRED,42501:TRIAL_EXPIRED,42501:TRIAL_EXPIRED,42501:TRIAL_EXPIRED,42501:TRIAL_EXPIRED,42501:TRIAL_EXPIRED',
  '9: UPDATE і DELETE блокуються на розрахунках, клієнтах і автопарку');
CREATE TEMP TABLE guarded AS
  SELECT c.relname::text AS t, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE t.tgname = '_trial_readonly' AND NOT t.tgisinternal;
SELECT is((SELECT count(*)::int FROM guarded WHERE tgtype = 31), 32,
  '10: _trial_readonly (ROW, BEFORE, INSERT+UPDATE+DELETE) стоїть на всіх 32 таблицях: розрахунки, документи, платежі, підписи, ТТН, подорожні листи, клієнти, автопарк, водії, шаблони, факт, ремонти');
SELECT is((SELECT count(*)::int FROM guarded WHERE pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', format('INSERT INTO public.%I DEFAULT VALUES', t)) LIKE '42501:TRIAL_EXPIRED%'), 32,
  '11: INSERT на кожній із цих таблиць дає 42501 TRIAL_EXPIRED (тригер спрацьовує до решти перевірок)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'SELECT count(*)::text FROM public.calculations'), '3', '12: SELECT працює, дані не видалені');
SELECT is(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b1', $q$UPDATE public.org_company_profiles SET ownership = 'tov' WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), 'ok',
  '13: налаштування профілю компанії не блокуються');
SELECT ok(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'SELECT public.current_org_readonly()::text') = 'true'
          AND has_column_privilege('authenticated', 'public.org_subscriptions', 'trial_ends_at', 'SELECT'),
  '14: current_org_readonly() = true після тріалу; клієнт може читати trial_ends_at');

SELECT is((SELECT count(*)::int FROM guarded g WHERE (SELECT min(tg.tgname) FROM pg_trigger tg WHERE tg.tgrelid = ('public.' || g.t)::regclass AND NOT tg.tgisinternal AND (tg.tgtype & 2) = 2) = '_trial_readonly'), 32,
  '22: _trial_readonly спрацьовує першим серед BEFORE-тригерів на всіх 32 таблицях (порядок за назвою)');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'SELECT count(*)::text FROM public.kp_maintenance_seed_defaults()') || '/'
          || (SELECT count(*) FROM public.maintenance_types WHERE org_id = (SELECT a FROM orgs)), '0/0',
  '23: kp_maintenance_seed_defaults у режимі лише читання нічого не засіває й не падає');

UPDATE public.org_subscriptions SET paid_until = now() + interval '30 days' WHERE org_id = (SELECT a FROM orgs);
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b1'), 'ok', '15: оплата (paid_until) одразу знімає обмеження');
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b5'), 'ok', '16: наявна компанія без trial_ends_at працює як раніше');
UPDATE public.org_subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE org_id = (SELECT approved FROM orgs);
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b4'), 'ok', '17: ручний повний доступ (is_approved) знімає блок');

SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'SELECT count(*)::text FROM public.kp_maintenance_seed_defaults()'), '5', '24: після оплати типи обслуговування засіваються як раніше');

-- ---------------------------------------------------------------------------
-- Оплата під час тріалу: залишок тріалу не згорає
-- ---------------------------------------------------------------------------
INSERT INTO public.payments (id, org_id, created_by, provider, plan, amount_minor, provider_order_id)
VALUES ('7e000000-0000-0000-0000-000000000001', (SELECT payer FROM orgs), '00000000-0000-0000-0000-0000000000b6', 'mono', 'month', 25000, 'trial-pay-1');
CREATE TEMP TABLE before_pay AS SELECT trial_ends_at AS t FROM public.org_subscriptions WHERE org_id = (SELECT payer FROM orgs);
SELECT public.apply_payment_success('7e000000-0000-0000-0000-000000000001', NULL);
SELECT is((SELECT s.paid_until FROM public.org_subscriptions s WHERE s.org_id = (SELECT payer FROM orgs)), (SELECT t + interval '1 month' FROM before_pay),
  '18: оплата під час тріалу: paid_until = кінець тріалу + 1 місяць');
SELECT ok((SELECT s.paid_until > now() + interval '35 days' FROM public.org_subscriptions s WHERE s.org_id = (SELECT payer FROM orgs)) AND (SELECT t > now() + interval '6 days' FROM before_pay),
  '19: залишок тріалу (понад 6 днів) додається до оплаченого місяця');
SELECT ok(NOT public.org_readonly((SELECT payer FROM orgs)) AND public.org_trial_active((SELECT payer FROM orgs)), '20: після оплати компанія не в режимі лише читання');
UPDATE public.org_subscriptions SET trial_ends_at = now() - interval '2 days', paid_until = now() - interval '1 day' WHERE org_id = (SELECT payer FROM orgs);
SELECT ok(public.org_readonly((SELECT payer FROM orgs)), '21: оплата й тріал скінчились — знову лише читання');

-- Тимчасова компанія запрошеного логіста з минулим тріалом видаляється так, як це робить accept_org_invite (лише service_role: тригер пропускає).
INSERT INTO public.organizations (id, name) VALUES ('7f000000-0000-0000-0000-000000000001', 'Temp invitee org');
INSERT INTO public.org_subscriptions (org_id, trial_ends_at) VALUES ('7f000000-0000-0000-0000-000000000001', now() - interval '3 days');
INSERT INTO public.company_settings (org_id, settings) VALUES ('7f000000-0000-0000-0000-000000000001', '{}'::jsonb);
DELETE FROM public.company_settings WHERE org_id = '7f000000-0000-0000-0000-000000000001';
DELETE FROM public.organizations WHERE id = '7f000000-0000-0000-0000-000000000001';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = '7f000000-0000-0000-0000-000000000001')
          AND NOT EXISTS (SELECT 1 FROM public.org_subscriptions WHERE org_id = '7f000000-0000-0000-0000-000000000001'),
  '25: тимчасова компанія з минулим тріалом видаляється під service_role (як у accept_org_invite)');
INSERT INTO public.maintenance_types (org_id, name, interval_km, sort) VALUES ((SELECT payer FROM orgs), 'Масло', 15000, 10);
SELECT like(pg_temp.as_claims('00000000-0000-0000-0000-0000000000b6', $q$DELETE FROM public.maintenance_types WHERE org_id = (SELECT payer FROM orgs) RETURNING 'ok'$q$), '42501:TRIAL_EXPIRED%',
  '26: прямий DELETE користувачем у режимі лише читання, як і раніше, дає TRIAL_EXPIRED');

SELECT * FROM finish();
ROLLBACK;
