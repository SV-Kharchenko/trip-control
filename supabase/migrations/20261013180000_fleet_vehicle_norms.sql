-- Optional identity and consumption fields for a fleet vehicle.
-- Empty consumption means the company cabinet template stays.
-- The calculator arithmetic does not read this table. Apply manually after review.
-- This file is not applied to production by the agent.

ALTER TABLE public.fleet_vehicles
  ADD COLUMN IF NOT EXISTS make_model text,
  ADD COLUMN IF NOT EXISTS year_made integer,
  ADD COLUMN IF NOT EXISTS fuel_load numeric,
  ADD COLUMN IF NOT EXISTS fuel_empty numeric,
  ADD COLUMN IF NOT EXISTS adblue_on boolean,
  ADD COLUMN IF NOT EXISTS adblue_consumption numeric,
  ADD COLUMN IF NOT EXISTS trailer_plate text,
  ADD COLUMN IF NOT EXISTS trailer_type text,
  ADD COLUMN IF NOT EXISTS payload_t numeric;

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_make_model_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_make_model_chk
  CHECK (make_model IS NULL OR char_length(make_model) BETWEEN 1 AND 80);

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_year_made_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_year_made_chk
  CHECK (year_made IS NULL OR (year_made >= 1980 AND year_made <= 2100));

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
  DROP CONSTRAINT IF EXISTS fleet_vehicles_adblue_consumption_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_adblue_consumption_chk
  CHECK (adblue_consumption IS NULL OR (adblue_consumption >= 0.05 AND adblue_consumption <= 30));

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_trailer_plate_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_trailer_plate_chk
  CHECK (trailer_plate IS NULL OR char_length(trailer_plate) BETWEEN 1 AND 40);

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_trailer_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_trailer_chk
  CHECK (trailer_type IS NULL OR trailer_type IN ('зерновоз', 'рефрижератор', 'тент', 'цистерна'));

ALTER TABLE public.fleet_vehicles
  DROP CONSTRAINT IF EXISTS fleet_vehicles_payload_chk;
ALTER TABLE public.fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_payload_chk
  CHECK (payload_t IS NULL OR (payload_t >= 0.1 AND payload_t <= 80));
