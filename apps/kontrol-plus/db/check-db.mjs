// Контроль+ (Етап 1): перевірка міграцій на справжньому Postgres (PGlite, у пам'яті). Supabase не чіпає.
// Усі міграції репозиторію по черзі на заглушці базової схеми прод (таблиці до репо, ролі й default privileges
// Supabase), потім 20261022090000 / 20261022091000 (двічі — ідемпотентність) і сценарії від імені authenticated.
//
//   npm i --no-save @electric-sql/pglite@0.2.17   (у корені репозиторію)
//   node apps/kontrol-plus/db/check-db.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const OURS = ['20261022090000_kontrol_plus_access.sql', '20261022091000_kontrol_plus_clients_reports.sql'];
const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const before = all.filter((f) => f < OURS[0]);
const db = new PGlite();

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
CREATE FUNCTION public.my_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT org_id FROM public.profiles WHERE id = auth.uid() $$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT coalesce((SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()), false) $$;
CREATE FUNCTION public.enforce_demo_save_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS
  $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.ua_today() RETURNS date LANGUAGE sql STABLE AS
  $$ SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date $$;
`);

let failed = 0;
function check(ok, label, extra) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !extra ? '' : ' — ' + extra));
    if (!ok) failed += 1;
}
for (const file of before) await db.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
for (const file of OURS) {
    const sql = fs.readFileSync(new URL(file, DIR), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
}
check(true, 'all ' + before.length + ' earlier migrations + both Контроль+ migrations (twice) applied');

async function one(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}
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
const user = (id) => (sql, params) => as('authenticated', id, sql, params);
const service = (sql, params) => as('service_role', null, sql, params);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const A = '10000000-0000-4000-8000-00000000000a';   // control_plus
const B = '10000000-0000-4000-8000-00000000000b';   // company (без Контроль+)
const C = '10000000-0000-4000-8000-00000000000c';   // control_plus, чужа
const D = '10000000-0000-4000-8000-00000000000d';   // власна org директора (company)
const OA = '00000000-0000-4000-8000-0000000000a1', LA = '00000000-0000-4000-8000-0000000000a2', LA2 = '00000000-0000-4000-8000-0000000000a3';
const OB = '00000000-0000-4000-8000-0000000000b1', OC = '00000000-0000-4000-8000-0000000000c1';
const DIR1 = '00000000-0000-4000-8000-0000000000d1', DIR2 = '00000000-0000-4000-8000-0000000000d2', DIR3 = '00000000-0000-4000-8000-0000000000d3';
await db.exec(`
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO auth.users (id, email) VALUES ('${OA}', 'owner@a.ua'), ('${LA}', 'logist@a.ua'), ('${LA2}', 'logist2@a.ua'),
  ('${OB}', 'owner@b.ua'), ('${OC}', 'owner@c.ua'), ('${DIR1}', 'dir1@x.ua'), ('${DIR2}', 'dir2@x.ua'), ('${DIR3}', 'dir3@x.ua');
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO public.organizations (id, name, work_mode) VALUES ('${A}', 'Агро А', 'team'), ('${B}', 'Компанія Б', 'solo'),
  ('${C}', 'Чужа В', 'solo'), ('${D}', 'Директорська', 'solo');
INSERT INTO public.profiles (id, org_id, email, org_role, member_status, is_approved) VALUES
  ('${OA}', '${A}', 'owner@a.ua', 'owner', 'active', true), ('${LA}', '${A}', 'logist@a.ua', 'logist', 'active', true),
  ('${LA2}', '${A}', 'logist2@a.ua', 'logist', 'active', true),
  ('${OB}', '${B}', 'owner@b.ua', 'owner', 'active', true), ('${OC}', '${C}', 'owner@c.ua', 'owner', 'active', true),
  ('${DIR1}', '${D}', 'dir1@x.ua', 'owner', 'active', true), ('${DIR2}', null, 'dir2@x.ua', 'owner', 'active', false),
  ('${DIR3}', null, 'dir3@x.ua', 'owner', 'active', false);
