-- Apply manually after review. This file is not applied to any database by the agent.
--
-- Контроль+ GPS: групи юнітів, тип юніта, провайдер «agrocontrol» (лише збереження доступу, без інтеграції).
--
-- * gps_groups — групи юнітів організації. source = 'wialon' (дзеркало avl_unit_group, оновлює лише sync-units
--   через gps_sync_groups) або 'manual' (створює директор / менеджер; sync їх не чіпає й не видаляє).
-- * gps_group_members — група ↔ юніт (gps_vehicles). Організація й належність юніта тій самій організації
--   перевіряються тригером.
-- * gps_vehicles.kind / kind_manual — тип юніта (truck / tractor / special / van / other, NULL = невизначено).
--   sync-units вгадує тип із назви; якщо kind_manual = true, ні sync, ні будь-який інший запис, окрім gps_set_kind,
--   тип не змінює (тригер gps_vehicles_kind_guard — друга лінія захисту поверх коду API).
-- * gps_integrations.provider: додається 'agrocontrol'. Токен — у Vault так само, як для Wialon (gps_connect /
--   gps_store_token без змін), клієнту не віддається.
--
-- Доступ: читають усі учасники організації на control_plus (kp_org_id()); змінюють лише «Директор» (owner) і
-- «Менеджер» (director) і лише не заблоковані (is_user_blocked()). Групи source = 'wialon' з клієнта змінити не можна.
--
-- Лише адитивно, ідемпотентно. Усі UPDATE і DELETE мають явний WHERE (на проді для authenticator увімкнено
-- safeupdate). Без CREATE EXTENSION.
--
-- РУЧНИЙ ВІДКАТ (не виконується автоматично):
--   DROP FUNCTION IF EXISTS public.gps_sync_groups(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.gps_set_kind(uuid, text);
--   DROP TABLE IF EXISTS public.gps_group_members; DROP TABLE IF EXISTS public.gps_groups;
--   DROP TRIGGER IF EXISTS trg_gps_vehicles_kind_guard ON public.gps_vehicles;
--   DROP FUNCTION IF EXISTS public.gps_vehicles_kind_guard();
--   ALTER TABLE public.gps_vehicles DROP COLUMN IF EXISTS kind_manual, DROP COLUMN IF EXISTS kind;
--   ALTER TABLE public.gps_integrations DROP CONSTRAINT IF EXISTS gps_integrations_provider_check;
--   ALTER TABLE public.gps_integrations ADD CONSTRAINT gps_integrations_provider_check CHECK (provider IN ('wialon'));
--   (перед останнім рядком видаліть підключення з provider = 'agrocontrol')

-- ---------------------------------------------------------------------------
-- Provider: wialon | agrocontrol
-- ---------------------------------------------------------------------------

ALTER TABLE public.gps_integrations DROP CONSTRAINT IF EXISTS gps_integrations_provider_check;
ALTER TABLE public.gps_integrations
  ADD CONSTRAINT gps_integrations_provider_check CHECK (provider IN ('wialon', 'agrocontrol'));

-- ---------------------------------------------------------------------------
-- gps_vehicles: kind, kind_manual
-- ---------------------------------------------------------------------------

ALTER TABLE public.gps_vehicles
  ADD COLUMN IF NOT EXISTS kind text NULL,
  ADD COLUMN IF NOT EXISTS kind_manual boolean NOT NULL DEFAULT false;

ALTER TABLE public.gps_vehicles DROP CONSTRAINT IF EXISTS gps_vehicles_kind_check;
ALTER TABLE public.gps_vehicles
  ADD CONSTRAINT gps_vehicles_kind_check CHECK (kind IS NULL OR kind IN ('truck', 'tractor', 'special', 'van', 'other'));

-- Ручний тип не перезаписується нічим, крім gps_set_kind (він ставить прапорець сесії на час своєї транзакції).
CREATE OR REPLACE FUNCTION public.gps_vehicles_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.kind_manual AND coalesce(current_setting('kp.gps_set_kind', true), '') <> '1' THEN
    NEW.kind := OLD.kind;
    NEW.kind_manual := OLD.kind_manual;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_vehicles_kind_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_gps_vehicles_kind_guard ON public.gps_vehicles;
CREATE TRIGGER trg_gps_vehicles_kind_guard
  BEFORE UPDATE ON public.gps_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.gps_vehicles_kind_guard();

-- ---------------------------------------------------------------------------
-- gps_groups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gps_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  integration_id uuid NULL REFERENCES public.gps_integrations (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('wialon', 'manual')),
  external_id text NULL CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- wialon: належить підключенню й має external_id; manual: без підключення й без external_id.
  CONSTRAINT gps_groups_source_shape CHECK (
    (source = 'wialon' AND integration_id IS NOT NULL AND external_id IS NOT NULL)
    OR (source = 'manual' AND integration_id IS NULL AND external_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS gps_groups_wialon_uidx
  ON public.gps_groups (integration_id, external_id) WHERE source = 'wialon';
CREATE INDEX IF NOT EXISTS gps_groups_org_idx ON public.gps_groups (org_id);

-- Організація групи wialon — організація підключення; організацію групи не можна змінити.
CREATE OR REPLACE FUNCTION public.gps_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.source IS DISTINCT FROM OLD.source
      OR NEW.integration_id IS DISTINCT FROM OLD.integration_id) THEN
    RAISE EXCEPTION 'GPS_GROUP_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF NEW.integration_id IS NOT NULL THEN
    SELECT gi.org_id INTO v_org FROM public.gps_integrations AS gi WHERE gi.id = NEW.integration_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'GPS_INTEGRATION_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    NEW.org_id := v_org;
  END IF;
  NEW.name := btrim(NEW.name);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_groups_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_gps_groups_guard ON public.gps_groups;
CREATE TRIGGER trg_gps_groups_guard
  BEFORE INSERT OR UPDATE ON public.gps_groups
  FOR EACH ROW EXECUTE FUNCTION public.gps_groups_guard();

DROP TRIGGER IF EXISTS trg_gps_groups_touch ON public.gps_groups;
CREATE TRIGGER trg_gps_groups_touch
  BEFORE UPDATE ON public.gps_groups
  FOR EACH ROW EXECUTE FUNCTION public.gps_touch_updated_at();

-- ---------------------------------------------------------------------------
-- gps_group_members
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gps_group_members (
  group_id uuid NOT NULL REFERENCES public.gps_groups (id) ON DELETE CASCADE,
  gps_vehicle_id uuid NOT NULL REFERENCES public.gps_vehicles (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, gps_vehicle_id)
);

CREATE INDEX IF NOT EXISTS gps_group_members_vehicle_idx ON public.gps_group_members (gps_vehicle_id);
CREATE INDEX IF NOT EXISTS gps_group_members_org_idx ON public.gps_group_members (org_id);

-- Група й юніт — з однієї організації; org_id рядка завжди береться з групи.
CREATE OR REPLACE FUNCTION public.gps_group_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT g.org_id INTO v_org FROM public.gps_groups AS g WHERE g.id = NEW.group_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'GPS_GROUP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gps_vehicles AS gv WHERE gv.id = NEW.gps_vehicle_id AND gv.org_id = v_org) THEN
    RAISE EXCEPTION 'GPS_UNIT_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;
  NEW.org_id := v_org;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_group_members_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_gps_group_members_guard ON public.gps_group_members;
CREATE TRIGGER trg_gps_group_members_guard
  BEFORE INSERT OR UPDATE ON public.gps_group_members
  FOR EACH ROW EXECUTE FUNCTION public.gps_group_members_guard();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE public.gps_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gps_group_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gps_groups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.gps_group_members FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.gps_groups TO authenticated;
GRANT UPDATE (name) ON public.gps_groups TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.gps_group_members TO authenticated;
GRANT ALL ON public.gps_groups TO service_role;
GRANT ALL ON public.gps_group_members TO service_role;

DROP POLICY IF EXISTS gps_groups_select ON public.gps_groups;
CREATE POLICY gps_groups_select ON public.gps_groups
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

DROP POLICY IF EXISTS gps_groups_insert ON public.gps_groups;
CREATE POLICY gps_groups_insert ON public.gps_groups
  FOR INSERT TO authenticated
  WITH CHECK (
    source = 'manual'
    AND org_id = public.kp_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'director'), false)
    AND NOT public.is_user_blocked()
  );

