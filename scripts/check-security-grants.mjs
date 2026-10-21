// Checks supabase/migrations/20261021090000_security_grants.sql on a real Postgres (PGlite, in memory):
// all migrations of the repo in order on top of a stub of the production base schema (tables that were
// created before the repo, Supabase roles and default privileges), then this migration, then the main
// scenarios as authenticated / anon: demo calculations and the save limit, owner + logist, route templates,
// company profile, payments. Nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-security-grants.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const DIR = new URL('../supabase/migrations/', import.meta.url);
const TARGET = '20261021090000_security_grants.sql';
const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const before = all.filter((f) => f < TARGET);
const migration = fs.readFileSync(process.argv[2] || new URL(TARGET, DIR), 'utf8');
const db = new PGlite();

// Production base schema before the repo (stub): Supabase roles, auth, default privileges that give
// anon / authenticated / service_role everything on new public objects, the first app tables and the
// functions that exist on production from SQL that is not in the repo.
await db.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb, banned_until timestamptz, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
  status text NOT NULL DEFAULT 'active', default_tax_mode text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.profiles (id uuid PRIMARY KEY, org_id uuid REFERENCES public.organizations (id), email text,
  role text NOT NULL DEFAULT 'user', is_approved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.company_settings (org_id uuid PRIMARY KEY REFERENCES public.organizations (id), settings jsonb,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.calculations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, org_id uuid, name text,
  inputs jsonb, results jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.usage_counters (org_id uuid NOT NULL, day date NOT NULL, calc_count integer NOT NULL DEFAULT 0);
CREATE TABLE public.trailer_presets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, name text);

-- Production-only functions (not in the repo); bodies are stand-ins.
CREATE FUNCTION public.my_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT org_id FROM public.profiles WHERE id = auth.uid() $$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT coalesce((SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()), false) $$;
CREATE FUNCTION public.enforce_demo_save_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS
  $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.ua_today() RETURNS date LANGUAGE sql STABLE AS
  $$ SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date $$;
-- An overload with arguments: the migration builds its signature with pg_get_function_identity_arguments().
CREATE FUNCTION public.ua_today(p_tz text) RETURNS date LANGUAGE sql STABLE AS
  $$ SELECT (now() AT TIME ZONE p_tz)::date $$;
`);

let failed = 0;
function check(ok, label) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed += 1;
}

for (const file of before) {
    try {
        await db.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
    } catch (error) {
        console.log('FAIL apply ' + file + ': ' + (error && error.message));
        process.exit(1);
    }
}
console.log('PASS all ' + before.length + ' earlier migrations applied');

// Guard: a database where a policy still uses a helper that is closed here — the migration stops and
// changes nothing. Checked on a copy (dump / restore is not available in PGlite, so the same steps again).
{
    const copy = new PGlite();
    const setup = fs.readFileSync(new URL(import.meta.url), 'utf8');
    const stub = setup.slice(setup.indexOf('CREATE ROLE anon NOLOGIN'), setup.indexOf('`);\n\nlet failed'));
    await copy.exec(stub);
    for (const file of before) await copy.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
    await copy.exec(`CREATE POLICY legacy_demo_select ON public.usage_counters FOR SELECT TO authenticated
      USING (public.current_is_approved() OR org_id = public.current_org_id())`);
    const res = await copy.exec(migration).then(() => ({ ok: true }), (error) => ({ ok: false, message: String(error.message) }));
    check(!res.ok && /current_is_approved\(\) is still used by: policy legacy_demo_select on public\.usage_counters/.test(res.message),
        'guard: a policy still using current_is_approved() stops the migration (' + (res.message || 'applied') + ')');
    const { rows } = await copy.query(`SELECT has_function_privilege('authenticated', 'public.current_org_role()', 'EXECUTE') AS role_ok,
      has_function_privilege('authenticated', 'public.audit_org_company_profiles()', 'EXECUTE') AS trg_ok`);
    check(rows[0].role_ok === true && rows[0].trg_ok === true, 'guard: nothing was changed before it stopped');
    // A SECURITY INVOKER function with arguments: named as schema.name(arguments).
    await copy.exec(`DROP POLICY legacy_demo_select ON public.usage_counters;
      CREATE FUNCTION public.legacy_role_of(p_user uuid, p_strict boolean) RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT public.current_org_role() $$;`);
    const invoker = await copy.exec(migration).then(() => ({ ok: true }), (error) => ({ ok: false, message: String(error.message) }));
    check(!invoker.ok && invoker.message.includes('current_org_role() is still used by: security invoker function public.legacy_role_of(p_user uuid, p_strict boolean)'),
        'guard: a security invoker function is named schema.name(arguments) (' + (invoker.message || 'applied') + ')');
}

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);
check(true, 'migration applied twice');

