-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: модуль «Власний парк», етап 1 (прапорець, підрозділи, точки, роль «Замовник підрозділу», внутрішні заявки).
--
-- * organizations.features jsonb: own_fleet = features->>'own_fleet' = 'true'. Вмикається лише вручну (SQL / service_role);
--   власник організації змінити features не може (тригер нижче). org_has_feature(org, key) — SECURITY DEFINER, STABLE.
-- * Доступ до модуля: own_fleet_org_id() / own_fleet_role() / own_fleet_can_manage() / own_fleet_unit_ids() / own_fleet_context().
--   Персонал (owner, logist, director з org_directors) — лише якщо організація на control_plus І має прапорець; requester —
--   через org_requesters. Без прапорця всі ці функції порожні, тож RLS віддає 0 рядків усім, навіть власнику.
-- * Роль requester («Замовник підрозділу») — окрема таблиця членства org_requesters (як repair_manager у 3a), бо
--   profiles.org_role має CHECK (owner, logist) і спільний із сайтом. Тому ліміт «1 директор + 3 логісти» на неї не діє: свій
--   ліміт 30 (разом із відкритими запрошеннями). У організації без own_fleet роль призначити не можна (тригер).
--   requester не є учасником kp_org_id(): розділи Контроль+ (клієнти, документи, авто, водії, налаштування, команда) йому закриті.
-- * org_units / org_points: CRUD для owner / director / logist через RLS; requester бачить лише свої підрозділи
--   (org_unit_members) і спільні точки (без підрозділу) та точки своїх підрозділів.
-- * fleet_requests (+ fleet_request_log): без прямого запису з клієнта; усе — функціями fleet_request_*.
--   Статуси: new → accepted → assigned → in_progress → done; cancelled з будь-якого до done (причина обовʼязкова).
--   Номери авто / причепа / ПІБ водія знімаються в заявку при призначенні (vehicle_label, trailer_label, driver_name): requester
--   довідників авто й водіїв не читає.
--
-- Лише адитивно: нові таблиці, функції, тригери й політики. Наявні таблиці, функції й політики не змінюються
-- (на organizations додається колонка і один новий тригер). Ідемпотентно.

-- ---------------------------------------------------------------------------
-- Прапорець
-- ---------------------------------------------------------------------------

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.org_has_feature(p_org uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT o.features ->> p_key = 'true' FROM public.organizations AS o WHERE o.id = p_org), false);
$$;

