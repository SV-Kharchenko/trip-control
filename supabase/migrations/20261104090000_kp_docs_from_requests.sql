-- Apply manually after review. This file is not applied to production by the agent.
-- Документи з прийнятої заявки (ТТН, акт, рахунок, подорожній лист): список прийнятих заявок для вибору «На основі заявки»,
-- документи, створені з заявки, і захист на сервері: рядок рахунку / акта може посилатися лише на ПРИЙНЯТУ заявку своєї організації.
-- Зв'язок «документ ↔ заявка» вже зберігається: kp_doc_ttn.calculation_id, kp_doc_trip_sheet.calculation_id, kp_document_lines.calculation_id
-- (рахунок / акт) — нових колонок і даних не потрібно, існуючі дані не чіпаємо.
--
-- 1. kp_calc_accepted_list(p_q): прийняті (accepted | done) заявки своєї організації, видимі користувачу, із клієнтом; пошук за назвою,
--    маршрутом і клієнтом. Право «документи» на запис (як kp_calc_doc_prefill).
-- 2. kp_calc_documents(p_calculation): ТТН, подорожні листи, акти й рахунки цієї заявки (номер, дата, статус). Чужа заявка — DOC_TRIP_FORBIDDEN.
-- 3. Тригер kp_document_lines_calc_accepted: рядок документа з calculation_id вимагає заявку цієї ж організації зі статусом accepted | done,
--    інакше CALC_NOT_ACCEPTED. (ТТН і подорожній лист це вже перевіряють: kp_doc_ttn_calc_accepted, kp_trip_sheet_create.)
--
-- РУЧНИЙ ВІДКАТ (існуючі дані не змінюються):
--   DROP TRIGGER IF EXISTS trg_kp_document_lines_calc_accepted ON public.kp_document_lines;
--   DROP FUNCTION IF EXISTS public.kp_document_lines_calc_accepted();
--   DROP FUNCTION IF EXISTS public.kp_calc_documents(uuid);
--   DROP FUNCTION IF EXISTS public.kp_calc_accepted_list(text);

BEGIN;

CREATE OR REPLACE FUNCTION public.kp_calc_accepted_list(p_q text DEFAULT NULL)
RETURNS TABLE (
  calculation_id uuid, name text, trip_date date, route_from text, route_to text, status text, client_id uuid, client_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('write');
  v_q text := lower(nullif(btrim(coalesce(p_q, '')), ''));
BEGIN
  RETURN QUERY
  SELECT c.id, c.name, c.trip_date, c.route_from, c.route_to, c.status, cl.id, cl.name
  FROM public.calculations AS c
  LEFT JOIN LATERAL (
    SELECT k.id, k.name FROM public.calculation_clients AS cc
    JOIN public.clients AS k ON k.id = cc.client_id AND k.org_id = v_org
    WHERE cc.calculation_id = c.id ORDER BY k.name LIMIT 1
  ) AS cl ON true
  WHERE c.org_id = v_org
    AND c.status IN ('accepted', 'done')
    AND public.kp_trip_visible(c.user_id)
    AND (v_q IS NULL
         OR position(v_q IN lower(coalesce(c.name, ''))) > 0
         OR position(v_q IN lower(coalesce(c.route_from, '') || ' ' || coalesce(c.route_to, ''))) > 0
         OR position(v_q IN lower(coalesce(cl.name, ''))) > 0)
  ORDER BY c.trip_date DESC NULLS LAST, c.created_at DESC
  LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.kp_calc_documents(p_calculation uuid)
RETURNS TABLE (kind text, id uuid, number_text text, doc_date date, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := public.kp_docs_org('read');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.calculations AS c WHERE c.id = p_calculation AND c.org_id = v_org AND public.kp_trip_visible(c.user_id)
  ) THEN
    RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT d.kind, d.id, d.number_text, d.doc_date, d.status FROM (
    SELECT 'ttn'::text AS kind, t.id AS id, coalesce(t.prefix, '') || t.number::text AS number_text, t.doc_date AS doc_date, t.status AS status
      FROM public.kp_doc_ttn AS t WHERE t.org_id = v_org AND t.calculation_id = p_calculation
    UNION ALL
    SELECT 'trip_sheet'::text, s.id, coalesce(s.prefix, '') || s.number::text, s.doc_date, s.status
      FROM public.kp_doc_trip_sheet AS s WHERE s.org_id = v_org AND s.calculation_id = p_calculation
    UNION ALL
    SELECT x.kind, x.id, coalesce(x.prefix, '') || x.number::text, x.doc_date, x.status
      FROM public.kp_documents AS x
      WHERE x.org_id = v_org AND x.kind IN ('invoice', 'act')
        AND EXISTS (SELECT 1 FROM public.kp_document_lines AS l WHERE l.doc_id = x.id AND l.calculation_id = p_calculation)
  ) AS d
  ORDER BY d.doc_date DESC, d.kind, d.number_text;
END;
$$;

-- Рядок рахунку / акта посилається лише на прийняту заявку своєї організації.
CREATE OR REPLACE FUNCTION public.kp_document_lines_calc_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.calculation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calculations AS c
    WHERE c.id = NEW.calculation_id AND c.org_id = NEW.org_id AND c.status IN ('accepted', 'done')
  ) THEN
    RAISE EXCEPTION 'CALC_NOT_ACCEPTED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.kp_document_lines_calc_accepted() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_kp_document_lines_calc_accepted ON public.kp_document_lines;
CREATE TRIGGER trg_kp_document_lines_calc_accepted
  BEFORE INSERT ON public.kp_document_lines
  FOR EACH ROW EXECUTE FUNCTION public.kp_document_lines_calc_accepted();

REVOKE ALL ON FUNCTION public.kp_calc_accepted_list(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_calc_documents(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_calc_accepted_list(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_calc_documents(uuid) TO authenticated, service_role;

COMMIT;
