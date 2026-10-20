import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createBillingHandler, isPartialRefund, paymentAlertText, refundMinor } from '../lib/billing/service.js';
import { LEGAL_VERSION } from '../lib/legal.js';
import { baseEnv, DAY, fakeNet, memoryStore, monoKeyPair, NOW, ORG, request, response, WFP_MERCHANT, WFP_SECRET } from './billing-fakes.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function world() {
    const clock = { now: NOW };
    const key = monoKeyPair();
    const net = fakeNet({ monoKeyBase64: key.base64 });
    const store = memoryStore(clock);
    const env = baseEnv({ MONO_PUBKEY: key.base64 });
    const handler = createBillingHandler({ store, fetch: net.fetch, env, now: () => clock.now });
    async function call(method, route, options) {
        const res = response();
        await handler(request(method, route, options), res);
        return res;
    }
    async function pay(provider = 'wayforpay', plan = 'month') {
        const res = await call('POST', 'create-invoice', { token: 'owner', body: { plan, provider, consent: true, legal_version: LEGAL_VERSION } });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        return store.db.payments.find((p) => p.id === res.body.payment_id);
    }
    function wfp(payment, fields) {
        const body = Object.assign({
            merchantAccount: WFP_MERCHANT, orderReference: payment.provider_order_id, currency: 'UAH', authCode: '541963',
            cardPan: '41****8217', reasonCode: 1100, processingDate: Math.floor(clock.now / 1000)
        }, fields);
        body.merchantSignature = crypto.createHmac('md5', WFP_SECRET).update([
            body.merchantAccount, body.orderReference, body.amount, body.currency, body.authCode, body.cardPan, body.transactionStatus, body.reasonCode
        ].join(';'), 'utf8').digest('hex');
        return call('POST', 'wayforpay-webhook', { raw: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    }
    async function monoHook(payment, fields) {
        const raw = JSON.stringify(Object.assign({
            invoiceId: payment.provider_invoice_id, reference: payment.id, amount: payment.amount_minor, ccy: 980,
            modifiedDate: new Date(clock.now).toISOString()
        }, fields));
        return call('POST', 'mono-webhook', { raw, headers: { 'x-sign': key.sign(raw) } });
    }
    const approve = (payment) => wfp(payment, { amount: 250, transactionStatus: 'Approved' });
    const until = () => (store.db.subs[ORG] || {}).paid_until || null;
    const refunds = () => net.telegrams().filter((t) => t.startsWith('↩️'));
    return { clock, store, net, call, pay, wfp, monoHook, approve, until, refunds };
}

test('refund of the only monthly payment: access ends (not below now), Telegram says «доступ завершено»', async () => {
    const w = world();
    const p = await w.pay();
    await w.approve(p);
    assert.equal(w.until(), '2026-11-18T09:00:00.000Z');

    w.clock.now = NOW + 2 * DAY;
    const res = await w.wfp(p, { amount: 250, transactionStatus: 'Refunded' });
    assert.equal(res.body.status, 'accept');
    assert.equal(w.until(), new Date(NOW + 2 * DAY).toISOString(), '18.11 − 1 month = 18.10, but not below now');
    const row = w.store.db.payments[0];
    assert.equal(row.status, 'reversed');
    assert.equal(row.reversal_applied_at, new Date(NOW + 2 * DAY).toISOString());
    assert.deepEqual(w.refunds(), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · доступ завершено']);
    assert.equal((await w.call('GET', 'summary', { token: 'owner' })).body.paid, false);
});

test('two months paid ahead, one refunded: the other month stays', async () => {
    const w = world();
    const first = await w.pay();
    await w.approve(first);
    w.clock.now = NOW + DAY;
    const second = await w.pay();
    await w.approve(second);
    assert.equal(w.until(), '2026-12-18T09:00:00.000Z');

    w.clock.now = NOW + 3 * DAY;
    await w.wfp(first, { amount: 250, transactionStatus: 'Refunded' });
    // The first payment covered 18.10–18.11 = 31 days; 18.12 − 31 days = 17.11: the second period (30 days) stays whole.
    assert.equal(w.until(), '2026-11-17T09:00:00.000Z', 'exactly the refunded period taken back');
    assert.equal(w.store.db.payments.find((p) => p.id === second.id).status, 'success');
    assert.deepEqual(w.refunds(), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · оплачено до 17.11.2026']);
    assert.equal((await w.call('GET', 'summary', { token: 'owner' })).body.paid, true);
});

test('the same refund notified again (webhook twice, Voided, status check) changes nothing', async () => {
    const w = world();
    const first = await w.pay();
    await w.approve(first);
    const second = await w.pay();
    await w.approve(second);
    w.clock.now = NOW + DAY;
    const refund = { amount: 250, transactionStatus: 'Refunded' };
    await w.wfp(first, refund);
    const after = w.until();
    const mark = w.store.db.payments.find((p) => p.id === first.id).reversal_applied_at;
    assert.equal(after, '2026-11-17T09:00:00.000Z');

    w.clock.now = NOW + 2 * DAY;
    await w.wfp(first, refund);
    await w.wfp(first, { amount: 250, transactionStatus: 'Voided' });
    w.net.state.wfpCheck = { orderReference: first.provider_order_id, amount: 250, currency: 'UAH', transactionStatus: 'Refunded', processingDate: Math.floor(w.clock.now / 1000) };
    await w.call('GET', 'status', { token: 'owner', query: { pid: first.id } });
    assert.equal(w.until(), after);
    assert.equal(w.store.db.payments.find((p) => p.id === first.id).reversal_applied_at, mark);
    assert.equal(w.refunds().length, 1);

    // mono: reversed twice → one cut, one alert.
    const m = world();
    const p = await m.pay('mono');
    await m.monoHook(p, { status: 'success' });
    m.clock.now = NOW + DAY;
    await m.monoHook(p, { status: 'reversed', finalAmount: 0 });
    await m.monoHook(p, { status: 'reversed', finalAmount: 0 });
    assert.equal(m.until(), new Date(NOW + DAY).toISOString());
    assert.deepEqual(m.refunds(), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · plata by mono · доступ завершено']);
});

test('partial refund: period unchanged, Telegram says it is partial and access is not changed; a later full refund cuts once', async () => {
    const w = world();
    const p = await w.pay();
    await w.approve(p);
    w.clock.now = NOW + DAY;
    await w.wfp(p, { amount: 250, refundAmount: 100, transactionStatus: 'Refunded' });
    assert.equal(w.until(), '2026-11-18T09:00:00.000Z');
    assert.equal(w.store.db.payments[0].status, 'reversed');
    assert.equal(w.store.db.payments[0].reversal_applied_at || null, null);
    assert.deepEqual(w.refunds(), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · повернення часткове (100 грн), доступ не змінено · оплачено до 18.11.2026']);

    // Same partial again: nothing.
    await w.wfp(p, { amount: 250, refundAmount: 100, transactionStatus: 'Refunded' });
    assert.equal(w.refunds().length, 1);

    // The rest refunded later (full amount): the period is taken back once.
    w.clock.now = NOW + 2 * DAY;
    await w.wfp(p, { amount: 250, refundAmount: 250, transactionStatus: 'Refunded' });
    assert.equal(w.until(), new Date(NOW + 2 * DAY).toISOString());
    assert.equal(w.refunds().length, 2);
    assert.match(w.refunds()[1], /· доступ завершено$/);

    // mono: finalAmount left after a partial reversal.
    const m = world();
    const mp = await m.pay('mono');
    await m.monoHook(mp, { status: 'success' });
    m.clock.now = NOW + DAY;
    await m.monoHook(mp, { status: 'reversed', finalAmount: 15000 });
    assert.equal(m.until(), '2026-11-18T09:00:00.000Z');
    assert.deepEqual(m.refunds(), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · plata by mono · повернення часткове (100 грн), доступ не змінено · оплачено до 18.11.2026']);
});

test('refund of a payment that was never credited: status reversed, subscription unchanged', async () => {
    const w = world();
    const paid = await w.pay();
    await w.approve(paid);
    const before = w.until();
    const pending = await w.pay();
    assert.equal(pending.status, 'pending');
    w.clock.now = NOW + DAY;
    await w.wfp(pending, { amount: 250, transactionStatus: 'Voided' });
    const row = w.store.db.payments.find((p) => p.id === pending.id);
    assert.equal(row.status, 'reversed');
    assert.equal(row.credited_at, null);
    assert.equal(row.reversal_applied_at || null, null);
    assert.equal(w.until(), before);
    assert.deepEqual(w.refunds(), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · платіж не був зарахований, доступ не змінено · оплачено до 18.11.2026']);

    // A later Approved for it is older than the reversal → ignored, nothing credited.
    await w.wfp(pending, { amount: 250, transactionStatus: 'Approved', processingDate: Math.floor(NOW / 1000) });
    assert.equal(w.until(), before);

    // No subscription at all.
    const v = world();
    const p = await v.pay();
    await v.wfp(p, { amount: 250, transactionStatus: 'Refunded' });
    assert.equal(v.store.db.payments[0].status, 'reversed');
    assert.equal(v.store.db.subs[ORG], undefined);
});

test('refund amount: mono amount − finalAmount, WayForPay refundAmount or amount; partial only below the payment', () => {
    const payment = { amount_minor: 25000 };
    assert.equal(refundMinor('mono', { amount: 25000, finalAmount: 0 }, payment), 25000);
    assert.equal(refundMinor('mono', { amount: 25000, finalAmount: 15000 }, payment), 10000);
    assert.equal(refundMinor('mono', { amount: 10000 }, payment), 10000);
    assert.equal(refundMinor('wayforpay', { amount: 250, refundAmount: '99.5' }, payment), 9950);
    assert.equal(refundMinor('wayforpay', { amount: '250.00' }, payment), 25000);
    assert.equal(Number.isNaN(refundMinor('wayforpay', {}, payment)), true);
    assert.equal(isPartialRefund(10000, payment), true);
    assert.equal(isPartialRefund(25000, payment), false);
    assert.equal(isPartialRefund(NaN, payment), false, 'no amount → full, by status');
    assert.equal(isPartialRefund(0, payment), false);
    assert.equal(paymentAlertText('reversed', { orgName: 'А', plan: 'year', provider: 'wayforpay', paidUntil: null }),
        '↩️ Повернення: А · 1 рік · 2500 грн · WayForPay · доступ завершено');
    assert.equal(paymentAlertText('success', { orgName: 'А', plan: 'month', provider: 'wayforpay', paidUntil: '2026-11-18T09:00:00Z' }),
        '💳 Оплата: А · 1 місяць · 250 грн · WayForPay · оплачено до 18.11.2026');
});

test('migration: new file, FOR UPDATE, once per payment, not below now(); is_approved and old migrations untouched', () => {
    const sql = read('supabase/migrations/20261020180000_refund_cut.sql');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS reversal_applied_at timestamptz NULL/);
    assert.match(sql, /SELECT \* INTO v_payment FROM public\.payments WHERE id = p_payment FOR UPDATE;/);
    assert.match(sql, /WHERE s\.org_id = v_payment\.org_id\n\s+FOR UPDATE;/);
    assert.match(sql, /least\(v_until, greatest\(now\(\), v_until - \(v_payment\.period_to - v_payment\.period_from\)\)\)/);
    assert.match(sql, /AND v_payment\.reversal_applied_at IS NULL/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.apply_payment_reversal\(uuid, timestamptz, boolean\) TO service_role;/);
    assert.equal(/is_approved/.test(sql.replace(/^--.*$/gm, '')), false);
    assert.match(read('supabase/migrations/20261018190000_payments.sql'), /paid_until is never shortened here \(refunds are handled by hand\)/);
});

test('store: without the refund-cut migration (no function) a refund falls back to the old status-only path', async () => {
    const { createSupabaseStore } = await import('../lib/billing/store.js');
    const calls = [];
    const fake = {
        async rpc(name, args) {
            calls.push([name, args]);
            if (name === 'apply_payment_reversal') return { data: null, error: { code: 'PGRST202', message: 'not found' } };
            return { data: { changed: true, previous: 'success', status: 'reversed' }, error: null };
        }
    };
    const store = createSupabaseStore(fake);
    const result = await store.applyReversal('p1', '2026-10-20T10:00:00Z', false);
    assert.deepEqual(calls, [
        ['apply_payment_reversal', { p_payment: 'p1', p_modified: '2026-10-20T10:00:00Z', p_partial: false }],
        ['apply_payment_status', { p_payment: 'p1', p_status: 'reversed', p_modified: '2026-10-20T10:00:00Z' }]
    ]);
    assert.equal(result.changed, true);
    assert.equal(result.cut, false);
    assert.equal(result.legacy, true);

    const broken = createSupabaseStore({ async rpc() { return { data: null, error: { code: '57014', message: 'timeout' } }; } });
    await assert.rejects(broken.applyReversal('p1', null, false), (e) => e.code === '57014');
});
