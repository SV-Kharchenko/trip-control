-- A refund shortens the paid period automatically (instead of by hand).
--
-- * payments.reversal_applied_at — set once, when a credited payment's period has been taken
--   back from org_subscriptions.paid_until. A repeated refund notification changes nothing.
--   Payments already reversed / refunded before this migration are marked as handled.
-- * payments.partial_refund_alerted_at — mono partial refund (success, finalAmount < amount) alerted once.
-- * apply_payment_reversal() — the only way a refund touches paid_until:
--     - credited payment, full refund: paid_until -= (period_to - period_from), not below now()
--       (two months paid ahead, one refunded → the other month stays);
--     - credited payment, partial refund: status reversed, paid_until unchanged
--       (a later full refund notification can still cut once);
--     - payment never credited (pending etc.): status reversed, subscription unchanged;
--     - a manually 'refunded' payment is left as it is (manual path in docs/PAYMENTS.md).
--   Rows are locked FOR UPDATE, as in apply_payment_success().
-- * apply_payment_status() is unchanged; the server sends 'reversed' here instead.
-- * profiles.is_approved is not touched: manual full access stays permanent.
--
-- New file only. Idempotent. Not applied to production by this PR.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS reversal_applied_at timestamptz NULL;

-- mono reports a partial refund as status=success with finalAmount < amount: the admin is told once.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS partial_refund_alerted_at timestamptz NULL;

-- Payments refunded before this migration were already handled (status recorded, alert sent,
-- paid_until corrected by hand if needed): a repeated old refund notification must not cut the
-- period again or alert again.
UPDATE public.payments
SET reversal_applied_at = coalesce(updated_at, now())
WHERE status IN ('reversed', 'refunded')
  AND reversal_applied_at IS NULL;

CREATE OR REPLACE FUNCTION public.apply_payment_reversal(p_payment uuid, p_modified timestamptz, p_partial boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_until timestamptz;
  v_new timestamptz;
  v_status_changed boolean;
  v_cut boolean;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.paid_until INTO v_until FROM public.org_subscriptions AS s WHERE s.org_id = v_payment.org_id;

  -- An older notification after a newer one, or a payment refunded by hand: nothing to do.
  IF v_payment.status = 'refunded'
     OR (p_modified IS NOT NULL AND v_payment.provider_modified_at IS NOT NULL
         AND p_modified < v_payment.provider_modified_at)
  THEN
    RETURN jsonb_build_object('changed', false, 'cut', false, 'previous', v_payment.status, 'status', v_payment.status,
      'credited', v_payment.credited_at IS NOT NULL, 'partial', coalesce(p_partial, false), 'paid_until', v_until);
  END IF;

  v_status_changed := v_payment.status <> 'reversed';
  v_cut := v_payment.credited_at IS NOT NULL
    AND v_payment.reversal_applied_at IS NULL
    AND NOT coalesce(p_partial, false)
    AND v_payment.period_from IS NOT NULL
    AND v_payment.period_to IS NOT NULL;

  -- Same refund again (or a partial one after the status is already reversed).
  IF NOT v_status_changed AND NOT v_cut THEN
    RETURN jsonb_build_object('changed', false, 'cut', false, 'previous', v_payment.status, 'status', v_payment.status,
      'credited', v_payment.credited_at IS NOT NULL, 'partial', coalesce(p_partial, false), 'paid_until', v_until);
  END IF;

  IF v_cut THEN
    SELECT s.paid_until INTO v_until
    FROM public.org_subscriptions AS s
    WHERE s.org_id = v_payment.org_id
    FOR UPDATE;

    IF v_until IS NOT NULL THEN
      -- Not below now(), and never later than it already is (an expired date stays as it is).
      v_new := least(v_until, greatest(now(), v_until - (v_payment.period_to - v_payment.period_from)));
      UPDATE public.org_subscriptions
      SET paid_until = v_new,
          reminder_sent_for = NULL,
          updated_at = now()
      WHERE org_id = v_payment.org_id;
      v_until := v_new;
    END IF;
  END IF;

  UPDATE public.payments
  SET status = 'reversed',
      reversal_applied_at = CASE WHEN v_cut THEN now() ELSE reversal_applied_at END,
      provider_modified_at = coalesce(p_modified, provider_modified_at),
      updated_at = now()
  WHERE id = p_payment;

  RETURN jsonb_build_object(
    'changed', true,
    'cut', v_cut,
    'previous', v_payment.status,
    'status', 'reversed',
    'credited', v_payment.credited_at IS NOT NULL,
    'partial', coalesce(p_partial, false),
    'paid_until', v_until
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_payment_reversal(uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_payment_reversal(uuid, timestamptz, boolean) TO service_role;
