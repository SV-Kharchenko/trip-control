-- New edition of the Public offer, the Privacy policy and the Payment and refund page: 09.11.2026
-- (all three are already published, effective 19.11.2026). LEGAL_VERSION in index.html and lib/legal.js
-- becomes '2026-11-09'.
--
-- record_signup_consent() is the same function as in 20261020190000_legal_version_2026_10_20.sql; only the
-- list of accepted editions changes. '2026-10-18' and '2026-10-20' stay accepted during the switch (a signup
-- page loaded before the deploy still sends the old date).
--
-- Apply BEFORE deploying the code with LEGAL_VERSION = '2026-11-09': otherwise signup consents with
-- the new edition are skipped (the signup itself is never blocked).
--
-- New file only. Idempotent. Not applied to production by this PR.

CREATE OR REPLACE FUNCTION public.record_signup_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Accepted editions (LEGAL_VERSION). Add the new date here with a new migration.
  v_allowed constant text[] := ARRAY['2026-10-18', '2026-10-20', '2026-11-09'];
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
