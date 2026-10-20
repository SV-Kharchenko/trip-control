-- Auto-renewal through WayForPay regular payments.
--
-- * org_subscriptions: auto_renew (off by default), the WayForPay regular reference (the order
--   reference of the first payment), card mask, next charge date, last known regular status,
--   consecutive failed charges, consent and cancellation times.
-- * payments.kind: 'initial' (an invoice the owner paid) or 'renewal' (a charge WayForPay made on
--   its own; orderReference = <initial orderReference>_WFPREG-<digits>), parent_payment_id → the
--   initial payment. payments.auto_renew_requested_at: the owner ticked auto-renewal for this
--   invoice (the time is the consent time); only such a payment turns auto_renew on when credited.
-- * Renewals are credited by the same apply_payment_success(); the unique
--   (provider, provider_order_id) index stays as it is (every charge has its own reference).
-- * record_renewal_failure(): fail_count + 1, atomically; the server stops the regular at 2.
-- * Clients keep read access to the old org_subscriptions columns only (paid_until etc.): card mask
--   and the regular reference are server-only. Clients still cannot write either table.
--
-- New file only. Idempotent. Not applied to production by this PR.

ALTER TABLE public.org_subscriptions
  ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wfp_regular_order_ref text NULL,
  ADD COLUMN IF NOT EXISTS card_mask text NULL,
  ADD COLUMN IF NOT EXISTS next_charge_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS regular_status text NULL,
  -- regular_status = 'RemovePending': REMOVE ще не підтверджено, auto_renew лишається true, крон повторює REMOVE.
  -- Причина (renewal_failed / refund / owner / admin / org_blocked / no_owner / org_missing) — що робити після підтвердження.
  ADD COLUMN IF NOT EXISTS regular_remove_reason text NULL,
  ADD COLUMN IF NOT EXISTS fail_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_renew_consent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS auto_renew_cancelled_at timestamptz NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'initial',
  ADD COLUMN IF NOT EXISTS parent_payment_id uuid NULL REFERENCES public.payments (id),
  ADD COLUMN IF NOT EXISTS auto_renew_requested_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_kind_check' AND conrelid = 'public.payments'::regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_kind_check CHECK (kind IN ('initial', 'renewal'));
  END IF;
  -- A renewal always points to its initial payment; an initial payment never does.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_renewal_parent_check' AND conrelid = 'public.payments'::regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_renewal_parent_check CHECK ((kind = 'renewal') = (parent_payment_id IS NOT NULL));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS payments_parent_idx
  ON public.payments (parent_payment_id)
  WHERE parent_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_subscriptions_auto_renew_idx
  ON public.org_subscriptions (org_id)
  WHERE auto_renew;

-- Members read paid_until of their company (RLS org_subscriptions_select_own_org stays);
-- the auto-renewal columns are read by the server only.
REVOKE SELECT ON public.org_subscriptions FROM authenticated;
GRANT SELECT (org_id, paid_until, last_plan, reminder_sent_for, updated_at) ON public.org_subscriptions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.org_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_renewal_failure(p_org uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.org_subscriptions
  SET fail_count = fail_count + 1,
      updated_at = now()
  WHERE org_id = p_org
  RETURNING fail_count INTO v_count;
  RETURN coalesce(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.record_renewal_failure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_renewal_failure(uuid) TO service_role;
