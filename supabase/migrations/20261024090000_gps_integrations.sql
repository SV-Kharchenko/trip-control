-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+ (Етап 2a): GPS-моніторинг через Wialon — схема, підключення, мапінг юнітів на авто компанії.
-- Збирача позицій, крону, карти й прив'язки до заявок тут немає (етапи 2b / 2c).
--
-- * gps_integrations — підключення організації до провайдера (зараз лише Wialon: Hosting або Local). Токен клієнта
--   ніколи не лежить у цій таблиці: лише посилання на секрет у Supabase Vault (token_secret_id) і маска (token_hint).
--   next_poll_at / lock_until / consecutive_failures — для збирача 2b, у 2a не використовуються.
-- * gps_vehicles — юніт провайдера ↔ авто компанії (fleet_vehicles). Авто має бути з тієї самої організації.
-- * gps_positions — точки руху (порожня в 2a). gps_purge_old() чистить старі точки пачками.
-- * gps_store_token / gps_read_token / gps_delete_token — робота з токеном через Vault, лише service_role (API).
-- * gps_connect — підключення після перевірки: поля й секрет в одній транзакції (лише service_role).
-- * gps_map_vehicle(unit, vehicle) — мапінг юніта на авто, лише власник організації на control_plus.
-- * gps_units() — список юнітів з назвою авто для вкладки «GPS» (директор не читає fleet_vehicles чужої організації).
--
-- Доступ (лише SELECT для клієнтів; пишуть service_role і gps_map_vehicle):
-- * gps_integrations — власник і директор організації на control_plus; логіст — ні.
-- * gps_vehicles, gps_positions — усі учасники організації на control_plus (власник, директор, логіст):
--   усі авто організації, без розрізнення за рейсами. Без плану control_plus доступ зникає.
--
-- Лише адитивно: нові таблиці, функції, тригери й політики на нових таблицях. Наявні таблиці, функції й політики
-- не змінюються. Ідемпотентно. Без CREATE EXTENSION: supabase_vault на проді вже встановлено; vault.* викликається лише
-- в тілах функцій.

-- ---------------------------------------------------------------------------
-- gps_integrations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gps_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  -- Нові провайдери додаються окремою міграцією (розширенням цього CHECK).
  provider text NOT NULL CHECK (provider IN ('wialon')),
  host_kind text NOT NULL DEFAULT 'hosting' CHECK (host_kind IN ('hosting', 'local')),
  -- hosting: адреса з allowlist API; local: нормалізований hostname[:port] сервера клієнта.
  api_host text NOT NULL CHECK (char_length(api_host) BETWEEN 1 AND 260),
  token_secret_id uuid NULL,
  token_hint text NULL CHECK (token_hint IS NULL OR char_length(token_hint) <= 8),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error_auth', 'error', 'disabled')),
  provider_account text NULL,
  units_total integer NULL,
  poll_interval_min integer NOT NULL DEFAULT 10 CHECK (poll_interval_min BETWEEN 1 AND 1440),
  next_poll_at timestamptz NULL,
  lock_until timestamptz NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz NULL,
  last_ok_at timestamptz NULL,
  last_error_code text NULL,
  last_error_at timestamptz NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gps_integrations_org_provider_key UNIQUE (org_id, provider)
);

CREATE OR REPLACE FUNCTION public.gps_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_gps_integrations_touch ON public.gps_integrations;
CREATE TRIGGER trg_gps_integrations_touch
  BEFORE UPDATE ON public.gps_integrations
  FOR EACH ROW EXECUTE FUNCTION public.gps_touch_updated_at();

ALTER TABLE public.gps_integrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gps_integrations FROM PUBLIC, anon, authenticated;
-- Клієнт читає метадані без посилання на секрет (token_secret_id не видно навіть власнику).
GRANT SELECT (id, org_id, provider, host_kind, api_host, token_hint, status, provider_account, units_total,
  poll_interval_min, consecutive_failures, last_checked_at, last_ok_at, last_error_code, last_error_at,
  created_at, updated_at) ON public.gps_integrations TO authenticated;
