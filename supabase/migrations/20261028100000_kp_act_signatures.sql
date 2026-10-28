-- Контроль+: статус акта «Підписано» (підписав директор/власник). НЕ застосовувати на прод без дозволу власника проєкту.
--
-- kp_documents незмінні (тригер kp_documents_guard), тому підпис — окрема таблиця, один рядок на акт. Прямого доступу
-- клієнтів немає (RLS без політик), усе через функції нижче. Підписує лише власник компанії (kp_docs_org('owner')),
-- читати підписані можуть усі ролі Контроль+ своєї організації. Ідемпотентно.

CREATE TABLE IF NOT EXISTS public.kp_document_signatures (
  doc_id uuid PRIMARY KEY REFERENCES public.kp_documents (id) ON DELETE RESTRICT,
  org_id uuid NOT NULL,
  signed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  signed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kp_document_signatures_org_idx ON public.kp_document_signatures (org_id);

ALTER TABLE public.kp_document_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kp_document_signatures FROM PUBLIC, anon, authenticated;

-- Підписати / зняти підпис з акта. Лише власник; лише акт зі статусом issued (анульований не підписується).
CREATE OR REPLACE FUNCTION public.kp_doc_sign(p_doc uuid, p_signed boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('owner');
  v_doc public.kp_documents%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM public.kp_documents WHERE id = p_doc AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOC_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc.kind <> 'act' THEN
    RAISE EXCEPTION 'DOC_SIGN_ACT_ONLY' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc.status = 'cancelled' THEN
    RAISE EXCEPTION 'DOC_ALREADY_CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_signed, true) THEN
    INSERT INTO public.kp_document_signatures (doc_id, org_id, signed_by)
    VALUES (p_doc, v_org, auth.uid())
    ON CONFLICT (doc_id) DO NOTHING;
  ELSE
    DELETE FROM public.kp_document_signatures WHERE doc_id = p_doc AND org_id = v_org;
  END IF;
  RETURN COALESCE(p_signed, true);
END;
$$;

-- Які з переданих документів підписані (для списку й картки).
CREATE OR REPLACE FUNCTION public.kp_doc_signed(p_ids uuid[])
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  RETURN QUERY
  SELECT s.doc_id FROM public.kp_document_signatures AS s
  WHERE s.org_id = v_org AND s.doc_id = ANY (COALESCE(p_ids, ARRAY[]::uuid[]));
END;
$$;

REVOKE ALL ON FUNCTION public.kp_doc_sign(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_doc_sign(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_doc_signed(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_doc_signed(uuid[]) TO authenticated, service_role;
