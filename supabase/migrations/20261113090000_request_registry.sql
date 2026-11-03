-- Apply manually after review. This file is not applied to production by the agent.
--
-- «Реєстр заявок», частина A: база, права, API (без інтерфейсу реєстру). Для сайту (company) і Контроль+ однаково.
--
-- Рішення:
--  * Заявки лишаються в calculations. Реєстр = статуси accepted, done, cancelled. accepted = «Активна/прийнята»,
--    статусу in_work немає. Новий статус cancelled («Скасована») потребує причини; done -> cancelled заборонено,
--    з cancelled нікуди не переходить (це діє і для service_role).
--  * registry_no: наскрізний по організації за рік, 2026-0001. Присвоюється один раз при першому переході в accepted
--    (або одразу в accepted/done), рік — за decided_at (Europe/Kyiv). Лічильник calc_registry_counters оновлюється
--    атомарно (INSERT .. ON CONFLICT DO UPDATE блокує рядок), у тій самій транзакції, що й заявка: паралельні запити не
--    дублюють номер, відкат не залишає дірок. Після присвоєння номер не змінюється і не перевикористовується, навіть
--    якщо заявку скасовано.
--  * Директор з org_directors приймає нарівні з owner. Логіст приймає ЛИШЕ коли company_settings.settings.approval_mode =
--    'logist_can_accept' (за замовчуванням 'owner_only') І в нього org_member_permissions.can_accept = true; тоді він
--    приймає будь-які заявки компанії. member_can('accept') працює на обох тарифах (company і control_plus).
--  * calculations_enforce_approval переписано (дослівно лишилося: INSERT -> draft, «Сам»-прийняття власником власної
--    чернетки, подання автором/власником). Сервісна роль (auth.uid() IS NULL) цим тригером не обмежується — її перевіряє
--    API (lib/approvals.js); інваріанти cancelled/registry_no діють для всіх у тригері calculations_registry.
--  * Документи Контроль+: усі наявні перевірки статусу заявки — білий список IN ('accepted', 'done')
--    (kp_calc_is_accepted, kp_doc_ttn_calc_accepted, kp_document_lines_calc_accepted, kp_trip_sheet_create / ttn_create,
--    kp_calc_accepted_list, trip_actuals_guard). Вони без змін відхиляють cancelled для НОВИХ документів; ці тригери
--    спрацьовують лише на INSERT, тож наявні документи скасованої заявки лишаються й не видаляються.
--  * Сповіщення approval_decided автору заявки (recipient_id), коли її прийнято / відхилено / скасовано не ним самим.
--  * RPC registry_list / registry_totals: SECURITY INVOKER (RLS), фільтри from, to, user_id, vehicle, client, status.
--
-- Ідемпотентно. Старі міграції не редагуються.
--
-- РУЧНИЙ ВІДКАТ (SQL editor, однією транзакцією, у цьому порядку; спершу політики й функції, що викликають нові функції,
-- і лише потім DROP нових функцій):
--   BEGIN;
--   -- 1. Тригери нової міграції.
--   DROP TRIGGER IF EXISTS trg_calculations_notify_decided ON public.calculations;
--   DROP TRIGGER IF EXISTS trg_calculations_registry ON public.calculations;
--   -- 2. Політики назад (вони викликають calc_logist_accepts / kp_is_org_director — тому ДО видалення функцій).
--   DROP POLICY IF EXISTS org_notifications_select ON public.org_notifications;
--   CREATE POLICY org_notifications_select ON public.org_notifications FOR SELECT TO authenticated
--     USING (org_id = public.current_org_id() AND public.is_org_owner());
--   DROP POLICY IF EXISTS calculations_select_role ON public.calculations;
--   CREATE POLICY calculations_select_role ON public.calculations FOR SELECT TO authenticated
--     USING (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid() OR public.org_logists_see_all()));
--   DROP POLICY IF EXISTS calculations_update_role ON public.calculations;
--   CREATE POLICY calculations_update_role ON public.calculations FOR UPDATE TO authenticated
--     USING (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid()))
--     WITH CHECK (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid()));
--   DROP POLICY IF EXISTS calculations_delete_role ON public.calculations;
--   CREATE POLICY calculations_delete_role ON public.calculations FOR DELETE TO authenticated
--     USING (org_id = public.current_org_id() AND status NOT IN ('accepted', 'done') AND (public.is_org_owner() OR user_id = auth.uid()));
--   -- 3. Старі тіла функцій: виконати CREATE OR REPLACE FUNCTION public.calculations_enforce_approval() з
--   --    20261027140559_calc_approvals.sql та public.member_can(text) з 20261028155128_director_cabinet.sql
--   --    (разом з їх REVOKE / GRANT з тих файлів; гранти member_can не змінювались: EXECUTE лише authenticated, service_role).
--   -- 4. Дані й обмеження.
--   DELETE FROM public.org_notifications WHERE kind = 'approval_decided';
--   UPDATE public.calculations SET status = 'done' WHERE status = 'cancelled';   -- або видалити такі рядки за домовленістю
--   ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_kind_check;
--   ALTER TABLE public.org_notifications ADD CONSTRAINT org_notifications_kind_check
--     CHECK (kind IN ('approval_pending', 'signature_used', 'doc_emailed'));
--   ALTER TABLE public.org_notifications DROP COLUMN IF EXISTS recipient_id;
--   REVOKE UPDATE (cancel_reason) ON public.calculations FROM authenticated;
--   ALTER TABLE public.calculations DROP CONSTRAINT IF EXISTS calculations_cancel_reason_ck,
--     DROP CONSTRAINT IF EXISTS calculations_registry_no_ck, DROP CONSTRAINT IF EXISTS calculations_org_registry_no_key,
--     DROP CONSTRAINT IF EXISTS calculations_status_check;
--   ALTER TABLE public.calculations ADD CONSTRAINT calculations_status_check
--     CHECK (status IN ('draft', 'pending', 'accepted', 'rejected', 'done'));
--   DROP INDEX IF EXISTS public.calculations_org_registry_idx;
--   ALTER TABLE public.calculations DROP COLUMN IF EXISTS registry_no, DROP COLUMN IF EXISTS cancelled_at,
--     DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancel_reason;
--   ALTER TABLE public.org_member_permissions DROP COLUMN IF EXISTS can_accept;
--   -- 5. Нові функції й таблиця (уже ніхто на них не посилається). Ключ approval_mode у company_settings.settings можна лишити.
--   DROP FUNCTION IF EXISTS public.registry_list(jsonb, integer, integer), public.registry_totals(jsonb);
--   DROP FUNCTION IF EXISTS public.calculations_notify_decided(), public.calculations_registry(), public.kp_next_registry_no(uuid, integer),
--     public.set_approval_mode(uuid, text), public.calc_logist_accepts(uuid), public.kp_is_org_director(uuid), public.approval_mode_of(uuid);
--   DROP TABLE IF EXISTS public.calc_registry_counters;
--   COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Колонки, статус, унікальність
-- ---------------------------------------------------------------------------