INSERT INTO public.company_settings (org_id, settings) VALUES ('${A}', '{"logists_see_all": false}');
`);

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
check((await one(`SELECT plan FROM public.organizations WHERE id = $1`, [A])).plan === 'company', 'plan: existing organizations default to company');
const ownerSetsPlan = await user(OA)(`UPDATE public.organizations SET plan = 'control_plus' WHERE id = $1 RETURNING id`, [A]);
check(!ownerSetsPlan.ok && /PLAN_SERVICE_ROLE_ONLY/.test(ownerSetsPlan.message), 'plan: owner cannot switch own org to control_plus', ownerSetsPlan.message);
const rename = await user(OA)(`UPDATE public.organizations SET name = 'Агро А+' WHERE id = $1 RETURNING name`, [A]);
check(rename.ok && rename.rows[0].name === 'Агро А+', 'plan: owner still renames own org (site unchanged)', rename.message);
const rpcByUser = await user(OA)(`SELECT public.set_org_plan($1, 'control_plus')`, [A]);
check(!rpcByUser.ok && rpcByUser.code === '42501', 'plan: set_org_plan not callable by authenticated');
for (const org of [A, C]) check((await service(`SELECT public.set_org_plan($1, 'control_plus') AS p`, [org])).rows[0].p === 'control_plus', 'plan: service_role enables control_plus for ' + org.slice(-1));
const badPlan = await service(`SELECT public.set_org_plan($1, 'gold')`, [B]);
check(!badPlan.ok && /BAD_PLAN/.test(badPlan.message), 'plan: unknown plan refused');
await db.exec(`UPDATE public.organizations SET plan = 'company' WHERE id = '${D}'`);
check(true, 'plan: direct SQL (SQL Editor, no client role) can set the plan');
const signup = '00000000-0000-4000-8000-0000000000e1';
await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${signup}', 'new@x.ua', '{"company_name":"Нова"}')`);
const newOrg = await one(`SELECT o.plan FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id WHERE p.id = $1`, [signup]);
check(newOrg && newOrg.plan === 'company', 'plan: site signup still creates an org on company');

