-- Apply manually after review. This file is not applied to production by the agent.
--
-- Контроль+: відправка актів і рахунків на пошту (Resend). Лист відправляє лише сервер (apps/kontrol-plus/api/docs/send.js).
--
-- * kp_doc_emails — лог відправок: кому, які документи, хто, коли, статус і помилка постачальника. Пише лише service_role
--   (API); читають учасники своєї організації (RLS). Рядок створюється зі статусом queued ДО відправки (так він враховується
--   в ліміті 20 листів на годину на організацію), потім стає sent або failed.
-- * kp_doc_email_context(doc) — єдина перевірка перед відправкою (SECURITY DEFINER від імені користувача): документ СВОЄЇ
--   організації (чужий → DOC_NOT_FOUND), роль owner/logist (kp_docs_org('write')), право «створювати акти» (member_require('acts')),
--   лише рахунок/акт, не анульований. Віддає документ, email контрагента, Reply-To (пошта для звітів організації або пошта
--   директора) і відправника.
-- * kp_doc_email_log(doc) — історія відправок документа для його картки.
-- * Сповіщення директору (org_notify): коли лист відправив ЛОГІСТ — kind doc_emailed (CHECK org_notifications розширено).
--
-- Лише адитивно, ідемпотентно, існуючі дані не змінюються. Після 20261031090000_director_cabinet.sql.
--
-- РУЧНИЙ ВІДКАТ (SQL editor):
--   DROP TRIGGER IF EXISTS trg_kp_doc_emails_notify ON public.kp_doc_emails;
--   DROP FUNCTION IF EXISTS public.kp_doc_emails_notify(), public.kp_doc_email_context(uuid), public.kp_doc_email_log(uuid), public.kp_doc_email_reserve(uuid, uuid[], uuid, text, text, integer), public.kp_is_org_member(uuid, uuid);
--   DROP TABLE IF EXISTS public.kp_doc_emails;
--   (УВАГА: повторний запуск ЦІЄЇ міграції після 20261102090000_kp_contracts.sql поверне старий kp_doc_emails_notify без гілки договорів —
--    після повторного запуску потрібно ще раз застосувати 20261102090000_kp_contracts.sql.)
--   DELETE FROM public.org_notifications WHERE kind = 'doc_emailed';
--   ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_kind_check;
--   ALTER TABLE public.org_notifications ADD CONSTRAINT org_notifications_kind_check CHECK (kind IN ('approval_pending', 'signature_used'));

