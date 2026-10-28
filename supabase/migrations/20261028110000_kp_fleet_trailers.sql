-- Контроль+: причепи — окрема сутність fleet_trailers (раніше три колонки trailer_* у fleet_vehicles).
-- НЕ застосовувати на прод без дозволу власника проєкту. Ідемпотентно: можна запускати повторно.
--
-- Що робить:
--   1. fleet_trailers: org_id, plate (+ plate_norm — нормалізований номер), type, make_model, capacity_t, volume_m3,
--      строки ТО / страхування, active, timestamps. RLS як у fleet_vehicles: читають учасники організації, пишуть власник
--      (директор); логісту дозволено лише ТТН-колонки (make_model, capacity_t, volume_m3) через kp_trailer_save.
--   2. fleet_vehicles.default_trailer_id → fleet_trailers (ON DELETE SET NULL): «причіп за замовчуванням» тягача.
--   3. Перенос: кожен тягач, у якого заповнений trailer_plate, дає запис у fleet_trailers (один на org + нормалізований
--      номер; той самий причіп у кількох тягачів — один запис), тягач отримує default_trailer_id. Нічого не видаляється:
--      тягачі, ТТН (знімок причепа лежить у самому документі), розрахунки й історія лишаються як були.
--   4. Старі колонки fleet_vehicles.trailer_plate / trailer_type / trailer_make_model НЕ видаляються: це дзеркало
--      default_trailer_id, яким користуються сайт (калькулятор, історія) і kp_ttn_prefill. Тригери тримають їх у згоді
--      з fleet_trailers в обидва боки (запис через стару картку авто на сайті теж потрапляє в fleet_trailers).
--      «Деактивувати» причіп знімає його з усіх тягачів (default_trailer_id = NULL, дзеркало очищається).
--
-- Відкат (ручний, після перевірки): дзеркальні колонки fleet_vehicles повні, тож:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_fleet_vehicles_trailer_sync ON public.fleet_vehicles;
--   DROP TRIGGER IF EXISTS trg_fleet_trailers_after ON public.fleet_trailers;
--   DROP TRIGGER IF EXISTS trg_fleet_trailers_guard ON public.fleet_trailers;
--   DROP INDEX IF EXISTS public.fleet_vehicles_trailer_idx;
--   ALTER TABLE public.fleet_vehicles DROP COLUMN IF EXISTS default_trailer_id;
--   DROP TABLE IF EXISTS public.fleet_trailers;
--   DROP FUNCTION IF EXISTS public.kp_trailers_list();
--   DROP FUNCTION IF EXISTS public.kp_trailer_save(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.fleet_vehicles_trailer_sync();
--   DROP FUNCTION IF EXISTS public.fleet_trailers_after();
--   DROP FUNCTION IF EXISTS public.fleet_trailers_guard();
--   DROP FUNCTION IF EXISTS public.kp_plate_norm(text);
--   COMMIT;
-- Дані причепів при цьому не губляться — вони лишаються в trailer_* тягачів.

BEGIN;

-- Backfill і службові оновлення йдуть від service_role (fleet_vehicles_guard пускає лише власника / service_role).
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Нормалізований номер: верхній регістр, без пробілів / дефісів, кириличні двійники → латиниця (як lib/plates.js).
CREATE OR REPLACE FUNCTION public.kp_plate_norm(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT translate(upper(regexp_replace(coalesce(p, ''), '[\s\-_.]+', '', 'g')), 'АВЕІКМНОРСТХУ', 'ABEIKMHOPCTXY');
$$;

CREATE TABLE IF NOT EXISTS public.fleet_trailers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plate text NOT NULL CHECK (char_length(plate) BETWEEN 1 AND 40),
  plate_norm text NOT NULL,
  type text NOT NULL DEFAULT 'зерновоз' CHECK (type IN ('зерновоз', 'рефрижератор', 'тент', 'цистерна')),
  make_model text NULL CHECK (make_model IS NULL OR char_length(make_model) BETWEEN 1 AND 100),
  capacity_t numeric(6, 3) NULL CHECK (capacity_t IS NULL OR (capacity_t > 0 AND capacity_t <= 100)),
  volume_m3 numeric(7, 2) NULL CHECK (volume_m3 IS NULL OR (volume_m3 > 0 AND volume_m3 <= 200)),
  oscpv_on date NULL,
  kasko_on date NULL,
  green_card_on date NULL,
  inspection_on date NULL,
  tachograph_on date NULL,
  service_on date NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_trailers_plate_uidx ON public.fleet_trailers (org_id, plate_norm);
CREATE INDEX IF NOT EXISTS fleet_trailers_org_idx ON public.fleet_trailers (org_id, lower(plate));

ALTER TABLE public.fleet_trailers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fleet_trailers_select ON public.fleet_trailers;
CREATE POLICY fleet_trailers_select ON public.fleet_trailers
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

DROP POLICY IF EXISTS fleet_trailers_insert ON public.fleet_trailers;
CREATE POLICY fleet_trailers_insert ON public.fleet_trailers
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner());

-- Логіст оновлює лише ТТН-колонки: RLS пускає, а fleet_trailers_guard звужує до make_model / capacity_t / volume_m3.
DROP POLICY IF EXISTS fleet_trailers_update ON public.fleet_trailers;
CREATE POLICY fleet_trailers_update ON public.fleet_trailers
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND (public.is_org_owner() OR public.kp_can_write()))
  WITH CHECK (org_id = public.current_org_id() AND (public.is_org_owner() OR public.kp_can_write()));

