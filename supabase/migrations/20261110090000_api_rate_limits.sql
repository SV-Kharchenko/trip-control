-- Apply manually after review. This file is not applied to production by the agent.
-- Ліміт запитів на /api за IP (lib/rate-limit.js): лічильники у фіксованих вікнах + RPC api_rate_hit. Таблиця закрита від
-- клієнтів повністю (RLS без політик, гранти лише service_role), функція — лише service_role: дзвонить серверний код Vercel.
-- У ключ іде SHA-256 від IP, сирих адрес у базі немає. Старі вікна чистяться принагідно (≈1 % викликів).
--
-- РУЧНИЙ ВІДКАТ:
--   DROP FUNCTION IF EXISTS public.api_rate_hit(text, integer, integer);
--   DROP TABLE IF EXISTS public.api_rate_limits;

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS api_rate_limits_window_idx ON public.api_rate_limits (window_start);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.api_rate_limits TO service_role;

-- Рахує звернення в поточному вікні; allowed = false, коли ліміт уже вичерпано (запит, що перевищив ліміт, теж рахується).
CREATE OR REPLACE FUNCTION public.api_rate_hit(p_bucket text, p_limit integer, p_window_seconds integer DEFAULT 60)
RETURNS TABLE (allowed boolean, hits integer, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_start timestamptz;
  v_hits integer;
BEGIN
  IF p_bucket IS NULL OR char_length(p_bucket) NOT BETWEEN 1 AND 200
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'RATE_BAD_ARGS' USING ERRCODE = 'P0001';
  END IF;
  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.api_rate_limits AS r (bucket, window_start, hits)
  VALUES (p_bucket, v_start, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;
  IF random() < 0.01 THEN
    DELETE FROM public.api_rate_limits WHERE window_start < now() - interval '1 hour';
  END IF;
  RETURN QUERY SELECT v_hits <= p_limit, v_hits,
    greatest(1, ceil(extract(epoch FROM (v_start + make_interval(secs => p_window_seconds) - now())))::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.api_rate_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_rate_hit(text, integer, integer) TO service_role;
