// Checks supabase/migrations/20261020200000_auto_renew.sql on a real Postgres (PGlite, in memory),
// on top of 20261018190000_payments.sql and 20261020180000_refund_cut.sql. Nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-auto-renew.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261020200000_auto_renew.sql', import.meta.url), 'utf8');
const db = new PGlite();

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER_ORG = '10000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000001';
const LOGIST = '00000000-0000-4000-8000-000000000002';

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

INSERT INTO public.organizations (id, name) VALUES ('${ORG}', 'Агро'), ('${OTHER_ORG}', 'Інша');
INSERT INTO public.profiles (id, org_id, org_role) VALUES
  ('${OWNER}', '${ORG}', 'owner'),
  ('${LOGIST}', '${ORG}', 'logist');
`);

await db.exec(read('20261018190000_payments.sql'));
await db.exec(read('20261020180000_refund_cut.sql'));
// A payment made before this migration: it becomes kind = 'initial'.
await db.exec(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, status, provider_order_id)
  VALUES ('${ORG}', '${OWNER}', 'wayforpay', 'month', 25000, 'pending', 'tc-before')`);
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
        return { ok: false, rows: [], code: error.code };
    } finally {
        await db.exec('RESET ROLE');
    }
}
async function one(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}
async function attempt(sql, params = []) {
    try {
        await db.query(sql, params);
        return { ok: true };
    } catch (error) {
        return { ok: false, code: error.code };
    }
}
async function insertPayment(ref, extra = {}) {
    const { rows } = await db.query(
        `INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, status, provider_order_id, kind, parent_payment_id)
         VALUES ($1, $2, 'wayforpay', 'month', 25000, 'pending', $3, $4, $5) RETURNING id`,
        [extra.org || ORG, OWNER, ref, extra.kind || 'initial', extra.parent || null]);
    return rows[0].id;
}

