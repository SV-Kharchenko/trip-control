-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+ (Етап 4b): ТТН за формою № 1-ТН (додаток 7 до Правил перевезень вантажів автомобільним транспортом
-- в Україні, наказ Мінтрансу № 363, у редакції наказів Мінрозвитку № 1332 від 14.11.2024 і № 1727 від 12.12.2025),
-- поля транспортного засобу в fleet_vehicles і мінімальний довідник водіїв.
--
-- * fleet_vehicles (таблиця сайту): нові nullable-колонки з CHECK-ами (тип ТЗ, марка / модель причепа, габарити
--   автопоїзда, тара, максимально дозволена маса, водій за замовчуванням). Наявні колонки, політики й гранти не
--   змінюються; сайт пише нові колонки напряму через RLS (лише власник — як і решту картки).
--   Держномер тягача — наявний label, номер причепа — trailer_plate, тип причепа — trailer_type.
--   fleet_vehicles_guard розширено рівно на один випадок: не-власник з правом запису Контроль+ (логіст, kp_can_write)
--   може в UPDATE авто своєї компанії змінити ЛИШЕ нові ТТН-колонки; усе інше — як і раніше лише owner / service_role
--   (гілки власника й service_role — без змін). Прямий запис логіста й надалі не проходить RLS сайту — пише він через
--   kp_vehicle_save (SECURITY DEFINER), і guard перевіряє, що змінено тільки дозволене.
-- * Водій за замовчуванням — лише своєї компанії: тригер trg_fleet_vehicles_guard_driver (BEFORE INSERT / UPDATE OF
--   default_driver_id, після guard), інакше VEHICLE_DRIVER_FORBIDDEN — і для запису сайту, і для RPC.
-- * kp_drivers — ПІБ і номер посвідчення водія (без телефонів, адрес, паспортів); деактивація замість видалення.
-- * kp_doc_ttn + kp_doc_ttn_lines — ТТН: знімок усіх реквізитів форми на момент створення, після випуску незмінний
--   (тригери); змінюються лише статус (анулювання) і посилання на рейс / авто, якщо їх видалили на сайті. DELETE немає.
--   ТТН — окрема таблиця, а не рядок kp_documents: CHECK kp_documents_sums_check вимагає total > 0, а сума в ТТН
--   необовʼязкова (вантаж за обліковою ціною власника). Лічильник номерів — наявний kp_doc_counters (kind 'ttn'),
--   номер унікальний у межах організації й року; kp_doc_create, як і раніше, відхиляє 'ttn' (DOC_KIND_NOT_READY).
--   Список, картка й анулювання ТТН — нові функції kp_ttn_list / kp_ttn_get / kp_ttn_cancel (функції 4a працюють лише
--   з kp_documents і не змінюються).
-- * Підпис і печатка в ТТН — лише нашої сторони (перевізник), знімок <org>/docs/<id>/… через /api/docs/assets, як у 4a.
-- * Права: читають owner / logist / director своєї організації на control_plus; створюють ТТН, редагують поля ТЗ і
--   водіїв — kp_can_write() (owner, logist); анулює лише owner. Таблиці — без прямих грантів клієнтам, усе через RPC.
--
-- Адитивно: нові таблиці, функції, тригери й колонки; із наявного — лише розширений fleet_vehicles_guard (вище).
-- Функції й таблиці 4a, kp_org_id, kp_role, kp_can_write,
-- kp_context, kp_trips, calculations, trip_actuals, org_company_profiles, функції 3a / 3b не змінюються. Ідемпотентно.
-- Після 20261026072759_kp_documents.sql.

-- ---------------------------------------------------------------------------
-- Drivers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kp_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  full_name text NOT NULL,
  license_no text NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_drivers_name_check CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 200 AND full_name !~ '[[:cntrl:]]'),
  CONSTRAINT kp_drivers_license_check CHECK (license_no IS NULL OR (char_length(btrim(license_no)) BETWEEN 1 AND 30 AND license_no !~ '[[:cntrl:]]'))
);

CREATE INDEX IF NOT EXISTS kp_drivers_org_idx ON public.kp_drivers (org_id, active, lower(full_name));

-- ---------------------------------------------------------------------------
-- fleet_vehicles: vehicle data for the waybill (new nullable columns only)
-- ---------------------------------------------------------------------------