async function one(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}
// As a client role: claims like PostgREST sets them, SET ROLE, then back.
async function as(role, user, sql, params = []) {
    await db.exec('RESET ROLE');
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify(user ? { sub: user, role } : { role })]);
    await db.exec('SET ROLE ' + role);
    try {
        const { rows } = await db.query(sql, params);
        return { ok: true, rows };
    } catch (error) {
        return { ok: false, rows: [], code: error.code, message: String(error.message || error) };
    } finally {
        await db.exec('RESET ROLE');
        await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------
const can = async (role, fn) => (await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).ok;
for (const fn of ['public.audit_org_company_profiles()', 'public.calculations_enforce_owner_and_demo_limit()', 'public.enforce_demo_save_limit()']) {
    check(!(await can('anon', fn)) && !(await can('authenticated', fn)), 'a) ' + fn + ': no EXECUTE for anon / authenticated');
}
for (const fn of ['public.current_org_id()', 'public.is_org_owner()', 'public.is_platform_admin()', 'public.is_user_blocked()', 'public.org_logists_see_all()']) {
    check(!(await can('anon', fn)) && (await can('authenticated', fn)) && (await can('service_role', fn)),
        'b) ' + fn + ': kept for authenticated (RLS), closed for anon');
}
for (const fn of ['public.current_org_role()', 'public.current_is_approved()', 'public.is_admin()', 'public.my_org_id()']) {
    check(!(await can('anon', fn)) && !(await can('authenticated', fn)) && (await can('service_role', fn)),
        'b) ' + fn + ': closed for anon and authenticated, service_role keeps it');
}
check(!(await can('anon', 'public.touch_route_template(uuid)')) && (await can('authenticated', 'public.touch_route_template(uuid)')),
    'c) touch_route_template: authenticated only');
// PUBLIC (no explicit grant) does not sneak back in.
const publicAcl = await one(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
  aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
  WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    AND p.proname = ANY ($1)`, [['audit_org_company_profiles', 'calculations_enforce_owner_and_demo_limit', 'enforce_demo_save_limit',
    'current_org_id', 'current_org_role', 'current_is_approved', 'is_admin', 'is_org_owner', 'is_platform_admin', 'is_user_blocked',
    'my_org_id', 'org_logists_see_all', 'touch_route_template']]);
check(publicAcl.n === 0, 'no EXECUTE for PUBLIC on any of the listed functions');

// ---------------------------------------------------------------------------
// search_path
// ---------------------------------------------------------------------------
for (const fn of ['public.is_service_role()', 'public.tc_num(jsonb,text)', 'public.ua_today()', 'public.ua_today(text)', 'public.touch_route_template(uuid)']) {
    const row = await one(`SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [fn]);
    check(Array.isArray(row.proconfig) && row.proconfig.includes('search_path=""'), 'd) ' + fn + ': search_path = \'\'');
}
check((await one(`SELECT public.tc_num('{"dist": "120.5"}'::jsonb, 'dist') AS n`)).n === '120.5'
    && (await one(`SELECT public.tc_num('{"dist": "x"}'::jsonb, 'dist') AS n`)).n === null, 'd) tc_num works with search_path \'\'');
check((await one(`SELECT public.is_service_role() AS v`)).v === false, 'd) is_service_role works (false without claims)');
check((await as('service_role', null, `SELECT public.is_service_role() AS v`)).rows[0].v === true, 'd) is_service_role true for service_role');
check((await one(`SELECT public.ua_today() AS d`)).d instanceof Date, 'd) ua_today works with search_path \'\'');

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const ORG = '10000000-0000-4000-8000-000000000001';
const ORG_B = '10000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000001';
const LOGIST = '00000000-0000-4000-8000-000000000002';
const OWNER_B = '00000000-0000-4000-8000-000000000003';
const ADMIN = '00000000-0000-4000-8000-000000000004';
await db.exec(`
-- Test data straight in: the signup trigger (creates its own company and profile) stays off for it.
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'owner@agro.ua'), ('${LOGIST}', 'logist@agro.ua'),
  ('${OWNER_B}', 'boss@other.ua'), ('${ADMIN}', 'admin@trip-control.com');
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO public.organizations (id, name) VALUES ('${ORG}', 'Агро'), ('${ORG_B}', 'Інша');
INSERT INTO public.profiles (id, org_id, email, role, is_approved, org_role, member_status) VALUES
  ('${OWNER}', '${ORG}', 'owner@agro.ua', 'user', false, 'owner', 'active'),
  ('${LOGIST}', '${ORG}', 'logist@agro.ua', 'user', false, 'logist', 'active'),
  ('${OWNER_B}', '${ORG_B}', 'boss@other.ua', 'user', false, 'owner', 'active'),
  ('${ADMIN}', '${ORG_B}', 'admin@trip-control.com', 'admin', true, 'logist', 'active');
`);
const insertCalc = (user, dist) => as('authenticated', user,
    `INSERT INTO public.calculations (user_id, org_id, name, inputs, results) VALUES ($1, $2, 'Рейс', $3::jsonb, '{}'::jsonb) RETURNING id, distance_km`,
    [user, ORG, JSON.stringify({ dist: String(dist) })]);

