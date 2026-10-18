import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createBillingHandler, paymentAlertText, parseWayforpayBody } from '../lib/billing/service.js';
import { LEGAL_VERSION } from '../lib/legal.js';
import {
    baseEnv, DAY, fakeNet, LOGIST, memoryStore, monoKeyPair, NOW, ORG, OTHER_ORG, request, response, WFP_MERCHANT, WFP_SECRET
} from './billing-fakes.mjs';

function world(envExtra = {}, netOptions = {}) {
    const clock = { now: NOW };
    const key = monoKeyPair();
    const net = fakeNet(Object.assign({ monoKeyBase64: key.base64 }, netOptions));
    const store = memoryStore(clock);
    const env = baseEnv(Object.assign({ MONO_PUBKEY: key.base64 }, envExtra));
    const handler = createBillingHandler({ store, fetch: net.fetch, env, now: () => clock.now });
    async function call(method, route, options) {
        const res = response();
        await handler(request(method, route, options), res);
        return res;
    }
    const pay = (body, token = 'owner') => call('POST', 'create-invoice', { token, body });
    const consent = { consent: true, legal_version: LEGAL_VERSION };
    async function monoHook(payload, signWith = key) {
        const raw = JSON.stringify(payload);
        return call('POST', 'mono-webhook', { raw, headers: { 'x-sign': signWith.sign(raw) } });
    }
    function wfpBody(fields) {
        const body = Object.assign({ merchantAccount: WFP_MERCHANT, currency: 'UAH', authCode: '541963', cardPan: '41****8217', reasonCode: 1100 }, fields);
        body.merchantSignature = crypto.createHmac('md5', WFP_SECRET).update([
            body.merchantAccount, body.orderReference, body.amount, body.currency, body.authCode, body.cardPan, body.transactionStatus, body.reasonCode
        ].join(';'), 'utf8').digest('hex');
        return body;
    }
    const wfpHook = (body, contentType = 'application/json') => call('POST', 'wayforpay-webhook', { raw: JSON.stringify(body), headers: { 'content-type': contentType } });
    return { clock, key, net, store, env, call, pay, consent, monoHook, wfpHook, wfpBody };
}

const monoPayment = (w) => w.store.db.payments.find((p) => p.provider === 'mono');

test('create-invoice (mono): amount only from the plan, consent recorded, PRRO basket, pending', async () => {
    const w = world();
    const res = await w.pay(Object.assign({ plan: 'year', provider: 'mono', price: 1, amount: 100, amount_minor: 1 }, w.consent));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.url, /^https:\/\/pay\.mbnk\.biz\/inv_1$/);
    const p = w.store.db.payments[0];
    assert.equal(res.body.payment_id, p.id);
    assert.deepEqual([p.plan, p.amount_minor, p.currency, p.status, p.provider_invoice_id, p.provider_order_id], ['year', 250000, 'UAH', 'pending', 'inv_1', p.id]);
    const sent = JSON.parse(w.net.calls.find((c) => c.url.endsWith('/invoice/create')).body);
    assert.equal(w.net.calls.find((c) => c.url.endsWith('/invoice/create')).headers['X-Token'], 'mono-test-token');
    assert.equal(sent.amount, 250000);
    assert.equal(sent.ccy, 980);
    assert.equal(sent.paymentType, 'debit');
    assert.equal(sent.validity, 3600);
    assert.equal(sent.redirectUrl, 'https://trip-control.com/api/billing/return?pid=' + p.id);
    assert.equal(sent.webHookUrl, 'https://trip-control.com/api/billing/mono-webhook');
    assert.deepEqual(sent.merchantPaymInfo, {
        reference: p.id,
        destination: 'Доступ до сервісу Trip Control, 1 рік',
        comment: 'Доступ до сервісу Trip Control, 1 рік',
        customerEmails: ['owner@agro.ua'],
        basketOrder: [{ name: 'Доступ до онлайн-сервісу Trip Control — тариф 1 рік', qty: 1, sum: 250000, total: 250000, unit: 'посл.', code: 'TC-YEAR' }]
    });
    assert.equal(w.store.db.consents.length, 1);
    assert.deepEqual(
        (({ user_id, org_id, kind, offer_version, privacy_version, payment_id }) => ({ user_id, org_id, kind, offer_version, privacy_version, payment_id }))(w.store.db.consents[0]),
        { user_id: p.created_by, org_id: ORG, kind: 'payment', offer_version: LEGAL_VERSION, privacy_version: LEGAL_VERSION, payment_id: p.id }
    );
});