try {
    const before = await one(`SELECT kind, parent_payment_id, auto_renew_requested_at FROM public.payments WHERE provider_order_id = 'tc-before'`);
    check(before.kind === 'initial' && before.parent_payment_id === null && before.auto_renew_requested_at === null,
        'existing payments become kind initial, no parent');

    const parent = await insertPayment('tc-parent');
    await db.query(`UPDATE public.payments SET auto_renew_requested_at = now() WHERE id = $1`, [parent]);
    await db.query('SELECT public.apply_payment_success($1, null)', [parent]);
    const sub = await one(`SELECT auto_renew, fail_count, card_mask, wfp_regular_order_ref, next_charge_at, regular_status,
        auto_renew_consent_at, auto_renew_cancelled_at FROM public.org_subscriptions WHERE org_id = $1`, [ORG]);
    check(sub.auto_renew === false && sub.fail_count === 0 && sub.card_mask === null && sub.wfp_regular_order_ref === null
        && sub.next_charge_at === null && sub.regular_status === null && sub.auto_renew_consent_at === null
        && sub.auto_renew_cancelled_at === null, 'org_subscriptions: auto_renew false, fail_count 0, the rest empty by default');

    const renewal = await insertPayment('tc-parent_WFPREG-123456', { kind: 'renewal', parent });
    check(!!renewal, 'renewal row with parent_payment_id and the _WFPREG- reference');
    const untilBefore = (await one(`SELECT paid_until FROM public.org_subscriptions WHERE org_id = $1`, [ORG])).paid_until;
    await db.query('SELECT public.apply_payment_success($1, null)', [renewal]);
    await db.query('SELECT public.apply_payment_success($1, null)', [renewal]);
    const untilAfter = (await one(`SELECT paid_until FROM public.org_subscriptions WHERE org_id = $1`, [ORG])).paid_until;
    const days = Math.round((untilAfter - untilBefore) / 86400000);
    check(days >= 28 && days <= 31, 'renewal credited by apply_payment_success, twice = one month (' + days + ' days)');

    const dup = await attempt(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id, kind, parent_payment_id)
        VALUES ($1, $2, 'wayforpay', 'month', 25000, 'tc-parent_WFPREG-123456', 'renewal', $3)`, [ORG, OWNER, parent]);
    check(!dup.ok && dup.code === '23505', 'same _WFPREG- reference twice: unique violation (23505)');
    const second = await attempt(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id, kind, parent_payment_id)
        VALUES ($1, $2, 'wayforpay', 'month', 25000, 'tc-parent_WFPREG-777', 'renewal', $3)`, [ORG, OWNER, parent]);
    check(second.ok, 'another charge of the same regular: new reference, inserted');

    const orphan = await attempt(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id, kind)
        VALUES ($1, $2, 'wayforpay', 'month', 25000, 'tc-orphan_WFPREG-1', 'renewal')`, [ORG, OWNER]);
    check(!orphan.ok && orphan.code === '23514', 'renewal without parent_payment_id: check violation (23514)');
    const badKind = await attempt(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id, kind)
        VALUES ($1, $2, 'wayforpay', 'month', 25000, 'tc-bad-kind', 'gift')`, [ORG, OWNER]);
    check(!badKind.ok && badKind.code === '23514', 'kind other than initial / renewal: check violation (23514)');
    const initialWithParent = await attempt(`INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id, kind, parent_payment_id)
        VALUES ($1, $2, 'wayforpay', 'month', 25000, 'tc-initial-parent', 'initial', $3)`, [ORG, OWNER, parent]);
    check(!initialWithParent.ok && initialWithParent.code === '23514', 'initial payment with a parent: check violation (23514)');

    const orphanEvent = await attempt(`INSERT INTO public.payment_events (payment_id, order_reference, provider, status, source, payload)
        VALUES (null, 'tc-x_WFPREG-1', 'wayforpay', 'Approved', 'webhook', '{"amount": 250}'::jsonb)`);
    check(orphanEvent.ok, 'payment_events: unmatched renewal event without payment_id, with order_reference');
    const emptyEvent = await attempt(`INSERT INTO public.payment_events (payment_id, provider, status, source)
        VALUES (null, 'wayforpay', 'Approved', 'webhook')`);
    check(!emptyEvent.ok && emptyEvent.code === '23514', 'payment_events: neither payment_id nor order_reference → check violation (23514)');
    const eventsRead = await as(OWNER, `SELECT id FROM public.payment_events`);
    check(!eventsRead.ok && eventsRead.code === '42501', 'payment_events: still no client access (42501)');

    check((await one('SELECT public.record_renewal_failure($1) AS n', [ORG])).n === 1, 'record_renewal_failure: 1');
    check((await one('SELECT public.record_renewal_failure($1) AS n', [ORG])).n === 2, 'record_renewal_failure: 2');
    check((await one('SELECT public.record_renewal_failure($1) AS n', [OTHER_ORG])).n === 0, 'record_renewal_failure: company without a subscription → 0');

    // Clients: paid_until stays readable, auto-renewal columns and writes do not.
    const paid = await as(OWNER, `SELECT paid_until FROM public.org_subscriptions`);
    check(paid.ok && paid.rows.length === 1, 'owner still reads paid_until of own company');
    const logistPaid = await as(LOGIST, `SELECT org_id, paid_until, last_plan FROM public.org_subscriptions`);
    check(logistPaid.ok && logistPaid.rows.length === 1, 'logist still reads paid_until of own company');
    for (const column of ['card_mask', 'auto_renew', 'wfp_regular_order_ref', 'fail_count', 'next_charge_at']) {
        const res = await as(OWNER, `SELECT ${column} FROM public.org_subscriptions`);
        check(!res.ok && res.code === '42501', 'authenticated cannot read org_subscriptions.' + column + ' (42501)');
    }
    const star = await as(OWNER, `SELECT * FROM public.org_subscriptions`);
    check(!star.ok && star.code === '42501', 'authenticated cannot SELECT * from org_subscriptions (42501)');
    for (const [label, sql] of [
        ['update org_subscriptions.auto_renew', `UPDATE public.org_subscriptions SET auto_renew = true`],
        ['update org_subscriptions.fail_count', `UPDATE public.org_subscriptions SET fail_count = 0`],
        ['insert org_subscriptions', `INSERT INTO public.org_subscriptions (org_id, auto_renew) VALUES ('${OTHER_ORG}', true)`],
        ['update payments.kind', `UPDATE public.payments SET kind = 'renewal'`],
        ['update payments.auto_renew_requested_at', `UPDATE public.payments SET auto_renew_requested_at = now()`],
        ['insert payments', `INSERT INTO public.payments (org_id, created_by, provider, plan, amount_minor, provider_order_id)
            VALUES ('${ORG}', '${OWNER}', 'wayforpay', 'month', 1, 'tc-client')`],
        ['call record_renewal_failure', `SELECT public.record_renewal_failure('${ORG}')`]
    ]) {
        const res = await as(OWNER, sql);
        check(!res.ok && res.code === '42501', 'authenticated cannot ' + label + ' (42501)');
    }
    const ownerPayments = await as(OWNER, `SELECT kind, parent_payment_id FROM public.payments WHERE provider_order_id = 'tc-parent_WFPREG-123456'`);
    check(ownerPayments.ok && ownerPayments.rows.length === 1 && ownerPayments.rows[0].kind === 'renewal', 'owner sees renewal payments of own company');
    const logistPayments = await as(LOGIST, `SELECT id FROM public.payments`);
    check(logistPayments.ok && logistPayments.rows.length === 0, 'logist still does not see payments');
} catch (error) {
    console.log('FAIL unexpected error: ' + (error && error.message));
    failed += 1;
}

if (failed) {
    console.log(failed + ' auto-renew check(s) failed');
    process.exit(1);
}
console.log('all auto-renew checks passed');