ALTER TABLE public.calculations
  ADD COLUMN IF NOT EXISTS registry_no text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE public.calculations DROP CONSTRAINT IF EXISTS calculations_status_check;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_status_check
  CHECK (status IN ('draft', 'pending', 'accepted', 'rejected', 'done', 'cancelled'));

ALTER TABLE public.calculations DROP CONSTRAINT IF EXISTS calculations_cancel_reason_ck;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_cancel_reason_ck
  CHECK (
    (cancel_reason IS NULL OR char_length(cancel_reason) <= 500)
    AND (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> ''))
  );

ALTER TABLE public.calculations DROP CONSTRAINT IF EXISTS calculations_registry_no_ck;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_registry_no_ck CHECK (registry_no IS NULL OR registry_no ~ '^[0-9]{4}-[0-9]{4,}$');

ALTER TABLE public.calculations DROP CONSTRAINT IF EXISTS calculations_org_registry_no_key;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_org_registry_no_key UNIQUE (org_id, registry_no);

CREATE INDEX IF NOT EXISTS calculations_org_registry_idx
  ON public.calculations (org_id, registry_no DESC)
  WHERE status IN ('accepted', 'done', 'cancelled');

-- У authenticated немає табличного UPDATE на calculations (лише колонкові гранти: name, status, reject_reason), тож без цього
-- гранта клієнт не передасть причину разом зі статусом cancelled. cancelled_at / cancelled_by / registry_no ставить лише тригер.
GRANT UPDATE (cancel_reason) ON public.calculations TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Лічильник номерів
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.calc_registry_counters (
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_no integer NOT NULL DEFAULT 0 CHECK (last_no >= 0),
  PRIMARY KEY (org_id, year)
);

