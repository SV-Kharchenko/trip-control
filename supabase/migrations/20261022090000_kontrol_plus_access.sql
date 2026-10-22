-- Контроль+ (Етап 1): тарифний план організації, хелпери доступу, роль «директор» (лише читання).
--
-- * organizations.plan: 'company' (тариф «Компанія», як зараз) | 'control_plus'. Окремого поля рівня тарифу досі не
--   було: org_subscriptions.last_plan — це період оплати (month / year), не тариф. Змінює plan лише service_role
--   (або адмін напряму в SQL Editor); клієнтські ролі (anon / authenticated) — ні, навіть власник, який має UPDATE
--   на свою організацію. Вмикає Контроль+ на Етапі 1 адмін: public.set_org_plan(org, 'control_plus') від service_role.
-- * public.org_has_plan(org, plan), public.current_org_is_control_plus() — перевірка на сервері (RLS / функції).
-- * public.org_directors(org_id, user_id): директор — окрема таблиця, бо profiles.org_role має CHECK (owner, logist),
--   який не змінюємо. Директор не займає місце логіста (ліміт 1 owner + 3 logist не чіпаємо); директорів ≤ 2 на
--   організацію, і директор не може бути активним учасником тієї самої організації (guard-тригер). Додає / прибирає
--   директорів на Етапі 1 лише service_role.
-- * public.kp_org_id() / kp_role() / kp_context(): з якою організацією і в якій ролі користувач працює в Контроль+.
--
-- Лише адитивно: нова колонка з DEFAULT, нова таблиця, нові функції, новий тригер; існуючі колонки, політики, тригери
-- і функції не змінюються. Ідемпотентно. Не застосовується до прод-БД цим PR.

-- ---------------------------------------------------------------------------
-- organizations.plan
-- ---------------------------------------------------------------------------

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'company';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_plan_check' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_plan_check CHECK (plan IN ('company', 'control_plus'));
  END IF;
END;
$$;

-- Клієнтські ролі API (PostgREST робить SET ROLE anon / authenticated) не змінюють план; service_role і пряме
-- підключення до БД (SQL Editor) — можуть. Нова організація від клієнта завжди починає з 'company'.
CREATE OR REPLACE FUNCTION public.kp_guard_org_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client boolean := coalesce(current_setting('role', true), 'none') IN ('anon', 'authenticated')
    AND NOT public.is_service_role();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_client THEN
      NEW.plan := 'company';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan AND v_client THEN
    RAISE EXCEPTION 'PLAN_SERVICE_ROLE_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_guard_org_plan() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_guard_org_plan ON public.organizations;
CREATE TRIGGER trg_kp_guard_org_plan
  BEFORE INSERT OR UPDATE OF plan ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.kp_guard_org_plan();

