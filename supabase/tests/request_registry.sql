-- Реєстр заявок (20261113090000_request_registry.sql): права переходів (роль × перехід × режим approval_mode),
-- нумерація, скасування, сповіщення, RLS для registry_list / registry_totals.
-- Run with pgTAP against a database that has all migrations: `supabase test db`. Everything is rolled back.
--
-- Тест виконується від суперкористувача: auth.uid() береться з request.jwt.claims (sub), тому тригери бачать «користувача»,
-- а RLS обходиться. Для перевірок RLS блоки нижче явно роблять SET LOCAL ROLE authenticated.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(44);

-- ---------------------------------------------------------------------------
-- Фікстура
-- ---------------------------------------------------------------------------
-- Організації: A (team) — матриця прав; B (solo); C (чужа); N — нумерація; R — підсумки реєстру.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

INSERT INTO public.organizations (id, name, work_mode) VALUES
  ('50000000-0000-0000-0000-00000000000a', 'Registry A', 'team'),
  ('50000000-0000-0000-0000-00000000000b', 'Registry B solo', 'solo'),
  ('50000000-0000-0000-0000-00000000000c', 'Registry C foreign', 'team'),
  ('50000000-0000-0000-0000-00000000000d', 'Registry N numbering', 'team'),
  ('50000000-0000-0000-0000-00000000000e', 'Registry R totals', 'team');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email, '', now(),
       '{"provider":"email","providers":["email"]}', '{"company_name":"Registry fixture"}', now(), now()
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'owner.a.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d2', 'logist.right.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d3', 'logist.noright.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d4', 'director.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d5', 'owner.b.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d6', 'owner.c.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d7', 'owner.n.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d8', 'owner.r.reg@example.com'),
  ('00000000-0000-0000-0000-0000000000d9', 'logist.r.reg@example.com')
) AS u(id, email);

UPDATE public.profiles AS p
SET org_id = m.org::uuid, org_role = m.role, member_status = 'active', is_approved = true
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000d1', '50000000-0000-0000-0000-00000000000a', 'owner'),
  ('00000000-0000-0000-0000-0000000000d2', '50000000-0000-0000-0000-00000000000a', 'logist'),
  ('00000000-0000-0000-0000-0000000000d3', '50000000-0000-0000-0000-00000000000a', 'logist'),
  ('00000000-0000-0000-0000-0000000000d5', '50000000-0000-0000-0000-00000000000b', 'owner'),
  ('00000000-0000-0000-0000-0000000000d6', '50000000-0000-0000-0000-00000000000c', 'owner'),
  ('00000000-0000-0000-0000-0000000000d7', '50000000-0000-0000-0000-00000000000d', 'owner'),
  ('00000000-0000-0000-0000-0000000000d8', '50000000-0000-0000-0000-00000000000e', 'owner'),
  ('00000000-0000-0000-0000-0000000000d9', '50000000-0000-0000-0000-00000000000e', 'logist')
) AS m(id, org, role)
WHERE p.id = m.id::uuid;

SELECT public.set_org_plan('50000000-0000-0000-0000-00000000000a', 'control_plus');

-- Директор org A (control_plus): окремий користувач, не учасник організації. У org B (company) той самий користувач — директор лише
-- формально: kp_is_org_director враховує тариф.
INSERT INTO public.org_directors (org_id, user_id) VALUES
  ('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d4'),
  ('50000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000d4');

-- Права логістів: d2 може приймати, d3 — ні.
INSERT INTO public.org_member_permissions (org_id, user_id, can_accept) VALUES
  ('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d2', true),
  ('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d3', false),
  ('50000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000d9', true);

-- Стан для перевірок: нова заявка org A / org-параметр, автор d2 (логіст з правом); потім вистава «користувача» і спроба переходу.
-- Повертає 'ok' або SQLSTATE. Спроба відкочується (підтранзакція), тож кожен виклик починає з чистої заявки.
CREATE FUNCTION pg_temp.act(p_actor uuid, p_from text, p_to text, p_reason text DEFAULT NULL,
                            p_org uuid DEFAULT '50000000-0000-0000-0000-00000000000a', p_author uuid DEFAULT '00000000-0000-0000-0000-0000000000d2')
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status)
  VALUES (v_id, p_org, p_author, 'matrix', '{}'::jsonb, '{}'::jsonb,
          CASE WHEN p_from IN ('done', 'cancelled') THEN 'accepted' ELSE p_from END);
  IF p_from = 'done' THEN
    UPDATE public.calculations SET status = 'done' WHERE id = v_id;
  ELSIF p_from = 'cancelled' THEN
    UPDATE public.calculations SET status = 'cancelled', cancel_reason = 'setup' WHERE id = v_id;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.calculations
    SET status = p_to, cancel_reason = coalesce(p_reason, cancel_reason)
    WHERE id = v_id;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    RETURN 'ok';
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    RETURN SQLSTATE;
  END;
