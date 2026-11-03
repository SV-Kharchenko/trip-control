-- Apply manually after review. This file is not applied to production by the agent.
--
-- «Реєстр заявок», PR C: документи й оплати в реєстрі (лише Контроль+).
--
-- ЯК УСТРОЄНО (знайдено, нових сутностей не вигадуємо): рахунки й акти — kp_documents (kind invoice | act); рядки документа з посиланням
-- на заявку — kp_document_lines.calculation_id; акт «на підставі рахунку» має parent_id = id рахунку (той самий клієнт). Договір —
-- kp_contracts на КЛІЄНТА (прямого зв'язку з заявкою чи документом немає; клієнт заявки — calculation_clients). Оплати рахунків ведуться
-- журналом kp_document_payments (часткові суми, kp_payment_add / kp_payment_void); у актів оплат немає. Таблиці документів закриті від
-- клієнтів (RLS без політик, REVOKE ALL), доступ лише через SECURITY DEFINER RPC з kp_docs_org(), включно з директором (kp_org_id).
--
-- ЩО ДОДАНО:
--  * kp_documents.paid_at / paid_by — позначка «оплачено» для рахунку й акта (окрема від журналу часткових оплат kp_document_payments;
--    журнал не змінюється й не синхронізується). kp_documents_guard дозволяє змінювати лише ці два поля (разом зі статусом/анулюванням).
--  * registry_doc_set_paid(doc, paid) — ОДНА атомарна RPC: рахунок і всі його акти (parent_id) стають оплаченими/неоплаченими разом; акт
--    тягне свій рахунок і всі акти того ж рахунку. Анульовані документи не чіпаються. Тригерів немає, тож рекурсії немає; рядки блокуються
--    в порядку id. Доступ: директор (owner), директор КП (org_directors) і логіст із правом на документи (kp_can_write + member_can('acts'));
--    чужа організація / чужий документ — 42501 DOC_FORBIDDEN.
--  * registry_documents(calcs[]) — для сторінки реєстру: договір клієнта заявки (чинний на дату рейсу), рахунки й акти заявки з номером,
--    статусом і ознакою оплати.
--  * Чому SECURITY DEFINER, а не INVOKER: таблиці документів закриті від authenticated (REVOKE ALL, без політик); INVOKER вимагав би
--    відкрити їх (GRANT UPDATE + RLS-політики), що суперечить «RLS документів не розширювати». Як і всі kp_* RPC, функції самі перевіряють
--    доступ (kp_docs_org, kp_role, can_view_org, kp_trip_visible), а не довіряють виклику.
--
-- РУЧНИЙ ВІДКАТ (SQL editor, однією транзакцією; спершу функції, потім guard, потім колонки — дані paid_at / paid_by буде втрачено):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.registry_doc_set_paid(uuid, boolean);
--   DROP FUNCTION IF EXISTS public.registry_documents(uuid[]);
--   -- Оригінальне тіло kp_documents_guard(): виконати CREATE OR REPLACE FUNCTION public.kp_documents_guard() з
--   -- 20261026072759_kp_documents.sql (дозволяє змінювати лише status / cancelled_*).
--   ALTER TABLE public.kp_documents DROP COLUMN IF EXISTS paid_by, DROP COLUMN IF EXISTS paid_at;
--   COMMIT;

BEGIN;

ALTER TABLE public.kp_documents
  ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paid_by uuid NULL REFERENCES auth.users (id) ON DELETE SET NULL;

-- Те саме тіло, що в 20261026072759_kp_documents.sql, плюс paid_at / paid_by серед змінюваних полів.
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
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason', 'paid_at', 'paid_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason', 'paid_at', 'paid_by'])
     OR (OLD.status = 'cancelled' AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))) THEN
    RAISE EXCEPTION 'DOC_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Оплата: рахунок і всі його акти — разом, в обидва боки
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registry_doc_set_paid(p_doc uuid, p_paid boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_role text;
  v_doc public.kp_documents%ROWTYPE;
  v_root uuid;
  v_ids uuid[];
  v_changed integer;
BEGIN
  IF p_doc IS NULL OR p_paid IS NULL THEN
    RAISE EXCEPTION 'BAD_ARGS' USING ERRCODE = 'P0001';
  END IF;
  -- Контроль+ (control_plus), роль owner / logist / director; заблокований користувач не проходить.
  v_org := public.kp_docs_org('read');
  v_role := public.kp_role();
  IF public.is_user_blocked() OR NOT public.can_view_org(v_org) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'logist' THEN
    -- Логіст: може працювати з документами (kp_can_write) і має право на акти.
    IF NOT public.kp_can_write() OR NOT public.member_can('acts') THEN
      RAISE EXCEPTION 'PAYMENT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF v_role = 'owner' THEN
    IF NOT public.kp_can_write() THEN
      RAISE EXCEPTION 'PAYMENT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF v_role IS DISTINCT FROM 'director' THEN
    RAISE EXCEPTION 'PAYMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_doc FROM public.kp_documents WHERE id = p_doc;
  IF NOT FOUND OR v_doc.org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'DOC_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_doc.kind NOT IN ('invoice', 'act') THEN
    RAISE EXCEPTION 'PAID_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc.status <> 'issued' THEN
    RAISE EXCEPTION 'DOC_CANCELLED' USING ERRCODE = 'P0001';
  END IF;

  -- Група: рахунок (корінь) + усі його акти; акт без рахунку — лише він сам.
  v_root := CASE WHEN v_doc.kind = 'invoice' THEN v_doc.id ELSE v_doc.parent_id END;
  IF v_root IS NULL THEN
    v_ids := ARRAY[v_doc.id];
  ELSE
    SELECT array_agg(d.id ORDER BY d.id) INTO v_ids
    FROM public.kp_documents AS d
    WHERE d.org_id = v_org AND d.status = 'issued' AND (d.id = v_root OR d.parent_id = v_root);
  END IF;

  -- Блокування в стабільному порядку (паралельні виклики не стають у взаємну чергу), потім один UPDATE на всю групу.
  PERFORM 1 FROM public.kp_documents WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  UPDATE public.kp_documents
  SET paid_at = CASE WHEN p_paid THEN coalesce(paid_at, now()) END,
      paid_by = CASE WHEN p_paid THEN coalesce(paid_by, auth.uid()) END
  WHERE id = ANY (v_ids);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN jsonb_build_object('paid', p_paid, 'doc_ids', to_jsonb(v_ids), 'count', v_changed);
END;
$$;

-- ---------------------------------------------------------------------------
-- Документи заявок для сторінки реєстру
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registry_documents(p_calcs uuid[])
RETURNS TABLE (
  calculation_id uuid, client_id uuid, contract_id uuid, contract_no text, contract_date date, contract_status text, docs jsonb
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
  IF NOT public.can_view_org(v_org) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_calcs IS NULL OR cardinality(p_calcs) > 200 THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT c.id, cc.client_id, k.id, k.number, k.contract_date, k.status,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'id', d.id, 'kind', d.kind, 'number', coalesce(d.prefix, '') || d.number::text, 'status', d.status,
                    'paid', d.paid_at IS NOT NULL, 'total', d.total, 'currency', d.currency
                  ) ORDER BY d.kind, d.doc_date, d.number)
           FROM public.kp_documents AS d
           WHERE d.org_id = v_org AND d.kind IN ('invoice', 'act')
             AND EXISTS (SELECT 1 FROM public.kp_document_lines AS l WHERE l.doc_id = d.id AND l.calculation_id = c.id)
         ), '[]'::jsonb)
  FROM public.calculations AS c
  LEFT JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
  LEFT JOIN LATERAL (
    SELECT x.* FROM public.kp_contracts AS x
    WHERE x.org_id = v_org AND x.client_id = cc.client_id AND x.cancelled_at IS NULL
      AND x.contract_date <= coalesce(c.trip_date, public.ua_today())
      AND (x.valid_until IS NULL OR x.valid_until >= coalesce(c.trip_date, public.ua_today()))
    ORDER BY x.contract_date DESC, x.created_at DESC
    LIMIT 1
  ) AS k ON true
  WHERE c.id = ANY (p_calcs) AND c.org_id = v_org AND public.kp_trip_visible(c.user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.registry_doc_set_paid(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.registry_documents(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registry_doc_set_paid(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.registry_documents(uuid[]) TO authenticated, service_role;

COMMIT;
