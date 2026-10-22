-- Контроль+ (Етап 1): клієнти (вантажовласники) з реквізитами, прив'язка рейсу до клієнта, історія клієнта,
-- звіт план / факт.
--
-- * clients — реквізити для майбутніх актів і рахунків (Етап 4). CHECK-и формату м'які: усе необов'язкове може бути NULL;
--   тригер прибирає пробіли й порожні рядки (IBAN — без пробілів і великими літерами) до перевірки.
-- * calculation_clients — рейс → клієнт без зміни calculations (один клієнт на рейс).
-- * client_history(client), kp_trips(from, to, only_unlinked), report_plan_fact(from, to, group) — SECURITY DEFINER з
--   тими самими правилами видимості, що й на сайті: власник і директор — усі рейси організації; логіст — свої, або всі,
--   якщо в компанії ввімкнено «логісти бачать усе».
-- * Доступ: читати — учасники своєї організації на control_plus і її директори; писати — owner / logist своєї
--   організації на control_plus (не заблоковані); директор — лише читання.
-- * clients.org_id — ON DELETE RESTRICT: org_has_user_data() (не змінюємо) не знає про clients, тож прийняття запрошення
--   не видалить організацію разом із клієнтами — воно зупиниться.
--
-- Лише адитивно: нові таблиці, функції, тригери й політики на нових таблицях. Ідемпотентно.
-- Не застосовується до прод-БД цим PR. Після 20261022090000_kontrol_plus_access.sql.

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL,
  legal_name text NULL,
  legal_form text NULL,
  edrpou text NULL,
  ipn text NULL,
  vat_payer boolean NOT NULL DEFAULT false,
  vat_number text NULL,
  iban text NULL,
  bank_name text NULL,
  legal_address text NULL,
  postal_address text NULL,
  signer_name text NULL,
  signer_position text NULL,
  contact_name text NULL,
  phone text NULL,
  email text NULL,
  notes text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  CONSTRAINT clients_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT clients_legal_form_check CHECK (legal_form IS NULL OR legal_form IN ('tov', 'fop', 'other')),
  CONSTRAINT clients_edrpou_format CHECK (edrpou IS NULL OR edrpou ~ '^[0-9]{8}$'),
  CONSTRAINT clients_ipn_format CHECK (ipn IS NULL OR ipn ~ '^[0-9]{10}$'),
  CONSTRAINT clients_vat_number_format CHECK (vat_number IS NULL OR vat_number ~ '^([0-9]{10}|[0-9]{12})$'),
  CONSTRAINT clients_iban_format CHECK (iban IS NULL OR iban ~ '^UA[0-9]{27}$'),
  CONSTRAINT clients_email_format CHECK (email IS NULL OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT clients_notes_len CHECK (notes IS NULL OR char_length(notes) <= 4000)
);

CREATE INDEX IF NOT EXISTS clients_org_name_idx ON public.clients (org_id, lower(name));
-- Один активний клієнт на ЄДРПОУ / ІПН в організації (архівні не заважають).
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_edrpou_uidx
  ON public.clients (org_id, edrpou) WHERE edrpou IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_ipn_uidx
  ON public.clients (org_id, ipn) WHERE ipn IS NOT NULL AND archived_at IS NULL;

-- Нормалізація до CHECK-ів, автор і час — від сервера, організацію змінити не можна.
CREATE OR REPLACE FUNCTION public.kp_clients_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.name := btrim(coalesce(NEW.name, ''));
  NEW.legal_name := nullif(btrim(NEW.legal_name), '');
  NEW.legal_form := nullif(lower(btrim(NEW.legal_form)), '');
  NEW.edrpou := nullif(regexp_replace(NEW.edrpou, '\s', '', 'g'), '');
  NEW.ipn := nullif(regexp_replace(NEW.ipn, '\s', '', 'g'), '');
  NEW.vat_number := nullif(regexp_replace(NEW.vat_number, '\s', '', 'g'), '');
  NEW.iban := nullif(upper(regexp_replace(NEW.iban, '\s', '', 'g')), '');
  NEW.bank_name := nullif(btrim(NEW.bank_name), '');
  NEW.legal_address := nullif(btrim(NEW.legal_address), '');
  NEW.postal_address := nullif(btrim(NEW.postal_address), '');
  NEW.signer_name := nullif(btrim(NEW.signer_name), '');
  NEW.signer_position := nullif(btrim(NEW.signer_position), '');
  NEW.contact_name := nullif(btrim(NEW.contact_name), '');
  NEW.phone := nullif(btrim(NEW.phone), '');
  NEW.email := nullif(lower(btrim(NEW.email)), '');
  NEW.notes := nullif(btrim(NEW.notes), '');
  NEW.vat_payer := coalesce(NEW.vat_payer, false);

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(auth.uid(), NEW.created_by);
    NEW.created_at := now();
  ELSE
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'CLIENT_ORG_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_clients_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_clients_guard ON public.clients;
CREATE TRIGGER trg_kp_clients_guard
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.kp_clients_guard();

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clients FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT ALL ON public.clients TO service_role;

