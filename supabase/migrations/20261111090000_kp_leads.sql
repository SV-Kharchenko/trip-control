-- Apply manually after review. This file is not applied to production by the agent.
-- Заявки «Замовити демо» з лендингу /kontrol-plus (POST /api/kp-lead). Таблиця закрита від клієнтів повністю: RLS увімкнено
-- без жодної політики, гранти лише service_role (запис робить серверний код Vercel). У ip_hash — SHA-256 від IP, сирої адреси немає.
--
-- РУЧНИЙ ВІДКАТ:
--   DROP TABLE IF EXISTS public.kp_leads;

CREATE TABLE IF NOT EXISTS public.kp_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  company text NOT NULL CHECK (char_length(btrim(company)) BETWEEN 1 AND 160),
  phone text NOT NULL CHECK (char_length(btrim(phone)) BETWEEN 5 AND 40),
  email text CHECK (email IS NULL OR char_length(email) <= 160),
  vehicles integer CHECK (vehicles IS NULL OR vehicles BETWEEN 1 AND 100000),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'won', 'lost', 'spam')),
  ip_hash text
);

CREATE INDEX IF NOT EXISTS kp_leads_created_idx ON public.kp_leads (created_at DESC);

ALTER TABLE public.kp_leads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kp_leads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.kp_leads TO service_role;
