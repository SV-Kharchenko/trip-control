-- Погодження заявок («Історія заявок»): статуси draft | pending | accepted | rejected (+ done після виконання),
-- хто і коли подав / вирішив, причина відхилення. НЕ застосовувати на прод без дозволу власника проєкту.
--
-- Ролі (перевіряються в базі, а не лише в інтерфейсі):
--   логіст (author)  створює заявки, бачить свої (select-політика без змін), подає draft/rejected -> pending,
--                    видаляє свої, доки заявка не accepted/done. Ставити accepted/rejected не може (42501 -> HTTP 403).
--   власник/директор бачить усі заявки компанії, ставить accepted/rejected лише для pending. У режимі «Сам»
--                    (organizations.work_mode = 'solo') власник приймає власну чернетку без погодження.
--   Прийняті (accepted/done) заявки не видаляє ніхто через клієнт (RLS delete).
-- Ідемпотентно: можна запускати повторно.

ALTER TABLE public.calculations
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS reject_reason text;

ALTER TABLE public.calculations
  DROP CONSTRAINT IF EXISTS calculations_reject_reason_len;
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_reject_reason_len
  CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 500);

-- «Запропоновано» (proposed) -> «На погодженні» (pending).
ALTER TABLE public.calculations
  DROP CONSTRAINT IF EXISTS calculations_status_check;
UPDATE public.calculations
   SET status = 'pending',
       submitted_at = COALESCE(submitted_at, created_at)
 WHERE status = 'proposed';
ALTER TABLE public.calculations
  ADD CONSTRAINT calculations_status_check
  CHECK (status IN ('draft', 'pending', 'accepted', 'rejected', 'done'));

CREATE INDEX IF NOT EXISTS calculations_org_pending_idx
  ON public.calculations (org_id, submitted_at DESC)
  WHERE status = 'pending';

-- Права переходів. Сервіс-роль і міграції (auth.uid() IS NULL) не обмежуються.
CREATE OR REPLACE FUNCTION public.calculations_enforce_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner boolean;
  v_solo boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.submitted_at := NULL;
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.reject_reason := NULL;
    RETURN NEW;
  END IF;

  -- Поля рішення змінюються лише разом зі статусом і лише цим тригером.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.submitted_at := OLD.submitted_at;
    NEW.decided_by := OLD.decided_by;
    NEW.decided_at := OLD.decided_at;
    NEW.reject_reason := OLD.reject_reason;
    RETURN NEW;
  END IF;

  v_owner := public.is_org_owner();

  IF NEW.status = 'pending' AND OLD.status IN ('draft', 'rejected') THEN
    IF OLD.user_id <> v_uid AND NOT v_owner THEN
      RAISE EXCEPTION 'APPROVAL_FORBIDDEN: only the author submits' USING ERRCODE = '42501';
    END IF;
    NEW.submitted_at := now();
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.reject_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status IN ('accepted', 'rejected') AND OLD.status = 'pending' THEN
    IF NOT v_owner THEN
      RAISE EXCEPTION 'APPROVAL_FORBIDDEN: only the owner decides' USING ERRCODE = '42501';
    END IF;
    NEW.decided_by := v_uid;
    NEW.decided_at := now();
    NEW.reject_reason := CASE WHEN NEW.status = 'rejected' THEN left(NULLIF(btrim(COALESCE(NEW.reject_reason, '')), ''), 500) ELSE NULL END;
    RETURN NEW;
  END IF;

  -- «Сам»: власник без логістів приймає власну заявку без погодження.
  IF NEW.status = 'accepted' AND OLD.status IN ('draft', 'rejected') THEN
    SELECT o.work_mode = 'solo' INTO v_solo FROM public.organizations AS o WHERE o.id = OLD.org_id;
    IF v_owner AND OLD.user_id = v_uid AND COALESCE(v_solo, false) THEN
      NEW.decided_by := v_uid;
      NEW.decided_at := now();
      NEW.reject_reason := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'APPROVAL_FORBIDDEN: not submitted' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'done' AND OLD.status = 'accepted' THEN
    IF OLD.user_id = v_uid OR v_owner THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'APPROVAL_FORBIDDEN: % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.calculations_enforce_approval() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_calculations_enforce_approval ON public.calculations;
CREATE TRIGGER trg_calculations_enforce_approval
  BEFORE INSERT OR UPDATE ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_enforce_approval();

-- Клієнт пише статус (уже дозволено) і причину відхилення; submitted_at / decided_* ставить лише тригер.
GRANT UPDATE (status, reject_reason) ON public.calculations TO authenticated;

-- Прийняті й виконані заявки видаляти не можна нікому через клієнт.
DROP POLICY IF EXISTS calculations_delete_role ON public.calculations;
CREATE POLICY calculations_delete_role ON public.calculations
  FOR DELETE TO authenticated
  USING (
    org_id = public.current_org_id()
    AND status NOT IN ('accepted', 'done')
    AND (public.is_org_owner() OR user_id = auth.uid())
  );
