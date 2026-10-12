-- Supabase can grant EXECUTE directly to API roles through default
-- privileges. Revoking from PUBLIC alone does not remove those grants.

REVOKE ALL ON FUNCTION public.current_org_id() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_org_role() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_org_owner() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_org_admin() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.org_logists_see_all() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_org_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_owner() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.org_logists_see_all() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.protect_profile_privileges() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.protect_last_active_owner() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.protect_org_privileges() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.protect_company_settings_privileges() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.protect_calculation_ownership() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.handle_new_tripcontrol_user() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_logists_visibility(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accept_org_invite(text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.set_logists_visibility(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text, uuid, text) TO service_role;
