-- Optional fleet document dates. Not used by the calculator.
-- Apply manually after review. This file is not applied to production by the agent.

CREATE TABLE IF NOT EXISTS public.fleet_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  oscpv_on date,
  kasko_on date,
  green_card_on date,
  inspection_on date,
  tachograph_on date,
  service_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_vehicles_org_idx
  ON public.fleet_vehicles (org_id, label);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicles_label_uidx
  ON public.fleet_vehicles (org_id, lower(label));

CREATE OR REPLACE FUNCTION public.fleet_vehicles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF public.is_service_role() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    NEW.label := btrim(coalesce(NEW.label, ''));
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NOT public.is_org_owner() THEN
    RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.org_id IS DISTINCT FROM public.current_org_id() THEN
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  NEW.org_id := public.current_org_id();
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  NEW.label := btrim(coalesce(NEW.label, ''));
  IF char_length(NEW.label) < 1 OR char_length(NEW.label) > 40 THEN
    RAISE EXCEPTION 'FLEET_LABEL' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_count
    FROM public.fleet_vehicles
    WHERE org_id = NEW.org_id;
    IF v_count >= 100 THEN
      RAISE EXCEPTION 'FLEET_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_vehicles_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_fleet_vehicles_guard ON public.fleet_vehicles;
CREATE TRIGGER trg_fleet_vehicles_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.fleet_vehicles_guard();

ALTER TABLE public.fleet_vehicles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fleet_vehicles_select ON public.fleet_vehicles;
CREATE POLICY fleet_vehicles_select ON public.fleet_vehicles
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

DROP POLICY IF EXISTS fleet_vehicles_insert ON public.fleet_vehicles;
CREATE POLICY fleet_vehicles_insert ON public.fleet_vehicles
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());

DROP POLICY IF EXISTS fleet_vehicles_update ON public.fleet_vehicles;
CREATE POLICY fleet_vehicles_update ON public.fleet_vehicles
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner())
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());

DROP POLICY IF EXISTS fleet_vehicles_delete ON public.fleet_vehicles;
CREATE POLICY fleet_vehicles_delete ON public.fleet_vehicles
  FOR DELETE TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner());

REVOKE ALL ON TABLE public.fleet_vehicles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fleet_vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fleet_vehicles TO service_role;
