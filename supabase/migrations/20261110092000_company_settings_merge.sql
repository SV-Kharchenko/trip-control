-- Apply manually after review. This file is not applied to production by the agent.
-- Налаштування компанії (company_settings.settings) зберігаються серверним merge, а не перезаписом усього об'єкта:
-- два власники (або дві вкладки) із різними змінами більше не затирають одне одного. Клієнт шле лише змінені ключі
-- (p_set) і ключі, які треба прибрати (p_remove); решта ключів у базі лишається як є — навіть ті, про які клієнт не знає
-- (lastFuelPrice / lastAdbluePrice, logists_see_all, нові ключі).
--
-- РУЧНИЙ ВІДКАТ:
--   DROP FUNCTION IF EXISTS public.kp_company_settings_merge(jsonb, text[]);

CREATE OR REPLACE FUNCTION public.kp_company_settings_merge(p_set jsonb DEFAULT '{}'::jsonb, p_remove text[] DEFAULT ARRAY[]::text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR public.is_user_blocked() OR NOT public.is_org_owner() THEN
    RAISE EXCEPTION 'SETTINGS_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_set IS NULL OR jsonb_typeof(p_set) <> 'object' OR pg_column_size(p_set) > 65536
     OR (p_remove IS NOT NULL AND cardinality(p_remove) > 200) THEN
    RAISE EXCEPTION 'SETTINGS_BAD_DATA' USING ERRCODE = 'P0001';
  END IF;
  -- Один оператор: видалення ключів і злиття відбуваються на актуальному значенні в базі (рядок блокується на час UPSERT).
  INSERT INTO public.company_settings AS cs (org_id, settings, updated_at)
  VALUES (v_org, p_set, now())
  ON CONFLICT (org_id) DO UPDATE
    SET settings = (coalesce(cs.settings, '{}'::jsonb) - coalesce(p_remove, ARRAY[]::text[])) || excluded.settings,
        updated_at = now()
  RETURNING cs.settings INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_company_settings_merge(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kp_company_settings_merge(jsonb, text[]) TO authenticated, service_role;