ALTER TABLE public.fleet_vehicles
  ADD COLUMN IF NOT EXISTS vehicle_type text NULL,
  ADD COLUMN IF NOT EXISTS trailer_make_model text NULL,
  ADD COLUMN IF NOT EXISTS length_m numeric(5, 2) NULL,
  ADD COLUMN IF NOT EXISTS width_m numeric(5, 2) NULL,
  ADD COLUMN IF NOT EXISTS height_m numeric(5, 2) NULL,
  ADD COLUMN IF NOT EXISTS tare_t numeric(6, 3) NULL,
  ADD COLUMN IF NOT EXISTS max_mass_t numeric(6, 3) NULL,
  ADD COLUMN IF NOT EXISTS default_driver_id uuid NULL REFERENCES public.kp_drivers (id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_vehicles_vehicle_type_chk' AND conrelid = 'public.fleet_vehicles'::regclass) THEN
    ALTER TABLE public.fleet_vehicles
      ADD CONSTRAINT fleet_vehicles_vehicle_type_chk
      CHECK (vehicle_type IS NULL OR (char_length(vehicle_type) BETWEEN 1 AND 100 AND vehicle_type !~ '[[:cntrl:]]'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_vehicles_trailer_make_model_chk' AND conrelid = 'public.fleet_vehicles'::regclass) THEN
    ALTER TABLE public.fleet_vehicles
      ADD CONSTRAINT fleet_vehicles_trailer_make_model_chk
      CHECK (trailer_make_model IS NULL OR (char_length(trailer_make_model) BETWEEN 1 AND 100 AND trailer_make_model !~ '[[:cntrl:]]'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_vehicles_dimensions_chk' AND conrelid = 'public.fleet_vehicles'::regclass) THEN
    ALTER TABLE public.fleet_vehicles
      ADD CONSTRAINT fleet_vehicles_dimensions_chk
      CHECK ((length_m IS NULL OR (length_m > 0 AND length_m <= 30))
         AND (width_m IS NULL OR (width_m > 0 AND width_m <= 30))
         AND (height_m IS NULL OR (height_m > 0 AND height_m <= 30)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_vehicles_mass_chk' AND conrelid = 'public.fleet_vehicles'::regclass) THEN
    ALTER TABLE public.fleet_vehicles
      ADD CONSTRAINT fleet_vehicles_mass_chk
      CHECK ((tare_t IS NULL OR (tare_t > 0 AND tare_t <= 100))
         AND (max_mass_t IS NULL OR (max_mass_t > 0 AND max_mass_t <= 100))
         AND (tare_t IS NULL OR max_mass_t IS NULL OR tare_t < max_mass_t));
  END IF;
END;
$$;

-- Guard сайту (20261012240000_fleet_vehicles.sql) + один новий випадок: UPDATE не-власником з kp_can_write() (логіст
-- Контроль+) авто своєї компанії, де відрізняються лише ТТН-колонки (updated_at ставить guard). Гілки service_role і
-- власника — дослівно як були.
CREATE OR REPLACE FUNCTION public.fleet_vehicles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_ttn text[] := ARRAY['vehicle_type', 'trailer_make_model', 'length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t',
                        'default_driver_id', 'updated_at'];
BEGIN
  IF public.is_service_role() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    NEW.label := btrim(coalesce(NEW.label, ''));
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NOT public.is_org_owner() THEN
    -- Логіст Контроль+: лише ТТН-колонки авто своєї компанії.
    IF TG_OP = 'UPDATE'
       AND public.kp_can_write()
       AND OLD.org_id = public.current_org_id()
       AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
       AND (to_jsonb(NEW) - v_ttn) = (to_jsonb(OLD) - v_ttn) THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.org_id IS DISTINCT FROM public.current_org_id() THEN
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  NEW.org_id := public.current_org_id();
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  NEW.label := btrim(coalesce(NEW.label, ''));
  IF char_length(NEW.label) < 1 OR char_length(NEW.label) > 40 THEN
    RAISE EXCEPTION 'FLEET_LABEL' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_count
    FROM public.fleet_vehicles
    WHERE org_id = NEW.org_id;
    IF v_count >= 100 THEN
      RAISE EXCEPTION 'FLEET_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_vehicles_guard() FROM PUBLIC, anon, authenticated, service_role;

-- Водій за замовчуванням — лише своєї компанії (і для прямого запису сайту, і для RPC). Імʼя тригера сортується після
-- trg_fleet_vehicles_guard, тож org_id тут уже виставлений guard-ом.
CREATE OR REPLACE FUNCTION public.fleet_vehicles_driver_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.default_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.kp_drivers AS d WHERE d.id = NEW.default_driver_id AND d.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'VEHICLE_DRIVER_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_vehicles_driver_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_fleet_vehicles_guard_driver ON public.fleet_vehicles;
CREATE TRIGGER trg_fleet_vehicles_guard_driver
  BEFORE INSERT OR UPDATE OF default_driver_id ON public.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.fleet_vehicles_driver_guard();

-- ---------------------------------------------------------------------------
-- Waybills (ТТН) and cargo lines
-- ---------------------------------------------------------------------------

-- Сторони (shipper, carrier, consignee, customer, forwarder) — jsonb {name, code, address?}; driver — {full_name,
-- license_no}; vehicle — {make_model, type, reg_number, trailer_make_model, trailer_type, trailer_reg_number,
-- length_m, width_m, height_m}. operations — масив з двох рядків (навантаження / розвантаження): фіксовані два рядки
-- форми без окремих правил на рядок, тому jsonb; рядки вантажу (до 50, графи 1–11) — окрема таблиця з CHECK-ами.
CREATE TABLE IF NOT EXISTS public.kp_doc_ttn (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  number integer NOT NULL,
  doc_year smallint NOT NULL,
  prefix text NULL,
  doc_date date NOT NULL,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE RESTRICT,
  calculation_id uuid NULL REFERENCES public.calculations (id) ON DELETE SET NULL,
  vehicle_id uuid NULL REFERENCES public.fleet_vehicles (id) ON DELETE SET NULL,
  place_of_issue text NOT NULL,
  transport_kind text NULL,
  vehicle_parking_place text NULL,
  readdressing text NULL,
  seal_note text NULL,
  shipper jsonb NOT NULL,
  carrier jsonb NOT NULL,
  consignee jsonb NOT NULL,
  customer jsonb NULL,
  forwarder jsonb NULL,
  driver jsonb NOT NULL,
  vehicle jsonb NOT NULL,
  load_point text NOT NULL,
  unload_point text NOT NULL,
  places_count integer NULL,
  cargo_net_t numeric(12, 3) NULL,
  cargo_gross_t numeric(12, 3) NOT NULL,
  tare_t numeric(12, 3) NOT NULL,
  total_mass_t numeric(12, 3) NOT NULL,
  max_mass_t numeric(12, 3) NULL,
  accompanying_docs text NULL,
  total_amount numeric(14, 2) NULL,
  vat_amount numeric(14, 2) NULL,
  received_by text NULL,
  released_by text NULL,
  accepted_by text NULL,
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'issued',
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL,
  cancelled_reason text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_doc_ttn_number_range CHECK (number BETWEEN 1 AND 999999999),
  CONSTRAINT kp_doc_ttn_year_matches CHECK (doc_year = extract(year FROM doc_date)),
  CONSTRAINT kp_doc_ttn_parties CHECK (
    jsonb_typeof(shipper) = 'object' AND jsonb_typeof(carrier) = 'object' AND jsonb_typeof(consignee) = 'object'
    AND jsonb_typeof(driver) = 'object' AND jsonb_typeof(vehicle) = 'object'
    AND (customer IS NULL OR jsonb_typeof(customer) = 'object') AND (forwarder IS NULL OR jsonb_typeof(forwarder) = 'object')
    AND jsonb_typeof(operations) = 'array' AND jsonb_array_length(operations) <= 2),
  CONSTRAINT kp_doc_ttn_mass CHECK (
    cargo_gross_t > 0 AND cargo_gross_t <= 1000 AND tare_t > 0 AND tare_t <= 100
    AND total_mass_t = tare_t + cargo_gross_t
    AND (cargo_net_t IS NULL OR (cargo_net_t > 0 AND cargo_net_t <= cargo_gross_t))
    AND (max_mass_t IS NULL OR (max_mass_t > 0 AND max_mass_t <= 100))),
  CONSTRAINT kp_doc_ttn_places CHECK (places_count IS NULL OR places_count BETWEEN 0 AND 1000000),
  CONSTRAINT kp_doc_ttn_amounts CHECK (
    (total_amount IS NULL OR total_amount BETWEEN 0 AND 999999999.99)
    AND (vat_amount IS NULL OR (vat_amount >= 0 AND total_amount IS NOT NULL AND vat_amount <= total_amount))),
  CONSTRAINT kp_doc_ttn_text_len CHECK (
    char_length(place_of_issue) BETWEEN 1 AND 200 AND char_length(load_point) BETWEEN 1 AND 500
    AND char_length(unload_point) BETWEEN 1 AND 500
    AND coalesce(char_length(transport_kind), 0) <= 100 AND coalesce(char_length(vehicle_parking_place), 0) <= 500
    AND coalesce(char_length(readdressing), 0) <= 500 AND coalesce(char_length(seal_note), 0) <= 300
    AND coalesce(char_length(accompanying_docs), 0) <= 500 AND coalesce(char_length(received_by), 0) <= 300
    AND coalesce(char_length(released_by), 0) <= 300 AND coalesce(char_length(accepted_by), 0) <= 300),
  CONSTRAINT kp_doc_ttn_status_check CHECK (status IN ('issued', 'cancelled') AND ((status = 'cancelled') = (cancelled_at IS NOT NULL))),
  CONSTRAINT kp_doc_ttn_reason_len CHECK (cancelled_reason IS NULL OR char_length(cancelled_reason) <= 500),
  -- Підпис і печатка перевізника — лише знімок цієї ТТН (<org>/docs/<id>/…), як kp_documents_asset_snapshot у 4a.
  CONSTRAINT kp_doc_ttn_asset_snapshot CHECK (
    (carrier ->> 'signature_path' IS NULL
      OR carrier ->> 'signature_path' IN (org_id::text || '/docs/' || id::text || '/signature.png', org_id::text || '/docs/' || id::text || '/signature.jpg'))
    AND (carrier ->> 'stamp_path' IS NULL
      OR carrier ->> 'stamp_path' IN (org_id::text || '/docs/' || id::text || '/stamp.png', org_id::text || '/docs/' || id::text || '/stamp.jpg'))),
  CONSTRAINT kp_doc_ttn_number_key UNIQUE (org_id, doc_year, number)
);

CREATE INDEX IF NOT EXISTS kp_doc_ttn_org_date_idx ON public.kp_doc_ttn (org_id, doc_date DESC);
CREATE INDEX IF NOT EXISTS kp_doc_ttn_client_idx ON public.kp_doc_ttn (client_id, status);
CREATE INDEX IF NOT EXISTS kp_doc_ttn_calc_idx ON public.kp_doc_ttn (calculation_id) WHERE calculation_id IS NOT NULL;

-- Графи 1–11 форми: найменування / контейнер / клас небезпеки, ідентифікаційний номер і вид тварини, температурний
-- режим, одиниця, кількість місць, ціна без ПДВ (або облікова ціна власника — owner_price), сума з ПДВ, пакування,
-- документи з вантажем, маса брутто. bulk — насип / налив (маса брутто = нетто).
CREATE TABLE IF NOT EXISTS public.kp_doc_ttn_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ttn_id uuid NOT NULL REFERENCES public.kp_doc_ttn (id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  sort smallint NOT NULL CHECK (sort BETWEEN 1 AND 50),
  cargo_name text NOT NULL,
  animal_id text NULL,
  animal_kind text NULL,
  temperature text NULL,
  unit text NULL,
  places integer NULL,
  price numeric(14, 2) NULL,
  owner_price boolean NOT NULL DEFAULT false,
  amount numeric(14, 2) NULL,
  packaging text NULL,
  docs text NULL,
  gross_t numeric(12, 3) NULL,
  bulk boolean NOT NULL DEFAULT false,
  CONSTRAINT kp_doc_ttn_lines_text CHECK (
    char_length(cargo_name) BETWEEN 1 AND 500 AND coalesce(char_length(animal_id), 0) <= 100
    AND coalesce(char_length(animal_kind), 0) <= 100 AND coalesce(char_length(temperature), 0) <= 50
    AND coalesce(char_length(unit), 0) <= 20 AND coalesce(char_length(packaging), 0) <= 100 AND coalesce(char_length(docs), 0) <= 300),
  CONSTRAINT kp_doc_ttn_lines_values CHECK (
    (places IS NULL OR places BETWEEN 0 AND 1000000)
    AND (price IS NULL OR price BETWEEN 0 AND 1000000000) AND (NOT owner_price OR price IS NULL)
    AND (amount IS NULL OR amount BETWEEN 0 AND 999999999.99)
    AND (gross_t IS NULL OR (gross_t > 0 AND gross_t <= 1000))),
  CONSTRAINT kp_doc_ttn_lines_sort_key UNIQUE (ttn_id, sort)
);

CREATE INDEX IF NOT EXISTS kp_doc_ttn_lines_ttn_idx ON public.kp_doc_ttn_lines (ttn_id);

-- ---------------------------------------------------------------------------
-- Immutability: no DELETE; after issue only the cancel fields and links removed by the site change
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_doc_ttn_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOC_DELETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Дозволено: анулювання (один раз) і calculation_id / vehicle_id → NULL (рейс чи авто видалили на сайті).
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason', 'calculation_id', 'vehicle_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason', 'calculation_id', 'vehicle_id'])
     OR (NEW.calculation_id IS NOT NULL AND NEW.calculation_id IS DISTINCT FROM OLD.calculation_id)
     OR (NEW.vehicle_id IS NOT NULL AND NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id)
     OR (OLD.status = 'cancelled' AND (to_jsonb(NEW) - ARRAY['calculation_id', 'vehicle_id'])
                                      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['calculation_id', 'vehicle_id'])) THEN
    RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_doc_ttn_lines_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOC_DELETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_kp_doc_ttn_guard ON public.kp_doc_ttn;
CREATE TRIGGER trg_kp_doc_ttn_guard
  BEFORE UPDATE OR DELETE ON public.kp_doc_ttn
  FOR EACH ROW EXECUTE FUNCTION public.kp_doc_ttn_guard();

DROP TRIGGER IF EXISTS trg_kp_doc_ttn_lines_guard ON public.kp_doc_ttn_lines;
CREATE TRIGGER trg_kp_doc_ttn_lines_guard
  BEFORE UPDATE OR DELETE ON public.kp_doc_ttn_lines
  FOR EACH ROW EXECUTE FUNCTION public.kp_doc_ttn_lines_guard();

-- ---------------------------------------------------------------------------
-- RLS and grants: no direct access for clients (everything through the functions below)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kp_drivers', 'kp_doc_ttn', 'kp_doc_ttn_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Internal helpers (closed to every API role)
-- ---------------------------------------------------------------------------

-- Текст поля: обрізаний, порожній → NULL; довший за p_max або з керівними символами → TTN_FIELD_INVALID:<поле>.
CREATE OR REPLACE FUNCTION public.kp_ttn_text(p_value text, p_max integer, p_field text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text := nullif(btrim(coalesce(p_value, '')), '');
BEGIN
  IF v IS NOT NULL AND (char_length(v) > p_max OR v ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:%', p_field USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END;
$$;

-- Число поля: NULL / '' → NULL; не число або поза (p_min_excl, p_max] → p_error:<поле>.
CREATE OR REPLACE FUNCTION public.kp_ttn_num(p_value text, p_min_excl numeric, p_max numeric, p_scale integer, p_field text, p_error text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v numeric;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v := round(replace(btrim(p_value), ',', '.')::numeric, p_scale);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION '%:%', p_error, p_field USING ERRCODE = 'P0001';
  END;
  IF v <= p_min_excl OR v > p_max THEN
    RAISE EXCEPTION '%:%', p_error, p_field USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END;
$$;

-- Сторона {name, code, address}: код — ЄДРПОУ (8 цифр), РНОКПП (10), номер ID-картки (9) або серія й номер паспорта
-- (2 літери + 6 цифр). Обовʼязкова сторона без назви чи коду → TTN_FIELD_REQUIRED:<поле>.name / .code.
CREATE OR REPLACE FUNCTION public.kp_ttn_party(p jsonb, p_field text, p_required boolean)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_code text;
  v_address text;
BEGIN
  IF p IS NOT NULL AND jsonb_typeof(p) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:%', p_field USING ERRCODE = 'P0001';
  END IF;
  IF p IS NOT NULL AND jsonb_typeof(p) = 'object' THEN
    v_name := public.kp_ttn_text(p ->> 'name', 300, p_field || '.name');
    v_code := upper(regexp_replace(coalesce(p ->> 'code', ''), '\s', '', 'g'));
    v_code := nullif(v_code, '');
    v_address := public.kp_ttn_text(p ->> 'address', 500, p_field || '.address');
  END IF;
  IF v_name IS NULL AND v_code IS NULL AND v_address IS NULL AND NOT p_required THEN
    RETURN NULL;
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:%', p_field || '.name' USING ERRCODE = 'P0001';
  END IF;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:%', p_field || '.code' USING ERRCODE = 'P0001';
  END IF;
  IF v_code !~ '^([0-9]{8}|[0-9]{9}|[0-9]{10}|[А-ЯҐЄІЇ]{2}[0-9]{6})$' THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:%', p_field || '.code' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('name', v_name, 'code', v_code, 'address', v_address));
END;
$$;

-- Номер ТТН — наявний лічильник kp_doc_counters (kind 'ttn'), той самий підхід, що kp_doc_alloc_number (рядок
-- лічильника блокується до кінця транзакції), але зайнятість номера — у kp_doc_ttn.
CREATE OR REPLACE FUNCTION public.kp_ttn_alloc_number(p_org uuid, p_year integer, p_manual integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_no integer;
BEGIN
  IF p_manual IS NOT NULL THEN
    IF p_manual < 1 OR p_manual > 999999999 THEN
      RAISE EXCEPTION 'DOC_BAD_NUMBER' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.kp_doc_counters AS c (org_id, kind, year, next_no)
    VALUES (p_org, 'ttn', p_year, p_manual + 1)
    ON CONFLICT (org_id, kind, year) DO UPDATE SET next_no = greatest(c.next_no, EXCLUDED.next_no), updated_at = now();
    IF EXISTS (SELECT 1 FROM public.kp_doc_ttn AS t WHERE t.org_id = p_org AND t.doc_year = p_year AND t.number = p_manual) THEN
      RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = p_manual::text;
    END IF;
    RETURN p_manual;
  END IF;
  LOOP
    INSERT INTO public.kp_doc_counters AS c (org_id, kind, year, next_no)
    VALUES (p_org, 'ttn', p_year, 2)
    ON CONFLICT (org_id, kind, year) DO UPDATE SET next_no = c.next_no + 1, updated_at = now()
    RETURNING c.next_no - 1 INTO v_no;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.kp_doc_ttn AS t WHERE t.org_id = p_org AND t.doc_year = p_year AND t.number = v_no);
  END LOOP;
  RETURN v_no;
END;
$$;

-- ---------------------------------------------------------------------------
-- Vehicles and drivers
-- ---------------------------------------------------------------------------

-- Авто організації з полями ТЗ і строками документів (для бейджа ТО / страхування). Директор читає fleet_vehicles лише
-- так (RLS сайту його не пускає).
CREATE OR REPLACE FUNCTION public.kp_vehicles_list()
RETURNS TABLE (
  id uuid, label text, make_model text, vehicle_type text, trailer_plate text, trailer_type text, trailer_make_model text,
  length_m numeric, width_m numeric, height_m numeric, tare_t numeric, max_mass_t numeric, payload_t numeric,
  default_driver_id uuid, default_driver_name text,
  oscpv_on date, kasko_on date, green_card_on date, inspection_on date, tachograph_on date, service_on date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY
  SELECT fv.id, fv.label, fv.make_model, fv.vehicle_type, fv.trailer_plate, fv.trailer_type, fv.trailer_make_model,
         fv.length_m, fv.width_m, fv.height_m, fv.tare_t, fv.max_mass_t, fv.payload_t,
         d.id, d.full_name,
         fv.oscpv_on, fv.kasko_on, fv.green_card_on, fv.inspection_on, fv.tachograph_on, fv.service_on
  FROM public.fleet_vehicles AS fv
  LEFT JOIN public.kp_drivers AS d ON d.id = fv.default_driver_id AND d.org_id = v_org
  WHERE fv.org_id = v_org
  ORDER BY lower(fv.label)
  LIMIT 1000;
END;
$$;

-- Лише нові ТТН-колонки авто своєї організації (owner / logist). Ключа немає — значення лишається; null / '' — очистити.
CREATE OR REPLACE FUNCTION public.kp_vehicle_save(p_vehicle uuid, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.fleet_vehicles%ROWTYPE;
  v_type text;
  v_trailer text;
  v_len numeric;
  v_wid numeric;
  v_hgt numeric;
  v_tare numeric;
  v_max numeric;
  v_driver uuid;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'VEHICLE_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_old FROM public.fleet_vehicles WHERE id = p_vehicle AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_type := CASE WHEN p_data ? 'vehicle_type' THEN public.kp_ttn_text(p_data ->> 'vehicle_type', 100, 'vehicle_type') ELSE v_old.vehicle_type END;
  v_trailer := CASE WHEN p_data ? 'trailer_make_model' THEN public.kp_ttn_text(p_data ->> 'trailer_make_model', 100, 'trailer_make_model') ELSE v_old.trailer_make_model END;
  v_len := CASE WHEN p_data ? 'length_m' THEN public.kp_ttn_num(p_data ->> 'length_m', 0, 30, 2, 'length_m', 'VEHICLE_FIELD_INVALID') ELSE v_old.length_m END;
  v_wid := CASE WHEN p_data ? 'width_m' THEN public.kp_ttn_num(p_data ->> 'width_m', 0, 30, 2, 'width_m', 'VEHICLE_FIELD_INVALID') ELSE v_old.width_m END;
  v_hgt := CASE WHEN p_data ? 'height_m' THEN public.kp_ttn_num(p_data ->> 'height_m', 0, 30, 2, 'height_m', 'VEHICLE_FIELD_INVALID') ELSE v_old.height_m END;
  v_tare := CASE WHEN p_data ? 'tare_t' THEN public.kp_ttn_num(p_data ->> 'tare_t', 0, 100, 3, 'tare_t', 'VEHICLE_FIELD_INVALID') ELSE v_old.tare_t END;
  v_max := CASE WHEN p_data ? 'max_mass_t' THEN public.kp_ttn_num(p_data ->> 'max_mass_t', 0, 100, 3, 'max_mass_t', 'VEHICLE_FIELD_INVALID') ELSE v_old.max_mass_t END;
  IF v_tare IS NOT NULL AND v_max IS NOT NULL AND v_tare >= v_max THEN
    RAISE EXCEPTION 'VEHICLE_FIELD_INVALID:tare_t' USING ERRCODE = 'P0001', DETAIL = 'tare must be below the maximum mass';
  END IF;
  IF p_data ? 'default_driver_id' THEN
    BEGIN
      v_driver := nullif(p_data ->> 'default_driver_id', '')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'VEHICLE_FIELD_INVALID:default_driver_id' USING ERRCODE = 'P0001';
    END;
    IF v_driver IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.kp_drivers AS d WHERE d.id = v_driver AND d.org_id = v_org) THEN
      RAISE EXCEPTION 'VEHICLE_DRIVER_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    v_driver := v_old.default_driver_id;
  END IF;

  -- Лише ТТН-колонки: fleet_vehicles_guard пропускає логіста тільки з такою зміною, водія перевіряє
  -- trg_fleet_vehicles_guard_driver. Claims користувача не змінюються.
  UPDATE public.fleet_vehicles
  SET vehicle_type = v_type, trailer_make_model = v_trailer, length_m = v_len, width_m = v_wid, height_m = v_hgt,
      tare_t = v_tare, max_mass_t = v_max, default_driver_id = v_driver
  WHERE id = p_vehicle AND org_id = v_org;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_driver_list(p_active_only boolean DEFAULT true)
RETURNS TABLE (id uuid, full_name text, license_no text, active boolean, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY
  SELECT d.id, d.full_name, d.license_no, d.active, d.created_at
  FROM public.kp_drivers AS d
  WHERE d.org_id = v_org AND (NOT coalesce(p_active_only, true) OR d.active)
  ORDER BY d.active DESC, lower(d.full_name)
  LIMIT 500;
END;
$$;

-- p_id NULL — новий водій (до 500 в організації); інакше — зміна свого. Видалення немає: active = false.
CREATE OR REPLACE FUNCTION public.kp_driver_save(p_id uuid, p_full_name text, p_license_no text, p_active boolean DEFAULT true)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_name text;
  v_license text;
  v_id uuid;
BEGIN
  v_name := nullif(regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g'), '');
  v_license := nullif(upper(regexp_replace(coalesce(p_license_no, ''), '\s', '', 'g')), '');
  IF v_name IS NULL OR char_length(v_name) > 200 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'DRIVER_BAD_NAME' USING ERRCODE = 'P0001';
  END IF;
  IF v_license IS NOT NULL AND (char_length(v_license) > 30 OR v_license ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'DRIVER_BAD_LICENSE' USING ERRCODE = 'P0001';
  END IF;
  IF p_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kp_drivers:' || v_org::text, 0));
    IF (SELECT count(*) FROM public.kp_drivers AS d WHERE d.org_id = v_org) >= 500 THEN
      RAISE EXCEPTION 'DRIVER_LIMIT' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.kp_drivers (org_id, full_name, license_no, active, created_by)
    VALUES (v_org, v_name, v_license, coalesce(p_active, true), auth.uid())
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.kp_drivers
  SET full_name = v_name, license_no = v_license, active = coalesce(p_active, true), updated_at = now()
  WHERE id = p_id AND org_id = v_org
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Waybill: prefill, number hint, create, read, list, cancel
-- ---------------------------------------------------------------------------

-- Підказки для форми, нічого не пише. Замовник — клієнт; вантажовідправник і вантажоодержувач — порожні (лише
-- варіанти «клієнт» / «наша компанія»); перевізник — наші реквізити. Рейс (необовʼязково) — рейс цієї організації
-- цього клієнта: авто рейсу (p_vehicle або перше за тоннажем), водій за замовчуванням, пункти маршруту, тоннаж авто.
CREATE OR REPLACE FUNCTION public.kp_ttn_prefill(p_calculation uuid, p_client uuid, p_vehicle uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_req public.kp_org_requisites%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_calc public.calculations%ROWTYPE;
  v_vehicle_id uuid;
  v_tonnage numeric;
  v_fv public.fleet_vehicles%ROWTYPE;
  v_driver public.kp_drivers%ROWTYPE;
  v_ours jsonb;
  v_theirs jsonb;
  v_vehicles jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_client FROM public.clients WHERE id = p_client AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  v_ours := CASE WHEN v_req.org_id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'name', v_req.legal_name, 'code', coalesce(v_req.edrpou, v_req.ipn), 'address', v_req.legal_address)) END;
  v_theirs := jsonb_strip_nulls(jsonb_build_object(
    'name', coalesce(v_client.legal_name, v_client.name), 'code', coalesce(v_client.edrpou, v_client.ipn), 'address', v_client.legal_address));

  IF p_calculation IS NOT NULL THEN
    SELECT c.* INTO v_calc
    FROM public.calculations AS c JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
    WHERE c.id = p_calculation AND c.org_id = v_org AND cc.client_id = p_client AND public.kp_trip_visible(c.user_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', fv.id, 'label', fv.label, 'tonnage', cv.tonnage) ORDER BY cv.tonnage DESC, fv.label), '[]'::jsonb)
    INTO v_vehicles
    FROM public.calc_vehicles AS cv JOIN public.fleet_vehicles AS fv ON fv.id = cv.vehicle_id AND fv.org_id = v_org
    WHERE cv.calc_id = p_calculation;
    SELECT cv.vehicle_id, cv.tonnage INTO v_vehicle_id, v_tonnage
    FROM public.calc_vehicles AS cv JOIN public.fleet_vehicles AS fv ON fv.id = cv.vehicle_id AND fv.org_id = v_org
    WHERE cv.calc_id = p_calculation AND (p_vehicle IS NULL OR cv.vehicle_id = p_vehicle)
    ORDER BY cv.tonnage DESC, fv.label
    LIMIT 1;
  END IF;
  IF v_vehicle_id IS NULL AND p_vehicle IS NOT NULL THEN
    v_vehicle_id := p_vehicle;
  END IF;
  IF v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_fv FROM public.fleet_vehicles WHERE id = v_vehicle_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_driver FROM public.kp_drivers WHERE id = v_fv.default_driver_id AND org_id = v_org AND active;
  END IF;

  RETURN jsonb_build_object(
    'next_number', public.kp_ttn_next_number(public.ua_today()),
    'prefix', v_req.ttn_prefix,
    'place_of_issue', v_req.doc_place,
    'carrier', v_ours,
    'customer', v_theirs,
    'party_options', jsonb_build_object('client', v_theirs, 'ours', v_ours),
    'calculation', CASE WHEN v_calc.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_calc.id, 'trip_date', v_calc.trip_date, 'name', v_calc.name, 'route_from', v_calc.route_from,
      'route_to', v_calc.route_to, 'tonnage', v_calc.tonnage) END,
    'load_point', v_calc.route_from,
    'unload_point', v_calc.route_to,
    'cargo_net_t', CASE WHEN v_tonnage > 0 THEN round(v_tonnage, 3) WHEN v_calc.tonnage > 0 AND jsonb_array_length(v_vehicles) <= 1 THEN round(v_calc.tonnage, 3) END,
    'vehicles', v_vehicles,
    'vehicle_id', v_fv.id,
    'vehicle', CASE WHEN v_fv.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
      'make_model', v_fv.make_model, 'type', v_fv.vehicle_type, 'reg_number', v_fv.label,
      'trailer_make_model', v_fv.trailer_make_model, 'trailer_type', v_fv.trailer_type, 'trailer_reg_number', v_fv.trailer_plate,
      'length_m', v_fv.length_m, 'width_m', v_fv.width_m, 'height_m', v_fv.height_m)) END,
    'tare_t', v_fv.tare_t,
    'max_mass_t', v_fv.max_mass_t,
    'driver', CASE WHEN v_driver.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
      'id', v_driver.id, 'full_name', v_driver.full_name, 'license_no', v_driver.license_no)) END
  );
END;
$$;

-- Наступний автоматичний номер ТТН (лише підказка; справжній береться при створенні).
CREATE OR REPLACE FUNCTION public.kp_ttn_next_number(p_doc_date date)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_year integer;
  v_no integer;
BEGIN
  IF p_doc_date IS NULL THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  v_year := extract(year FROM p_doc_date)::integer;
  SELECT c.next_no INTO v_no FROM public.kp_doc_counters AS c WHERE c.org_id = v_org AND c.kind = 'ttn' AND c.year = v_year;
  v_no := coalesce(v_no, 1);
  WHILE EXISTS (SELECT 1 FROM public.kp_doc_ttn AS t WHERE t.org_id = v_org AND t.doc_year = v_year AND t.number = v_no) LOOP
    v_no := v_no + 1;
  END LOOP;
  RETURN v_no;
END;
$$;

-- Створення ТТН. Обовʼязкові реквізити ст. 48 Закону «Про автомобільний транспорт» перевіряє сервер
-- (TTN_FIELD_REQUIRED:<поле>): місце складання; вантажовідправник і вантажоодержувач (назва + код); перевізник — наші
-- реквізити (REQUISITES_REQUIRED без назви чи коду); водій (ПІБ, посвідчення); ТЗ (марка / модель, тип, номер; причіп —
-- якщо вказано його номер); довжина, ширина, висота; тара і маса брутто вантажу (загальна маса = тара + брутто —
-- рахує сервер); пункти навантаження й розвантаження. Кілька ТТН на один рейс дозволено. p_id — id з /api/docs/assets
-- (знімок підпису й печатки перевізника, як у kp_doc_create). Помилка до вставки не зсуває лічильник (відкат).
CREATE OR REPLACE FUNCTION public.kp_ttn_create(
  p_client uuid, p_doc_date date, p_number integer DEFAULT NULL, p_data jsonb DEFAULT NULL,
  p_calculation uuid DEFAULT NULL, p_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_req public.kp_org_requisites%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_doc uuid := coalesce(p_id, gen_random_uuid());
  v_data jsonb := p_data;
  v_place text;
  v_shipper jsonb;
  v_consignee jsonb;
  v_customer jsonb;
  v_forwarder jsonb;
  v_carrier jsonb;
  v_driver_in jsonb;
  v_driver_id uuid;
  v_drv public.kp_drivers%ROWTYPE;
  v_driver_name text;
  v_driver_license text;
  v_vin jsonb;
  v_vehicle_id uuid;
  v_vehicle jsonb;
  v_make text;
  v_type text;
  v_reg text;
  v_t_make text;
  v_t_type text;
  v_t_reg text;
  v_len numeric;
  v_wid numeric;
  v_hgt numeric;
  v_tare numeric;
  v_max numeric;
  v_net numeric;
  v_gross numeric;
  v_load text;
  v_unload text;
  v_places integer;
  v_total numeric;
  v_vat numeric;
  v_ops jsonb := '[]'::jsonb;
  v_op jsonb;
  v_op_kind text;
  v_lines jsonb;
  v_line jsonb;
  v_n integer := 0;
  v_line_gross numeric;
  v_gross_sum numeric := 0;
  v_all_gross boolean := true;
  v_sig text;
  v_stamp text;
  v_year integer;
  v_no integer;
BEGIN
  IF p_doc_date IS NULL OR p_doc_date < DATE '2000-01-01' OR p_doc_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  IF NOT FOUND OR (v_req.edrpou IS NULL AND v_req.ipn IS NULL) THEN
    RAISE EXCEPTION 'REQUISITES_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_client FROM public.clients WHERE id = p_client AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_client.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'CLIENT_ARCHIVED' USING ERRCODE = 'P0001';
  END IF;
  IF v_data IS NULL OR jsonb_typeof(v_data) <> 'object' THEN
    RAISE EXCEPTION 'TTN_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  IF p_calculation IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calculations AS c JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
    WHERE c.id = p_calculation AND c.org_id = v_org AND cc.client_id = p_client AND public.kp_trip_visible(c.user_id)
  ) THEN
    RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  -- Місце складання і сторони.
  v_place := public.kp_ttn_text(v_data ->> 'place_of_issue', 200, 'place_of_issue');
  IF v_place IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:place_of_issue' USING ERRCODE = 'P0001';
  END IF;
  v_shipper := public.kp_ttn_party(v_data -> 'shipper', 'shipper', true);
  v_consignee := public.kp_ttn_party(v_data -> 'consignee', 'consignee', true);
  v_customer := public.kp_ttn_party(v_data -> 'customer', 'customer', false);
  v_forwarder := public.kp_ttn_party(v_data -> 'forwarder', 'forwarder', false);

  -- Водій: з довідника (свого) або вручну; надруковане — знімок.
  v_driver_in := coalesce(v_data -> 'driver', '{}'::jsonb);
  IF jsonb_typeof(v_driver_in) <> 'object' THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:driver' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_driver_id := nullif(v_driver_in ->> 'id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:driver.id' USING ERRCODE = 'P0001';
  END;
  IF v_driver_id IS NOT NULL THEN
    SELECT * INTO v_drv FROM public.kp_drivers WHERE id = v_driver_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TTN_DRIVER_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_driver_name := coalesce(public.kp_ttn_text(v_driver_in ->> 'full_name', 200, 'driver.full_name'), v_drv.full_name);
  v_driver_license := coalesce(public.kp_ttn_text(v_driver_in ->> 'license_no', 30, 'driver.license_no'), v_drv.license_no);
  IF v_driver_name IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:driver.full_name' USING ERRCODE = 'P0001';
  END IF;
  IF v_driver_license IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:driver.license_no' USING ERRCODE = 'P0001';
  END IF;

  -- Транспортний засіб.
  v_vin := coalesce(v_data -> 'vehicle', '{}'::jsonb);
  IF jsonb_typeof(v_vin) <> 'object' THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:vehicle' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_vehicle_id := nullif(v_data ->> 'vehicle_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:vehicle_id' USING ERRCODE = 'P0001';
  END;
  IF v_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fleet_vehicles AS fv WHERE fv.id = v_vehicle_id AND fv.org_id = v_org) THEN
    RAISE EXCEPTION 'TTN_VEHICLE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  v_make := public.kp_ttn_text(v_vin ->> 'make_model', 100, 'vehicle.make_model');
  v_type := public.kp_ttn_text(v_vin ->> 'type', 100, 'vehicle.type');
  v_reg := upper(public.kp_ttn_text(v_vin ->> 'reg_number', 20, 'vehicle.reg_number'));
  v_t_make := public.kp_ttn_text(v_vin ->> 'trailer_make_model', 100, 'vehicle.trailer_make_model');
  v_t_type := public.kp_ttn_text(v_vin ->> 'trailer_type', 100, 'vehicle.trailer_type');
  v_t_reg := upper(public.kp_ttn_text(v_vin ->> 'trailer_reg_number', 20, 'vehicle.trailer_reg_number'));
  IF v_make IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.make_model' USING ERRCODE = 'P0001';
  END IF;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.type' USING ERRCODE = 'P0001';
  END IF;
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.reg_number' USING ERRCODE = 'P0001';
  END IF;
  -- Причіп / напівпричіп — якщо він є (вказано номер або марку): марка / модель, тип і номер обовʼязкові.
  IF v_t_reg IS NOT NULL OR v_t_make IS NOT NULL THEN
    IF v_t_make IS NULL THEN
      RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.trailer_make_model' USING ERRCODE = 'P0001';
    END IF;
    IF v_t_type IS NULL THEN
      RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.trailer_type' USING ERRCODE = 'P0001';
    END IF;
    IF v_t_reg IS NULL THEN
      RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.trailer_reg_number' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_len := public.kp_ttn_num(v_vin ->> 'length_m', 0, 30, 2, 'vehicle.length_m', 'TTN_FIELD_INVALID');
  v_wid := public.kp_ttn_num(v_vin ->> 'width_m', 0, 30, 2, 'vehicle.width_m', 'TTN_FIELD_INVALID');
  v_hgt := public.kp_ttn_num(v_vin ->> 'height_m', 0, 30, 2, 'vehicle.height_m', 'TTN_FIELD_INVALID');
  IF v_len IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.length_m' USING ERRCODE = 'P0001';
  END IF;
  IF v_wid IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.width_m' USING ERRCODE = 'P0001';
  END IF;
  IF v_hgt IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:vehicle.height_m' USING ERRCODE = 'P0001';
  END IF;

  -- Маса: тара ТЗ + маса брутто вантажу = загальна маса з вантажем (рахує сервер).
  v_tare := public.kp_ttn_num(v_data ->> 'tare_t', 0, 100, 3, 'tare_t', 'TTN_FIELD_INVALID');
  v_max := public.kp_ttn_num(v_data ->> 'max_mass_t', 0, 100, 3, 'max_mass_t', 'TTN_FIELD_INVALID');
  v_net := public.kp_ttn_num(v_data ->> 'cargo_net_t', 0, 1000, 3, 'cargo_net_t', 'TTN_FIELD_INVALID');
  v_gross := public.kp_ttn_num(v_data ->> 'cargo_gross_t', 0, 1000, 3, 'cargo_gross_t', 'TTN_FIELD_INVALID');
  IF v_tare IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:tare_t' USING ERRCODE = 'P0001';
  END IF;
  IF v_gross IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:cargo_gross_t' USING ERRCODE = 'P0001';
  END IF;
  IF v_net IS NOT NULL AND v_net > v_gross THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:cargo_net_t' USING ERRCODE = 'P0001', DETAIL = 'net above gross';
  END IF;

  v_load := public.kp_ttn_text(v_data ->> 'load_point', 500, 'load_point');
  v_unload := public.kp_ttn_text(v_data ->> 'unload_point', 500, 'unload_point');
  IF v_load IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:load_point' USING ERRCODE = 'P0001';
  END IF;
  IF v_unload IS NULL THEN
    RAISE EXCEPTION 'TTN_FIELD_REQUIRED:unload_point' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_places := nullif(btrim(coalesce(v_data ->> 'places_count', '')), '')::integer;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:places_count' USING ERRCODE = 'P0001';
  END;
  IF v_places IS NOT NULL AND (v_places < 0 OR v_places > 1000000) THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:places_count' USING ERRCODE = 'P0001';
  END IF;
  v_total := public.kp_ttn_num(v_data ->> 'total_amount', -0.001, 999999999.99, 2, 'total_amount', 'TTN_FIELD_INVALID');
  v_vat := public.kp_ttn_num(v_data ->> 'vat_amount', -0.001, 999999999.99, 2, 'vat_amount', 'TTN_FIELD_INVALID');
  IF v_vat IS NOT NULL AND (v_total IS NULL OR v_vat > v_total) THEN
    RAISE EXCEPTION 'TTN_FIELD_INVALID:vat_amount' USING ERRCODE = 'P0001';
  END IF;

  -- Вантажно-розвантажувальні операції: до двох рядків (load / unload), маса брутто / тара / нетто і час.
  IF v_data ? 'operations' AND jsonb_typeof(v_data -> 'operations') <> 'null' THEN
    IF jsonb_typeof(v_data -> 'operations') <> 'array' OR jsonb_array_length(v_data -> 'operations') > 2 THEN
      RAISE EXCEPTION 'TTN_FIELD_INVALID:operations' USING ERRCODE = 'P0001';
    END IF;
    FOR v_op IN SELECT e.value FROM jsonb_array_elements(v_data -> 'operations') WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
      v_op_kind := v_op ->> 'op';
      IF jsonb_typeof(v_op) <> 'object' OR v_op_kind IS NULL OR v_op_kind NOT IN ('load', 'unload')
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ops) AS x(o) WHERE x.o ->> 'op' = v_op_kind) THEN
        RAISE EXCEPTION 'TTN_FIELD_INVALID:operations' USING ERRCODE = 'P0001';
      END IF;
      v_ops := v_ops || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'op', v_op_kind,
        'gross_t', public.kp_ttn_num(v_op ->> 'gross_t', 0, 1000, 3, 'operations.gross_t', 'TTN_FIELD_INVALID'),
        'tare_t', public.kp_ttn_num(v_op ->> 'tare_t', 0, 1000, 3, 'operations.tare_t', 'TTN_FIELD_INVALID'),
        'net_t', public.kp_ttn_num(v_op ->> 'net_t', 0, 1000, 3, 'operations.net_t', 'TTN_FIELD_INVALID'),
        'arrival', public.kp_ttn_text(v_op ->> 'arrival', 20, 'operations.arrival'),
        'departure', public.kp_ttn_text(v_op ->> 'departure', 20, 'operations.departure'),
        'idle', public.kp_ttn_text(v_op ->> 'idle', 20, 'operations.idle'))));
    END LOOP;
  END IF;

  -- Рядки вантажу: 1…50, усе перевіряємо до будь-якого запису.
  v_lines := v_data -> 'lines';
  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'TTN_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'count';
  END IF;
  FOR v_line IN SELECT e.value FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(v_line) <> 'object' OR public.kp_ttn_text(v_line ->> 'cargo_name', 500, 'lines.cargo_name') IS NULL THEN
      RAISE EXCEPTION 'TTN_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n;
    END IF;
    PERFORM public.kp_ttn_text(v_line ->> 'animal_id', 100, 'lines.animal_id'),
            public.kp_ttn_text(v_line ->> 'animal_kind', 100, 'lines.animal_kind'),
            public.kp_ttn_text(v_line ->> 'temperature', 50, 'lines.temperature'),
            public.kp_ttn_text(v_line ->> 'unit', 20, 'lines.unit'),
            public.kp_ttn_text(v_line ->> 'packaging', 100, 'lines.packaging'),
            public.kp_ttn_text(v_line ->> 'docs', 300, 'lines.docs'),
            public.kp_ttn_num(v_line ->> 'places', -1, 1000000, 0, 'lines.places', 'TTN_BAD_LINES'),
            public.kp_ttn_num(v_line ->> 'price', -0.001, 1000000000, 2, 'lines.price', 'TTN_BAD_LINES'),
            public.kp_ttn_num(v_line ->> 'amount', -0.001, 999999999.99, 2, 'lines.amount', 'TTN_BAD_LINES');
    IF coalesce((v_line ->> 'owner_price')::boolean, false) AND nullif(v_line ->> 'price', '') IS NOT NULL THEN
      RAISE EXCEPTION 'TTN_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n || ': owner price without a price';
    END IF;
    v_line_gross := public.kp_ttn_num(v_line ->> 'gross_t', 0, 1000, 3, 'lines.gross_t', 'TTN_BAD_LINES');
    IF v_line_gross IS NULL THEN
      v_all_gross := false;
    ELSE
      v_gross_sum := v_gross_sum + v_line_gross;
    END IF;
  END LOOP;
  -- Маса брутто в рядках (якщо вказана в кожному) = маса брутто вантажу.
  IF v_all_gross AND v_gross_sum <> v_gross THEN
    RAISE EXCEPTION 'TTN_MASS_MISMATCH' USING ERRCODE = 'P0001', DETAIL = v_gross_sum::text || ' <> ' || v_gross::text;
  END IF;

  -- Знімок підпису й печатки перевізника (як у kp_doc_create).
  IF p_id IS NOT NULL AND (EXISTS (SELECT 1 FROM public.kp_doc_ttn AS t WHERE t.id = p_id)
                           OR EXISTS (SELECT 1 FROM public.kp_documents AS d WHERE d.id = p_id)) THEN
    RAISE EXCEPTION 'DOC_ID_TAKEN' USING ERRCODE = 'P0001';
  END IF;
  v_sig := CASE WHEN v_req.signature_path IS NOT NULL
    THEN v_org::text || '/docs/' || v_doc::text || '/signature.' || substring(v_req.signature_path FROM '\.(png|jpg)$') END;
  v_stamp := CASE WHEN v_req.stamp_path IS NOT NULL
    THEN v_org::text || '/docs/' || v_doc::text || '/stamp.' || substring(v_req.stamp_path FROM '\.(png|jpg)$') END;
  IF (v_sig IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_sig))
     OR (v_stamp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_stamp)) THEN
    RAISE EXCEPTION 'DOC_ASSETS_NOT_COPIED' USING ERRCODE = 'P0001';
  END IF;

  v_carrier := jsonb_strip_nulls(jsonb_build_object(
    'name', v_req.legal_name, 'code', coalesce(v_req.edrpou, v_req.ipn), 'address', v_req.legal_address,
    'signer_name', v_req.signer_name, 'signer_position', v_req.signer_position,
    'signature_path', v_sig, 'stamp_path', v_stamp));
  v_vehicle := jsonb_strip_nulls(jsonb_build_object(
    'make_model', v_make, 'type', v_type, 'reg_number', v_reg,
    'trailer_make_model', v_t_make, 'trailer_type', v_t_type, 'trailer_reg_number', v_t_reg,
    'length_m', v_len, 'width_m', v_wid, 'height_m', v_hgt, 'gross_total_t', v_tare + v_gross));

  v_year := extract(year FROM p_doc_date)::integer;
  v_no := public.kp_ttn_alloc_number(v_org, v_year, p_number);
  BEGIN
    INSERT INTO public.kp_doc_ttn (
      id, org_id, number, doc_year, prefix, doc_date, client_id, calculation_id, vehicle_id,
      place_of_issue, transport_kind, vehicle_parking_place, readdressing, seal_note,
      shipper, carrier, consignee, customer, forwarder, driver, vehicle, load_point, unload_point,
      places_count, cargo_net_t, cargo_gross_t, tare_t, total_mass_t, max_mass_t, accompanying_docs, total_amount, vat_amount,
      received_by, released_by, accepted_by, operations, created_by
    ) VALUES (
      v_doc, v_org, v_no, v_year, v_req.ttn_prefix, p_doc_date, p_client, p_calculation, v_vehicle_id,
      v_place,
      public.kp_ttn_text(v_data ->> 'transport_kind', 100, 'transport_kind'),
      public.kp_ttn_text(v_data ->> 'vehicle_parking_place', 500, 'vehicle_parking_place'),
      public.kp_ttn_text(v_data ->> 'readdressing', 500, 'readdressing'),
      public.kp_ttn_text(v_data ->> 'seal_note', 300, 'seal_note'),
      v_shipper, v_carrier, v_consignee, v_customer, v_forwarder,
      jsonb_build_object('full_name', v_driver_name, 'license_no', v_driver_license), v_vehicle, v_load, v_unload,
      v_places, v_net, v_gross, v_tare, v_tare + v_gross, v_max,
      public.kp_ttn_text(v_data ->> 'accompanying_docs', 500, 'accompanying_docs'), v_total, v_vat,
      public.kp_ttn_text(v_data ->> 'received_by', 300, 'received_by'),
      public.kp_ttn_text(v_data ->> 'released_by', 300, 'released_by'),
      public.kp_ttn_text(v_data ->> 'accepted_by', 300, 'accepted_by'),
      v_ops, auth.uid()
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = v_no::text;
  END;

  INSERT INTO public.kp_doc_ttn_lines (
    ttn_id, org_id, sort, cargo_name, animal_id, animal_kind, temperature, unit, places, price, owner_price, amount,
    packaging, docs, gross_t, bulk
  )
  SELECT v_doc, v_org, e.ord::smallint,
         public.kp_ttn_text(e.value ->> 'cargo_name', 500, 'lines.cargo_name'),
         public.kp_ttn_text(e.value ->> 'animal_id', 100, 'lines.animal_id'),
         public.kp_ttn_text(e.value ->> 'animal_kind', 100, 'lines.animal_kind'),
         public.kp_ttn_text(e.value ->> 'temperature', 50, 'lines.temperature'),
         public.kp_ttn_text(e.value ->> 'unit', 20, 'lines.unit'),
         public.kp_ttn_num(e.value ->> 'places', -1, 1000000, 0, 'lines.places', 'TTN_BAD_LINES')::integer,
         public.kp_ttn_num(e.value ->> 'price', -0.001, 1000000000, 2, 'lines.price', 'TTN_BAD_LINES'),
         coalesce((e.value ->> 'owner_price')::boolean, false),
         public.kp_ttn_num(e.value ->> 'amount', -0.001, 999999999.99, 2, 'lines.amount', 'TTN_BAD_LINES'),
         public.kp_ttn_text(e.value ->> 'packaging', 100, 'lines.packaging'),
         public.kp_ttn_text(e.value ->> 'docs', 300, 'lines.docs'),
         public.kp_ttn_num(e.value ->> 'gross_t', 0, 1000, 3, 'lines.gross_t', 'TTN_BAD_LINES'),
         coalesce((e.value ->> 'bulk')::boolean, false)
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(value, ord);
  RETURN v_doc;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_ttn_get(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_t public.kp_doc_ttn%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.kp_doc_ttn WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN (to_jsonb(v_t) - 'org_id') || jsonb_build_object(
    'kind', 'ttn',
    'number_text', coalesce(v_t.prefix, '') || v_t.number::text,
    'client_name', (SELECT cl.name FROM public.clients AS cl WHERE cl.id = v_t.client_id),
    'created_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.created_by),
    'cancelled_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_t.cancelled_by),
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'sort', l.sort, 'cargo_name', l.cargo_name, 'animal_id', l.animal_id, 'animal_kind', l.animal_kind,
               'temperature', l.temperature, 'unit', l.unit, 'places', l.places, 'price', l.price, 'owner_price', l.owner_price,
               'amount', l.amount, 'packaging', l.packaging, 'docs', l.docs, 'gross_t', l.gross_t, 'bulk', l.bulk)) ORDER BY l.sort)
      FROM public.kp_doc_ttn_lines AS l WHERE l.ttn_id = v_t.id
    ), '[]'::jsonb)
  );
