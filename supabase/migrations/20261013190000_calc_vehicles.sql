-- Chosen trucks saved with a calculation. Norms are frozen in snapshot.
-- Do not apply this file. The app still saves the calculation if the table is missing.

CREATE TABLE IF NOT EXISTS public.calc_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calc_id uuid NOT NULL REFERENCES public.calculations(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES public.fleet_vehicles(id) ON DELETE SET NULL,
  tonnage numeric NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_vehicles_tonnage_positive CHECK (tonnage > 0),
  CONSTRAINT calc_vehicles_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT calc_vehicles_calc_vehicle_key UNIQUE (calc_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS calc_vehicles_calc_idx
  ON public.calc_vehicles (calc_id);

CREATE OR REPLACE FUNCTION public.calc_vehicles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_vehicle_org uuid;
BEGIN
  IF public.is_service_role() THEN
    RETURN NEW;
  END IF;

  SELECT c.org_id INTO v_org
  FROM public.calculations AS c
  WHERE c.id = NEW.calc_id;

  IF v_org IS NULL OR v_org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'CALC_VEHICLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NEW.vehicle_id IS NOT NULL THEN
    SELECT f.org_id INTO v_vehicle_org
    FROM public.fleet_vehicles AS f
    WHERE f.id = NEW.vehicle_id;
    IF v_vehicle_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'CALC_VEHICLE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.calc_vehicles_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_calc_vehicles_guard ON public.calc_vehicles;
CREATE TRIGGER trg_calc_vehicles_guard
  BEFORE INSERT OR UPDATE ON public.calc_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.calc_vehicles_guard();

ALTER TABLE public.calc_vehicles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calc_vehicles_select_role ON public.calc_vehicles;
CREATE POLICY calc_vehicles_select_role ON public.calc_vehicles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = calc_vehicles.calc_id
        AND c.org_id = public.current_org_id()
        AND (
          public.is_org_owner()
          OR c.user_id = auth.uid()
          OR public.org_logists_see_all()
        )
    )
  );

DROP POLICY IF EXISTS calc_vehicles_insert_role ON public.calc_vehicles;
CREATE POLICY calc_vehicles_insert_role ON public.calc_vehicles
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = calc_vehicles.calc_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS calc_vehicles_update_role ON public.calc_vehicles;
CREATE POLICY calc_vehicles_update_role ON public.calc_vehicles
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = calc_vehicles.calc_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = calc_vehicles.calc_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS calc_vehicles_delete_role ON public.calc_vehicles;
CREATE POLICY calc_vehicles_delete_role ON public.calc_vehicles
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.calculations AS c
      WHERE c.id = calc_vehicles.calc_id
        AND c.org_id = public.current_org_id()
        AND (public.is_org_owner() OR c.user_id = auth.uid())
    )
  );

REVOKE ALL ON TABLE public.calc_vehicles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calc_vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calc_vehicles TO service_role;
