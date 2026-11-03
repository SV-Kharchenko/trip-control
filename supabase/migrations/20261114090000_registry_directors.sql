-- Apply manually after review. This file is not applied to production by the agent.
--
-- Директори Контроль+ (org_directors) бачать реєстр і заявки своєї компанії.
--
-- ЯК БУЛО: профіль директора може належати іншій організації (profiles.org_id), а current_org_id() повертає саме її (або NULL).
-- kp_org_id() для Контроль+ дає свою організацію, якщо вона на control_plus, інакше — першу (за created_at) компанію, де користувач у
-- org_directors і тариф control_plus; kp_role() = 'director'. Окремого перемикача компаній немає. KP-RPC працюють через kp_org_id(),
-- а registry_list / registry_totals і RLS calculations / trip_actuals фільтрували за current_org_id(), тож директор реєстру не бачив.
-- api/team.js це обходить службовою роллю: заявку шукає за id і підтверджує членство в org_directors (isOrgDirector).
--
-- ЩО ЗМІНЕНО:
--  * can_view_org(org) — SECURITY DEFINER: org = current_org_id() АБО користувач директор цієї org (kp_is_org_director: org_directors +
--    тариф control_plus). EXECUTE лише authenticated.
--  * registry_list / registry_totals: необов'язковий ключ filters.org_id (за замовчуванням current_org_id()); явний org_id без доступу —
--    42501 REGISTRY_FORBIDDEN. Лишаються SECURITY INVOKER: видимість рядків усе одно задає RLS (захист у два шари), а не довіра функції.
--  * Нові SELECT-політики (лише додаються, наявні не змінюються): calculations_select_director, trip_actuals_select_director, а також
--    calc_vehicles_select_director і calculation_clients_select_director (без них у директора не працюють фільтри «авто» і «клієнт»
--    та підсумки). Політики використовують kp_is_org_director(org_id), а не can_view_org: гілка «своя організація» в can_view_org
--    розширила б видимість логістів. UPDATE / INSERT / DELETE не розширюються: зміни статусу йдуть через API.
--
-- Ідемпотентно. Старі міграції не редагуються.
--
-- РУЧНИЙ ВІДКАТ (SQL editor, однією транзакцією; спершу політики, потім функції):
--   BEGIN;
--   DROP POLICY IF EXISTS calculation_clients_select_director ON public.calculation_clients;
--   DROP POLICY IF EXISTS calc_vehicles_select_director ON public.calc_vehicles;
--   DROP POLICY IF EXISTS trip_actuals_select_director ON public.trip_actuals;
--   DROP POLICY IF EXISTS calculations_select_director ON public.calculations;
--   -- Тіла registry_list(jsonb, integer, integer) і registry_totals(jsonb) назад: виконати їх CREATE OR REPLACE FUNCTION з
--   -- 20261113090000_request_registry.sql (рядки "CREATE OR REPLACE FUNCTION public.registry_list" … до REVOKE; сигнатури й гранти не
--   -- змінювались: EXECUTE лише authenticated, service_role).
--   DROP FUNCTION IF EXISTS public.can_view_org(uuid);
--   COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION public.can_view_org(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_org IS NOT NULL
     AND (p_org = public.current_org_id() OR public.kp_is_org_director(p_org));
$$;

REVOKE ALL ON FUNCTION public.can_view_org(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_org(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- SELECT для директора Контроль+ (лише читання; kp_is_org_director = org_directors + control_plus)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS calculations_select_director ON public.calculations;
CREATE POLICY calculations_select_director ON public.calculations
  FOR SELECT TO authenticated
  USING (public.kp_is_org_director(org_id));

DROP POLICY IF EXISTS trip_actuals_select_director ON public.trip_actuals;
CREATE POLICY trip_actuals_select_director ON public.trip_actuals
  FOR SELECT TO authenticated
  USING (public.kp_is_org_director(org_id));

DROP POLICY IF EXISTS calc_vehicles_select_director ON public.calc_vehicles;
CREATE POLICY calc_vehicles_select_director ON public.calc_vehicles
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.calculations AS c WHERE c.id = calc_vehicles.calc_id AND public.kp_is_org_director(c.org_id)));

DROP POLICY IF EXISTS calculation_clients_select_director ON public.calculation_clients;
CREATE POLICY calculation_clients_select_director ON public.calculation_clients
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.calculations AS c WHERE c.id = calculation_clients.calculation_id AND public.kp_is_org_director(c.org_id)));

-- ---------------------------------------------------------------------------
-- RPC реєстру з необов'язковим org_id у filters (SECURITY INVOKER, сигнатури не змінились)
-- ---------------------------------------------------------------------------

-- Фільтри (jsonb): org_id (необов'язково: компанія директора Контроль+; за замовчуванням current_org_id()), from, to (дата рейсу;
-- без неї — дата рішення / створення), user_id (логіст), vehicle, client (uuid),
-- status (accepted | done | cancelled, рядок або масив; без фільтра — усі три).
CREATE OR REPLACE FUNCTION public.registry_list(p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, registry_no text, status text, user_id uuid, name text, client_name text, trip_date date,
  route_from text, route_to text, distance_km numeric, revenue numeric, profit numeric,
  fact_revenue numeric, fact_profit numeric, decided_at timestamptz, cancelled_at timestamptz, cancel_reason text,
  created_at timestamptz, total_count bigint
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
  SELECT c.id, c.registry_no, c.status, c.user_id, c.name, c.client_name, c.trip_date,
         c.route_from, c.route_to, c.distance_km, c.revenue, c.profit,
         ta.revenue, ta.profit, c.decided_at, c.cancelled_at, c.cancel_reason,
         c.created_at, count(*) OVER ()
  FROM public.calculations AS c
  LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
  WHERE c.org_id = v_org
    AND c.status = ANY (v_statuses)
    AND (v_from IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) >= v_from)
    AND (v_to IS NULL OR coalesce(c.trip_date, (c.decided_at AT TIME ZONE 'Europe/Kyiv')::date, (c.created_at AT TIME ZONE 'Europe/Kyiv')::date) <= v_to)
    AND (v_user IS NULL OR c.user_id = v_user)
    AND (v_vehicle IS NULL OR EXISTS (SELECT 1 FROM public.calc_vehicles AS cv WHERE cv.calc_id = c.id AND cv.vehicle_id = v_vehicle))
    AND (v_client IS NULL OR EXISTS (SELECT 1 FROM public.calculation_clients AS cc WHERE cc.calculation_id = c.id AND cc.client_id = v_client))
  ORDER BY c.registry_no DESC NULLS LAST, c.created_at DESC, c.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

-- Ті самі фільтри. Підсумки: кількість (разом зі скасованими; cancelled_count окремо), виручка (план), прибуток план,
-- прибуток факт (trip_actuals), км — суми БЕЗ скасованих заявок.
CREATE OR REPLACE FUNCTION public.registry_totals(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
  total_count bigint, cancelled_count bigint, revenue numeric, profit_plan numeric, profit_fact numeric, distance_km numeric
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
         coalesce(sum(ta.profit) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric,
         coalesce(sum(c.distance_km) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric
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


REVOKE ALL ON FUNCTION public.registry_list(jsonb, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.registry_totals(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registry_list(jsonb, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.registry_totals(jsonb) TO authenticated, service_role;

COMMIT;