// ---------------------------------------------------------------------------
// Directors
// ---------------------------------------------------------------------------
const selfDirector = await user(OA)(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2)`, [A, DIR1]);
check(!selfDirector.ok && selfDirector.code === '42501', 'directors: owner cannot add a director (service_role only)');
check((await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2) RETURNING user_id`, [A, DIR1])).ok, 'directors: service_role adds director 1');
check((await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2) RETURNING user_id`, [A, DIR2])).ok, 'directors: service_role adds director 2');
const third = await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2)`, [A, DIR3]);
check(!third.ok && /DIRECTOR_LIMIT/.test(third.message), 'directors: a 3rd director is refused (limit 2)', third.message);
const member = await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2)`, [C, OC]);
check(!member.ok && /DIRECTOR_IS_MEMBER/.test(member.message), 'directors: an active member of the org cannot be its director');
const seats = await one(`SELECT count(*)::int AS n FROM public.profiles WHERE org_id = $1 AND org_role = 'logist' AND member_status = 'active'`, [A]);
check(seats.n === 2, 'directors: do not take logist seats (profiles unchanged)');
const dirSees = await user(DIR1)(`SELECT org_id FROM public.org_directors`);
const logistSeesDirs = await user(LA)(`SELECT org_id FROM public.org_directors`);
const ownerSeesDirs = await user(OA)(`SELECT user_id FROM public.org_directors`);
check(dirSees.ok && dirSees.rows.length === 1 && logistSeesDirs.rows.length === 0 && ownerSeesDirs.rows.length === 2, 'directors: visible to the owner and to the director only');

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const ctx = async (id) => (await user(id)(`SELECT * FROM public.kp_context()`)).rows[0];
const cOA = await ctx(OA), cLA = await ctx(LA), cDIR = await ctx(DIR1), cOB = await ctx(OB), cOC = await ctx(OC);
check(cOA.control_plus && cOA.role === 'owner' && cOA.org_id === A, 'context: owner of a control_plus org');
check(cLA.control_plus && cLA.role === 'logist' && cLA.org_id === A, 'context: logist');
check(cDIR.control_plus && cDIR.role === 'director' && cDIR.org_id === A && cDIR.own_org_plan === 'company', 'context: director works in org A (own org on company)');
check(!cOB.control_plus && cOB.role === null && cOB.own_org_plan === 'company', 'context: org without the plan — no access');
check(cOC.control_plus && cOC.org_id === C, 'context: other control_plus org sees its own');

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const insertClient = (id, org, fields) => user(id)(`INSERT INTO public.clients (org_id, name, legal_form, edrpou, ipn, iban, email, vat_payer, vat_number)
  VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, false), $9) RETURNING id, iban, email, created_by`,
  [org, fields.name, fields.legal_form || null, fields.edrpou || null, fields.ipn || null, fields.iban || null, fields.email || null, fields.vat_payer || null, fields.vat_number || null]);
const tov = await insertClient(OA, A, { name: 'Зерно ТОВ', legal_form: 'tov', edrpou: '12345678', iban: 'ua21 3223 1300 0002 6007 2335 6600 1', email: ' Buh@Zerno.UA ', vat_payer: true, vat_number: '123456789012' });
check(tov.ok && tov.rows[0].iban === 'UA213223130000026007233566001' && tov.rows[0].email === 'buh@zerno.ua' && tov.rows[0].created_by === OA,
    'clients: owner adds a ТОВ; IBAN / email normalized, author from the server', tov.message);
const fop = await insertClient(LA, A, { name: 'ФОП Петренко', legal_form: 'fop', ipn: '1234567890' });
check(fop.ok, 'clients: logist adds a ФОП', fop.message);
const quick = await insertClient(LA, A, { name: 'Швидкий без реквізитів' });
check(quick.ok, 'clients: quick add with the name only (all requisites may be empty)', quick.message);
for (const [label, fields] of [['ЄДРПОУ 7 digits', { edrpou: '1234567' }], ['ІПН 9 digits', { ipn: '123456789' }],
    ['IBAN not UA', { iban: 'DE89370400440532013000' }], ['IBAN short', { iban: 'UA2132231300' }], ['bad email', { email: 'not-an-email' }],
    ['legal form', { legal_form: 'pp' }], ['VAT number 11 digits', { vat_number: '12345678901' }]]) {
    const res = await insertClient(OA, A, Object.assign({ name: 'Bad ' + label }, fields));
    check(!res.ok && res.code === '23514', 'clients: format check — ' + label, res.message);
}
const dup = await insertClient(OA, A, { name: 'Дубль', edrpou: '12345678' });
check(!dup.ok && dup.code === '23505', 'clients: one active client per ЄДРПОУ in the org');
const tovId = tov.rows[0].id, fopId = fop.rows[0].id;
const otherOrgSameEdrpou = await insertClient(OC, C, { name: 'Інший', edrpou: '12345678' });
check(otherOrgSameEdrpou.ok, 'clients: the same ЄДРПОУ is fine in another org');

const bClients = await user(OB)(`SELECT id FROM public.clients`);
const bInsert = await insertClient(OB, B, { name: 'Б-клієнт' });
check(bClients.ok && bClients.rows.length === 0, 'gating: org without the plan sees no clients');
check(!bInsert.ok && bInsert.code === '42501', 'gating: org without the plan cannot add clients (RLS)', bInsert.message);
const cSees = await user(OC)(`SELECT name FROM public.clients`);
check(cSees.ok && cSees.rows.length === 1 && cSees.rows[0].name === 'Інший', 'isolation: another control_plus org sees only its own clients');
const crossInsert = await insertClient(OC, A, { name: 'Чужий у А' });
check(!crossInsert.ok, 'isolation: cannot add a client into another org');
const anonSees = await as('anon', null, `SELECT id FROM public.clients`);
check(!anonSees.ok && anonSees.code === '42501', 'isolation: anon has no access');

const dirClients = await user(DIR1)(`SELECT name FROM public.clients ORDER BY name`);
check(dirClients.ok && dirClients.rows.length === 3, 'director: reads the org clients');
const dirInsert = await insertClient(DIR1, A, { name: 'Від директора' });
const dirUpdate = await user(DIR1)(`UPDATE public.clients SET notes = 'x' WHERE id = $1 RETURNING id`, [tovId]);
const dirDelete = await user(DIR1)(`DELETE FROM public.clients WHERE id = $1 RETURNING id`, [tovId]);
check(!dirInsert.ok && dirUpdate.ok && dirUpdate.rows.length === 0 && dirDelete.ok && dirDelete.rows.length === 0,
    'director: cannot insert, update or delete clients', [dirInsert.message, dirUpdate.message, dirDelete.message].join(' | '));
const logistUpdate = await user(LA)(`UPDATE public.clients SET phone = '+380 50 000 00 00' WHERE id = $1 RETURNING phone`, [tovId]);
check(logistUpdate.ok && logistUpdate.rows.length === 1, 'clients: logist edits a client');
const logistDelete = await user(LA)(`DELETE FROM public.clients WHERE id = $1 RETURNING id`, [quick.rows[0].id]);
check(logistDelete.ok && logistDelete.rows.length === 0, 'clients: logist cannot delete (archive instead)');
const archive = await user(LA)(`UPDATE public.clients SET archived_at = now() WHERE id = $1 RETURNING archived_at`, [quick.rows[0].id]);
check(archive.ok && archive.rows[0].archived_at, 'clients: logist archives');
const moveOrg = await user(OA)(`UPDATE public.clients SET org_id = $2 WHERE id = $1`, [tovId, C]);
check(!moveOrg.ok, 'clients: org cannot be changed');
await db.exec(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '${LA2}'`);
const blocked = await insertClient(LA2, A, { name: 'Від заблокованого' });
check(!blocked.ok, 'clients: a blocked user cannot write');
await db.exec(`UPDATE auth.users SET banned_until = null WHERE id = '${LA2}'`);

