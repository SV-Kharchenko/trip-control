-- TRIP-CONTROL week-2: org company profile (PII) + admin CRM read + audit + helpers
-- Apply after week-1 migration. Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid() LIMIT 1),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Org company profile (ЄДРПОУ, телефон тощо) — окремо від operational company_settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_company_profiles (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  country text,
  edrpou text,
  ownership text,
  city text,
  address text,
  zip text,
  timezone text,
  phone text,
  website text,
  report_email text,
  lang text DEFAULT 'uk',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.org_company_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ocp_select_own ON public.org_company_profiles;
CREATE POLICY ocp_select_own ON public.org_company_profiles
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() OR public.is_platform_admin());

DROP POLICY IF EXISTS ocp_insert_own ON public.org_company_profiles;
CREATE POLICY ocp_insert_own ON public.org_company_profiles
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());

DROP POLICY IF EXISTS ocp_update_own ON public.org_company_profiles;
CREATE POLICY ocp_update_own ON public.org_company_profiles
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());

-- DELETE: немає політики для authenticated

-- ---------------------------------------------------------------------------
-- Security audit log (читає лише platform admin; пише trigger / service_role)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.security_audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor uuid,
  org_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  detail jsonb
);

CREATE INDEX IF NOT EXISTS security_audit_log_at_idx ON public.security_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS security_audit_log_org_idx ON public.security_audit_log (org_id);

ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_select_admin ON public.security_audit_log;
CREATE POLICY audit_select_admin ON public.security_audit_log
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

-- no INSERT/UPDATE/DELETE for authenticated — лише SECURITY DEFINER / service_role

CREATE OR REPLACE FUNCTION public.write_security_audit(
  p_action text,
  p_entity text,
  p_entity_id text,
  p_org_id uuid,
  p_detail jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.security_audit_log (actor, org_id, action, entity, entity_id, detail)
  VALUES (auth.uid(), p_org_id, p_action, p_entity, p_entity_id, p_detail);
END;
$$;

REVOKE ALL ON FUNCTION public.write_security_audit(text, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_security_audit(text, text, text, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.audit_org_company_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_by := auth.uid();
    NEW.updated_at := now();
    PERFORM public.write_security_audit(
      'insert', 'org_company_profiles', NEW.org_id::text, NEW.org_id,
      jsonb_build_object('edrpou', NEW.edrpou, 'phone', NEW.phone)
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.updated_by := auth.uid();
    NEW.updated_at := now();
    PERFORM public.write_security_audit(
      'update', 'org_company_profiles', NEW.org_id::text, NEW.org_id,
      jsonb_build_object(
        'old', jsonb_build_object(
          'edrpou', OLD.edrpou, 'phone', OLD.phone, 'report_email', OLD.report_email
        ),
        'new', jsonb_build_object(
          'edrpou', NEW.edrpou, 'phone', NEW.phone, 'report_email', NEW.report_email
        )
      )
    );
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_org_company_profiles ON public.org_company_profiles;
CREATE TRIGGER trg_audit_org_company_profiles
  BEFORE INSERT OR UPDATE ON public.org_company_profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_org_company_profiles();

-- ---------------------------------------------------------------------------
-- Backfill PII from company_settings.settings → org_company_profiles, then strip
-- ---------------------------------------------------------------------------

INSERT INTO public.org_company_profiles (
  org_id, country, edrpou, ownership, city, address, zip, timezone,
  phone, website, report_email, lang, updated_at
)
SELECT
  cs.org_id,
  nullif(cs.settings->>'coCountry', ''),
  nullif(cs.settings->>'coEdrpou', ''),
  nullif(cs.settings->>'coOwnership', ''),
  nullif(cs.settings->>'coCity', ''),
  nullif(cs.settings->>'coAddress', ''),
  nullif(cs.settings->>'coZip', ''),
  nullif(cs.settings->>'coTimezone', ''),
  nullif(cs.settings->>'coPhone', ''),
  nullif(cs.settings->>'coWebsite', ''),
  nullif(cs.settings->>'coReportEmail', ''),
  coalesce(nullif(cs.settings->>'coLang', ''), 'uk'),
  coalesce(cs.updated_at, now())
FROM public.company_settings cs
WHERE cs.settings ?| array[
  'coCountry','coEdrpou','coOwnership','coCity','coAddress','coZip',
  'coTimezone','coPhone','coWebsite','coReportEmail','coLang'
]
ON CONFLICT (org_id) DO NOTHING;

UPDATE public.company_settings
SET settings = settings
  - 'coCountry' - 'coEdrpou' - 'coOwnership' - 'coCity' - 'coAddress'
  - 'coZip' - 'coTimezone' - 'coPhone' - 'coWebsite' - 'coReportEmail' - 'coLang'
WHERE settings ?| array[
  'coCountry','coEdrpou','coOwnership','coCity','coAddress','coZip',
  'coTimezone','coPhone','coWebsite','coReportEmail','coLang'
];

-- ---------------------------------------------------------------------------
-- Admin CRM: SELECT інших profiles/orgs лише для platform admin
-- (власні політики week-1 лишаються; додаємо OR is_platform_admin)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_platform_admin());

DROP POLICY IF EXISTS organizations_select_own ON public.organizations;
CREATE POLICY organizations_select_own ON public.organizations
  FOR SELECT TO authenticated
  USING (id = public.current_org_id() OR public.is_platform_admin());

DROP POLICY IF EXISTS company_settings_select_own ON public.company_settings;
CREATE POLICY company_settings_select_own ON public.company_settings
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() OR public.is_platform_admin());
