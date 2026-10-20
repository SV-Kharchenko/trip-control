// Checks supabase/migrations/20261020180000_refund_cut.sql on a real Postgres (PGlite, in memory),
// on top of 20261018190000_payments.sql. Nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-refund-cut.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const payments = fs.readFileSync(new URL('../supabase/migrations/20261018190000_payments.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261020180000_refund_cut.sql', import.meta.url), 'utf8');
const db = new PGlite();

const ORG = '10000000-0000-4000-8000-000000000001';
const APPROVED_ORG = '10000000-0000-4000-8000-000000000003';
const OWNER = '00000000-0000-4000-8000-000000000001';
const APPROVED = '00000000-0000-4000-8000-000000000004';

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
CREATE TABLE public.company_settings (org_id uuid PRIMARY KEY, settings jsonb);
CREATE TABLE public.org_company_profiles (org_id uuid PRIMARY KEY, ownership text, phone text, lang text,
  updated_at timestamptz, updated_by uuid);

CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.org_id FROM public.profiles AS p JOIN public.organizations AS o ON o.id = p.org_id
  WHERE p.id = auth.uid() AND p.member_status = 'active' AND o.status <> 'blocked' LIMIT 1 $$;
CREATE FUNCTION public.is_org_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = auth.uid() AND p.org_role = 'owner') $$;
CREATE FUNCTION public.current_is_approved() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT is_approved FROM public.profiles WHERE id = auth.uid() LIMIT 1), false) $$;
GRANT EXECUTE ON FUNCTION public.current_org_id(), public.is_org_owner(), public.current_is_approved() TO authenticated, service_role;

INSERT INTO public.organizations (id, name) VALUES ('${ORG}', 'Агро'), ('${APPROVED_ORG}', 'Схвалена');
INSERT INTO public.profiles (id, org_id, org_role, is_approved) VALUES
  ('${OWNER}', '${ORG}', 'owner', false),
  ('${APPROVED}', '${APPROVED_ORG}', 'owner', true);
