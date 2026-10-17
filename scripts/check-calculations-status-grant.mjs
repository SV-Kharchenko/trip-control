// Checks supabase/migrations/20261017120000_calculations_status_grant.sql on a real
// Postgres (PGlite, in memory). public.calculations gets the production grants
// for authenticated (SELECT, INSERT, DELETE + UPDATE (name) only) and the same
// RLS as production; nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-calculations-status-grant.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261017120000_calculations_status_grant.sql', import.meta.url), 'utf8');
const db = new PGlite();
const ORG = '70000000-0000-0000-0000-000000000001';
const OTHER_ORG = '70000000-0000-0000-0000-000000000002';
const OWNER = '00000000-0000-0000-0000-0000000000d1';
const LOGIST = '00000000-0000-0000-0000-0000000000d2';
const MATE = '00000000-0000-0000-0000-0000000000d3';
const BLOCKED = '00000000-0000-0000-0000-0000000000d4';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, banned_until timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, org_id uuid, org_role text, member_status text DEFAULT 'active');
CREATE TABLE public.company_settings (org_id uuid PRIMARY KEY, settings jsonb);
CREATE TABLE public.calculations (
  id serial PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, name text,
  inputs jsonb, results jsonb, created_at timestamptz DEFAULT now(),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'accepted', 'rejected', 'done')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.is_service_role() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role' $$;
CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT org_id FROM public.profiles WHERE id = auth.uid() AND member_status = 'active' $$;
CREATE FUNCTION public.is_org_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND org_role = 'owner' AND member_status = 'active') $$;
CREATE FUNCTION public.org_logists_see_all() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT coalesce((SELECT (settings ->> 'logists_see_all')::boolean FROM public.company_settings
       WHERE org_id = public.current_org_id()), false) $$;
CREATE FUNCTION public.is_user_blocked() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT coalesce((SELECT u.banned_until IS NOT NULL AND u.banned_until > now() FROM auth.users AS u WHERE u.id = auth.uid()), false) $$;
GRANT EXECUTE ON FUNCTION public.current_org_id(), public.is_org_owner(), public.org_logists_see_all(),
  public.is_user_blocked(), public.is_service_role() TO authenticated;

-- 20261012114133_org_roles.sql
CREATE FUNCTION public.protect_calculation_ownership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_service_role() AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'CALCULATION_OWNERSHIP_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_protect_calculation_ownership BEFORE UPDATE OF org_id, user_id ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.protect_calculation_ownership();
-- Stand-in for trg_calculations_fill_history (20261012200000): fires on status, writes other columns.
CREATE FUNCTION public.calculations_fill_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_calculations_fill_history BEFORE INSERT OR UPDATE OF inputs, results, status ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_fill_history();

-- 20261012161314_owner_logist_team_hardening.sql
ALTER TABLE public.calculations ENABLE ROW LEVEL SECURITY;
CREATE POLICY calculations_select_role ON public.calculations FOR SELECT TO authenticated
  USING (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid() OR public.org_logists_see_all()));
CREATE POLICY calculations_insert_role ON public.calculations FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND user_id = auth.uid());
CREATE POLICY calculations_update_role ON public.calculations FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid()))
  WITH CHECK (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid()));
CREATE POLICY calculations_delete_role ON public.calculations FOR DELETE TO authenticated
  USING (org_id = public.current_org_id() AND (public.is_org_owner() OR user_id = auth.uid()));
-- 20261016130000_user_block_rls.sql
CREATE POLICY calculations_not_blocked_update ON public.calculations AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT (SELECT public.is_user_blocked())) WITH CHECK (NOT (SELECT public.is_user_blocked()));

-- Production grants for authenticated on calculations: ard + UPDATE (name).
GRANT SELECT, INSERT, DELETE ON public.calculations TO authenticated;
GRANT UPDATE (name) ON public.calculations TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

INSERT INTO public.organizations VALUES ('${ORG}', 'Status fixture'), ('${OTHER_ORG}', 'Other');
INSERT INTO auth.users (id, banned_until) VALUES ('${OWNER}', null), ('${LOGIST}', null), ('${MATE}', null),
  ('${BLOCKED}', now() + interval '1 day');
INSERT INTO public.profiles (id, org_id, org_role) VALUES ('${OWNER}', '${ORG}', 'owner'), ('${LOGIST}', '${ORG}', 'logist'),
  ('${MATE}', '${ORG}', 'logist'), ('${BLOCKED}', '${ORG}', 'logist');
