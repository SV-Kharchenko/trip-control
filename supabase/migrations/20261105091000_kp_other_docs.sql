-- Apply manually after review. This file is not applied to production by the agent.
-- Вкладка «Документи» → «Інше»: довільні файли (довіреності, страховки, скани) з необов'язковою прив'язкою до клієнта, авто,
-- водія чи заявки. Таблиця kp_other_docs (читають усі ролі організації; пише лише RPC), приватний бакет kp-other-docs
-- (10 МБ; PDF, JPG, PNG, Word, Excel), RLS storage за org_id у шляху: читають owner / logist / director, пишуть
-- kp_can_write(), видаляє лише власник. Анулювання — власник, з причиною; файл при цьому лишається.
--
-- РУЧНИЙ ВІДКАТ (видаляє всі «Інші» документи; файли бакета спершу видаліть через Storage API, не SQL):
--   DROP POLICY IF EXISTS kp_other_docs_storage_select ON storage.objects;  (так само _insert, _delete)
--   DROP FUNCTION IF EXISTS public.kp_other_list(date, date, text, uuid, text);
--   DROP FUNCTION IF EXISTS public.kp_other_save(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.kp_other_cancel(uuid, text);
--   DROP FUNCTION IF EXISTS public.kp_other_delete(uuid);
--   DROP TABLE IF EXISTS public.kp_other_docs;
--   DELETE FROM storage.buckets WHERE id = 'kp-other-docs';

CREATE TABLE IF NOT EXISTS public.kp_other_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('power_of_attorney', 'insurance', 'other')),
  client_id uuid REFERENCES public.clients (id) ON DELETE SET NULL,
  vehicle_id uuid REFERENCES public.fleet_vehicles (id) ON DELETE SET NULL,
  driver_id uuid REFERENCES public.kp_drivers (id) ON DELETE SET NULL,
  calculation_id uuid REFERENCES public.calculations (id) ON DELETE SET NULL,
  doc_date date NOT NULL CHECK (doc_date BETWEEN DATE '1991-01-01' AND DATE '2100-12-31'),
  valid_until date CHECK (valid_until IS NULL OR valid_until BETWEEN DATE '1991-01-01' AND DATE '2100-12-31'),
  file_path text NOT NULL,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_size integer NOT NULL CHECK (file_size BETWEEN 1 AND 10485760),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500),
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_other_docs_valid_range CHECK (valid_until IS NULL OR valid_until >= doc_date)
);

CREATE INDEX IF NOT EXISTS kp_other_docs_org_date_idx ON public.kp_other_docs (org_id, doc_date DESC);

ALTER TABLE public.kp_other_docs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kp_other_docs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.kp_other_docs TO authenticated;
GRANT ALL ON TABLE public.kp_other_docs TO service_role;

DROP POLICY IF EXISTS kp_other_docs_select ON public.kp_other_docs;
CREATE POLICY kp_other_docs_select ON public.kp_other_docs
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- ---------------------------------------------------------------------------
-- Storage: приватний бакет. Шлях <org>/<документ>/file-<uuid>.<ext>
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kp-other-docs', 'kp-other-docs', false, 10485760, ARRAY[
  'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 10485760,
      allowed_mime_types = ARRAY[
        'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

DROP POLICY IF EXISTS kp_other_docs_storage_select ON storage.objects;
CREATE POLICY kp_other_docs_storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'kp-other-docs'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/file-[0-9a-f-]{36}\.(pdf|jpg|png|doc|docx|xls|xlsx)$'
    AND split_part(name, '/', 1) = public.kp_org_id()::text
    AND coalesce(public.kp_role() IN ('owner', 'logist', 'director'), false)
  );

DROP POLICY IF EXISTS kp_other_docs_storage_insert ON storage.objects;
CREATE POLICY kp_other_docs_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'kp-other-docs'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/file-[0-9a-f-]{36}\.(pdf|jpg|png|doc|docx|xls|xlsx)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write()
  );

DROP POLICY IF EXISTS kp_other_docs_storage_delete ON storage.objects;
CREATE POLICY kp_other_docs_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'kp-other-docs'
    AND name ~ '/file-[0-9a-f-]{36}\.(pdf|jpg|png|doc|docx|xls|xlsx)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write()
    AND public.kp_role() = 'owner'
  );

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