// ---------------------------------------------------------------------------
// Trips, links, history
// ---------------------------------------------------------------------------
async function trip(author, name, revenue, profit, overhead, status = 'accepted', date = '2026-10-10') {
    const res = await service(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results, status, trip_date)
      VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, $5, $6) RETURNING id`,
    [author, (await one(`SELECT org_id FROM public.profiles WHERE id = $1`, [author])).org_id, name,
        JSON.stringify({ grossIncome: String(revenue), netProfit: String(profit), overheadTotal: String(overhead) }), status, date]);
    if (!res.ok) throw new Error(res.message);
    return res.rows[0].id;
}
const t1 = await trip(OA, 'Київ — Одеса', 100000, 20000, 5000);
const t2 = await trip(LA, 'Київ — Одеса (копія)', 80000, 10000, 4000);
const t3 = await trip(LA2, 'Львів — Дніпро', 50000, 5000, 2000);
const t4 = await trip(OA, 'Чернетка', 999, 1, 0, 'draft');
const t5 = await trip(OA, 'Поза періодом', 70000, 7000, 1000, 'done', '2026-09-01');
const tC = await trip(OC, 'Чужий рейс', 10000, 1000, 0);
// Факт: t1 і t2.
await service(`INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by) VALUES ($1, 95000, 72000, 0, 0, $2)`, [t1, OA]);
await service(`INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by) VALUES ($1, 80000, 70000, 0, 0, $2)`, [t2, LA]);
const facts = await db.query(`SELECT calculation_id, profit FROM public.trip_actuals`);
const factProfit = Object.fromEntries(facts.rows.map((r) => [r.calculation_id, Number(r.profit)]));
check(factProfit[t1] === 18000 && factProfit[t2] === 6000, 'fixture: fact profit = revenue − costs − planned overhead (18 000 / 6 000)');
// Авто: t1 — два авто (тоннаж 30 / 10), t2 — одне, t3 — без авто.
const fleet = await service(`INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('20000000-0000-4000-8000-000000000001', $1, 'AA1111AA'), ('20000000-0000-4000-8000-000000000002', $1, 'BB2222BB')`, [A]);
if (!fleet.ok) throw new Error(fleet.message);
await service(`INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage) VALUES ($1, '20000000-0000-4000-8000-000000000001', 30), ($1, '20000000-0000-4000-8000-000000000002', 10), ($2, '20000000-0000-4000-8000-000000000001', 25)`, [t1, t2]);
await service(`INSERT INTO public.route_templates (org_id, owner_user_id, scope, name, params) VALUES ($1, $2, 'company', 'Київ — Одеса', '{}'::jsonb)`, [A, OA]);

const link = (id, calc, client) => user(id)(`INSERT INTO public.calculation_clients (calculation_id, client_id) VALUES ($1, $2) RETURNING org_id, linked_by`, [calc, client]);
const l1 = await link(OA, t2, tovId);
check(l1.ok && l1.rows[0].org_id === A && l1.rows[0].linked_by === OA, 'links: owner links a logist\'s trip to a client', l1.message);
const l2 = await link(LA, t1, fopId);
check(!l2.ok && /CLIENT_LINK_FORBIDDEN|row-level security/.test(l2.message), 'links: logist cannot link the owner\'s trip', l2.message);
const l3 = await link(LA2, t3, fopId);
check(l3.ok, 'links: logist links own trip', l3.message);
const l4 = await link(OA, t1, tovId);
check(l4.ok, 'links: owner links own trip');
const lCross = await link(OC, tC, tovId);
check(!lCross.ok, 'links: a client of another org cannot be linked');
const lDir = await link(DIR1, t5, tovId);
check(!lDir.ok, 'links: director cannot link');
const lB = await user(OB)(`SELECT * FROM public.calculation_clients`);
check(lB.ok && lB.rows.length === 0, 'links: org without the plan sees no links');

const history = await user(OA)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(history.ok && history.rows.length === 2 && history.rows.some((r) => r.calculation_id === t1 && Number(r.fact_profit) === 18000 && Number(r.plan_costs) === 80000),
    'history: owner sees the client\'s trips with plan, rate and fact', history.message);
const historyLogist = await user(LA2)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(historyLogist.ok && historyLogist.rows.length === 0, 'history: logist (see-all off) sees only own trips of the client');
const historyDir = await user(DIR1)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(historyDir.ok && historyDir.rows.length === 2, 'history: director sees all trips of the client');
const historyC = await user(OC)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(!historyC.ok && /CLIENT_NOT_FOUND/.test(historyC.message), 'history: another org gets CLIENT_NOT_FOUND');
const historyB = await user(OB)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(!historyB.ok && /CONTROL_PLUS_REQUIRED/.test(historyB.message), 'history: org without the plan — CONTROL_PLUS_REQUIRED');
const kpTrips = await user(OA)(`SELECT calculation_id, can_link, client_name FROM public.kp_trips('2026-10-01', '2026-10-31', false)`);
check(kpTrips.ok && kpTrips.rows.length === 4 && kpTrips.rows.every((r) => r.can_link === true), 'trips: owner — all trips of the period, can link');
const kpUnlinked = await user(LA2)(`SELECT calculation_id, can_link FROM public.kp_trips('2026-10-01', '2026-10-31', true)`);
check(kpUnlinked.ok && kpUnlinked.rows.length === 0, 'trips: logist — own trips only (t3 already linked)');
const kpDir = await user(DIR1)(`SELECT can_link FROM public.kp_trips('2026-10-01', '2026-10-31', false)`);
check(kpDir.ok && kpDir.rows.length === 4 && kpDir.rows.every((r) => r.can_link === false), 'trips: director sees all, cannot link');

// ---------------------------------------------------------------------------
// Plan / fact report
// ---------------------------------------------------------------------------
const report = async (id, group) => user(id)(`SELECT * FROM public.report_plan_fact('2026-10-01', '2026-10-31', $1)`, [group]);
const num = (v) => (v === null ? null : Number(v));
const byLabel = (rows) => Object.fromEntries(rows.map((r) => [r.group_label, r]));

const rl = await report(OA, 'logist');
const L = byLabel(rl.rows);
check(rl.ok && rl.rows.length === 3, 'report logist: 3 authors (draft and out-of-period excluded)', rl.message);
check(L['owner@a.ua'] && L['owner@a.ua'].trips === 1 && num(L['owner@a.ua'].plan_revenue) === 100000 && num(L['owner@a.ua'].plan_costs) === 80000
    && num(L['owner@a.ua'].plan_profit) === 20000 && num(L['owner@a.ua'].fact_revenue) === 95000 && num(L['owner@a.ua'].fact_costs) === 77000
    && num(L['owner@a.ua'].fact_profit) === 18000 && num(L['owner@a.ua'].deviation_profit) === -2000 && num(L['owner@a.ua'].deviation_pct) === -10,
'report logist: owner row — plan 100 000 / 80 000 / 20 000, fact 95 000 / 77 000 / 18 000, −2 000 (−10%)', JSON.stringify(L['owner@a.ua']));
check(L['logist2@a.ua'] && L['logist2@a.ua'].trips_with_fact === 0 && num(L['logist2@a.ua'].deviation_profit) === 0 && L['logist2@a.ua'].deviation_pct === null,
    'report logist: a trip without fact — no deviation');

const rv = byLabel((await report(OA, 'vehicle')).rows);
check(num(rv.AA1111AA.plan_revenue) === 155000 && num(rv.BB2222BB.plan_revenue) === 25000 && rv.AA1111AA.trips === 2 && rv.BB2222BB.trips === 1,
    'report vehicle: two vehicles on one trip split by tonnage (75% / 25%)', JSON.stringify([rv.AA1111AA, rv.BB2222BB].map((r) => r && r.plan_revenue)));
check(rv['Без авто'] && rv['Без авто'].trips === 1 && num(rv['Без авто'].plan_revenue) === 50000, 'report vehicle: trips without a vehicle — «Без авто»');
const vehicleTotal = Object.values(rv).reduce((s, r) => s + num(r.plan_revenue), 0);
check(vehicleTotal === 230000, 'report vehicle: totals equal the trips (no double counting)', String(vehicleTotal));

const rc = byLabel((await report(OA, 'client')).rows);
check(rc['Зерно ТОВ'] && rc['Зерно ТОВ'].trips === 2 && rc['ФОП Петренко'].trips === 1 && !rc['Без клієнта'], 'report client: by linked client');
const rd = byLabel((await report(OA, 'direction')).rows);
check(rd['Київ — Одеса'] && rd['Київ — Одеса'].trips === 2 && rd['Без шаблону'] && rd['Без шаблону'].trips === 1,
    'report direction: by route template name (« (копія)» too), others «Без шаблону»', JSON.stringify(Object.keys(rd)));
check((await report(OA, 'direction')).rows.at(-1).group_label === 'Без шаблону', 'report: «Без …» group last');

const rLogist = await report(LA, 'logist');
check(rLogist.ok && rLogist.rows.length === 1 && rLogist.rows[0].group_label === 'logist@a.ua', 'report: logist (see-all off) sees only own trips');
await db.exec(`UPDATE public.company_settings SET settings = '{"logists_see_all": true}' WHERE org_id = '${A}'`);
check((await report(LA, 'logist')).rows.length === 3, 'report: logist sees all with «логісти бачать усе»');
check((await report(DIR1, 'logist')).rows.length === 3, 'report: director sees all trips');
const rC = await report(OC, 'logist');
check(rC.ok && rC.rows.length === 1 && rC.rows[0].group_label === 'owner@c.ua', 'report: another org sees only its trips');
const rB = await report(OB, 'logist');
check(!rB.ok && /CONTROL_PLUS_REQUIRED/.test(rB.message), 'report: org without the plan — CONTROL_PLUS_REQUIRED');
const badGroup = await user(OA)(`SELECT * FROM public.report_plan_fact('2026-10-01', '2026-10-31', 'colour')`);
const badPeriod = await user(OA)(`SELECT * FROM public.report_plan_fact('2026-10-31', '2026-10-01', 'logist')`);
check(!badGroup.ok && /BAD_GROUP/.test(badGroup.message) && !badPeriod.ok && /BAD_PERIOD/.test(badPeriod.message), 'report: bad group / period refused');
const anonReport = await as('anon', null, `SELECT * FROM public.report_plan_fact('2026-10-01', '2026-10-31', 'logist')`);
check(!anonReport.ok && anonReport.code === '42501', 'report: anon cannot call');

// Відключення плану — доступ зникає одразу.
await service(`SELECT public.set_org_plan($1, 'company')`, [A]);
check((await user(DIR1)(`SELECT id FROM public.clients`)).rows.length === 0 && !(await ctx(OA)).control_plus, 'gating: plan back to company — clients hidden, no context');
await service(`SELECT public.set_org_plan($1, 'control_plus')`, [A]);
await service(`UPDATE public.organizations SET status = 'blocked' WHERE id = $1`, [A]);
check((await user(OA)(`SELECT id FROM public.clients`)).rows.length === 0, 'gating: blocked org — no access');
await service(`UPDATE public.organizations SET status = 'active' WHERE id = $1`, [A]);

// Сайт: збереження рейсу (тригери calculations) і факт працюють як раніше.
const siteCalc = await user(OA)(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results) VALUES ($1, $2, 'Сайт', '{"dist":"100"}'::jsonb, '{}'::jsonb) RETURNING distance_km`, [OA, A]);
check(siteCalc.ok && Number(siteCalc.rows[0].distance_km) === 100, 'site: saving a calculation works as before', siteCalc.message);
const delOrg = await attemptDeleteOrg(A);
check(!delOrg.ok && delOrg.code === '23503', 'safety: an org with clients cannot be deleted by cascade (ON DELETE RESTRICT)');
async function attemptDeleteOrg(org) {
    try {
        await db.query(`DELETE FROM public.organizations WHERE id = $1`, [org]);
        return { ok: true };
    } catch (error) {
        return { ok: false, code: error.code };
    }
}

