-- Вибір варіанта маршруту директором при погодженні заявки.
-- Заявка зберігає всі варіанти Google в calculations.inputs.routeVariants (км, час, шлях, прибуток, пальне) і вибір логіста
-- в inputs.routeVariant.index; тут з'являється погоджений варіант. НЕ застосовувати на прод без дозволу власника проєкту.
--
-- calculations.approved_variant (jsonb, NULL = варіант не вибирався: стара заявка або без альтернатив):
--   { index, km, minutes, podachaKm, summary, logistIndex, netProfit, decidedBy, decidedAt }
-- Пише лише сервіс (api/team.js, calc_decide, service role). Клієнт (authenticated) цю колонку не оновлює:
-- UPDATE на проді дозволено лише для status / reject_reason (20261027140559_calc_approvals.sql), а тригер нижче додатково
-- обнуляє її на INSERT і забороняє змінювати клієнту.
-- Км і прибуток заявки при іншому виборі директора перераховує той самий сервіс (inputs.dist, results.*), а
-- calculations_fill_history() сам оновлює distance_km / profit, бо inputs і results змінилися.
-- Нову міграцію можна запускати повторно (ідемпотентна). Старі міграції не редагуються.

ALTER TABLE public.calculations
  ADD COLUMN IF NOT EXISTS approved_variant jsonb;

ALTER TABLE public.calculations
  DROP CONSTRAINT IF EXISTS calculations_approved_variant_shape;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_approved_variant_shape
  CHECK (
    approved_variant IS NULL
    OR (
      jsonb_typeof(approved_variant) = 'object'
      AND pg_column_size(approved_variant) <= 2048
    )
  );

-- Клієнт (auth.uid() не NULL) не може ні вставити «погоджений» варіант, ні змінити його. Сервіс і міграції (auth.uid() IS NULL)
-- не обмежуються. Так само діє й там, де в authenticated є право UPDATE на всю таблицю, а не лише на окремі колонки.
CREATE OR REPLACE FUNCTION public.calculations_guard_approved_variant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.approved_variant := NULL;
  ELSIF NEW.approved_variant IS DISTINCT FROM OLD.approved_variant THEN
    RAISE EXCEPTION 'APPROVAL_FORBIDDEN: the approved route variant is set by the approval service' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_guard_approved_variant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_calculations_clear_approved_variant ON public.calculations;
DROP TRIGGER IF EXISTS trg_calculations_guard_approved_variant ON public.calculations;
CREATE TRIGGER trg_calculations_guard_approved_variant
  BEFORE INSERT OR UPDATE ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_guard_approved_variant();
DROP FUNCTION IF EXISTS public.calculations_clear_approved_variant();


