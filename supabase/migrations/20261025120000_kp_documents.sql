-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+ (Етап 4a): документи — реквізити компанії з підписом і печаткою, договір клієнта, рахунки й акти
-- з автонумерацією, ПДВ, валюта з курсом НБУ, анулювання, оплати й борги клієнтів.
--
-- * kp_org_requisites — реквізити своєї компанії (продавець у документах), префікси номерів, валюта й режим ПДВ
--   за замовчуванням, шляхи до підпису й печатки в Storage. org_company_profiles НЕ змінюється.
-- * clients — лише три нові nullable-колонки: contract_no, contract_date, payment_terms_days (NULL = 5 днів).
--   Клієнтів пише сайт Контроль+ напряму через RLS (як і раніше), тож тут лише колонки з CHECK-ами.
-- * kp_doc_counters — лічильник номерів (org, kind, рік doc_date). Номер береться INSERT … ON CONFLICT DO UPDATE …
--   RETURNING: рядок лічильника заблокований до кінця транзакції, паралельні виклики йдуть по черзі. Ручний номер —
--   якщо вільний (інакше DOC_NUMBER_TAKEN); більший за лічильник зсуває лічильник. Номери анульованих не повертаються.
--   kind 'ttn' передбачено одразу (етап 4b — лише адитивно).
-- * kp_documents (рахунок / акт; ttn — 4b), kp_document_lines, kp_document_payments. Знімки seller / buyer і суми
--   незмінні після випуску (тригери); змінюється лише статус (анулювання), активність рядків і анулювання оплат.
--   DELETE документів, рядків і оплат немає взагалі.
-- * Суми рахує сервер: рядок = round(qty × price, 2); ПДВ 20 % лише для платника ПДВ (знімок у документі):
--   net — ПДВ = round(Σ × 0.20, 2), total = Σ + ПДВ; gross — total = Σ, ПДВ = round(Σ × 20 / 120, 2), subtotal = total − ПДВ.
-- * Курс приходить від клієнта (функція /api/docs/rate бере його з НБУ) і перевіряється на межі: rate > 0,
--   rate_date ≤ doc_date, не старше 7 днів; для UAH rate = 1.
-- * Права: читають owner / logist / director своєї організації на control_plus; створюють документи й оплати —
--   kp_can_write() (owner, logist); анулює документ і змінює реквізити, підпис, печатку — лише owner. Менеджер
--   з ремонтів (без власного Контроль+) — KP_FORBIDDEN. Таблиці — без прямих грантів клієнтам, усе через RPC.
-- * Storage: приватний бакет kp-doc-assets (PNG / JPEG ≤ 512 КБ), шлях <org_id>/(signature|stamp).(png|jpg);
--   читають учасники організації, пише лише owner. Бакет створює ця міграція (ON CONFLICT DO NOTHING).
--
-- Лише адитивно: нові таблиці, функції, тригери й політики; у clients — нові колонки. Наявні функції
-- (kp_org_id, kp_role, kp_can_write, kp_context, kp_trips, функції 3a / 3b), таблиці calculations, trip_actuals,
-- fleet_vehicles, org_company_profiles не змінюються. Ідемпотентно. Після 20261024232246_repairs_maintenance.sql.

-- ---------------------------------------------------------------------------
-- clients: contract and payment terms
-- ---------------------------------------------------------------------------

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS contract_no text NULL,
  ADD COLUMN IF NOT EXISTS contract_date date NULL,
  ADD COLUMN IF NOT EXISTS payment_terms_days smallint NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_contract_no_len' AND conrelid = 'public.clients'::regclass) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_contract_no_len CHECK (contract_no IS NULL OR char_length(btrim(contract_no)) BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_contract_date_range' AND conrelid = 'public.clients'::regclass) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_contract_date_range CHECK (contract_date IS NULL OR contract_date BETWEEN DATE '1991-01-01' AND DATE '2100-12-31');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_payment_terms_range' AND conrelid = 'public.clients'::regclass) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_payment_terms_range CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Company requisites (seller)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kp_org_requisites (
  org_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  legal_form text NULL,
  edrpou text NULL,
  ipn text NULL,
  vat_payer boolean NOT NULL DEFAULT false,
  vat_number text NULL,
  iban text NULL,
  bank_name text NULL,
  legal_address text NULL,
  signer_name text NULL,
  signer_position text NULL,
  doc_place text NULL,
  invoice_prefix text NULL,
  act_prefix text NULL,
  ttn_prefix text NULL,
  default_currency text NOT NULL DEFAULT 'UAH',
  default_vat_mode text NOT NULL DEFAULT 'net',
  signature_path text NULL,
  stamp_path text NULL,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_org_requisites_legal_name_len CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 300),
  CONSTRAINT kp_org_requisites_legal_form_check CHECK (legal_form IS NULL OR legal_form IN ('tov', 'fop', 'other')),
  CONSTRAINT kp_org_requisites_edrpou_format CHECK (edrpou IS NULL OR edrpou ~ '^[0-9]{8}$'),
  CONSTRAINT kp_org_requisites_ipn_format CHECK (ipn IS NULL OR ipn ~ '^[0-9]{10}$'),
  CONSTRAINT kp_org_requisites_vat_number_format CHECK (vat_number IS NULL OR vat_number ~ '^([0-9]{10}|[0-9]{12})$'),
  CONSTRAINT kp_org_requisites_iban_format CHECK (iban IS NULL OR iban ~ '^UA[0-9]{27}$'),
  CONSTRAINT kp_org_requisites_text_len CHECK (
    coalesce(char_length(bank_name), 0) <= 300 AND coalesce(char_length(legal_address), 0) <= 500
    AND coalesce(char_length(signer_name), 0) <= 200 AND coalesce(char_length(signer_position), 0) <= 200
    AND coalesce(char_length(doc_place), 0) <= 200),
  CONSTRAINT kp_org_requisites_prefix_format CHECK (
    (invoice_prefix IS NULL OR invoice_prefix ~ '^[0-9A-Za-zА-яҐґЄєІіЇї/._-]{1,10}$')
    AND (act_prefix IS NULL OR act_prefix ~ '^[0-9A-Za-zА-яҐґЄєІіЇї/._-]{1,10}$')
    AND (ttn_prefix IS NULL OR ttn_prefix ~ '^[0-9A-Za-zА-яҐґЄєІіЇї/._-]{1,10}$')),
  CONSTRAINT kp_org_requisites_currency_check CHECK (default_currency IN ('UAH', 'USD', 'EUR')),
  CONSTRAINT kp_org_requisites_vat_mode_check CHECK (default_vat_mode IN ('net', 'gross')),
  CONSTRAINT kp_org_requisites_signature_path CHECK (
    signature_path IS NULL OR signature_path IN (org_id::text || '/signature.png', org_id::text || '/signature.jpg')),
  CONSTRAINT kp_org_requisites_stamp_path CHECK (
    stamp_path IS NULL OR stamp_path IN (org_id::text || '/stamp.png', org_id::text || '/stamp.jpg'))
);

