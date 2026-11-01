-- Apply manually after review. This file is not applied to production by the agent.
-- Реєстр договорів у «Документах» (вкладка «Договори»): статус «анульовано» (лише власник), загальний список із клієнтом,
-- періодом і статусом «діє / закінчився / анульовано». Таблиця kp_contracts, бакет kp-contracts, підпис і пошта — з 20261102090000.
-- Лише ADD COLUMN IF NOT EXISTS, заміна CHECK статусу і CREATE OR REPLACE двох нових функцій; дані не чіпаються.
--
-- РУЧНИЙ ВІДКАТ (лише якщо немає анульованих договорів):
--   DROP FUNCTION IF EXISTS public.kp_contract_cancel(uuid, text);
--   DROP FUNCTION IF EXISTS public.kp_contract_list_all(uuid, date, date, text);
--   ALTER TABLE public.kp_contracts DROP CONSTRAINT IF EXISTS kp_contracts_status_check;
--   ALTER TABLE public.kp_contracts ADD CONSTRAINT kp_contracts_status_check CHECK (status IN ('draft', 'signed', 'sent'));
--   ALTER TABLE public.kp_contracts DROP CONSTRAINT IF EXISTS kp_contracts_cancel_reason_check;
--   ALTER TABLE public.kp_contracts DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS cancelled_by;

ALTER TABLE public.kp_contracts ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.kp_contracts ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE public.kp_contracts ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.kp_contracts DROP CONSTRAINT IF EXISTS kp_contracts_status_check;
ALTER TABLE public.kp_contracts ADD CONSTRAINT kp_contracts_status_check CHECK (status IN ('draft', 'signed', 'sent', 'cancelled'));
ALTER TABLE public.kp_contracts DROP CONSTRAINT IF EXISTS kp_contracts_cancel_reason_check;
ALTER TABLE public.kp_contracts ADD CONSTRAINT kp_contracts_cancel_reason_check
  CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500);

CREATE INDEX IF NOT EXISTS kp_contracts_org_date_idx ON public.kp_contracts (org_id, contract_date DESC);

-- Загальний список договорів організації. p_client / p_from / p_to (за датою договору) — необов'язкові.
-- p_status: active (не анульований і не закінчився) | expired (діяв до дати в минулому) | cancelled | NULL.
-- expired / expiring_soon рахуються за київською датою: «закінчується» — діє ще ≤ 30 днів.
CREATE OR REPLACE FUNCTION public.kp_contract_list_all(p_client uuid DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_status text DEFAULT NULL)
RETURNS TABLE (
  id uuid, client_id uuid, client_name text, number text, contract_date date, subject text, valid_until date, status text,
  file_path text, file_name text, signed_path text, sig_path text, sign_method text, signed_at timestamptz, sent_at timestamptz,
  cancelled_at timestamptz, cancel_reason text, expired boolean, expiring_soon boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_today date := (now() AT TIME ZONE 'Europe/Kyiv')::date;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'CONTRACT_BAD_STATUS' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT r.* FROM (
    SELECT c.id, c.client_id, cl.name AS client_name, c.number, c.contract_date, c.subject, c.valid_until, c.status,
           c.file_path, c.file_name, c.signed_path, c.sig_path, c.sign_method, c.signed_at, c.sent_at, c.cancelled_at, c.cancel_reason,
           (c.status <> 'cancelled' AND c.valid_until IS NOT NULL AND c.valid_until < v_today) AS expired,
           (c.status <> 'cancelled' AND c.valid_until IS NOT NULL AND c.valid_until >= v_today AND c.valid_until <= v_today + 30) AS expiring_soon
    FROM public.kp_contracts AS c
    JOIN public.clients AS cl ON cl.id = c.client_id AND cl.org_id = c.org_id
    WHERE c.org_id = v_org
      AND (p_client IS NULL OR c.client_id = p_client)
      AND (p_from IS NULL OR c.contract_date >= p_from)
      AND (p_to IS NULL OR c.contract_date <= p_to)
  ) AS r
  WHERE p_status IS NULL
     OR (p_status = 'cancelled' AND r.status = 'cancelled')
     OR (p_status = 'expired' AND r.expired)
     OR (p_status = 'active' AND r.status <> 'cancelled' AND NOT r.expired)
  ORDER BY r.contract_date DESC, r.number;
END;
$$;

-- Анулювання з причиною: лише власник; підписаний і надісланий договір теж можна анулювати, файли лишаються.
CREATE OR REPLACE FUNCTION public.kp_contract_cancel(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'CONTRACT_REASON' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_contracts
  SET status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason, cancelled_by = auth.uid(), updated_at = now()
  WHERE id = p_id AND org_id = v_org AND status <> 'cancelled';
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.kp_contracts WHERE id = p_id AND org_id = v_org) THEN
      RAISE EXCEPTION 'CONTRACT_ALREADY_CANCELLED' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'CONTRACT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_contract_list_all(uuid, date, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_contract_cancel(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_contract_list_all(uuid, date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_cancel(uuid, text) TO authenticated, service_role;
