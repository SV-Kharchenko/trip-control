-- Тріал 7 днів (20261117090000_trial_7d.sql): старт для нової компанії, один тріал на email / ЄДРПОУ, «лише читання» після кінця, оплата знімає блок.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(14);

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
  pg_temp.signup('00000000-0000-0000-0000-0000000000b4', 'approved.trial@example.com') AS approved;
GRANT SELECT ON orgs TO authenticated;

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

UPDATE public.org_subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE org_id = (SELECT a FROM orgs);
SELECT like(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b1'), '42501:TRIAL_EXPIRED%', '8: після закінчення INSERT блокується (42501 TRIAL_EXPIRED)');
SELECT like(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', $q$UPDATE public.calculations SET name = 'changed' WHERE org_id = (SELECT a FROM orgs) RETURNING 'ok'$q$), '42501:TRIAL_EXPIRED%',
  '9: після закінчення UPDATE блокується');
SELECT is(pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'SELECT count(*)::text FROM public.calculations'), '1', '10: SELECT працює, дані не видалені');
SELECT ok((SELECT count(*) = 6 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE t.tgname = 'trg_trial_readonly' AND c.relname IN ('calculations', 'kp_documents', 'kp_document_lines', 'kp_contracts', 'kp_doc_ttn', 'kp_other_docs')),
  '11: блокування стоїть на розрахунках, документах, договорах, ТТН та інших документах');

UPDATE public.org_subscriptions SET paid_until = now() + interval '30 days' WHERE org_id = (SELECT a FROM orgs);
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b1'), 'ok', '12: оплата одразу знімає обмеження');
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b5'), 'ok', '13: наявна компанія без тріалу працює як раніше');
UPDATE public.org_subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE org_id = (SELECT approved FROM orgs);
SELECT is(pg_temp.add_calc('00000000-0000-0000-0000-0000000000b4'), 'ok', '14: ручний повний доступ (is_approved) тріал не обмежує');

SELECT * FROM finish();
ROLLBACK;
