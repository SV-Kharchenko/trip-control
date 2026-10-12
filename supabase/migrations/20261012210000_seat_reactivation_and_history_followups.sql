-- Seat reactivation, client name, and atomic template use_count.
-- Do not edit earlier applied migrations. Apply this file on its own.

-- Demo duplicates are already counted by calculations_enforce_owner_and_demo_limit
-- on every INSERT, including copies. That trigger stays as it is.

CREATE OR REPLACE FUNCTION public.calculations_fill_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inp jsonb := coalesce(NEW.inputs, '{}'::jsonb);
  res jsonb := coalesce(NEW.results, '{}'::jsonb);
  return_mode text := coalesce(inp ->> 'returnMode', '');
  cars numeric := public.tc_num(inp, 'carsCount');
  norm_w numeric := public.tc_num(inp, 'normWeight');
  contract_vol numeric := coalesce(public.tc_num(inp, 'volume'), public.tc_num(res, 'volume'));
  dist numeric := coalesce(public.tc_num(inp, 'dist'), public.tc_num(res, 'dist'));
  podacha numeric := coalesce(public.tc_num(inp, 'podachaDist'), public.tc_num(res, 'podachaDist'));
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.inputs IS NOT DISTINCT FROM OLD.inputs
     AND NEW.results IS NOT DISTINCT FROM OLD.results
     AND NEW.distance_km IS NOT NULL
  THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  NEW.route_from := nullif(inp ->> 'origin', '');
  NEW.route_to := nullif(inp ->> 'destination', '');
  NEW.client_name := nullif(left(btrim(coalesce(inp ->> 'clientName', '')), 120), '');
  NEW.distance_km := CASE WHEN dist IS NULL AND podacha IS NULL THEN NULL ELSE coalesce(dist, 0) + coalesce(podacha, 0) END;
  NEW.vehicles_count := cars;
  NEW.trip_days := public.tc_num(inp, 'daysPerTrip');
  NEW.rate := coalesce(public.tc_num(inp, 'rate'), public.tc_num(res, 'rate'));
  NEW.revenue := public.tc_num(res, 'grossIncome');
  NEW.profit := public.tc_num(res, 'netProfit');
  NEW.trailer_type := coalesce(nullif(inp ->> 'trailerType', ''), nullif(res ->> 'trailerType', ''));
  NEW.tonnage := CASE
    WHEN return_mode = 'разовий' AND cars IS NOT NULL AND norm_w IS NOT NULL THEN cars * norm_w
    ELSE contract_vol
  END;
  IF NEW.trip_date IS NULL THEN
    NEW.trip_date := (timezone('Europe/Kyiv', coalesce(NEW.created_at, now())))::date;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_fill_history() FROM PUBLIC, anon, authenticated, service_role;

-- Column-only update. Setting inputs = inputs would hit the early return above
-- and skip rows that already have distance_km.
UPDATE public.calculations
SET client_name = nullif(left(btrim(coalesce(inputs ->> 'clientName', '')), 120), '')
WHERE client_name IS NULL
  AND nullif(btrim(coalesce(inputs ->> 'clientName', '')), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.route_templates_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- use_count / last_used_at bumps must not rewrite the template owner.
  IF TG_OP = 'UPDATE'
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.scope IS NOT DISTINCT FROM OLD.scope
     AND NEW.params IS NOT DISTINCT FROM OLD.params
  THEN
    RETURN NEW;
  END IF;

  IF public.is_service_role() THEN
    RETURN NEW;
  END IF;

  NEW.org_id := public.current_org_id();
  NEW.owner_user_id := auth.uid();
  IF NEW.org_id IS NULL OR NEW.owner_user_id IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NO_ORG' USING ERRCODE = '42501';
  END IF;
  IF NEW.scope = 'company' AND NOT public.is_org_owner() THEN
    RAISE EXCEPTION 'TEMPLATE_OWNER_ONLY'
      USING ERRCODE = '42501',
            DETAIL = 'Company templates are created by the owner';
  END IF;
  IF TG_OP = 'INSERT' AND NOT public.current_is_approved() THEN
    SELECT count(*)::integer INTO v_count
    FROM public.route_templates
    WHERE org_id = NEW.org_id;
    IF v_count >= 1 THEN
      RAISE EXCEPTION 'TEMPLATE_LIMIT'
        USING ERRCODE = 'P0001',
              DETAIL = 'Demo accounts can keep one route template';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.route_templates_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.touch_route_template(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR public.current_org_id() IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.route_templates
  SET use_count = use_count + 1,
      last_used_at = now()
  WHERE id = p_id
    AND org_id = public.current_org_id()
    AND (scope = 'company' OR owner_user_id = auth.uid())
  RETURNING use_count INTO v_count;

  IF v_count IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_route_template(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_route_template(uuid) TO authenticated;

-- Service role is not exempt: the team API updates profiles with that role.
-- A pending invite for this same email is the seat being accepted, so it is
-- not counted twice. A different person's invite still occupies a seat.
CREATE OR REPLACE FUNCTION public.enforce_logist_activation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
BEGIN
  IF NOT (NEW.org_role = 'logist' AND NEW.member_status = 'active') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.org_role = 'logist'
     AND OLD.member_status = 'active'
     AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id
  THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.organizations
  WHERE id = NEW.org_id
  FOR UPDATE;

  SELECT
    (SELECT count(*)::integer FROM public.profiles AS p
      WHERE p.org_id = NEW.org_id
        AND p.id IS DISTINCT FROM NEW.id
        AND p.member_status = 'active'
        AND p.org_role = 'logist')
    +
    (SELECT count(*)::integer FROM public.org_invites AS oi
      WHERE oi.org_id = NEW.org_id
        AND oi.accepted_at IS NULL
        AND oi.revoked_at IS NULL
        AND oi.expires_at > now()
        AND (
          NEW.email IS NULL
          OR lower(oi.email) IS DISTINCT FROM lower(NEW.email)
        ))
  INTO v_used;

  IF v_used >= 3 THEN
    RAISE EXCEPTION 'MEMBER_LIMIT'
      USING ERRCODE = 'P0001',
            DETAIL = 'One owner and at most three logists, including live invitations';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_logist_activation_limit()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_enforce_logist_activation_limit ON public.profiles;
CREATE TRIGGER trg_enforce_logist_activation_limit
  BEFORE UPDATE OF org_role, member_status, org_id
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_logist_activation_limit();