-- Створення (рядка з p_id ще немає: файл уже в бакеті за шляхом <org>/<p_id>/file-<uuid>.<ext>) або зміна полів активного
-- документа (файл не змінюється). p_data: title, category, doc_date, valid_until, client_id, vehicle_id, driver_id,
-- calculation_id (порожній рядок / null — без прив'язки), file_path і file_name (лише при створенні).
CREATE OR REPLACE FUNCTION public.kp_other_save(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.kp_other_docs%ROWTYPE;
  v_title text;
  v_cat text;
  v_date date;
  v_valid date;
  v_client uuid;
  v_vehicle uuid;
  v_driver uuid;
  v_calc uuid;
  v_path text;
  v_size bigint;
BEGIN
  IF p_id IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'OTHER_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_old FROM public.kp_other_docs WHERE id = p_id FOR UPDATE;
  IF FOUND AND v_old.org_id <> v_org THEN
    RAISE EXCEPTION 'OTHER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF FOUND AND v_old.status <> 'active' THEN
    RAISE EXCEPTION 'OTHER_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  v_title := CASE WHEN p_data ? 'title' THEN nullif(btrim(p_data ->> 'title'), '') ELSE v_old.title END;
  v_cat := CASE WHEN p_data ? 'category' THEN nullif(p_data ->> 'category', '') ELSE coalesce(v_old.category, 'other') END;
  v_date := CASE WHEN p_data ? 'doc_date' THEN nullif(p_data ->> 'doc_date', '')::date ELSE v_old.doc_date END;
  v_valid := CASE WHEN p_data ? 'valid_until' THEN nullif(p_data ->> 'valid_until', '')::date ELSE v_old.valid_until END;
  v_client := CASE WHEN p_data ? 'client_id' THEN nullif(p_data ->> 'client_id', '')::uuid ELSE v_old.client_id END;
  v_vehicle := CASE WHEN p_data ? 'vehicle_id' THEN nullif(p_data ->> 'vehicle_id', '')::uuid ELSE v_old.vehicle_id END;
  v_driver := CASE WHEN p_data ? 'driver_id' THEN nullif(p_data ->> 'driver_id', '')::uuid ELSE v_old.driver_id END;
  v_calc := CASE WHEN p_data ? 'calculation_id' THEN nullif(p_data ->> 'calculation_id', '')::uuid ELSE v_old.calculation_id END;
  IF v_title IS NULL OR v_date IS NULL OR v_cat NOT IN ('power_of_attorney', 'insurance', 'other')
     OR (v_valid IS NOT NULL AND v_valid < v_date) THEN
    RAISE EXCEPTION 'OTHER_BAD' USING ERRCODE = 'P0001';
  END IF;
  IF (v_client IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clients AS x WHERE x.id = v_client AND x.org_id = v_org))
     OR (v_vehicle IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fleet_vehicles AS x WHERE x.id = v_vehicle AND x.org_id = v_org))
     OR (v_driver IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.kp_drivers AS x WHERE x.id = v_driver AND x.org_id = v_org))
     OR (v_calc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.calculations AS x WHERE x.id = v_calc AND x.org_id = v_org AND public.kp_trip_visible(x.user_id))) THEN
    RAISE EXCEPTION 'OTHER_LINK_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_old.id IS NULL THEN
    v_path := p_data ->> 'file_path';
    IF v_path IS NULL OR v_path !~ ('^' || v_org::text || '/' || p_id::text || '/file-[0-9a-f-]{36}\.(pdf|jpg|png|doc|docx|xls|xlsx)$') THEN
      RAISE EXCEPTION 'OTHER_FILE_BAD' USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce((o.metadata ->> 'size')::bigint, 0) INTO v_size
    FROM storage.objects AS o WHERE o.bucket_id = 'kp-other-docs' AND o.name = v_path;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OTHER_FILE_MISSING' USING ERRCODE = 'P0001';
    END IF;
    IF v_size > 10485760 THEN
      RAISE EXCEPTION 'OTHER_FILE_TOO_BIG' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.kp_other_docs (id, org_id, title, category, client_id, vehicle_id, driver_id, calculation_id, doc_date, valid_until,
                                      file_path, file_name, file_size, created_by)
    VALUES (p_id, v_org, v_title, v_cat, v_client, v_vehicle, v_driver, v_calc, v_date, v_valid,
            v_path, left(coalesce(nullif(btrim(p_data ->> 'file_name'), ''), 'файл'), 200), greatest(v_size, 1)::integer, auth.uid());
  ELSE
    UPDATE public.kp_other_docs
    SET title = v_title, category = v_cat, client_id = v_client, vehicle_id = v_vehicle, driver_id = v_driver,
        calculation_id = v_calc, doc_date = v_date, valid_until = v_valid, updated_at = now()
    WHERE id = p_id;
  END IF;
  RETURN p_id;