DROP POLICY IF EXISTS fleet_trailers_delete ON public.fleet_trailers;
CREATE POLICY fleet_trailers_delete ON public.fleet_trailers
  FOR DELETE TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner());

-- Заблокований користувач нічого не пише (як в інших таблицях користувача, 20261016130000_user_block_rls).
DROP POLICY IF EXISTS fleet_trailers_not_blocked_insert ON public.fleet_trailers;
CREATE POLICY fleet_trailers_not_blocked_insert ON public.fleet_trailers AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT (SELECT public.is_user_blocked()));
DROP POLICY IF EXISTS fleet_trailers_not_blocked_update ON public.fleet_trailers;
CREATE POLICY fleet_trailers_not_blocked_update ON public.fleet_trailers AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT (SELECT public.is_user_blocked())) WITH CHECK (NOT (SELECT public.is_user_blocked()));
DROP POLICY IF EXISTS fleet_trailers_not_blocked_delete ON public.fleet_trailers;
CREATE POLICY fleet_trailers_not_blocked_delete ON public.fleet_trailers AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT (SELECT public.is_user_blocked()));

REVOKE ALL ON TABLE public.fleet_trailers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fleet_trailers TO authenticated;
GRANT ALL ON TABLE public.fleet_trailers TO service_role;