// Demo: the save limit trigger (EXECUTE revoked) still fires; history trigger (tc_num, search_path '') fills columns.
const saved = [];
for (let i = 1; i <= 3; i += 1) saved.push(await insertCalc(OWNER, 100 + i));
check(saved.every((r) => r.ok), 'demo: owner saves 3 calculations (' + saved.map((r) => r.message || 'ok').join('; ') + ')');
check(saved[0].ok && Number(saved[0].rows[0].distance_km) === 101, 'demo: history trigger fills distance_km via tc_num');
const fourth = await insertCalc(OWNER, 104);
check(!fourth.ok && /DEMO_SAVE_LIMIT/.test(fourth.message), 'demo: the 4th save is refused by the demo limit (not a permission error): ' + fourth.message);

// 5 calculations a day in demo: bump_calc_usage through service_role (/api/calculate).
const bumps = [];
for (let i = 0; i < 6; i += 1) bumps.push((await as('service_role', null, `SELECT public.bump_calc_usage($1, 5) AS ok`, [ORG])).rows[0].ok);
check(JSON.stringify(bumps) === JSON.stringify([true, true, true, true, true, false]), 'demo: 5 calculations a day, the 6th refused (' + bumps + ')');
const usage = await as('authenticated', OWNER, `SELECT calc_count FROM public.usage_counters`);
check(usage.ok && usage.rows.length === 1 && usage.rows[0].calc_count === 5, 'demo: owner reads own usage counter (RLS with current_org_id)');

// Team: owner + logist.
// is_approved is server-managed (protect_profile_privileges lets only service_role change it).
await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
await db.exec(`UPDATE public.profiles SET is_approved = true WHERE id IN ('${OWNER}', '${LOGIST}')`);
await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
const logistCalc = await insertCalc(LOGIST, 300);
check(logistCalc.ok, 'team: logist saves a calculation (' + (logistCalc.message || 'ok') + ')');
const ownerSees = await as('authenticated', OWNER, `SELECT count(*)::int AS n FROM public.calculations`);
const logistSees = await as('authenticated', LOGIST, `SELECT count(*)::int AS n FROM public.calculations`);
check(ownerSees.ok && ownerSees.rows[0].n === 4, 'team: owner sees all 4 calculations of the company');
check(logistSees.ok && logistSees.rows[0].n === 1, 'team: logist sees only own (logists_see_all off)');
await db.exec(`INSERT INTO public.company_settings (org_id, settings) VALUES ('${ORG}', '{"logists_see_all": true}')
  ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`);
const logistAll = await as('authenticated', LOGIST, `SELECT count(*)::int AS n FROM public.calculations`);
check(logistAll.ok && logistAll.rows[0].n === 4, 'team: logist sees all with logists_see_all (org_logists_see_all in RLS)');
const team = await as('authenticated', OWNER, `SELECT id FROM public.profiles ORDER BY id`);
check(team.ok && team.rows.length === 2, 'team: owner sees both members of the company');
const otherCalcs = await as('authenticated', OWNER_B, `SELECT count(*)::int AS n FROM public.calculations`);
check(otherCalcs.ok && otherCalcs.rows[0].n === 0, 'team: another company sees none');
const settingsByLogist = await as('authenticated', LOGIST, `UPDATE public.company_settings SET settings = '{}'::jsonb RETURNING org_id`);
check(settingsByLogist.ok ? settingsByLogist.rows.length === 0 : settingsByLogist.code === '42501', 'team: logist cannot change company settings');

// Route templates.
const tpl = await as('authenticated', OWNER, `INSERT INTO public.route_templates (org_id, owner_user_id, scope, name, params)
  VALUES ($1, $2, 'company', 'Київ — Одеса', '{}'::jsonb) RETURNING id`, [ORG, OWNER]);
check(tpl.ok, 'templates: owner saves a company template (' + (tpl.message || 'ok') + ')');
const tplId = tpl.ok ? tpl.rows[0].id : null;
const touched = await as('authenticated', LOGIST, `SELECT public.touch_route_template($1) AS n`, [tplId]);
check(touched.ok && touched.rows[0].n === 1, 'templates: logist of the same company uses it (touch_route_template)');
const foreign = await as('authenticated', OWNER_B, `SELECT public.touch_route_template($1) AS n`, [tplId]);
check(!foreign.ok && /TEMPLATE_NOT_FOUND/.test(foreign.message), 'c) templates: another company cannot touch it (TEMPLATE_NOT_FOUND)');
const personal = await as('authenticated', OWNER, `INSERT INTO public.route_templates (org_id, owner_user_id, scope, name, params)
  VALUES ($1, $2, 'personal', 'Мій', '{}'::jsonb) RETURNING id`, [ORG, OWNER]);
