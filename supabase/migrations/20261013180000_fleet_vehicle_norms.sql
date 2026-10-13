-- Optional per-vehicle calculator norms. Empty means the company norm stays.
-- The calculator arithmetic does not read this table. Apply manually after review.
-- This file is not applied to production by the agent.

ALTER TABLE public.fleet_vehicles
  ADD COLUMN IF NOT EXISTS fuel_load numeric,
  ADD COLUMN IF NOT EXISTS fuel_empty numeric,
  ADD COLUMN IF NOT EXISTS norm_weight numeric,
  ADD COLUMN IF NOT EXISTS trailer_type text;

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_fuel_load_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_fuel_load_chk
  CHECK (fuel_load IS NULL OR (fuel_load >= 0.1 AND fuel_load <= 80));

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_fuel_empty_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_fuel_empty_chk
  CHECK (fuel_empty IS NULL OR (fuel_empty >= 0.1 AND fuel_empty <= 80));

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_norm_weight_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_norm_weight_chk
  CHECK (norm_weight IS NULL OR (norm_weight >= 0.1 AND norm_weight <= 80));

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_trailer_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_trailer_chk
  CHECK (trailer_type IS NULL OR trailer_type IN ('зерновоз', 'рефрижератор', 'тент', 'цистерна'));
