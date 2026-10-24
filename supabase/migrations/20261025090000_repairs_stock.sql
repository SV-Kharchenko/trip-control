-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+ (Етап 3a): ремонти і склад запчастин.
--
-- * org_repair_handlers — відповідальні за ремонти: призначені логісти організації і менеджери з ремонтів (до 2 на
--   організацію; не займають місць логістів, не є учасниками чи директорами цієї організації). Менеджер зʼявляється лише
--   через прийняте запрошення (repair_manager_invites, API Контроль+ зі service_role).
-- * kp_repairs_org_id / kp_repairs_role / kp_repairs_can_write / kp_repairs_context — доступ до розділу «Ремонти».
--   kp_org_id / kp_role / kp_can_write / kp_context НЕ змінюються: менеджер з ремонтів не бачить заявок, клієнтів, звітів, GPS.
-- * parts (довідник і залишки), part_receipts (приходи), repairs (ремонти), part_writeoffs (списання на ремонт),
--   stock_adjustments (коригування). Залишок не буває відʼємним; собівартість — рухома середньозважена:
--   прихід: avg = (qty·avg + q·ціна) / (qty + q); списання — за поточною avg (avg не змінюється);
--   сторно ремонту — як прихід за собівартістю списання. Списання не редагуються — лише сторно.
-- * Клієнти лише читають (RLS SELECT); пишуть лише функції нижче (SECURITY DEFINER) і service_role.
-- * Дані складу й ремонтів: org_id … ON DELETE RESTRICT (як clients): організацію з ними не видалити каскадом.
--   repairs.vehicle_id … ON DELETE SET NULL + vehicle_label: видалення авто на сайті працює як раніше, історія лишається.
--
-- Лише адитивно: нові таблиці, функції, тригери й політики на нових таблицях. Наявні таблиці, функції й політики
-- не змінюються. Ідемпотентно.