test('create-invoice (WayForPay): offline url; CREATE_INVOICE fallback when offline is not answered', async () => {
    const w = world();
    const res = await w.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, w.consent));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.url, 'https://secure.wayforpay.com/page?vkh=abc123');
    const call = w.net.calls.find((c) => c.url.includes('behavior=offline'));
    assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    assert.equal(form.get('amount'), '250');
    assert.deepEqual(form.getAll('productName[]'), ['Доступ до онлайн-сервісу Trip Control — тариф 1 місяць']);
    assert.equal(form.get('orderReference'), 'tc-' + res.body.payment_id);
    assert.equal(w.store.db.payments[0].status, 'pending');

    const f = world({}, { wfpOffline: false });
    const fb = await f.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, f.consent));
    assert.equal(fb.statusCode, 200);
    assert.equal(fb.body.url, 'https://secure.wayforpay.com/invoice/i123');
    const inv = JSON.parse(f.net.calls.find((c) => c.url === 'https://api.wayforpay.com/api').body);
    assert.equal(inv.transactionType, 'CREATE_INVOICE');
    assert.equal(inv.apiVersion, 1);
    assert.equal(inv.returnUrl, undefined);
    assert.equal(inv.amount, '250');
});

test('create-invoice refuses: not owner 403, no consent 400, old legal version 400, bad plan 400, disabled 503, provider without env 503', async () => {
    const w = world();
    const body = Object.assign({ plan: 'month', provider: 'mono' }, w.consent);
    assert.equal((await w.pay(body, 'logist')).statusCode, 403);
    assert.equal((await w.pay(body, 'logist')).body.code, 'OWNER_ONLY');
    assert.equal((await w.pay(body, null)).statusCode, 401);
    assert.equal((await w.pay({ plan: 'month', provider: 'mono' })).statusCode, 400);
    assert.equal((await w.pay({ plan: 'month', provider: 'mono', consent: 'true', legal_version: LEGAL_VERSION })).statusCode, 400);
    assert.equal((await w.pay({ plan: 'month', provider: 'mono', consent: true, legal_version: '2020-01-01' })).body.code, 'CONSENT_REQUIRED');
    assert.equal((await w.pay(Object.assign({}, body, { plan: 'week' }))).body.code, 'BAD_PLAN');
    assert.equal((await w.pay(Object.assign({}, body, { provider: 'liq' + 'pay' }))).body.code, 'BAD_PROVIDER');
    assert.equal(w.store.db.payments.length, 0, 'nothing created');

    w.store.db.orgs[ORG].status = 'blocked';
    assert.equal((await w.pay(body)).statusCode, 403);
    w.store.db.orgs[ORG].status = 'active';
    w.store.db.users.owner.banned_until = new Date(NOW + DAY).toISOString();
    assert.equal((await w.pay(body)).body.code, 'USER_BLOCKED');

    const off = world({ PAYMENTS_ENABLED: '0' });
    const disabled = await off.pay(body);
    assert.equal(disabled.statusCode, 503);
    assert.equal(disabled.body.error, 'Оплата тимчасово недоступна.');
    const noMono = world({ MONO_TOKEN: '' });
    assert.equal((await noMono.pay(body)).body.code, 'PROVIDER_UNAVAILABLE');
    const noBase = world({ PUBLIC_BASE_URL: '' });
    assert.equal((await noBase.pay(body)).statusCode, 503);
    assert.equal(off.store.db.payments.length + noMono.store.db.payments.length + noBase.store.db.payments.length, 0);
});

