-- Контроль+: картка водія — телефон, паспорт (серія/номер), ІПН/РНОКПП, адреса. Це ПЕРСОНАЛЬНІ ДАНІ.
-- НЕ застосовувати на прод без дозволу власника проєкту.
--
-- Окрема таблиця поруч із kp_drivers, щоб ПІБ і посвідчення (єдині поля водія, що потрапляють у ТТН) читалися
-- як раніше, а нові поля НЕ потрапляли в жоден запит ТТН (kp_ttn_*, kp_driver_list їх не знають).
-- Доступ:
--   читати  — учасники своєї організації (RLS select: org_id = current_org_id(); RPC kp_driver_details_get — kp_docs_org('read'));
--   писати  — лише власник (RPC kp_driver_details_save — kp_docs_org('owner')); прямих INSERT / UPDATE / DELETE клієнтам немає.
-- Ідемпотентно.

CREATE TABLE IF NOT EXISTS public.kp_driver_details (
  driver_id uuid PRIMARY KEY REFERENCES public.kp_drivers (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  phone text NULL,
  passport text NULL,
  ipn text NULL,
  address text NULL,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_driver_details_phone CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{10,15}$'),
  CONSTRAINT kp_driver_details_passport CHECK (passport IS NULL OR passport ~ '^([A-ZА-ЯІЇЄҐ]{2}[0-9]{6}|[0-9]{9})$'),
  CONSTRAINT kp_driver_details_ipn CHECK (ipn IS NULL OR ipn ~ '^[0-9]{10}$'),
  CONSTRAINT kp_driver_details_address CHECK (address IS NULL OR (char_length(address) <= 300 AND address !~ '[[:cntrl:]]'))
);

CREATE INDEX IF NOT EXISTS kp_driver_details_org_idx ON public.kp_driver_details (org_id);

ALTER TABLE public.kp_driver_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kp_driver_details FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kp_driver_details TO authenticated;
GRANT ALL ON public.kp_driver_details TO service_role;

DROP POLICY IF EXISTS kp_driver_details_select ON public.kp_driver_details;
CREATE POLICY kp_driver_details_select ON public.kp_driver_details
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

-- Деталі водія (порожній рядок, якщо ще не заповнено). Читають усі ролі Контроль+ своєї організації.
CREATE OR REPLACE FUNCTION public.kp_driver_details_get(p_driver uuid)
RETURNS TABLE (phone text, passport text, ipn text, address text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.kp_drivers AS d WHERE d.id = p_driver AND d.org_id = v_org) THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT x.phone, x.passport, x.ipn, x.address FROM public.kp_driver_details AS x WHERE x.driver_id = p_driver AND x.org_id = v_org;
END;
$$;

-- Зберегти деталі водія. Лише власник. Порожнє значення очищає поле. ІПН — рівно 10 цифр.
CREATE OR REPLACE FUNCTION public.kp_driver_details_save(p_driver uuid, p_phone text, p_passport text, p_ipn text, p_address text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[\s()\-]', '', 'g'), '');
  v_passport text := nullif(upper(regexp_replace(coalesce(p_passport, ''), '\s', '', 'g')), '');
  v_ipn text := nullif(regexp_replace(coalesce(p_ipn, ''), '\s', '', 'g'), '');
  v_address text := nullif(regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g'), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.kp_drivers AS d WHERE d.id = p_driver AND d.org_id = v_org) THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^\+?[0-9]{10,15}$' THEN
    RAISE EXCEPTION 'DRIVER_BAD_PHONE' USING ERRCODE = 'P0001';
  END IF;
  IF v_passport IS NOT NULL AND v_passport !~ '^([A-ZА-ЯІЇЄҐ]{2}[0-9]{6}|[0-9]{9})$' THEN
    RAISE EXCEPTION 'DRIVER_BAD_PASSPORT' USING ERRCODE = 'P0001';
  END IF;
  IF v_ipn IS NOT NULL AND v_ipn !~ '^[0-9]{10}$' THEN
    RAISE EXCEPTION 'DRIVER_BAD_IPN' USING ERRCODE = 'P0001';
  END IF;
  IF v_address IS NOT NULL AND (char_length(v_address) > 300 OR v_address ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'DRIVER_BAD_ADDRESS' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.kp_driver_details AS x (driver_id, org_id, phone, passport, ipn, address, updated_by)
  VALUES (p_driver, v_org, v_phone, v_passport, v_ipn, v_address, auth.uid())
  ON CONFLICT (driver_id) DO UPDATE
  SET phone = excluded.phone, passport = excluded.passport, ipn = excluded.ipn, address = excluded.address,
      updated_by = excluded.updated_by, updated_at = now()
  WHERE x.org_id = v_org;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_driver_details_get(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_driver_details_get(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_driver_details_save(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_driver_details_save(uuid, text, text, text, text) TO authenticated, service_role;
