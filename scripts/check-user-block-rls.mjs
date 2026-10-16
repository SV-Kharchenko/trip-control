// Checks supabase/migrations/20261016130000_user_block_rls.sql on a real Postgres
// (PGlite, in memory). The schema below is a stub with the same kind of write
// policies as production; nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-user-block-rls.mjs
//
// Full pgTAP version against a Supabase database: supabase/tests/user_block.sql.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261016130000_user_block_rls.sql', import.meta.url), 'utf8');
const db = new PGlite();
const OWNER = '00000000-0000-0000-0000-0000000000b1';
const BLOCKED = '00000000-0000-0000-0000-0000000000b2';
const ORG = '30000000-0000-0000-0000-000000000001';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, banned_until timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, org_id uuid, role text DEFAULT 'user', is_approved boolean,
  org_role text, member_status text DEFAULT 'active', phone text);
CREATE TABLE public.calculations (id serial PRIMARY KEY, org_id uuid, user_id uuid, name text);
CREATE TABLE public.route_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, owner_user_id uuid,
  name text, scope text DEFAULT 'personal', params jsonb DEFAULT '{}', use_count int DEFAULT 0, last_used_at timestamptz);
CREATE TABLE public.fleet_vehicles (id serial PRIMARY KEY, org_id uuid, plate text);
CREATE TABLE public.extra_prod_table (id serial PRIMARY KEY, org_id uuid);

CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT org_id FROM public.profiles WHERE id = auth.uid() $$;
CREATE FUNCTION public.protect_profile_privileges() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role' THEN RETURN NEW; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.is_approved IS DISTINCT FROM OLD.is_approved THEN
    RAISE EXCEPTION 'profiles: privileged columns are server-managed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_protect_profile_privileges BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileges();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extra_prod_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_same_org ON public.profiles FOR SELECT TO authenticated USING (org_id = public.current_org_id());
CREATE POLICY profiles_update_own_safe ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() AND member_status = 'active') WITH CHECK (id = auth.uid() AND member_status = 'active');
CREATE POLICY calculations_select_role ON public.calculations FOR SELECT TO authenticated USING (org_id = public.current_org_id());
CREATE POLICY calculations_insert_role ON public.calculations FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND user_id = auth.uid());
CREATE POLICY calculations_update_role ON public.calculations FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id() AND user_id = auth.uid()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY calculations_delete_role ON public.calculations FOR DELETE TO authenticated
  USING (org_id = public.current_org_id() AND user_id = auth.uid());
CREATE POLICY route_templates_all ON public.route_templates FOR ALL TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY fleet_all ON public.fleet_vehicles FOR ALL TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY extra_all ON public.extra_prod_table FOR ALL TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

