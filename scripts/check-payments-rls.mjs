// Checks supabase/migrations/20261018190000_payments.sql on a real Postgres (PGlite, in memory).
// The schema is a stub of the production tables and helpers the migration touches; the demo
// save limit trigger is the production one (3 saved calculations without approval or payment).
// Nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-payments-rls.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261018190000_payments.sql', import.meta.url), 'utf8');
const db = new PGlite();
const ORG = '80000000-0000-0000-0000-000000000001';
const OTHER_ORG = '80000000-0000-0000-0000-000000000002';
const OWNER = '00000000-0000-0000-0000-0000000000e1';
const LOGIST = '00000000-0000-0000-0000-0000000000e2';
const STRANGER = '00000000-0000-0000-0000-0000000000e3';
const APPROVED = '00000000-0000-0000-0000-0000000000e4';
const APPROVED_ORG = '80000000-0000-0000-0000-000000000003';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text, status text DEFAULT 'active');
CREATE TABLE public.profiles (id uuid PRIMARY KEY, org_id uuid, org_role text, member_status text DEFAULT 'active',
  is_approved boolean DEFAULT false);
CREATE TABLE public.calculations (id serial PRIMARY KEY, org_id uuid, user_id uuid, name text);
-- Read by org_has_user_data (redefined by the migration).
CREATE TABLE public.company_settings (org_id uuid PRIMARY KEY, settings jsonb);
CREATE TABLE public.org_company_profiles (org_id uuid PRIMARY KEY, ownership text, phone text, lang text,
  updated_at timestamptz, updated_by uuid);

CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.org_id FROM public.profiles AS p JOIN public.organizations AS o ON o.id = p.org_id
  WHERE p.id = auth.uid() AND p.member_status = 'active' AND o.status <> 'blocked' LIMIT 1 $$;
CREATE FUNCTION public.current_org_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.org_role FROM public.profiles AS p JOIN public.organizations AS o ON o.id = p.org_id
  WHERE p.id = auth.uid() AND p.member_status = 'active' AND o.status <> 'blocked' LIMIT 1 $$;
CREATE FUNCTION public.is_org_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.current_org_role() = 'owner', false) $$;
-- Production version before this migration (20261008_week1_rls_and_limits.sql).
CREATE FUNCTION public.current_is_approved() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT is_approved FROM public.profiles WHERE id = auth.uid() LIMIT 1), false) $$;
GRANT EXECUTE ON FUNCTION public.current_org_id(), public.current_org_role(), public.is_org_owner(),
  public.current_is_approved() TO authenticated, service_role;

-- Demo limit trigger as in production (calculations_enforce_owner_and_demo_limit, limit 3).
CREATE FUNCTION public.calculations_demo_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cnt integer;
BEGIN
  IF NOT public.current_is_approved() THEN
    SELECT count(*)::int INTO v_cnt FROM public.calculations WHERE org_id = NEW.org_id;
    IF v_cnt >= 3 THEN RAISE EXCEPTION 'DEMO_SAVE_LIMIT' USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_calculations_demo_limit BEFORE INSERT ON public.calculations
  FOR EACH ROW EXECUTE FUNCTION public.calculations_demo_limit();
ALTER TABLE public.calculations ENABLE ROW LEVEL SECURITY;
CREATE POLICY calc_insert ON public.calculations FOR INSERT TO authenticated WITH CHECK (org_id = public.current_org_id());
CREATE POLICY calc_select ON public.calculations FOR SELECT TO authenticated USING (org_id = public.current_org_id());
GRANT SELECT, INSERT ON public.calculations TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Owners can update their organization (organizations_update_owner); used to show that
-- paid_until is not reachable through it.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_select_own ON public.organizations FOR SELECT TO authenticated USING (id = public.current_org_id());
CREATE POLICY organizations_update_owner ON public.organizations FOR UPDATE TO authenticated
  USING (id = public.current_org_id() AND public.is_org_owner()) WITH CHECK (id = public.current_org_id() AND public.is_org_owner());
GRANT SELECT, UPDATE ON public.organizations TO authenticated;

