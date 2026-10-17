-- New starter template for an empty cabinet (index.html STARTER_SETTINGS):
-- totalFleet 5 → 1, fuelLoad 37 → 38, fuelPrice 57 → 95, perDiem 850 → 500.
--
-- org_has_user_data (20261017090000_invite_flow.sql) treats the autosaved
-- starter template as "no data", so an account that only has it can join a team
-- and its empty company is removed. Accounts created before this change carry
-- the previous template, new ones the current one: both are recognised here.
-- A mix of the two, any other key or any other value is still user data.
--
-- Same function otherwise. CREATE OR REPLACE keeps its owner; grants restated.
-- Safe to run more than once. Not applied to production by this PR.

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
  -- Starter template until 2026-10-17 (accounts already autosaved with it).
  v_starter_previous constant jsonb := jsonb_build_object(
    'totalFleet', 5, 'fuelLoad', 37, 'fuelEmpty', 32, 'fuelPrice', 57,
    'adblueEnable', 'on', 'adblueConsumption', 2.85, 'adbluePrice', 18,
    'driverPayMode', 'km', 'driverRateLoad', 4.03, 'driverRateEmpty', 2.3,
    'driverPctVal', 12, 'perDiem', 850, 'toCost', 18000, 'toPeriod', 50000,
    'tireCost', 16500, 'tireCount', 14, 'tireMileage', 150000
  );
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
    'fleet_vehicles', 'trailer_presets', 'weekly_reports'
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
  -- starter template (previous or current). Neither is user data.
  SELECT coalesce((
    SELECT jsonb_object_agg(e.key, e.value)
    FROM jsonb_each(coalesce(s.settings, '{}'::jsonb) - 'logists_see_all') AS e
    WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb)
  ), '{}'::jsonb)
  INTO v_settings
  FROM public.company_settings AS s
  WHERE s.org_id = p_org_id;

  IF v_settings IS NOT NULL
     AND NOT (v_starter_previous @> v_settings OR v_starter_current @> v_settings)
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
