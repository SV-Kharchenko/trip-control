-- Fleet card: AdBlue is only «Є» / «Немає», the trailer type is required.
-- There is no «Як у компанії» (NULL) any more:
--   adblue_on NULL     → true  (an empty adblue_consumption keeps the calculator default norm);
--   trailer_type NULL  → company_settings.settings->>'trailerType' when it is a known type,
--                        otherwise 'зерновоз' (the starter template and the calculator default).
-- The client already shows and calculates NULL rows this way, so applying the file changes nothing visible.
-- This file is not applied to production by the agent. Apply manually after review.

BEGIN;

-- fleet_vehicles_guard() lets only the org owner or service_role write; run the backfill as service_role.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

UPDATE public.fleet_vehicles
SET adblue_on = true
WHERE adblue_on IS NULL;

UPDATE public.fleet_vehicles v
SET trailer_type = coalesce(
  (
    SELECT cs.settings ->> 'trailerType'
    FROM public.company_settings cs
    WHERE cs.org_id = v.org_id
      AND cs.settings ->> 'trailerType' IN ('зерновоз', 'рефрижератор', 'тент', 'цистерна')
  ),
  'зерновоз'
)
WHERE v.trailer_type IS NULL;

ALTER TABLE public.fleet_vehicles
  ALTER COLUMN adblue_on SET DEFAULT true,
  ALTER COLUMN adblue_on SET NOT NULL;

ALTER TABLE public.fleet_vehicles
  ALTER COLUMN trailer_type SET DEFAULT 'зерновоз',
  ALTER COLUMN trailer_type SET NOT NULL;

COMMIT;