INSERT INTO public.organizations (id, name) VALUES ('${ORG}', 'Агро'), ('${OTHER_ORG}', 'Інша'), ('${APPROVED_ORG}', 'Схвалена');
INSERT INTO public.profiles (id, org_id, org_role, is_approved) VALUES
  ('${OWNER}', '${ORG}', 'owner', false),
  ('${LOGIST}', '${ORG}', 'logist', false),
  ('${STRANGER}', '${OTHER_ORG}', 'owner', false),
  ('${APPROVED}', '${APPROVED_ORG}', 'owner', true);
`);

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);

let failed = 0;
function check(ok, label) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed += 1;
}

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
async function one(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}
let n = 0;
async function payment(org, plan = 'month', creator = OWNER) {
    n += 1;
    const { rows } = await db.query(
        `INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, status, provider_order_id)
         VALUES ($1, $2, 'mono', $3, $4, 'pending', $5) RETURNING id`,
        [org, creator, plan, plan === 'year' ? 250000 : 25000, 'order-' + n]);
    return rows[0].id;
}
const apply = async (id, modified = null) => (await one('SELECT public.apply_payment_success($1, $2) AS r', [id, modified])).r;
const setPaidUntil = (org, sql) => db.exec(`INSERT INTO public.org_subscriptions (org_id, paid_until) VALUES ('${org}', ${sql})
  ON CONFLICT (org_id) DO UPDATE SET paid_until = EXCLUDED.paid_until`);
const paidUntil = async (org) => (await one('SELECT paid_until FROM public.org_subscriptions WHERE org_id = $1', [org]))?.paid_until;
const nowMs = async () => (await one('SELECT now() AS t')).t.getTime();
const DAY = 24 * 60 * 60 * 1000;
const near = (a, b) => Math.abs(a - b) < 5 * 60 * 1000;

// --- Visibility -------------------------------------------------------------
const p1 = await payment(ORG);
await payment(OTHER_ORG, 'month', STRANGER);
{
    const owner = await as(OWNER, 'SELECT id FROM public.payments');
    const logist = await as(LOGIST, 'SELECT id FROM public.payments');
    const stranger = await as(STRANGER, 'SELECT id FROM public.payments WHERE org_id = $1', [ORG]);
    check(owner.ok && owner.rows.length === 1 && owner.rows[0].id === p1, 'owner sees own company payments only');
    check(logist.ok && logist.rows.length === 0, 'logist does not see payments');
    check(stranger.ok && stranger.rows.length === 0, 'another company does not see them');
    const events = await as(OWNER, 'SELECT 1 FROM public.payment_events');
    check(!events.ok && events.code === '42501', 'payment_events: no client access');
}

// --- No client writes ---------------------------------------------------------
{
    const tries = [
        [`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id) VALUES ('${ORG}', '${OWNER}', 'mono', 'month', 1, 'x')`, 'insert payments'],
        [`UPDATE public.payments SET status = 'success' WHERE id = '${p1}'`, 'update payments'],
        [`INSERT INTO public.org_subscriptions (org_id, paid_until) VALUES ('${ORG}', now() + interval '10 years')`, 'insert org_subscriptions'],
        [`UPDATE public.org_subscriptions SET paid_until = now() + interval '10 years'`, 'update org_subscriptions'],
        [`INSERT INTO public.payment_events (payment_id, provider, source) VALUES ('${p1}', 'mono', 'manual')`, 'insert payment_events'],
        [`SELECT public.apply_payment_success('${p1}', null)`, 'call apply_payment_success'],
        [`SELECT public.apply_payment_status('${p1}', 'failure', null)`, 'call apply_payment_status']
    ];
    for (const [sql, label] of tries) {
        const res = await as(OWNER, sql);
        check(!res.ok && res.code === '42501', 'authenticated cannot ' + label + ' (42501)');
    }
    check((await one('SELECT status FROM public.payments WHERE id = $1', [p1])).status === 'pending', 'payment unchanged by the client');
}

// --- Crediting ----------------------------------------------------------------
{
    const t0 = await nowMs();
    const first = await apply(p1, new Date().toISOString());
    const until1 = (await paidUntil(ORG)).getTime();
    const second = await apply(p1, new Date().toISOString());
    const until2 = (await paidUntil(ORG)).getTime();
    const row = await one('SELECT status, credited_at, period_from, period_to FROM public.payments WHERE id = $1', [p1]);
    check(first.credited === true && second.credited === false && second.already_credited === true && until1 === until2,
        'apply_payment_success twice: one extension');
    check(row.status === 'success' && row.credited_at && row.period_to.getTime() === until1, 'payment marked success with its period');
    // From no subscription: now() + 1 month (calendar month in Postgres).
    const expected = (await one(`SELECT (now() + interval '1 month') AS t`)).t.getTime();
    check(near(until1, expected) && until1 > t0 + 27 * DAY, 'no paid_until: now() + 1 month');
}
{
    await setPaidUntil(ORG, `now() - interval '5 days'`);
    const p = await payment(ORG);
    await apply(p);
    const expected = (await one(`SELECT (now() + interval '1 month') AS t`)).t.getTime();
    check(near((await paidUntil(ORG)).getTime(), expected), 'paid_until in the past: now() + 1 month');
}
{
    await setPaidUntil(ORG, `now() + interval '10 days'`);
    const before = await paidUntil(ORG);
    const p = await payment(ORG);
    await apply(p);
    const expected = (await one(`SELECT ($1::timestamptz + interval '1 month') AS t`, [before])).t.getTime();
    check((await paidUntil(ORG)).getTime() === expected, 'paid_until in the future: paid_until + 1 month');
}
{
    await setPaidUntil(ORG, `now() + interval '10 days'`);
    const before = await paidUntil(ORG);
    const p = await payment(ORG, 'year');
    await apply(p);
    const expected = (await one(`SELECT ($1::timestamptz + interval '1 year') AS t`, [before])).t.getTime();
    check((await paidUntil(ORG)).getTime() === expected, 'year: paid_until + 1 year');
}
{
    await db.exec(`SET TIME ZONE 'UTC'`);
    await setPaidUntil(ORG, `'2099-01-31T12:00:00Z'`);
    const p = await payment(ORG);
    await apply(p);
    check((await paidUntil(ORG)).toISOString() === '2099-02-28T12:00:00.000Z', '31.01 + 1 month = 28.02 (end of month)');
    await setPaidUntil(ORG, `'2096-01-31T12:00:00Z'`);
    const leap = await payment(ORG);
    await apply(leap);
    check((await paidUntil(ORG)).toISOString() === '2096-02-29T12:00:00.000Z', '31.01 + 1 month in a leap year = 29.02');
}
{
    await setPaidUntil(ORG, `now() + interval '3 days'`);
    await db.exec(`UPDATE public.org_subscriptions SET reminder_sent_for = paid_until WHERE org_id = '${ORG}'`);
    const p = await payment(ORG);
    await apply(p);
    check((await one('SELECT reminder_sent_for FROM public.org_subscriptions WHERE org_id = $1', [ORG])).reminder_sent_for === null,
        'a new payment resets the reminder');
}

// --- Order of notifications ------------------------------------------------------
{
    const p = await payment(ORG);
    const newer = await one(`SELECT public.apply_payment_status($1, 'failure', '2026-10-18T10:05:00Z') AS r`, [p]);
    const older = await one(`SELECT public.apply_payment_status($1, 'pending', '2026-10-18T10:00:00Z') AS r`, [p]);
    check(newer.r.changed === true && older.r.changed === false
        && (await one('SELECT status FROM public.payments WHERE id = $1', [p])).status === 'failure', 'older status after newer is ignored');
    const before = await paidUntil(ORG);
    const staleSuccess = await apply(p, '2026-10-18T10:01:00Z');
    check(staleSuccess.credited === false && staleSuccess.stale === true && (await paidUntil(ORG)).getTime() === before.getTime(),
        'older success after a newer status is not credited');
    const freshSuccess = await apply(p, '2026-10-18T10:10:00Z');
    check(freshSuccess.credited === true, 'newer success after failure is credited');
    const downgrade = await one(`SELECT public.apply_payment_status($1, 'failure', '2026-10-18T10:20:00Z') AS r`, [p]);
    check(downgrade.r.changed === false, 'credited payment cannot fall back to failure');
    const untilBefore = (await paidUntil(ORG)).getTime();
    const reversed = await one(`SELECT public.apply_payment_status($1, 'reversed', '2026-10-18T10:30:00Z') AS r`, [p]);
    check(reversed.r.changed === true && reversed.r.previous === 'success' && (await paidUntil(ORG)).getTime() === untilBefore,
        'reversed is recorded, paid_until is not shortened');
}

// --- Access ---------------------------------------------------------------------------
const approved = async (user) => (await as(user, 'SELECT public.current_is_approved() AS a')).rows[0].a;
{
    await setPaidUntil(ORG, `now() + interval '20 days'`);
    check(await approved(OWNER) === true && await approved(LOGIST) === true, 'current_is_approved: true while the company is paid (owner and logist)');
    await setPaidUntil(ORG, `now() - interval '1 minute'`);
    check(await approved(OWNER) === false, 'current_is_approved: false after paid_until');
    check(await approved(APPROVED) === true, 'current_is_approved: true for manual is_approved without payment');
    check(await approved(STRANGER) === false, 'unpaid company: false');
}

// Demo limit follows the payment: 3 saved in demo, unlimited when paid, back to demo after expiry; data kept.
{
    await setPaidUntil(ORG, `now() - interval '1 minute'`);
    const save = (name) => as(OWNER, `INSERT INTO public.calculations (org_id, user_id, name) VALUES ('${ORG}', '${OWNER}', $1) RETURNING id`, [name]);
    for (let i = 1; i <= 3; i += 1) await save('demo ' + i);
    const fourthDemo = await save('demo 4');
    check(!fourthDemo.ok && /DEMO_SAVE_LIMIT/.test(fourthDemo.message), 'demo: the 4th saved calculation is refused');
    await setPaidUntil(ORG, `now() + interval '1 month'`);
    const paid = await save('paid 4');
    const paid2 = await save('paid 5');
    check(paid.ok && paid2.ok, 'paid: saving is not limited');
    await setPaidUntil(ORG, `now() - interval '1 minute'`);
    const afterExpiry = await save('after expiry');
    const kept = await as(OWNER, 'SELECT count(*)::int AS c FROM public.calculations');
    check(!afterExpiry.ok && /DEMO_SAVE_LIMIT/.test(afterExpiry.message) && kept.rows[0].c === 5,
        'after paid_until: demo limit is back, all 5 calculations are kept');
}

// A disabled member of a paid company is not approved; clients cannot call org_has_paid_access.
{
    await setPaidUntil(ORG, `now() + interval '20 days'`);
    await db.exec(`UPDATE public.profiles SET member_status = 'disabled' WHERE id = '${LOGIST}'`);
    check(await approved(LOGIST) === false, 'disabled member of a paid company: current_is_approved false');
    await db.exec(`UPDATE public.profiles SET member_status = 'active' WHERE id = '${LOGIST}'`);
    check(await approved(LOGIST) === true, 'active again: true');
    const direct = await as(OWNER, `SELECT public.org_has_paid_access('${ORG}')`);
    check(!direct.ok && direct.code === '42501', 'authenticated cannot call org_has_paid_access (42501)');
}

// org_has_user_data: a company with payments or a subscription row is kept by accept_org_invite.
{
    const empty = '80000000-0000-0000-0000-0000000000a1';
    const paidOnly = '80000000-0000-0000-0000-0000000000a2';
    const subOnly = '80000000-0000-0000-0000-0000000000a3';
    const someone = '00000000-0000-0000-0000-0000000000f1';
    await db.exec(`INSERT INTO public.organizations (id, name) VALUES ('${empty}', 'e'), ('${paidOnly}', 'p'), ('${subOnly}', 's')`);
    await payment(paidOnly, 'month', someone);
    await db.exec(`INSERT INTO public.org_subscriptions (org_id, paid_until) VALUES ('${subOnly}', now() - interval '1 year')`);
    const has = async (org) => (await one('SELECT public.org_has_user_data($1, $2) AS h', [org, someone])).h;
    check(await has(empty) === false, 'org_has_user_data: empty company → no data');
    check(await has(paidOnly) === true, 'org_has_user_data: company with a payment → has data');
    check(await has(subOnly) === true, 'org_has_user_data: company with a subscription (even expired) → has data');
}

// The owner cannot extend paid_until through organizations either (no such column there).
{
    const res = await as(OWNER, `UPDATE public.organizations SET name = 'Агро' WHERE id = '${ORG}' RETURNING id`);
    const cols = await one(`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'paid_until'`);
    check(res.ok && cols.c === 0, 'paid_until is not on organizations (owner UPDATE there cannot touch it)');
}

if (failed) {
    console.log(failed + ' check(s) failed');
    process.exit(1);
}
console.log('all payments checks passed');
