-- Payments for an organization plan through plata by mono (monobank acquiring) and WayForPay.
--
-- * org_subscriptions — paid_until per organization. A separate table, not a column on
--   organizations: owners have UPDATE on organizations (organizations_update_owner) and
--   protect_org_privileges guards only id/status/work_mode, so a new column there could be
--   extended by the owner. Here users can only read.
-- * payments — one row per invoice. The amount comes from the plan code on the server.
-- * payment_events — append-only status history (webhooks, status checks, manual notes);
--   payload keeps whitelisted fields only, no payer email/phone and no raw bodies.
-- * apply_payment_success() — the only way a payment extends paid_until; idempotent.
-- * current_is_approved() now also counts a paid organization, so the existing demo limits
--   (3 saved calculations, 1 route template) follow the subscription. A manual
--   profiles.is_approved stays permanent full access; nothing is backfilled or changed.
--
-- New file only. Idempotent. Not applied to production by this PR.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_subscriptions (
  org_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  paid_until timestamptz NULL,
  last_plan text NULL,
  reminder_sent_for timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- org_id has no foreign key on purpose: payment records outlive a removed organization.
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  created_by uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('mono', 'wayforpay')),
  plan text NOT NULL CHECK (plan IN ('month', 'year')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'UAH',
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'success', 'failure', 'expired', 'reversed', 'refunded')),
  provider_order_id text NOT NULL,
  provider_invoice_id text NULL,
  provider_modified_at timestamptz NULL,
  credited_at timestamptz NULL,
  period_from timestamptz NULL,
  period_to timestamptz NULL,
  refund_note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_order_uidx
  ON public.payments (provider, provider_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_invoice_uidx
  ON public.payments (provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_org_created_idx
  ON public.payments (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_open_idx
  ON public.payments (status, created_at)
  WHERE status IN ('created', 'pending');

CREATE TABLE IF NOT EXISTS public.payment_events (
  id bigserial PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES public.payments (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('mono', 'wayforpay')),
  status text NULL,
  provider_modified_at timestamptz NULL,
  signature_ok boolean NULL,
  source text NOT NULL CHECK (source IN ('webhook', 'status_check', 'manual')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_events_payment_idx
  ON public.payment_events (payment_id, received_at);

-- ---------------------------------------------------------------------------
-- Access: users read; only service_role writes.
-- ---------------------------------------------------------------------------

ALTER TABLE public.org_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.org_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.payment_events_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.org_subscriptions TO authenticated;
GRANT SELECT ON public.payments TO authenticated;

GRANT ALL ON public.org_subscriptions TO service_role;
GRANT ALL ON public.payments TO service_role;
GRANT ALL ON public.payment_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.payment_events_id_seq TO service_role;

-- Every member sees the plan status of their own company.
DROP POLICY IF EXISTS org_subscriptions_select_own_org ON public.org_subscriptions;
CREATE POLICY org_subscriptions_select_own_org ON public.org_subscriptions
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

-- Payments are visible to the owner of the company only.
DROP POLICY IF EXISTS payments_select_owner ON public.payments;
CREATE POLICY payments_select_owner ON public.payments
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner());

-- payment_events: no policy for authenticated, so no client access at all.

-- ---------------------------------------------------------------------------
-- Paid access
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_has_paid_access(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_subscriptions AS s
    WHERE s.org_id = p_org AND s.paid_until > now()
  );
$$;

-- Only current_is_approved() (SECURITY DEFINER) and the server use it; clients do not call it.
REVOKE ALL ON FUNCTION public.org_has_paid_access(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_paid_access(uuid) TO service_role;

-- Manual approval (profiles.is_approved) is permanent full access; otherwise a paid company.
-- current_org_id() counts only an active member of a non-blocked company, so a disabled member
-- of a paid company is not approved.
CREATE OR REPLACE FUNCTION public.current_is_approved()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT p.is_approved OR coalesce(public.org_has_paid_access(public.current_org_id()), false)
    FROM public.profiles AS p
    WHERE p.id = auth.uid()
    LIMIT 1
  ), false);
$$;

REVOKE ALL ON FUNCTION public.current_is_approved() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_is_approved() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Crediting a successful payment
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_payment_success(p_payment uuid, p_modified timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_until timestamptz;
  v_base timestamptz;
  v_new timestamptz;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Already credited: a repeated webhook or status check changes nothing.
  IF v_payment.credited_at IS NOT NULL THEN
    SELECT s.paid_until INTO v_until FROM public.org_subscriptions AS s WHERE s.org_id = v_payment.org_id;
    RETURN jsonb_build_object(
      'credited', false,
      'already_credited', true,
      'paid_until', v_until,
      'period_from', v_payment.period_from,
      'period_to', v_payment.period_to
    );
  END IF;

  -- An older notification after a newer one (e.g. success after reversed) is ignored.
  IF p_modified IS NOT NULL AND v_payment.provider_modified_at IS NOT NULL
     AND p_modified < v_payment.provider_modified_at THEN
    SELECT s.paid_until INTO v_until FROM public.org_subscriptions AS s WHERE s.org_id = v_payment.org_id;
    RETURN jsonb_build_object('credited', false, 'already_credited', false, 'stale', true, 'paid_until', v_until);
  END IF;

  INSERT INTO public.org_subscriptions (org_id) VALUES (v_payment.org_id)
  ON CONFLICT (org_id) DO NOTHING;

  SELECT s.paid_until INTO v_until
  FROM public.org_subscriptions AS s
  WHERE s.org_id = v_payment.org_id
  FOR UPDATE;

  v_base := greatest(now(), coalesce(v_until, now()));
  v_new := v_base + CASE v_payment.plan WHEN 'year' THEN interval '1 year' ELSE interval '1 month' END;

  UPDATE public.org_subscriptions
  SET paid_until = v_new,
      last_plan = v_payment.plan,
      reminder_sent_for = NULL,
      updated_at = now()
  WHERE org_id = v_payment.org_id;

  UPDATE public.payments
  SET status = 'success',
      credited_at = now(),
      period_from = v_base,
      period_to = v_new,
      provider_modified_at = coalesce(p_modified, provider_modified_at),
      updated_at = now()
  WHERE id = p_payment;

  RETURN jsonb_build_object(
    'credited', true,
    'already_credited', false,
    'paid_until', v_new,
    'period_from', v_base,
    'period_to', v_new
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_payment_success(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_payment_success(uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Any other status (pending / failure / expired / reversed / refunded)
-- ---------------------------------------------------------------------------
-- Providers do not guarantee the order of notifications: a status is applied only when it
-- is newer than the stored one. A credited payment can only move to reversed / refunded;
-- paid_until is never shortened here (refunds are handled by hand).

CREATE OR REPLACE FUNCTION public.apply_payment_status(p_payment uuid, p_status text, p_modified timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
BEGIN
  IF p_status NOT IN ('pending', 'failure', 'expired', 'reversed', 'refunded') THEN
    RAISE EXCEPTION 'BAD_PAYMENT_STATUS' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_payment.status = p_status
     OR (p_modified IS NOT NULL AND v_payment.provider_modified_at IS NOT NULL
         AND p_modified < v_payment.provider_modified_at)
     OR (v_payment.credited_at IS NOT NULL AND p_status NOT IN ('reversed', 'refunded'))
  THEN
    RETURN jsonb_build_object('changed', false, 'previous', v_payment.status, 'status', v_payment.status);
  END IF;

  UPDATE public.payments
  SET status = p_status,
      provider_modified_at = coalesce(p_modified, provider_modified_at),
      updated_at = now()
  WHERE id = p_payment;

  RETURN jsonb_build_object('changed', true, 'previous', v_payment.status, 'status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_payment_status(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_payment_status(uuid, text, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- org_has_user_data: a company with payments or a subscription has data
-- ---------------------------------------------------------------------------
-- Same function as in 20261017130000_starter_defaults_user_data.sql (current starter template),
-- plus payments and org_subscriptions in the list of tables. accept_org_invite therefore never
-- removes a company that has paid. Keep the starter values in sync with index.html STARTER_SETTINGS.

CREATE OR REPLACE FUNCTION public.org_has_user_data(p_org_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table text;
  v_found boolean;
  v_settings jsonb;
  -- Current STARTER_SETTINGS in index.html (same values).
  v_starter_current constant jsonb := jsonb_build_object(
    'totalFleet', 1, 'fuelLoad', 38, 'fuelEmpty', 32, 'fuelPrice', 95,
    'adblueEnable', 'on', 'adblueConsumption', 2.85, 'adbluePrice', 18,
    'driverPayMode', 'km', 'driverRateLoad', 4.03, 'driverRateEmpty', 2.3,
    'driverPctVal', 12, 'perDiem', 500, 'toCost', 18000, 'toPeriod', 50000,
    'tireCost', 16500, 'tireCount', 14, 'tireMileage', 150000
  );
BEGIN
  IF p_org_id IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.org_id = p_org_id AND p.id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN true;
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'calculations', 'calc_vehicles', 'trip_actuals', 'route_templates',
    'fleet_vehicles', 'trailer_presets', 'weekly_reports',
    -- A company that paid or has a subscription row is kept (payments outlive nothing silently).
    'payments', 'org_subscriptions'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns AS c
      WHERE c.table_schema = 'public' AND c.table_name = v_table AND c.column_name = 'org_id'
    ) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE org_id = $1)', v_table)
        INTO v_found
        USING p_org_id;
      IF v_found THEN
        RETURN true;
      END IF;
    END IF;
  END LOOP;

  -- Signup writes {"logists_see_all": false}; the first sign-in autosaves the
  -- current starter template. Neither is user data.
  SELECT coalesce((
    SELECT jsonb_object_agg(e.key, e.value)
    FROM jsonb_each(coalesce(s.settings, '{}'::jsonb) - 'logists_see_all') AS e
    WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb)
  ), '{}'::jsonb)
  INTO v_settings
  FROM public.company_settings AS s
  WHERE s.org_id = p_org_id;

  IF v_settings IS NOT NULL
     AND NOT (v_starter_current @> v_settings)
  THEN
    RETURN true;
  END IF;

  -- Signup fills only ownership; EDRPOU, phone, address and the rest come from the cabinet.
  IF EXISTS (
    SELECT 1
    FROM public.org_company_profiles AS ocp,
         jsonb_each(to_jsonb(ocp) - ARRAY['org_id', 'ownership', 'lang', 'updated_at', 'updated_by', 'created_at']) AS f
    WHERE ocp.org_id = p_org_id
      AND f.value NOT IN ('null'::jsonb, '""'::jsonb)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.org_has_user_data(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_user_data(uuid, uuid) TO service_role;