const personalByLogist = await as('authenticated', LOGIST, `SELECT public.touch_route_template($1) AS n`, [personal.rows[0] && personal.rows[0].id]);
check(personal.ok && !personalByLogist.ok && /TEMPLATE_NOT_FOUND/.test(personalByLogist.message), 'c) templates: someone else\'s personal template — TEMPLATE_NOT_FOUND');
const anonTouch = await as('anon', null, `SELECT public.touch_route_template($1) AS n`, [tplId]);
check(!anonTouch.ok && anonTouch.code === '42501', 'c) templates: anon cannot call touch_route_template (42501)');
const count = await one(`SELECT use_count FROM public.route_templates WHERE id = $1`, [tplId]);
check(count.use_count === 1, 'c) templates: use_count changed only by the allowed call');

// Company profile: the audit trigger (EXECUTE revoked) still writes the log.
const ocp = await as('authenticated', OWNER, `INSERT INTO public.org_company_profiles (org_id, ownership, phone)
  VALUES ($1, 'fop', '+380000000000') ON CONFLICT (org_id) DO UPDATE SET phone = EXCLUDED.phone RETURNING org_id`, [ORG]);
check(ocp.ok, 'company profile: owner saves it (' + (ocp.message || 'ok') + ')');
const audit = await one(`SELECT count(*)::int AS n FROM public.security_audit_log WHERE org_id = $1`, [ORG]);
check(audit.n >= 1, 'company profile: audit trigger still writes security_audit_log');

// Payments: owner reads, logist does not; paid_until readable by members.
await db.exec(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, status, provider_order_id)
  VALUES ('${ORG}', '${OWNER}', 'wayforpay', 'month', 25000, 'pending', 'tc-check')`);
const payId = (await one(`SELECT id FROM public.payments WHERE provider_order_id = 'tc-check'`)).id;
const credited = await as('service_role', null, `SELECT public.apply_payment_success($1, null) AS r`, [payId]);
check(credited.ok && credited.rows[0].r.credited === true, 'payments: service_role credits (apply_payment_success)');
const ownerPays = await as('authenticated', OWNER, `SELECT status FROM public.payments`);
const logistPays = await as('authenticated', LOGIST, `SELECT status FROM public.payments`);
const paidUntil = await as('authenticated', LOGIST, `SELECT paid_until FROM public.org_subscriptions`);
check(ownerPays.ok && ownerPays.rows.length === 1 && ownerPays.rows[0].status === 'success', 'payments: owner sees the payment');
check(logistPays.ok && logistPays.rows.length === 0, 'payments: logist does not see payments');
check(paidUntil.ok && paidUntil.rows.length === 1 && paidUntil.rows[0].paid_until instanceof Date, 'payments: members read paid_until');

// Platform admin (CRM) still sees every company through RLS (is_platform_admin).
const adminOrgs = await as('authenticated', ADMIN, `SELECT count(*)::int AS n FROM public.organizations`);
check(adminOrgs.ok && adminOrgs.rows[0].n === 2, 'admin: platform admin sees all companies');

// Blocked user: write blocked by RLS (is_user_blocked), not by a function permission error.
await db.exec(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '${LOGIST}'`);
const blocked = await insertCalc(LOGIST, 1);
check(!blocked.ok && blocked.code === '42501' && /row-level security/.test(blocked.message), 'blocked user: insert refused by RLS (' + blocked.message + ')');
await db.exec(`UPDATE auth.users SET banned_until = null WHERE id = '${LOGIST}'`);

// Closed helpers are not callable by clients; kept ones are.
for (const fn of ['current_org_role', 'current_is_approved', 'is_admin', 'my_org_id']) {
    const res = await as('authenticated', OWNER, `SELECT public.${fn}()`);
    check(!res.ok && res.code === '42501', 'b) authenticated cannot call ' + fn + '() (42501)');
}
const kept = await as('authenticated', OWNER, `SELECT public.current_org_id() AS org`);
check(kept.ok && kept.rows[0].org === ORG, 'b) authenticated still calls current_org_id()');
for (const fn of ['current_org_id', 'is_org_owner', 'is_user_blocked']) {
    const res = await as('anon', null, `SELECT public.${fn}()`);
    check(!res.ok && res.code === '42501', 'b) anon cannot call ' + fn + '() (42501)');
}

if (failed) {
    console.log(failed + ' security grants check(s) failed');
    process.exit(1);
}
console.log('all security grants checks passed');
