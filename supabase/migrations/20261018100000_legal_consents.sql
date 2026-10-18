-- Consent to the public offer and the privacy policy, recorded on the server.
--
-- The signup form sends consent_offer_version / consent_privacy_version in the
-- user metadata (LEGAL_VERSION in index.html and lib/legal.js). A separate
-- AFTER INSERT trigger on auth.users writes one 'signup' row with the server
-- time when both versions are on the allowed list. Anything else writes
-- nothing and never breaks the signup. handle_new_tripcontrol_user is not
-- changed. No IP is stored: the privacy policy does not list it.
--
-- New file only. Idempotent. Not applied to production by this PR.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.legal_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid,
  kind text NOT NULL CHECK (kind IN ('signup', 'payment')),
  offer_version text NOT NULL,
  privacy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  payment_id uuid NULL,
  user_agent text NULL
);

CREATE INDEX IF NOT EXISTS legal_consents_user_idx
  ON public.legal_consents (user_id, accepted_at DESC);

COMMENT ON TABLE public.legal_consents IS
  'Згода з публічною офертою і політикою конфіденційності: реєстрація (signup) або оплата (payment). Пише лише сервер.';

-- ---------------------------------------------------------------------------
-- Access: users read their own rows; only service_role / SECURITY DEFINER write.
-- ---------------------------------------------------------------------------

ALTER TABLE public.legal_consents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.legal_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.legal_consents TO authenticated;
GRANT ALL ON public.legal_consents TO service_role;

DROP POLICY IF EXISTS legal_consents_select_own ON public.legal_consents;
CREATE POLICY legal_consents_select_own ON public.legal_consents
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Signup consent from the auth metadata
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_signup_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Accepted editions (LEGAL_VERSION). Add the new date here with a new migration.
  v_allowed constant text[] := ARRAY['2026-10-18'];
  v_offer text := NEW.raw_user_meta_data ->> 'consent_offer_version';
  v_privacy text := NEW.raw_user_meta_data ->> 'consent_privacy_version';
  v_org uuid;
BEGIN
  IF v_offer IS NULL OR v_privacy IS NULL
     OR NOT (v_offer = ANY (v_allowed))
     OR NOT (v_privacy = ANY (v_allowed))
  THEN
    RETURN NEW;
  END IF;

  BEGIN
    -- on_auth_user_created_tripcontrol runs first (triggers fire in name order),
    -- so the profile and its company already exist here.
    SELECT p.org_id INTO v_org FROM public.profiles AS p WHERE p.id = NEW.id;

    INSERT INTO public.legal_consents (user_id, org_id, kind, offer_version, privacy_version, accepted_at)
    VALUES (NEW.id, v_org, 'signup', v_offer, v_privacy, now());
  EXCEPTION WHEN OTHERS THEN
    -- The consent row must never block the signup itself.
    RAISE WARNING 'record_signup_consent: % (%)', SQLERRM, SQLSTATE;
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_signup_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_record_signup_consent ON auth.users;
CREATE TRIGGER on_auth_user_record_signup_consent
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.record_signup_consent();
