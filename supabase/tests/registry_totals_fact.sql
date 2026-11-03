-- registry_totals: «Прибуток факт» = факт, якщо внесено, інакше план (20261115090000_registry_fact_fallback.sql); fact_count; скасовані не входять.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(8);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

INSERT INTO public.organizations (id, name, work_mode) VALUES
  ('74000000-0000-0000-0000-00000000000a', 'Fact A', 'solo'),
  ('74000000-0000-0000-0000-00000000000b', 'Fact B foreign', 'solo');
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email, '', now(),
       '{"provider":"email","providers":["email"]}', '{"company_name":"Fact fixture"}', now(), now()
FROM (VALUES ('00000000-0000-0000-0000-0000000000f1', 'owner.a.fact@example.com'), ('00000000-0000-0000-0000-0000000000f2', 'owner.b.fact@example.com')) AS u(id, email);
UPDATE public.profiles AS p SET org_id = m.org::uuid, org_role = 'owner', member_status = 'active', is_approved = true
FROM (VALUES ('00000000-0000-0000-0000-0000000000f1', '74000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-0000000000f2', '74000000-0000-0000-0000-00000000000b')) AS m(id, org)
WHERE p.id = m.id::uuid;

-- Заявка: статус, план (netProfit), дата рейсу, факт (NULL — не внесено).
CREATE FUNCTION pg_temp.mk(p_n int, p_status text, p_plan numeric, p_date date, p_fact numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := ('75000000-0000-0000-0000-0000000000' || lpad(p_n::text, 2, '0'))::uuid;
BEGIN
  INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, decided_at)
  VALUES (v_id, '74000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1', 'fact ' || p_n, '{"dist":"100"}'::jsonb,
          jsonb_build_object('grossIncome', p_plan * 10, 'netProfit', p_plan), CASE WHEN p_status = 'cancelled' THEN 'accepted' ELSE p_status END, now());
  IF p_status = 'cancelled' THEN
    UPDATE public.calculations SET status = 'cancelled', cancel_reason = 'setup' WHERE id = v_id;
  ELSIF p_status = 'done' THEN
    UPDATE public.calculations SET status = 'done' WHERE id = v_id;
  END IF;
  UPDATE public.calculations SET trip_date = p_date WHERE id = v_id;
  IF p_fact IS NOT NULL THEN
    INSERT INTO public.trip_actuals (org_id, calculation_id, revenue, costs, planned_overhead, profit, entered_by)
    VALUES ('74000000-0000-0000-0000-00000000000a', v_id, 1, 1, 0, p_fact, '00000000-0000-0000-0000-0000000000f1');
  END IF;
END;
$$;
-- Січень: факту немає зовсім. Лютий: частковий (є в 1 із 2). Березень: повний. Квітень: повний + скасована з фактом.
SELECT pg_temp.mk(1, 'accepted', 100, '2026-01-10', NULL);
SELECT pg_temp.mk(2, 'done', 200, '2026-01-11', NULL);
SELECT pg_temp.mk(3, 'accepted', 100, '2026-02-10', 80);
SELECT pg_temp.mk(4, 'done', 300, '2026-02-11', NULL);
SELECT pg_temp.mk(5, 'accepted', 100, '2026-03-10', 90);
SELECT pg_temp.mk(6, 'done', 200, '2026-03-11', 250);
SELECT pg_temp.mk(7, 'accepted', 100, '2026-04-10', 70);
SELECT pg_temp.mk(8, 'cancelled', 999, '2026-04-11', 5);

CREATE FUNCTION pg_temp.totals(p_uid uuid, p_filters text, p_cols text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SELECT ' || p_cols || ' FROM public.registry_totals($1::jsonb)' INTO v USING p_filters;
  EXCEPTION WHEN others THEN
    v := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN v;
END;
$$;
-- Колонки: кількість / скасовані / прибуток план / прибуток факт / fact_count.
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f1', '{"from":"2026-01-01","to":"2026-01-31"}',
  $$total_count || '/' || cancelled_count || '/' || profit_plan || '/' || profit_fact || '/' || fact_count$$), '2/0/300/300/0',
  '1: факту немає зовсім — прибуток факт = план (300), fact_count 0, не 0 грн');
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f1', '{"from":"2026-02-01","to":"2026-02-28"}',
  $$total_count || '/' || cancelled_count || '/' || profit_plan || '/' || profit_fact || '/' || fact_count$$), '2/0/400/380/1',
  '2: частковий факт — 80 (факт) + 300 (план без факту) = 380, fact_count 1 з 2');
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f1', '{"from":"2026-03-01","to":"2026-03-31"}',
  $$total_count || '/' || cancelled_count || '/' || profit_plan || '/' || profit_fact || '/' || fact_count$$), '2/0/300/340/2',
  '3: повний факт — сума фактів 90 + 250, fact_count 2 з 2');
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f1', '{"from":"2026-04-01","to":"2026-04-30"}',
  $$total_count || '/' || cancelled_count || '/' || profit_plan || '/' || profit_fact || '/' || fact_count$$), '2/1/100/70/1',
  '4: скасована (план 999, факт 5) не входить ні в плани, ні в факт, ні в fact_count; кількість і cancelled_count лишаються');
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f1', '{}',
  $$profit_plan || '/' || profit_fact || '/' || fact_count$$), '1100/1090/4',
  '5: увесь реєстр: план 1100, факт-або-план 100+200+80+300+90+250+70 = 1090, факт внесено у 4 заявках');
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f2', '{"org_id":"74000000-0000-0000-0000-00000000000a"}', 'total_count::text'), '42501',
  '6: REGISTRY_FORBIDDEN лишається: чужа компанія через org_id');
SELECT is(pg_temp.totals('00000000-0000-0000-0000-0000000000f2', '{}', 'total_count::text'), '0',
  '7: власна компанія без заявок: 0 (RLS, без витоку чужих сум)');
SELECT is((SELECT prosecdef::text FROM pg_proc WHERE oid = 'public.registry_totals(jsonb)'::regprocedure), 'false',
  '8: registry_totals лишається SECURITY INVOKER');

SELECT * FROM finish();
ROLLBACK;