END;
$$;

-- Список: p_from / p_to за датою документа (необов'язково), p_category, p_client, p_status: active | expired | cancelled | NULL.
-- expired — активний документ, термін дії якого минув (київська дата); expiring_soon — лишилось ≤ 30 днів.
CREATE OR REPLACE FUNCTION public.kp_other_list(p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_category text DEFAULT NULL, p_client uuid DEFAULT NULL, p_status text DEFAULT NULL)
RETURNS TABLE (
  id uuid, title text, category text, client_id uuid, client_name text, vehicle_id uuid, vehicle_label text, driver_id uuid, driver_name text,
  calculation_id uuid, doc_date date, valid_until date, file_path text, file_name text, file_size integer, status text,
  cancelled_at timestamptz, cancel_reason text, expired boolean, expiring_soon boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
  v_today date := (now() AT TIME ZONE 'Europe/Kyiv')::date;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'OTHER_BAD_STATUS' USING ERRCODE = 'P0001';
  END IF;
  IF p_category IS NOT NULL AND p_category NOT IN ('power_of_attorney', 'insurance', 'other') THEN
    RAISE EXCEPTION 'OTHER_BAD' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT r.* FROM (
    SELECT d.id, d.title, d.category, d.client_id, cl.name AS client_name, d.vehicle_id, v.label AS vehicle_label, d.driver_id, dr.full_name AS driver_name,
           d.calculation_id, d.doc_date, d.valid_until, d.file_path, d.file_name, d.file_size, d.status, d.cancelled_at, d.cancel_reason,
           (d.status = 'active' AND d.valid_until IS NOT NULL AND d.valid_until < v_today) AS expired,
           (d.status = 'active' AND d.valid_until IS NOT NULL AND d.valid_until >= v_today AND d.valid_until <= v_today + 30) AS expiring_soon
    FROM public.kp_other_docs AS d
    LEFT JOIN public.clients AS cl ON cl.id = d.client_id
    LEFT JOIN public.fleet_vehicles AS v ON v.id = d.vehicle_id
    LEFT JOIN public.kp_drivers AS dr ON dr.id = d.driver_id
    WHERE d.org_id = v_org
      AND (p_from IS NULL OR d.doc_date >= p_from)
      AND (p_to IS NULL OR d.doc_date <= p_to)
      AND (p_category IS NULL OR d.category = p_category)
      AND (p_client IS NULL OR d.client_id = p_client)
  ) AS r
  WHERE p_status IS NULL
     OR (p_status = 'cancelled' AND r.status = 'cancelled')
     OR (p_status = 'expired' AND r.expired)
     OR (p_status = 'active' AND r.status = 'active' AND NOT r.expired)
  ORDER BY r.doc_date DESC, r.title;
END;
$$;

-- Анулювання з причиною — лише власник. Файл лишається в бакеті.
CREATE OR REPLACE FUNCTION public.kp_other_cancel(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'OTHER_REASON' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_other_docs
  SET status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason, cancelled_by = auth.uid(), updated_at = now()
  WHERE id = p_id AND org_id = v_org AND status = 'active';
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.kp_other_docs WHERE id = p_id AND org_id = v_org) THEN
      RAISE EXCEPTION 'OTHER_CANCELLED' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'OTHER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$$;

-- Видалення запису — лише власник; повертає шлях файлу, який клієнт тут же видаляє через Storage API (політика delete — лише власник).
CREATE OR REPLACE FUNCTION public.kp_other_delete(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_path text;
BEGIN
  DELETE FROM public.kp_other_docs WHERE id = p_id AND org_id = v_org RETURNING file_path INTO v_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OTHER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_path;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_other_save(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_other_list(date, date, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_other_cancel(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_other_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_other_save(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_other_list(date, date, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_other_cancel(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_other_delete(uuid) TO authenticated, service_role;
