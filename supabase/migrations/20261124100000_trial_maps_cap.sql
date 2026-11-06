-- Apply manually after review. This file is not applied to production by the agent.
--
-- Ліміт маршрутів Google на тріалі: 20 побудов маршруту на компанію за календарну добу Europe/Kyiv.
-- Побудову Directions робить браузер, тому клієнт ПЕРЕД викликом Google просить дозвіл у maps_route_take(); без дозволу
-- маршрут рахується через OpenStreetMap (OSRM). Лічильник живе на сервері, таблиця закрита для клієнтів.
-- * Тріал (org_trial_active) без оплати й без ручного схвалення: максимум trial_maps_limit() = 20 маршрутів на добу.
-- * Оплачена компанія (paid_until > now()) або profiles.is_approved: без ліміту, лічильник не чіпається.
-- * Той самий маршрут (ключ) за ту саму добу не рахується двічі — це «кеш»: повторна побудова безкоштовна.
-- * maps_route_refund(key): якщо Google не дав маршрут, дозвіл повертається.
-- Роллбек (вручну):
--   DROP FUNCTION IF EXISTS public.maps_route_refund(text);
--   DROP FUNCTION IF EXISTS public.maps_route_status();
--   DROP FUNCTION IF EXISTS public.maps_route_take(text);
--   DROP FUNCTION IF EXISTS public.trial_maps_take_at(uuid, text, timestamptz, boolean);
--   DROP FUNCTION IF EXISTS public.trial_maps_kyiv_day(timestamptz);
--   DROP FUNCTION IF EXISTS public.trial_maps_limit();
--   DROP TABLE IF EXISTS public.trial_maps_routes;

CREATE TABLE IF NOT EXISTS public.trial_maps_routes (
  org_id uuid NOT NULL,
  day date NOT NULL,
  route_key text NOT NULL CHECK (char_length(route_key) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, day, route_key)
);

ALTER TABLE public.trial_maps_routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trial_maps_routes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.trial_maps_routes TO service_role;

CREATE OR REPLACE FUNCTION public.trial_maps_limit()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 20; $$;

-- Календарна доба за Києвом.
CREATE OR REPLACE FUNCTION public.trial_maps_kyiv_day(p_at timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$ SELECT (p_at AT TIME ZONE 'Europe/Kyiv')::date; $$;

-- Ядро: p_at — «зараз» (для тестів доби); p_take = false — лише статус. Користується тільки сервер (SECURITY DEFINER-обгортки нижче).
-- Результат: allowed, unlimited, used, left, limit, cached, reason ('' | 'no_access' | 'limit').
CREATE OR REPLACE FUNCTION public.trial_maps_take_at(p_org uuid, p_key text, p_at timestamptz, p_take boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := public.trial_maps_limit();
  v_day date := public.trial_maps_kyiv_day(p_at);
  v_key text := md5(coalesce(nullif(p_key, ''), gen_random_uuid()::text));
  v_used integer;
  v_cached boolean;
BEGIN
  IF p_org IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'unlimited', false, 'used', 0, 'left', 0, 'limit', v_limit, 'cached', false, 'reason', 'no_access');
  END IF;
  -- Повний доступ: ручне схвалення будь-кого з компанії або чинна оплата.
  IF EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.org_id = p_org AND p.is_approved)
     OR coalesce(public.org_has_paid_access(p_org), false) THEN
    RETURN jsonb_build_object('allowed', true, 'unlimited', true, 'used', 0, 'left', NULL, 'limit', NULL, 'cached', false, 'reason', '');
  END IF;
  IF NOT coalesce(public.org_trial_active(p_org), false) THEN
    RETURN jsonb_build_object('allowed', false, 'unlimited', false, 'used', 0, 'left', 0, 'limit', v_limit, 'cached', false, 'reason', 'no_access');
  END IF;
  -- Один запит за раз на компанію, щоб ліміт не обійшли паралельними викликами.
  PERFORM pg_advisory_xact_lock(hashtextextended('trial_maps:' || p_org::text, 0));
  SELECT count(*) INTO v_used FROM public.trial_maps_routes WHERE org_id = p_org AND day = v_day;
  SELECT EXISTS (SELECT 1 FROM public.trial_maps_routes WHERE org_id = p_org AND day = v_day AND route_key = v_key) INTO v_cached;
  IF NOT p_take OR v_cached THEN
    RETURN jsonb_build_object('allowed', v_cached OR v_used < v_limit, 'unlimited', false, 'used', v_used, 'left', greatest(v_limit - v_used, 0),
                              'limit', v_limit, 'cached', v_cached, 'reason', CASE WHEN v_cached OR v_used < v_limit THEN '' ELSE 'limit' END);
  END IF;
  IF v_used >= v_limit THEN
    RETURN jsonb_build_object('allowed', false, 'unlimited', false, 'used', v_used, 'left', 0, 'limit', v_limit, 'cached', false, 'reason', 'limit');
  END IF;
  INSERT INTO public.trial_maps_routes (org_id, day, route_key, created_at) VALUES (p_org, v_day, v_key, p_at);
  RETURN jsonb_build_object('allowed', true, 'unlimited', false, 'used', v_used + 1, 'left', v_limit - v_used - 1, 'limit', v_limit, 'cached', false, 'reason', '');
END;
$$;
REVOKE ALL ON FUNCTION public.trial_maps_take_at(uuid, text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trial_maps_take_at(uuid, text, timestamptz, boolean) TO service_role;

-- Клієнтські RPC: компанія береться з профілю поточного користувача, не з параметрів.
CREATE OR REPLACE FUNCTION public.maps_route_take(p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.trial_maps_take_at((SELECT p.org_id FROM public.profiles AS p WHERE p.id = auth.uid()), p_key, now(), true);
$$;

CREATE OR REPLACE FUNCTION public.maps_route_status()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.trial_maps_take_at((SELECT p.org_id FROM public.profiles AS p WHERE p.id = auth.uid()), NULL, now(), false);
$$;

-- Google не побудував маршрут (помилка, таймаут): дозвіл повертається.
CREATE OR REPLACE FUNCTION public.maps_route_refund(p_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.trial_maps_routes
  WHERE org_id = (SELECT p.org_id FROM public.profiles AS p WHERE p.id = auth.uid())
    AND day = public.trial_maps_kyiv_day(now())
    AND route_key = md5(coalesce(p_key, ''));
$$;

REVOKE ALL ON FUNCTION public.maps_route_take(text), public.maps_route_status(), public.maps_route_refund(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maps_route_take(text), public.maps_route_status(), public.maps_route_refund(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trial_maps_limit(), public.trial_maps_kyiv_day(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trial_maps_limit(), public.trial_maps_kyiv_day(timestamptz) TO authenticated, service_role;