test('create-invoice: at most 10 invoices per company per hour', async () => {
    const w = world();
    const body = Object.assign({ plan: 'month', provider: 'mono' }, w.consent);
    for (let i = 0; i < 10; i += 1) assert.equal((await w.pay(body)).statusCode, 200);
    const eleventh = await w.pay(body);
    assert.equal(eleventh.statusCode, 429);
    w.clock.now += 61 * 60 * 1000;
    assert.equal((await w.pay(body)).statusCode, 200);
});

test('mono webhook: success twice → one extension, one Telegram alert with exactly 5 fields', async () => {
    const w = world();
    await w.pay(Object.assign({ plan: 'month', provider: 'mono' }, w.consent));
    const p = monoPayment(w);
    const hook = {
        invoiceId: 'inv_1', reference: p.id, status: 'success', amount: 25000, ccy: 980, finalAmount: 25000,
        modifiedDate: '2026-10-18T09:05:00Z', paymentInfo: { maskedPan: '444403******1902', paymentMethod: 'pan', rrn: '1', approvalCode: 'x' }
    };
    const first = await w.monoHook(hook);
    const second = await w.monoHook(hook);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(w.store.db.subs[ORG].paid_until, '2026-11-18T09:00:00.000Z', 'max(now, paid_until) + 1 month, once');
    assert.equal(w.store.db.payments[0].status, 'success');
    const alerts = w.net.telegrams();
    assert.deepEqual(alerts, ['💳 Оплата: ТОВ «Агро» · 1 місяць · 250 грн · plata by mono · оплачено до 18.11.2026']);
    assert.equal(/@|\*{3}|4444|1902|owner/.test(alerts[0]), false, 'no email, card or payer id');
    assert.equal(w.store.db.events.length, 2);
    assert.deepEqual(w.store.db.events[0].payload, {
        status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z', paymentMethod: 'pan', maskedPan: '444403******1902'
    });
    assert.equal(w.store.db.events[0].signature_ok, true);
    assert.equal(w.store.db.events[0].source, 'webhook');
});

