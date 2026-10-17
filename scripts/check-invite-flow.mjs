// Checks supabase/migrations/20261017090000_invite_flow.sql on a real Postgres
// (PGlite, in memory). The schema below is a stub of the production tables the
// function touches; nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-invite-flow.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261017090000_invite_flow.sql', import.meta.url), 'utf8');
const db = new PGlite();
const TEAM = '50000000-0000-0000-0000-000000000001';
const OWNER = '00000000-0000-0000-0000-0000000000c1';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION public.is_service_role() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text, status text DEFAULT 'active', work_mode text DEFAULT 'solo');
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, org_id uuid REFERENCES public.organizations(id),
  org_role text, member_status text DEFAULT 'active');
CREATE TABLE public.company_settings (org_id uuid PRIMARY KEY REFERENCES public.organizations(id), settings jsonb);
CREATE TABLE public.usage_counters (org_id uuid REFERENCES public.organizations(id), day date, calc_count int);
CREATE TABLE public.calculations (id serial PRIMARY KEY, org_id uuid REFERENCES public.organizations(id), user_id uuid);
CREATE TABLE public.fleet_vehicles (id serial PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE, label text);
CREATE TABLE public.route_templates (id serial PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE);
CREATE TABLE public.org_company_profiles (org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  edrpou text, ownership text, phone text, lang text DEFAULT 'uk', updated_at timestamptz DEFAULT now(), updated_by uuid);
CREATE TABLE public.org_invites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE, email text NOT NULL,
  org_role text NOT NULL DEFAULT 'logist', token_hash text NOT NULL UNIQUE, invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.security_audit_log (id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), actor uuid, org_id uuid,
  action text, entity text, entity_id text, detail jsonb);

INSERT INTO public.organizations (id, name, work_mode) VALUES ('${TEAM}', 'Team fixture', 'team');
INSERT INTO public.profiles (id, email, org_id, org_role) VALUES ('${OWNER}', 'owner@example.com', '${TEAM}', 'owner');
`);

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);

let failed = 0;
function check(ok, label) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed += 1;
}

let n = 0;
// A fresh signup: own empty company with the default settings and profile rows.
async function signup(email, extra = '') {
    n += 1;
    const user = '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
    const org = '60000000-0000-0000-0000-' + String(n).padStart(12, '0');
    await db.exec(`