-- Guard: org_id завжди зі сесії, номер без службових символів і нормалізований, не більше 100 причепів на компанію.
-- Вкладені виклики (з тригера fleet_vehicles — дзеркало старої картки авто) і service_role проходять без перевірки ролі.
CREATE OR REPLACE FUNCTION public.fleet_trailers_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_ttn text[] := ARRAY['make_model', 'capacity_t', 'volume_m3', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.is_service_role() OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    IF NOT public.is_org_owner() OR OLD.org_id IS DISTINCT FROM public.current_org_id() THEN
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT (public.is_service_role() OR pg_trigger_depth() > 1) THEN
    IF NOT public.is_org_owner() THEN
      IF TG_OP = 'UPDATE'
         AND public.kp_can_write()
         AND OLD.org_id = public.current_org_id()
         AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
         AND (to_jsonb(NEW) - v_ttn) = (to_jsonb(OLD) - v_ttn) THEN
        NEW.updated_at := now();
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.org_id := public.current_org_id();
    IF NEW.org_id IS NULL THEN
      RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.plate := btrim(coalesce(NEW.plate, ''));
  IF char_length(NEW.plate) < 1 OR char_length(NEW.plate) > 40 OR NEW.plate ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'TRAILER_PLATE' USING ERRCODE = 'P0001';
  END IF;
  NEW.plate_norm := public.kp_plate_norm(NEW.plate);
  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_count FROM public.fleet_trailers WHERE org_id = NEW.org_id;
    IF v_count >= 100 THEN
      RAISE EXCEPTION 'FLEET_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_trailers_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_fleet_trailers_guard ON public.fleet_trailers;
CREATE TRIGGER trg_fleet_trailers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fleet_trailers
  FOR EACH ROW EXECUTE FUNCTION public.fleet_trailers_guard();

-- Причіп за замовчуванням тягача.
ALTER TABLE public.fleet_vehicles
  ADD COLUMN IF NOT EXISTS default_trailer_id uuid NULL REFERENCES public.fleet_trailers (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fleet_vehicles_trailer_idx ON public.fleet_vehicles (default_trailer_id) WHERE default_trailer_id IS NOT NULL;

-- Перенос даних (ідемпотентний): один причіп на org + нормалізований номер; тип, марка й написання номера — з найсвіжішого тягача (updated_at).
INSERT INTO public.fleet_trailers (org_id, plate, plate_norm, type, make_model)
SELECT DISTINCT ON (fv.org_id, public.kp_plate_norm(fv.trailer_plate))
       fv.org_id, btrim(fv.trailer_plate), public.kp_plate_norm(fv.trailer_plate), coalesce(fv.trailer_type, 'зерновоз'), fv.trailer_make_model
FROM public.fleet_vehicles AS fv
WHERE fv.trailer_plate IS NOT NULL AND btrim(fv.trailer_plate) <> '' AND public.kp_plate_norm(fv.trailer_plate) <> ''
ORDER BY fv.org_id, public.kp_plate_norm(fv.trailer_plate), fv.updated_at DESC, lower(fv.label)
ON CONFLICT (org_id, plate_norm) DO NOTHING;

UPDATE public.fleet_vehicles AS fv
SET default_trailer_id = ft.id
FROM public.fleet_trailers AS ft
WHERE fv.default_trailer_id IS NULL
  AND fv.trailer_plate IS NOT NULL
  AND ft.org_id = fv.org_id
  AND ft.plate_norm = public.kp_plate_norm(fv.trailer_plate);

-- Однаковий номер, тип і марка в усіх тягачів одного причепа (раніше могли розійтися).
UPDATE public.fleet_vehicles AS fv
SET trailer_plate = ft.plate, trailer_type = ft.type, trailer_make_model = ft.make_model
FROM public.fleet_trailers AS ft
WHERE fv.default_trailer_id = ft.id
  AND (fv.trailer_plate, fv.trailer_type, fv.trailer_make_model) IS DISTINCT FROM (ft.plate, ft.type, ft.make_model);

-- Тригер fleet_vehicles: зв'язок ↔ дзеркальні колонки (див. шапку).
CREATE OR REPLACE FUNCTION public.fleet_vehicles_trailer_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.fleet_trailers%ROWTYPE;
  v_norm text;
  v_nested boolean := pg_trigger_depth() > 1;  -- оновлення з fleet_trailers_after: дзеркало вже виставлене
BEGIN
  IF TG_OP = 'INSERT' OR NEW.default_trailer_id IS DISTINCT FROM OLD.default_trailer_id THEN
    IF NEW.default_trailer_id IS NOT NULL THEN
      SELECT * INTO t FROM public.fleet_trailers WHERE id = NEW.default_trailer_id AND org_id = NEW.org_id AND active;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'TRAILER_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
      NEW.trailer_plate := t.plate;
      NEW.trailer_type := t.type;
      NEW.trailer_make_model := t.make_model;
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' AND NEW.trailer_plate IS NOT DISTINCT FROM OLD.trailer_plate THEN
      -- «Відчепити»: зв'язок знято, дзеркало очищається.
      NEW.trailer_plate := NULL;
      NEW.trailer_make_model := NULL;
      RETURN NEW;
    END IF;
  END IF;

  -- Запис через стару картку авто (trailer_plate / trailer_type / trailer_make_model) → fleet_trailers.
  IF NOT v_nested AND ((TG_OP = 'INSERT' AND NEW.trailer_plate IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND (NEW.trailer_plate, NEW.trailer_type, NEW.trailer_make_model)
                              IS DISTINCT FROM (OLD.trailer_plate, OLD.trailer_type, OLD.trailer_make_model))) THEN
    IF NEW.trailer_plate IS NULL OR btrim(NEW.trailer_plate) = '' THEN
      NEW.trailer_plate := NULL;
      NEW.default_trailer_id := NULL;
      RETURN NEW;
    END IF;
    v_norm := public.kp_plate_norm(NEW.trailer_plate);
    SELECT * INTO t FROM public.fleet_trailers WHERE org_id = NEW.org_id AND plate_norm = v_norm;
    IF NOT FOUND AND NEW.default_trailer_id IS NOT NULL THEN
      -- Номер змінено в картці авто з прив'язаним причепом: перейменовуємо сам причіп (тягачі з ним оновляться нижче).
      SELECT * INTO t FROM public.fleet_trailers WHERE id = NEW.default_trailer_id AND org_id = NEW.org_id;
      IF FOUND THEN
        UPDATE public.fleet_trailers SET plate = btrim(NEW.trailer_plate) WHERE id = t.id;
      END IF;
    END IF;
    IF FOUND THEN
      UPDATE public.fleet_trailers
      SET type = coalesce(NEW.trailer_type, type), make_model = NEW.trailer_make_model, active = true
      WHERE id = t.id AND (type, make_model, active) IS DISTINCT FROM (coalesce(NEW.trailer_type, type), NEW.trailer_make_model, true);
    ELSE
      INSERT INTO public.fleet_trailers (org_id, plate, plate_norm, type, make_model)
      VALUES (NEW.org_id, NEW.trailer_plate, v_norm, coalesce(NEW.trailer_type, 'зерновоз'), NEW.trailer_make_model)
      RETURNING * INTO t;
    END IF;
    SELECT * INTO t FROM public.fleet_trailers WHERE id = t.id;
    IF t.make_model IS DISTINCT FROM NEW.trailer_make_model OR (NEW.trailer_type IS NOT NULL AND t.type <> NEW.trailer_type) THEN
      -- Тихого «успіху» без змін не буває.
      RAISE EXCEPTION 'TRAILER_SYNC_FAILED' USING ERRCODE = 'P0001';
    END IF;
    NEW.default_trailer_id := t.id;
    NEW.trailer_plate := t.plate;
    NEW.trailer_type := t.type;
    NEW.trailer_make_model := t.make_model;
    -- Той самий причіп в інших тягачах: однаковий номер, тип і марка (вкладений UPDATE не запускає цей шлях повторно).
    UPDATE public.fleet_vehicles
    SET trailer_plate = t.plate, trailer_type = t.type, trailer_make_model = t.make_model
    WHERE default_trailer_id = t.id AND org_id = NEW.org_id AND id <> NEW.id
      AND (trailer_plate, trailer_type, trailer_make_model) IS DISTINCT FROM (t.plate, t.type, t.make_model);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_vehicles_trailer_sync() FROM PUBLIC, anon, authenticated, service_role;

-- Ім'я сортується після trg_fleet_vehicles_guard (org_id вже виставлений guard-ом).
DROP TRIGGER IF EXISTS trg_fleet_vehicles_trailer_sync ON public.fleet_vehicles;
CREATE TRIGGER trg_fleet_vehicles_trailer_sync
  BEFORE INSERT OR UPDATE ON public.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.fleet_vehicles_trailer_sync();

-- Після зміни причепа: дзеркало у його тягачів; деактивація знімає причіп з усіх тягачів.
CREATE OR REPLACE FUNCTION public.fleet_trailers_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF NOT NEW.active THEN
    UPDATE public.fleet_vehicles SET default_trailer_id = NULL WHERE default_trailer_id = NEW.id;
  ELSE
    UPDATE public.fleet_vehicles
    SET trailer_plate = NEW.plate, trailer_type = NEW.type, trailer_make_model = NEW.make_model
    WHERE default_trailer_id = NEW.id
      AND (trailer_plate, trailer_type, trailer_make_model) IS DISTINCT FROM (NEW.plate, NEW.type, NEW.make_model);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fleet_trailers_after() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_fleet_trailers_after ON public.fleet_trailers;
CREATE TRIGGER trg_fleet_trailers_after
  AFTER UPDATE ON public.fleet_trailers
  FOR EACH ROW
  WHEN (OLD.plate IS DISTINCT FROM NEW.plate OR OLD.type IS DISTINCT FROM NEW.type
        OR OLD.make_model IS DISTINCT FROM NEW.make_model OR OLD.active IS DISTINCT FROM NEW.active)
  EXECUTE FUNCTION public.fleet_trailers_after();

-- Список причепів компанії з тягачем, до якого прив'язані (директор читає fleet_* лише через RPC — як kp_vehicles_list).
CREATE OR REPLACE FUNCTION public.kp_trailers_list()
RETURNS TABLE (
  id uuid, plate text, type text, make_model text, capacity_t numeric, volume_m3 numeric, active boolean,
  oscpv_on date, kasko_on date, green_card_on date, inspection_on date, tachograph_on date, service_on date,
  vehicle_ids uuid[], vehicle_labels text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY
  SELECT ft.id, ft.plate, ft.type, ft.make_model, ft.capacity_t, ft.volume_m3, ft.active,
         ft.oscpv_on, ft.kasko_on, ft.green_card_on, ft.inspection_on, ft.tachograph_on, ft.service_on,
         coalesce(array_agg(fv.id ORDER BY lower(fv.label)) FILTER (WHERE fv.id IS NOT NULL), ARRAY[]::uuid[]),
         coalesce(array_agg(fv.label ORDER BY lower(fv.label)) FILTER (WHERE fv.id IS NOT NULL), ARRAY[]::text[])
  FROM public.fleet_trailers AS ft
  LEFT JOIN public.fleet_vehicles AS fv ON fv.default_trailer_id = ft.id AND fv.org_id = v_org
  WHERE ft.org_id = v_org
  GROUP BY ft.id
  ORDER BY lower(ft.plate)
  LIMIT 1000;
END;
$$;

-- Лише ТТН-колонки причепа (owner / logist): марка, вантажопідйомність, обʼєм. Ключа немає — значення лишається; null / '' — очистити.
CREATE OR REPLACE FUNCTION public.kp_trailer_save(p_trailer uuid, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.fleet_trailers%ROWTYPE;
  v_make text;
  v_cap numeric;
  v_vol numeric;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'TRAILER_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_old FROM public.fleet_trailers WHERE id = p_trailer AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRAILER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_make := CASE WHEN p_data ? 'make_model' THEN public.kp_ttn_text(p_data ->> 'make_model', 100, 'make_model') ELSE v_old.make_model END;
  v_cap := CASE WHEN p_data ? 'capacity_t' THEN public.kp_ttn_num(p_data ->> 'capacity_t', 0, 100, 3, 'capacity_t', 'TRAILER_FIELD_INVALID') ELSE v_old.capacity_t END;
  v_vol := CASE WHEN p_data ? 'volume_m3' THEN public.kp_ttn_num(p_data ->> 'volume_m3', 0, 200, 2, 'volume_m3', 'TRAILER_FIELD_INVALID') ELSE v_old.volume_m3 END;
  UPDATE public.fleet_trailers SET make_model = v_make, capacity_t = v_cap, volume_m3 = v_vol WHERE id = p_trailer AND org_id = v_org;
  RETURN true;
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  REVOKE ALL ON FUNCTION public.kp_plate_norm(text) FROM PUBLIC, anon;
  FOREACH f IN ARRAY ARRAY['public.kp_trailers_list()', 'public.kp_trailer_save(uuid, jsonb)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END;
$$;

COMMIT;
