-- «Історія рейсів»: the trip status could not be saved by anyone.
-- На проді в authenticated були лише права на name (UPDATE), виставлені поза міграціями.
--
-- On production the authenticated role has UPDATE on public.calculations for
-- the name column only (column grant set outside these migrations), so
-- PATCH {status} answers 403 «permission denied for table calculations» even
-- for the owner's own trips. Add the one column the UI writes; the table is
-- not opened further (org_id / user_id / inputs / results stay without UPDATE).
--
-- Who may change which row is still decided by RLS, unchanged here:
--   calculations_update_role       owner: any trip of the company; logist: own trips;
--   calculations_not_blocked_update blocked users cannot update at all;
--   trg_protect_calculation_ownership org_id / user_id stay immutable.
--
-- GRANT is idempotent. Safe to run more than once.

GRANT UPDATE (status) ON public.calculations TO authenticated;