INSERT INTO public.organizations (id, name) VALUES ('${org}', 'Own ${n}');
INSERT INTO public.company_settings (org_id, settings) VALUES ('${org}', '{"logists_see_all": false}');
INSERT INTO public.org_company_profiles (org_id, ownership, updated_by) VALUES ('${org}', 'fop', '${user}');
INSERT INTO public.usage_counters (org_id, day, calc_count) VALUES ('${org}', current_date, 2);
INSERT INTO public.profiles (id, email, org_id, org_role) VALUES ('${user}', '${email}', '${org}', 'owner');
${extra.replace(/:org/g, `'${org}'`).replace(/:user/g, `'${user}'`)}
`);
    return { user, org };
}

async function invite(email, extra = {}) {
    n += 1;
    const hash = 'hash-' + n;
    const expires = extra.expired ? "now() - interval '1 hour'" : "now() + interval '7 days'";
    await db.query(`INSERT INTO public.org_invites (org_id, email, token_hash, invited_by, expires_at, created_at, declined_at)
        VALUES ($1, $2, $3, $4, ${expires}, now() - interval '2 hours', $5)`,
    [TEAM, email, hash, OWNER, extra.declined ? new Date().toISOString() : null]);
    return hash;
}

async function accept(hash, user, email) {
    try {
        const { rows } = await db.query('SELECT * FROM public.accept_org_invite($1, $2, $3)', [hash, user, email]);
        return { ok: true, row: rows[0] };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
}

async function one(sql, params) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}

// 1. New email: empty signup company is removed, the user joins as logist.
{
    const a = await signup('new@example.com');
    const hash = await invite('new@example.com');
    const res = await accept(hash, a.user, 'NEW@example.com');
    const profile = await one('SELECT org_id, org_role, member_status FROM public.profiles WHERE id = $1', [a.user]);
    const oldOrg = await one('SELECT count(*)::int AS c FROM public.organizations WHERE id = $1', [a.org]);
    const settings = await one('SELECT count(*)::int AS c FROM public.company_settings WHERE org_id = $1', [a.org]);
    const accepted = await one('SELECT accepted_at FROM public.org_invites WHERE token_hash = $1', [hash]);
    check(res.ok && res.row.org_id === TEAM && res.row.org_role === 'logist', 'new email: accept returns the team org and logist');
    check(profile.org_id === TEAM && profile.org_role === 'logist' && profile.member_status === 'active', 'new email: profile moved to the team as active logist');
    check(oldOrg.c === 0 && settings.c === 0, 'new email: empty signup company removed with its default settings');
    check(accepted.accepted_at !== null, 'new email: invite marked accepted');
}

// 2. Existing accounts whose company holds data: 409, nothing moves or disappears.
const DATA_CASES = [
    ['calculation', `INSERT INTO public.calculations (org_id, user_id) VALUES (:org, :user);`],
    ['fleet vehicle', `INSERT INTO public.fleet_vehicles (org_id, label) VALUES (:org, 'AA1111AA');`],
    ['route template', `INSERT INTO public.route_templates (org_id) VALUES (:org);`],
    ['company settings', `UPDATE public.company_settings SET settings = '{"logists_see_all": false, "fuelPrice": 57}' WHERE org_id = :org;`],
    ['company profile', `UPDATE public.org_company_profiles SET phone = '+380000000000' WHERE org_id = :org;`],
    ['another member', `INSERT INTO public.profiles (id, email, org_id, org_role) VALUES (gen_random_uuid(), 'mate@example.com', :org, 'logist');`]
];
for (const [label, sql] of DATA_CASES) {
    const email = label.replace(/\s+/g, '-') + '@example.com';
    const a = await signup(email, sql);
    const hash = await invite(email);
    const res = await accept(hash, a.user, email);
    const profile = await one('SELECT org_id FROM public.profiles WHERE id = $1', [a.user]);
    const oldOrg = await one('SELECT count(*)::int AS c FROM public.organizations WHERE id = $1', [a.org]);
    const pending = await one('SELECT accepted_at FROM public.org_invites WHERE token_hash = $1', [hash]);
    check(!res.ok && /OLD_ORG_HAS_DATA/.test(res.message) && profile.org_id === a.org && oldOrg.c === 1 && pending.accepted_at === null,
        'old org with ' + label + ': OLD_ORG_HAS_DATA, company and invite untouched');
}

// 3. Wrong email, declined, expired.
{
    const a = await signup('right@example.com');
    const hash = await invite('right@example.com');
    const res = await accept(hash, a.user, 'other@example.com');
    check(!res.ok && /INVITE_EMAIL_MISMATCH/.test(res.message), 'other email: INVITE_EMAIL_MISMATCH');
}
{
    const a = await signup('declined@example.com');
    const hash = await invite('declined@example.com', { declined: true });
    const res = await accept(hash, a.user, 'declined@example.com');
    check(!res.ok && /INVITE_DECLINED/.test(res.message), 'declined invite: INVITE_DECLINED');
}
{
    const a = await signup('late@example.com');
    const hash = await invite('late@example.com', { expired: true });
    const res = await accept(hash, a.user, 'late@example.com');
    check(!res.ok && /INVITE_EXPIRED/.test(res.message), 'expired invite: INVITE_EXPIRED');
}

// 4. Seat limit: owner + 3 active logists is full.
{
    const active = await one(`SELECT count(*)::int AS c FROM public.profiles WHERE org_id = $1 AND org_role = 'logist' AND member_status = 'active'`, [TEAM]);
    for (let i = active.c; i < 3; i += 1) {
        await db.query(`INSERT INTO public.profiles (id, email, org_id, org_role) VALUES (gen_random_uuid(), $1, $2, 'logist')`, ['seat' + i + '@example.com', TEAM]);
    }
    const a = await signup('fourth@example.com');
    const hash = await invite('fourth@example.com');
    const res = await accept(hash, a.user, 'fourth@example.com');
    check(!res.ok && /MEMBER_LIMIT/.test(res.message), 'fourth logist: MEMBER_LIMIT');
}

const declinedColumn = await one(`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'org_invites' AND column_name = 'declined_at'`);
check(declinedColumn.c === 1, 'org_invites.declined_at exists');

if (failed) {
    console.log(failed + ' check(s) failed');
    process.exit(1);
}
console.log('all invite-flow checks passed');