`);

await db.exec(payments);

// Before this migration (production today): a credited payment refunded through apply_payment_status
// (status only, paid_until corrected by hand), one refunded by hand, one still pending.
const LEGACY_ORG = '10000000-0000-4000-8000-000000000009';
await db.exec(`INSERT INTO public.organizations (id, name) VALUES ('${LEGACY_ORG}', 'Стара');`);
async function legacyPayment(status) {
    const { rows } = await db.query(
        `INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, status, provider_order_id)
         VALUES ($1, $2, 'wayforpay', 'month', 25000, 'pending', $3) RETURNING id`, [LEGACY_ORG, OWNER, 'tc-legacy-' + status]);
    const id = rows[0].id;
    if (status !== 'pending') {
        await db.query('SELECT public.apply_payment_success($1, null)', [id]);
        await db.query(`SELECT public.apply_payment_status($1, 'reversed', null)`, [id]);
        if (status === 'refunded') await db.query(`UPDATE public.payments SET status = 'refunded' WHERE id = $1`, [id]);
    }
    await db.query(`UPDATE public.payments SET updated_at = now() - interval '3 days' WHERE id = $1`, [id]);
    return id;
}
const legacyReversed = await legacyPayment('reversed');
const legacyRefunded = await legacyPayment('refunded');
const legacyPending = await legacyPayment('pending');
// Two credited months, one of them refunded before the migration: paid_until is what it is now.
await db.exec(`UPDATE public.org_subscriptions SET paid_until = now() + interval '20 days' WHERE org_id = '${LEGACY_ORG}'`);

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);
await db.exec(`SET TIME ZONE 'UTC'`);

let failed = 0;
function check(ok, label) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed += 1;
}
async function one(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}
async function as(user, sql, params = []) {
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await db.exec('SET ROLE authenticated');
    try {
        const { rows } = await db.query(sql, params);
        return { ok: true, rows };
    } catch (error) {
        return { ok: false, rows: [], code: error.code };
    } finally {
        await db.exec('RESET ROLE');
    }
}

let n = 0;
async function payment(org = ORG, plan = 'month') {
    n += 1;
    const { rows } = await db.query(
        `INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, status, provider_order_id)
         VALUES ($1, $2, 'wayforpay', $3, $4, 'pending', $5) RETURNING id`,
        [org, OWNER, plan, plan === 'year' ? 250000 : 25000, 'tc-order-' + n]);
    return rows[0].id;
}
const credit = async (id, modified = null) => (await one('SELECT public.apply_payment_success($1, $2) AS r', [id, modified])).r;
const reverse = async (id, modified = null, partial = false) =>
    (await one('SELECT public.apply_payment_reversal($1, $2, $3) AS r', [id, modified, partial])).r;
const paidUntil = async (org = ORG) => (await one('SELECT paid_until FROM public.org_subscriptions WHERE org_id = $1', [org]))?.paid_until?.getTime() ?? null;
const row = (id) => one('SELECT status, credited_at, reversal_applied_at, period_from, period_to FROM public.payments WHERE id = $1', [id]);
const setPaidUntil = (sql, org = ORG) => db.exec(`INSERT INTO public.org_subscriptions (org_id, paid_until) VALUES ('${org}', ${sql})
  ON CONFLICT (org_id) DO UPDATE SET paid_until = EXCLUDED.paid_until`);
const nowMs = async () => (await one('SELECT now() AS t')).t.getTime();
const near = (a, b) => Math.abs(a - b) < 60 * 1000;

check((await one(`SELECT count(*)::int AS c FROM information_schema.columns
  WHERE table_name = 'payments' AND column_name = 'reversal_applied_at'`)).c === 1, 'payments.reversal_applied_at exists');
check((await one(`SELECT count(*)::int AS c FROM information_schema.columns
  WHERE table_name = 'payments' AND column_name = 'partial_refund_alerted_at'`)).c === 1, 'payments.partial_refund_alerted_at exists');

// Backfill: refunds from before the migration are handled; an old refund notification changes nothing.
{
    const mark = async (id) => one('SELECT reversal_applied_at, updated_at FROM public.payments WHERE id = $1', [id]);
    const r = await mark(legacyReversed);
    const f = await mark(legacyRefunded);
    const pnd = await mark(legacyPending);
    check(r.reversal_applied_at !== null && r.reversal_applied_at.getTime() === r.updated_at.getTime(),
        'backfill: reversed before the migration → reversal_applied_at = updated_at');
    check(f.reversal_applied_at !== null, 'backfill: refunded by hand → marked');
    check(pnd.reversal_applied_at === null, 'backfill: pending payment untouched');
    const before = await paidUntil(LEGACY_ORG);
    const again = await reverse(legacyReversed, null, false);
    check(again.changed === false && again.cut === false && (await paidUntil(LEGACY_ORG)) === before,
        'old refund notified again after the migration: no second cut, no change (so no alert)');
}

// 1. Only monthly payment refunded: access ends now.
{
    await db.exec(`DELETE FROM public.org_subscriptions`);
    const p = await payment();
    await credit(p);
    const r = await reverse(p, new Date(Date.now() + 1000).toISOString());
    const after = await row(p);
    check(r.changed === true && r.cut === true && r.credited === true, 'full refund of a credited payment: changed, cut');
    check(near(await paidUntil(), await nowMs()), 'one month refunded: paid_until = now() (not below)');
    check(after.status === 'reversed' && after.reversal_applied_at !== null, 'status reversed, reversal_applied_at set');

    // 3. Same refund again: nothing changes.
    const until = await paidUntil();
    const again = await reverse(p, new Date(Date.now() + 2000).toISOString());
    const later = await row(p);
    check(again.changed === false && again.cut === false && (await paidUntil()) === until
        && later.reversal_applied_at.getTime() === after.reversal_applied_at.getTime(), 'repeated refund: nothing changes');
}

// 2. Two months ahead, one refunded: the other stays.
{
    await db.exec(`DELETE FROM public.org_subscriptions`);
    const a = await payment();
    await credit(a);
    const b = await payment();
    await credit(b);
    const before = await paidUntil();
    const ra = await row(a);
    const rb = await row(b);
    await reverse(a);
    const length = ra.period_to.getTime() - ra.period_from.getTime();
    check((await paidUntil()) === before - length, 'one of two refunded: paid_until − exactly that payment\'s period');
    check((await paidUntil()) - (await nowMs()) > rb.period_to.getTime() - rb.period_from.getTime() - 60 * 1000,
        'the second paid period is still there in full');
    check((await row(b)).status === 'success', 'the other payment is untouched');
}

// 3b. Year refunded when only a few days of it are left: not below now().
{
    await db.exec(`DELETE FROM public.org_subscriptions`);
    const y = await payment(ORG, 'year');
    await credit(y);
    await setPaidUntil(`now() + interval '5 days'`);
    await reverse(y);
    check(near(await paidUntil(), await nowMs()), 'period longer than what is left: paid_until = now()');
}

// 3c. Already expired subscription is never moved forward to now().
{
    const p = await payment();
    await credit(p);
    await setPaidUntil(`now() - interval '40 days'`);
    const before = await paidUntil();
    await reverse(p);
    check((await paidUntil()) === before, 'expired paid_until stays as it is (never extended by a refund)');
}

// 4. Partial refund: period unchanged; later full refund cuts once.
{
    await db.exec(`DELETE FROM public.org_subscriptions`);
    const p = await payment();
    await credit(p);
    const before = await paidUntil();
    const r = await reverse(p, null, true);
    check(r.changed === true && r.cut === false && r.partial === true && (await paidUntil()) === before
        && (await row(p)).status === 'reversed' && (await row(p)).reversal_applied_at === null, 'partial refund: status reversed, paid_until unchanged');
    const dup = await reverse(p, null, true);
    check(dup.changed === false && (await paidUntil()) === before, 'partial refund again: nothing');
    const full = await reverse(p, null, false);
    check(full.changed === true && full.cut === true && near(await paidUntil(), await nowMs()), 'later full refund: cut once');
    const again = await reverse(p, null, false);
    check(again.changed === false, 'full refund again: nothing');
}

// 5. Payment never credited: only the status.
{
    await setPaidUntil(`now() + interval '20 days'`);
    const before = await paidUntil();
    const p = await payment();
    const r = await reverse(p);
    const after = await row(p);
    check(r.changed === true && r.cut === false && r.credited === false && after.status === 'reversed'
        && after.reversal_applied_at === null && (await paidUntil()) === before, 'pending payment refunded: reversed, subscription unchanged');
}

// 6. Order and manual refunds.
{
    await db.exec(`DELETE FROM public.org_subscriptions`);
    const p = await payment();
    await credit(p, '2026-10-20T10:00:00Z');
    const before = await paidUntil();
    const old = await reverse(p, '2026-10-20T09:00:00Z');
    check(old.changed === false && (await paidUntil()) === before, 'refund older than the success notification: ignored');
    await db.query(`UPDATE public.payments SET status = 'refunded' WHERE id = $1`, [p]);
    const manual = await reverse(p, '2026-10-21T10:00:00Z');
    check(manual.changed === false && (await paidUntil()) === before && (await row(p)).status === 'refunded',
        'payment refunded by hand: left as it is');
}

// 7. Access: only service_role; manual is_approved untouched.
{
    const p = await payment();
    const direct = await as(OWNER, 'SELECT public.apply_payment_reversal($1, null, false)', [p]);
    check(!direct.ok && direct.code === '42501', 'authenticated cannot call apply_payment_reversal (42501)');
    const ap = await payment(APPROVED_ORG);
    await credit(ap);
    await reverse(ap);
    const approved = await as(APPROVED, 'SELECT public.current_is_approved() AS a');
    const flag = await one('SELECT is_approved FROM public.profiles WHERE id = $1', [APPROVED]);
    check(approved.rows[0].a === true && flag.is_approved === true, 'manual is_approved: still full access after its payment is refunded');
}

console.log(failed ? failed + ' check(s) failed' : 'all refund-cut checks passed');
process.exit(failed ? 1 : 0);