-- ---------------------------------------------------------------------------
-- Numbering, documents, lines, payments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kp_doc_counters (
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invoice', 'act', 'ttn')),
  year smallint NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  next_no integer NOT NULL DEFAULT 1 CHECK (next_no BETWEEN 1 AND 1000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, year)
);

-- Номер унікальний у межах організації, типу й року (нумерація з 1 щороку).
CREATE TABLE IF NOT EXISTS public.kp_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  number integer NOT NULL,
  doc_year smallint NOT NULL,
  prefix text NULL,
  doc_date date NOT NULL,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE RESTRICT,
  parent_id uuid NULL REFERENCES public.kp_documents (id) ON DELETE RESTRICT,
  seller jsonb NOT NULL,
  buyer jsonb NOT NULL,
  currency text NOT NULL DEFAULT 'UAH',
  rate numeric(12, 6) NOT NULL DEFAULT 1,
  rate_date date NOT NULL,
  vat_mode text NOT NULL DEFAULT 'net',
  vat_rate smallint NOT NULL DEFAULT 0,
  subtotal numeric(14, 2) NOT NULL,
  vat_amount numeric(14, 2) NOT NULL,
  total numeric(14, 2) NOT NULL,
  total_uah numeric(14, 2) NOT NULL,
  due_date date NULL,
  status text NOT NULL DEFAULT 'issued',
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL,
  cancelled_reason text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_documents_kind_check CHECK (kind IN ('invoice', 'act', 'ttn')),
  CONSTRAINT kp_documents_number_range CHECK (number BETWEEN 1 AND 999999999),
  CONSTRAINT kp_documents_year_matches CHECK (doc_year = extract(year FROM doc_date)),
  CONSTRAINT kp_documents_currency_check CHECK (currency IN ('UAH', 'USD', 'EUR')),
  CONSTRAINT kp_documents_rate_check CHECK (rate > 0 AND (currency <> 'UAH' OR rate = 1) AND rate_date <= doc_date),
  CONSTRAINT kp_documents_vat_check CHECK (vat_mode IN ('net', 'gross') AND vat_rate IN (0, 20) AND (vat_rate = 20 OR vat_amount = 0)),
  CONSTRAINT kp_documents_sums_check CHECK (subtotal >= 0 AND vat_amount >= 0 AND total > 0 AND subtotal + vat_amount = total),
  CONSTRAINT kp_documents_status_check CHECK (status IN ('issued', 'cancelled') AND ((status = 'cancelled') = (cancelled_at IS NOT NULL))),
  CONSTRAINT kp_documents_reason_len CHECK (cancelled_reason IS NULL OR char_length(cancelled_reason) <= 500),
  CONSTRAINT kp_documents_due_check CHECK (due_date IS NULL OR due_date >= doc_date),
  CONSTRAINT kp_documents_number_key UNIQUE (org_id, kind, doc_year, number)
);

CREATE INDEX IF NOT EXISTS kp_documents_org_date_idx ON public.kp_documents (org_id, doc_date DESC);
CREATE INDEX IF NOT EXISTS kp_documents_client_idx ON public.kp_documents (client_id, kind, status);
CREATE INDEX IF NOT EXISTS kp_documents_parent_idx ON public.kp_documents (parent_id) WHERE parent_id IS NOT NULL;

-- kind і active — копія з документа: на них частковий UNIQUE «один рейс — на одному активному документі типу».
-- calculation_id … ON DELETE SET NULL: видалення рейсу на сайті працює як раніше, рядок документа лишається.
CREATE TABLE IF NOT EXISTS public.kp_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid NOT NULL REFERENCES public.kp_documents (id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('invoice', 'act', 'ttn')),
  active boolean NOT NULL DEFAULT true,
  sort smallint NOT NULL CHECK (sort BETWEEN 1 AND 200),
  calculation_id uuid NULL REFERENCES public.calculations (id) ON DELETE SET NULL,
  title text NOT NULL,
  unit text NOT NULL DEFAULT 'послуга',
  qty numeric(12, 3) NOT NULL,
  price numeric(14, 2) NOT NULL,
  amount numeric(14, 2) NOT NULL,
  CONSTRAINT kp_document_lines_title_len CHECK (char_length(title) BETWEEN 1 AND 500),
  CONSTRAINT kp_document_lines_unit_len CHECK (char_length(unit) BETWEEN 1 AND 20),
  CONSTRAINT kp_document_lines_values CHECK (qty > 0 AND price >= 0 AND amount = round(qty * price, 2)),
  CONSTRAINT kp_document_lines_sort_key UNIQUE (doc_id, sort)
);

CREATE UNIQUE INDEX IF NOT EXISTS kp_document_lines_trip_active_uidx
  ON public.kp_document_lines (calculation_id, kind) WHERE active AND calculation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kp_document_lines_doc_idx ON public.kp_document_lines (doc_id);

CREATE TABLE IF NOT EXISTS public.kp_document_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  doc_id uuid NOT NULL REFERENCES public.kp_documents (id) ON DELETE RESTRICT,
  paid_on date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz NULL,
  voided_by uuid NULL
);

