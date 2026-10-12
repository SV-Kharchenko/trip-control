-- Weekly report delivery log. The letter itself is not stored.
-- Apply manually after review. This file is not applied to production by the agent.
-- Clients can read their own log. Only the service role inserts rows.

CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  recipient text,
  subject text,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error text,
  trip_count integer NOT NULL DEFAULT 0,
  planned_profit numeric,
  actual_profit numeric,
  alert_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_start)
);

CREATE INDEX IF NOT EXISTS weekly_reports_org_period_idx
  ON public.weekly_reports (org_id, period_start DESC);

ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weekly_reports_select_owner ON public.weekly_reports;
CREATE POLICY weekly_reports_select_owner ON public.weekly_reports
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND public.is_org_owner());

REVOKE ALL ON TABLE public.weekly_reports FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.weekly_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_reports TO service_role;