ALTER TABLE public.calc_registry_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.calc_registry_counters FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.calc_registry_counters TO service_role;

-- Наступний номер організації за рік: '2026-0001'. Один атомарний оператор: паралельні виклики стають у чергу на рядку.
CREATE OR REPLACE FUNCTION public.kp_next_registry_no(p_org uuid, p_year integer)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_no integer;
BEGIN
  INSERT INTO public.calc_registry_counters AS c (org_id, year, last_no)
  VALUES (p_org, p_year, 1)
  ON CONFLICT (org_id, year) DO UPDATE SET last_no = c.last_no + 1
  RETURNING c.last_no INTO v_no;
  RETURN p_year::text || '-' || CASE WHEN v_no > 9999 THEN v_no::text ELSE lpad(v_no::text, 4, '0') END;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_next_registry_no(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Право can_accept і режим прийняття
-- ---------------------------------------------------------------------------

ALTER TABLE public.org_member_permissions
  ADD COLUMN IF NOT EXISTS can_accept boolean NOT NULL DEFAULT false;

-- Те саме тіло, що в 20261028155128_director_cabinet.sql, плюс 'accept' (за замовчуванням false, як 'sign').
CREATE OR REPLACE FUNCTION public.member_can(p_perm text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_org uuid;
  v_row public.org_member_permissions%ROWTYPE;
BEGIN
  IF p_perm IS NULL OR p_perm NOT IN ('acts', 'sign', 'fleet', 'clients', 'contracts', 'accept') THEN
    RETURN false;
  END IF;
  IF v_uid IS NULL OR coalesce(auth.jwt() ->> 'role', '') = 'service_role' THEN
    RETURN true;
  END IF;
  SELECT p.org_role, p.org_id INTO v_role, v_org FROM public.profiles AS p WHERE p.id = v_uid;
  IF v_role IS DISTINCT FROM 'logist' THEN
    RETURN true;
  END IF;
  SELECT * INTO v_row FROM public.org_member_permissions WHERE org_id = v_org AND user_id = v_uid;
  IF NOT FOUND THEN
    RETURN p_perm NOT IN ('sign', 'accept');
  END IF;
  RETURN CASE p_perm
    WHEN 'acts' THEN v_row.can_acts
    WHEN 'sign' THEN v_row.can_sign
    WHEN 'fleet' THEN v_row.can_fleet
    WHEN 'clients' THEN v_row.can_clients
    WHEN 'accept' THEN v_row.can_accept
    ELSE v_row.can_contracts
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.member_can(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_can(text) TO authenticated, service_role;

-- 'owner_only' (за замовчуванням) | 'logist_can_accept'. Будь-яке інше значення = 'owner_only'.
CREATE OR REPLACE FUNCTION public.approval_mode_of(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT CASE WHEN cs.settings ->> 'approval_mode' = 'logist_can_accept' THEN 'logist_can_accept' END
     FROM public.company_settings AS cs WHERE cs.org_id = p_org LIMIT 1),
    'owner_only'
  );
$$;

-- Поточний користувач — директор цієї організації (org_directors), а організація — на тарифі control_plus.
CREATE OR REPLACE FUNCTION public.kp_is_org_director(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.org_directors AS d WHERE d.org_id = p_org AND d.user_id = auth.uid())
     AND public.org_has_plan(p_org, 'control_plus');
$$;

-- Поточний користувач — активний логіст цієї організації з правом приймати І режим logist_can_accept.
CREATE OR REPLACE FUNCTION public.calc_logist_accepts(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.profiles AS p
       WHERE p.id = auth.uid() AND p.org_id = p_org AND p.org_role = 'logist' AND p.member_status = 'active'
     )
     AND public.approval_mode_of(p_org) = 'logist_can_accept'
     AND public.member_can('accept');
$$;

REVOKE ALL ON FUNCTION public.approval_mode_of(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_is_org_director(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calc_logist_accepts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approval_mode_of(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_is_org_director(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calc_logist_accepts(uuid) TO authenticated, service_role;

-- Режим змінює лише API (service_role) за перевіркою власника, як set_logists_visibility.
CREATE OR REPLACE FUNCTION public.set_approval_mode(p_org uuid, p_mode text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_service_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('owner_only', 'logist_can_accept') THEN
    RAISE EXCEPTION 'BAD_APPROVAL_MODE' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.company_settings (org_id, settings, updated_at)
  VALUES (p_org, jsonb_build_object('approval_mode', p_mode), now())
  ON CONFLICT (org_id) DO UPDATE
  SET settings = jsonb_set(coalesce(public.company_settings.settings, '{}'::jsonb), '{approval_mode}', to_jsonb(p_mode), true),
      updated_at = now();
  RETURN p_mode;
END;
$$;

REVOKE ALL ON FUNCTION public.set_approval_mode(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_approval_mode(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Права переходів (тригер)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.calculations_enforce_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner boolean;
  v_director boolean;
  v_logist boolean;
  v_solo boolean;
  -- Єдине, що міняє логіст, який має доступ до чужої заявки лише через право accept (решту колонок він змінювати не може).
  v_allowed constant text[] := ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'cancel_reason', 'cancelled_at',
                                      'cancelled_by', 'registry_no', 'updated_at'];
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.submitted_at := NULL;
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.reject_reason := NULL;
    RETURN NEW;
  END IF;

  v_owner := EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = v_uid AND p.org_id = OLD.org_id AND p.org_role = 'owner' AND p.member_status = 'active'
  );
  v_director := public.kp_is_org_director(OLD.org_id);
  v_logist := public.calc_logist_accepts(OLD.org_id);

  -- Логіст, якому чужу заявку відкриває лише calc_logist_accepts, змінює тільки поля рішення (v_allowed); будь-яка інша
  -- колонка, що відрізняється від OLD, — відмова. Тригер спрацьовує до calculations_fill_history і calculations_registry,
  -- тож порівнюється те, що надіслав клієнт.
  IF NOT v_owner AND NOT v_director AND OLD.user_id IS DISTINCT FROM v_uid AND v_logist
     AND (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'CALC_COLUMNS_FORBIDDEN: accept right changes only the decision fields' USING ERRCODE = '42501';
  END IF;

  -- Поля рішення змінюються лише разом зі статусом і лише цим тригером.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.submitted_at := OLD.submitted_at;
    NEW.decided_by := OLD.decided_by;
    NEW.decided_at := OLD.decided_at;
    NEW.reject_reason := OLD.reject_reason;
    RETURN NEW;
  END IF;

  IF NEW.status = 'pending' AND OLD.status IN ('draft', 'rejected') THEN
    IF OLD.user_id <> v_uid AND NOT v_owner THEN
      RAISE EXCEPTION 'APPROVAL_FORBIDDEN: only the author submits' USING ERRCODE = '42501';
    END IF;
    NEW.submitted_at := now();
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.reject_reason := NULL;
    RETURN NEW;
  END IF;

  -- На погодженні: рішає owner, директор (org_directors) або логіст з правом (режим logist_can_accept + can_accept).
  IF NEW.status IN ('accepted', 'rejected') AND OLD.status = 'pending' THEN
    IF NOT (v_owner OR v_director OR v_logist) THEN
      RAISE EXCEPTION 'APPROVAL_FORBIDDEN: only the owner, a director or a logist with the right decides' USING ERRCODE = '42501';
    END IF;
    NEW.decided_by := v_uid;
    NEW.decided_at := now();
    NEW.reject_reason := CASE WHEN NEW.status = 'rejected' THEN left(NULLIF(btrim(COALESCE(NEW.reject_reason, '')), ''), 500) ELSE NULL END;
    RETURN NEW;
  END IF;

  -- Одразу в accepted: «Сам» — власник власну чернетку; директор; логіст з правом у режимі «Команда».
  IF NEW.status = 'accepted' AND OLD.status IN ('draft', 'rejected') THEN
    SELECT o.work_mode = 'solo' INTO v_solo FROM public.organizations AS o WHERE o.id = OLD.org_id;
    IF (v_owner AND OLD.user_id = v_uid AND COALESCE(v_solo, false))
       OR v_director
       OR (v_logist AND NOT COALESCE(v_solo, false)) THEN
      NEW.decided_by := v_uid;
      NEW.decided_at := now();
      NEW.reject_reason := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'APPROVAL_FORBIDDEN: not submitted' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'done' AND OLD.status = 'accepted' THEN
    IF OLD.user_id = v_uid OR v_owner OR v_director THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Скасування прийнятої: owner, директор, логіст з правом. Причину і cancelled_at / cancelled_by перевіряє calculations_registry.
  IF NEW.status = 'cancelled' AND OLD.status = 'accepted' THEN
    IF v_owner OR v_director OR v_logist THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'APPROVAL_FORBIDDEN: % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_enforce_approval() FROM PUBLIC, anon, authenticated;

-- Номер реєстру і поля скасування: для всіх викликів, зокрема service_role. Спрацьовує ПІСЛЯ calculations_enforce_approval
-- (тригери одного типу виконуються за алфавітом назв: trg_calculations_enforce_approval < trg_calculations_registry).
CREATE OR REPLACE FUNCTION public.calculations_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.registry_no := NULL;
    NEW.cancelled_at := NULL;
    NEW.cancelled_by := NULL;
    NEW.cancel_reason := NULL;
    IF NEW.status = 'cancelled' THEN
      RAISE EXCEPTION 'BAD_TRANSITION: a request cannot be created cancelled' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'CANCELLED_FINAL: a cancelled request does not change status' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'done' AND NEW.status = 'cancelled' THEN
      RAISE EXCEPTION 'DONE_CANNOT_CANCEL: a done request cannot be cancelled' USING ERRCODE = '42501';
    END IF;
    -- Номер після присвоєння не змінюється. Явно задати його може лише серверний код / міграція (auth.uid() IS NULL).
    IF OLD.registry_no IS NOT NULL THEN
      NEW.registry_no := OLD.registry_no;
    ELSIF auth.uid() IS NOT NULL THEN
      NEW.registry_no := NULL;
    END IF;

    IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
      IF OLD.status <> 'accepted' THEN
        RAISE EXCEPTION 'BAD_TRANSITION: only an accepted request can be cancelled' USING ERRCODE = '42501';
      END IF;
      IF NULLIF(btrim(COALESCE(NEW.cancel_reason, '')), '') IS NULL THEN
        RAISE EXCEPTION 'CANCEL_REASON_REQUIRED' USING ERRCODE = 'P0001';
      END IF;
      NEW.cancel_reason := left(btrim(NEW.cancel_reason), 500);
      NEW.cancelled_at := now();
      NEW.cancelled_by := coalesce(auth.uid(), NEW.cancelled_by);
    ELSE
      NEW.cancelled_at := OLD.cancelled_at;
      NEW.cancelled_by := OLD.cancelled_by;
      NEW.cancel_reason := OLD.cancel_reason;
    END IF;
  END IF;

  IF NEW.registry_no IS NULL AND NEW.status IN ('accepted', 'done') THEN
    v_year := extract(year FROM (coalesce(NEW.decided_at, now()) AT TIME ZONE 'Europe/Kyiv'))::integer;
    NEW.registry_no := public.kp_next_registry_no(NEW.org_id, v_year);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_registry() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_calculations_registry ON public.calculations;
CREATE TRIGGER trg_calculations_registry
  BEFORE INSERT OR UPDATE ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_registry();

-- ---------------------------------------------------------------------------
-- 5. Видалення, видимість для логіста з правом
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS calculations_delete_role ON public.calculations;
CREATE POLICY calculations_delete_role ON public.calculations
  FOR DELETE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND status NOT IN ('accepted', 'done', 'cancelled')
    AND (public.is_org_owner() OR user_id = auth.uid())
  );

-- Логіст з правом приймати бачить і вирішує будь-які заявки компанії (лише коли режим logist_can_accept).
DROP POLICY IF EXISTS calculations_select_role ON public.calculations;
CREATE POLICY calculations_select_role ON public.calculations
  FOR SELECT TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (
      public.is_org_owner()
      OR user_id = auth.uid()
      OR public.org_logists_see_all()
      OR public.calc_logist_accepts(org_id)
    )
  );

DROP POLICY IF EXISTS calculations_update_role ON public.calculations;
CREATE POLICY calculations_update_role ON public.calculations
  FOR UPDATE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (public.is_org_owner() OR user_id = auth.uid() OR public.calc_logist_accepts(org_id))
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND (public.is_org_owner() OR user_id = auth.uid() OR public.calc_logist_accepts(org_id))
  );

-- ---------------------------------------------------------------------------
-- 6. Backfill: номери наявним accepted / done за decided_at (запасний created_at), по організації і року
-- ---------------------------------------------------------------------------

ALTER TABLE public.calculations DISABLE TRIGGER trg_calculations_fill_history;

WITH ranked AS (
  SELECT c.id,
         extract(year FROM (coalesce(c.decided_at, c.created_at) AT TIME ZONE 'Europe/Kyiv'))::integer AS y,
         row_number() OVER (
           PARTITION BY c.org_id, extract(year FROM (coalesce(c.decided_at, c.created_at) AT TIME ZONE 'Europe/Kyiv'))
           ORDER BY coalesce(c.decided_at, c.created_at), c.created_at, c.id
         )::integer AS n
  FROM public.calculations AS c
  WHERE c.status IN ('accepted', 'done') AND c.registry_no IS NULL
)
UPDATE public.calculations AS c
SET registry_no = r.y::text || '-' || CASE WHEN r.n > 9999 THEN r.n::text ELSE lpad(r.n::text, 4, '0') END
FROM ranked AS r
WHERE c.id = r.id;

ALTER TABLE public.calculations ENABLE TRIGGER trg_calculations_fill_history;

INSERT INTO public.calc_registry_counters (org_id, year, last_no)
SELECT c.org_id, substr(c.registry_no, 1, 4)::integer, max(substr(c.registry_no, 6)::integer)
FROM public.calculations AS c
WHERE c.registry_no IS NOT NULL
GROUP BY c.org_id, substr(c.registry_no, 1, 4)::integer
ON CONFLICT (org_id, year) DO UPDATE SET last_no = greatest(public.calc_registry_counters.last_no, excluded.last_no);

-- ---------------------------------------------------------------------------
-- 7. Сповіщення автору заявки
-- ---------------------------------------------------------------------------

ALTER TABLE public.org_notifications
  ADD COLUMN IF NOT EXISTS recipient_id uuid REFERENCES auth.users (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS org_notifications_recipient_idx
  ON public.org_notifications (recipient_id, created_at DESC) WHERE recipient_id IS NOT NULL;

ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_kind_check;
ALTER TABLE public.org_notifications
  ADD CONSTRAINT org_notifications_kind_check
  CHECK (kind IN ('approval_pending', 'signature_used', 'doc_emailed', 'approval_decided'));

-- Адресат (автор заявки) бачить свої. Сповіщення без адресата бачить owner, директор з org_directors (control_plus) і —
-- лише approval_pending — логіст з правом accept у режимі logist_can_accept.
DROP POLICY IF EXISTS org_notifications_select ON public.org_notifications;
CREATE POLICY org_notifications_select ON public.org_notifications
  FOR SELECT TO authenticated
  USING (
    recipient_id = auth.uid()
    OR (
      recipient_id IS NULL
      AND (
        (org_id = public.current_org_id() AND public.is_org_owner())
        OR public.kp_is_org_director(org_id)
        OR (kind = 'approval_pending' AND public.calc_logist_accepts(org_id))
      )
    )
  );

CREATE OR REPLACE FUNCTION public.calculations_notify_decided()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_decider uuid;
BEGIN
  v_decider := CASE NEW.status WHEN 'cancelled' THEN NEW.cancelled_by ELSE NEW.decided_by END;
  IF NEW.user_id IS NULL OR v_decider IS NOT DISTINCT FROM NEW.user_id THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.org_notifications (org_id, kind, ref_kind, ref_id, actor_id, recipient_id, meta)
  VALUES (
    NEW.org_id, 'approval_decided', 'calculation', NEW.id, v_decider, NEW.user_id,
    jsonb_build_object(
      'name', left(coalesce(NEW.name, ''), 200),
      'decision', NEW.status,
      'reason', CASE NEW.status WHEN 'cancelled' THEN left(coalesce(NEW.cancel_reason, ''), 500)
                                WHEN 'rejected' THEN left(coalesce(NEW.reject_reason, ''), 500) ELSE '' END,
      'registry_no', coalesce(NEW.registry_no, '')
    )
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_notify_decided() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_calculations_notify_decided ON public.calculations;
CREATE TRIGGER trg_calculations_notify_decided
  AFTER UPDATE OF status ON public.calculations
  FOR EACH ROW
  WHEN (NEW.status IN ('accepted', 'rejected', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.calculations_notify_decided();

-- ---------------------------------------------------------------------------
-- 8. RPC реєстру (SECURITY INVOKER: видимість задає RLS, чужа організація порожня)
-- ---------------------------------------------------------------------------

-- Фільтри (jsonb): from, to (дата рейсу; без неї — дата рішення / створення), user_id (логіст), vehicle, client (uuid),
-- status (accepted | done | cancelled, рядок або масив; без фільтра — усі три).
CREATE OR REPLACE FUNCTION public.registry_list(p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, registry_no text, status text, user_id uuid, name text, client_name text, trip_date date,
  route_from text, route_to text, distance_km numeric, revenue numeric, profit numeric,
  fact_revenue numeric, fact_profit numeric, decided_at timestamptz, cancelled_at timestamptz, cancel_reason text,
  created_at timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date;
  v_to date;
  v_user uuid;
  v_vehicle uuid;
  v_client uuid;
  v_statuses text[];
BEGIN
  IF jsonb_typeof(f) <> 'object' THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_from := nullif(f ->> 'from', '')::date;
    v_to := nullif(f ->> 'to', '')::date;
    v_user := nullif(f ->> 'user_id', '')::uuid;
    v_vehicle := nullif(f ->> 'vehicle', '')::uuid;
    v_client := nullif(f ->> 'client', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END;
  IF f ? 'status' AND jsonb_typeof(f -> 'status') = 'array' THEN
    SELECT array_agg(x) INTO v_statuses FROM jsonb_array_elements_text(f -> 'status') AS x;
  ELSIF f ? 'status' AND jsonb_typeof(f -> 'status') = 'string' THEN
    v_statuses := ARRAY[f ->> 'status'];
  END IF;
  v_statuses := coalesce(v_statuses, ARRAY['accepted', 'done', 'cancelled']);
  IF NOT (v_statuses <@ ARRAY['accepted', 'done', 'cancelled']) THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT c.id, c.registry_no, c.status, c.user_id, c.name, c.client_name, c.trip_date,
         c.route_from, c.route_to, c.distance_km, c.revenue, c.profit,
         ta.revenue, ta.profit, c.decided_at, c.cancelled_at, c.cancel_reason,
         c.created_at, count(*) OVER ()
  FROM public.calculations AS c
  LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
  WHERE c.org_id = public.current_org_id()
    AND c.status = ANY (v_statuses)
    AND (v_from IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) >= v_from)
    AND (v_to IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) <= v_to)
    AND (v_user IS NULL OR c.user_id = v_user)
    AND (v_vehicle IS NULL OR EXISTS (SELECT 1 FROM public.calc_vehicles AS cv WHERE cv.calc_id = c.id AND cv.vehicle_id = v_vehicle))
    AND (v_client IS NULL OR EXISTS (SELECT 1 FROM public.calculation_clients AS cc WHERE cc.calculation_id = c.id AND cc.client_id = v_client))
  ORDER BY c.registry_no DESC NULLS LAST, c.created_at DESC, c.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

-- Ті самі фільтри. Підсумки: кількість (разом зі скасованими; cancelled_count окремо), виручка (план), прибуток план,
-- прибуток факт (trip_actuals), км — суми БЕЗ скасованих заявок.
CREATE OR REPLACE FUNCTION public.registry_totals(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
  total_count bigint, cancelled_count bigint, revenue numeric, profit_plan numeric, profit_fact numeric, distance_km numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date;
  v_to date;
  v_user uuid;
  v_vehicle uuid;
  v_client uuid;
  v_statuses text[];
BEGIN
  IF jsonb_typeof(f) <> 'object' THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_from := nullif(f ->> 'from', '')::date;
    v_to := nullif(f ->> 'to', '')::date;
    v_user := nullif(f ->> 'user_id', '')::uuid;
    v_vehicle := nullif(f ->> 'vehicle', '')::uuid;
    v_client := nullif(f ->> 'client', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END;
  IF f ? 'status' AND jsonb_typeof(f -> 'status') = 'array' THEN
    SELECT array_agg(x) INTO v_statuses FROM jsonb_array_elements_text(f -> 'status') AS x;
  ELSIF f ? 'status' AND jsonb_typeof(f -> 'status') = 'string' THEN
    v_statuses := ARRAY[f ->> 'status'];
  END IF;
  v_statuses := coalesce(v_statuses, ARRAY['accepted', 'done', 'cancelled']);
  IF NOT (v_statuses <@ ARRAY['accepted', 'done', 'cancelled']) THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT count(*)::bigint,
         (count(*) FILTER (WHERE c.status = 'cancelled'))::bigint,
         coalesce(sum(c.revenue) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(c.profit) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(ta.profit) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(c.distance_km) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric
  FROM public.calculations AS c
  LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
  WHERE c.org_id = public.current_org_id()
    AND c.status = ANY (v_statuses)
    AND (v_from IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) >= v_from)
    AND (v_to IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) <= v_to)
    AND (v_user IS NULL OR c.user_id = v_user)
    AND (v_vehicle IS NULL OR EXISTS (SELECT 1 FROM public.calc_vehicles AS cv WHERE cv.calc_id = c.id AND cv.vehicle_id = v_vehicle))
    AND (v_client IS NULL OR EXISTS (SELECT 1 FROM public.calculation_clients AS cc WHERE cc.calculation_id = c.id AND cc.client_id = v_client));
END;
$$;

REVOKE ALL ON FUNCTION public.registry_list(jsonb, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.registry_totals(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registry_list(jsonb, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.registry_totals(jsonb) TO authenticated, service_role;

COMMIT;