test('mono webhook: older modifiedDate after a newer one is ignored; amount/ccy mismatch is not credited', async () => {
    const w = world();
    await w.pay(Object.assign({ plan: 'month', provider: 'mono' }, w.consent));
    const p = monoPayment(w);
    const base = { invoiceId: 'inv_1', reference: p.id, amount: 25000, ccy: 980 };
    await w.monoHook(Object.assign({ status: 'failure', modifiedDate: '2026-10-18T09:10:00Z' }, base));
    await w.monoHook(Object.assign({ status: 'processing', modifiedDate: '2026-10-18T09:01:00Z' }, base));
    assert.equal(w.store.db.payments[0].status, 'failure');
    await w.monoHook(Object.assign({ status: 'success', modifiedDate: '2026-10-18T09:05:00Z' }, base));
    assert.equal(w.store.db.subs[ORG], undefined, 'older success after failure is not credited');

    const m = world();
    await m.pay(Object.assign({ plan: 'month', provider: 'mono' }, m.consent));
    const q = monoPayment(m);
    await m.monoHook({ invoiceId: 'inv_1', reference: q.id, status: 'success', amount: 100, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' });
    await m.monoHook({ invoiceId: 'inv_1', reference: q.id, status: 'success', amount: 25000, ccy: 840, modifiedDate: '2026-10-18T09:06:00Z' });
    assert.equal(m.store.db.subs[ORG], undefined);
    assert.equal(m.store.db.payments[0].status, 'pending');
    assert.equal(m.store.db.events.length, 2, 'events still recorded');
    assert.deepEqual(m.net.telegrams(), []);
});

test('mono webhook: invalid signature → 401, nothing written; reversed → recorded, alert, paid_until kept', async () => {
    const w = world();
    await w.pay(Object.assign({ plan: 'month', provider: 'mono' }, w.consent));
    const p = monoPayment(w);
    const hook = { invoiceId: 'inv_1', reference: p.id, status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' };
    const forged = await w.monoHook(hook, monoKeyPair());
    assert.equal(forged.statusCode, 401);
    const raw = JSON.stringify(hook);
    const tampered = await w.call('POST', 'mono-webhook', { raw: raw.replace('25000', '25001'), headers: { 'x-sign': w.key.sign(raw) } });
    assert.equal(tampered.statusCode, 401);
    assert.equal((await w.call('POST', 'mono-webhook', { raw })).statusCode, 401, 'no x-sign');
    assert.equal(w.store.db.events.length, 0);
    assert.equal(w.store.db.payments[0].status, 'pending');

    await w.monoHook(hook);
    const until = w.store.db.subs[ORG].paid_until;
    await w.monoHook(Object.assign({}, hook, { status: 'reversed', modifiedDate: '2026-10-19T10:00:00Z' }));
    await w.monoHook(Object.assign({}, hook, { status: 'reversed', modifiedDate: '2026-10-19T10:00:00Z' }));
    assert.equal(w.store.db.payments[0].status, 'reversed');
    assert.equal(w.store.db.subs[ORG].paid_until, until, 'not shortened automatically');
    assert.deepEqual(w.net.telegrams().slice(1), ['↩️ Повернення: ТОВ «Агро» · 1 місяць · 250 грн · plata by mono · оплачено до 18.11.2026']);
});

test('WayForPay webhook: accept JSON always on a valid request; Approved credits once; form-urlencoded body; bad signature 401', async () => {
    const w = world();
    const created = await w.pay(Object.assign({ plan: 'year', provider: 'wayforpay' }, w.consent));
    const ref = 'tc-' + created.body.payment_id;
    const ok = w.wfpBody({ orderReference: ref, amount: 2500, transactionStatus: 'Approved', processingDate: 1760778300 });
    const r1 = await w.wfpHook(ok);
    const r2 = await w.wfpHook(ok, 'application/x-www-form-urlencoded');
    for (const r of [r1, r2]) {
        assert.equal(r.statusCode, 200);
        assert.deepEqual(Object.keys(r.body).sort(), ['orderReference', 'signature', 'status', 'time']);
        assert.equal(r.body.orderReference, ref);
        assert.equal(r.body.status, 'accept');
        assert.equal(r.body.time, Math.floor(NOW / 1000));
        assert.equal(r.body.signature, crypto.createHmac('md5', WFP_SECRET).update(ref + ';accept;' + r.body.time).digest('hex'));
    }
    assert.equal(w.store.db.subs[ORG].paid_until, '2027-10-18T09:00:00.000Z', 'year: + 1 year, once');
    assert.deepEqual(w.net.telegrams(), ['💳 Оплата: ТОВ «Агро» · 1 рік · 2500 грн · WayForPay · оплачено до 18.10.2027']);

    const bad = Object.assign({}, ok, { merchantSignature: 'f'.repeat(32) });
    const r3 = await w.wfpHook(bad);
    assert.equal(r3.statusCode, 401);
    assert.notEqual(r3.body.status, 'accept');
    assert.equal(w.store.db.events.length, 2);

    // Mismatched amount: accepted (no retries) but not credited.
    const m = world();
    const mc = await m.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, m.consent));
    const wrong = m.wfpBody({ orderReference: 'tc-' + mc.body.payment_id, amount: 1, transactionStatus: 'Approved' });
    assert.equal((await m.wfpHook(wrong)).body.status, 'accept');
    assert.equal(m.store.db.subs[ORG], undefined);

    // Declined / Refunded mapping.
    const d = world();
    const dc = await d.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, d.consent));
    await d.wfpHook(d.wfpBody({ orderReference: 'tc-' + dc.body.payment_id, amount: 250, transactionStatus: 'Declined', processingDate: 1760778300 }));
    assert.equal(d.store.db.payments[0].status, 'failure');
    assert.equal(parseWayforpayBody('{"a":1}').a, 1);
    assert.equal(parseWayforpayBody(encodeURIComponent('{"a":2}')).a, 2);
    assert.equal(parseWayforpayBody('nonsense'), null);
});

