-- Plan stays on the saved calculation. Fact is a separate row.
-- Actual profit = actual revenue − actual costs − planned overhead from the snapshot.
-- The calculator is not involved.

CREATE TABLE IF NOT EXISTS public.trip_actuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  calculation_id uuid NOT NULL UNIQUE REFERENCES public.calculations(id) ON DELETE CASCADE,
  revenue numeric NOT NULL,
  costs numeric NOT NULL,
  planned_overhead numeric NOT NULL,
  profit numeric NOT NULL,
  entered_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_actuals_revenue_nonneg CHECK (revenue >= 0),
  CONSTRAINT trip_actuals_costs_nonneg CHECK (costs >= 0)
);

CREATE INDEX IF NOT EXISTS trip_actuals_org_idx
  ON public.trip_actuals (org_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.trip_actuals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calc public.calculations%ROWTYPE;
  v_overhead numeric;
  v_anchor timestamptz;
BEGIN
  SELECT * INTO v_calc
  FROM public.calculations
  WHERE id = NEW.calculation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FACT_NO_TRIP' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.is_service_role() THEN
    IF auth.uid() IS NULL OR v_calc.org_id IS DISTINCT FROM public.current_org_id() THEN
      RAISE EXCEPTION 'FACT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF v_calc.status NOT IN ('accepted', 'done') THEN
      RAISE EXCEPTION 'FACT_STATUS'
        USING ERRCODE = 'P0001',
              DETAIL = 'Fact is allowed only for accepted or done trips';
    END IF;
    IF NOT public.is_org_owner() AND v_calc.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'FACT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    v_anchor := coalesce(v_calc.trip_date::timestamptz, v_calc.created_at, now());
    IF NOT public.is_org_owner() AND v_anchor + interval '30 days' < now() THEN
      RAISE EXCEPTION 'FACT_LOCKED'
        USING ERRCODE = 'P0001',
              DETAIL = 'After 30 days only the owner can edit the fact';
    END IF;
  END IF;

  v_overhead := public.tc_num(coalesce(v_calc.results, '{}'::jsonb), 'overheadTotal');
  IF TG_OP = 'UPDATE' THEN
    NEW.planned_overhead := OLD.planned_overhead;
    NEW.entered_by := OLD.entered_by;
    NEW.created_at := OLD.created_at;
  ELSE
    NEW.planned_overhead := coalesce(v_overhead, 0);
    NEW.entered_by := coalesce(auth.uid(), NEW.entered_by);
    NEW.created_at := now();
  END IF;

  NEW.org_id := v_calc.org_id;
  NEW.profit := NEW.revenue - NEW.costs - NEW.planned_overhead;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trip_actuals_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_trip_actuals_guard ON public.trip_actuals;
CREATE TRIGGER trg_trip_actuals_guard
  BEFORE INSERT OR UPDATE ON public.trip_actuals
  FOR EACH ROW EXECUTE FUNCTION public.trip_actuals_guard();

ALTER TABLE public.trip_actuals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_actuals_select ON public.trip_actuals;
DROP POLICY IF EXISTS trip_actuals_insert ON public.trip_actuals;
DROP POLICY IF EXISTS trip_actuals_update ON public.trip_actuals;
DROP POLICY IF EXISTS trip_actuals_delete ON public.trip_actuals;

CREATE POLICY trip_actuals_select ON public.trip_actuals
  FOR SELECT TO authenticated
  USING (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = trip_actuals.calculation_id
        AND c.org_id = public.current_org_id()
        AND (
          public.is_org_owner()
          OR c.user_id = auth.uid()
          OR public.org_logists_see_all()
        )
    )
  );

CREATE POLICY trip_actuals_insert ON public.trip_actuals
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = trip_actuals.calculation_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  );

CREATE POLICY trip_actuals_update ON public.trip_actuals
  FOR UPDATE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = trip_actuals.calculation_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = trip_actuals.calculation_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  );

CREATE POLICY trip_actuals_delete ON public.trip_actuals
  FOR DELETE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND public.is_org_owner()
  );

REVOKE ALL ON TABLE public.trip_actuals FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trip_actuals TO authenticated;