DROP POLICY IF EXISTS clients_select ON public.clients;
CREATE POLICY clients_select ON public.clients
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

DROP POLICY IF EXISTS clients_insert ON public.clients;
CREATE POLICY clients_insert ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.kp_can_write());

DROP POLICY IF EXISTS clients_update ON public.clients;
CREATE POLICY clients_update ON public.clients
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND public.kp_can_write())
  WITH CHECK (org_id = public.current_org_id() AND public.kp_can_write());

-- Видаляє лише власник (решта — архів).
DROP POLICY IF EXISTS clients_delete ON public.clients;
CREATE POLICY clients_delete ON public.clients
  FOR DELETE TO authenticated
  USING (org_id = public.current_org_id() AND public.kp_can_write() AND public.kp_role() = 'owner');

-- ---------------------------------------------------------------------------
-- calculation_clients: trip → client
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.calculation_clients (
  calculation_id uuid PRIMARY KEY REFERENCES public.calculations (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  linked_by uuid NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calculation_clients_client_idx ON public.calculation_clients (client_id);
CREATE INDEX IF NOT EXISTS calculation_clients_org_idx ON public.calculation_clients (org_id);

-- Прив'язати / змінити / зняти прив'язку може власник (будь-який рейс організації) або автор рейсу.
CREATE OR REPLACE FUNCTION public.kp_can_link(p_calc uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.kp_can_write() AND EXISTS (
    SELECT 1 FROM public.calculations AS c
    WHERE c.id = p_calc
      AND c.org_id = public.current_org_id()
      AND (public.kp_role() = 'owner' OR c.user_id = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.kp_can_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_can_link(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.kp_calculation_clients_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calc_org uuid;
  v_client_org uuid;
BEGIN
  SELECT c.org_id INTO v_calc_org FROM public.calculations AS c WHERE c.id = NEW.calculation_id;
  SELECT cl.org_id INTO v_client_org FROM public.clients AS cl WHERE cl.id = NEW.client_id;
  IF v_calc_org IS NULL OR v_client_org IS NULL OR v_calc_org IS DISTINCT FROM v_client_org THEN
    RAISE EXCEPTION 'CLIENT_LINK_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;
  NEW.org_id := v_calc_org;
  IF public.kp_is_client_role() OR NOT public.is_service_role() THEN
    IF NOT public.kp_can_link(NEW.calculation_id) THEN
      RAISE EXCEPTION 'CLIENT_LINK_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.linked_by := auth.uid();
  END IF;
  NEW.linked_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_calculation_clients_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_calculation_clients_guard ON public.calculation_clients;
CREATE TRIGGER trg_kp_calculation_clients_guard
  BEFORE INSERT OR UPDATE ON public.calculation_clients
  FOR EACH ROW EXECUTE FUNCTION public.kp_calculation_clients_guard();

ALTER TABLE public.calculation_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calculation_clients FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calculation_clients TO authenticated;
GRANT ALL ON public.calculation_clients TO service_role;

DROP POLICY IF EXISTS calculation_clients_select ON public.calculation_clients;
CREATE POLICY calculation_clients_select ON public.calculation_clients
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

DROP POLICY IF EXISTS calculation_clients_insert ON public.calculation_clients;
CREATE POLICY calculation_clients_insert ON public.calculation_clients
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.kp_can_link(calculation_id));

DROP POLICY IF EXISTS calculation_clients_update ON public.calculation_clients;
CREATE POLICY calculation_clients_update ON public.calculation_clients
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND public.kp_can_link(calculation_id))
  WITH CHECK (org_id = public.current_org_id() AND public.kp_can_link(calculation_id));

DROP POLICY IF EXISTS calculation_clients_delete ON public.calculation_clients;
CREATE POLICY calculation_clients_delete ON public.calculation_clients
  FOR DELETE TO authenticated
  USING (org_id = public.current_org_id() AND public.kp_can_link(calculation_id));

-- ---------------------------------------------------------------------------
-- Trip visibility (same rules as the site)
-- ---------------------------------------------------------------------------

-- Чи бачить користувач Контроль+ рейс автора p_user у своїй організації Контроль+.
CREATE OR REPLACE FUNCTION public.kp_trip_visible(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE public.kp_role()
    WHEN 'owner' THEN true
    WHEN 'director' THEN true
    WHEN 'logist' THEN p_user = auth.uid() OR public.org_logists_see_all()
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.kp_trip_visible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kp_trip_visible(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Trips for linking (Контроль+): visible trips of the period with their client
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_trips(p_from date, p_to date, p_only_unlinked boolean DEFAULT false)
RETURNS TABLE (
  calculation_id uuid, trip_date date, name text, route_from text, route_to text, status text,
  plan_revenue numeric, plan_profit numeric, client_id uuid, client_name text, can_link boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT c.id, c.trip_date, c.name, c.route_from, c.route_to, c.status,
         c.revenue, c.profit, cc.client_id, cl.name,
         public.kp_can_link(c.id)
  FROM public.calculations AS c
  LEFT JOIN public.calculation_clients AS cc ON cc.calculation_id = c.id
  LEFT JOIN public.clients AS cl ON cl.id = cc.client_id
  WHERE c.org_id = v_org
    AND c.trip_date BETWEEN p_from AND p_to
    AND public.kp_trip_visible(c.user_id)
    AND (NOT coalesce(p_only_unlinked, false) OR cc.calculation_id IS NULL)
  ORDER BY c.trip_date DESC, c.created_at DESC
  LIMIT 500;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_trips(date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_trips(date, date, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Client history: trips, rates (calculations) and fact (trip_actuals)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.client_history(p_client uuid)
RETURNS TABLE (
  calculation_id uuid, trip_date date, name text, route_from text, route_to text, status text,
  rate numeric, distance_km numeric, tonnage numeric,
  plan_revenue numeric, plan_costs numeric, plan_profit numeric,
  fact_revenue numeric, fact_costs numeric, fact_profit numeric,
  author_email text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients AS cl WHERE cl.id = p_client AND cl.org_id = v_org) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT c.id, c.trip_date, c.name, c.route_from, c.route_to, c.status,
         c.rate, c.distance_km, c.tonnage,
         c.revenue, c.revenue - c.profit, c.profit,
         ta.revenue, ta.costs + ta.planned_overhead, ta.profit,
         p.email
  FROM public.calculation_clients AS cc
  JOIN public.calculations AS c ON c.id = cc.calculation_id
  LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
  LEFT JOIN public.profiles AS p ON p.id = c.user_id
  WHERE cc.client_id = p_client
    AND c.org_id = v_org
    AND public.kp_trip_visible(c.user_id)
  ORDER BY c.trip_date DESC NULLS LAST, c.created_at DESC
  LIMIT 1000;
END;
$$;

REVOKE ALL ON FUNCTION public.client_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_history(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Plan / fact report
-- ---------------------------------------------------------------------------
-- Рейси: статуси accepted / done з trip_date у періоді (чернетки й пропозиції — ще не рейси).
-- План: calculations.revenue / profit; витрати плану = revenue − profit.
-- Факт: trip_actuals (витрати факту = costs + planned_overhead, прибуток = profit).
-- Відхилення — лише по рейсах з фактом: fact_profit − plan_profit_with_fact (і у % від |plan_profit_with_fact|).
-- Групи:
--   logist    — автор рейсу (email);
--   vehicle   — авто рейсу (calc_vehicles); кілька авто — суми діляться пропорційно тоннажу
--               (тоннаж не вказано — порівну); без авто — «Без авто»;
--   client    — клієнт (calculation_clients); без — «Без клієнта»;
--   direction — шаблон маршруту: назва рейсу (без « (копія)») = назва шаблону організації; без збігу — «Без шаблону».

CREATE OR REPLACE FUNCTION public.report_plan_fact(p_from date, p_to date, p_group text)
RETURNS TABLE (
  group_key text, group_label text, trips integer, trips_with_fact integer,
  plan_revenue numeric, plan_costs numeric, plan_profit numeric,
  fact_revenue numeric, fact_costs numeric, fact_profit numeric,
  plan_profit_with_fact numeric, deviation_profit numeric, deviation_pct numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'CONTROL_PLUS_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_group IS NULL OR p_group NOT IN ('logist', 'vehicle', 'client', 'direction') THEN
    RAISE EXCEPTION 'BAD_GROUP' USING ERRCODE = 'P0001';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'BAD_PERIOD' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  WITH trips AS (
    SELECT c.id, c.user_id, c.name,
           coalesce(c.revenue, 0) AS p_rev, coalesce(c.profit, 0) AS p_profit,
           ta.id IS NOT NULL AS has_fact,
           coalesce(ta.revenue, 0) AS f_rev,
           coalesce(ta.costs, 0) + coalesce(ta.planned_overhead, 0) AS f_costs,
           coalesce(ta.profit, 0) AS f_profit
    FROM public.calculations AS c
    LEFT JOIN public.trip_actuals AS ta ON ta.calculation_id = c.id
    WHERE c.org_id = v_org
      AND c.status IN ('accepted', 'done')
      AND c.trip_date BETWEEN p_from AND p_to
      AND public.kp_trip_visible(c.user_id)
  ),
  keyed AS (
    -- logist
    SELECT t.*, t.user_id::text AS k, coalesce(p.email, 'Користувач без профілю') AS label, 1::numeric AS w
    FROM trips AS t
    LEFT JOIN public.profiles AS p ON p.id = t.user_id
    WHERE p_group = 'logist'
    UNION ALL
    -- vehicle: share by tonnage; no tonnage on the trip (NULL / 0) → equal shares
    SELECT t.*, coalesce(cv.vehicle_id::text, 'unlinked:' || cv.id::text),
           coalesce(fv.label, nullif(cv.snapshot ->> 'label', ''), 'Авто без картки'),
           CASE WHEN coalesce(sum(cv.tonnage) OVER (PARTITION BY t.id), 0) > 0
                THEN coalesce(cv.tonnage, 0) / sum(cv.tonnage) OVER (PARTITION BY t.id)
                ELSE 1::numeric / count(*) OVER (PARTITION BY t.id) END
    FROM trips AS t
    JOIN public.calc_vehicles AS cv ON cv.calc_id = t.id
    LEFT JOIN public.fleet_vehicles AS fv ON fv.id = cv.vehicle_id
    WHERE p_group = 'vehicle'
    UNION ALL
    SELECT t.*, 'none', 'Без авто', 1::numeric
    FROM trips AS t
    WHERE p_group = 'vehicle' AND NOT EXISTS (SELECT 1 FROM public.calc_vehicles AS cv WHERE cv.calc_id = t.id)
    UNION ALL
    -- client
    SELECT t.*, coalesce(cl.id::text, 'none'), coalesce(cl.name, 'Без клієнта'), 1::numeric
    FROM trips AS t
    LEFT JOIN public.calculation_clients AS cc ON cc.calculation_id = t.id
    LEFT JOIN public.clients AS cl ON cl.id = cc.client_id
    WHERE p_group = 'client'
    UNION ALL
    -- direction: route template by name
    SELECT t.*, coalesce(rt.id::text, 'none'), coalesce(rt.name, 'Без шаблону'), 1::numeric
    FROM trips AS t
    LEFT JOIN LATERAL (
      SELECT r.id, r.name
      FROM public.route_templates AS r
      WHERE r.org_id = v_org
        AND lower(btrim(r.name)) = lower(btrim(regexp_replace(coalesce(t.name, ''), '( \(копія\))+$', '')))
      ORDER BY r.created_at, r.id
      LIMIT 1
    ) AS rt ON true
    WHERE p_group = 'direction'
  ),
  grouped AS (
    SELECT k.k AS g_key, min(k.label) AS g_label,
           count(DISTINCT k.id)::integer AS g_trips,
           count(DISTINCT k.id) FILTER (WHERE k.has_fact)::integer AS g_fact_trips,
           sum(k.p_rev * k.w) AS g_p_rev,
           sum((k.p_rev - k.p_profit) * k.w) AS g_p_costs,
           sum(k.p_profit * k.w) AS g_p_profit,
           sum(k.f_rev * k.w) FILTER (WHERE k.has_fact) AS g_f_rev,
           sum(k.f_costs * k.w) FILTER (WHERE k.has_fact) AS g_f_costs,
           sum(k.f_profit * k.w) FILTER (WHERE k.has_fact) AS g_f_profit,
           sum(k.p_profit * k.w) FILTER (WHERE k.has_fact) AS g_p_profit_fact
    FROM keyed AS k
    GROUP BY k.k
  )
  SELECT g.g_key, g.g_label, g.g_trips, g.g_fact_trips,
         round(coalesce(g.g_p_rev, 0), 2), round(coalesce(g.g_p_costs, 0), 2), round(coalesce(g.g_p_profit, 0), 2),
         round(coalesce(g.g_f_rev, 0), 2), round(coalesce(g.g_f_costs, 0), 2), round(coalesce(g.g_f_profit, 0), 2),
         round(coalesce(g.g_p_profit_fact, 0), 2),
         round(coalesce(g.g_f_profit, 0) - coalesce(g.g_p_profit_fact, 0), 2),
         CASE WHEN g.g_fact_trips = 0 OR coalesce(g.g_p_profit_fact, 0) = 0 THEN NULL
              ELSE round((coalesce(g.g_f_profit, 0) - g.g_p_profit_fact) / abs(g.g_p_profit_fact) * 100, 1) END
  FROM grouped AS g
  ORDER BY g.g_key = 'none', g.g_label;
END;
$$;

REVOKE ALL ON FUNCTION public.report_plan_fact(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_plan_fact(date, date, text) TO authenticated, service_role;