INSERT INTO public.organizations VALUES ('${ORG}', 'Block fixture');
INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${BLOCKED}');
INSERT INTO public.profiles (id, org_id, is_approved, org_role) VALUES ('${OWNER}', '${ORG}', true, 'owner'), ('${BLOCKED}', '${ORG}', true, 'logist');
INSERT INTO public.calculations (org_id, user_id, name) VALUES ('${ORG}', '${BLOCKED}', 'blocked user calc');
INSERT INTO public.route_templates (id, org_id, owner_user_id, name) VALUES ('40000000-0000-0000-0000-000000000001', '${ORG}', '${BLOCKED}', 'tpl');
`);

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

async function as(user, fn) {
    await db.exec('BEGIN');
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await db.exec('SET LOCAL ROLE authenticated');
    try { return await fn(); } finally { await db.exec('COMMIT'); }
}
async function tryQuery(sql, params) {
    try { const r = await db.query(sql, params); return { ok: true, affected: r.affectedRows, rows: r.rows }; }
    catch (e) { return { ok: false, code: e.code, message: e.message }; }
}
const sub = async (sql) => { await db.exec('SAVEPOINT s'); const r = await tryQuery(sql); await db.exec(r.ok ? 'RELEASE SAVEPOINT s' : 'ROLLBACK TO SAVEPOINT s'); return r; };

await db.exec(`UPDATE auth.users SET banned_until = now() + interval '876000 hours' WHERE id = '${BLOCKED}'`);

await as(OWNER, async () => {
    check('active: is_user_blocked() = false', (await db.query('SELECT public.is_user_blocked() AS b')).rows[0].b === false);
    const r = await sub(`INSERT INTO public.calculations (org_id, user_id, name) VALUES ('${ORG}', auth.uid(), 'active insert')`);
    check('active: INSERT calculations succeeds', r.ok, r);
    const f = await sub(`INSERT INTO public.fleet_vehicles (org_id, plate) VALUES ('${ORG}', 'AA0001BB')`);
    check('active: INSERT fleet_vehicles succeeds', f.ok, f);
    const p = await sub(`UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid()`);
    check('active: cannot set own role', !p.ok && p.code === '42501', p);
    const a = await sub(`UPDATE public.profiles SET is_approved = false WHERE id = auth.uid()`);
    check('active: cannot change own is_approved', !a.ok && a.code === '42501', a);
    const ph = await sub(`UPDATE public.profiles SET phone = '+380' WHERE id = auth.uid()`);
    check('active: can still edit own phone', ph.ok && ph.affected === 1, ph);
});

await as(BLOCKED, async () => {
    check('blocked: is_user_blocked() = true', (await db.query('SELECT public.is_user_blocked() AS b')).rows[0].b === true);
    const r = await sub(`INSERT INTO public.calculations (org_id, user_id, name) VALUES ('${ORG}', auth.uid(), 'blocked insert')`);
    check('blocked: INSERT calculations fails (42501)', !r.ok && r.code === '42501', r);
    const sel = await sub(`SELECT count(*)::int AS n FROM public.calculations WHERE user_id = auth.uid()`);
    check('blocked: SELECT still works', sel.ok && sel.rows[0].n === 1, sel);
    const u = await sub(`UPDATE public.calculations SET name = 'x' WHERE user_id = auth.uid()`);
    check('blocked: UPDATE calculations changes 0 rows', u.ok && u.affected === 0, u);
    const d = await sub(`DELETE FROM public.calculations WHERE user_id = auth.uid()`);
    check('blocked: DELETE calculations removes 0 rows', d.ok && d.affected === 0, d);
    const f = await sub(`INSERT INTO public.fleet_vehicles (org_id, plate) VALUES ('${ORG}', 'BB0002CC')`);
    check('blocked: INSERT fleet_vehicles fails', !f.ok && f.code === '42501', f);
    const x = await sub(`INSERT INTO public.extra_prod_table (org_id) VALUES ('${ORG}')`);
    check('blocked: table outside the list (found via pg_policies) fails', !x.ok && x.code === '42501', x);
    const p = await sub(`UPDATE public.profiles SET is_approved = false, role = 'admin' WHERE id = auth.uid()`);
    check('blocked: profile UPDATE changes 0 rows', p.ok && p.affected === 0, p);
    const t = await sub(`SELECT public.touch_route_template('40000000-0000-0000-0000-000000000001')`);
    check('blocked: touch_route_template() refused', !t.ok && /USER_BLOCKED/.test(t.message), t);
});

await db.exec(`UPDATE auth.users SET banned_until = NULL WHERE id = '${BLOCKED}'`);
await as(BLOCKED, async () => {
    const r = await sub(`INSERT INTO public.calculations (org_id, user_id, name) VALUES ('${ORG}', auth.uid(), 'after unblock')`);
    check('unblocked: INSERT calculations succeeds again', r.ok, r);
    const t = await sub(`SELECT public.touch_route_template('40000000-0000-0000-0000-000000000001') AS n`);
    check('unblocked: touch_route_template() works', t.ok && t.rows[0].n === 1, t);
});

const fnInfo = (await db.query(`SELECT p.prosecdef, p.provolatile, p.proconfig FROM pg_proc p WHERE p.proname = 'is_user_blocked'`)).rows[0];
check('is_user_blocked: SECURITY DEFINER, STABLE, fixed search_path', fnInfo.prosecdef && fnInfo.provolatile === 's' && String(fnInfo.proconfig).includes('search_path='), fnInfo);
const anon = (await db.query(`SELECT has_function_privilege('anon', 'public.is_user_blocked()', 'EXECUTE') AS a`)).rows[0].a;
check('is_user_blocked: anon cannot execute', anon === false);
const pols = (await db.query(`SELECT tablename, count(*)::int AS n FROM pg_policies WHERE policyname LIKE '%_not_blocked_%' GROUP BY 1 ORDER BY 1`)).rows;
check('restrictive policies per table (3 each, no duplicates after 2 runs)', pols.every((p) => p.n === 3), pols);

for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.pass ? '' : '  ' + JSON.stringify(r.detail)));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