INSERT INTO public.company_settings VALUES ('${ORG}', '{"logists_see_all": false}');
INSERT INTO public.calculations (id, org_id, user_id, name) VALUES
  (1, '${ORG}', '${LOGIST}', 'logist trip'),
  (2, '${ORG}', '${MATE}', 'mate trip'),
  (3, '${ORG}', '${BLOCKED}', 'blocked trip'),
  (4, '${ORG}', '${OWNER}', 'owner trip');
`);

let failed = 0;
function check(ok, label) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed += 1;
}

// One statement as a signed-in user (PostgREST: role authenticated + JWT claims).
async function as(user, sql, params = []) {
    await db.exec('RESET ROLE');
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await db.exec('SET ROLE authenticated');
    try {
        const { rows } = await db.query(sql, params);
        return { ok: true, rows };
    } catch (error) {
        return { ok: false, rows: [], message: String(error.message || error), code: error.code };
    } finally {
        await db.exec('RESET ROLE');
    }
}
const setStatus = (user, id, status) => as(user, 'UPDATE public.calculations SET status = $2 WHERE id = $1 RETURNING id', [id, status]);
async function statusOf(id) {
    const { rows } = await db.query('SELECT status, org_id, user_id FROM public.calculations WHERE id = $1', [id]);
    return rows[0];
}

// Before: the production bug.
{
    const res = await setStatus(OWNER, 4, 'accepted');
    check(!res.ok && /permission denied for table calculations/.test(res.message) && res.code === '42501',
        'before migration: owner status PATCH is 42501 permission denied for table calculations');
}

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);

{
    const res = await setStatus(OWNER, 1, 'accepted');
    check(res.ok && res.rows.length === 1 && (await statusOf(1)).status === 'accepted', 'owner changes the status of a logist trip');
}
{
    const res = await setStatus(OWNER, 4, 'done');
    check(res.ok && res.rows.length === 1 && (await statusOf(4)).status === 'done', 'owner changes the status of an own trip');
}
{
    const res = await setStatus(LOGIST, 1, 'done');
    check(res.ok && res.rows.length === 1 && (await statusOf(1)).status === 'done', 'logist changes the status of an own trip');
}
{
    const res = await setStatus(LOGIST, 2, 'rejected');
    check(res.ok && res.rows.length === 0 && (await statusOf(2)).status === 'draft', 'logist cannot change another logist trip (0 rows)');
}
{
    await db.exec(`UPDATE public.company_settings SET settings = '{"logists_see_all": true}' WHERE org_id = '${ORG}'`);
    const seen = await as(LOGIST, 'SELECT id FROM public.calculations WHERE id = 2');
    const res = await setStatus(LOGIST, 2, 'rejected');
    check(seen.rows.length === 1 && res.ok && res.rows.length === 0 && (await statusOf(2)).status === 'draft',
        'logists_see_all: logist sees another trip but still cannot change it (0 rows)');
    await db.exec(`UPDATE public.company_settings SET settings = '{"logists_see_all": false}' WHERE org_id = '${ORG}'`);
}
{
    const res = await setStatus(BLOCKED, 3, 'done');
    check(res.ok && res.rows.length === 0 && (await statusOf(3)).status === 'draft', 'blocked user cannot change an own trip (0 rows)');
}
{
    const res = await setStatus(OWNER, 1, 'archived');
    check(!res.ok && /calculations_status_check|check constraint/.test(res.message), 'unknown status is still rejected by the check constraint');
}
{
    const org = await as(OWNER, `UPDATE public.calculations SET org_id = '${OTHER_ORG}' WHERE id = 4 RETURNING id`);
    const user = await as(OWNER, `UPDATE public.calculations SET user_id = '${LOGIST}' WHERE id = 4 RETURNING id`);
    const row = await statusOf(4);
    check(!org.ok && org.code === '42501' && !user.ok && user.code === '42501' && row.org_id === ORG && row.user_id === OWNER,
        'org_id / user_id still cannot be changed (42501)');
}
{
    const results = await as(OWNER, `UPDATE public.calculations SET results = '{}'::jsonb WHERE id = 4 RETURNING id`);
    const name = await as(OWNER, `UPDATE public.calculations SET name = 'renamed' WHERE id = 4 RETURNING id`);
    check(!results.ok && results.code === '42501' && name.ok && name.rows.length === 1,
        'table not opened: results still denied, name still allowed');
}
{
    const { rows } = await db.query(`SELECT privilege_type, column_name FROM information_schema.column_privileges
        WHERE table_name = 'calculations' AND grantee = 'authenticated' AND privilege_type = 'UPDATE' ORDER BY column_name`);
    check(rows.map((r) => r.column_name).join(',') === 'name,status', 'authenticated UPDATE columns: name, status');
}

if (failed) {
    console.log(failed + ' check(s) failed');
    process.exit(1);
}
console.log('all calculations status checks passed');
