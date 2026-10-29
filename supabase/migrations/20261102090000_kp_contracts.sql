-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: договори контрагентів — реєстр, скан у ПРИВАТНОМУ сховищі, підпис (зображення підпису й печатки АБО КЕП .p7s),
-- відправка контрагенту.
--
-- * kp_contracts — договір контрагента: номер, дата, предмет, строк, статус (draft / signed / sent), файл скану, підписана
--   копія (зображення підпису й печатки, формує сервер), відокремлений підпис CAdES .p7s. Клієнти таблицю не пишуть
--   (лише SELECT під RLS): усе через RPC з перевіркою організації, ролі й прав member_can('contracts') / ('sign').
-- * Бакет kp-contracts — приватний, 10 МБ, PDF / JPEG / PNG / .p7s. Шлях <org_id>/<contract_id>/<kind>-<uuid>.<ext>, kind:
--   scan (скан) і sig (.p7s) завантажує учасник із правом «Договори» (sig — ще й «Підпис і печатка»); signed (підписана
--   копія) пише лише сервер. RLS на storage.objects за org_id у шляху: читають учасники своєї організації, чужа організація
--   не бачить навіть існування файлу. Посилання на скачування — лише підписані URL (createSignedUrl) на 10 хв.
-- * kp_contract_attach / kp_contract_attach_sig — прив'язка вже завантаженого файлу (існує в бакеті, шлях своєї організації й
--   договору, розмір ≤ 10 МБ). Підписаний договір не міняється (CONTRACT_LOCKED).
-- * kp_contract_sign_context / kp_contract_set_signed / kp_contract_email_context — для серверних функцій (/api/contracts/*):
--   перевірка прав від імені користувача й запис результату службовою роллю. Підпис зображеннями = право «Підпис і печатка»
--   + сповіщення директору (як в актах).
-- * kp_doc_emails розширено полем contract_id: «Надіслати контрагенту» використовує той самий журнал і ліміт, що й акти.
--
-- Лише адитивно, ідемпотентно, існуючі дані не змінюються. Після 20261101090000_kp_doc_email.sql.
--
-- Тип файлу: MIME бакета — лише PDF / JPEG / PNG / .p7s (без application/octet-stream), а справжній тип (magic bytes) сервер
-- перевіряє сам: /api/contracts/sign {method: 'scan'} при додаванні скану, а також перед підписом печаткою й відправкою.
-- kp_mail_reserve — те саме резервування, що kp_doc_email_reserve (#88), але з p_contract_id: ліміт і журнал спільні з актами; API з цього
-- PR викликає саме її (стара залишається, service-only, без впливу).
--
-- РУЧНИЙ ВІДКАТ (SQL editor):
--   DROP FUNCTION IF EXISTS public.kp_mail_reserve(uuid, uuid[], uuid, text, text, integer, uuid), public.kp_contract_scan_context(uuid);
--   DROP FUNCTION IF EXISTS public.kp_contract_list(uuid), public.kp_contract_save(uuid, uuid, jsonb), public.kp_contract_attach(uuid, text, text),
--     public.kp_contract_attach_sig(uuid, text), public.kp_contract_sign_context(uuid), public.kp_contract_set_signed(uuid, uuid, text, text),
--     public.kp_contract_email_context(uuid), public.kp_contract_mark_sent(uuid);
--   DROP POLICY IF EXISTS kp_contracts_storage_select ON storage.objects;  (так само _insert, _delete)
--   DROP TABLE IF EXISTS public.kp_contracts;   -- спершу: ALTER TABLE public.kp_doc_emails DROP COLUMN IF EXISTS contract_id;
--   DELETE FROM storage.objects WHERE bucket_id = 'kp-contracts'; DELETE FROM storage.buckets WHERE id = 'kp-contracts';
--   DELETE FROM public.org_notifications WHERE ref_kind = 'contract';
--   ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_ref_kind_check;
--   ALTER TABLE public.org_notifications ADD CONSTRAINT org_notifications_ref_kind_check CHECK (ref_kind IN ('calculation', 'document', 'ttn'));

CREATE TABLE IF NOT EXISTS public.kp_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  number text NOT NULL CHECK (char_length(btrim(number)) BETWEEN 1 AND 100),
  contract_date date NOT NULL CHECK (contract_date BETWEEN DATE '1991-01-01' AND DATE '2100-12-31'),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 500),
  valid_until date CHECK (valid_until IS NULL OR valid_until BETWEEN DATE '1991-01-01' AND DATE '2100-12-31'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed', 'sent')),
  file_path text,
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 200),
  file_size integer CHECK (file_size IS NULL OR file_size BETWEEN 1 AND 10485760),
  signed_path text,
  signed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  signed_at timestamptz,
  sign_method text CHECK (sign_method IS NULL OR sign_method IN ('image', 'kep')),
  sig_path text,
  sent_at timestamptz,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_contracts_valid_range CHECK (valid_until IS NULL OR valid_until >= contract_date)
);

CREATE INDEX IF NOT EXISTS kp_contracts_org_client_idx ON public.kp_contracts (org_id, client_id, contract_date DESC);

ALTER TABLE public.kp_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kp_contracts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.kp_contracts TO authenticated;
GRANT ALL ON TABLE public.kp_contracts TO service_role;

DROP POLICY IF EXISTS kp_contracts_select ON public.kp_contracts;
CREATE POLICY kp_contracts_select ON public.kp_contracts
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- Сповіщення: договір як об'єкт.
ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_ref_kind_check;
ALTER TABLE public.org_notifications
  ADD CONSTRAINT org_notifications_ref_kind_check CHECK (ref_kind IN ('calculation', 'document', 'ttn', 'contract'));

-- Журнал пошти: лист може нести договір замість рахунків / актів.
ALTER TABLE public.kp_doc_emails ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES public.kp_contracts (id) ON DELETE SET NULL;
ALTER TABLE public.kp_doc_emails DROP CONSTRAINT IF EXISTS kp_doc_emails_doc_ids_check;
ALTER TABLE public.kp_doc_emails
  ADD CONSTRAINT kp_doc_emails_doc_ids_check CHECK (cardinality(doc_ids) BETWEEN 0 AND 5 AND (cardinality(doc_ids) > 0 OR contract_id IS NOT NULL));

CREATE OR REPLACE FUNCTION public.kp_doc_emails_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT p.org_role INTO v_role FROM public.profiles AS p WHERE p.id = NEW.sent_by;
  IF v_role = 'logist' THEN
    IF NEW.contract_id IS NOT NULL THEN
      PERFORM public.org_notify(NEW.org_id, 'doc_emailed', 'contract', NEW.contract_id, NEW.sent_by,
        jsonb_build_object('to', left(NEW.to_email, 120), 'count', 1, 'doc_kind', 'contract',
          'client_id', (SELECT c.client_id FROM public.kp_contracts AS c WHERE c.id = NEW.contract_id)));
    ELSE
      PERFORM public.org_notify(NEW.org_id, 'doc_emailed', 'document', NEW.doc_ids[1], NEW.sent_by,
        jsonb_build_object('to', left(NEW.to_email, 120), 'count', cardinality(NEW.doc_ids)));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_doc_emails_notify() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage: приватний бакет
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kp-contracts', 'kp-contracts', false, 10485760, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'application/pkcs7-signature'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 10485760,
      allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png', 'application/pkcs7-signature'];

-- <org>/<contract>/<scan|sig|signed>-<uuid>.<ext>. Читають учасники своєї організації; пишуть scan і sig (не signed) учасники з
-- правом «Договори» (sig — і «Підпис і печатка»); signed пише лише сервер. Оновлення файлів немає: заміна = новий файл.
DROP POLICY IF EXISTS kp_contracts_storage_select ON storage.objects;
CREATE POLICY kp_contracts_storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'kp-contracts'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(scan|sig|signed)-[0-9a-f-]{36}\.(pdf|jpg|png|p7s)$'
    AND split_part(name, '/', 1) = public.kp_org_id()::text
    AND coalesce(public.kp_role() IN ('owner', 'logist', 'director'), false)
  );

DROP POLICY IF EXISTS kp_contracts_storage_insert ON storage.objects;
CREATE POLICY kp_contracts_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'kp-contracts'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(scan-[0-9a-f-]{36}\.(pdf|jpg|png)|sig-[0-9a-f-]{36}\.p7s)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write()
    AND public.member_can('contracts')
    AND (name !~ '/sig-' OR public.member_can('sign'))
    AND EXISTS (SELECT 1 FROM public.kp_contracts AS c
                WHERE c.id::text = split_part(name, '/', 2) AND c.org_id = public.current_org_id())
  );

DROP POLICY IF EXISTS kp_contracts_storage_delete ON storage.objects;
CREATE POLICY kp_contracts_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'kp-contracts'
    AND name ~ '/(scan|sig)-[0-9a-f-]{36}\.(pdf|jpg|png|p7s)$'
    AND split_part(name, '/', 1) = public.current_org_id()::text
    AND public.kp_can_write()
    AND public.member_can('contracts')
    AND EXISTS (SELECT 1 FROM public.kp_contracts AS c
                WHERE c.id::text = split_part(name, '/', 2) AND c.org_id = public.current_org_id() AND c.status = 'draft')
  );

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kp_contract_list(p_client uuid)
RETURNS SETOF public.kp_contracts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY
  SELECT c.* FROM public.kp_contracts AS c
  WHERE c.org_id = v_org AND c.client_id = p_client
  ORDER BY c.contract_date DESC, c.created_at DESC;
END;
$$;

-- Створити (p_id NULL) або змінити договір. Змінювати можна, лише поки він чернетка. p_data: number, contract_date, subject, valid_until.
CREATE OR REPLACE FUNCTION public.kp_contract_save(p_id uuid, p_client uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.kp_contracts%ROWTYPE;
  v_number text;
  v_date date;
  v_subject text;
  v_valid date;
  v_id uuid;
BEGIN
  PERFORM public.member_require('contracts');
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'CONTRACT_BAD' USING ERRCODE = 'P0001';
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.kp_contracts WHERE id = p_id AND org_id = v_org FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONTRACT_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF v_old.status <> 'draft' THEN
      RAISE EXCEPTION 'CONTRACT_LOCKED' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.clients AS cl WHERE cl.id = p_client AND cl.org_id = v_org) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_number := CASE WHEN p_data ? 'number' THEN nullif(btrim(p_data ->> 'number'), '') ELSE v_old.number END;
  v_date := CASE WHEN p_data ? 'contract_date' THEN nullif(p_data ->> 'contract_date', '')::date ELSE v_old.contract_date END;
  v_subject := CASE WHEN p_data ? 'subject' THEN nullif(btrim(p_data ->> 'subject'), '') ELSE v_old.subject END;
  v_valid := CASE WHEN p_data ? 'valid_until' THEN nullif(p_data ->> 'valid_until', '')::date ELSE v_old.valid_until END;
  IF v_number IS NULL OR v_date IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_BAD' USING ERRCODE = 'P0001';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.kp_contracts (org_id, client_id, number, contract_date, subject, valid_until, created_by)
    VALUES (v_org, p_client, v_number, v_date, v_subject, v_valid, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.kp_contracts SET number = v_number, contract_date = v_date, subject = v_subject, valid_until = v_valid, updated_at = now()
    WHERE id = p_id;
    v_id := p_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Файл скану, уже завантажений у бакет: шлях <org>/<contract>/scan-<uuid>.(pdf|jpg|png), розмір ≤ 10 МБ.
CREATE OR REPLACE FUNCTION public.kp_contract_attach(p_id uuid, p_path text, p_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.kp_contracts%ROWTYPE;
  v_size bigint;
BEGIN
  PERFORM public.member_require('contracts');
  SELECT * INTO v_old FROM public.kp_contracts WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTRACT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_old.status <> 'draft' THEN
    RAISE EXCEPTION 'CONTRACT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  IF p_path IS NULL OR p_path !~ ('^' || v_org::text || '/' || p_id::text || '/scan-[0-9a-f-]{36}\.(pdf|jpg|png)$') THEN
    RAISE EXCEPTION 'CONTRACT_FILE_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce((o.metadata ->> 'size')::bigint, 0) INTO v_size
  FROM storage.objects AS o WHERE o.bucket_id = 'kp-contracts' AND o.name = p_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTRACT_FILE_MISSING' USING ERRCODE = 'P0001';
  END IF;
  IF v_size > 10485760 THEN
    RAISE EXCEPTION 'CONTRACT_FILE_TOO_BIG' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_contracts
  SET file_path = p_path, file_name = left(coalesce(nullif(btrim(p_name), ''), 'договір'), 200), file_size = nullif(v_size, 0)::integer, updated_at = now()
  WHERE id = p_id;
  RETURN true;
END;
$$;

-- Відокремлений підпис CAdES (.p7s) до скану: право «Договори» І «Підпис і печатка». Структуру .p7s перевіряє /api/contracts/sign.
CREATE OR REPLACE FUNCTION public.kp_contract_attach_sig(p_id uuid, p_path text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_old public.kp_contracts%ROWTYPE;
  v_size bigint;
BEGIN
  PERFORM public.member_require('contracts');
  PERFORM public.member_require('sign');
  SELECT * INTO v_old FROM public.kp_contracts WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTRACT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_old.status <> 'draft' OR v_old.file_path IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  IF p_path IS NULL OR p_path !~ ('^' || v_org::text || '/' || p_id::text || '/sig-[0-9a-f-]{36}\.p7s$') THEN
    RAISE EXCEPTION 'CONTRACT_FILE_BAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce((o.metadata ->> 'size')::bigint, 0) INTO v_size
  FROM storage.objects AS o WHERE o.bucket_id = 'kp-contracts' AND o.name = p_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTRACT_FILE_MISSING' USING ERRCODE = 'P0001';
  END IF;
  IF v_size > 1048576 THEN
    RAISE EXCEPTION 'CONTRACT_FILE_TOO_BIG' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_contracts
  SET sig_path = p_path, status = 'signed', sign_method = 'kep', signed_by = auth.uid(), signed_at = now(), updated_at = now()
  WHERE id = p_id;
  IF public.kp_role() = 'logist' THEN
    PERFORM public.org_notify(v_org, 'signature_used', 'contract', p_id, auth.uid(),
      jsonb_build_object('doc_kind', 'contract', 'number', left(v_old.number, 100), 'method', 'kep', 'client_id', v_old.client_id));
  END IF;
  RETURN true;
END;
$$;

-- Для /api/contracts/sign (зображення підпису й печатки): права від імені користувача, дані для рендера.
CREATE OR REPLACE FUNCTION public.kp_contract_sign_context(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_c public.kp_contracts%ROWTYPE;
  v_req public.kp_org_requisites%ROWTYPE;
BEGIN
  PERFORM public.member_require('contracts');
  PERFORM public.member_require('sign');
  SELECT * INTO v_c FROM public.kp_contracts WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTRACT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_c.status <> 'draft' THEN
    RAISE EXCEPTION 'CONTRACT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  IF v_c.file_path IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_FILE_MISSING' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.kp_org_requisites WHERE org_id = v_org;
  RETURN jsonb_build_object('org_id', v_org, 'contract_id', v_c.id, 'file_path', v_c.file_path, 'number', v_c.number,
    'client_id', v_c.client_id, 'signature_path', v_req.signature_path, 'stamp_path', v_req.stamp_path,
    'sender_id', auth.uid(), 'sender_role', public.kp_role());
END;
$$;

-- Для /api/contracts/sign {method: 'scan'}: права «Договори» від імені користувача й організація ДО читання файлу службовою роллю.
CREATE OR REPLACE FUNCTION public.kp_contract_scan_context(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_c public.kp_contracts%ROWTYPE;
BEGIN
  PERFORM public.member_require('contracts');
  SELECT * INTO v_c FROM public.kp_contracts WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTRACT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_c.status <> 'draft' THEN
    RAISE EXCEPTION 'CONTRACT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('org_id', v_org, 'contract_id', v_c.id);
END;
$$;

-- Журнал з урахуванням договору: те саме резервування під замком організації, що й у 20261101090000, але з contract_id. Окрема назва, щоб
-- повторне застосування попередньої міграції не створювало неоднозначного перевантаження.
CREATE OR REPLACE FUNCTION public.kp_mail_reserve(p_org uuid, p_doc_ids uuid[], p_sent_by uuid, p_to text, p_subject text, p_limit integer DEFAULT 20, p_contract_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = p_sent_by AND p.org_id = p_org) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_contract_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.kp_contracts AS c WHERE c.id = p_contract_id AND c.org_id = p_org) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kp_doc_emails:' || p_org::text, 0));
  IF (SELECT count(*) FROM public.kp_doc_emails AS e WHERE e.org_id = p_org AND e.created_at >= now() - interval '1 hour') >= least(coalesce(p_limit, 20), 20) THEN
    RAISE EXCEPTION 'RATE_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.kp_doc_emails (org_id, doc_ids, contract_id, sent_by, to_email, subject, status)
  VALUES (p_org, coalesce(p_doc_ids, ARRAY[]::uuid[]), p_contract_id, p_sent_by, p_to, p_subject, 'queued')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Службова: записати підписану копію (лише service_role). p_user — хто підписав (з перевіреного JWT).
CREATE OR REPLACE FUNCTION public.kp_contract_set_signed(p_id uuid, p_user uuid, p_path text, p_method text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_c public.kp_contracts%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO v_c FROM public.kp_contracts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_c.status <> 'draft' THEN
    RAISE EXCEPTION 'CONTRACT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  IF p_method <> 'image' OR p_path IS NULL OR p_path !~ ('^' || v_c.org_id::text || '/' || p_id::text || '/signed-[0-9a-f-]{36}\.pdf$') THEN
    RAISE EXCEPTION 'CONTRACT_FILE_BAD' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.kp_contracts
  SET signed_path = p_path, status = 'signed', sign_method = 'image', signed_by = p_user, signed_at = now(), updated_at = now()
  WHERE id = p_id;
  SELECT p.org_role INTO v_role FROM public.profiles AS p WHERE p.id = p_user;
  IF v_role = 'logist' THEN
    PERFORM public.org_notify(v_c.org_id, 'signature_used', 'contract', p_id, p_user,
      jsonb_build_object('doc_kind', 'contract', 'number', left(v_c.number, 100), 'method', 'image', 'client_id', v_c.client_id));
  END IF;
  RETURN true;
END;
$$;

-- Для відправки контрагенту: права «Договори» від імені користувача; віддає файли для вкладення.
CREATE OR REPLACE FUNCTION public.kp_contract_email_context(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_c public.kp_contracts%ROWTYPE;
  v_client text;
  v_name text;
  v_reply text;
BEGIN
  PERFORM public.member_require('contracts');
  SELECT * INTO v_c FROM public.kp_contracts WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_c.file_path IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_FILE_MISSING' USING ERRCODE = 'P0001';
  END IF;
  SELECT cl.email, cl.name INTO v_client, v_name FROM public.clients AS cl WHERE cl.id = v_c.client_id AND cl.org_id = v_org;
  v_reply := coalesce(
    nullif(btrim((SELECT cp.report_email FROM public.org_company_profiles AS cp WHERE cp.org_id = v_org)), ''),
    (SELECT p.email FROM public.profiles AS p
      WHERE p.org_id = v_org AND p.org_role = 'owner' AND p.member_status = 'active' ORDER BY p.created_at LIMIT 1));
  RETURN jsonb_build_object('org_id', v_org, 'contract', to_jsonb(v_c), 'client_email', v_client, 'client_name', v_name,
    'reply_to', v_reply, 'org_name', (SELECT r.legal_name FROM public.kp_org_requisites AS r WHERE r.org_id = v_org),
    'sender_id', auth.uid(), 'sender_role', public.kp_role());
END;
$$;

-- Службова: після успішного листа договір стає «надіслано» (підписаний або чернетка лишаються з позначкою sent_at).
CREATE OR REPLACE FUNCTION public.kp_contract_mark_sent(p_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.kp_contracts SET status = CASE WHEN status = 'signed' THEN 'sent' ELSE status END, sent_at = now(), updated_at = now()
  WHERE id = p_id RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.kp_contract_list(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_save(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_attach(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_attach_sig(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_sign_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_email_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_set_signed(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_mark_sent(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_scan_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_mail_reserve(uuid, uuid[], uuid, text, text, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_list(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_save(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_attach(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_attach_sig(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_sign_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_email_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_set_signed(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_mark_sent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_scan_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_mail_reserve(uuid, uuid[], uuid, text, text, integer, uuid) TO service_role;