// ---------------------------------------------------------------------------
// supabase/tests/kontrol_plus.sql — через мінімальний shim pgTAP (у PGlite немає розширення pgtap).
// ---------------------------------------------------------------------------
await db.exec(`
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS instance_id uuid, ADD COLUMN IF NOT EXISTS aud text,
  ADD COLUMN IF NOT EXISTS role text, ADD COLUMN IF NOT EXISTS encrypted_password text,
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE TABLE extensions.tap (n serial, ok boolean, label text);
GRANT ALL ON extensions.tap TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE extensions.tap_n_seq TO anon, authenticated, service_role;
CREATE FUNCTION extensions.plan(integer) RETURNS text LANGUAGE sql AS $$ SELECT '1..' || $1 $$;
CREATE FUNCTION extensions.ok(boolean, text) RETURNS text LANGUAGE sql AS
  $$ INSERT INTO extensions.tap (ok, label) VALUES (coalesce($1, false), $2) RETURNING label $$;
CREATE FUNCTION extensions.is(anyelement, anyelement, text) RETURNS text LANGUAGE sql AS
  $$ SELECT extensions.ok($1 IS NOT DISTINCT FROM $2, $3 || ' (got ' || coalesce($1::text, 'NULL') || ')') $$;
CREATE FUNCTION extensions.lives_ok(text, text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE $1; EXCEPTION WHEN OTHERS THEN RETURN extensions.ok(false, $2 || ' (' || SQLERRM || ')'); END;
  RETURN extensions.ok(true, $2);
END $$;
CREATE FUNCTION extensions.throws_ok(text, text, text, text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE $1; EXCEPTION WHEN OTHERS THEN RETURN extensions.ok(SQLSTATE = $2, $4 || ' (' || SQLSTATE || ' ' || SQLERRM || ')'); END;
  RETURN extensions.ok(false, $4 || ' (no error)');
END $$;
CREATE FUNCTION extensions.finish() RETURNS SETOF text LANGUAGE sql AS $$ SELECT 'done' $$;
`);
const tapSql = fs.readFileSync(new URL('../../../supabase/tests/kontrol_plus.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const planned = Number((tapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
await db.exec(tapSql);
const tap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows;
for (const row of tap) check(row.ok, 'pgTAP kontrol_plus.sql: ' + row.label);
check(tap.length === planned, `pgTAP kontrol_plus.sql: ran ${tap.length} of plan(${planned})`);

if (failed) {
    console.log(failed + ' Контроль+ DB check(s) failed');
    process.exit(1);
}
console.log('all Контроль+ DB checks passed');