CREATE TABLE IF NOT EXISTS public.kp_doc_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  doc_ids uuid[] NOT NULL CHECK (cardinality(doc_ids) BETWEEN 1 AND 5),
  sent_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  to_email text NOT NULL CHECK (char_length(to_email) BETWEEN 3 AND 254),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  provider_id text,
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS kp_doc_emails_org_created_idx ON public.kp_doc_emails (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kp_doc_emails_docs_idx ON public.kp_doc_emails USING gin (doc_ids);

ALTER TABLE public.kp_doc_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kp_doc_emails FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.kp_doc_emails TO authenticated;
GRANT ALL ON TABLE public.kp_doc_emails TO service_role;

DROP POLICY IF EXISTS kp_doc_emails_select ON public.kp_doc_emails;
CREATE POLICY kp_doc_emails_select ON public.kp_doc_emails
  FOR SELECT TO authenticated
  USING (org_id = public.kp_org_id());

-- Нові види сповіщень.
ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_kind_check;
ALTER TABLE public.org_notifications
  ADD CONSTRAINT org_notifications_kind_check CHECK (kind IN ('approval_pending', 'signature_used', 'doc_emailed'));

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
    PERFORM public.org_notify(NEW.org_id, 'doc_emailed', 'document', NEW.doc_ids[1], NEW.sent_by,
      jsonb_build_object('to', left(NEW.to_email, 120), 'count', cardinality(NEW.doc_ids)));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_doc_emails_notify() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_kp_doc_emails_notify ON public.kp_doc_emails;
CREATE TRIGGER trg_kp_doc_emails_notify
  AFTER UPDATE OF status ON public.kp_doc_emails
  FOR EACH ROW
  WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent')
  EXECUTE FUNCTION public.kp_doc_emails_notify();

-- Перевірка перед відправкою. Чужий документ → DOC_NOT_FOUND (сервер віддає 403), без права «акти» → MEMBER_PERMISSION_DENIED.
CREATE OR REPLACE FUNCTION public.kp_doc_email_context(p_doc uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_doc jsonb;
  v_client text;
  v_reply text;
BEGIN
  PERFORM public.member_require('acts');
  v_doc := public.kp_doc_get(p_doc);
  IF v_doc ->> 'kind' NOT IN ('invoice', 'act') THEN
    RAISE EXCEPTION 'DOC_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc ->> 'status' = 'cancelled' THEN
    RAISE EXCEPTION 'DOC_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  SELECT c.email INTO v_client FROM public.clients AS c WHERE c.id = (v_doc ->> 'client_id')::uuid AND c.org_id = v_org;
  v_reply := coalesce(
    nullif(btrim((SELECT cp.report_email FROM public.org_company_profiles AS cp WHERE cp.org_id = v_org)), ''),
    (SELECT p.email FROM public.profiles AS p
      WHERE p.org_id = v_org AND p.org_role = 'owner' AND p.member_status = 'active' ORDER BY p.created_at LIMIT 1));
  RETURN jsonb_build_object(
    'org_id', v_org,
    'doc', v_doc,
    'client_email', v_client,
    'reply_to', v_reply,
    'org_name', (SELECT r.legal_name FROM public.kp_org_requisites AS r WHERE r.org_id = v_org),
    'sender_id', auth.uid(),
    'sender_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = auth.uid()),
    'sender_role', public.kp_role());
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_doc_email_log(p_doc uuid)
RETURNS TABLE (id uuid, created_at timestamptz, finished_at timestamptz, to_email text, subject text, status text, error text,
               sender_email text, doc_count integer)
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
  SELECT e.id, e.created_at, e.finished_at, e.to_email, e.subject, e.status, e.error,
         (SELECT p.email FROM public.profiles AS p WHERE p.id = e.sent_by), cardinality(e.doc_ids)
  FROM public.kp_doc_emails AS e
  WHERE e.org_id = v_org AND p_doc = ANY (e.doc_ids)
  ORDER BY e.created_at DESC
  LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_doc_email_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_doc_email_log(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_doc_email_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_doc_email_log(uuid) TO authenticated, service_role;

-- Членство відправника в організації — та сама логіка, що в kp_org_id / kp_role: активний учасник своєї організації (profiles.org_id)
-- АБО директор цієї організації (org_directors, організація на control_plus). Лише service_role.
CREATE OR REPLACE FUNCTION public.kp_is_org_member(p_user uuid, p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND p_org IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = p_user AND p.org_id = p_org AND p.member_status = 'active')
    OR EXISTS (SELECT 1 FROM public.org_directors AS d WHERE d.user_id = p_user AND d.org_id = p_org AND public.org_has_plan(d.org_id, 'control_plus'))
  );
$$;

REVOKE ALL ON FUNCTION public.kp_is_org_member(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_is_org_member(uuid, uuid) TO service_role;

-- Ліміт без гонки: резервування рядка журналу й підрахунок за останню годину — в одній транзакції під advisory-замком організації
-- (pg_advisory_xact_lock). Паралельні запити стають у чергу на замку, тому 21-й лист за годину неможливий. Лише service_role
-- (API передає org з перевіреного kp_doc_email_context); відправник має бути учасником цієї організації.
CREATE OR REPLACE FUNCTION public.kp_doc_email_reserve(p_org uuid, p_doc_ids uuid[], p_sent_by uuid, p_to text, p_subject text, p_limit integer DEFAULT 20)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.kp_is_org_member(p_sent_by, p_org) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kp_doc_emails:' || p_org::text, 0));
  IF (SELECT count(*) FROM public.kp_doc_emails AS e WHERE e.org_id = p_org AND e.created_at >= now() - interval '1 hour') >= least(coalesce(p_limit, 20), 20) THEN
    RAISE EXCEPTION 'RATE_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.kp_doc_emails (org_id, doc_ids, sent_by, to_email, subject, status)
  VALUES (p_org, p_doc_ids, p_sent_by, p_to, p_subject, 'queued')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_doc_email_reserve(uuid, uuid[], uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_doc_email_reserve(uuid, uuid[], uuid, text, text, integer) TO service_role;
