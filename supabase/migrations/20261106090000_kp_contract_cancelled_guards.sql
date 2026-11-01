-- Apply manually after review. This file is not applied to production by the agent.
-- Анульований договір (kp_contracts.status = 'cancelled', 20261105090000) не можна надіслати контрагенту: перевірка в
-- kp_contract_email_context (контекст листа) і в kp_mail_reserve (резервування відправки службовою роллю).
-- Підписання й завантаження скану вже відмовляють (CONTRACT_LOCKED: вони дозволені лише для чернетки).
-- Лише CREATE OR REPLACE двох функцій; тіла — з 20261030094515 (email_context) і 20261030081043 (mail_reserve) плюс одна перевірка.
--
-- РУЧНИЙ ВІДКАТ: повторно застосувати визначення kp_contract_email_context з 20261030094515_kp_mail_org_name.sql
-- і kp_mail_reserve з 20261030081043_kp_contracts.sql.

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
  IF v_c.status = 'cancelled' THEN
    RAISE EXCEPTION 'CONTRACT_CANCELLED' USING ERRCODE = 'P0001';
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
    'reply_to', v_reply, 'org_name', coalesce((SELECT nullif(btrim(r.legal_name), '') FROM public.kp_org_requisites AS r WHERE r.org_id = v_org),
      (SELECT nullif(btrim(o.name), '') FROM public.organizations AS o WHERE o.id = v_org)),
    'sender_id', auth.uid(), 'sender_role', public.kp_role());
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_mail_reserve(p_org uuid, p_doc_ids uuid[], p_sent_by uuid, p_to text, p_subject text, p_limit integer DEFAULT 20, p_contract_id uuid DEFAULT NULL)
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
  IF p_contract_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.kp_contracts AS c WHERE c.id = p_contract_id AND c.org_id = p_org) THEN
    RAISE EXCEPTION 'KP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_contract_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.kp_contracts AS c WHERE c.id = p_contract_id AND c.status = 'cancelled') THEN
    RAISE EXCEPTION 'CONTRACT_CANCELLED' USING ERRCODE = 'P0001';
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

REVOKE ALL ON FUNCTION public.kp_contract_email_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_email_context(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_mail_reserve(uuid, uuid[], uuid, text, text, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_mail_reserve(uuid, uuid[], uuid, text, text, integer, uuid) TO service_role;