END;
$$;

-- p_status: issued | cancelled | NULL. p_calculation — ТТН одного рейсу.
CREATE OR REPLACE FUNCTION public.kp_ttn_list(p_from date, p_to date, p_client uuid DEFAULT NULL, p_status text DEFAULT NULL, p_calculation uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, kind text, number integer, prefix text, number_text text, doc_date date, client_id uuid, client_name text,
  calculation_id uuid, vehicle_reg text, load_point text, unload_point text, cargo_gross_t numeric, total_mass_t numeric,
  total_amount numeric, status text, cancelled_at timestamptz, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('issued', 'cancelled') THEN
    RAISE EXCEPTION 'DOC_BAD_STATUS' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT t.id, 'ttn'::text, t.number, t.prefix, coalesce(t.prefix, '') || t.number::text, t.doc_date, t.client_id,
         coalesce(cl.name, t.customer ->> 'name'), t.calculation_id, t.vehicle ->> 'reg_number', t.load_point, t.unload_point,
         t.cargo_gross_t, t.total_mass_t, t.total_amount, t.status, t.cancelled_at, t.created_at
  FROM public.kp_doc_ttn AS t
  LEFT JOIN public.clients AS cl ON cl.id = t.client_id
  WHERE t.org_id = v_org
    AND t.doc_date BETWEEN p_from AND p_to
    AND (p_client IS NULL OR t.client_id = p_client)
    AND (p_status IS NULL OR t.status = p_status)
    AND (p_calculation IS NULL OR t.calculation_id = p_calculation)
  ORDER BY t.doc_date DESC, t.number DESC
  LIMIT 5000;
END;
$$;

-- Анулює лише власник; причина обовʼязкова. Номер не повторюється.
CREATE OR REPLACE FUNCTION public.kp_ttn_cancel(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_t public.kp_doc_ttn%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO v_t FROM public.kp_doc_ttn WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_t.status = 'cancelled' THEN
    RAISE EXCEPTION 'DOC_ALREADY_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'DOC_CANCEL_REASON' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_doc_ttn
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancelled_reason = v_reason
  WHERE id = p_id;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants on functions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  -- Внутрішні: тригери й хелпери — жодній ролі API.
  FOREACH f IN ARRAY ARRAY[
    'public.kp_doc_ttn_guard()',
    'public.kp_doc_ttn_lines_guard()',
    'public.kp_ttn_text(text, integer, text)',
    'public.kp_ttn_num(text, numeric, numeric, integer, text, text)',
    'public.kp_ttn_party(jsonb, text, boolean)',
    'public.kp_ttn_alloc_number(uuid, integer, integer)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
  END LOOP;
  -- Клієнтські RPC.
  FOREACH f IN ARRAY ARRAY[
    'public.kp_vehicles_list()',
    'public.kp_vehicle_save(uuid, jsonb)',
    'public.kp_driver_list(boolean)',
    'public.kp_driver_save(uuid, text, text, boolean)',
    'public.kp_ttn_prefill(uuid, uuid, uuid)',
    'public.kp_ttn_next_number(date)',
    'public.kp_ttn_create(uuid, date, integer, jsonb, uuid, uuid)',
    'public.kp_ttn_get(uuid)',
    'public.kp_ttn_list(date, date, uuid, text, uuid)',
    'public.kp_ttn_cancel(uuid, text)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;