END;
$$;

-- Те саме, але зі збереженням результату (повертає id заявки).
CREATE FUNCTION pg_temp.act_keep(p_actor uuid, p_id uuid, p_to text, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  UPDATE public.calculations SET status = p_to, cancel_reason = coalesce(p_reason, cancel_reason) WHERE id = p_id;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
END;
$$;

-- Пряма зміна колонки (SET-фрагмент) логістом/власником на чужій заявці org A; автор заявки — власник (d1).
CREATE FUNCTION pg_temp.patch(p_actor uuid, p_status text, p_set text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status)
  VALUES (v_id, '50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1', 'patch', '{}'::jsonb, '{}'::jsonb, p_status);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'UPDATE public.calculations SET ' || p_set || ' WHERE id = $1' USING v_id;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    RETURN 'ok';
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    RETURN SQLSTATE;
  END;
END;
$$;

-- Які сповіщення (мітки 'A'..) бачить користувач під роллю authenticated (RLS).
CREATE FUNCTION pg_temp.seen(p_uid uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  SELECT coalesce(string_agg(n.meta ->> 'tag', '' ORDER BY n.meta ->> 'tag'), '') INTO v FROM public.org_notifications AS n WHERE n.meta ->> 'tag' IS NOT NULL;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN v;
END;
$$;

-- Скільки рядків видалив DELETE (RLS мовчки відсікає заборонені).
CREATE FUNCTION pg_temp.del_count(p_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v integer;
BEGIN
  DELETE FROM public.calculations WHERE id = p_id;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END;
$$;

CREATE FUNCTION pg_temp.mk(p_org uuid, p_user uuid, p_status text, p_decided timestamptz DEFAULT NULL, p_id uuid DEFAULT gen_random_uuid(),
                           p_results jsonb DEFAULT '{}'::jsonb, p_inputs jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, decided_at)
  VALUES (p_id, p_org, p_user, 'calc ' || left(p_id::text, 8), p_inputs, p_results,
          CASE WHEN p_status IN ('done', 'cancelled') THEN 'accepted' ELSE p_status END, p_decided);
  IF p_status = 'done' THEN
    UPDATE public.calculations SET status = 'done' WHERE id = p_id;
  ELSIF p_status = 'cancelled' THEN
    UPDATE public.calculations SET status = 'cancelled', cancel_reason = 'setup' WHERE id = p_id;
  END IF;
  RETURN p_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Режим за замовчуванням і запис режиму
-- ---------------------------------------------------------------------------
SELECT is(public.approval_mode_of('50000000-0000-0000-0000-00000000000a'), 'owner_only', '1: режим за замовчуванням — owner_only');
SELECT throws_ok($$SELECT public.set_approval_mode('50000000-0000-0000-0000-00000000000a', 'anyone')$$, 'P0001', 'BAD_APPROVAL_MODE', '2: невідомий режим відхиляється');

-- ---------------------------------------------------------------------------
-- Матриця: роль × перехід × режим. Автор усіх заявок — d2 (логіст з правом).
-- Ролі: own = власник A, dir = директор A, lgR = логіст з правом (автор), lgN = логіст без права (не автор), out = власник чужої організації.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE reg_roles (ord int, role text, uid uuid) ON COMMIT DROP;
INSERT INTO reg_roles VALUES
  (1, 'own', '00000000-0000-0000-0000-0000000000d1'),
  (2, 'dir', '00000000-0000-0000-0000-0000000000d4'),
  (3, 'lgR', '00000000-0000-0000-0000-0000000000d2'),
  (4, 'lgN', '00000000-0000-0000-0000-0000000000d3'),
  (5, 'out', '00000000-0000-0000-0000-0000000000d6');
CREATE TEMP TABLE reg_moves (ord int, name text, from_status text, to_status text, reason text) ON COMMIT DROP;
INSERT INTO reg_moves VALUES
  (1, 'pending>accepted', 'pending', 'accepted', NULL),
  (2, 'pending>rejected', 'pending', 'rejected', NULL),
  (3, 'draft>accepted', 'draft', 'accepted', NULL),
  (4, 'accepted>done', 'accepted', 'done', NULL),
  (5, 'accepted>cancelled', 'accepted', 'cancelled', 'Клієнт відмовився'),
  (6, 'done>cancelled', 'done', 'cancelled', 'Пізно'),
  (7, 'cancelled>accepted', 'cancelled', 'accepted', NULL);

SELECT results_eq(
  $$SELECT m.name, string_agg(r.role || '=' || pg_temp.act(r.uid, m.from_status, m.to_status, m.reason), ' ' ORDER BY r.ord)
    FROM reg_moves AS m CROSS JOIN reg_roles AS r GROUP BY m.ord, m.name ORDER BY m.ord$$,
  $$VALUES
    ('pending>accepted'::text, 'own=ok dir=ok lgR=42501 lgN=42501 out=42501'::text),
    ('pending>rejected', 'own=ok dir=ok lgR=42501 lgN=42501 out=42501'),
    ('draft>accepted', 'own=42501 dir=ok lgR=42501 lgN=42501 out=42501'),
    ('accepted>done', 'own=ok dir=ok lgR=ok lgN=42501 out=42501'),
    ('accepted>cancelled', 'own=ok dir=ok lgR=42501 lgN=42501 out=42501'),
    ('done>cancelled', 'own=42501 dir=42501 lgR=42501 lgN=42501 out=42501'),
    ('cancelled>accepted', 'own=42501 dir=42501 lgR=42501 lgN=42501 out=42501')$$,
  '3: режим owner_only — логіст (навіть з правом) не приймає, не скасовує; директор нарівні з власником'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.set_approval_mode('50000000-0000-0000-0000-00000000000a', 'logist_can_accept');

SELECT results_eq(
  $$SELECT m.name, string_agg(r.role || '=' || pg_temp.act(r.uid, m.from_status, m.to_status, m.reason), ' ' ORDER BY r.ord)
    FROM reg_moves AS m CROSS JOIN reg_roles AS r GROUP BY m.ord, m.name ORDER BY m.ord$$,
  $$VALUES
    ('pending>accepted'::text, 'own=ok dir=ok lgR=ok lgN=42501 out=42501'::text),
    ('pending>rejected', 'own=ok dir=ok lgR=ok lgN=42501 out=42501'),
    ('draft>accepted', 'own=42501 dir=ok lgR=ok lgN=42501 out=42501'),
    ('accepted>done', 'own=ok dir=ok lgR=ok lgN=42501 out=42501'),
    ('accepted>cancelled', 'own=ok dir=ok lgR=ok lgN=42501 out=42501'),
    ('done>cancelled', 'own=42501 dir=42501 lgR=42501 lgN=42501 out=42501'),
    ('cancelled>accepted', 'own=42501 dir=42501 lgR=42501 lgN=42501 out=42501')$$,
  '4: режим logist_can_accept — логіст приймає/скасовує лише з правом can_accept; done > cancelled і вихід з cancelled заборонені всім'
);

-- «Сам»: власник приймає власну чернетку (як і раніше), у режимі solo логіст-права не потрібні.
SELECT is(
  pg_temp.act('00000000-0000-0000-0000-0000000000d5', 'draft', 'accepted', NULL,
              '50000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000d5'),
  'ok', '5: solo — власник приймає власну чернетку одразу'
);

CREATE FUNCTION pg_temp.can_accept(p_uid uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  RETURN public.member_can('accept');
END;
$f$;

-- member_can('accept'): працює без тарифу control_plus (org A на company), за замовчуванням false для логіста.
SELECT is(
  (SELECT string_agg(r.role || '=' || pg_temp.can_accept(r.uid)::text, ' ' ORDER BY r.ord) FROM reg_roles AS r WHERE r.role IN ('own', 'lgR', 'lgN')),
  'own=true lgR=true lgN=false',
  '6: member_can(accept): власник true, логіст з правом true, без права false (тариф company)'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT is(
  pg_temp.can_accept('00000000-0000-0000-0000-0000000000d9'), true,
  '6b: member_can(accept) працює й у організації на тарифі company (org R)'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Логіст з правом (режим logist_can_accept), не автор: будь-яка колонка поза полями рішення — відмова на draft / pending / accepted.
SELECT results_eq(
  $$SELECT s.status, string_agg(c.col || '=' || pg_temp.patch('00000000-0000-0000-0000-0000000000d2', s.status, c.set_sql), ' ' ORDER BY c.col)
    FROM (VALUES ('draft'), ('pending'), ('accepted')) AS s(status)
    CROSS JOIN (VALUES ('route_from', $q$route_from = 'Інше місто'$q$), ('revenue', 'revenue = 1'),
                       ('inputs', $q$inputs = '{"a":1}'::jsonb$q$), ('client_name', $q$client_name = 'Інший'$q$),
                       ('name', $q$name = 'Нова назва'$q$)) AS c(col, set_sql)
    GROUP BY s.status ORDER BY s.status$$,
  $$VALUES ('accepted'::text, 'client_name=42501 inputs=42501 name=42501 revenue=42501 route_from=42501'::text),
           ('draft', 'client_name=42501 inputs=42501 name=42501 revenue=42501 route_from=42501'),
           ('pending', 'client_name=42501 inputs=42501 name=42501 revenue=42501 route_from=42501')$$,
  '6c: логіст з правом accept не змінює route_from, revenue, inputs, client_name, name чужої draft / pending / accepted заявки'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT results_eq(
  $$SELECT pg_temp.act('00000000-0000-0000-0000-0000000000d2', 'pending', 'accepted', NULL, '50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1'),
           pg_temp.act('00000000-0000-0000-0000-0000000000d2', 'pending', 'rejected', NULL, '50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1'),
           pg_temp.act('00000000-0000-0000-0000-0000000000d2', 'accepted', 'cancelled', 'Причина', '50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1')$$,
  $$VALUES ('ok'::text, 'ok'::text, 'ok'::text)$$,
  '6d: той самий логіст приймає, відхиляє й скасовує (з причиною) чужу заявку'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT results_eq(
  $$SELECT pg_temp.patch('00000000-0000-0000-0000-0000000000d1', 'draft', $q$route_from = 'Власник міняє'$q$),
           pg_temp.patch('00000000-0000-0000-0000-0000000000d1', 'accepted', $q$client_name = 'Власник міняє'$q$)$$,
  $$VALUES ('ok'::text, 'ok'::text)$$,
  '6e: власник (не обмежений обліком колонок) змінює інші поля'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Директор на тарифі company не діє (kp_is_org_director враховує control_plus); на control_plus — діє (матриця вище).
SELECT is(
  pg_temp.act('00000000-0000-0000-0000-0000000000d4', 'pending', 'accepted', NULL, '50000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000d5'),
  '42501', '6f: директор з org_directors організації на тарифі company не приймає'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Сповіщення без адресата: owner і директор (control_plus) бачать усе, логіст з правом accept — лише approval_pending, адресат — свої.
INSERT INTO public.org_notifications (org_id, kind, ref_kind, ref_id, meta, recipient_id) VALUES
  ('50000000-0000-0000-0000-00000000000a', 'approval_pending', 'calculation', gen_random_uuid(), '{"tag":"A"}', NULL),
  ('50000000-0000-0000-0000-00000000000a', 'signature_used', 'document', gen_random_uuid(), '{"tag":"B"}', NULL),
  ('50000000-0000-0000-0000-00000000000a', 'approval_decided', 'calculation', gen_random_uuid(), '{"tag":"C"}', '00000000-0000-0000-0000-0000000000d3');
SELECT results_eq(
  $$SELECT string_agg(r.role || '=' || pg_temp.seen(r.uid), ' ' ORDER BY r.ord) FROM reg_roles AS r WHERE r.role <> 'out'$$,
  $$VALUES ('own=AB dir=AB lgR=A lgN=C'::text)$$,
  '6g: SELECT org_notifications: owner і директор — без адресата, логіст з правом — approval_pending, адресат — своє'
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Скасування: причина, службові поля, незмінність станів
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.act('00000000-0000-0000-0000-0000000000d1', 'accepted', 'cancelled', NULL), 'P0001', '7: скасування без причини падає');
SELECT is(pg_temp.act('00000000-0000-0000-0000-0000000000d1', 'accepted', 'cancelled', '   '), 'P0001', '8: скасування з порожньою (пробіли) причиною падає');

SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'accepted', '2026-03-01 10:00+02', '60000000-0000-0000-0000-000000000001');
SELECT pg_temp.act_keep('00000000-0000-0000-0000-0000000000d7', '60000000-0000-0000-0000-000000000001', 'cancelled', 'Клієнт відмовився');
SELECT results_eq(
  $$SELECT status, cancel_reason, cancelled_by, cancelled_at IS NOT NULL FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000001'$$,
  $$VALUES ('cancelled'::text, 'Клієнт відмовився'::text, '00000000-0000-0000-0000-0000000000d7'::uuid, true)$$,
  '9: cancelled_at / cancelled_by ставляться автоматично'
);

SELECT throws_ok(
  $$UPDATE public.calculations SET status = 'accepted' WHERE id = '60000000-0000-0000-0000-000000000001'$$,
  '42501', NULL, '10: з cancelled нікуди не переходить — навіть service_role'
);
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'done', '2031-05-02 10:00+03', '60000000-0000-0000-0000-000000000003');
SELECT throws_ok(
  $$UPDATE public.calculations SET status = 'cancelled', cancel_reason = 'x' WHERE id = '60000000-0000-0000-0000-000000000003'$$,
  '42501', NULL, '11: done > cancelled заборонено — навіть service_role'
);

-- ---------------------------------------------------------------------------
-- Нумерація (org N)
-- ---------------------------------------------------------------------------
-- 6000…01 вже accepted 2026-03-01 (№ 2026-0001); додаємо ще дві 2026-го, одну 2027-го.
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'accepted', '2026-03-03 10:00+02', '60000000-0000-0000-0000-000000000002');
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'accepted', '2027-01-05 10:00+02', '60000000-0000-0000-0000-000000000004');

SELECT results_eq(
  $$SELECT id::text, registry_no FROM public.calculations
    WHERE id IN ('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000004') ORDER BY id$$,
  $$VALUES ('60000000-0000-0000-0000-000000000001'::text, '2026-0001'::text),
           ('60000000-0000-0000-0000-000000000002', '2026-0002'),
           ('60000000-0000-0000-0000-000000000004', '2027-0001')$$,
  '12: наскрізний номер по організації за рік; новий рік починається з 0001'
);

-- Скасована заявка (№ 2026-0001) лишає номер, нова не перевикористовує його.
SELECT is((SELECT registry_no FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000001'), '2026-0001', '13: скасування не змінює номер');
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'accepted', '2026-04-01 10:00+03', '60000000-0000-0000-0000-000000000005');
SELECT is((SELECT registry_no FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000005'), '2026-0003', '14: номер скасованої не перевикористовується');

-- Номер не змінюється ззовні: ні користувачем, ні сервісом.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d7', 'role', 'authenticated')::text, true);
UPDATE public.calculations SET registry_no = '2026-9999' WHERE id = '60000000-0000-0000-0000-000000000002';
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.calculations SET registry_no = '2026-9998' WHERE id = '60000000-0000-0000-0000-000000000002';
SELECT is((SELECT registry_no FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000002'), '2026-0002', '15: номер після присвоєння не змінюється');

-- Перший перехід у accepted через користувача (pending → accepted) присвоює номер, done його зберігає.
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'pending', NULL, '60000000-0000-0000-0000-000000000006');
SELECT pg_temp.act_keep('00000000-0000-0000-0000-0000000000d7', '60000000-0000-0000-0000-000000000006', 'accepted');
SELECT matches((SELECT registry_no FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000006'), '^[0-9]{4}-[0-9]{4}$', '16: pending → accepted присвоює номер');
SELECT pg_temp.act_keep('00000000-0000-0000-0000-0000000000d7', '60000000-0000-0000-0000-000000000006', 'done');
SELECT is(
  (SELECT registry_no = (SELECT max(registry_no) FROM public.calculations WHERE org_id = '50000000-0000-0000-0000-00000000000d' AND registry_no LIKE to_char(now() AT TIME ZONE 'Europe/Kyiv', 'YYYY') || '-%')
   FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000006'),
  true, '17: accepted → done зберігає номер'
);

-- Лічильник атомарний: 50 викликів у одному запиті дають 50 різних номерів; дубль заборонено унікальним індексом.
SELECT is((SELECT count(DISTINCT public.kp_next_registry_no('50000000-0000-0000-0000-00000000000d', 2030)) FROM generate_series(1, 50)), 50::bigint,
  '18: 50 викликів лічильника — 50 унікальних номерів');
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d7', 'draft', NULL, '60000000-0000-0000-0000-000000000007');
SELECT throws_ok(
  $$UPDATE public.calculations SET registry_no = '2026-0002' WHERE id = '60000000-0000-0000-0000-000000000007'$$,
  '23505', NULL, '19: (org_id, registry_no) унікальний'
);

-- ---------------------------------------------------------------------------
-- Документи Контроль+ і видалення
-- ---------------------------------------------------------------------------
SELECT is(public.kp_calc_is_accepted('60000000-0000-0000-0000-000000000001'), false, '20: kp_calc_is_accepted — скасована заявка не підходить для нових документів');
SELECT is(public.kp_calc_is_accepted('60000000-0000-0000-0000-000000000002'), true, '21: kp_calc_is_accepted — прийнята підходить');

-- ---------------------------------------------------------------------------
-- Сповіщення автору
-- ---------------------------------------------------------------------------
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d2', 'pending', NULL, '60000000-0000-0000-0000-000000000010');
SELECT pg_temp.act_keep('00000000-0000-0000-0000-0000000000d1', '60000000-0000-0000-0000-000000000010', 'accepted');
SELECT results_eq(
  $$SELECT kind, recipient_id, actor_id, meta ->> 'decision' FROM public.org_notifications WHERE ref_id = '60000000-0000-0000-0000-000000000010'$$,
  $$VALUES ('approval_decided'::text, '00000000-0000-0000-0000-0000000000d2'::uuid, '00000000-0000-0000-0000-0000000000d1'::uuid, 'accepted'::text)$$,
  '22: автор заявки отримує approval_decided (прийнято)'
);
SELECT pg_temp.act_keep('00000000-0000-0000-0000-0000000000d1', '60000000-0000-0000-0000-000000000010', 'cancelled', 'Клієнт передумав');
SELECT results_eq(
  $$SELECT meta ->> 'decision', meta ->> 'reason', meta ->> 'registry_no' IS NOT NULL FROM public.org_notifications
    WHERE ref_id = '60000000-0000-0000-0000-000000000010' AND meta ->> 'decision' = 'cancelled'$$,
  $$VALUES ('cancelled'::text, 'Клієнт передумав'::text, true)$$,
  '23: сповіщення про скасування містить причину і номер'
);
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000d5', 'draft', NULL, '60000000-0000-0000-0000-000000000011');
SELECT pg_temp.act_keep('00000000-0000-0000-0000-0000000000d5', '60000000-0000-0000-0000-000000000011', 'accepted');
SELECT is((SELECT count(*)::int FROM public.org_notifications WHERE ref_id = '60000000-0000-0000-0000-000000000011'), 0, '24: рішення автора по власній заявці не створює сповіщення');

-- ---------------------------------------------------------------------------
-- RLS і RPC реєстру (org R: accepted 1000/100/100км факт 80, done 2000/300/200км факт 250, cancelled 500/50/50км; draft не в реєстрі)
-- ---------------------------------------------------------------------------
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000d8', 'accepted', '2026-05-10 10:00+03', '60000000-0000-0000-0000-000000000021',
  '{"grossIncome":1000,"netProfit":100}'::jsonb, '{"dist":"100","podachaDist":"0"}'::jsonb);
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000d9', 'done', '2026-05-11 10:00+03', '60000000-0000-0000-0000-000000000022',
  '{"grossIncome":2000,"netProfit":300}'::jsonb, '{"dist":"200","podachaDist":"0"}'::jsonb);
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000d8', 'cancelled', '2026-05-12 10:00+03', '60000000-0000-0000-0000-000000000023',
  '{"grossIncome":500,"netProfit":50}'::jsonb, '{"dist":"50","podachaDist":"0"}'::jsonb);
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000d8', 'draft', NULL, '60000000-0000-0000-0000-000000000024');
UPDATE public.calculations SET trip_date = DATE '2026-05-10' WHERE id = '60000000-0000-0000-0000-000000000021';
UPDATE public.calculations SET trip_date = DATE '2026-05-11' WHERE id = '60000000-0000-0000-0000-000000000022';
UPDATE public.calculations SET trip_date = DATE '2026-05-12' WHERE id = '60000000-0000-0000-0000-000000000023';
INSERT INTO public.trip_actuals (org_id, calculation_id, revenue, costs, planned_overhead, profit, entered_by) VALUES
  ('50000000-0000-0000-0000-00000000000e', '60000000-0000-0000-0000-000000000021', 1000, 900, 20, 80, '00000000-0000-0000-0000-0000000000d8'),
  ('50000000-0000-0000-0000-00000000000e', '60000000-0000-0000-0000-000000000022', 2000, 1700, 50, 250, '00000000-0000-0000-0000-0000000000d8');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d8', 'role', 'authenticated')::text, true);

SELECT results_eq(
  $$SELECT total_count, cancelled_count, revenue, profit_plan, profit_fact, distance_km FROM public.registry_totals('{}'::jsonb)$$,
  $$VALUES (3::bigint, 1::bigint, 3000::numeric, 400::numeric, 330::numeric, 300::numeric)$$,
  '25: registry_totals — кількість зі скасованою, суми (виручка, прибуток план / факт, км) без скасованої; чернетка не в реєстрі'
);
SELECT results_eq(
  $$SELECT total_count, revenue FROM public.registry_totals('{"status":["accepted","done"]}'::jsonb)$$,
  $$VALUES (2::bigint, 3000::numeric)$$,
  '26: фільтр status (масив) у totals'
);
SELECT results_eq(
  $$SELECT status FROM public.registry_list('{"status":"cancelled"}'::jsonb)$$,
  $$VALUES ('cancelled'::text)$$,
  '27: фільтр status (рядок) у списку'
);
SELECT is((SELECT count(*)::int FROM public.registry_list('{"user_id":"00000000-0000-0000-0000-0000000000d9"}'::jsonb)), 1, '28: фільтр user_id (логіст)');
SELECT is((SELECT count(*)::int FROM public.registry_list('{"from":"2026-05-11","to":"2026-05-12"}'::jsonb)), 2, '29: фільтр періоду from/to');
SELECT results_eq(
  $$SELECT count(*)::int, max(total_count) FROM public.registry_list('{}'::jsonb, 1, 0)$$,
  $$VALUES (1, 3::bigint)$$,
  '30: limit/offset, total_count рахує весь реєстр'
);
SELECT throws_ok($$SELECT * FROM public.registry_list('{"status":"draft"}'::jsonb)$$, 'P0001', 'BAD_FILTER', '31: чернетка не є статусом реєстру');

-- Чужа організація реєстру не бачить (RLS).
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d6', 'role', 'authenticated')::text, true);
SELECT is((SELECT count(*)::int FROM public.registry_list('{}'::jsonb)), 0, '32: чужа організація не бачить списку');
SELECT is((SELECT total_count FROM public.registry_totals('{}'::jsonb)), 0::bigint, '33: чужа організація не бачить підсумків');

-- Логіст без права бачить лише своє; з правом (режим logist_can_accept) — будь-які заявки компанії.
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.set_approval_mode('50000000-0000-0000-0000-00000000000a', 'logist_can_accept');
SELECT pg_temp.mk('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1', 'accepted', '2026-06-01 10:00+03', '60000000-0000-0000-0000-000000000030');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d3', 'role', 'authenticated')::text, true);
SELECT is((SELECT count(*)::int FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000030'), 0, '34: логіст без права не бачить чужу заявку');
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d2', 'role', 'authenticated')::text, true);
SELECT is((SELECT count(*)::int FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000030'), 1, '35: логіст з правом (logist_can_accept) бачить будь-яку заявку компанії');

-- Режим owner_only: право саме по собі не діє.
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.set_approval_mode('50000000-0000-0000-0000-00000000000a', 'owner_only');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d2', 'role', 'authenticated')::text, true);
SELECT is((SELECT count(*)::int FROM public.calculations WHERE id = '60000000-0000-0000-0000-000000000030'), 0, '36: у режимі owner_only логіст з правом чужу заявку не бачить');

-- Клієнт не змінює режим і не видаляє скасовані/прийняті заявки.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000d1', 'role', 'authenticated')::text, true);
SELECT throws_ok($$SELECT public.set_approval_mode('50000000-0000-0000-0000-00000000000a', 'logist_can_accept')$$, '42501', NULL, '37: клієнт не викликає set_approval_mode');
SELECT is(
  pg_temp.del_count('60000000-0000-0000-0000-000000000030'),
  0, '38: accepted / done / cancelled видалити не можна'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
