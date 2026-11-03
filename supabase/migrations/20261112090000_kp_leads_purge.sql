-- Apply manually after review. This file is not applied to production by the agent.
-- Автовидалення заявок «Замовити демо» (kp_leads) старших за 1 рік (строк зберігання з /privacy). Викликається щоденним
-- cron (/api/billing/cron) через service_role; клієнтам (PUBLIC, anon, authenticated) виконання закрите.
--
-- РУЧНИЙ ВІДКАТ:
--   DROP FUNCTION IF EXISTS public.purge_old_kp_leads();

CREATE OR REPLACE FUNCTION public.purge_old_kp_leads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.kp_leads WHERE created_at < now() - interval '1 year';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_old_kp_leads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_kp_leads() TO service_role;
