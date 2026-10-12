-- Supabase default privileges grant every table right to authenticated.
-- weekly_reports is a service-role delivery log. Owners may only read it.
-- Apply manually after review.

REVOKE ALL ON TABLE public.weekly_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.weekly_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_reports TO service_role;