REVOKE ALL ON FUNCTION public.org_has_feature(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_feature(uuid, text) TO service_role;

-- features змінює лише service_role / суперадмін / SQL без користувацького JWT (редактор SQL): власник організації не вмикає модуль сам.
CREATE OR REPLACE FUNCTION public.protect_org_features()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.features IS DISTINCT FROM OLD.features
     AND auth.uid() IS NOT NULL AND NOT public.is_service_role() AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'organizations: features are server-managed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_org_features() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_protect_org_features ON public.organizations;
CREATE TRIGGER trg_protect_org_features
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.protect_org_features();

-- ---------------------------------------------------------------------------
-- Підрозділи й точки
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  kind text NOT NULL DEFAULT 'agro' CHECK (kind IN ('agro', 'elevator', 'livestock', 'warehouse', 'other')),
  responsible_user_id uuid NULL REFERENCES auth.users (id) ON DELETE SET NULL,
  cost_center text NULL CHECK (cost_center IS NULL OR char_length(btrim(cost_center)) BETWEEN 1 AND 60),
  archived boolean NOT NULL DEFAULT false,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_units_name_uq ON public.org_units (org_id, lower(btrim(name))) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS public.org_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  unit_id uuid NULL REFERENCES public.org_units (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  kind text NOT NULL DEFAULT 'field' CHECK (kind IN ('field', 'elevator', 'warehouse', 'farm', 'other')),
  lat numeric(9, 6) NULL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng numeric(9, 6) NULL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  crop text NULL CHECK (crop IS NULL OR char_length(btrim(crop)) BETWEEN 1 AND 80),
  area_ha numeric(10, 2) NULL CHECK (area_ha IS NULL OR (area_ha >= 0 AND area_ha <= 1000000)),
  archived boolean NOT NULL DEFAULT false,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_points_latlng_check CHECK ((lat IS NULL) = (lng IS NULL))
);

CREATE INDEX IF NOT EXISTS org_points_org_idx ON public.org_points (org_id, archived, lower(name));
CREATE INDEX IF NOT EXISTS org_points_unit_idx ON public.org_points (unit_id);

-- ---------------------------------------------------------------------------
-- Замовники підрозділів (requester) і їхні запрошення
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_requesters (
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_requesters_user_idx ON public.org_requesters (user_id);

CREATE TABLE IF NOT EXISTS public.org_unit_members (
  unit_id uuid NOT NULL REFERENCES public.org_units (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES public.org_requesters (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS org_unit_members_user_idx ON public.org_unit_members (user_id, org_id);

CREATE TABLE IF NOT EXISTS public.requester_invites (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  token_hash text NOT NULL,
  unit_ids uuid[] NOT NULL DEFAULT '{}',
  invited_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz NULL,
  accepted_by uuid NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT requester_invites_token_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS requester_invites_org_idx ON public.requester_invites (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Доступ
-- ---------------------------------------------------------------------------

-- Організація й роль конкретного користувача. Персонал: власна організація (owner / logist), інакше організація, де користувач
-- директор; потім requester. Усі — лише на control_plus із прапорцем own_fleet.
CREATE OR REPLACE FUNCTION public.own_fleet_access_for(p_user uuid)
RETURNS TABLE (org_id uuid, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.org_id, a.role
  FROM (
    SELECT p.org_id, p.org_role AS role, 1 AS ord
    FROM public.profiles AS p
    WHERE p.id = p_user AND p.member_status = 'active' AND p.org_id IS NOT NULL
    UNION ALL
    SELECT d.org_id, 'director', 2 FROM public.org_directors AS d WHERE d.user_id = p_user
    UNION ALL
    SELECT r.org_id, 'requester', 3 FROM public.org_requesters AS r WHERE r.user_id = p_user
  ) AS a
  WHERE public.org_has_plan(a.org_id, 'control_plus') AND public.org_has_feature(a.org_id, 'own_fleet')
  ORDER BY a.ord, a.org_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_access_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.own_fleet_access_for(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.own_fleet_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.is_user_blocked() THEN NULL ELSE (SELECT a.org_id FROM public.own_fleet_access_for(auth.uid()) AS a) END;
$$;

-- 'owner' | 'director' | 'logist' | 'requester' | NULL.
CREATE OR REPLACE FUNCTION public.own_fleet_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.is_user_blocked() THEN NULL ELSE (SELECT a.role FROM public.own_fleet_access_for(auth.uid()) AS a) END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.own_fleet_role() IN ('owner', 'director', 'logist'), false);
$$;

-- Підрозділи requester-а (для staff порожньо: вони бачать усі).
CREATE OR REPLACE FUNCTION public.own_fleet_unit_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.unit_id FROM public.org_unit_members AS m
  WHERE m.user_id = auth.uid() AND m.org_id = public.own_fleet_org_id() AND public.own_fleet_role() = 'requester';
$$;

-- Для фронтенду: порожньо, якщо модуль вимкнено або доступу немає.
CREATE OR REPLACE FUNCTION public.own_fleet_context()
RETURNS TABLE (org_id uuid, role text, unit_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.own_fleet_org_id(), public.own_fleet_role(), ARRAY(SELECT public.own_fleet_unit_ids())
  WHERE public.own_fleet_org_id() IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_org_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.own_fleet_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.own_fleet_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.own_fleet_unit_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.own_fleet_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.own_fleet_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_can_manage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_unit_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_context() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Тригери цілісності
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.own_fleet_guard_unit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'OWN_FLEET_ORG_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  ELSE
    NEW.created_by := coalesce(auth.uid(), NEW.created_by);
  END IF;
  NEW.updated_at := now();
  IF NEW.responsible_user_id IS NOT NULL AND NOT (
    EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = NEW.responsible_user_id AND p.org_id = NEW.org_id AND p.member_status = 'active')
    OR EXISTS (SELECT 1 FROM public.org_directors AS d WHERE d.user_id = NEW.responsible_user_id AND d.org_id = NEW.org_id)
    OR EXISTS (SELECT 1 FROM public.org_requesters AS r WHERE r.user_id = NEW.responsible_user_id AND r.org_id = NEW.org_id)
  ) THEN
    RAISE EXCEPTION 'OWN_FLEET_RESPONSIBLE_NOT_MEMBER' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_guard_point()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'OWN_FLEET_ORG_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  ELSE
    NEW.created_by := coalesce(auth.uid(), NEW.created_by);
  END IF;
  NEW.updated_at := now();
  IF NEW.unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.org_units AS u WHERE u.id = NEW.unit_id AND u.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'OWN_FLEET_UNIT_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Requester: лише в організації з own_fleet; ліміт 30 (з відкритими запрошеннями); не учасник і не директор цієї організації.
CREATE OR REPLACE FUNCTION public.own_fleet_requester_seats(p_org uuid, p_except_user uuid, p_except_invite uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (SELECT count(*) FROM public.org_requesters AS r WHERE r.org_id = p_org AND r.user_id IS DISTINCT FROM p_except_user)::integer
       + (SELECT count(*) FROM public.requester_invites AS i
          WHERE i.org_id = p_org AND i.id IS DISTINCT FROM p_except_invite AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > now())::integer;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_requester_seats(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.own_fleet_guard_requester()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = NEW.org_id FOR UPDATE;
  IF NOT public.org_has_feature(NEW.org_id, 'own_fleet') THEN
    RAISE EXCEPTION 'REQUESTER_REQUIRES_OWN_FLEET' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.org_has_plan(NEW.org_id, 'control_plus') THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id AND p.member_status = 'active')
     OR EXISTS (SELECT 1 FROM public.org_directors AS d WHERE d.org_id = NEW.org_id AND d.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'REQUESTER_IS_MEMBER' USING ERRCODE = 'P0001';
  END IF;
  IF public.own_fleet_requester_seats(NEW.org_id, NEW.user_id, NULL) >= 30 THEN
    RAISE EXCEPTION 'REQUESTER_LIMIT' USING ERRCODE = 'P0001', DETAIL = 'At most 30 requesters (incl. pending invites) per organization';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_guard_unit_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.org_units AS u WHERE u.id = NEW.unit_id AND u.org_id = NEW.org_id AND NOT u.archived) THEN
    RAISE EXCEPTION 'OWN_FLEET_UNIT_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_guard_unit() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.own_fleet_guard_point() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.own_fleet_guard_requester() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.own_fleet_guard_unit_member() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_own_fleet_guard_unit ON public.org_units;
CREATE TRIGGER trg_own_fleet_guard_unit BEFORE INSERT OR UPDATE ON public.org_units
  FOR EACH ROW EXECUTE FUNCTION public.own_fleet_guard_unit();
DROP TRIGGER IF EXISTS trg_own_fleet_guard_point ON public.org_points;
CREATE TRIGGER trg_own_fleet_guard_point BEFORE INSERT OR UPDATE ON public.org_points
  FOR EACH ROW EXECUTE FUNCTION public.own_fleet_guard_point();
DROP TRIGGER IF EXISTS trg_own_fleet_guard_requester ON public.org_requesters;
CREATE TRIGGER trg_own_fleet_guard_requester BEFORE INSERT ON public.org_requesters
  FOR EACH ROW EXECUTE FUNCTION public.own_fleet_guard_requester();
DROP TRIGGER IF EXISTS trg_own_fleet_guard_unit_member ON public.org_unit_members;
CREATE TRIGGER trg_own_fleet_guard_unit_member BEFORE INSERT ON public.org_unit_members
  FOR EACH ROW EXECUTE FUNCTION public.own_fleet_guard_unit_member();

-- ---------------------------------------------------------------------------
-- Заявки
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.fleet_request_counters (
  org_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  next_no integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.fleet_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  number integer NOT NULL,
  unit_id uuid NOT NULL REFERENCES public.org_units (id) ON DELETE RESTRICT,
  created_by uuid NULL,
  cargo text NOT NULL CHECK (char_length(btrim(cargo)) BETWEEN 1 AND 200 AND cargo !~ '[[:cntrl:]]'),
  qty_t numeric(10, 3) NULL CHECK (qty_t IS NULL OR (qty_t > 0 AND qty_t <= 100000)),
  from_point_id uuid NULL REFERENCES public.org_points (id) ON DELETE RESTRICT,
  to_point_id uuid NULL REFERENCES public.org_points (id) ON DELETE RESTRICT,
  from_text text NULL CHECK (from_text IS NULL OR char_length(btrim(from_text)) BETWEEN 1 AND 200),
  to_text text NULL CHECK (to_text IS NULL OR char_length(btrim(to_text)) BETWEEN 1 AND 200),
  wanted_at timestamptz NOT NULL,
  duration_h numeric(5, 1) NOT NULL DEFAULT 8 CHECK (duration_h > 0 AND duration_h <= 240),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 1000),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'assigned', 'in_progress', 'done', 'cancelled')),
  -- Без FK на довідники авто / причепів / водіїв: їхні міграції мають власні відкати, а історія заявки тримається на знімку (*_label, driver_name).
  vehicle_id uuid NULL,
  trailer_id uuid NULL,
  driver_id uuid NULL,
  vehicle_label text NULL,
  trailer_label text NULL,
  driver_name text NULL,
  trip_id uuid NULL,
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  accepted_at timestamptz NULL,
  assigned_at timestamptz NULL,
  started_at timestamptz NULL,
  done_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fleet_requests_number_uq UNIQUE (org_id, number),
  CONSTRAINT fleet_requests_cancel_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS fleet_requests_board_idx ON public.fleet_requests (org_id, status, wanted_at);
CREATE INDEX IF NOT EXISTS fleet_requests_unit_idx ON public.fleet_requests (unit_id, status);
CREATE INDEX IF NOT EXISTS fleet_requests_vehicle_idx ON public.fleet_requests (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_requests_driver_idx ON public.fleet_requests (driver_id) WHERE driver_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fleet_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.fleet_requests (id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  actor_id uuid NULL,
  from_status text NULL,
  to_status text NOT NULL,
  note text NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_request_log_request_idx ON public.fleet_request_log (request_id, at);

-- ---------------------------------------------------------------------------
-- RLS і гранти
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_units', 'org_points', 'org_requesters', 'org_unit_members', 'requester_invites',
                           'fleet_request_counters', 'fleet_requests', 'fleet_request_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_units, public.org_points TO authenticated;
GRANT SELECT ON public.org_requesters, public.org_unit_members, public.fleet_requests, public.fleet_request_log TO authenticated;
GRANT SELECT (id, org_id, email, unit_ids, invited_by, created_at, last_sent_at, expires_at, accepted_at, accepted_by, revoked_at)
  ON public.requester_invites TO authenticated;

-- Підрозділи: персонал — усі; requester — свої.
DROP POLICY IF EXISTS org_units_select ON public.org_units;
CREATE POLICY org_units_select ON public.org_units FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id()
         AND (public.own_fleet_can_manage() OR id IN (SELECT public.own_fleet_unit_ids())));
DROP POLICY IF EXISTS org_units_insert ON public.org_units;
CREATE POLICY org_units_insert ON public.org_units FOR INSERT TO authenticated
  WITH CHECK (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());
DROP POLICY IF EXISTS org_units_update ON public.org_units;
CREATE POLICY org_units_update ON public.org_units FOR UPDATE TO authenticated
  USING (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage())
  WITH CHECK (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());
DROP POLICY IF EXISTS org_units_delete ON public.org_units;
CREATE POLICY org_units_delete ON public.org_units FOR DELETE TO authenticated
  USING (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());

-- Точки: персонал — усі; requester — спільні (без підрозділу) і своїх підрозділів.
DROP POLICY IF EXISTS org_points_select ON public.org_points;
CREATE POLICY org_points_select ON public.org_points FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id()
         AND (public.own_fleet_can_manage() OR unit_id IS NULL OR unit_id IN (SELECT public.own_fleet_unit_ids())));
DROP POLICY IF EXISTS org_points_insert ON public.org_points;
CREATE POLICY org_points_insert ON public.org_points FOR INSERT TO authenticated
  WITH CHECK (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());
DROP POLICY IF EXISTS org_points_update ON public.org_points;
CREATE POLICY org_points_update ON public.org_points FOR UPDATE TO authenticated
  USING (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage())
  WITH CHECK (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());
DROP POLICY IF EXISTS org_points_delete ON public.org_points;
CREATE POLICY org_points_delete ON public.org_points FOR DELETE TO authenticated
  USING (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());

-- Замовники: персонал бачить усіх, requester — себе. Запис — лише функціями.
DROP POLICY IF EXISTS org_requesters_select ON public.org_requesters;
CREATE POLICY org_requesters_select ON public.org_requesters FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id() AND (public.own_fleet_can_manage() OR user_id = auth.uid()));
DROP POLICY IF EXISTS org_unit_members_select ON public.org_unit_members;
CREATE POLICY org_unit_members_select ON public.org_unit_members FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id() AND (public.own_fleet_can_manage() OR user_id = auth.uid()));
DROP POLICY IF EXISTS requester_invites_select ON public.requester_invites;
CREATE POLICY requester_invites_select ON public.requester_invites FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage());

-- Заявки: персонал — усі; requester — лише свого підрозділу.
DROP POLICY IF EXISTS fleet_requests_select ON public.fleet_requests;
CREATE POLICY fleet_requests_select ON public.fleet_requests FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id()
         AND (public.own_fleet_can_manage() OR unit_id IN (SELECT public.own_fleet_unit_ids())));
DROP POLICY IF EXISTS fleet_request_log_select ON public.fleet_request_log;
CREATE POLICY fleet_request_log_select ON public.fleet_request_log FOR SELECT TO authenticated
  USING (org_id = public.own_fleet_org_id()
         AND EXISTS (SELECT 1 FROM public.fleet_requests AS r WHERE r.id = request_id));

-- ---------------------------------------------------------------------------
-- Керування замовниками (персонал) і запрошення (service_role з API)
-- ---------------------------------------------------------------------------

-- Підрозділи замовника: повний список (порожній — без підрозділів, тоді заявок він не бачить і не створює).
CREATE OR REPLACE FUNCTION public.own_fleet_requester_set_units(p_user uuid, p_unit_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
BEGIN
  IF v_org IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_requesters AS r WHERE r.org_id = v_org AND r.user_id = p_user) THEN
    RAISE EXCEPTION 'REQUESTER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.org_unit_members WHERE org_id = v_org AND user_id = p_user AND unit_id <> ALL (coalesce(p_unit_ids, '{}'));
  INSERT INTO public.org_unit_members (unit_id, user_id, org_id)
  SELECT DISTINCT u, p_user, v_org FROM unnest(coalesce(p_unit_ids, '{}')) AS u
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_requester_remove(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
BEGIN
  IF v_org IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.org_requesters WHERE org_id = v_org AND user_id = p_user;
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_requester_set_units(uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.own_fleet_requester_remove(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.own_fleet_requester_set_units(uuid, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_requester_remove(uuid) TO authenticated, service_role;

-- Запрошення резервує API (service_role, особу перевіряє p_invited_by через own_fleet_access_for).
CREATE OR REPLACE FUNCTION public.own_fleet_invite_reserve(
  p_org uuid, p_invite uuid, p_email text, p_token_hash text, p_invited_by uuid, p_expires_at timestamptz, p_unit_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_access record;
  v_email text := lower(btrim(p_email));
BEGIN
  SELECT * INTO v_access FROM public.own_fleet_access_for(p_invited_by);
  IF v_access.org_id IS DISTINCT FROM p_org OR v_access.role NOT IN ('owner', 'director', 'logist') THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR UPDATE;
  IF coalesce(cardinality(p_unit_ids), 0) = 0 OR EXISTS (
    SELECT 1 FROM unnest(p_unit_ids) AS u WHERE NOT EXISTS (SELECT 1 FROM public.org_units AS x WHERE x.id = u AND x.org_id = p_org AND NOT x.archived)
  ) THEN
    RAISE EXCEPTION 'OWN_FLEET_UNIT_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF public.own_fleet_requester_seats(p_org, NULL, p_invite) >= 30 THEN
    RAISE EXCEPTION 'REQUESTER_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.requester_invites (id, org_id, email, token_hash, unit_ids, invited_by, expires_at)
  VALUES (p_invite, p_org, v_email, p_token_hash, p_unit_ids, p_invited_by, p_expires_at)
  ON CONFLICT (id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, unit_ids = EXCLUDED.unit_ids, last_sent_at = now()
    WHERE public.requester_invites.org_id = p_org AND public.requester_invites.accepted_at IS NULL;
  RETURN p_invite;
END;
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_invite_revoke(p_org uuid, p_invite uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    UPDATE public.requester_invites SET revoked_at = now()
    WHERE id = p_invite AND org_id = p_org AND accepted_at IS NULL AND revoked_at IS NULL RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM r);
$$;

CREATE OR REPLACE FUNCTION public.own_fleet_invite_accept(p_token_hash text, p_user uuid, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.requester_invites%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.requester_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_inv.revoked_at IS NOT NULL OR v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'REQUESTER_INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'REQUESTER_INVITE_USED' USING ERRCODE = 'P0001';
  END IF;
  IF lower(btrim(p_email)) <> v_inv.email THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = '42501';
  END IF;
  -- Місце запрошення звільняється, щоб ліміт не рахував його двічі.
  UPDATE public.requester_invites SET accepted_at = now(), accepted_by = p_user WHERE id = v_inv.id;
  INSERT INTO public.org_requesters (org_id, user_id, created_by) VALUES (v_inv.org_id, p_user, v_inv.invited_by)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.org_unit_members (unit_id, user_id, org_id)
  SELECT u, p_user, v_inv.org_id FROM unnest(v_inv.unit_ids) AS u
  WHERE EXISTS (SELECT 1 FROM public.org_units AS x WHERE x.id = u AND x.org_id = v_inv.org_id AND NOT x.archived)
  ON CONFLICT DO NOTHING;
  RETURN v_inv.org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.own_fleet_invite_reserve(uuid, uuid, text, text, uuid, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.own_fleet_invite_revoke(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.own_fleet_invite_accept(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.own_fleet_invite_reserve(uuid, uuid, text, text, uuid, timestamptz, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_invite_revoke(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.own_fleet_invite_accept(text, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Заявки: створення, переходи, призначення
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fleet_request_log_add(p_req public.fleet_requests, p_from text, p_note text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.fleet_request_log (request_id, org_id, actor_id, from_status, to_status, note)
  VALUES (p_req.id, p_req.org_id, auth.uid(), p_from, p_req.status, p_note);
$$;

REVOKE ALL ON FUNCTION public.fleet_request_log_add(public.fleet_requests, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fleet_request_create(
  p_unit uuid, p_cargo text, p_qty_t numeric, p_from_point uuid, p_to_point uuid, p_from_text text, p_to_text text,
  p_wanted_at timestamptz, p_priority text DEFAULT 'normal', p_note text DEFAULT NULL, p_duration_h numeric DEFAULT 8)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
  v_role text := public.own_fleet_role();
  v_no integer;
  v_row public.fleet_requests;
  v_pt uuid;
BEGIN
  IF v_org IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'requester' AND p_unit NOT IN (SELECT public.own_fleet_unit_ids()) THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_units AS u WHERE u.id = p_unit AND u.org_id = v_org AND NOT u.archived) THEN
    RAISE EXCEPTION 'OWN_FLEET_UNIT_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_pt IN ARRAY ARRAY[p_from_point, p_to_point] LOOP
    IF v_pt IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.org_points AS x
      WHERE x.id = v_pt AND x.org_id = v_org AND NOT x.archived
        AND (v_role <> 'requester' OR x.unit_id IS NULL OR x.unit_id IN (SELECT public.own_fleet_unit_ids()))
    ) THEN
      RAISE EXCEPTION 'FLEET_REQUEST_BAD_POINT' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF p_wanted_at IS NULL OR coalesce(p_priority, 'normal') NOT IN ('normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'FLEET_REQUEST_INVALID' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.fleet_request_counters (org_id, next_no) VALUES (v_org, 2)
  ON CONFLICT (org_id) DO UPDATE SET next_no = public.fleet_request_counters.next_no + 1
  RETURNING next_no - 1 INTO v_no;
  INSERT INTO public.fleet_requests (org_id, number, unit_id, created_by, cargo, qty_t, from_point_id, to_point_id, from_text, to_text,
                                     wanted_at, duration_h, priority, note)
  VALUES (v_org, v_no, p_unit, auth.uid(), p_cargo, p_qty_t, p_from_point, p_to_point, nullif(btrim(p_from_text), ''), nullif(btrim(p_to_text), ''),
          p_wanted_at, coalesce(p_duration_h, 8), coalesce(p_priority, 'normal'), nullif(btrim(p_note), ''))
  RETURNING * INTO v_row;
  PERFORM public.fleet_request_log_add(v_row, NULL, NULL);
  RETURN v_row.id;
END;
$$;

-- Переходи: new → accepted → (assign) → assigned → in_progress → done; cancelled — з будь-якого до done.
CREATE OR REPLACE FUNCTION public.fleet_request_transition(p_id uuid, p_to text, p_reason text DEFAULT NULL)
RETURNS public.fleet_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
  v_role text := public.own_fleet_role();
  v_row public.fleet_requests;
  v_from text;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF v_org IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.fleet_requests WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND OR (v_role = 'requester' AND v_row.unit_id NOT IN (SELECT public.own_fleet_unit_ids())) THEN
    RAISE EXCEPTION 'FLEET_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_from := v_row.status;
  IF p_to = 'assigned' THEN
    RAISE EXCEPTION 'FLEET_REQUEST_USE_ASSIGN' USING ERRCODE = 'P0001';
  END IF;
  IF v_role = 'requester' THEN
    -- Замовник: лише скасувати свою нову заявку.
    IF NOT (p_to = 'cancelled' AND v_from = 'new' AND v_row.created_by = auth.uid()) THEN
      RAISE EXCEPTION 'FLEET_REQUEST_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NOT (
    (v_from = 'new' AND p_to IN ('accepted', 'cancelled'))
    OR (v_from = 'accepted' AND p_to = 'cancelled')
    OR (v_from = 'assigned' AND p_to IN ('in_progress', 'cancelled'))
    OR (v_from = 'in_progress' AND p_to IN ('done', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_TRANSITION' USING ERRCODE = 'P0001', DETAIL = v_from || ' -> ' || coalesce(p_to, 'NULL');
  END IF;
  IF p_to = 'cancelled' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'FLEET_REQUEST_REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.fleet_requests SET
    status = p_to,
    cancel_reason = CASE WHEN p_to = 'cancelled' THEN left(v_reason, 500) END,
    accepted_at = CASE WHEN p_to = 'accepted' THEN now() ELSE accepted_at END,
    started_at = CASE WHEN p_to = 'in_progress' THEN now() ELSE started_at END,
    done_at = CASE WHEN p_to = 'done' THEN now() ELSE done_at END,
    cancelled_at = CASE WHEN p_to = 'cancelled' THEN now() ELSE cancelled_at END,
    updated_at = now()
  WHERE id = p_id RETURNING * INTO v_row;
  PERFORM public.fleet_request_log_add(v_row, v_from, CASE WHEN p_to = 'cancelled' THEN v_reason END);
  RETURN v_row;
END;
$$;

-- Перетин у часі авто / водія з іншими призначеними заявками: [wanted_at, wanted_at + duration_h).
CREATE OR REPLACE FUNCTION public.fleet_request_conflicts(p_id uuid, p_vehicle uuid, p_driver uuid)
RETURNS TABLE (request_id uuid, number integer, kind text, wanted_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.number, k.kind, o.wanted_at
  FROM public.fleet_requests AS r
  JOIN public.fleet_requests AS o ON o.org_id = r.org_id AND o.id <> r.id AND o.status IN ('assigned', 'in_progress')
    AND tstzrange(o.wanted_at, o.wanted_at + o.duration_h * interval '1 hour')
        && tstzrange(r.wanted_at, r.wanted_at + r.duration_h * interval '1 hour')
  JOIN LATERAL (VALUES ('vehicle', o.vehicle_id = p_vehicle AND p_vehicle IS NOT NULL),
                       ('driver', o.driver_id = p_driver AND p_driver IS NOT NULL)) AS k (kind, hit) ON k.hit
  WHERE r.id = p_id AND r.org_id = public.own_fleet_org_id() AND public.own_fleet_can_manage()
  ORDER BY o.wanted_at, o.number;
$$;

CREATE OR REPLACE FUNCTION public.fleet_request_assign(p_id uuid, p_vehicle uuid, p_trailer uuid, p_driver uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.own_fleet_org_id();
  v_row public.fleet_requests;
  v_from text;
  v_veh text;
  v_trl text;
  v_drv text;
  v_conflicts jsonb;
BEGIN
  IF v_org IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.fleet_requests WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_from := v_row.status;
  IF v_from NOT IN ('accepted', 'assigned') THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_TRANSITION' USING ERRCODE = 'P0001', DETAIL = v_from || ' -> assigned';
  END IF;
  SELECT f.label INTO v_veh FROM public.fleet_vehicles AS f WHERE f.id = p_vehicle AND f.org_id = v_org;
  SELECT d.full_name INTO v_drv FROM public.kp_drivers AS d WHERE d.id = p_driver AND d.org_id = v_org AND d.active;
  IF v_veh IS NULL OR v_drv IS NULL THEN
    RAISE EXCEPTION 'FLEET_REQUEST_BAD_ASSIGNMENT' USING ERRCODE = 'P0001';
  END IF;
  IF p_trailer IS NOT NULL THEN
    SELECT t.plate INTO v_trl FROM public.fleet_trailers AS t WHERE t.id = p_trailer AND t.org_id = v_org;
    IF v_trl IS NULL THEN
      RAISE EXCEPTION 'FLEET_REQUEST_BAD_ASSIGNMENT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('request_id', c.request_id, 'number', c.number, 'kind', c.kind, 'wanted_at', c.wanted_at)), '[]'::jsonb)
  INTO v_conflicts FROM public.fleet_request_conflicts(p_id, p_vehicle, p_driver) AS c;
  UPDATE public.fleet_requests SET
    status = 'assigned', vehicle_id = p_vehicle, trailer_id = p_trailer, driver_id = p_driver,
    vehicle_label = v_veh, trailer_label = v_trl, driver_name = v_drv, assigned_at = now(), updated_at = now()
  WHERE id = p_id RETURNING * INTO v_row;
  PERFORM public.fleet_request_log_add(v_row, v_from, v_veh || coalesce(' + ' || v_trl, '') || ', ' || v_drv);
  RETURN jsonb_build_object('ok', true, 'conflicts', v_conflicts);
END;
$$;

-- Звʼязок із рейсом / подорожнім: лише посилання (інтеграція з формою подорожнього — наступний етап).
CREATE OR REPLACE FUNCTION public.fleet_request_set_trip(p_id uuid, p_trip uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.own_fleet_org_id() IS NULL OR NOT public.own_fleet_can_manage() THEN
    RAISE EXCEPTION 'OWN_FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.fleet_requests SET trip_id = p_trip, updated_at = now()
  WHERE id = p_id AND org_id = public.own_fleet_org_id() AND status IN ('assigned', 'in_progress', 'done');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_request_create(uuid, text, numeric, uuid, uuid, text, text, timestamptz, text, text, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fleet_request_transition(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fleet_request_conflicts(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fleet_request_assign(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fleet_request_set_trip(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fleet_request_create(uuid, text, numeric, uuid, uuid, text, text, timestamptz, text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fleet_request_transition(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fleet_request_conflicts(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fleet_request_assign(uuid, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fleet_request_set_trip(uuid, uuid) TO authenticated;
