-- Факт рейсу v2 (редактор «Факт» на сайті й у Контроль+).
-- Адитивно: нові nullable-стовпці trip_actuals і перевірки лише для них. Наявні стовпці, RLS, політики й права
-- не змінюються. Тригер trip_actuals_guard — та сама функція з тими самими перевірками доступу,
-- статусу й 30 діб, плюс правила v2 нижче.
--
-- v2 (fact_version = 'v2'): фактичні доби на ходку, пробіг з вантажем / порожнім на все замовлення,
-- оплачений простій (діб на ходку) і ставка (у валюті контракту), незаплановані витрати (грн) з описом.
-- revenue / costs / profit — підсумки перерахунку (POST /api/calculate?mode=fact → lib/trip-fact.js), planned_overhead = 0
-- (накладні вже в costs). Тож у звіті витрати факту = costs + planned_overhead = costs, прибуток = profit.
--
-- Старий факт (вручну, fact_version IS NULL) лишається як був: profit = revenue − costs − planned_overhead.
-- Закешована стара версія сайту оновлює рядок без v2-стовпців і без updated_at. Якщо вона змінює revenue / costs /
-- profit рядка v2, деталі v2 і fact_version обнуляються (рядок стає ручним фактом; planned_overhead лишається 0,
-- як його бачить і стара версія). Нова версія завжди надсилає updated_at, і за цим тригер її відрізняє.

ALTER TABLE public.trip_actuals
  ADD COLUMN IF NOT EXISTS fact_days numeric,
  ADD COLUMN IF NOT EXISTS fact_loaded_km numeric,
  ADD COLUMN IF NOT EXISTS fact_empty_km numeric,
  ADD COLUMN IF NOT EXISTS paid_idle_days numeric,
  ADD COLUMN IF NOT EXISTS idle_rate numeric,
  ADD COLUMN IF NOT EXISTS extra_costs numeric,
  ADD COLUMN IF NOT EXISTS extra_costs_note text,
  ADD COLUMN IF NOT EXISTS fact_version text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_actuals_fact_v2_values'
                 AND conrelid = 'public.trip_actuals'::regclass) THEN
    ALTER TABLE public.trip_actuals ADD CONSTRAINT trip_actuals_fact_v2_values CHECK (
      (fact_version IS NULL OR fact_version = 'v2')
      AND (fact_days IS NULL OR (fact_days > 0 AND fact_days <= 365))
      AND (fact_loaded_km IS NULL OR fact_loaded_km >= 0)
      AND (fact_empty_km IS NULL OR fact_empty_km >= 0)
      AND (paid_idle_days IS NULL OR (paid_idle_days >= 0 AND paid_idle_days <= 365))
      AND (idle_rate IS NULL OR idle_rate >= 0)
      AND (extra_costs IS NULL OR extra_costs >= 0)
      AND (extra_costs_note IS NULL OR char_length(extra_costs_note) <= 500)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_actuals_fact_v2_complete'
                 AND conrelid = 'public.trip_actuals'::regclass) THEN
    ALTER TABLE public.trip_actuals ADD CONSTRAINT trip_actuals_fact_v2_complete CHECK (
      fact_version IS NULL
      OR (fact_days IS NOT NULL AND fact_loaded_km IS NOT NULL AND fact_empty_km IS NOT NULL
          AND paid_idle_days IS NOT NULL AND idle_rate IS NOT NULL AND extra_costs IS NOT NULL)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trip_actuals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calc public.calculations%ROWTYPE;
  v_overhead numeric;
  v_anchor timestamptz;
BEGIN
  SELECT * INTO v_calc
  FROM public.calculations
  WHERE id = NEW.calculation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FACT_NO_TRIP' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.is_service_role() THEN
    IF auth.uid() IS NULL OR v_calc.org_id IS DISTINCT FROM public.current_org_id() THEN
      RAISE EXCEPTION 'FACT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF v_calc.status NOT IN ('accepted', 'done') THEN
      RAISE EXCEPTION 'FACT_STATUS'
        USING ERRCODE = 'P0001',
              DETAIL = 'Fact is allowed only for accepted or done trips';
    END IF;
    IF NOT public.is_org_owner() AND v_calc.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'FACT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    v_anchor := coalesce(v_calc.trip_date::timestamptz, v_calc.created_at, now());
    IF NOT public.is_org_owner() AND v_anchor + interval '30 days' < now() THEN
      RAISE EXCEPTION 'FACT_LOCKED'
        USING ERRCODE = 'P0001',
              DETAIL = 'After 30 days only the owner can edit the fact';
    END IF;
  END IF;

  v_overhead := public.tc_num(coalesce(v_calc.results, '{}'::jsonb), 'overheadTotal');

  -- Стара (закешована) версія сайту: змінює revenue / costs / profit рядка v2, не чіпаючи v2-стовпці
  -- й updated_at (нова версія завжди надсилає updated_at).
  IF TG_OP = 'UPDATE' AND OLD.fact_version IS NOT NULL
     AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
     AND NEW.fact_version IS NOT DISTINCT FROM OLD.fact_version
     AND NEW.fact_days IS NOT DISTINCT FROM OLD.fact_days
     AND NEW.fact_loaded_km IS NOT DISTINCT FROM OLD.fact_loaded_km
     AND NEW.fact_empty_km IS NOT DISTINCT FROM OLD.fact_empty_km
     AND NEW.paid_idle_days IS NOT DISTINCT FROM OLD.paid_idle_days
     AND NEW.idle_rate IS NOT DISTINCT FROM OLD.idle_rate
     AND NEW.extra_costs IS NOT DISTINCT FROM OLD.extra_costs
     AND NEW.extra_costs_note IS NOT DISTINCT FROM OLD.extra_costs_note
     AND (NEW.revenue IS DISTINCT FROM OLD.revenue
          OR NEW.costs IS DISTINCT FROM OLD.costs
          OR NEW.profit IS DISTINCT FROM OLD.profit) THEN
    NEW.fact_version := NULL;
  END IF;

  -- Без версії рядок — ручний факт: жодних застарілих деталей v2.
  IF NEW.fact_version IS NULL THEN
    NEW.fact_days := NULL;
    NEW.fact_loaded_km := NULL;
    NEW.fact_empty_km := NULL;
    NEW.paid_idle_days := NULL;
    NEW.idle_rate := NULL;
    NEW.extra_costs := NULL;
    NEW.extra_costs_note := NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- v2 → 0. Ручний факт → як і раніше, planned_overhead рядка (для колишнього v2 це 0: саме так
    -- рахувала прибуток і стара версія сайту, бо бере planned_overhead збереженого рядка).
    NEW.planned_overhead := CASE WHEN NEW.fact_version IS NOT NULL THEN 0 ELSE OLD.planned_overhead END;
    NEW.entered_by := OLD.entered_by;
    NEW.created_at := OLD.created_at;
  ELSE
    NEW.planned_overhead := CASE WHEN NEW.fact_version IS NOT NULL THEN 0 ELSE coalesce(v_overhead, 0) END;
    NEW.entered_by := coalesce(auth.uid(), NEW.entered_by);
    NEW.created_at := now();
  END IF;

  NEW.org_id := v_calc.org_id;
  NEW.profit := NEW.revenue - NEW.costs - NEW.planned_overhead;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trip_actuals_guard() FROM PUBLIC, anon, authenticated, service_role;
