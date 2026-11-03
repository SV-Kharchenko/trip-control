-- Apply manually after review. This file is not applied to production by the agent.
--
-- «Прибуток факт» у Реєстрі заявок: факт, якщо його внесено, інакше план (раніше заявки без факту рахувались як 0, і сума
-- займала лише 3 із 9 заявок). registry_totals отримує поле fact_count (у скількох заявках факт внесено); скасовані в суми й
-- fact_count не входять. Решта без змін: SECURITY INVOKER, org_id у filters, can_view_org / REGISTRY_FORBIDDEN, фільтри, гранти.
-- Змінюється набір колонок результату, тому стара функція видаляється й створюється наново (CREATE OR REPLACE тут неможливий).
--
-- РУЧНИЙ ВІДКАТ (SQL editor, однією транзакцією):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.registry_totals(jsonb);
--   -- Попередня версія: виконати CREATE OR REPLACE FUNCTION public.registry_totals з 20261114090000_registry_directors.sql
--   -- (від рядка "CREATE OR REPLACE FUNCTION public.registry_totals" до "$$;") і гранти нижче:
--   REVOKE ALL ON FUNCTION public.registry_totals(jsonb) FROM PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION public.registry_totals(jsonb) TO authenticated, service_role;
--   COMMIT;

BEGIN;

DROP FUNCTION IF EXISTS public.registry_totals(jsonb);

-- Ті самі фільтри. Підсумки: кількість (разом зі скасованими; cancelled_count окремо), виручка (план), прибуток план,
-- прибуток факт = факт (trip_actuals), якщо внесено, інакше план: sum(coalesce(факт, план)); fact_count — у скількох заявках
-- факт внесено; км — суми БЕЗ скасованих заявок.
CREATE FUNCTION public.registry_totals(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
  total_count bigint, cancelled_count bigint, revenue numeric, profit_plan numeric, profit_fact numeric, distance_km numeric,
  fact_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date;
  v_to date;
  v_user uuid;
  v_vehicle uuid;
  v_client uuid;
  v_org uuid;
  v_explicit boolean;
  v_statuses text[];
BEGIN
  IF jsonb_typeof(f) <> 'object' THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_from := nullif(f ->> 'from', '')::date;
    v_to := nullif(f ->> 'to', '')::date;
    v_user := nullif(f ->> 'user_id', '')::uuid;
    v_vehicle := nullif(f ->> 'vehicle', '')::uuid;
    v_client := nullif(f ->> 'client', '')::uuid;
    v_org := nullif(f ->> 'org_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END;
  IF f ? 'status' AND jsonb_typeof(f -> 'status') = 'array' THEN
    SELECT array_agg(x) INTO v_statuses FROM jsonb_array_elements_text(f -> 'status') AS x;
  ELSIF f ? 'status' AND jsonb_typeof(f -> 'status') = 'string' THEN
    v_statuses := ARRAY[f ->> 'status'];
  END IF;
  v_statuses := coalesce(v_statuses, ARRAY['accepted', 'done', 'cancelled']);
  IF NOT (v_statuses <@ ARRAY['accepted', 'done', 'cancelled']) THEN
    RAISE EXCEPTION 'BAD_FILTER' USING ERRCODE = 'P0001';
  END IF;

  -- Організація: filters.org_id (директор Контроль+ чужої компанії) або поточна. Явний org_id — лише якщо can_view_org.
  v_explicit := v_org IS NOT NULL;
  v_org := coalesce(v_org, public.current_org_id());
  IF v_explicit AND NOT public.can_view_org(v_org) THEN
    RAISE EXCEPTION 'REGISTRY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT count(*)::bigint,
         (count(*) FILTER (WHERE c.status = 'cancelled'))::bigint,
         coalesce(sum(c.revenue) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(c.profit) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(coalesce(ta.profit, c.profit)) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(c.distance_km) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         (count(ta.id) FILTER (WHERE c.status <> 'cancelled'))::bigint
  FROM public.calculations AS c
  LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
  WHERE c.org_id = v_org
    AND c.status = ANY (v_statuses)
    AND (v_from IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) >= v_from)
    AND (v_to IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) <= v_to)
    AND (v_user IS NULL OR c.user_id = v_user)
    AND (v_vehicle IS NULL OR EXISTS (SELECT 1 FROM public.calc_vehicles AS cv WHERE cv.calc_id = c.id AND cv.vehicle_id = v_vehicle))
    AND (v_client IS NULL OR EXISTS (SELECT 1 FROM public.calculation_clients AS cc WHERE cc.calculation_id = c.id AND cc.client_id = v_client));
END;
$$;

REVOKE ALL ON FUNCTION public.registry_totals(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registry_totals(jsonb) TO authenticated, service_role;

COMMIT;
