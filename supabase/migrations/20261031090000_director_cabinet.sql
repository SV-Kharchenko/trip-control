-- Apply manually after review. This file is not applied to production by the agent.
--
-- Кабінет директора: права учасників команди і сповіщення директору.
--
-- * org_member_permissions — права логіста (створювати акти, використовувати підпис і печатку, редагувати Автопарк,
--   додавати клієнтів, працювати з договорами). Рядка немає = значення за замовчуванням: усе дозволено, крім підпису
--   і печатки (його вмикає директор). Власник (owner) має всі права завжди. Пишуть лише API (service_role); клієнт
--   читає свій рядок, директор — рядки своєї організації.
-- * member_can(perm) / member_require(perm) — перевірка прав НА СЕРВЕРІ. Тригери на clients, fleet_vehicles,
--   kp_documents і функції kp_doc_create / kp_ttn_create / kp_doc_assets_source викликають їх; сервісні виклики без
--   користувача (auth.uid() IS NULL) проходять. Відмова — SQLSTATE 42501, повідомлення MEMBER_PERMISSION_DENIED
--   (PostgREST віддає 403), у DETAIL — назва права.
-- * Без права «підпис і печатка» логіст усе одно створює акти й ТТН, але без підпису й печатки: знімки не копіюються
--   (/api/docs/assets повертає порожні шляхи), у seller / carrier шляхів немає.
-- * org_notifications — сповіщення директору (заявка чекає погодження; логіст використав підпис чи печатку на
--   документі). Створюють лише тригер calculations (відправка на погодження) і kp_doc_create / kp_ttn_create через
--   org_notify; клієнт напряму не пише, читає лише директор своєї організації. «Прочитано» ставить API.
-- * kp_doc_create, kp_ttn_create, kp_doc_assets_source — ті самі функції з 20261026072759 / 20261026130623 з
--   точковими правками (перевірка прав, підпис лише з правом, сповіщення). Інше тіло дослівно.
--
-- Ідемпотентно. Існуючі дані не змінюються. Після 20261030091000_kp_trip_sheet_followups.sql.
--
-- РУЧНИЙ ВІДКАТ (виконати в SQL editor, у такому порядку):
--   DROP TRIGGER IF EXISTS trg_calculations_notify_pending ON public.calculations;
--   DROP TRIGGER IF EXISTS trg_clients_member_guard ON public.clients;
--   DROP TRIGGER IF EXISTS trg_fleet_vehicles_member_guard ON public.fleet_vehicles;
--   DROP TRIGGER IF EXISTS trg_fleet_trailers_member_guard ON public.fleet_trailers;
--   DROP TRIGGER IF EXISTS trg_kp_drivers_member_guard ON public.kp_drivers;
--   DROP TRIGGER IF EXISTS trg_kp_documents_member_guard ON public.kp_documents;
--   Потім заново виконати CREATE OR REPLACE FUNCTION kp_doc_create, kp_doc_assets_source з 20261026072759_kp_documents.sql і
--   kp_ttn_create з 20261026130623_kp_docs_ttn.sql (повертає оригінальні тіла).
--   DROP FUNCTION IF EXISTS public.calculations_notify_pending(), public.clients_member_guard(),
--     public.fleet_vehicles_member_guard(), public.kp_documents_member_guard(), public.org_notify(uuid, text, text, uuid, uuid, jsonb),
--     public.member_require(text), public.member_can(text);
--   DROP TABLE IF EXISTS public.org_notifications, public.org_member_permissions;

-- ---------------------------------------------------------------------------
-- Права учасників
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_member_permissions (
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  can_acts boolean NOT NULL DEFAULT true,
  can_sign boolean NOT NULL DEFAULT false,
  can_fleet boolean NOT NULL DEFAULT true,
  can_clients boolean NOT NULL DEFAULT true,
  can_contracts boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE public.org_member_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_member_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.org_member_permissions TO authenticated;
GRANT ALL ON TABLE public.org_member_permissions TO service_role;

DROP POLICY IF EXISTS org_member_permissions_select ON public.org_member_permissions;
CREATE POLICY org_member_permissions_select ON public.org_member_permissions
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND (user_id = auth.uid() OR public.is_org_owner()));