CREATE INDEX IF NOT EXISTS kp_document_payments_doc_idx ON public.kp_document_payments (doc_id) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- Immutability: no DELETE; after issue only the cancel fields, line activity and payment voiding change
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOC_DELETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason'])
     OR (OLD.status = 'cancelled' AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))) THEN
    RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_document_lines_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOC_DELETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Дозволено: active true → false (анулювання документа) і calculation_id → NULL (рейс видалили на сайті).
  IF (to_jsonb(NEW) - ARRAY['active', 'calculation_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active', 'calculation_id'])
     OR (NEW.active AND NOT OLD.active)
     OR (NEW.calculation_id IS NOT NULL AND NEW.calculation_id IS DISTINCT FROM OLD.calculation_id) THEN
    RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_document_payments_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOC_DELETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by'])
     OR OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kp_documents_guard ON public.kp_documents;
CREATE TRIGGER trg_kp_documents_guard
  BEFORE UPDATE OR DELETE ON public.kp_documents
  FOR EACH ROW EXECUTE FUNCTION public.kp_documents_guard();

DROP TRIGGER IF EXISTS trg_kp_document_lines_guard ON public.kp_document_lines;
CREATE TRIGGER trg_kp_document_lines_guard
  BEFORE UPDATE OR DELETE ON public.kp_document_lines
  FOR EACH ROW EXECUTE FUNCTION public.kp_document_lines_guard();

DROP TRIGGER IF EXISTS trg_kp_document_payments_guard ON public.kp_document_payments;
CREATE TRIGGER trg_kp_document_payments_guard
  BEFORE UPDATE OR DELETE ON public.kp_document_payments
  FOR EACH ROW EXECUTE FUNCTION public.kp_document_payments_guard();

-- ---------------------------------------------------------------------------
-- RLS and grants: no direct access for clients (everything through the functions below)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kp_org_requisites', 'kp_doc_counters', 'kp_documents', 'kp_document_lines', 'kp_document_payments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Internal helpers (closed to every API role)
-- ---------------------------------------------------------------------------

-- Організація документів для рівня 'read' | 'write' | 'owner'. Менеджер з ремонтів чужої організації (власного
-- Контроль+ не має) — KP_FORBIDDEN; інші без тарифу — CONTROL_PLUS_REQUIRED (екран Контроль+ в інтерфейсі).
CREATE OR REPLACE FUNCTION public.kp_docs_org(p_level text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_org_id();
  v_role text := public.kp_role();
BEGIN
  IF v_org IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.org_repair_handlers AS h WHERE h.user_id = auth.uid() AND h.kind = 'repair_manager') THEN
      RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(v_role NOT IN ('owner', 'logist', 'director'), true) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_level IN ('write', 'owner') AND NOT public.kp_can_write() THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_level = 'owner' AND v_role <> 'owner' THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END;
$$;

-- Номер документа. Рядок лічильника блокується (ON CONFLICT DO UPDATE) до кінця транзакції: паралельні створення
-- того самого типу й року чекають одне на одного, дублів немає; помилка після цього відкочує й лічильник.
CREATE OR REPLACE FUNCTION public.kp_doc_alloc_number(p_org uuid, p_kind text, p_year integer, p_manual integer)
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
    VALUES (p_org, p_kind, p_year, p_manual + 1)
    ON CONFLICT (org_id, kind, year) DO UPDATE SET next_no = greatest(c.next_no, EXCLUDED.next_no), updated_at = now();
    IF EXISTS (
      SELECT 1 FROM public.kp_documents AS d
      WHERE d.org_id = p_org AND d.kind = p_kind AND d.doc_year = p_year AND d.number = p_manual
    ) THEN
      RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = p_manual::text;
    END IF;
    RETURN p_manual;
  END IF;
  LOOP
    INSERT INTO public.kp_doc_counters AS c (org_id, kind, year, next_no)
    VALUES (p_org, p_kind, p_year, 2)
    ON CONFLICT (org_id, kind, year) DO UPDATE SET next_no = c.next_no + 1, updated_at = now()
    RETURNING c.next_no - 1 INTO v_no;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.kp_documents AS d
      WHERE d.org_id = p_org AND d.kind = p_kind AND d.doc_year = p_year AND d.number = v_no
    );
  END LOOP;
  RETURN v_no;
END;
$$;

