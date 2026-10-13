-- OSM POI cache. Not applied to production until the owner says so.
-- One row is a type (gas, tir, cafe, sto) plus a geohash segment of the route.
-- The API reads and writes this with the service role. Clients do not.

CREATE TABLE IF NOT EXISTS public.poi_cache (
  poi_type text NOT NULL CHECK (poi_type IN ('gas', 'tir', 'cafe', 'sto')),
  segment_key text NOT NULL CHECK (char_length(segment_key) BETWEEN 4 AND 12),
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poi_type, segment_key)
);

ALTER TABLE public.poi_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.poi_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.poi_cache TO service_role;
