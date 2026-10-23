// Checks supabase/migrations/20261023090000_trip_fact_v2.sql on a real Postgres (PGlite, in memory):
// all earlier migrations on the stub of the production base schema, an old (manual) fact, then this migration twice,
// then the scenarios as authenticated: v2 save, a cached old site writing the old way, limits, access rules,
// and what report_plan_fact / client_history / kp_trips return. Nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-trip-fact-v2.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const DIR = new URL('../supabase/migrations/', import.meta.url);
const TARGET = '20261023090000_trip_fact_v2.sql';
const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const before = all.filter((f) => f < TARGET);
const after = all.filter((f) => f > TARGET);
const migration = fs.readFileSync(new URL(TARGET, DIR), 'utf8');
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

for (const file of before) await db.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
check(true, 'all ' + before.length + ' earlier migrations applied');

const A = '10000000-0000-4000-8000-00000000000a';
const C = '10000000-0000-4000-8000-00000000000c';
const OA = '00000000-0000-4000-8000-0000000000a1', LA = '00000000-0000-4000-8000-0000000000a2';
const LA2 = '00000000-0000-4000-8000-0000000000a3', OC = '00000000-0000-4000-8000-0000000000c1';
await db.exec(`
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO auth.users (id, email) VALUES ('${OA}', 'owner@a.ua'), ('${LA}', 'logist@a.ua'), ('${LA2}', 'logist2@a.ua'), ('${OC}', 'owner@c.ua');
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO public.organizations (id, name, work_mode) VALUES ('${A}', 'Агро А', 'team'), ('${C}', 'Чужа В', 'solo');
INSERT INTO public.profiles (id, org_id, email, org_role, member_status, is_approved) VALUES
  ('${OA}', '${A}', 'owner@a.ua', 'owner', 'active', true), ('${LA}', '${A}', 'logist@a.ua', 'logist', 'active', true),
  ('${LA2}', '${A}', 'logist2@a.ua', 'logist', 'active', true), ('${OC}', '${C}', 'owner@c.ua', 'owner', 'active', true);
INSERT INTO public.company_settings (org_id, settings) VALUES ('${A}', '{"logists_see_all": false}');
`);
await service(`SELECT public.set_org_plan($1, 'control_plus')`, [A]);