DROP POLICY IF EXISTS gps_groups_update ON public.gps_groups;
CREATE POLICY gps_groups_update ON public.gps_groups
  FOR UPDATE TO authenticated
  USING (
    source = 'manual'
    AND org_id = public.kp_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'director'), false)
    AND NOT public.is_user_blocked()
  )
  WITH CHECK (
    source = 'manual'
    AND org_id = public.kp_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'director'), false)
    AND NOT public.is_user_blocked()
  );

DROP POLICY IF EXISTS gps_groups_delete ON public.gps_groups;
CREATE POLICY gps_groups_delete ON public.gps_groups
  FOR DELETE TO authenticated
  USING (
    source = 'manual'
    AND org_id = public.kp_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'director'), false)
    AND NOT public.is_user_blocked()
  );

DROP POLICY IF EXISTS gps_group_members_select ON public.gps_group_members;
CREATE POLICY gps_group_members_select ON public.gps_group_members
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- Склад змінюється лише у ручних групах; групи wialon — дзеркало провайдера.
DROP POLICY IF EXISTS gps_group_members_insert ON public.gps_group_members;
CREATE POLICY gps_group_members_insert ON public.gps_group_members
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id = public.kp_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'director'), false)
    AND NOT public.is_user_blocked()
    AND EXISTS (SELECT 1 FROM public.gps_groups AS g WHERE g.id = group_id AND g.source = 'manual' AND g.org_id = public.kp_org_id())
  );