-- Статус для списку: cancelled | paid | overdue | partial | issued (акт — issued / cancelled).
CREATE OR REPLACE FUNCTION public.kp_doc_pay_status(p_kind text, p_status text, p_total numeric, p_paid numeric, p_due date, p_today date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_status = 'cancelled' THEN 'cancelled'
    WHEN p_kind <> 'invoice' THEN 'issued'
    WHEN coalesce(p_paid, 0) >= p_total THEN 'paid'
    WHEN p_due IS NOT NULL AND p_due < p_today THEN 'overdue'
    WHEN coalesce(p_paid, 0) > 0 THEN 'partial'
    ELSE 'issued'
  END;
$$;

CREATE OR REPLACE FUNCTION public.kp_doc_paid(p_doc uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(sum(p.amount), 0) FROM public.kp_document_payments AS p WHERE p.doc_id = p_doc AND p.voided_at IS NULL;
$$;

-- ---------------------------------------------------------------------------
-- Requisites
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_requisites_get()
RETURNS SETOF public.kp_org_requisites
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY SELECT r.* FROM public.kp_org_requisites AS r WHERE r.org_id = v_org;
END;
$$;

-- p_data — обʼєкт з полями таблиці. signature_path / stamp_path: ключа немає — лишаємо як є; null — прибрати;
-- шлях — лише <org_id>/(signature|stamp).(png|jpg) і файл уже має бути в бакеті kp-doc-assets.
CREATE OR REPLACE FUNCTION public.kp_requisites_save(p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_old public.kp_org_requisites%ROWTYPE;
  v_sig text;
  v_stamp text;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'REQUISITES_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_old FROM public.kp_org_requisites WHERE org_id = v_org FOR UPDATE;
  v_sig := CASE WHEN p_data ? 'signature_path' THEN nullif(btrim(coalesce(p_data ->> 'signature_path', '')), '') ELSE v_old.signature_path END;
  v_stamp := CASE WHEN p_data ? 'stamp_path' THEN nullif(btrim(coalesce(p_data ->> 'stamp_path', '')), '') ELSE v_old.stamp_path END;
  IF (v_sig IS NOT NULL AND v_sig IS DISTINCT FROM v_old.signature_path
      AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_sig))
     OR (v_stamp IS NOT NULL AND v_stamp IS DISTINCT FROM v_old.stamp_path
      AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_stamp)) THEN
    RAISE EXCEPTION 'REQUISITES_ASSET_MISSING' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.kp_org_requisites AS r (
    org_id, legal_name, legal_form, edrpou, ipn, vat_payer, vat_number, iban, bank_name, legal_address,
    signer_name, signer_position, doc_place, invoice_prefix, act_prefix, ttn_prefix, default_currency, default_vat_mode,
    signature_path, stamp_path, updated_by, updated_at
  ) VALUES (
    v_org,
    btrim(coalesce(p_data ->> 'legal_name', '')),
    nullif(lower(btrim(coalesce(p_data ->> 'legal_form', ''))), ''),
    nullif(regexp_replace(coalesce(p_data ->> 'edrpou', ''), '\s', '', 'g'), ''),
    nullif(regexp_replace(coalesce(p_data ->> 'ipn', ''), '\s', '', 'g'), ''),
    coalesce((p_data ->> 'vat_payer')::boolean, false),
    nullif(regexp_replace(coalesce(p_data ->> 'vat_number', ''), '\s', '', 'g'), ''),
    nullif(upper(regexp_replace(coalesce(p_data ->> 'iban', ''), '\s', '', 'g')), ''),
    nullif(btrim(coalesce(p_data ->> 'bank_name', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'legal_address', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'signer_name', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'signer_position', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'doc_place', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'invoice_prefix', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'act_prefix', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'ttn_prefix', '')), ''),
    coalesce(nullif(upper(btrim(coalesce(p_data ->> 'default_currency', ''))), ''), 'UAH'),
    coalesce(nullif(lower(btrim(coalesce(p_data ->> 'default_vat_mode', ''))), ''), 'net'),
    v_sig, v_stamp, auth.uid(), now()
  )
  ON CONFLICT (org_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, legal_form = EXCLUDED.legal_form, edrpou = EXCLUDED.edrpou, ipn = EXCLUDED.ipn,
    vat_payer = EXCLUDED.vat_payer, vat_number = EXCLUDED.vat_number, iban = EXCLUDED.iban, bank_name = EXCLUDED.bank_name,
    legal_address = EXCLUDED.legal_address, signer_name = EXCLUDED.signer_name, signer_position = EXCLUDED.signer_position,
    doc_place = EXCLUDED.doc_place, invoice_prefix = EXCLUDED.invoice_prefix, act_prefix = EXCLUDED.act_prefix,
    ttn_prefix = EXCLUDED.ttn_prefix, default_currency = EXCLUDED.default_currency, default_vat_mode = EXCLUDED.default_vat_mode,
    signature_path = EXCLUDED.signature_path, stamp_path = EXCLUDED.stamp_path, updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trips for a document
-- ---------------------------------------------------------------------------

-- Рейси клієнта за період (accepted / done, видимі користувачу), ще не виставлені документом p_kind ('act' — за
-- замовчуванням; NULL — усі з позначками). Ціна — дохід факту (trip_actuals.revenue > 0), інакше план (calculations.revenue).
CREATE OR REPLACE FUNCTION public.kp_doc_trips_for_client(p_client uuid, p_from date, p_to date, p_kind text DEFAULT 'act')
RETURNS TABLE (
  calculation_id uuid, trip_date date, name text, route_from text, route_to text, status text,
  tonnage numeric, distance_km numeric, plan_revenue numeric, fact_revenue numeric, price numeric, price_source text,
  invoice_doc_id uuid, act_doc_id uuid
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
  IF NOT EXISTS (SELECT 1 FROM public.clients AS cl WHERE cl.id = p_client AND cl.org_id = v_org) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('invoice', 'act') THEN
    RAISE EXCEPTION 'DOC_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT c.id, c.trip_date, c.name, c.route_from, c.route_to, c.status,
         c.tonnage, c.distance_km, c.revenue, ta.revenue,
         CASE WHEN ta.revenue > 0 THEN ta.revenue ELSE c.revenue END,
         CASE WHEN ta.revenue > 0 THEN 'fact' ELSE 'plan' END,
         (SELECT l.doc_id FROM public.kp_document_lines AS l WHERE l.calculation_id = c.id AND l.kind = 'invoice' AND l.active LIMIT 1),
         (SELECT l.doc_id FROM public.kp_document_lines AS l WHERE l.calculation_id = c.id AND l.kind = 'act' AND l.active LIMIT 1)
  FROM public.calculation_clients AS cc
  JOIN public.calculations AS c ON c.id = cc.calculation_id
  LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
  WHERE cc.client_id = p_client
    AND c.org_id = v_org
    AND c.status IN ('accepted', 'done')
    AND c.trip_date BETWEEN p_from AND p_to
    AND public.kp_trip_visible(c.user_id)
    AND (p_kind IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.kp_document_lines AS l WHERE l.calculation_id = c.id AND l.kind = p_kind AND l.active))
  ORDER BY c.trip_date, c.created_at
  LIMIT 500;
END;
$$;

-- Наступний автоматичний номер (лише підказка для форми; справжній береться при створенні).
CREATE OR REPLACE FUNCTION public.kp_doc_next_number(p_kind text, p_doc_date date)
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
  IF p_kind IS NULL OR p_kind NOT IN ('invoice', 'act', 'ttn') OR p_doc_date IS NULL THEN
    RAISE EXCEPTION 'DOC_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  v_year := extract(year FROM p_doc_date)::integer;
  SELECT c.next_no INTO v_no FROM public.kp_doc_counters AS c WHERE c.org_id = v_org AND c.kind = p_kind AND c.year = v_year;
  v_no := coalesce(v_no, 1);
  WHILE EXISTS (
    SELECT 1 FROM public.kp_documents AS d WHERE d.org_id = v_org AND d.kind = p_kind AND d.doc_year = v_year AND d.number = v_no
  ) LOOP
    v_no := v_no + 1;
  END LOOP;
  RETURN v_no;
END;
$$;

-- ---------------------------------------------------------------------------
-- Create / cancel a document
-- ---------------------------------------------------------------------------

-- Рахунок або акт (окремими викликами, кожен — з номером своєї послідовності). p_lines: [{ title, unit, qty, price,
-- calculation_id? }], 1…200. Ставка ПДВ — зі знімка реквізитів (vat_payer), режим — p_vat_mode або default_vat_mode.
-- Суми, знімки seller / buyer, строк оплати (рахунок: p_due_date або doc_date + строк клієнта, NULL = 5 днів) — сервер.
CREATE OR REPLACE FUNCTION public.kp_doc_create(
  p_kind text, p_client uuid, p_doc_date date, p_currency text, p_number integer DEFAULT NULL, p_lines jsonb DEFAULT NULL,
  p_parent uuid DEFAULT NULL, p_due_date date DEFAULT NULL, p_vat_mode text DEFAULT NULL, p_rate numeric DEFAULT NULL,
  p_rate_date date DEFAULT NULL
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
  v_parent public.kp_documents%ROWTYPE;
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_rate numeric;
  v_rate_date date;
  v_vat_mode text;
  v_vat_rate integer;
  v_sum numeric := 0;
  v_vat numeric;
  v_subtotal numeric;
  v_total numeric;
  v_due date;
  v_year integer;
  v_no integer;
  v_doc uuid;
  v_line jsonb;
  v_n integer := 0;
  v_title text;
  v_unit text;
  v_qty numeric;
  v_price numeric;
  v_calc uuid;
  v_titles text[] := '{}';
  v_units text[] := '{}';
  v_qtys numeric[] := '{}';
  v_prices numeric[] := '{}';
  v_calcs uuid[] := '{}';
BEGIN
  IF p_kind = 'ttn' THEN
    RAISE EXCEPTION 'DOC_KIND_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('invoice', 'act') THEN
    RAISE EXCEPTION 'DOC_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  IF p_doc_date IS NULL OR p_doc_date < DATE '2000-01-01' OR p_doc_date > public.ua_today() + 1 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  IF NOT FOUND OR (v_req.edrpou IS NULL AND v_req.ipn IS NULL) OR (p_kind = 'invoice' AND v_req.iban IS NULL) THEN
    RAISE EXCEPTION 'REQUISITES_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_client FROM public.clients WHERE id = p_client AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_client.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'CLIENT_ARCHIVED' USING ERRCODE = 'P0001';
  END IF;

  -- Валюта і курс: курс від клієнта (НБУ через /api/docs/rate) перевіряється на межі.
  IF v_currency NOT IN ('UAH', 'USD', 'EUR') THEN
    RAISE EXCEPTION 'DOC_BAD_CURRENCY' USING ERRCODE = 'P0001';
  END IF;
  IF v_currency = 'UAH' THEN
    IF p_rate IS NOT NULL AND p_rate <> 1 THEN
      RAISE EXCEPTION 'DOC_BAD_RATE' USING ERRCODE = 'P0001', DETAIL = 'UAH rate must be 1';
    END IF;
    v_rate := 1;
    v_rate_date := p_doc_date;
  ELSE
    IF p_rate IS NULL OR p_rate <= 0 OR p_rate > 1000 OR p_rate_date IS NULL OR p_rate_date > p_doc_date
       OR p_doc_date - p_rate_date > 7 THEN
      RAISE EXCEPTION 'DOC_BAD_RATE' USING ERRCODE = 'P0001', DETAIL = 'rate > 0, rate_date <= doc_date, at most 7 days old';
    END IF;
    v_rate := round(p_rate, 6);
    v_rate_date := p_rate_date;
  END IF;

  v_vat_mode := coalesce(lower(btrim(p_vat_mode)), v_req.default_vat_mode);
  IF v_vat_mode NOT IN ('net', 'gross') THEN
    RAISE EXCEPTION 'DOC_BAD_VAT_MODE' USING ERRCODE = 'P0001';
  END IF;
  v_vat_rate := CASE WHEN v_req.vat_payer THEN 20 ELSE 0 END;

  -- Рядки: усе перевіряємо до будь-якого запису.
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'DOC_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'count';
  END IF;
  FOR v_line IN SELECT e.value FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(v_line) <> 'object' THEN
      RAISE EXCEPTION 'DOC_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n;
    END IF;
    BEGIN
      v_title := btrim(coalesce(v_line ->> 'title', ''));
      v_unit := coalesce(nullif(btrim(coalesce(v_line ->> 'unit', '')), ''), 'послуга');
      v_qty := round((v_line ->> 'qty')::numeric, 3);
      v_price := round((v_line ->> 'price')::numeric, 2);
      v_calc := nullif(v_line ->> 'calculation_id', '')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'DOC_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n;
    END;
    IF char_length(v_title) NOT BETWEEN 1 AND 500 OR char_length(v_unit) > 20
       OR v_qty IS NULL OR v_qty <= 0 OR v_qty > 1000000
       OR v_price IS NULL OR v_price < 0 OR v_price > 1000000000 THEN
      RAISE EXCEPTION 'DOC_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n;
    END IF;
    IF v_calc IS NOT NULL THEN
      IF v_calc = ANY (v_calcs) THEN
        RAISE EXCEPTION 'DOC_BAD_LINES' USING ERRCODE = 'P0001', DETAIL = 'line ' || v_n || ': trip repeated';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.calculations AS c JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
        WHERE c.id = v_calc AND c.org_id = v_org AND cc.client_id = p_client AND public.kp_trip_visible(c.user_id)
      ) THEN
        RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001', DETAIL = v_calc::text;
      END IF;
      IF EXISTS (SELECT 1 FROM public.kp_document_lines AS l WHERE l.calculation_id = v_calc AND l.kind = p_kind AND l.active) THEN
        RAISE EXCEPTION 'TRIP_ALREADY_BILLED' USING ERRCODE = 'P0001', DETAIL = v_calc::text;
      END IF;
    END IF;
    v_titles := v_titles || v_title;
    v_units := v_units || v_unit;
    v_qtys := v_qtys || v_qty;
    v_prices := v_prices || v_price;
    v_calcs := v_calcs || v_calc;
    v_sum := v_sum + round(v_qty * v_price, 2);
  END LOOP;

  IF v_vat_rate = 0 THEN
    v_subtotal := v_sum;
    v_vat := 0;
    v_total := v_sum;
  ELSIF v_vat_mode = 'net' THEN
    v_subtotal := v_sum;
    v_vat := round(v_sum * 0.20, 2);
    v_total := v_sum + v_vat;
  ELSE
    v_total := v_sum;
    v_vat := round(v_sum * 20 / 120, 2);
    v_subtotal := v_total - v_vat;
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'DOC_ZERO_TOTAL' USING ERRCODE = 'P0001';
  END IF;
  IF v_total > 999999999.99 THEN
    RAISE EXCEPTION 'DOC_TOTAL_TOO_LARGE' USING ERRCODE = 'P0001';
  END IF;

  IF p_parent IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.kp_documents WHERE id = p_parent AND org_id = v_org;
    IF p_kind <> 'act' OR NOT FOUND OR v_parent.kind <> 'invoice' OR v_parent.client_id <> p_client OR v_parent.status <> 'issued' THEN
      RAISE EXCEPTION 'DOC_BAD_PARENT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_kind = 'invoice' THEN
    v_due := coalesce(p_due_date, p_doc_date + coalesce(v_client.payment_terms_days, 5));
    IF v_due < p_doc_date OR v_due > p_doc_date + 366 THEN
      RAISE EXCEPTION 'DOC_BAD_DUE_DATE' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_year := extract(year FROM p_doc_date)::integer;
  v_no := public.kp_doc_alloc_number(v_org, p_kind, v_year, p_number);
  BEGIN
    INSERT INTO public.kp_documents (
      org_id, kind, number, doc_year, prefix, doc_date, client_id, parent_id, seller, buyer,
      currency, rate, rate_date, vat_mode, vat_rate, subtotal, vat_amount, total, total_uah, due_date, created_by
    ) VALUES (
      v_org, p_kind, v_no, v_year, CASE p_kind WHEN 'invoice' THEN v_req.invoice_prefix ELSE v_req.act_prefix END,
      p_doc_date, p_client, p_parent,
      jsonb_build_object(
        'legal_name', v_req.legal_name, 'legal_form', v_req.legal_form, 'edrpou', v_req.edrpou, 'ipn', v_req.ipn,
        'vat_payer', v_req.vat_payer, 'vat_number', v_req.vat_number, 'iban', v_req.iban, 'bank_name', v_req.bank_name,
        'legal_address', v_req.legal_address, 'signer_name', v_req.signer_name, 'signer_position', v_req.signer_position,
        'doc_place', v_req.doc_place, 'signature_path', v_req.signature_path, 'stamp_path', v_req.stamp_path),
      jsonb_build_object(
        'name', v_client.name, 'legal_name', v_client.legal_name, 'legal_form', v_client.legal_form,
        'edrpou', v_client.edrpou, 'ipn', v_client.ipn, 'vat_payer', v_client.vat_payer, 'vat_number', v_client.vat_number,
        'iban', v_client.iban, 'bank_name', v_client.bank_name, 'legal_address', v_client.legal_address,
        'signer_name', v_client.signer_name, 'signer_position', v_client.signer_position,
        'contract_no', v_client.contract_no, 'contract_date', v_client.contract_date,
        'payment_terms_days', v_client.payment_terms_days),
      v_currency, v_rate, v_rate_date, v_vat_mode, v_vat_rate, v_subtotal, v_vat, v_total, round(v_total * v_rate, 2), v_due, auth.uid()
    )
    RETURNING id INTO v_doc;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = v_no::text;
  END;

  -- Частковий UNIQUE (рейс, тип) серед активних — запобіжник для паралельних створень з тим самим рейсом.
  BEGIN
    INSERT INTO public.kp_document_lines (doc_id, org_id, kind, sort, calculation_id, title, unit, qty, price, amount)
    SELECT v_doc, v_org, p_kind, i, v_calcs[i], v_titles[i], v_units[i], v_qtys[i], v_prices[i], round(v_qtys[i] * v_prices[i], 2)
    FROM generate_subscripts(v_titles, 1) AS i;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'TRIP_ALREADY_BILLED' USING ERRCODE = 'P0001';
  END;
  RETURN v_doc;
END;
$$;

-- Анулює лише власник; причина обовʼязкова. Рахунок з активними оплатами — спершу анулювати оплати.
CREATE OR REPLACE FUNCTION public.kp_doc_cancel(p_doc uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_doc public.kp_documents%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO v_doc FROM public.kp_documents WHERE id = p_doc AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc.status = 'cancelled' THEN
    RAISE EXCEPTION 'DOC_ALREADY_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'DOC_CANCEL_REASON' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.kp_document_payments AS p WHERE p.doc_id = p_doc AND p.voided_at IS NULL) THEN
    RAISE EXCEPTION 'DOC_HAS_PAYMENTS' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_documents
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancelled_reason = v_reason
  WHERE id = p_doc;
  UPDATE public.kp_document_lines SET active = false WHERE doc_id = p_doc AND active;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Read: list and one document
-- ---------------------------------------------------------------------------

-- p_status: issued | partial | paid | overdue | cancelled | unpaid (усе неоплачене активне) | NULL.
CREATE OR REPLACE FUNCTION public.kp_doc_list(p_kind text, p_from date, p_to date, p_client uuid DEFAULT NULL, p_status text DEFAULT NULL)
RETURNS TABLE (
  id uuid, kind text, number integer, prefix text, number_text text, doc_date date, client_id uuid, client_name text,
  currency text, total numeric, total_uah numeric, paid numeric, debt numeric, due_date date, status text, pay_status text,
  parent_id uuid, cancelled_at timestamptz, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_today date := public.ua_today();
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('invoice', 'act', 'ttn') THEN
    RAISE EXCEPTION 'DOC_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('issued', 'partial', 'paid', 'overdue', 'cancelled', 'unpaid') THEN
    RAISE EXCEPTION 'DOC_BAD_STATUS' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  WITH docs AS (
    SELECT d.*, CASE WHEN d.kind = 'invoice' THEN public.kp_doc_paid(d.id) ELSE NULL END AS paid_sum
    FROM public.kp_documents AS d
    WHERE d.org_id = v_org
      AND d.doc_date BETWEEN p_from AND p_to
      AND (p_kind IS NULL OR d.kind = p_kind)
      AND (p_client IS NULL OR d.client_id = p_client)
  ), ranked AS (
    SELECT x.*, public.kp_doc_pay_status(x.kind, x.status, x.total, x.paid_sum, x.due_date, v_today) AS st
    FROM docs AS x
  )
  SELECT r.id, r.kind, r.number, r.prefix, coalesce(r.prefix, '') || r.number::text, r.doc_date, r.client_id,
         coalesce(cl.name, r.buyer ->> 'name'), r.currency, r.total, r.total_uah,
         r.paid_sum, CASE WHEN r.kind = 'invoice' AND r.status = 'issued' THEN r.total - r.paid_sum END,
         r.due_date, r.status, r.st, r.parent_id, r.cancelled_at, r.created_at
  FROM ranked AS r
  LEFT JOIN public.clients AS cl ON cl.id = r.client_id
  WHERE p_status IS NULL
     OR r.st = p_status
     OR (p_status = 'unpaid' AND r.kind = 'invoice' AND r.st IN ('issued', 'partial', 'overdue'))
  ORDER BY r.doc_date DESC, r.kind, r.number DESC
  LIMIT 5000;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_doc_get(p_doc uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_doc public.kp_documents%ROWTYPE;
  v_paid numeric;
BEGIN
  SELECT * INTO v_doc FROM public.kp_documents WHERE id = p_doc AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_paid := CASE WHEN v_doc.kind = 'invoice' THEN public.kp_doc_paid(v_doc.id) END;
  RETURN (to_jsonb(v_doc) - 'org_id') || jsonb_build_object(
    'number_text', coalesce(v_doc.prefix, '') || v_doc.number::text,
    'client_name', coalesce((SELECT cl.name FROM public.clients AS cl WHERE cl.id = v_doc.client_id), v_doc.buyer ->> 'name'),
    'paid', v_paid,
    'debt', CASE WHEN v_doc.kind = 'invoice' AND v_doc.status = 'issued' THEN v_doc.total - v_paid END,
    'pay_status', public.kp_doc_pay_status(v_doc.kind, v_doc.status, v_doc.total, v_paid, v_doc.due_date, public.ua_today()),
    'created_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_doc.created_by),
    'cancelled_by_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = v_doc.cancelled_by),
    'parent', (
      SELECT jsonb_build_object('id', d.id, 'kind', d.kind, 'number_text', coalesce(d.prefix, '') || d.number::text,
                                'doc_date', d.doc_date, 'status', d.status)
      FROM public.kp_documents AS d WHERE d.id = v_doc.parent_id
    ),
    'children', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'number_text', coalesce(d.prefix, '') || d.number::text,
                                          'doc_date', d.doc_date, 'status', d.status) ORDER BY d.doc_date, d.number)
      FROM public.kp_documents AS d WHERE d.parent_id = v_doc.id
    ), '[]'::jsonb),
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object('sort', l.sort, 'calculation_id', l.calculation_id, 'title', l.title, 'unit', l.unit,
                                          'qty', l.qty, 'price', l.price, 'amount', l.amount) ORDER BY l.sort)
      FROM public.kp_document_lines AS l WHERE l.doc_id = v_doc.id
    ), '[]'::jsonb),
    'payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'paid_on', p.paid_on, 'amount', p.amount, 'note', p.note,
                                          'created_at', p.created_at, 'voided_at', p.voided_at) ORDER BY p.paid_on, p.created_at)
      FROM public.kp_document_payments AS p WHERE p.doc_id = v_doc.id
    ), '[]'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Payments and debts (in the document currency, no exchange differences)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_payment_add(p_doc uuid, p_paid_on date, p_amount numeric, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_doc public.kp_documents%ROWTYPE;
  v_amount numeric := round(p_amount, 2);
  v_paid numeric;
  v_id uuid;
BEGIN
  -- Блокування документа: паралельні оплати одного рахунку не перевищать суму.
  SELECT * INTO v_doc FROM public.kp_documents WHERE id = p_doc AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc.kind <> 'invoice' THEN
    RAISE EXCEPTION 'PAYMENT_NOT_INVOICE' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc.status <> 'issued' THEN
    RAISE EXCEPTION 'DOC_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  IF p_paid_on IS NULL OR p_paid_on < DATE '2000-01-01' OR p_paid_on > public.ua_today() THEN
    RAISE EXCEPTION 'PAYMENT_BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_BAD_AMOUNT' USING ERRCODE = 'P0001';
  END IF;
  IF p_note IS NOT NULL AND char_length(btrim(p_note)) > 500 THEN
    RAISE EXCEPTION 'PAYMENT_BAD_NOTE' USING ERRCODE = 'P0001';
  END IF;
  v_paid := public.kp_doc_paid(p_doc);
  IF v_paid + v_amount > v_doc.total THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS' USING ERRCODE = 'P0001', DETAIL = (v_doc.total - v_paid)::text;
  END IF;
  INSERT INTO public.kp_document_payments (org_id, doc_id, paid_on, amount, note, created_by)
  VALUES (v_org, p_doc, p_paid_on, v_amount, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_payment_void(p_payment uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_doc uuid;
BEGIN
  SELECT p.doc_id INTO v_doc FROM public.kp_document_payments AS p WHERE p.id = p_payment AND p.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.kp_documents WHERE id = v_doc FOR UPDATE;
  PERFORM 1 FROM public.kp_document_payments WHERE id = p_payment AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_VOIDED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_document_payments SET voided_at = now(), voided_by = auth.uid() WHERE id = p_payment;
  RETURN true;
END;
$$;

-- Борги на дату (NULL — сьогодні за Києвом): активні рахунки з doc_date ≤ дати, оплати з paid_on ≤ дати.
-- Прострочено — due_date < дати і борг > 0. Окремий рядок на кожну валюту клієнта (суми різних валют не додаються).
CREATE OR REPLACE FUNCTION public.kp_client_debts(p_on date DEFAULT NULL)
RETURNS TABLE (
  client_id uuid, client_name text, currency text, invoices integer, invoiced numeric, paid numeric, debt numeric,
  overdue numeric, overdue_invoices integer, oldest_due date, overdue_days integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_on date := coalesce(p_on, public.ua_today());
BEGIN
  IF v_on < DATE '2000-01-01' OR v_on > public.ua_today() + 366 THEN
    RAISE EXCEPTION 'BAD_DATE' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  WITH inv AS (
    SELECT d.client_id AS c_id, d.currency AS cur, d.total AS amt, d.due_date AS due,
           coalesce((SELECT sum(p.amount) FROM public.kp_document_payments AS p
                     WHERE p.doc_id = d.id AND p.voided_at IS NULL AND p.paid_on <= v_on), 0) AS got
    FROM public.kp_documents AS d
    WHERE d.org_id = v_org AND d.kind = 'invoice' AND d.status = 'issued' AND d.doc_date <= v_on
  ), agg AS (
    SELECT i.c_id, i.cur, count(*)::integer AS n, sum(i.amt) AS s_amt, sum(i.got) AS s_got,
           coalesce(sum(i.amt - i.got) FILTER (WHERE i.due < v_on AND i.amt > i.got), 0) AS s_over,
           (count(*) FILTER (WHERE i.due < v_on AND i.amt > i.got))::integer AS n_over,
           min(i.due) FILTER (WHERE i.due < v_on AND i.amt > i.got) AS old_due
    FROM inv AS i
    GROUP BY i.c_id, i.cur
  )
  SELECT a.c_id, coalesce(cl.name, '—'), a.cur, a.n, a.s_amt, a.s_got, a.s_amt - a.s_got, a.s_over, a.n_over, a.old_due,
         CASE WHEN a.old_due IS NULL THEN NULL ELSE (v_on - a.old_due)::integer END
  FROM agg AS a
  LEFT JOIN public.clients AS cl ON cl.id = a.c_id
  ORDER BY a.s_over DESC, a.s_amt - a.s_got DESC, cl.name, a.cur
  LIMIT 5000;
END;
$$;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for the signature and the stamp
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kp-doc-assets', 'kp-doc-assets', false, 524288, ARRAY['image/png', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;

-- Шлях: <org_id>/(signature|stamp).(png|jpg). Читають учасники організації Контроль+ (owner, logist, director),
-- пише / замінює / видаляє лише власник. Політики стосуються тільки цього бакета.
DROP POLICY IF EXISTS kp_doc_assets_select ON storage.objects;
CREATE POLICY kp_doc_assets_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'kp-doc-assets'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(signature|stamp)\.(png|jpg)$'
    AND split_part(name, '/', 1) = public.kp_org_id()::text
  );

DROP POLICY IF EXISTS kp_doc_assets_insert ON storage.objects;
CREATE POLICY kp_doc_assets_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'kp-doc-assets'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(signature|stamp)\.(png|jpg)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write() AND public.kp_role() = 'owner'
  );

DROP POLICY IF EXISTS kp_doc_assets_update ON storage.objects;
CREATE POLICY kp_doc_assets_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'kp-doc-assets'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(signature|stamp)\.(png|jpg)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write() AND public.kp_role() = 'owner'
  )
  WITH CHECK (
    bucket_id = 'kp-doc-assets'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(signature|stamp)\.(png|jpg)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write() AND public.kp_role() = 'owner'
  );

DROP POLICY IF EXISTS kp_doc_assets_delete ON storage.objects;
CREATE POLICY kp_doc_assets_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'kp-doc-assets'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(signature|stamp)\.(png|jpg)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write() AND public.kp_role() = 'owner'
  );