async function trip(author, org, name, revenue, profit, overhead, status = 'accepted', date = null) {
    const res = await service(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results, status, trip_date)
      VALUES ($1, $2, $3, '{"dist": 500}'::jsonb, $4::jsonb, $5, coalesce($6::date, public.ua_today())) RETURNING id`,
    [author, org, name, JSON.stringify({ grossIncome: revenue, netProfit: profit, overheadTotal: overhead }), status, date]);
    if (!res.ok) throw new Error(res.message);
    return res.rows[0].id;
}
const tOld = await trip(LA, A, 'Старий ручний факт', 100000, 20000, 5000);
const tNew = await trip(LA, A, 'Новий факт', 80000, 10000, 4000);
const tCache = await trip(LA, A, 'Кеш', 60000, 9000, 3000);
const tDraft = await trip(LA, A, 'Чернетка', 1000, 100, 0, 'draft');
const tOldDate = await trip(LA, A, 'Давній', 50000, 5000, 1000, 'done', '2026-08-01');
const tOther = await trip(LA2, A, 'Чужого логіста', 40000, 4000, 1000);
const tC = await trip(OC, C, 'Інша компанія', 30000, 3000, 0);

// Колишній клієнт (старий сайт) — поля рівно як у saveTripActual до v2.
const oldUpsert = (who, calc, revenue, costs, overhead) => user(who)(`INSERT INTO public.trip_actuals
  (calculation_id, org_id, revenue, costs, planned_overhead, profit, entered_by) VALUES ($1, $2, $3, $4, $5, $3::numeric - $4::numeric - $5::numeric, $6)
  ON CONFLICT (calculation_id) DO UPDATE SET calculation_id = EXCLUDED.calculation_id, org_id = EXCLUDED.org_id, revenue = EXCLUDED.revenue,
  costs = EXCLUDED.costs, planned_overhead = EXCLUDED.planned_overhead, profit = EXCLUDED.profit, entered_by = EXCLUDED.entered_by
  RETURNING *`, [calc, A, revenue, costs, overhead, who]);

const before1 = await oldUpsert(LA, tOld, 95000, 72000, 5000);
check(before1.ok && Number(before1.rows[0].profit) === 18000, 'before the migration: manual fact = revenue − costs − planned overhead', before1.message);

const snapshot = async () => JSON.stringify((await db.query(`SELECT policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies
  WHERE tablename = 'trip_actuals' ORDER BY policyname`)).rows.concat((await db.query(`SELECT grantee, privilege_type FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'trip_actuals' ORDER BY grantee, privilege_type`)).rows));
const policiesBefore = await snapshot();
await db.exec(migration);
await db.exec(migration);
for (const file of after) await db.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
check(true, 'trip_fact_v2 applied twice (idempotent)' + (after.length ? ' + ' + after.length + ' later' : ''));

const cols = await db.query(`SELECT column_name, is_nullable, data_type FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'trip_actuals' ORDER BY ordinal_position`);
const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
const v2cols = ['fact_days', 'fact_loaded_km', 'fact_empty_km', 'paid_idle_days', 'idle_rate', 'extra_costs', 'extra_costs_note', 'fact_version'];
check(v2cols.every((c) => byName[c] && byName[c].is_nullable === 'YES'), 'new columns exist and are nullable');
check(['revenue', 'costs', 'planned_overhead', 'profit', 'entered_by'].every((c) => byName[c] && byName[c].is_nullable === 'NO'),
    'old columns unchanged (NOT NULL)');
const policiesAfter = await snapshot();
check(policiesBefore === policiesAfter && policiesBefore.includes('trip_actuals_update'), 'RLS policies and table grants unchanged');
const grants = await one(`SELECT has_function_privilege('authenticated', 'public.trip_actuals_guard()', 'EXECUTE') AS a,
  has_function_privilege('anon', 'public.trip_actuals_guard()', 'EXECUTE') AS b`);
check(grants.a === false && grants.b === false, 'trigger function not executable by clients');

const oldRow = await one(`SELECT * FROM public.trip_actuals WHERE calculation_id = $1`, [tOld]);
check(Number(oldRow.profit) === 18000 && Number(oldRow.planned_overhead) === 5000 && v2cols.every((c) => oldRow[c] === null),
    'old manual fact unchanged after the migration');

// Нова версія сайту: v2-стовпці + updated_at, як у saveTripActual.
const v2Upsert = (who, calc, f) => user(who)(`INSERT INTO public.trip_actuals
  (calculation_id, org_id, revenue, costs, planned_overhead, profit, entered_by, updated_at,
   fact_version, fact_days, fact_loaded_km, fact_empty_km, paid_idle_days, idle_rate, extra_costs, extra_costs_note)
  VALUES ($1, $2, $3, $4, 0, $3::numeric - $4::numeric, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (calculation_id) DO UPDATE SET calculation_id = EXCLUDED.calculation_id, org_id = EXCLUDED.org_id,
  revenue = EXCLUDED.revenue, costs = EXCLUDED.costs, planned_overhead = EXCLUDED.planned_overhead, profit = EXCLUDED.profit,
  entered_by = EXCLUDED.entered_by, updated_at = EXCLUDED.updated_at, fact_version = EXCLUDED.fact_version,
  fact_days = EXCLUDED.fact_days, fact_loaded_km = EXCLUDED.fact_loaded_km, fact_empty_km = EXCLUDED.fact_empty_km,
  paid_idle_days = EXCLUDED.paid_idle_days, idle_rate = EXCLUDED.idle_rate, extra_costs = EXCLUDED.extra_costs,
  extra_costs_note = EXCLUDED.extra_costs_note RETURNING *`,
[calc, A, f.revenue, f.costs, who, f.version === undefined ? 'v2' : f.version, f.days, f.loaded, f.empty, f.idle, f.rate, f.extra, f.note === undefined ? null : f.note]);
const sample = { revenue: 83000, costs: 75000, days: 8, loaded: 1000, empty: 800, idle: 3, rate: 1000, extra: 1500, note: 'Штраф на КПП' };

const v2 = await v2Upsert(LA, tNew, sample);
const v2row = v2.rows[0] || {};
check(v2.ok && v2row.fact_version === 'v2' && Number(v2row.fact_days) === 8 && v2row.extra_costs_note === 'Штраф на КПП',
    'v2: logist saves the new fact (details stored)', v2.message);
check(Number(v2row.planned_overhead) === 0 && Number(v2row.profit) === 8000,
    'v2: planned_overhead forced to 0 (plan overhead is 4 000), profit = revenue − costs = 8 000');

const exactDays = 3.9308080808080805; // планові доби на ходку з кругорейсу, без округлення
const exact = await v2Upsert(LA, tNew, { ...sample, days: exactDays });
check(exact.ok && Number(exact.rows[0].fact_days) === exactDays && (await one('SELECT pg_typeof(fact_days)::text AS t, fact_days::text AS v FROM public.trip_actuals WHERE calculation_id = $1', [tNew])).v === String(exactDays),
    'v2: fact_days keeps the exact plan value (numeric without precision limit)', exact.message);
const v2again = await v2Upsert(LA, tNew, { ...sample, revenue: 84000 });
check(v2again.ok && v2again.rows[0].fact_version === 'v2' && Number(v2again.rows[0].profit) === 9000,
    'v2: re-save with the same details but new totals (new site) stays v2');

// Закешована стара версія оновлює рядок v2 по-старому.
await v2Upsert(LA, tCache, { ...sample, revenue: 61000, costs: 50000 });
const cached = await oldUpsert(LA, tCache, 62000, 50000, 0);
const cachedRow = cached.rows[0] || {};
check(cached.ok && cachedRow.fact_version === null && v2cols.every((c) => cachedRow[c] === null),
    'cached old site edits a v2 row → all v2 columns (fact_version too) are cleared', cached.message);
check(Number(cachedRow.revenue) === 62000 && Number(cachedRow.planned_overhead) === 0 && Number(cachedRow.profit) === 12000,
    'cached old site edit: revenue / costs kept, profit = revenue − costs − 0 (what the old UI showed)');
const plainUpdate = await user(LA)(`UPDATE public.trip_actuals SET costs = 51000 WHERE calculation_id = $1 RETURNING *`, [tCache]);
check(plainUpdate.ok && plainUpdate.rows[0].fact_version === null && Number(plainUpdate.rows[0].profit) === 11000,
    'manual row: plain update works as before');
await v2Upsert(LA, tCache, { ...sample, revenue: 61000, costs: 50000 });
const sameTotals = await oldUpsert(LA, tCache, 61000, 50000, 0);
check(sameTotals.ok && sameTotals.rows[0].fact_version === null,
    'cached old site re-saving the same numbers also turns the row into a manual fact (its profit differs)');
await v2Upsert(LA, tCache, { ...sample, revenue: 61000, costs: 50000 });
const touchOnly = await user(LA)(`UPDATE public.trip_actuals SET entered_by = entered_by WHERE calculation_id = $1 RETURNING fact_version`, [tCache]);
check(touchOnly.ok && touchOnly.rows[0].fact_version === 'v2', 'an update that changes no totals keeps v2');

// Ручний → v2 (новий редактор, після підтвердження «Замінити старий факт»).
const upgrade = await v2Upsert(LA, tOld, sample);
check(upgrade.ok && upgrade.rows[0].fact_version === 'v2' && Number(upgrade.rows[0].planned_overhead) === 0 && Number(upgrade.rows[0].profit) === 8000,
    'manual → v2: planned_overhead 0, profit = revenue − costs');
// v2 → ручний (новий редактор, рейс без даних калькулятора): fact_version null чистить деталі.
const downgrade = await v2Upsert(LA, tOld, { revenue: 90000, costs: 70000, version: null, days: 5, loaded: 1, empty: 1, idle: 0, rate: 0, extra: 0 });
check(downgrade.ok && v2cols.every((c) => downgrade.rows[0][c] === null) && Number(downgrade.rows[0].profit) === 20000,
    'v2 → manual: details cleared, profit = revenue − costs − 0');

// Межі.
const bad = async (label, f) => {
    const res = await v2Upsert(LA, tNew, { ...sample, ...f });
    check(!res.ok && /trip_actuals_fact_v2/.test(res.message), 'limits: ' + label, res.message);
};
await bad('negative loaded km', { loaded: -1 });
await bad('negative empty km', { empty: -5 });
await bad('zero fact days', { days: 0 });
await bad('negative paid idle', { idle: -1 });
await bad('negative idle rate', { rate: -1 });
await bad('negative extra costs', { extra: -1 });
await bad('note longer than 500', { note: 'x'.repeat(501) });
await bad('unknown fact_version', { version: 'v3' });
await bad('v2 without days', { days: null });
const note500 = await v2Upsert(LA, tNew, { ...sample, note: 'я'.repeat(500) });
check(note500.ok, 'limits: a 500-character note is fine', note500.message);
const negCosts = await v2Upsert(LA, tNew, { ...sample, costs: -1 });
check(!negCosts.ok, 'limits: costs stay >= 0 (old constraint)');

// Доступ — як раніше.
const draft = await v2Upsert(LA, tDraft, sample);
check(!draft.ok && /FACT_STATUS/.test(draft.message), 'access: draft → FACT_STATUS');
const locked = await v2Upsert(LA, tOldDate, sample);
check(!locked.ok && /FACT_LOCKED/.test(locked.message), 'access: logist after 30 days → FACT_LOCKED');
const ownerLate = await v2Upsert(OA, tOldDate, sample);
check(ownerLate.ok, 'access: owner edits after 30 days', ownerLate.message);
const foreign = await v2Upsert(LA, tOther, sample);
check(!foreign.ok, 'access: another logist\'s trip is refused');
const otherOrg = await user(OC)(`SELECT count(*)::int AS n FROM public.trip_actuals`);
check(otherOrg.ok && otherOrg.rows[0].n === 0, 'access: another company sees no facts');
const logist2 = await user(LA2)(`SELECT count(*)::int AS n FROM public.trip_actuals`);
check(logist2.ok && logist2.rows[0].n === 0, 'access: another logist sees no facts (logists_see_all = false)');
const cross = await user(OC)(`INSERT INTO public.trip_actuals (calculation_id, org_id, revenue, costs, planned_overhead, profit, entered_by)
  VALUES ($1, $2, 1, 1, 0, 0, $3)`, [tNew, C, OC]);
check(!cross.ok, 'access: another company cannot write');
void tC;

// Споживачі: звіт план/факт, історія клієнта, kp_trips.
await v2Upsert(LA, tNew, sample); // 83 000 / 75 000 → прибуток 8 000
const report = await user(OA)(`SELECT * FROM public.report_plan_fact(public.ua_today() - 3, public.ua_today() + 3, 'logist')`);
const logistRow = (report.rows || []).find((r) => r.group_label === 'logist@a.ua');
console.log('report_plan_fact (logist@a.ua):', JSON.stringify(logistRow));
const facts = await one(`SELECT sum(ta.revenue) AS r, sum(ta.costs + ta.planned_overhead) AS c, sum(ta.profit) AS p, count(*)::int AS n
  FROM public.trip_actuals AS ta JOIN public.calculations AS c ON c.id = ta.calculation_id
  WHERE c.user_id = $1 AND c.status IN ('accepted', 'done') AND c.trip_date BETWEEN public.ua_today() - 3 AND public.ua_today() + 3`, [LA]);
check(report.ok && logistRow && Number(logistRow.fact_revenue) === Number(facts.r) && Number(logistRow.fact_costs) === Number(facts.c)
    && Number(logistRow.fact_profit) === Number(facts.p) && Number(logistRow.fact_revenue) - Number(logistRow.fact_costs) === Number(logistRow.fact_profit),
'report_plan_fact: fact costs = costs + planned_overhead, profit = profit, revenue − costs = profit for v2 and manual rows', report.message);
const client = await user(OA)(`INSERT INTO public.clients (org_id, name) VALUES ($1, 'ТОВ Тест') RETURNING id`, [A]);
await user(OA)(`INSERT INTO public.calculation_clients (calculation_id, client_id) VALUES ($1, $2)`, [tNew, client.rows[0].id]);
const history = await user(OA)(`SELECT * FROM public.client_history($1)`, [client.rows[0].id]);
const h = (history.rows || [])[0] || {};
check(history.ok && Number(h.fact_revenue) === 83000 && Number(h.fact_costs) === 75000 && Number(h.fact_profit) === 8000,
    'client_history: v2 fact shows revenue 83 000, costs 75 000, profit 8 000', history.message || JSON.stringify(h));
const kp = await user(OA)(`SELECT * FROM public.kp_trips(public.ua_today() - 3, public.ua_today() + 3, false)`);
check(kp.ok && kp.rows.some((r) => r.calculation_id === tNew && Number(r.plan_revenue) === 80000 && Number(r.plan_profit) === 10000),
    'kp_trips: plan only (calculations.revenue / profit), not affected by the fact', kp.message);
const weekly = await service(`SELECT calculation_id, profit FROM public.trip_actuals WHERE calculation_id = $1`, [tNew]);
check(weekly.ok && Number(weekly.rows[0].profit) === 8000, 'weekly report source (calculation_id, profit) reads the v2 profit');

console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