GRANT ALL ON public.gps_integrations TO service_role;

DROP POLICY IF EXISTS gps_integrations_select ON public.gps_integrations;
CREATE POLICY gps_integrations_select ON public.gps_integrations
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id() AND coalesce(public.kp_role() IN ('owner', 'director'), false));

-- ---------------------------------------------------------------------------
-- gps_vehicles: unit of the provider ↔ vehicle of the company
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gps_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.gps_integrations (id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (char_length(name) <= 200),
  vehicle_id uuid NULL REFERENCES public.fleet_vehicles (id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_pos_at timestamptz NULL,
  last_lat double precision NULL,
  last_lon double precision NULL,
  last_speed smallint NULL,
  last_course smallint NULL,
  CONSTRAINT gps_vehicles_integration_external_key UNIQUE (integration_id, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS gps_vehicles_integration_vehicle_uidx
  ON public.gps_vehicles (integration_id, vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gps_vehicles_org_idx ON public.gps_vehicles (org_id);
CREATE INDEX IF NOT EXISTS gps_vehicles_vehicle_idx ON public.gps_vehicles (vehicle_id) WHERE vehicle_id IS NOT NULL;

-- Організація юніта — та сама, що в підключення; авто — лише своєї організації.
CREATE OR REPLACE FUNCTION public.gps_vehicles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT gi.org_id INTO v_org FROM public.gps_integrations AS gi WHERE gi.id = NEW.integration_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'GPS_INTEGRATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.integration_id IS DISTINCT FROM OLD.integration_id THEN
    RAISE EXCEPTION 'GPS_UNIT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  NEW.org_id := v_org;
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.fleet_vehicles AS fv WHERE fv.id = NEW.vehicle_id AND fv.org_id = v_org
  ) THEN
    RAISE EXCEPTION 'GPS_VEHICLE_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_vehicles_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_gps_vehicles_guard ON public.gps_vehicles;
CREATE TRIGGER trg_gps_vehicles_guard
  BEFORE INSERT OR UPDATE ON public.gps_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.gps_vehicles_guard();

ALTER TABLE public.gps_vehicles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gps_vehicles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.gps_vehicles TO authenticated;
GRANT ALL ON public.gps_vehicles TO service_role;

DROP POLICY IF EXISTS gps_vehicles_select ON public.gps_vehicles;
CREATE POLICY gps_vehicles_select ON public.gps_vehicles
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- ---------------------------------------------------------------------------
-- gps_positions (empty in 2a)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gps_positions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  gps_vehicle_id uuid NOT NULL REFERENCES public.gps_vehicles (id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  speed smallint NULL,
  course smallint NULL,
  sats smallint NULL,
  altitude real NULL,
  CONSTRAINT gps_positions_vehicle_time_key UNIQUE (gps_vehicle_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS gps_positions_recorded_idx ON public.gps_positions (recorded_at);
CREATE INDEX IF NOT EXISTS gps_positions_org_idx ON public.gps_positions (org_id, recorded_at DESC);

-- Організація точки — завжди організація юніта.
CREATE OR REPLACE FUNCTION public.gps_positions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT gv.org_id INTO v_org FROM public.gps_vehicles AS gv WHERE gv.id = NEW.gps_vehicle_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'GPS_UNIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  NEW.org_id := v_org;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_positions_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_gps_positions_guard ON public.gps_positions;
CREATE TRIGGER trg_gps_positions_guard
  BEFORE INSERT OR UPDATE ON public.gps_positions
  FOR EACH ROW EXECUTE FUNCTION public.gps_positions_guard();

ALTER TABLE public.gps_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gps_positions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.gps_positions TO authenticated;
GRANT ALL ON public.gps_positions TO service_role;

DROP POLICY IF EXISTS gps_positions_select ON public.gps_positions;
CREATE POLICY gps_positions_select ON public.gps_positions
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- Чистка старих точок пачками (для збирача 2b). Лише service_role; повертає кількість видалених.
CREATE OR REPLACE FUNCTION public.gps_purge_old(p_days integer DEFAULT 14, p_batch integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint := 0;
  v_step bigint;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 3650 OR p_batch IS NULL OR p_batch < 1 OR p_batch > 100000 THEN
    RAISE EXCEPTION 'GPS_BAD_PURGE_ARGS' USING ERRCODE = 'P0001';
  END IF;
  LOOP
    DELETE FROM public.gps_positions
    WHERE id IN (
      SELECT p.id FROM public.gps_positions AS p
      WHERE p.recorded_at < now() - make_interval(days => p_days)
      ORDER BY p.recorded_at
      LIMIT p_batch
    );
    GET DIAGNOSTICS v_step = ROW_COUNT;
    v_total := v_total + v_step;
    EXIT WHEN v_step < p_batch;
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_purge_old(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gps_purge_old(integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Token in Supabase Vault (service_role only)
-- ---------------------------------------------------------------------------
-- Секрет: імʼя 'gps:<integration_id>'. Відкритий токен ніколи не потрапляє в таблиці public, повідомлення помилок
-- чи RAISE; клієнтам ці функції недоступні (REVOKE). Викликає лише API Контроль+ з service_role.

CREATE OR REPLACE FUNCTION public.gps_store_token(p_integration uuid, p_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret uuid;
  v_name text := 'gps:' || p_integration::text;
  v_hint text;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_token IS NULL OR char_length(p_token) < 8 OR char_length(p_token) > 512 THEN
    RAISE EXCEPTION 'GPS_BAD_TOKEN' USING ERRCODE = 'P0001';
  END IF;
  SELECT gi.token_secret_id INTO v_secret
  FROM public.gps_integrations AS gi
  WHERE gi.id = p_integration
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GPS_INTEGRATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_secret IS NULL THEN
    -- Секрет з таким імʼям міг лишитись після збою відключення — перевикористовуємо його.
    SELECT s.id INTO v_secret FROM vault.secrets AS s WHERE s.name = v_name LIMIT 1;
  END IF;
  IF v_secret IS NULL THEN
    v_secret := vault.create_secret(p_token, v_name, 'Контроль+ GPS token');
  ELSE
    PERFORM vault.update_secret(v_secret, p_token, v_name, 'Контроль+ GPS token');
  END IF;
  v_hint := '…' || right(p_token, 4);
  UPDATE public.gps_integrations
  SET token_secret_id = v_secret, token_hint = v_hint
  WHERE id = p_integration;
  RETURN v_hint;
END;
$$;

CREATE OR REPLACE FUNCTION public.gps_read_token(p_integration uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT ds.decrypted_secret INTO v_token
  FROM public.gps_integrations AS gi
  JOIN vault.decrypted_secrets AS ds ON ds.id = gi.token_secret_id
  WHERE gi.id = p_integration;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.gps_delete_token(p_integration uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret uuid;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT gi.token_secret_id INTO v_secret
  FROM public.gps_integrations AS gi
  WHERE gi.id = p_integration
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM vault.secrets AS s
  WHERE s.id = v_secret OR s.name = 'gps:' || p_integration::text;
  UPDATE public.gps_integrations
  SET token_secret_id = NULL, token_hint = NULL
  WHERE id = p_integration;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_store_token(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gps_read_token(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gps_delete_token(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gps_store_token(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gps_read_token(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.gps_delete_token(uuid) TO service_role;

-- Підключення після успішної перевірки в провайдера: поля підключення й секрет у Vault в одній транзакції.
-- Якщо збереження секрету впаде, не змінюється нічого (ні api_host / host_kind, ні старий токен) — інакше старий токен
-- міг би піти на новий сервер. Лише service_role. Повертає рядок без токена (лише маска).
CREATE OR REPLACE FUNCTION public.gps_connect(
  p_org uuid, p_provider text, p_host_kind text, p_api_host text, p_account text, p_units integer, p_token text, p_user uuid
)
RETURNS TABLE (
  id uuid, status text, host_kind text, api_host text, provider_account text, units_total integer, token_hint text,
  last_checked_at timestamptz, last_ok_at timestamptz, last_error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.gps_integrations (org_id, provider, host_kind, api_host, status, created_by)
  VALUES (p_org, p_provider, p_host_kind, p_api_host, 'pending', p_user)
  ON CONFLICT ON CONSTRAINT gps_integrations_org_provider_key DO NOTHING;
  SELECT gi.id INTO v_id
  FROM public.gps_integrations AS gi
  WHERE gi.org_id = p_org AND gi.provider = p_provider
  FOR UPDATE;
  -- Спершу секрет (той самий код, що й gps_store_token); помилка тут відкочує і вставку вище.
  PERFORM public.gps_store_token(v_id, p_token);
  UPDATE public.gps_integrations AS gi
  SET host_kind = p_host_kind,
      api_host = p_api_host,
      status = 'active',
      provider_account = p_account,
      units_total = p_units,
      last_checked_at = now(),
      last_ok_at = now(),
      last_error_code = NULL,
      last_error_at = NULL,
      consecutive_failures = 0
  WHERE gi.id = v_id;
  RETURN QUERY
  SELECT gi.id, gi.status, gi.host_kind, gi.api_host, gi.provider_account, gi.units_total, gi.token_hint,
         gi.last_checked_at, gi.last_ok_at, gi.last_error_code
  FROM public.gps_integrations AS gi
  WHERE gi.id = v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_connect(uuid, text, text, text, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gps_connect(uuid, text, text, text, text, integer, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Mapping unit → vehicle (owner only)
-- ---------------------------------------------------------------------------

-- p_vehicle = NULL знімає мапінг. Одне авто — один юніт у підключенні.
CREATE OR REPLACE FUNCTION public.gps_map_vehicle(p_gps_vehicle uuid, p_vehicle uuid)
RETURNS TABLE (id uuid, vehicle_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit public.gps_vehicles%ROWTYPE;
BEGIN
  IF NOT coalesce(public.kp_can_write() AND public.kp_role() = 'owner', false) THEN
    RAISE EXCEPTION 'GPS_MAP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_unit FROM public.gps_vehicles AS gv
  WHERE gv.id = p_gps_vehicle AND gv.org_id = public.current_org_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GPS_UNIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_vehicle IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.fleet_vehicles AS fv WHERE fv.id = p_vehicle AND fv.org_id = v_unit.org_id
    ) THEN
      RAISE EXCEPTION 'GPS_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.gps_vehicles AS other
      WHERE other.integration_id = v_unit.integration_id
        AND other.vehicle_id = p_vehicle
        AND other.id <> v_unit.id
    ) THEN
      RAISE EXCEPTION 'GPS_VEHICLE_TAKEN'
        USING ERRCODE = 'P0001', DETAIL = 'This vehicle is already mapped to another unit';
    END IF;
  END IF;
  UPDATE public.gps_vehicles AS gv SET vehicle_id = p_vehicle WHERE gv.id = v_unit.id;
  RETURN QUERY SELECT v_unit.id, p_vehicle;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_map_vehicle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gps_map_vehicle(uuid, uuid) TO authenticated, service_role;

-- Юніти організації Контроль+ з назвою авто: директор бачить назви авто без доступу до fleet_vehicles іншої організації.
CREATE OR REPLACE FUNCTION public.gps_units()
RETURNS TABLE (
  id uuid, external_id text, name text, vehicle_id uuid, vehicle_label text, active boolean,
  first_seen_at timestamptz, last_seen_at timestamptz, last_pos_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT gv.id, gv.external_id, gv.name, gv.vehicle_id, fv.label, gv.active,
         gv.first_seen_at, gv.last_seen_at, gv.last_pos_at
  FROM public.gps_vehicles AS gv
  LEFT JOIN public.fleet_vehicles AS fv ON fv.id = gv.vehicle_id
  WHERE gv.org_id = v_org
  ORDER BY gv.active DESC, lower(gv.name), gv.external_id
  LIMIT 2000;
END;
$$;

REVOKE ALL ON FUNCTION public.gps_units() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gps_units() TO authenticated, service_role;
