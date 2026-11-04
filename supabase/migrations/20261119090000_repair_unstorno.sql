-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+ (ремонти): «Скасувати сторно».
--
-- * repairs.status_before_void — статус ремонту до сторно (kp_repair_void тепер його зберігає). Допустимий лише 'posted': інших
--   «активних» статусів у ремонті немає. Для старих сторно, де його не зберігали (NULL), repair_unstorno повертає 'posted'.
-- * repair_status_log — журнал: хто і коли сторнував / скасував сторно ремонт.
-- * repair_unstorno(p_repair_id) — повертає сторнований ремонт у статус до сторно. Дозволено лише owner і repair_manager своєї
--   організації (director / logist — ні). Списання запчастин, зняті при сторно, знову списуються зі складу за тим самим unit_cost, за яким їх
--   списали (зворотна операція до повернення при сторно: кількість і середня знову такі, ніби сторно не було; не вистачає — STOCK_INSUFFICIENT,
--   нічого не змінюється); записи списань і суми ремонту лишаються як були. Сторно, зроблене до цієї міграції (немає запису 'void' у журналі),
--   перед скасуванням потрапляє в журнал зі своїми voided_at / voided_by / void_reason.
--   Рахунки / акти ремонт не створює й не анулює, тож пов'язаних документів немає.
-- Нових таблиць для клієнтів немає: журнал закритий RLS (select лише своя організація), пише лише SECURITY DEFINER.

ALTER TABLE public.repairs ADD COLUMN IF NOT EXISTS status_before_void text NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repairs_status_before_void_check' AND conrelid = 'public.repairs'::regclass) THEN
    ALTER TABLE public.repairs ADD CONSTRAINT repairs_status_before_void_check CHECK (status_before_void IS NULL OR status_before_void = 'posted');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.repair_status_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  repair_id uuid NOT NULL REFERENCES public.repairs (id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('void', 'unstorno')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor uuid NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.repair_status_log ADD COLUMN IF NOT EXISTS reason text NULL;
CREATE INDEX IF NOT EXISTS repair_status_log_repair_idx ON public.repair_status_log (repair_id, created_at);

ALTER TABLE public.repair_status_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_status_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.repair_status_log TO service_role;
GRANT SELECT ON public.repair_status_log TO authenticated;
DROP POLICY IF EXISTS repair_status_log_select ON public.repair_status_log;
CREATE POLICY repair_status_log_select ON public.repair_status_log FOR SELECT TO authenticated USING (org_id = public.kp_repairs_org_id());

-- Сторно (як у 3a) + запис статусу до сторно й журналу.
CREATE OR REPLACE FUNCTION public.kp_repair_void(p_repair uuid, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_r public.repairs%ROWTYPE;
  v_w record;
BEGIN
  SELECT * INTO v_r FROM public.repairs WHERE id = p_repair AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPAIR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'posted' THEN
    RAISE EXCEPTION 'REPAIR_ALREADY_VOID' USING ERRCODE = 'P0001';
  END IF;
  IF public.kp_repairs_role() NOT IN ('owner', 'director') THEN
    IF v_r.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF now() >= v_r.created_at + interval '24 hours' THEN
      RAISE EXCEPTION 'REPAIR_VOID_EXPIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  PERFORM 1 FROM public.parts AS p
  WHERE p.id IN (SELECT w.part_id FROM public.part_writeoffs AS w WHERE w.repair_id = v_r.id)
  ORDER BY p.id
  FOR UPDATE;
  FOR v_w IN
    SELECT w.id, w.part_id, w.qty, w.unit_cost FROM public.part_writeoffs AS w
    WHERE w.repair_id = v_r.id AND w.reversed_at IS NULL
    ORDER BY w.part_id
  LOOP
    PERFORM public.kp_stock_in(v_w.part_id, v_w.qty, v_w.unit_cost);
    UPDATE public.part_writeoffs SET reversed_at = now() WHERE id = v_w.id;
  END LOOP;
  UPDATE public.repairs
  SET status = 'void', status_before_void = v_r.status, voided_at = now(), voided_by = auth.uid(),
      void_reason = nullif(btrim(coalesce(p_reason, '')), '')
  WHERE id = v_r.id;
  INSERT INTO public.repair_status_log (org_id, repair_id, action, from_status, to_status, actor, reason)
  VALUES (v_org, v_r.id, 'void', v_r.status, 'void', auth.uid(), nullif(btrim(coalesce(p_reason, '')), ''));
  RETURN true;
END;
$$;

-- Скасування сторно: owner і repair_manager своєї організації. Повертає статус, у який повернуто ремонт.
CREATE OR REPLACE FUNCTION public.repair_unstorno(p_repair_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_repairs_require_write();
  v_r public.repairs%ROWTYPE;
  v_w record;
  v_p public.parts%ROWTYPE;
  v_to text;
BEGIN
  IF public.kp_repairs_role() NOT IN ('owner', 'repair_manager') THEN
    RAISE EXCEPTION 'REPAIRS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_r FROM public.repairs WHERE id = p_repair_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPAIR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'void' THEN
    RAISE EXCEPTION 'REPAIR_NOT_VOID' USING ERRCODE = 'P0001';
  END IF;
  v_to := coalesce(v_r.status_before_void, 'posted');
  PERFORM 1 FROM public.parts AS p
  WHERE p.id IN (SELECT w.part_id FROM public.part_writeoffs AS w WHERE w.repair_id = v_r.id)
  ORDER BY p.id
  FOR UPDATE;
  FOR v_w IN
    SELECT w.id, w.part_id, w.qty, w.unit_cost FROM public.part_writeoffs AS w
    WHERE w.repair_id = v_r.id AND w.reversed_at IS NOT NULL
    ORDER BY w.part_id
  LOOP
    -- Зворотна операція до kp_stock_in(qty, unit_cost) при сторно: знімаємо кількість за тим самим unit_cost, середня перераховується назад.
    SELECT * INTO v_p FROM public.parts WHERE id = v_w.part_id;
    IF v_p.qty < v_w.qty THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT' USING ERRCODE = 'P0001', DETAIL = v_p.name;
    END IF;
    UPDATE public.parts
    SET avg_cost = CASE WHEN qty - v_w.qty > 0 THEN round(greatest(0, (qty * avg_cost - v_w.qty * v_w.unit_cost) / (qty - v_w.qty)), 4) ELSE avg_cost END,
        qty = qty - v_w.qty,
        updated_at = now()
    WHERE id = v_w.part_id;
    UPDATE public.part_writeoffs SET reversed_at = NULL WHERE id = v_w.id;
  END LOOP;
  -- Сторно до цієї міграції не має запису в журналі: фіксуємо його зі старими значеннями, перш ніж їх обнулити.
  IF NOT EXISTS (SELECT 1 FROM public.repair_status_log WHERE repair_id = v_r.id AND action = 'void') THEN
    INSERT INTO public.repair_status_log (org_id, repair_id, action, from_status, to_status, actor, reason, created_at)
    VALUES (v_org, v_r.id, 'void', v_to, 'void', v_r.voided_by, v_r.void_reason, coalesce(v_r.voided_at, now()));
  END IF;
  UPDATE public.repairs
  SET status = v_to, status_before_void = NULL, voided_at = NULL, voided_by = NULL, void_reason = NULL, updated_at = now()
  WHERE id = v_r.id;
  INSERT INTO public.repair_status_log (org_id, repair_id, action, from_status, to_status, actor)
  VALUES (v_org, v_r.id, 'unstorno', 'void', v_to, auth.uid());
  RETURN v_to;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_unstorno(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_unstorno(uuid) TO authenticated, service_role;
