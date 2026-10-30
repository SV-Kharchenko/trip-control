-- Apply manually after review. This file is not applied to production by the agent.
-- Назва організації для імені відправника листа: реквізити (legal_name), інакше organizations.name.
-- Лише CREATE OR REPLACE двох контекстних функцій пошти (#88 акти/рахунки, #89 договори); решта тіла без змін, дані не чіпаємо.
-- Порядок: після міграцій 20261101090000_kp_doc_email та 20261102090000_kp_contracts.
-- Manual rollback: повторно застосувати визначення kp_doc_email_context / kp_contract_email_context з тих двох міграцій.

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
    'org_name', coalesce((SELECT nullif(btrim(r.legal_name), '') FROM public.kp_org_requisites AS r WHERE r.org_id = v_org),
      (SELECT nullif(btrim(o.name), '') FROM public.organizations AS o WHERE o.id = v_org)),
    'sender_id', auth.uid(),
    'sender_email', (SELECT p.email FROM public.profiles AS p WHERE p.id = auth.uid()),
    'sender_role', public.kp_role());
END;
$$;

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
    'reply_to', v_reply, 'org_name', coalesce((SELECT nullif(btrim(r.legal_name), '') FROM public.kp_org_requisites AS r WHERE r.org_id = v_org),
      (SELECT nullif(btrim(o.name), '') FROM public.organizations AS o WHERE o.id = v_org)),
    'sender_id', auth.uid(), 'sender_role', public.kp_role());
END;
$$;

REVOKE ALL ON FUNCTION public.kp_doc_email_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_doc_email_context(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_contract_email_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_contract_email_context(uuid) TO authenticated, service_role;