-- Право поточного користувача. Власник і ті, хто не логіст (директор іншої організації, менеджер з ремонтів), тут не
-- обмежуються — їхні межі задають kp_docs_org / RLS. Без користувача або з роллю service_role — дозволено.
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
  IF p_perm IS NULL OR p_perm NOT IN ('acts', 'sign', 'fleet', 'clients', 'contracts') THEN
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
    RETURN p_perm <> 'sign';
  END IF;
  RETURN CASE p_perm
    WHEN 'acts' THEN v_row.can_acts
    WHEN 'sign' THEN v_row.can_sign
    WHEN 'fleet' THEN v_row.can_fleet
    WHEN 'clients' THEN v_row.can_clients
    ELSE v_row.can_contracts
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.member_require(p_perm text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.member_can(p_perm) THEN
    RAISE EXCEPTION 'MEMBER_PERMISSION_DENIED' USING ERRCODE = '42501', DETAIL = p_perm;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.member_can(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.member_require(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_can(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_require(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Сповіщення директору
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('approval_pending', 'signature_used')),
  ref_kind text CHECK (ref_kind IN ('calculation', 'document', 'ttn')),
  ref_id uuid,
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object' AND pg_column_size(meta) < 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  read_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS org_notifications_org_created_idx ON public.org_notifications (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS org_notifications_unread_idx ON public.org_notifications (org_id) WHERE read_at IS NULL;

ALTER TABLE public.org_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.org_notifications TO authenticated;
GRANT ALL ON TABLE public.org_notifications TO service_role;

DROP POLICY IF EXISTS org_notifications_select ON public.org_notifications;
CREATE POLICY org_notifications_select ON public.org_notifications
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner());

-- Єдине місце, де створюються сповіщення. Викликається лише з тригерів і SECURITY DEFINER-функцій нижче.
CREATE OR REPLACE FUNCTION public.org_notify(p_org uuid, p_kind text, p_ref_kind text, p_ref uuid, p_actor uuid, p_meta jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.org_notifications (org_id, kind, ref_kind, ref_id, actor_id, meta)
  VALUES (p_org, p_kind, p_ref_kind, p_ref, p_actor, coalesce(p_meta, '{}'::jsonb));
$$;

REVOKE ALL ON FUNCTION public.org_notify(uuid, text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Заявка пішла на погодження: пише автор-логіст (через API це service_role, тож автор береться з рядка, а не з auth.uid()).
CREATE OR REPLACE FUNCTION public.calculations_notify_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT p.org_role INTO v_role FROM public.profiles AS p WHERE p.id = NEW.user_id;
  IF v_role = 'logist' THEN
    PERFORM public.org_notify(NEW.org_id, 'approval_pending', 'calculation', NEW.id, NEW.user_id,
      jsonb_build_object('name', left(coalesce(NEW.name, ''), 200)));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_notify_pending() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_calculations_notify_pending ON public.calculations;
CREATE TRIGGER trg_calculations_notify_pending
  AFTER UPDATE OF status ON public.calculations
  FOR EACH ROW
  WHEN (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending')
  EXECUTE FUNCTION public.calculations_notify_pending();

-- ---------------------------------------------------------------------------
-- Тригери прав
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.clients_member_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.member_require('clients');
    IF NEW.contract_no IS NOT NULL OR NEW.contract_date IS NOT NULL OR NEW.payment_terms_days IS NOT NULL THEN
      PERFORM public.member_require('contracts');
    END IF;
  ELSIF NEW.contract_no IS DISTINCT FROM OLD.contract_no
     OR NEW.contract_date IS DISTINCT FROM OLD.contract_date
     OR NEW.payment_terms_days IS DISTINCT FROM OLD.payment_terms_days THEN
    PERFORM public.member_require('contracts');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fleet_vehicles_member_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.member_require('fleet');
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_documents_member_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'act' THEN
    PERFORM public.member_require('acts');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.clients_member_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fleet_vehicles_member_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_documents_member_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_clients_member_guard ON public.clients;
CREATE TRIGGER trg_clients_member_guard
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_member_guard();

DROP TRIGGER IF EXISTS trg_fleet_vehicles_member_guard ON public.fleet_vehicles;
CREATE TRIGGER trg_fleet_vehicles_member_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.fleet_vehicles_member_guard();

-- Причепи і водії — частина Автопарку: те саме право «fleet» (kp_trailer_save, kp_driver_save і прямі зміни).
DROP TRIGGER IF EXISTS trg_fleet_trailers_member_guard ON public.fleet_trailers;
CREATE TRIGGER trg_fleet_trailers_member_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fleet_trailers
  FOR EACH ROW EXECUTE FUNCTION public.fleet_vehicles_member_guard();

DROP TRIGGER IF EXISTS trg_kp_drivers_member_guard ON public.kp_drivers;
CREATE TRIGGER trg_kp_drivers_member_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.kp_drivers
  FOR EACH ROW EXECUTE FUNCTION public.fleet_vehicles_member_guard();

DROP TRIGGER IF EXISTS trg_kp_documents_member_guard ON public.kp_documents;
CREATE TRIGGER trg_kp_documents_member_guard
  BEFORE INSERT ON public.kp_documents
  FOR EACH ROW EXECUTE FUNCTION public.kp_documents_member_guard();

-- ---------------------------------------------------------------------------
-- Функції документів: права, підпис лише з правом, сповіщення (решта тіла — з попередніх міграцій дослівно)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_doc_assets_source()
RETURNS TABLE (org_id uuid, signature_path text, stamp_path text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('write');
BEGIN
  RETURN QUERY
  SELECT v_org,
         CASE WHEN public.member_can('sign') THEN r.signature_path END,
         CASE WHEN public.member_can('sign') THEN r.stamp_path END
  FROM (SELECT 1) AS one
  LEFT JOIN public.kp_org_requisites AS r ON r.org_id = v_org;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_doc_create(
  p_kind text, p_client uuid, p_doc_date date, p_currency text, p_number integer DEFAULT NULL, p_lines jsonb DEFAULT NULL,
  p_parent uuid DEFAULT NULL, p_due_date date DEFAULT NULL, p_vat_mode text DEFAULT NULL, p_rate numeric DEFAULT NULL,
  p_rate_date date DEFAULT NULL, p_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_req public.kp_org_requisites%ROWTYPE;
  v_can_sign boolean := public.member_can('sign');
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
  v_doc uuid := coalesce(p_id, gen_random_uuid());
  v_sig text;
  v_stamp text;
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
  IF p_kind = 'act' THEN
    PERFORM public.member_require('acts');
  END IF;
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

  -- Знімок підпису й печатки: шлях документа з розширенням файлу реквізитів; файл уже скопійовано сервером.
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.kp_documents AS d WHERE d.id = p_id) THEN
    RAISE EXCEPTION 'DOC_ID_TAKEN' USING ERRCODE = 'P0001';
  END IF;
  v_sig := CASE WHEN v_req.signature_path IS NOT NULL AND v_can_sign
    THEN v_org::text || '/docs/' || v_doc::text || '/signature.' || substring(v_req.signature_path FROM '\.(png|jpg)$') END;
  v_stamp := CASE WHEN v_req.stamp_path IS NOT NULL AND v_can_sign
    THEN v_org::text || '/docs/' || v_doc::text || '/stamp.' || substring(v_req.stamp_path FROM '\.(png|jpg)$') END;
  IF (v_sig IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_sig))
     OR (v_stamp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'kp-doc-assets' AND o.name = v_stamp)) THEN
    RAISE EXCEPTION 'DOC_ASSETS_NOT_COPIED' USING ERRCODE = 'P0001';
  END IF;

  v_year := extract(year FROM p_doc_date)::integer;
  v_no := public.kp_doc_alloc_number(v_org, p_kind, v_year, p_number);
  BEGIN
    INSERT INTO public.kp_documents (
      id, org_id, kind, number, doc_year, prefix, doc_date, client_id, parent_id, seller, buyer,
      currency, rate, rate_date, vat_mode, vat_rate, subtotal, vat_amount, total, total_uah, due_date, created_by
    ) VALUES (
      v_doc, v_org, p_kind, v_no, v_year, CASE p_kind WHEN 'invoice' THEN v_req.invoice_prefix ELSE v_req.act_prefix END,
      p_doc_date, p_client, p_parent,
      jsonb_build_object(
        'legal_name', v_req.legal_name, 'legal_form', v_req.legal_form, 'edrpou', v_req.edrpou, 'ipn', v_req.ipn,
        'vat_payer', v_req.vat_payer, 'vat_number', v_req.vat_number, 'iban', v_req.iban, 'bank_name', v_req.bank_name,
        'legal_address', v_req.legal_address, 'signer_name', v_req.signer_name, 'signer_position', v_req.signer_position,
        'doc_place', v_req.doc_place, 'signature_path', v_sig, 'stamp_path', v_stamp),
      jsonb_build_object(
        'name', v_client.name, 'legal_name', v_client.legal_name, 'legal_form', v_client.legal_form,
        'edrpou', v_client.edrpou, 'ipn', v_client.ipn, 'vat_payer', v_client.vat_payer, 'vat_number', v_client.vat_number,
        'iban', v_client.iban, 'bank_name', v_client.bank_name, 'legal_address', v_client.legal_address,
        'signer_name', v_client.signer_name, 'signer_position', v_client.signer_position,
        'contract_no', v_client.contract_no, 'contract_date', v_client.contract_date,
        'payment_terms_days', v_client.payment_terms_days),
      v_currency, v_rate, v_rate_date, v_vat_mode, v_vat_rate, v_subtotal, v_vat, v_total, round(v_total * v_rate, 2), v_due, auth.uid()
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DOC_NUMBER_TAKEN' USING ERRCODE = 'P0001', DETAIL = v_no::text;
  END;

  -- Підпис чи печатка логіста на документі → сповіщення директору (пише сервер, не клієнт).
  IF (v_sig IS NOT NULL OR v_stamp IS NOT NULL) AND public.kp_role() = 'logist' THEN
    PERFORM public.org_notify(v_org, 'signature_used', 'document', v_doc, auth.uid(),
      jsonb_build_object('doc_kind', p_kind, 'number', v_no, 'prefix', CASE p_kind WHEN 'invoice' THEN v_req.invoice_prefix ELSE v_req.act_prefix END));
  END IF;

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
  v_can_sign boolean := public.member_can('sign');
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
  v_sig := CASE WHEN v_req.signature_path IS NOT NULL AND v_can_sign
    THEN v_org::text || '/docs/' || v_doc::text || '/signature.' || substring(v_req.signature_path FROM '\.(png|jpg)$') END;
  v_stamp := CASE WHEN v_req.stamp_path IS NOT NULL AND v_can_sign
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

  IF (v_sig IS NOT NULL OR v_stamp IS NOT NULL) AND public.kp_role() = 'logist' THEN
    PERFORM public.org_notify(v_org, 'signature_used', 'ttn', v_doc, auth.uid(),
      jsonb_build_object('doc_kind', 'ttn', 'number', v_no, 'prefix', v_req.ttn_prefix));
  END IF;

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