-- Увімкнути / вимкнути Контроль+ (адмін, service_role).
CREATE OR REPLACE FUNCTION public.set_org_plan(p_org uuid, p_plan text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_service_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('company', 'control_plus') THEN
    RAISE EXCEPTION 'BAD_PLAN' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.organizations SET plan = p_plan WHERE id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN p_plan;
END;
$$;

REVOKE ALL ON FUNCTION public.set_org_plan(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_org_plan(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Plan helpers
-- ---------------------------------------------------------------------------

-- Заблокована організація плану не має.
CREATE OR REPLACE FUNCTION public.org_has_plan(p_org uuid, p_plan text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations AS o
    WHERE o.id = p_org AND o.plan = p_plan AND o.status <> 'blocked'
  );
$$;

-- Будь-яка org за uuid — лише сервер; клієнти питають про свою через current_org_is_control_plus().
REVOKE ALL ON FUNCTION public.org_has_plan(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_plan(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.current_org_is_control_plus()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.org_has_plan(public.current_org_id(), 'control_plus'), false);
$$;

REVOKE ALL ON FUNCTION public.current_org_is_control_plus() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_org_is_control_plus() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Directors (read-only role)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_directors (
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_directors_user_idx ON public.org_directors (user_id);

CREATE OR REPLACE FUNCTION public.kp_guard_org_directors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_service_role() AND coalesce(current_setting('role', true), 'none') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'DIRECTORS_SERVICE_ROLE_ONLY' USING ERRCODE = '42501';
  END IF;

  -- Ліміт рахуємо під блокуванням організації (як ліміт логістів).
  PERFORM 1 FROM public.organizations WHERE id = NEW.org_id FOR UPDATE;

  SELECT count(*)::integer INTO v_count
  FROM public.org_directors AS d
  WHERE d.org_id = NEW.org_id
    AND d.user_id IS DISTINCT FROM NEW.user_id;
  IF v_count >= 2 THEN
    RAISE EXCEPTION 'DIRECTOR_LIMIT'
      USING ERRCODE = 'P0001', DETAIL = 'An organization can have at most 2 directors';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id AND p.member_status = 'active'
  ) THEN
    RAISE EXCEPTION 'DIRECTOR_IS_MEMBER'
      USING ERRCODE = 'P0001', DETAIL = 'An active owner / logist of the organization cannot also be its director';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_guard_org_directors() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_guard_org_directors ON public.org_directors;
CREATE TRIGGER trg_kp_guard_org_directors
  BEFORE INSERT OR UPDATE ON public.org_directors
  FOR EACH ROW EXECUTE FUNCTION public.kp_guard_org_directors();

ALTER TABLE public.org_directors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_directors FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.org_directors TO authenticated;
GRANT ALL ON public.org_directors TO service_role;

-- Бачать: власник організації і сам директор. Писати — лише service_role (політик на запис для клієнтів немає).
DROP POLICY IF EXISTS org_directors_select ON public.org_directors;
CREATE POLICY org_directors_select ON public.org_directors
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (org_id = public.current_org_id() AND public.is_org_owner())
  );

-- ---------------------------------------------------------------------------
-- Context: which organization and role in Контроль+
-- ---------------------------------------------------------------------------

-- Організація для Контроль+: своя (owner / logist), якщо вона на control_plus; інакше — та, де користувач директор
-- (control_plus, не заблокована). NULL — доступу немає.
CREATE OR REPLACE FUNCTION public.kp_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    CASE WHEN public.org_has_plan(public.current_org_id(), 'control_plus') THEN public.current_org_id() END,
    (
      SELECT d.org_id
      FROM public.org_directors AS d
      WHERE d.user_id = auth.uid()
        AND public.org_has_plan(d.org_id, 'control_plus')
      ORDER BY d.created_at, d.org_id
      LIMIT 1
    )
  );
$$;

-- 'owner' | 'logist' | 'director' | NULL.
CREATE OR REPLACE FUNCTION public.kp_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.kp_org_id() IS NULL THEN NULL
    WHEN public.kp_org_id() = public.current_org_id() THEN (
      SELECT p.org_role FROM public.profiles AS p
      WHERE p.id = auth.uid() AND p.member_status = 'active'
      LIMIT 1
    )
    ELSE 'director'
  END;
$$;

-- Пише лише owner / logist своєї організації на control_plus і не заблокований користувач.
CREATE OR REPLACE FUNCTION public.kp_can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_org_is_control_plus()
    AND public.kp_org_id() = public.current_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'logist'), false)
    AND NOT public.is_user_blocked();
$$;

-- Для екрана входу в додатку: план, роль, назва організації.
CREATE OR REPLACE FUNCTION public.kp_context()
RETURNS TABLE (org_id uuid, org_name text, role text, control_plus boolean, own_org_plan text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.kp_org_id(),
    (SELECT o.name FROM public.organizations AS o WHERE o.id = public.kp_org_id()),
    public.kp_role(),
    public.kp_org_id() IS NOT NULL,
    (SELECT o.plan FROM public.organizations AS o WHERE o.id = public.current_org_id());
$$;

REVOKE ALL ON FUNCTION public.kp_org_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_can_write() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_can_write() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_context() TO authenticated, service_role;