DROP POLICY IF EXISTS gps_group_members_delete ON public.gps_group_members;
CREATE POLICY gps_group_members_delete ON public.gps_group_members
  FOR DELETE TO authenticated
  USING (
    org_id = public.kp_org_id()
    AND coalesce(public.kp_role() IN ('owner', 'director'), false)
    AND NOT public.is_user_blocked()
    AND EXISTS (SELECT 1 FROM public.gps_groups AS g WHERE g.id = group_id AND g.source = 'manual' AND g.org_id = public.kp_org_id())
  );

-- ---------------------------------------------------------------------------
-- gps_set_kind: ручне виправлення типу юніта (директор / менеджер)
-- ---------------------------------------------------------------------------

-- p_kind = NULL знімає ручний тип (kind_manual = false; тип перерахує наступний sync-units).
CREATE OR REPLACE FUNCTION public.gps_set_kind(p_gps_vehicle uuid, p_kind text)
RETURNS TABLE (id uuid, kind text, kind_manual boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_org_id();
  v_id uuid;
  v_kind text;
  v_manual boolean;
BEGIN
  IF v_org IS NULL OR NOT coalesce(public.kp_role() IN ('owner', 'director'), false) OR public.is_user_blocked() THEN
    RAISE EXCEPTION 'GPS_KIND_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('truck', 'tractor', 'special', 'van', 'other') THEN
    RAISE EXCEPTION 'GPS_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('kp.gps_set_kind', '1', true);
  UPDATE public.gps_vehicles AS gv
  SET kind = p_kind, kind_manual = (p_kind IS NOT NULL)
  WHERE gv.id = p_gps_vehicle AND gv.org_id = v_org
  RETURNING gv.id, gv.kind, gv.kind_manual INTO v_id, v_kind, v_manual;
  PERFORM set_config('kp.gps_set_kind', '', true);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'GPS_UNIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT v_id, v_kind, v_manual;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_set_kind(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gps_set_kind(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- gps_sync_groups: дзеркало груп Wialon (лише service_role, з sync-units)
-- ---------------------------------------------------------------------------

-- p_groups: [{"external_id": "12", "name": "Тягачі", "units": ["101", "102"]}, …] — external_id юнітів провайдера.
-- Зачіпає ЛИШЕ групи source = 'wialon' цього підключення: ручні групи (source = 'manual') і їх склад не змінюються.
-- Група, якої більше нема у провайдера, видаляється разом із складом; юніти не видаляються.
CREATE OR REPLACE FUNCTION public.gps_sync_groups(p_integration uuid, p_groups jsonb)
RETURNS TABLE (groups_total integer, groups_removed integer, members_total integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_removed integer := 0;
  v_members integer := 0;
  v_total integer := 0;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_groups IS NULL OR jsonb_typeof(p_groups) <> 'array' THEN
    RAISE EXCEPTION 'GPS_BAD_GROUPS' USING ERRCODE = 'P0001';
  END IF;
  SELECT gi.org_id INTO v_org FROM public.gps_integrations AS gi WHERE gi.id = p_integration;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'GPS_INTEGRATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.gps_sync_in (ext text, nm text, unit_ext text) ON COMMIT DROP;
  DELETE FROM pg_temp.gps_sync_in WHERE true;
  INSERT INTO pg_temp.gps_sync_in (ext, nm, unit_ext)
  SELECT g.value ->> 'external_id', left(btrim(coalesce(g.value ->> 'name', '')), 200), u.value
  FROM jsonb_array_elements(p_groups) AS g(value)
  LEFT JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(g.value -> 'units') = 'array' THEN g.value -> 'units' ELSE '[]'::jsonb END
  ) AS u(value) ON true
  WHERE coalesce(g.value ->> 'external_id', '') <> '';

  INSERT INTO public.gps_groups (org_id, integration_id, source, external_id, name)
  SELECT DISTINCT ON (i.ext) v_org, p_integration, 'wialon', i.ext, coalesce(nullif(i.nm, ''), 'Група ' || i.ext)
  FROM pg_temp.gps_sync_in AS i
  ON CONFLICT (integration_id, external_id) WHERE source = 'wialon'
  DO UPDATE SET name = EXCLUDED.name WHERE public.gps_groups.name IS DISTINCT FROM EXCLUDED.name;

  DELETE FROM public.gps_groups AS g
  WHERE g.integration_id = p_integration AND g.source = 'wialon'
    AND NOT EXISTS (SELECT 1 FROM pg_temp.gps_sync_in AS i WHERE i.ext = g.external_id);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  DELETE FROM public.gps_group_members AS m
  USING public.gps_groups AS g
  WHERE m.group_id = g.id AND g.integration_id = p_integration AND g.source = 'wialon'
    AND NOT EXISTS (
      SELECT 1 FROM pg_temp.gps_sync_in AS i
      JOIN public.gps_vehicles AS gv ON gv.integration_id = p_integration AND gv.external_id = i.unit_ext
      WHERE i.ext = g.external_id AND gv.id = m.gps_vehicle_id
    );

  INSERT INTO public.gps_group_members (group_id, gps_vehicle_id, org_id)
  SELECT DISTINCT g.id, gv.id, v_org
  FROM pg_temp.gps_sync_in AS i
  JOIN public.gps_groups AS g ON g.integration_id = p_integration AND g.source = 'wialon' AND g.external_id = i.ext
  JOIN public.gps_vehicles AS gv ON gv.integration_id = p_integration AND gv.external_id = i.unit_ext
  ON CONFLICT (group_id, gps_vehicle_id) DO NOTHING;

  SELECT count(*)::integer INTO v_total FROM public.gps_groups AS g WHERE g.integration_id = p_integration AND g.source = 'wialon';
  SELECT count(*)::integer INTO v_members FROM public.gps_group_members AS m
  JOIN public.gps_groups AS g ON g.id = m.group_id WHERE g.integration_id = p_integration AND g.source = 'wialon';
  RETURN QUERY SELECT v_total, v_removed, v_members;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_sync_groups(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gps_sync_groups(uuid, jsonb) TO service_role;
