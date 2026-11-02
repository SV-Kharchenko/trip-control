-- Apply manually after review. This file is not applied to production by the agent.
-- Остання введена ціна дизпалива й AdBlue — спільна для всієї організації (не в localStorage): ключі lastFuelPrice / lastAdbluePrice
-- в company_settings.settings (jsonb). Писати їх можуть owner і логіст своєї організації; для цього окрема функція, яка оновлює
-- ЛИШЕ ці два ключі, тож логіст не може змінити інші налаштування (витрати, накладні тощо), а чужа організація — нічого.
-- Таблиці й політики не змінюються: лише одна нова функція (CREATE OR REPLACE).
--
-- РУЧНИЙ ВІДКАТ:
--   DROP FUNCTION IF EXISTS public.kp_set_last_fuel_prices(numeric, numeric);
--   (збережені ключі lastFuelPrice / lastAdbluePrice можна лишити: калькулятор без цієї функції їх просто не оновлює)

-- p_fuel / p_adblue — грн/л, 0 < ціна < 1000, округлюється до копійок; NULL = не змінювати. Обидва NULL — помилка.
CREATE OR REPLACE FUNCTION public.kp_set_last_fuel_prices(p_fuel numeric DEFAULT NULL, p_adblue numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_role text;
  v_patch jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.org_role INTO v_role
  FROM public.profiles AS p
  WHERE p.id = auth.uid() AND p.org_id = v_org AND p.member_status = 'active';
  IF coalesce(v_role NOT IN ('owner', 'logist'), true) OR public.is_user_blocked() THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_fuel IS NULL AND p_adblue IS NULL THEN
    RAISE EXCEPTION 'PRICE_EMPTY' USING ERRCODE = 'P0001';
  END IF;
  IF (p_fuel IS NOT NULL AND NOT (p_fuel > 0 AND p_fuel < 1000)) OR (p_adblue IS NOT NULL AND NOT (p_adblue > 0 AND p_adblue < 1000)) THEN
    RAISE EXCEPTION 'PRICE_BAD' USING ERRCODE = 'P0001';
  END IF;
  IF p_fuel IS NOT NULL THEN
    v_patch := v_patch || jsonb_build_object('lastFuelPrice', round(p_fuel, 2)::float8);
  END IF;
  IF p_adblue IS NOT NULL THEN
    v_patch := v_patch || jsonb_build_object('lastAdbluePrice', round(p_adblue, 2)::float8);
  END IF;
  -- Злиття на рівні jsonb в одному операторі: інші ключі (і одночасні зміни інших користувачів) не затираються.
  INSERT INTO public.company_settings AS cs (org_id, settings, updated_at)
  VALUES (v_org, v_patch, now())
  ON CONFLICT (org_id) DO UPDATE
    SET settings = coalesce(cs.settings, '{}'::jsonb) || excluded.settings, updated_at = now();
  RETURN v_patch;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_set_last_fuel_prices(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_set_last_fuel_prices(numeric, numeric) TO authenticated, service_role;