test('Telegram failure does not break the webhook: 200 / accept, payment still credited', async () => {
    const w = world({}, { telegramFails: true });
    await w.pay(Object.assign({ plan: 'month', provider: 'mono' }, w.consent));
    const p = monoPayment(w);
    const res = await w.monoHook({ invoiceId: 'inv_1', reference: p.id, status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' });
    assert.equal(res.statusCode, 200);
    assert.ok(w.store.db.subs[ORG].paid_until);
    const v = world({}, { telegramFails: true });
    const c = await v.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, v.consent));
    const r = await v.wfpHook(v.wfpBody({ orderReference: 'tc-' + c.body.payment_id, amount: 250, transactionStatus: 'Approved' }));
    assert.equal(r.body.status, 'accept');
    // Without TELEGRAM_* the alert is skipped silently.
    const quiet = world({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
    await quiet.pay(Object.assign({ plan: 'month', provider: 'mono' }, quiet.consent));
    await quiet.monoHook({ invoiceId: 'inv_1', reference: monoPayment(quiet).id, status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' });
    assert.equal(quiet.net.calls.filter((x) => x.url.includes('telegram')).length, 0);
});

test('alert text: only company, plan, sum, provider, paid until', () => {
    const text = paymentAlertText('success', { orgName: 'ТОВ «Агро»\nowner@agro.ua', plan: 'year', provider: 'wayforpay', paidUntil: '2027-10-18T09:00:00Z' });
    assert.equal(text.split(' · ').length, 5);
    assert.match(text, /^💳 Оплата: /);
    assert.equal(text.includes('\n'), false);
});

test('status: owner only, own company; asks the provider for open payments (mono and WayForPay)', async () => {
    const w = world();
    const created = await w.pay(Object.assign({ plan: 'month', provider: 'mono' }, w.consent));
    const pid = created.body.payment_id;
    w.net.state.monoStatus = { invoiceId: 'inv_1', reference: pid, status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' };
    assert.equal((await w.call('GET', 'status', { token: 'logist', query: { pid } })).statusCode, 403);
    assert.equal((await w.call('GET', 'status', { token: 'other', query: { pid } })).statusCode, 404);
    assert.equal((await w.call('GET', 'status', { token: 'owner', query: { pid: 'nope' } })).statusCode, 400);
    const res = await w.call('GET', 'status', { token: 'owner', query: { pid } });
    assert.deepEqual(res.body, { status: 'success', paid_until: '2026-11-18T09:00:00.000Z' });
    assert.equal(w.store.db.events[0].source, 'status_check');
    const again = await w.call('GET', 'status', { token: 'owner', query: { pid } });
    assert.equal(again.body.status, 'success');
    assert.equal(w.net.calls.filter((c) => c.url.includes('/invoice/status')).length, 1, 'no provider call once settled');
    assert.equal(w.net.telegrams().length, 1);

    const v = world();
    const vc = await v.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, v.consent));
    v.net.state.wfpCheck = v.wfpBody({ orderReference: 'tc-' + vc.body.payment_id, amount: 250, transactionStatus: 'Approved', processingDate: 1760778300 });
    const vr = await v.call('GET', 'status', { token: 'owner', query: { pid: vc.body.payment_id } });
    assert.equal(vr.body.status, 'success');
});

test('summary, return redirect and routing', async () => {
    const w = world({ WAYFORPAY_SECRET_KEY: '' });
    const owner = await w.call('GET', 'summary', { token: 'owner' });
    assert.equal(owner.statusCode, 200);
    assert.deepEqual(owner.body.providers, ['mono'], 'only providers with env');
    assert.deepEqual(owner.body.prices, [{ plan: 'month', label: '1 місяць', uah: 250 }, { plan: 'year', label: '1 рік', uah: 2500 }]);
    assert.equal(owner.body.can_pay, true);
    assert.equal(owner.body.paid, false);
    const logist = await w.call('GET', 'summary', { token: 'logist' });
    assert.equal(logist.body.can_pay, false);
    assert.deepEqual(logist.body.payments, []);
    assert.deepEqual((await w.call('GET', 'summary', { token: 'owner' })).body.payments, []);

    const pid = '3f2b6c1e-0000-4000-8000-000000000001';
    for (const method of ['GET', 'POST']) {
        const r = await w.call(method, 'return', { query: { pid } });
        assert.equal(r.statusCode, 303);
        assert.equal(r.location, '/?billing=return&pid=' + pid);
    }
    assert.equal((await w.call('GET', 'return', { query: { pid: '<script>' } })).location, '/?billing=return');
    assert.equal((await w.call('GET', 'unknown')).statusCode, 404);
    assert.equal((await w.call('GET', 'create-invoice', { token: 'owner' })).statusCode, 404);
});

test('cron: Bearer CRON_SECRET; reminder 3 Kyiv days ahead, sent once; mail not configured → fail closed; reconcile', async () => {
    const w = world();
    assert.equal((await w.call('GET', 'cron')).statusCode, 401);
    assert.equal((await w.call('GET', 'cron', { headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
    const noSecret = world({ CRON_SECRET: '' });
    assert.equal((await noSecret.call('GET', 'cron', { headers: { authorization: 'Bearer ' } })).statusCode, 401);

    // 18.10 09:00 UTC (12:00 Kyiv) + 3 days = 21.10 by Kyiv date.
    w.store.db.subs[ORG] = { org_id: ORG, paid_until: '2026-10-21T20:30:00.000Z', reminder_sent_for: null };
    w.store.db.subs[OTHER_ORG] = { org_id: OTHER_ORG, paid_until: '2026-10-21T21:30:00.000Z', reminder_sent_for: null }; // 22.10 in Kyiv
    const cron = () => w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    const first = await cron();
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.reminders.sent, 1);
    const mails = w.net.calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.body));
    assert.equal(mails.length, 1);
    assert.deepEqual(mails[0].to, ['owner@agro.ua']);
    assert.equal(mails[0].from, 'TRIP-CONTROL <billing@trip-control.com>');
    assert.equal(mails[0].subject, 'Trip Control: доступ діє до 21.10.2026');
    assert.match(mails[0].text, /250 грн/);
    assert.match(mails[0].text, /2500 грн/);
    assert.match(mails[0].text, /https:\/\/trip-control\.com\/\?billing=pay/);
    assert.match(mails[0].text, /https:\/\/trip-control\.com\/offer/);
    assert.match(mails[0].text, /https:\/\/trip-control\.com\/payment-refund/);
    assert.match(mails[0].html, />Продовжити<\/a>/);
    assert.equal(w.store.db.subs[ORG].reminder_sent_for, '2026-10-21T20:30:00.000Z');
    const second = await cron();
    assert.equal(second.body.reminders.sent, 0);
    assert.equal(w.net.calls.filter((c) => c.url === 'https://api.resend.com/emails').length, 1, 'not duplicated');

    const closed = world({ RESEND_API_KEY: '' });
    closed.store.db.subs[ORG] = { org_id: ORG, paid_until: '2026-10-21T10:00:00.000Z', reminder_sent_for: null };
    const r = await closed.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.reminders.mail, 'unconfigured');
    assert.equal(closed.net.calls.filter((c) => c.url === 'https://api.resend.com/emails').length, 0);
    assert.equal(closed.store.db.subs[ORG].reminder_sent_for, null, 'not marked, will retry when configured');
    assert.equal(JSON.stringify(r.body).includes('re_test'), false);

    // Reconcile: open payments between 10 min and 48 h old.
    const c = world();
    await c.pay(Object.assign({ plan: 'month', provider: 'mono' }, c.consent));
    const p = monoPayment(c);
    c.net.state.monoStatus = { invoiceId: 'inv_1', reference: p.id, status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' };
    const early = await c.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.equal(early.body.reconciled, 0, 'younger than 10 minutes');
    c.clock.now += 15 * 60 * 1000;
    const later = await c.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.equal(later.body.reconciled, 1);
    assert.equal(c.store.db.payments[0].status, 'success');
    assert.equal(c.store.db.payments.length, 1, 'cron deletes nothing');
});

test('no secrets in error responses', async () => {
    const w = world();
    w.net.state.invoiceSeq = 0;
    const brokenFetch = async () => { throw Object.assign(new Error('mono-test-token leaked?'), { code: 'ECONNRESET' }); };
    const handler = createBillingHandler({ store: w.store, fetch: brokenFetch, env: w.env, now: () => NOW });
    const res = response();
    await handler(request('POST', 'create-invoice', { token: 'owner', body: Object.assign({ plan: 'month', provider: 'mono' }, w.consent) }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.stringify(res.body).includes('mono-test-token'), false);
    assert.equal(w.store.db.payments[0].status, 'failure');
    assert.equal(LOGIST.length, 36);
});

test('mono webhook: 10 forged notifications in a row → at most 1 pubkey request; garbage x-sign → none', async () => {
    const w = world();
    await w.pay(Object.assign({ plan: 'month', provider: 'mono' }, w.consent));
    const p = monoPayment(w);
    const forger = monoKeyPair();
    const hook = { invoiceId: 'inv_1', reference: p.id, status: 'success', amount: 25000, ccy: 980, modifiedDate: '2026-10-18T09:05:00Z' };
    for (let i = 0; i < 10; i += 1) {
        assert.equal((await w.monoHook(Object.assign({}, hook, { n: i }), forger)).statusCode, 401);
    }
    assert.ok(w.net.calls.filter((c) => c.url.endsWith('/merchant/pubkey')).length <= 1);
    const before = w.net.calls.length;
    for (const bad of ['', 'not base64!', '%%%']) {
        assert.equal((await w.call('POST', 'mono-webhook', { raw: JSON.stringify(hook), headers: { 'x-sign': bad } })).statusCode, 401);
    }
    assert.equal(w.net.calls.length, before, 'no request to mono for an empty / invalid x-sign');
    assert.equal(w.store.db.events.length, 0);
    assert.equal(w.store.db.subs[ORG], undefined);
});

test('WayForPay webhook with amount 250.00 / "250.00" in the raw body is accepted and credited', async () => {
    for (const literal of ['250', '250.00', '"250.00"']) {
        const w = world();
        const created = await w.pay(Object.assign({ plan: 'month', provider: 'wayforpay' }, w.consent));
        const ref = 'tc-' + created.body.payment_id;
        const text = literal.replace(/"/g, '');
        const sig = crypto.createHmac('md5', WFP_SECRET).update([WFP_MERCHANT, ref, text, 'UAH', '541963', '41****8217', 'Approved', '1100'].join(';')).digest('hex');
        const raw = '{"merchantAccount":"' + WFP_MERCHANT + '","orderReference":"' + ref + '","amount":' + literal +
            ',"currency":"UAH","authCode":"541963","cardPan":"41****8217","transactionStatus":"Approved","reasonCode":1100,"processingDate":1760778300,"merchantSignature":"' + sig + '"}';
        const res = await w.call('POST', 'wayforpay-webhook', { raw, headers: { 'content-type': 'application/json' } });
        assert.equal(res.statusCode, 200, literal);
        assert.equal(res.body.status, 'accept', literal);
        assert.equal(w.store.db.subs[ORG].paid_until, '2026-11-18T09:00:00.000Z', literal);
    }
});
