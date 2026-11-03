-- Apply manually after review. This file is not applied to production by the agent.
--
-- Каркас CRM Контроль+: лічильник неоплачених рахунків у бічному меню — легка RPC замість вибірки всіх документів через kp_doc_list.
--
-- Чому RPC, а не select з count: таблиці документів закриті від authenticated (RLS без політик, REVOKE ALL), тож head-запит count
-- через PostgREST неможливий; SECURITY INVOKER теж не спрацює (у authenticated немає прав на kp_documents). Як і всі kp_* RPC, це
-- SECURITY DEFINER із перевіркою доступу першим рядком (kp_docs_org('read'): Контроль+, owner / logist / director своєї компанії).
--
-- Що рахується: чинні (issued) рахунки компанії, не позначені «оплачено» (kp_documents.paid_at, реєстр заявок) і з незакритим боргом за
-- журналом оплат — той самий kp_doc_pay_status IN ('issued', 'partial', 'overdue'), що й фільтр «unpaid» у kp_doc_list, але за весь час і
-- без вибірки рядків. Акти, анульовані, повністю оплачені й позначені оплаченими не рахуються.
--
-- РУЧНИЙ ВІДКАТ (SQL editor): DROP FUNCTION IF EXISTS public.kp_unpaid_invoices_count();

BEGIN;

CREATE OR REPLACE FUNCTION public.kp_unpaid_invoices_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_today date := public.ua_today();
BEGIN
  RETURN (
    SELECT count(*)::integer
    FROM public.kp_documents AS d
    WHERE d.org_id = v_org AND d.kind = 'invoice' AND d.status = 'issued' AND d.paid_at IS NULL
      AND public.kp_doc_pay_status(d.kind, d.status, d.total, public.kp_doc_paid(d.id), d.due_date, v_today) IN ('issued', 'partial', 'overdue')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kp_unpaid_invoices_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_unpaid_invoices_count() TO authenticated, service_role;

COMMIT;