-- ---------------------------------------------------------------------------
-- Grants on functions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  -- Внутрішні: тригери й хелпери — жодній ролі API.
  FOREACH f IN ARRAY ARRAY[
    'public.kp_documents_guard()',
    'public.kp_document_lines_guard()',
    'public.kp_document_payments_guard()',
    'public.kp_docs_org(text)',
    'public.kp_doc_alloc_number(uuid, text, integer, integer)',
    'public.kp_doc_pay_status(text, text, numeric, numeric, date, date)',
    'public.kp_doc_paid(uuid)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
  END LOOP;
  -- Клієнтські RPC.
  FOREACH f IN ARRAY ARRAY[
    'public.kp_requisites_get()',
    'public.kp_requisites_save(jsonb)',
    'public.kp_doc_trips_for_client(uuid, date, date, text)',
    'public.kp_doc_next_number(text, date)',
    'public.kp_doc_create(text, uuid, date, text, integer, jsonb, uuid, date, text, numeric, date)',
    'public.kp_doc_cancel(uuid, text)',
    'public.kp_doc_list(text, date, date, uuid, text)',
    'public.kp_doc_get(uuid)',
    'public.kp_payment_add(uuid, date, numeric, text)',
    'public.kp_payment_void(uuid)',
    'public.kp_client_debts(date)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;
