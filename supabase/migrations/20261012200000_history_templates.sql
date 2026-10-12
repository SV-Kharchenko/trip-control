-- History columns and route templates. Do not edit the earlier role migrations.
-- Apply manually after review. This file is not applied to production by the agent.

CREATE OR REPLACE FUNCTION public.tc_num(p jsonb, k text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(p, '{}'::jsonb) ->> k ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (p ->> k)::numeric
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.tc_num(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.calculations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS trip_date date,
  ADD COLUMN IF NOT EXISTS route_from text,
  ADD COLUMN IF NOT EXISTS route_to text,
  ADD COLUMN IF NOT EXISTS distance_km numeric,
  ADD COLUMN IF NOT EXISTS revenue numeric,
  ADD COLUMN IF NOT EXISTS profit numeric,
  ADD COLUMN IF NOT EXISTS rate numeric,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS trailer_type text,
  ADD COLUMN IF NOT EXISTS vehicles_count numeric,
  ADD COLUMN IF NOT EXISTS tonnage numeric,
  ADD COLUMN IF NOT EXISTS trip_days numeric,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.calculations
  DROP CONSTRAINT IF EXISTS calculations_status_check;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_status_check
  CHECK (status IN ('draft', 'proposed', 'accepted', 'rejected', 'done'));

CREATE INDEX IF NOT EXISTS calculations_org_created_idx
  ON public.calculations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calculations_org_status_idx
  ON public.calculations (org_id, status);
CREATE INDEX IF NOT EXISTS calculations_org_user_idx
  ON public.calculations (org_id, user_id);

-- Fills the list columns from the saved snapshot. Does not recalculate the trip.
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

DROP TRIGGER IF EXISTS trg_calculations_fill_history ON public.calculations;
CREATE TRIGGER trg_calculations_fill_history
  BEFORE INSERT OR UPDATE OF inputs, results, status
  ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_fill_history();

UPDATE public.calculations
SET inputs = inputs
WHERE distance_km IS NULL;

CREATE TABLE IF NOT EXISTS public.route_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  scope text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'company')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS route_templates_org_idx
  ON public.route_templates (org_id, scope, created_at DESC);

DO $$
BEGIN
  ALTER TABLE public.route_templates
    ADD CONSTRAINT route_templates_owner_fkey
    FOREIGN KEY (owner_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.route_templates ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.route_templates_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
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

DROP TRIGGER IF EXISTS trg_route_templates_guard ON public.route_templates;
CREATE TRIGGER trg_route_templates_guard
  BEFORE INSERT OR UPDATE ON public.route_templates
  FOR EACH ROW EXECUTE FUNCTION public.route_templates_guard();

DROP POLICY IF EXISTS route_templates_select ON public.route_templates;
DROP POLICY IF EXISTS route_templates_insert ON public.route_templates;
DROP POLICY IF EXISTS route_templates_update ON public.route_templates;
DROP POLICY IF EXISTS route_templates_delete ON public.route_templates;

CREATE POLICY route_templates_select ON public.route_templates
  FOR SELECT TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (scope = 'company' OR owner_user_id = auth.uid())
  );

CREATE POLICY route_templates_insert ON public.route_templates
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id = public.current_org_id()
    AND owner_user_id = auth.uid()
    AND (scope = 'personal' OR public.is_org_owner())
  );

CREATE POLICY route_templates_update ON public.route_templates
  FOR UPDATE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (
      (scope = 'personal' AND owner_user_id = auth.uid())
      OR (scope = 'company' AND public.is_org_owner())
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND (
      (scope = 'personal' AND owner_user_id = auth.uid())
      OR (scope = 'company' AND public.is_org_owner())
    )
  );

CREATE POLICY route_templates_delete ON public.route_templates
  FOR DELETE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND (
      (scope = 'personal' AND owner_user_id = auth.uid())
      OR (scope = 'company' AND public.is_org_owner())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_templates TO authenticated;