-- ---------------------------------------------------------------------------
-- Repair handlers (assigned logists, repair managers)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_repair_handlers (
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('logist', 'repair_manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_repair_handlers_user_idx ON public.org_repair_handlers (user_id, kind);

-- Запрошення менеджера з ремонтів: у БД лише sha256 токена (сам токен підписує API Контроль+, HMAC).
CREATE TABLE IF NOT EXISTS public.repair_manager_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz NULL,
  accepted_by uuid NULL,
  revoked_at timestamptz NULL,
  declined_at timestamptz NULL,
  CONSTRAINT repair_manager_invites_token_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS repair_manager_invites_org_idx ON public.repair_manager_invites (org_id, created_at DESC);

-- Місце менеджера: активний менеджер або чинне (не прийняте, не скасоване, не відхилене, не прострочене) запрошення.
CREATE OR REPLACE FUNCTION public.kp_repair_manager_seats(p_org uuid, p_except_user uuid, p_except_invite uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    SELECT count(*)::integer FROM public.org_repair_handlers AS h
    WHERE h.org_id = p_org AND h.kind = 'repair_manager' AND h.user_id IS DISTINCT FROM p_except_user
  ) + (
    SELECT count(*)::integer FROM public.repair_manager_invites AS i
    WHERE i.org_id = p_org AND i.id IS DISTINCT FROM p_except_invite
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION public.kp_repair_manager_seats(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Правила відповідальних — під блокуванням організації (як ліміти логістів і директорів).
CREATE OR REPLACE FUNCTION public.kp_guard_repair_handlers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = NEW.org_id FOR UPDATE;
  IF NOT public.org_has_plan(NEW.org_id, 'control_plus') THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind = 'repair_manager' THEN
    IF public.kp_repair_manager_seats(NEW.org_id, NEW.user_id, NULL) >= 2 THEN
      RAISE EXCEPTION 'REPAIR_MANAGER_LIMIT'
        USING ERRCODE = 'P0001', DETAIL = 'At most 2 repair managers (incl. pending invites) per organization';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id AND p.member_status = 'active'
    ) THEN
      RAISE EXCEPTION 'REPAIR_MANAGER_IS_MEMBER' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.org_directors AS d WHERE d.org_id = NEW.org_id AND d.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'REPAIR_MANAGER_IS_DIRECTOR' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id AND p.org_role = 'logist' AND p.member_status = 'active'
    ) THEN
      RAISE EXCEPTION 'REPAIR_HANDLER_NOT_LOGIST' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_guard_repair_handlers() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_guard_repair_handlers ON public.org_repair_handlers;
CREATE TRIGGER trg_kp_guard_repair_handlers
  BEFORE INSERT OR UPDATE ON public.org_repair_handlers
  FOR EACH ROW EXECUTE FUNCTION public.kp_guard_repair_handlers();

-- ---------------------------------------------------------------------------
-- Access helpers for the «Ремонти» tab
-- ---------------------------------------------------------------------------

-- Організація розділу «Ремонти»: як у Контроль+ (kp_org_id), інакше — організація на control_plus, де користувач
-- менеджер з ремонтів.
CREATE OR REPLACE FUNCTION public.kp_repairs_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    public.kp_org_id(),
    (
      SELECT h.org_id
      FROM public.org_repair_handlers AS h
      WHERE h.user_id = auth.uid()
        AND h.kind = 'repair_manager'
        AND public.org_has_plan(h.org_id, 'control_plus')
      ORDER BY h.created_at, h.org_id
      LIMIT 1
    )
  );
$$;

-- 'owner' | 'director' | 'logist' | 'repair_manager' | NULL.
CREATE OR REPLACE FUNCTION public.kp_repairs_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.kp_repairs_org_id() IS NULL THEN NULL
    WHEN public.kp_org_id() IS NOT NULL THEN public.kp_role()
    ELSE 'repair_manager'
  END;
$$;

-- Пишуть: власник і директор; призначений логіст (активний учасник); менеджер з ремонтів. Не заблоковані.
CREATE OR REPLACE FUNCTION public.kp_repairs_can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    NOT public.is_user_blocked()
    AND public.kp_repairs_org_id() IS NOT NULL
    AND public.org_has_plan(public.kp_repairs_org_id(), 'control_plus')
    AND (
      public.kp_repairs_role() IN ('owner', 'director')
      OR (
        public.kp_repairs_role() = 'logist'
        AND EXISTS (
          SELECT 1 FROM public.org_repair_handlers AS h
          WHERE h.org_id = public.kp_repairs_org_id() AND h.user_id = auth.uid() AND h.kind = 'logist'
        )
        AND EXISTS (
          SELECT 1 FROM public.profiles AS p
          WHERE p.id = auth.uid() AND p.org_id = public.kp_repairs_org_id() AND p.org_role = 'logist' AND p.member_status = 'active'
        )
      )
      OR (
        public.kp_repairs_role() = 'repair_manager'
        AND EXISTS (
          SELECT 1 FROM public.org_repair_handlers AS h
          WHERE h.org_id = public.kp_repairs_org_id() AND h.user_id = auth.uid() AND h.kind = 'repair_manager'
        )
      )
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.kp_repairs_context()
RETURNS TABLE (org_id uuid, org_name text, role text, can_write boolean, can_manage_handlers boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.kp_repairs_org_id(),
    (SELECT o.name FROM public.organizations AS o WHERE o.id = public.kp_repairs_org_id()),
    public.kp_repairs_role(),
    public.kp_repairs_can_write(),
    coalesce(public.kp_repairs_role() IN ('owner', 'director'), false) AND NOT public.is_user_blocked();
$$;

REVOKE ALL ON FUNCTION public.kp_repairs_org_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_repairs_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_repairs_can_write() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_repairs_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_repairs_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_repairs_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_repairs_can_write() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_repairs_context() TO authenticated, service_role;

-- Перевірки для функцій запису (внутрішні: клієнтам недоступні, викликаються з SECURITY DEFINER-функцій).
CREATE OR REPLACE FUNCTION public.kp_repairs_require_write()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.kp_repairs_can_write() THEN
    RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN public.kp_repairs_org_id();
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_repairs_require_manage()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.kp_repairs_can_write() OR coalesce(public.kp_repairs_role() NOT IN ('owner', 'director'), true) THEN
    RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN public.kp_repairs_org_id();
END;
$$;

REVOKE ALL ON FUNCTION public.kp_repairs_require_write() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_repairs_require_manage() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stock: parts, receipts, adjustments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  article text NULL CHECK (article IS NULL OR char_length(article) BETWEEN 1 AND 64),
  unit text NOT NULL DEFAULT 'шт' CHECK (char_length(unit) BETWEEN 1 AND 16),
  qty numeric(12,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  avg_cost numeric(14,4) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  min_qty numeric(12,3) NULL CHECK (min_qty IS NULL OR min_qty >= 0),
  notes text NULL CHECK (notes IS NULL OR char_length(notes) <= 1000),
  archived_at timestamptz NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS parts_org_article_uidx
  ON public.parts (org_id, lower(btrim(article))) WHERE article IS NOT NULL;
CREATE INDEX IF NOT EXISTS parts_org_name_idx ON public.parts (org_id, lower(name));

CREATE TABLE IF NOT EXISTS public.part_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  part_id uuid NOT NULL REFERENCES public.parts (id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'receipt' CHECK (kind IN ('receipt', 'opening')),
  qty numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  total numeric(14,2) NOT NULL CHECK (total >= 0),
  received_on date NOT NULL,
  supplier text NULL CHECK (supplier IS NULL OR char_length(supplier) <= 200),
  doc_number text NULL CHECK (doc_number IS NULL OR char_length(doc_number) <= 64),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  import_batch_id uuid NULL,
  reversed_at timestamptz NULL,
  reversed_by uuid NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS part_receipts_part_idx ON public.part_receipts (part_id, created_at);
CREATE INDEX IF NOT EXISTS part_receipts_org_idx ON public.part_receipts (org_id, received_on DESC);

CREATE TABLE IF NOT EXISTS public.stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  part_id uuid NOT NULL REFERENCES public.parts (id) ON DELETE RESTRICT,
  qty_delta numeric(12,3) NOT NULL CHECK (qty_delta <> 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_adjustments_part_idx ON public.stock_adjustments (part_id, created_at);

-- ---------------------------------------------------------------------------
-- Repairs and write-offs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.repairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  vehicle_id uuid NULL REFERENCES public.fleet_vehicles (id) ON DELETE SET NULL,
  vehicle_label text NOT NULL DEFAULT '' CHECK (char_length(vehicle_label) <= 40),
  repair_date date NOT NULL,
  odometer_km integer NULL CHECK (odometer_km IS NULL OR odometer_km BETWEEN 0 AND 10000000),
  works text NOT NULL CHECK (char_length(works) BETWEEN 1 AND 2000),
  provider text NULL CHECK (provider IS NULL OR char_length(provider) <= 200),
  service_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (service_cost >= 0),
  parts_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (parts_cost >= 0),
  total numeric(14,2) GENERATED ALWAYS AS (parts_cost + service_cost) STORED,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  voided_at timestamptz NULL,
  voided_by uuid NULL,
  void_reason text NULL CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repairs_org_date_idx ON public.repairs (org_id, repair_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS repairs_vehicle_idx ON public.repairs (vehicle_id, repair_date DESC) WHERE vehicle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.part_writeoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  repair_id uuid NOT NULL REFERENCES public.repairs (id) ON DELETE RESTRICT,
  part_id uuid NOT NULL REFERENCES public.parts (id) ON DELETE RESTRICT,
  qty numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  total numeric(14,2) NOT NULL CHECK (total >= 0),
  reversed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS part_writeoffs_repair_idx ON public.part_writeoffs (repair_id);
CREATE INDEX IF NOT EXISTS part_writeoffs_part_idx ON public.part_writeoffs (part_id, created_at);

-- Ремонт: авто лише своєї організації; автор і час створення — від сервера і не змінюються (межа сторно 24 год).
CREATE OR REPLACE FUNCTION public.kp_guard_repairs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.vehicle_id IS NULL THEN
      RAISE EXCEPTION 'REPAIR_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    SELECT fv.label INTO v_label FROM public.fleet_vehicles AS fv WHERE fv.id = NEW.vehicle_id AND fv.org_id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPAIR_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    NEW.vehicle_label := v_label;
    IF NOT public.is_service_role() THEN
      NEW.created_at := now();
      NEW.created_by := auth.uid();
    END IF;
  ELSE
    IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'REPAIR_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    IF NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id AND NEW.vehicle_id IS NOT NULL THEN
      SELECT fv.label INTO v_label FROM public.fleet_vehicles AS fv WHERE fv.id = NEW.vehicle_id AND fv.org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'REPAIR_VEHICLE_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
      NEW.vehicle_label := v_label;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_guard_repairs() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_guard_repairs ON public.repairs;
CREATE TRIGGER trg_kp_guard_repairs
  BEFORE INSERT OR UPDATE ON public.repairs
  FOR EACH ROW EXECUTE FUNCTION public.kp_guard_repairs();

-- ---------------------------------------------------------------------------
-- RLS and grants: clients read their organization; nobody writes directly
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_repair_handlers', 'parts', 'part_receipts', 'stock_adjustments', 'repairs', 'part_writeoffs',
                           'repair_manager_invites'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['org_repair_handlers', 'parts', 'part_receipts', 'stock_adjustments', 'repairs', 'part_writeoffs'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (org_id = public.kp_repairs_org_id())', t || '_select', t);
  END LOOP;
END;
$$;

-- Запрошення бачать лише власник і директор; без token_hash.
GRANT SELECT (id, org_id, email, invited_by, created_at, last_sent_at, expires_at, accepted_at, accepted_by, revoked_at, declined_at)
  ON public.repair_manager_invites TO authenticated;
DROP POLICY IF EXISTS repair_manager_invites_select ON public.repair_manager_invites;
CREATE POLICY repair_manager_invites_select ON public.repair_manager_invites
  FOR SELECT TO authenticated
  USING (org_id = public.kp_repairs_org_id() AND coalesce(public.kp_repairs_role() IN ('owner', 'director'), false));

-- ---------------------------------------------------------------------------
-- Stock movements (internal; the caller has locked the part row)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_stock_in(p_part uuid, p_qty numeric, p_price numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.parts AS p
  SET avg_cost = CASE WHEN p.qty + p_qty > 0 THEN round((p.qty * p.avg_cost + p_qty * p_price) / (p.qty + p_qty), 4) ELSE p.avg_cost END,
      qty = p.qty + p_qty,
      updated_at = now()
  WHERE p.id = p_part;
END;
$$;

-- Повертає собівартість одиниці (поточна avg); avg не змінюється. Нестача — STOCK_INSUFFICIENT (DETAIL: назва).
CREATE OR REPLACE FUNCTION public.kp_stock_out(p_part uuid, p_qty numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_part public.parts%ROWTYPE;
BEGIN
  SELECT * INTO v_part FROM public.parts WHERE id = p_part;
  IF v_part.qty < p_qty THEN
    RAISE EXCEPTION 'STOCK_INSUFFICIENT' USING ERRCODE = 'P0001', DETAIL = v_part.name;
  END IF;
  UPDATE public.parts SET qty = qty - p_qty, updated_at = now()
  WHERE id = p_part;
  RETURN v_part.avg_cost;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_stock_in(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_stock_out(uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Write functions (clients): org from kp_repairs_org_id(), never from the caller
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_part_upsert(
  p_id uuid, p_name text, p_article text, p_unit text, p_min_qty numeric, p_notes text, p_archived boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_article text := nullif(btrim(coalesce(p_article, '')), '');
  v_unit text := coalesce(nullif(btrim(coalesce(p_unit, '')), ''), 'шт');
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'PART_NAME' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    IF p_id IS NULL THEN
      IF (SELECT count(*) FROM public.parts WHERE org_id = v_org) >= 5000 THEN
        RAISE EXCEPTION 'PARTS_LIMIT' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.parts (org_id, name, article, unit, min_qty, notes, created_by)
      VALUES (v_org, v_name, v_article, v_unit, p_min_qty, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.parts
      SET name = v_name, article = v_article, unit = v_unit, min_qty = p_min_qty,
          notes = nullif(btrim(coalesce(p_notes, '')), ''),
          archived_at = CASE WHEN coalesce(p_archived, false) THEN coalesce(archived_at, now()) ELSE NULL END,
          updated_at = now()
      WHERE id = p_id AND org_id = v_org
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'PART_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'PART_ARTICLE_EXISTS' USING ERRCODE = 'P0001';
  END;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_part_receive(
  p_part uuid, p_qty numeric, p_unit_price numeric, p_date date, p_supplier text DEFAULT NULL, p_doc text DEFAULT NULL,
  p_note text DEFAULT NULL, p_kind text DEFAULT 'receipt'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_id uuid;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 OR p_qty > 1000000 OR p_unit_price IS NULL OR p_unit_price < 0 OR p_unit_price > 100000000 THEN
    RAISE EXCEPTION 'RECEIPT_BAD_VALUES' USING ERRCODE = 'P0001';
  END IF;
  IF p_date IS NULL OR p_date < DATE '2000-01-01' OR p_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(p_kind, 'receipt') NOT IN ('receipt', 'opening') THEN
    RAISE EXCEPTION 'RECEIPT_BAD_VALUES' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.parts WHERE id = p_part AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PART_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.part_receipts (org_id, part_id, kind, qty, unit_price, total, received_on, supplier, doc_number, note, created_by)
  VALUES (v_org, p_part, coalesce(p_kind, 'receipt'), p_qty, round(p_unit_price, 2), round(p_qty * p_unit_price, 2), p_date,
          nullif(btrim(coalesce(p_supplier, '')), ''), nullif(btrim(coalesce(p_doc, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  RETURNING id INTO v_id;
  PERFORM public.kp_stock_in(p_part, p_qty, round(p_unit_price, 2));
  RETURN v_id;
END;
$$;

-- Сторно приходу (власник / директор): лише якщо весь прихід ще на складі.
CREATE OR REPLACE FUNCTION public.kp_receipt_reverse(p_receipt uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_manage();
  v_r public.part_receipts%ROWTYPE;
  v_p public.parts%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM public.part_receipts WHERE id = p_receipt AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'RECEIPT_ALREADY_REVERSED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_p FROM public.parts WHERE id = v_r.part_id FOR UPDATE;
  IF v_p.qty < v_r.qty THEN
    RAISE EXCEPTION 'RECEIPT_ALREADY_USED' USING ERRCODE = 'P0001', DETAIL = v_p.name;
  END IF;
  UPDATE public.parts
  SET avg_cost = CASE WHEN qty - v_r.qty > 0 THEN greatest(0, round((qty * avg_cost - v_r.qty * v_r.unit_price) / (qty - v_r.qty), 4)) ELSE 0 END,
      qty = qty - v_r.qty,
      updated_at = now()
  WHERE id = v_r.part_id;
  UPDATE public.part_receipts SET reversed_at = now(), reversed_by = auth.uid() WHERE id = v_r.id;
  RETURN true;
END;
$$;

-- Ремонт зі списанням запчастин — одна транзакція: блокування запчастин FOR UPDATE у порядку id, перевірка всіх
-- залишків (усе або нічого), ремонт і списання за поточною середньою собівартістю.
-- p_parts: [{ "part_id": uuid, "qty": число }]; однакові запчастини сумуються.
CREATE OR REPLACE FUNCTION public.kp_repair_post(
  p_vehicle uuid, p_date date, p_odometer integer, p_works text, p_provider text, p_service_cost numeric, p_parts jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_repair uuid;
  v_need record;
  v_cost numeric;
  v_parts_cost numeric := 0;
  v_count integer;
  v_expected integer;
BEGIN
  IF p_date IS NULL OR p_date < DATE '2000-01-01' OR p_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_works, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'REPAIR_WORKS' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(p_service_cost, 0) < 0 OR coalesce(p_service_cost, 0) > 100000000 THEN
    RAISE EXCEPTION 'REPAIR_BAD_VALUES' USING ERRCODE = 'P0001';
  END IF;
  IF p_parts IS NOT NULL AND (jsonb_typeof(p_parts) <> 'array' OR jsonb_array_length(p_parts) > 100) THEN
    RAISE EXCEPTION 'REPAIR_BAD_PARTS' USING ERRCODE = 'P0001';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS kp_repair_need (part_id uuid PRIMARY KEY, qty numeric) ON COMMIT DROP;
  DELETE FROM kp_repair_need;
  BEGIN
    INSERT INTO kp_repair_need (part_id, qty)
    SELECT (e ->> 'part_id')::uuid, sum((e ->> 'qty')::numeric)
    FROM jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) AS e
    GROUP BY (e ->> 'part_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'REPAIR_BAD_PARTS' USING ERRCODE = 'P0001';
  END;
  IF EXISTS (SELECT 1 FROM kp_repair_need WHERE part_id IS NULL OR qty IS NULL OR qty <= 0 OR qty > 1000000) THEN
    RAISE EXCEPTION 'REPAIR_BAD_PARTS' USING ERRCODE = 'P0001';
  END IF;

  -- Блокування в стабільному порядку (id) — без взаємоблокувань між паралельними ремонтами.
  SELECT count(*)::integer INTO v_expected FROM kp_repair_need;
  SELECT count(*)::integer INTO v_count FROM (
    SELECT p.id FROM public.parts AS p
    WHERE p.org_id = v_org AND p.id IN (SELECT part_id FROM kp_repair_need)
    ORDER BY p.id
    FOR UPDATE
  ) AS locked;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'PART_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  -- Усі залишки — до будь-якого запису.
  FOR v_need IN
    SELECT n.part_id, n.qty, p.name, p.qty AS available
    FROM kp_repair_need AS n JOIN public.parts AS p ON p.id = n.part_id
    ORDER BY p.id
  LOOP
    IF v_need.available < v_need.qty THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT' USING ERRCODE = 'P0001', DETAIL = v_need.name;
    END IF;
  END LOOP;

  INSERT INTO public.repairs (org_id, vehicle_id, repair_date, odometer_km, works, provider, service_cost, created_by)
  VALUES (v_org, p_vehicle, p_date, p_odometer, btrim(p_works), nullif(btrim(coalesce(p_provider, '')), ''),
          round(coalesce(p_service_cost, 0), 2), auth.uid())
  RETURNING id INTO v_repair;

  FOR v_need IN SELECT n.part_id, n.qty FROM kp_repair_need AS n ORDER BY n.part_id LOOP
    v_cost := public.kp_stock_out(v_need.part_id, v_need.qty);
    INSERT INTO public.part_writeoffs (org_id, repair_id, part_id, qty, unit_cost, total)
    VALUES (v_org, v_repair, v_need.part_id, v_need.qty, v_cost, round(v_need.qty * v_cost, 2));
    v_parts_cost := v_parts_cost + round(v_need.qty * v_cost, 2);
  END LOOP;
  UPDATE public.repairs SET parts_cost = v_parts_cost WHERE id = v_repair;
  DELETE FROM kp_repair_need;
  RETURN v_repair;
END;
$$;

-- Описові поля ремонту (списання не змінюються — для них лише сторно). Власник / директор або автор.
CREATE OR REPLACE FUNCTION public.kp_repair_update(
  p_repair uuid, p_date date, p_odometer integer, p_works text, p_provider text, p_service_cost numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_r public.repairs%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM public.repairs WHERE id = p_repair AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPAIR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'posted' THEN
    RAISE EXCEPTION 'REPAIR_ALREADY_VOID' USING ERRCODE = 'P0001';
  END IF;
  IF public.kp_repairs_role() NOT IN ('owner', 'director') AND v_r.created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_date IS NULL OR p_date < DATE '2000-01-01' OR p_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_works, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'REPAIR_WORKS' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(p_service_cost, 0) < 0 OR coalesce(p_service_cost, 0) > 100000000 THEN
    RAISE EXCEPTION 'REPAIR_BAD_VALUES' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.repairs
  SET repair_date = p_date, odometer_km = p_odometer, works = btrim(p_works),
      provider = nullif(btrim(coalesce(p_provider, '')), ''), service_cost = round(coalesce(p_service_cost, 0), 2)
  WHERE id = p_repair;
  RETURN true;
END;
$$;

-- Сторно ремонту: списані кількості повертаються на склад за собівартістю списання (як прихід), статус 'void'.
-- Власник і директор — будь-коли; автор — лише поки now() < created_at + 24 години; інші — ні.
CREATE OR REPLACE FUNCTION public.kp_repair_void(p_repair uuid, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_r public.repairs%ROWTYPE;
  v_w record;
BEGIN
  SELECT * INTO v_r FROM public.repairs WHERE id = p_repair AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPAIR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'posted' THEN
    RAISE EXCEPTION 'REPAIR_ALREADY_VOID' USING ERRCODE = 'P0001';
  END IF;
  IF public.kp_repairs_role() NOT IN ('owner', 'director') THEN
    IF v_r.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF now() >= v_r.created_at + interval '24 hours' THEN
      RAISE EXCEPTION 'REPAIR_VOID_EXPIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  PERFORM 1 FROM public.parts AS p
  WHERE p.id IN (SELECT w.part_id FROM public.part_writeoffs AS w WHERE w.repair_id = v_r.id)
  ORDER BY p.id
  FOR UPDATE;
  FOR v_w IN
    SELECT w.id, w.part_id, w.qty, w.unit_cost FROM public.part_writeoffs AS w
    WHERE w.repair_id = v_r.id AND w.reversed_at IS NULL
    ORDER BY w.part_id
  LOOP
    PERFORM public.kp_stock_in(v_w.part_id, v_w.qty, v_w.unit_cost);
    UPDATE public.part_writeoffs SET reversed_at = now() WHERE id = v_w.id;
  END LOOP;
  UPDATE public.repairs
  SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = nullif(btrim(coalesce(p_reason, '')), '')
  WHERE id = v_r.id;
  RETURN true;
END;
$$;

-- Коригування залишку (власник / директор): +к-сть за ціною (за замовчуванням — поточна avg), −к-сть за avg.
CREATE OR REPLACE FUNCTION public.kp_stock_adjust(p_part uuid, p_qty_delta numeric, p_unit_cost numeric, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_manage();
  v_p public.parts%ROWTYPE;
  v_cost numeric;
  v_id uuid;
BEGIN
  IF p_qty_delta IS NULL OR p_qty_delta = 0 OR abs(p_qty_delta) > 1000000 OR (p_unit_cost IS NOT NULL AND p_unit_cost < 0) THEN
    RAISE EXCEPTION 'ADJUST_BAD_VALUES' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ADJUST_REASON' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_p FROM public.parts WHERE id = p_part AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PART_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_qty_delta > 0 THEN
    v_cost := round(coalesce(p_unit_cost, v_p.avg_cost), 4);
    PERFORM public.kp_stock_in(p_part, p_qty_delta, v_cost);
  ELSE
    v_cost := public.kp_stock_out(p_part, -p_qty_delta);
  END IF;
  INSERT INTO public.stock_adjustments (org_id, part_id, qty_delta, unit_cost, reason, created_by)
  VALUES (v_org, p_part, p_qty_delta, v_cost, btrim(p_reason), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Відповідальні: власник / директор призначають логістів; менеджер — лише через запрошення.
CREATE OR REPLACE FUNCTION public.kp_repair_handler_add(p_user uuid, p_kind text DEFAULT 'logist')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_manage();
BEGIN
  IF coalesce(p_kind, '') <> 'logist' THEN
    RAISE EXCEPTION 'REPAIR_HANDLER_KIND' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.org_repair_handlers AS h WHERE h.org_id = v_org AND h.user_id = p_user) THEN
    RAISE EXCEPTION 'REPAIR_HANDLER_EXISTS' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.org_repair_handlers (org_id, user_id, kind, created_by) VALUES (v_org, p_user, 'logist', auth.uid());
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_repair_handler_remove(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_manage();
BEGIN
  DELETE FROM public.org_repair_handlers AS h WHERE h.org_id = v_org AND h.user_id = p_user;
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_repairs_require_org()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_repairs_require_org() FROM PUBLIC, anon, authenticated, service_role;

-- Авто організації для форми ремонту (директор і менеджер не читають fleet_vehicles напряму).
CREATE OR REPLACE FUNCTION public.kp_repair_vehicles()
RETURNS TABLE (id uuid, label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  RETURN QUERY SELECT fv.id, fv.label FROM public.fleet_vehicles AS fv WHERE fv.org_id = v_org ORDER BY lower(fv.label) LIMIT 1000;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_repairs_list(p_from date, p_to date, p_vehicle uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, repair_date date, vehicle_id uuid, vehicle_label text, odometer_km integer, works text, provider text,
  service_cost numeric, parts_cost numeric, total numeric, status text, created_by uuid, created_at timestamptz,
  can_void boolean, parts jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
  v_manage boolean := coalesce(public.kp_repairs_role() IN ('owner', 'director'), false) AND public.kp_repairs_can_write();
  v_write boolean := public.kp_repairs_can_write();
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT r.id, r.repair_date, r.vehicle_id, coalesce(fv.label, r.vehicle_label), r.odometer_km, r.works, r.provider,
         r.service_cost, r.parts_cost, r.total, r.status, r.created_by, r.created_at,
         r.status = 'posted' AND (v_manage OR (v_write AND r.created_by = auth.uid() AND now() < r.created_at + interval '24 hours')),
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('part_id', w.part_id, 'name', p.name, 'unit', p.unit, 'qty', w.qty,
                                               'unit_cost', w.unit_cost, 'total', w.total) ORDER BY p.name)
           FROM public.part_writeoffs AS w JOIN public.parts AS p ON p.id = w.part_id
           WHERE w.repair_id = r.id
         ), '[]'::jsonb)
  FROM public.repairs AS r
  LEFT JOIN public.fleet_vehicles AS fv ON fv.id = r.vehicle_id
  WHERE r.org_id = v_org
    AND r.repair_date BETWEEN p_from AND p_to
    AND (p_vehicle IS NULL OR r.vehicle_id = p_vehicle)
  ORDER BY r.repair_date DESC, r.created_at DESC
  LIMIT 1000;
END;
$$;

-- Рух запчастини: приходи (+), списання (−), сторно, коригування.
CREATE OR REPLACE FUNCTION public.kp_part_history(p_part uuid)
RETURNS TABLE (moved_at timestamptz, on_date date, kind text, qty numeric, unit_cost numeric, total numeric, ref text, reversed boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.parts AS p WHERE p.id = p_part AND p.org_id = v_org) THEN
    RAISE EXCEPTION 'PART_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT r.created_at, r.received_on, r.kind, r.qty, r.unit_price::numeric, r.total,
           concat_ws(' · ', r.supplier, r.doc_number, r.note), r.reversed_at IS NOT NULL
    FROM public.part_receipts AS r WHERE r.part_id = p_part AND r.org_id = v_org
    UNION ALL
    SELECT w.created_at, rp.repair_date, 'writeoff', -w.qty, w.unit_cost, w.total,
           concat_ws(' · ', rp.vehicle_label, left(rp.works, 80)), w.reversed_at IS NOT NULL
    FROM public.part_writeoffs AS w JOIN public.repairs AS rp ON rp.id = w.repair_id
    WHERE w.part_id = p_part AND w.org_id = v_org
    UNION ALL
    SELECT a.created_at, (a.created_at AT TIME ZONE 'Europe/Kyiv')::date, 'adjustment', a.qty_delta, a.unit_cost,
           round(abs(a.qty_delta) * a.unit_cost, 2), a.reason, false
    FROM public.stock_adjustments AS a WHERE a.part_id = p_part AND a.org_id = v_org
  ) AS h
  ORDER BY 1 DESC
  LIMIT 500;
END;
$$;

-- Відповідальні: імʼя — усім учасникам розділу, email — лише власнику й директору.
CREATE OR REPLACE FUNCTION public.kp_repair_handlers_list()
RETURNS TABLE (user_id uuid, kind text, name text, email text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
  v_manage boolean := coalesce(public.kp_repairs_role() IN ('owner', 'director'), false);
BEGIN
  RETURN QUERY
  SELECT h.user_id, h.kind,
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                  CASE WHEN v_manage THEN split_part(u.email, '@', 1) ELSE 'Відповідальний' END),
         CASE WHEN v_manage THEN u.email ELSE NULL END,
         h.created_at
  FROM public.org_repair_handlers AS h
  LEFT JOIN auth.users AS u ON u.id = h.user_id
  WHERE h.org_id = v_org
  ORDER BY h.kind, h.created_at;
END;
$$;

-- Активні логісти організації, яких можна призначити (власник / директор).
CREATE OR REPLACE FUNCTION public.kp_repair_logist_candidates()
RETURNS TABLE (user_id uuid, email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_repairs_require_org();
BEGIN
  IF coalesce(public.kp_repairs_role() NOT IN ('owner', 'director'), true) THEN
    RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id, p.email FROM public.profiles AS p
  WHERE p.org_id = v_org AND p.org_role = 'logist' AND p.member_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.org_repair_handlers AS h WHERE h.org_id = v_org AND h.user_id = p.id)
  ORDER BY p.email;
END;
$$;

-- Дата 'YYYY-MM-DD' або NULL (без винятку на 2026-02-30 чи сміття).
CREATE OR REPLACE FUNCTION public.kp_try_date(p text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN p::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_try_date(text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CSV import of opening balances (dry run / commit)
-- ---------------------------------------------------------------------------
-- p_rows: [{ line, name, article, unit, qty, unit_price, date (YYYY-MM-DD), supplier, note }], до 2000 рядків.
-- Дедуплікація: артикул (lower(btrim)) — дубль у файлі = помилка обох рядків; наявний артикул — прихід до наявної
-- запчастини; без артикула — збіг за назвою серед запчастин без артикула (дубль назви без артикула у файлі — помилка).
-- p_commit = false нічого не пише; p_commit = true при будь-якій помилці — IMPORT_HAS_ERRORS, нічого не записано.
CREATE OR REPLACE FUNCTION public.kp_parts_import(p_rows jsonb, p_commit boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_batch uuid := gen_random_uuid();
  v_row record;
  v_result jsonb := '[]'::jsonb;
  v_errors integer := 0;
  v_new integer := 0;
  v_existing integer := 0;
  v_part uuid;
  v_today date := public.ua_today();
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'IMPORT_BAD_INPUT' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'IMPORT_TOO_LARGE' USING ERRCODE = 'P0001';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS kp_import_rows (
    n integer PRIMARY KEY, line integer, name text, article text, akey text, nkey text, unit text,
    qty numeric, price numeric, on_date date, supplier text, note text, errors text[], part_id uuid, status text
  ) ON COMMIT DROP;
  DELETE FROM kp_import_rows;

  INSERT INTO kp_import_rows (n, line, name, article, unit, supplier, note, errors)
  SELECT ord::integer,
         CASE WHEN (e ->> 'line') ~ '^[0-9]{1,6}$' THEN (e ->> 'line')::integer ELSE ord::integer END,
         btrim(coalesce(e ->> 'name', '')),
         nullif(btrim(coalesce(e ->> 'article', '')), ''),
         nullif(btrim(coalesce(e ->> 'unit', '')), ''),
         nullif(btrim(coalesce(e ->> 'supplier', '')), ''),
         nullif(btrim(coalesce(e ->> 'note', '')), ''),
         ARRAY[]::text[]
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, ord);

  -- Числа й дати — лише з валідних рядків (без винятків на «abc»).
  UPDATE kp_import_rows AS r SET
    qty = CASE WHEN (x.e ->> 'qty') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN (x.e ->> 'qty')::numeric END,
    price = CASE WHEN (x.e ->> 'unit_price') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN (x.e ->> 'unit_price')::numeric END,
    on_date = CASE WHEN coalesce(x.e ->> 'date', '') = '' THEN v_today
                   ELSE public.kp_try_date(x.e ->> 'date') END
  FROM (SELECT ord::integer AS n, e FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, ord)) AS x
  WHERE x.n = r.n;

  UPDATE kp_import_rows SET akey = lower(article), nkey = lower(name), unit = coalesce(unit, 'шт');

  UPDATE kp_import_rows SET errors = errors || 'Назва: 1–200 символів'::text WHERE char_length(name) NOT BETWEEN 1 AND 200;
  UPDATE kp_import_rows SET errors = errors || 'Артикул: до 64 символів'::text WHERE char_length(article) > 64;
  UPDATE kp_import_rows SET errors = errors || 'Одиниця: до 16 символів'::text WHERE char_length(unit) > 16;
  UPDATE kp_import_rows SET errors = errors || 'Кількість: число більше 0'::text WHERE qty IS NULL OR qty <= 0 OR qty > 1000000 OR scale(qty) > 3;
  UPDATE kp_import_rows SET errors = errors || 'Ціна: число від 0'::text WHERE price IS NULL OR price > 100000000;
  UPDATE kp_import_rows SET errors = errors || 'Дата: ДД.ММ.РРРР або РРРР-ММ-ДД'::text WHERE on_date IS NULL OR on_date < DATE '2000-01-01' OR on_date > v_today + 1;
  UPDATE kp_import_rows SET errors = errors || 'Постачальник: до 200 символів'::text WHERE char_length(supplier) > 200;
  UPDATE kp_import_rows SET errors = errors || 'Примітка: до 500 символів'::text WHERE char_length(note) > 500;
  UPDATE kp_import_rows AS r SET errors = errors || 'Артикул повторюється у файлі'::text
  WHERE r.akey IS NOT NULL AND (SELECT count(*) FROM kp_import_rows AS o WHERE o.akey = r.akey) > 1;
  UPDATE kp_import_rows AS r SET errors = errors || 'Назва без артикула повторюється у файлі'::text
  WHERE r.akey IS NULL AND r.nkey <> '' AND (SELECT count(*) FROM kp_import_rows AS o WHERE o.akey IS NULL AND o.nkey = r.nkey) > 1;

  -- Наявні запчастини: за артикулом, без артикула — за назвою серед запчастин без артикула.
  UPDATE kp_import_rows AS r SET part_id = p.id
  FROM public.parts AS p
  WHERE r.akey IS NOT NULL AND p.org_id = v_org AND p.article IS NOT NULL AND lower(btrim(p.article)) = r.akey;
  UPDATE kp_import_rows AS r SET part_id = (
    SELECT p.id FROM public.parts AS p
    WHERE p.org_id = v_org AND p.article IS NULL AND lower(btrim(p.name)) = r.nkey
    ORDER BY p.created_at, p.id LIMIT 1
  )
  WHERE r.akey IS NULL AND r.part_id IS NULL;

  UPDATE kp_import_rows SET status = CASE WHEN cardinality(errors) > 0 THEN 'error' WHEN part_id IS NULL THEN 'new_part' ELSE 'receipt_existing' END;
  SELECT count(*) FILTER (WHERE status = 'error'), count(*) FILTER (WHERE status = 'new_part'), count(*) FILTER (WHERE status = 'receipt_existing')
  INTO v_errors, v_new, v_existing FROM kp_import_rows;
  IF v_new > 0 AND (SELECT count(*) FROM public.parts WHERE org_id = v_org) + v_new > 5000 THEN
    UPDATE kp_import_rows SET errors = errors || 'Забагато запчастин (понад 5000)'::text, status = 'error' WHERE status = 'new_part';
    SELECT count(*) FILTER (WHERE status = 'error'), 0 INTO v_errors, v_new FROM kp_import_rows;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('line', line, 'status', status, 'errors', to_jsonb(errors), 'part_id', part_id) ORDER BY n), '[]'::jsonb)
  INTO v_result FROM kp_import_rows;

  IF coalesce(p_commit, false) THEN
    IF v_errors > 0 THEN
      RAISE EXCEPTION 'IMPORT_HAS_ERRORS' USING ERRCODE = 'P0001', DETAIL = v_errors::text;
    END IF;
    PERFORM 1 FROM public.parts AS p
    WHERE p.id IN (SELECT part_id FROM kp_import_rows WHERE part_id IS NOT NULL)
    ORDER BY p.id
    FOR UPDATE;
    FOR v_row IN SELECT * FROM kp_import_rows ORDER BY n LOOP
      v_part := v_row.part_id;
      IF v_part IS NULL THEN
        INSERT INTO public.parts (org_id, name, article, unit, created_by)
        VALUES (v_org, v_row.name, v_row.article, v_row.unit, auth.uid())
        RETURNING id INTO v_part;
      END IF;
      INSERT INTO public.part_receipts (org_id, part_id, kind, qty, unit_price, total, received_on, supplier, note, import_batch_id, created_by)
      VALUES (v_org, v_part, 'opening', v_row.qty, round(v_row.price, 2), round(v_row.qty * v_row.price, 2), v_row.on_date,
              v_row.supplier, v_row.note, v_batch, auth.uid());
      PERFORM public.kp_stock_in(v_part, v_row.qty, round(v_row.price, 2));
    END LOOP;
  END IF;

  DELETE FROM kp_import_rows;
  RETURN jsonb_build_object(
    'committed', coalesce(p_commit, false),
    'batch_id', CASE WHEN coalesce(p_commit, false) THEN v_batch END,
    'rows', v_result,
    'summary', jsonb_build_object('total', jsonb_array_length(p_rows), 'new_parts', v_new, 'receipts_existing', v_existing, 'errors', v_errors)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Repair manager invites (service_role only; API Контроль+)
-- ---------------------------------------------------------------------------

-- Створити (p_invite новий) або перевидати (p_invite наявний: новий токен, новий строк, місце те саме).
CREATE OR REPLACE FUNCTION public.kp_repair_invite_reserve(
  p_org uuid, p_invite uuid, p_email text, p_token_hash text, p_invited_by uuid, p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing public.repair_manager_invites%ROWTYPE;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR UPDATE;
  IF NOT public.org_has_plan(p_org, 'control_plus') THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_existing FROM public.repair_manager_invites WHERE id = p_invite AND org_id = p_org FOR UPDATE;
  IF FOUND THEN
    IF v_existing.accepted_at IS NOT NULL OR v_existing.revoked_at IS NOT NULL OR v_existing.declined_at IS NOT NULL THEN
      RAISE EXCEPTION 'REPAIR_INVITE_CLOSED' USING ERRCODE = 'P0001';
    END IF;
    v_email := v_existing.email;
  ELSE
    IF EXISTS (SELECT 1 FROM public.repair_manager_invites WHERE id = p_invite) THEN
      RAISE EXCEPTION 'REPAIR_INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.repair_manager_invites AS i
      WHERE i.org_id = p_org AND i.email = v_email
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at > now()
    ) THEN
      RAISE EXCEPTION 'REPAIR_INVITE_EXISTS' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.org_repair_handlers AS h JOIN auth.users AS u ON u.id = h.user_id
      WHERE h.org_id = p_org AND h.kind = 'repair_manager' AND lower(u.email) = v_email
    ) THEN
      RAISE EXCEPTION 'REPAIR_MANAGER_EXISTS' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF public.kp_repair_manager_seats(p_org, NULL, p_invite) >= 2 THEN
    RAISE EXCEPTION 'REPAIR_MANAGER_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.repair_manager_invites (id, org_id, email, token_hash, invited_by, expires_at, last_sent_at)
  VALUES (p_invite, p_org, v_email, p_token_hash, p_invited_by, p_expires_at, now())
  ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, last_sent_at = now();
  RETURN p_invite;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_repair_invite_revoke(p_org uuid, p_invite uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  UPDATE public.repair_manager_invites
  SET revoked_at = now()
  WHERE id = p_invite AND org_id = p_org AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Прийняти: токен (за хешем) чинний, email акаунта = email запрошення; менеджер додається рівно один раз.
-- Власна організація людини не змінюється.
CREATE OR REPLACE FUNCTION public.kp_repair_invite_accept(p_token_hash text, p_user uuid, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_i public.repair_manager_invites%ROWTYPE;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_i FROM public.repair_manager_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_i.revoked_at IS NOT NULL OR v_i.declined_at IS NOT NULL
     OR (v_i.accepted_at IS NULL AND v_i.expires_at <= now()) THEN
    RAISE EXCEPTION 'REPAIR_INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_i.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'REPAIR_INVITE_USED' USING ERRCODE = 'P0001';
  END IF;
  IF lower(btrim(coalesce(p_email, ''))) <> v_i.email THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = v_i.org_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.org_repair_handlers AS h WHERE h.org_id = v_i.org_id AND h.user_id = p_user) THEN
    RAISE EXCEPTION 'REPAIR_MANAGER_EXISTS' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.repair_manager_invites SET accepted_at = now(), accepted_by = p_user WHERE id = v_i.id;
  INSERT INTO public.org_repair_handlers (org_id, user_id, kind, created_by) VALUES (v_i.org_id, p_user, 'repair_manager', v_i.invited_by);
  RETURN v_i.org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_repair_invite_decline(p_token_hash text, p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_i public.repair_manager_invites%ROWTYPE;
BEGIN
  IF NOT public.is_service_role() OR public.kp_is_client_role() THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_i FROM public.repair_manager_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_i.accepted_at IS NOT NULL OR v_i.revoked_at IS NOT NULL OR v_i.declined_at IS NOT NULL OR v_i.expires_at <= now() THEN
    RAISE EXCEPTION 'REPAIR_INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF lower(btrim(coalesce(p_email, ''))) <> v_i.email THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.repair_manager_invites SET declined_at = now() WHERE id = v_i.id;
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
  FOREACH f IN ARRAY ARRAY[
    'public.kp_part_upsert(uuid, text, text, text, numeric, text, boolean)',
    'public.kp_part_receive(uuid, numeric, numeric, date, text, text, text, text)',
    'public.kp_receipt_reverse(uuid)',
    'public.kp_repair_post(uuid, date, integer, text, text, numeric, jsonb)',
    'public.kp_repair_update(uuid, date, integer, text, text, numeric)',
    'public.kp_repair_void(uuid, text)',
    'public.kp_stock_adjust(uuid, numeric, numeric, text)',
    'public.kp_repair_handler_add(uuid, text)',
    'public.kp_repair_handler_remove(uuid)',
    'public.kp_repair_vehicles()',
    'public.kp_repairs_list(date, date, uuid)',
    'public.kp_part_history(uuid)',
    'public.kp_repair_handlers_list()',
    'public.kp_repair_logist_candidates()',
    'public.kp_parts_import(jsonb, boolean)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.kp_repair_invite_reserve(uuid, uuid, text, text, uuid, timestamptz)',
    'public.kp_repair_invite_revoke(uuid, uuid)',
    'public.kp_repair_invite_accept(text, uuid, text)',
    'public.kp_repair_invite_decline(text, text)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO service_role';
  END LOOP;
END;
$$;
