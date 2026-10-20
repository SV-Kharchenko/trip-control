import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBillingHandler, createBillingService } from '../lib/billing/service.js';
import { buildReminderEmail } from '../lib/billing/mail.js';
import { parseRegularOrderReference, wayforpayDate } from '../lib/billing/wayforpay.js';
import { LEGAL_VERSION } from '../lib/legal.js';
import { baseEnv, DAY, fakeNet, memoryStore, NOW, ORG, request, response, WFP_MERCHANT, WFP_SECRET } from './billing-fakes.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const WFP_PASSWORD = 'test-wfp-merchant-password';
const OFFLINE = 'https://secure.wayforpay.com/pay?behavior=offline';

function world({ flag = true, password = true, net: netOptions = {} } = {}) {
    const clock = { now: NOW };
    const net = fakeNet(netOptions);
    const store = memoryStore(clock);
    const extra = {};
    if (flag) extra.AUTO_RENEW_ENABLED = '1';
    if (password) extra.WAYFORPAY_MERCHANT_PASSWORD = WFP_PASSWORD;
    const env = baseEnv(extra);
    const handler = createBillingHandler({ store, fetch: net.fetch, env, now: () => clock.now });
    const service = createBillingService({ store, fetch: net.fetch, env, now: () => clock.now });
    async function call(method, route, options) {
        const res = response();
        await handler(request(method, route, options), res);
        return res;
    }
    const invoice = (body, token = 'owner') => call('POST', 'create-invoice', {
        token, body: Object.assign({ plan: 'month', provider: 'wayforpay', consent: true, legal_version: LEGAL_VERSION }, body)
    });
    async function pay(body = {}) {
        const res = await invoice(body);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        return store.db.payments.find((p) => p.id === res.body.payment_id);
    }
    function signed(orderReference, fields) {
        const body = Object.assign({
            merchantAccount: WFP_MERCHANT, orderReference, amount: 250, currency: 'UAH', authCode: '541963',
            cardPan: '41****8217', reasonCode: 1100, processingDate: Math.floor(clock.now / 1000)
        }, fields);
        body.merchantSignature = crypto.createHmac('md5', WFP_SECRET).update([
            body.merchantAccount, body.orderReference, body.amount, body.currency, body.authCode, body.cardPan, body.transactionStatus, body.reasonCode
        ].join(';'), 'utf8').digest('hex');
        return body;
    }
    const hook = (orderReference, fields) =>
        call('POST', 'wayforpay-webhook', { raw: JSON.stringify(signed(orderReference, fields)), headers: { 'content-type': 'application/json' } });
    const approve = (orderReference, fields) => hook(orderReference, Object.assign({ transactionStatus: 'Approved' }, fields));
    const decline = (orderReference, fields) => hook(orderReference, Object.assign({ transactionStatus: 'Declined', reasonCode: 1101 }, fields));
    // Перший платіж з галочкою, зарахований: автопродовження увімкнене.
    async function autoRenewOn(plan = 'month') {
        const p = await pay({ plan, auto_renew: true });
        await approve(p.provider_order_id, { amount: plan === 'year' ? 2500 : 250 });
        net.state.regular[p.provider_order_id] = 'Active';
        return p;
    }
    const purchases = () => net.calls.filter((c) => c.url === OFFLINE).map((c) => new URLSearchParams(c.body));
    const sub = () => store.db.subs[ORG] || {};
    const renewals = () => store.db.payments.filter((p) => p.kind === 'renewal');
    const mails = () => net.calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.body));
    return { clock, store, net, env, service, call, invoice, pay, hook, approve, decline, autoRenewOn, purchases, sub, renewals, mails };
}

test('Purchase without the box: no regular fields; with the box: regular fields from the plan on the server', async () => {
    const w = world();
    await w.pay();
    const plain = w.purchases()[0];
    for (const key of ['regularMode', 'regularAmount', 'dateNext', 'regularOn', 'regularBehavior']) assert.equal(plain.has(key), false, key);
    assert.equal(w.store.db.payments[0].auto_renew_requested_at, null);

    // Ціну / суму від клієнта ігноруємо.
    const res = await w.invoice({ auto_renew: true, price: 1, amount: 1, regularAmount: 1, regularMode: 'daily' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.auto_renew, true);
    const regular = w.purchases()[1];
    assert.equal(regular.get('regularMode'), 'monthly');
    assert.equal(regular.get('regularAmount'), '250');
    assert.equal(regular.get('amount'), '250');
    assert.equal(regular.get('regularOn'), '1');
    assert.equal(regular.get('regularBehavior'), 'preset');
    // dateNext — нове «оплачено до» після цієї оплати (18.10 + 1 місяць), за Києвом.
    assert.equal(regular.get('dateNext'), '18.11.2026');
    const row = w.store.db.payments.find((p) => p.id === res.body.payment_id);
    assert.equal(row.auto_renew_requested_at, new Date(NOW).toISOString(), 'consent time is written on the server');

    const year = await w.invoice({ plan: 'year', auto_renew: true });
    assert.equal(year.statusCode, 200);
    assert.equal(w.purchases()[2].get('regularMode'), 'yearly');
    assert.equal(w.purchases()[2].get('regularAmount'), '2500');
    assert.equal(w.purchases()[2].get('dateNext'), '18.10.2027');
});

test('legal version: both 2026-10-18 and 2026-10-20 accepted during the switch, consent records the one sent; auto-renew needs the new one', async () => {
    const w = world();
    const old = await w.invoice({ legal_version: '2026-10-18' });
    assert.equal(old.statusCode, 200, 'a tab opened before the deploy does not get CONSENT_REQUIRED');
    const fresh = await w.invoice({ legal_version: '2026-10-20' });
    assert.equal(fresh.statusCode, 200);
    const consentOf = (id) => w.store.db.consents.find((c) => c.payment_id === id && c.kind === 'payment');
    assert.deepEqual([consentOf(old.body.payment_id).offer_version, consentOf(old.body.payment_id).privacy_version], ['2026-10-18', '2026-10-18']);
    assert.deepEqual([consentOf(fresh.body.payment_id).offer_version, consentOf(fresh.body.payment_id).privacy_version], ['2026-10-20', '2026-10-20']);
    for (const bad of ['2026-10-19', '2020-01-01', '', undefined]) {
        const res = await w.invoice({ legal_version: bad });
        assert.equal(res.statusCode, 400, String(bad));
        assert.equal(res.body.code, 'CONSENT_REQUIRED', String(bad));
    }
    const oldWithBox = await w.invoice({ legal_version: '2026-10-18', auto_renew: true });
    assert.equal(oldWithBox.statusCode, 400);
    assert.equal(oldWithBox.body.code, 'CONSENT_REQUIRED');
    assert.match(oldWithBox.body.error, /Оновіть сторінку/);
    assert.equal(w.store.db.payments.length, 2);
});

test('auto-renew consent is also written to legal_consents (kind auto_renew, payment_id); none without the box', async () => {
    const w = world();
    const plain = await w.pay();
    const withBox = await w.pay({ auto_renew: true });
    const kinds = (id) => w.store.db.consents.filter((c) => c.payment_id === id).map((c) => c.kind).sort();
    assert.deepEqual(kinds(plain.id), ['payment']);
    assert.deepEqual(kinds(withBox.id), ['auto_renew', 'payment']);
    const consent = w.store.db.consents.find((c) => c.kind === 'auto_renew');
    assert.deepEqual([consent.user_id, consent.org_id, consent.offer_version, consent.privacy_version],
        [withBox.created_by, ORG, LEGAL_VERSION, LEGAL_VERSION]);
    // Не вдалося записати згоду — рахунку немає (fail closed).
    const f = world();
    f.store.insertConsent = async (row) => { if (row.kind === 'auto_renew') throw Object.assign(new Error('db'), { code: 'EDB' }); f.store.db.consents.push(row); };
    const res = await f.invoice({ auto_renew: true });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'CONSENT_NOT_SAVED');
    assert.equal(f.store.db.payments[0].status, 'failure');
    assert.equal(f.purchases().length, 0, 'no Purchase without the consent');
    assert.match(read('supabase/migrations/20261020200000_auto_renew.sql'), /CHECK \(kind IN \('signup', 'payment', 'auto_renew'\)\)/);
});

test('dateNext counts from the current paid_until when access is still paid', async () => {
    const w = world();
    await w.approve((await w.pay()).provider_order_id);
    await w.invoice({ auto_renew: true });
    assert.equal(w.purchases()[1].get('dateNext'), '18.12.2026');
});

test('auto_renew only with WayForPay and the flag; behavior=offline only; one active regular per company', async () => {
    const w = world();
    const mono = await w.invoice({ provider: 'mono', auto_renew: true });
    assert.equal(mono.statusCode, 400);
    assert.equal(mono.body.code, 'AUTO_RENEW_UNAVAILABLE');
    assert.equal(w.store.db.payments.length, 0);
    // auto_renew лише true (не "true", не 1).
    await w.invoice({ auto_renew: 'true' });
    assert.equal(w.purchases()[0].has('regularMode'), false);

    const noPassword = world({ password: false });
    assert.equal((await noPassword.invoice({ auto_renew: true })).body.code, 'AUTO_RENEW_UNAVAILABLE');

    // Без behavior=offline (CREATE_INVOICE) регулярки немає: звичайна разова оплата.
    const fallback = world({ net: { wfpOffline: false } });
    const res = await fallback.invoice({ auto_renew: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.auto_renew, false);
    const created = fallback.net.calls.find((c) => c.url === 'https://api.wayforpay.com/api' && JSON.parse(c.body).transactionType === 'CREATE_INVOICE');
    for (const key of ['regularMode', 'regularAmount', 'dateNext', 'regularOn', 'regularBehavior']) assert.equal(key in JSON.parse(created.body), false, key);
    assert.equal(fallback.store.db.payments[0].auto_renew_requested_at, null);

    await w.autoRenewOn();
    const again = await w.invoice({ auto_renew: true });
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.code, 'AUTO_RENEW_ACTIVE');
    assert.equal((await w.invoice({})).statusCode, 200, 'a one-off payment is still possible');
});

test('credited first payment with the box turns auto-renew on: reference, card mask, next charge, consent time', async () => {
    const w = world();
    const p = await w.autoRenewOn();
    const sub = w.sub();
    assert.equal(sub.auto_renew, true);
    assert.equal(sub.wfp_regular_order_ref, p.provider_order_id);
    assert.equal(sub.card_mask, '41****8217');
    assert.equal(sub.next_charge_at, '2026-11-18T09:00:00.000Z');
    assert.equal(sub.paid_until, '2026-11-18T09:00:00.000Z');
    assert.equal(sub.regular_status, 'Active');
    assert.equal(sub.fail_count, 0);
    assert.equal(sub.auto_renew_consent_at, new Date(NOW).toISOString());

    const summary = (await w.call('GET', 'summary', { token: 'owner' })).body;
    assert.deepEqual(summary.auto_renew, { enabled: true, next_charge_at: '2026-11-18T09:00:00.000Z', card_mask: '41****8217', plan: 'month', amount_uah: 250, removing: false });
    assert.equal(summary.auto_renew_available, true);
    // Логіст не бачить ні стану, ні галочки.
    const logist = (await w.call('GET', 'summary', { token: 'logist' })).body;
    assert.equal('auto_renew' in logist, false);
    assert.equal(logist.auto_renew_available, false);

    // Оплата без галочки автопродовження не вмикає.
    const plain = world();
    await plain.approve((await plain.pay()).provider_order_id);
    assert.equal(plain.sub().auto_renew, undefined);
});

test('renewal callback (<ref>_WFPREG-<digits>) is credited once: own row, parent, same crediting; a duplicate is ignored', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    assert.deepEqual(parseRegularOrderReference(parent.provider_order_id + '_WFPREG-1234567'), { parent: parent.provider_order_id, seq: '1234567' });

    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    const ref = parent.provider_order_id + '_WFPREG-1234567';
    const first = await w.approve(ref, { cardPan: '41****9999' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.orderReference, ref);
    assert.equal(first.body.status, 'accept');
    assert.equal(w.renewals().length, 1);
    const row = w.renewals()[0];
    assert.equal(row.parent_payment_id, parent.id);
    assert.equal(row.org_id, ORG);
    assert.equal(row.plan, 'month');
    assert.equal(row.amount_minor, 25000);
    assert.equal(row.status, 'success');
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z', 'max(now, paid_until) + 1 month');
    assert.equal(w.sub().next_charge_at, '2026-12-18T09:00:00.000Z');
    assert.equal(w.sub().card_mask, '41****9999');

    // Той самий orderReference ще раз (повтор WayForPay) — нічого не змінюється.
    const again = await w.approve(ref);
    assert.equal(again.body.status, 'accept');
    assert.equal(w.renewals().length, 1);
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z');
    const credited = w.net.telegrams().filter((t) => t.includes('автосписання'));
    assert.deepEqual(credited, ['💳 Оплата: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · автосписання · оплачено до 18.12.2026']);

    // Наступне списання — нові цифри, новий рядок, ще один період.
    w.clock.now = Date.parse('2026-12-18T07:00:00Z');
    await w.approve(parent.provider_order_id + '_WFPREG-7654321');
    assert.equal(w.renewals().length, 2);
    assert.equal(w.sub().paid_until, '2027-01-18T09:00:00.000Z');
});

test('renewal: bad signature 401 without a row; unknown parent or wrong amount — accept, nothing credited', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    const ref = parent.provider_order_id + '_WFPREG-1';
    const body = Object.assign({ transactionStatus: 'Approved' }, { merchantAccount: WFP_MERCHANT, orderReference: ref, amount: 250, currency: 'UAH', merchantSignature: 'x' });
    const forged = await w.call('POST', 'wayforpay-webhook', { raw: JSON.stringify(body) });
    assert.equal(forged.statusCode, 401);
    assert.equal(w.renewals().length, 0);

    const unknown = await w.approve('tc-00000000-0000-4000-8000-000000000000_WFPREG-1');
    assert.equal(unknown.body.status, 'accept');
    assert.equal(w.renewals().length, 0);

    const until = w.sub().paid_until;
    await w.approve(ref, { amount: 1 });
    assert.equal(w.sub().paid_until, until, 'amount from the plan only');
    assert.equal(w.renewals()[0].status, 'pending');
});

test('unmatched _WFPREG- callbacks (no parent, unknown plan, wrong amount / currency): event with payload + one admin alert', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    const unmatched = () => w.net.telegrams().filter((t) => t.startsWith('❗'));

    // Немає першого платежу.
    const orphan = 'tc-00000000-0000-4000-8000-00000000dead_WFPREG-1';
    assert.equal((await w.approve(orphan)).body.status, 'accept');
    await w.approve(orphan); // повтор — подія є, алерт не дублюється
    assert.equal(w.renewals().length, 0);
    const events = w.store.db.events.filter((e) => e.order_reference === orphan);
    assert.equal(events.length, 2);
    assert.equal(events[0].payment_id, null);
    assert.deepEqual([events[0].status, events[0].source, events[0].signature_ok], ['Approved', 'webhook', true]);
    assert.equal(events[0].payload.orderReference, orphan);
    assert.equal(events[0].payload.amount, 250);
    assert.equal(events[0].payload.maskedPan, '41****8217');
    assert.deepEqual(unmatched(), [
        '❗ Автосписання не зараховано: — · немає першого платежу регулярки · сума 250 UAH · статус Approved · orderReference ' + orphan + ' · перевірте вручну'
    ]);
    // Інший статус того самого orderReference — ще один алерт.
    await w.decline(orphan);
    assert.equal(unmatched().length, 2);

    // Невідомий тариф першого платежу.
    w.store.db.payments.find((p) => p.id === parent.id).plan = 'week';
    await w.approve(parent.provider_order_id + '_WFPREG-2');
    assert.equal(w.renewals().length, 0);
    assert.match(unmatched().at(-1), /^❗ Автосписання не зараховано: ТОВ «Агро» · невідомий тариф першого платежу \(week\) · сума 250 UAH · статус Approved/);
    w.store.db.payments.find((p) => p.id === parent.id).plan = 'month';

    // Сума / валюта не збігаються: рядок є, не зараховано, подія з payload, один алерт.
    const ref = parent.provider_order_id + '_WFPREG-3';
    const until = w.sub().paid_until;
    await w.approve(ref, { amount: 1 });
    await w.approve(ref, { amount: 1 });
    await w.approve(parent.provider_order_id + '_WFPREG-4', { currency: 'USD' });
    assert.equal(w.sub().paid_until, until);
    assert.equal(w.renewals().find((p) => p.provider_order_id === ref).status, 'pending');
    assert.equal(w.store.db.events.filter((e) => e.payment_id === w.renewals()[0].id).length, 2);
    assert.deepEqual(unmatched().slice(-2), [
        '❗ Автосписання не зараховано: ТОВ «Агро» · сума або валюта не збігаються (очікували 250 UAH) · сума 1 UAH · статус Approved · orderReference ' + ref + ' · перевірте вручну',
        '❗ Автосписання не зараховано: ТОВ «Агро» · сума або валюта не збігаються (очікували 250 UAH) · сума 250 USD · статус Approved · orderReference ' + parent.provider_order_id + '_WFPREG-4 · перевірте вручну'
    ]);
    // Звичайний (не регулярний) платіж з неправильною сумою — як і раніше, без алерту.
    const before = unmatched().length;
    await w.approve((await w.pay()).provider_order_id, { amount: 1 });
    assert.equal(unmatched().length, before);
});

test('declined renewal: +1 fail and an admin alert; the second in a row → REMOVE, auto-renew off, mail «оплатіть вручну»', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    const first = parent.provider_order_id + '_WFPREG-100';
    await w.decline(first);
    await w.decline(first); // повтор того самого сповіщення не рахується
    assert.equal(w.sub().fail_count, 1);
    assert.equal(w.sub().auto_renew, true);
    assert.equal(w.net.regularCalls().length, 0, 'no REMOVE after one failure');
    assert.equal(w.renewals()[0].status, 'failure');

    w.clock.now += DAY;
    await w.decline(parent.provider_order_id + '_WFPREG-101');
    assert.equal(w.sub().fail_count, 2);
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().regular_status, 'Removed');
    const removes = w.net.regularCalls().filter((c) => c.requestType === 'REMOVE');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].orderReference, parent.provider_order_id);
    assert.equal(removes[0].merchantAccount, WFP_MERCHANT);
    assert.equal(removes[0].merchantPassword, WFP_PASSWORD);
    assert.equal(w.sub().paid_until, '2026-11-18T09:00:00.000Z', 'access stays until paid_until');

    const alerts = w.net.telegrams().filter((t) => t.startsWith('⚠️'));
    assert.deepEqual(alerts, [
        '⚠️ Автосписання не пройшло: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · спроба 1',
        '⚠️ Автосписання не пройшло: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · спроба 2 · автопродовження вимкнено'
    ]);
    const mail = w.mails().find((m) => m.subject === 'Trip Control: автосписання не пройшло, оплатіть вручну');
    assert.ok(mail);
    assert.deepEqual(mail.to, ['owner@agro.ua']);
    assert.match(mail.text, /^Автосписання не пройшло, оплатіть вручну\./);
    assert.match(mail.text, /Оплатити: https:\/\/trip-control\.com\/\?billing=pay/);
    assert.equal(mail.text.includes('41****'), false);
});

test('a successful renewal resets fail_count', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await w.decline(parent.provider_order_id + '_WFPREG-1');
    assert.equal(w.sub().fail_count, 1);
    w.clock.now += DAY;
    await w.approve(parent.provider_order_id + '_WFPREG-2');
    assert.equal(w.sub().fail_count, 0);
    assert.equal(w.sub().auto_renew, true);
});

const CRON = { headers: { authorization: 'Bearer cron-test-secret' } };

test('second failed charge, REMOVE not confirmed: auto_renew stays on (RemovePending), no mail; cron retries and turns off only after 4100', async () => {
    const w = world({ net: { removeFails: true } });
    const p = await w.autoRenewOn();
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await w.decline(p.provider_order_id + '_WFPREG-1');
    w.clock.now += DAY;
    await w.decline(p.provider_order_id + '_WFPREG-2');
    assert.equal(w.sub().auto_renew, true, 'WayForPay can still charge: not turned off on our side');
    assert.equal(w.sub().regular_status, 'RemovePending');
    assert.equal(w.sub().regular_remove_reason, 'renewal_failed');
    assert.equal(w.mails().some((m) => m.subject.includes('автосписання не пройшло')), false, 'no mail before WayForPay confirms');
    assert.equal(w.net.telegrams().at(-1),
        '⚠️ Автосписання не пройшло: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · спроба 2 · WayForPay не підтвердив REMOVE — повторюємо щодня, автопродовження поки увімкнене');
    const summary = (await w.call('GET', 'summary', { token: 'owner' })).body;
    assert.equal(summary.auto_renew.removing, true);

    // Крон: REMOVE знову не вдався — нічого не змінюється.
    let cron = (await w.call('GET', 'cron', CRON)).body;
    assert.equal(cron.auto_renew.failed, 1);
    assert.equal(w.sub().auto_renew, true);
    assert.equal(w.sub().regular_status, 'RemovePending');

    // Крон: WayForPay підтвердив (4100) — тепер вимкнено, лист власнику, алерт.
    w.net.state.removeFails = false;
    cron = (await w.call('GET', 'cron', CRON)).body;
    assert.equal(cron.auto_renew.disabled, 1);
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().regular_status, 'Removed');
    assert.equal(w.sub().regular_remove_reason, null);
    assert.equal(w.mails().filter((m) => m.subject === 'Trip Control: автосписання не пройшло, оплатіть вручну').length, 1);
    assert.ok(w.net.telegrams().includes(
        '🔁 Автопродовження вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · два невдалі автосписання поспіль · REMOVE підтверджено'));
    // Наступний крон регулярку вже не чіпає.
    const before = w.net.regularCalls().length;
    await w.call('GET', 'cron', CRON);
    assert.equal(w.net.regularCalls().length, before);
});

test('refund and owner cancel with REMOVE not confirmed: RemovePending, then cron confirms (cancelled_at for the owner)', async () => {
    const r = world({ net: { removeFails: true } });
    const p = await r.autoRenewOn();
    r.clock.now = NOW + DAY;
    await r.hook(p.provider_order_id, { transactionStatus: 'Refunded', refundAmount: 250 });
    assert.equal(r.sub().auto_renew, true);
    assert.equal(r.sub().regular_status, 'RemovePending');
    assert.equal(r.sub().regular_remove_reason, 'refund');
    assert.equal(r.net.telegrams().at(-1),
        '⏳ Автопродовження не вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · повернення платежу · WayForPay не підтвердив REMOVE — повторюємо щодня, автопродовження поки увімкнене');
    r.net.state.removeFails = false;
    await r.call('GET', 'cron', CRON);
    assert.equal(r.sub().auto_renew, false);
    assert.equal(r.sub().auto_renew_cancelled_at, null, 'refund is not an owner cancel');

    const o = world({ net: { removeFails: true } });
    await o.autoRenewOn();
    const res = await o.call('POST', 'cancel-auto-renew', { token: 'owner' });
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /повторюватимемо спробу щодня/);
    assert.equal(o.sub().auto_renew, true);
    assert.equal(o.sub().regular_remove_reason, 'owner');
    o.clock.now = NOW + 3 * DAY;
    o.net.state.removeFails = false;
    await o.call('GET', 'cron', CRON);
    assert.equal(o.sub().auto_renew, false);
    assert.equal(o.sub().auto_renew_cancelled_at, new Date(NOW + 3 * DAY).toISOString());
    assert.equal(o.mails().some((m) => m.subject.includes('автосписання не пройшло')), false, 'no «failed charge» mail for an owner cancel');
});

test('cancel: owner only; REMOVE, then auto_renew=false and cancelled_at; access stays until paid_until', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    const logist = await w.call('POST', 'cancel-auto-renew', { token: 'logist' });
    assert.equal(logist.statusCode, 403);
    assert.equal(w.sub().auto_renew, true);
    assert.equal(w.net.regularCalls().length, 0);

    w.clock.now = NOW + 2 * DAY;
    const res = await w.call('POST', 'cancel-auto-renew', { token: 'owner' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { auto_renew: false, paid_until: '2026-11-18T09:00:00.000Z' });
    assert.deepEqual(w.net.regularCalls().map((c) => [c.requestType, c.orderReference]), [['REMOVE', parent.provider_order_id]]);
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().regular_status, 'Removed');
    assert.equal(w.sub().auto_renew_cancelled_at, new Date(NOW + 2 * DAY).toISOString());
    assert.equal(w.sub().paid_until, '2026-11-18T09:00:00.000Z');
    assert.equal((await w.call('GET', 'summary', { token: 'owner' })).body.paid, true);
    assert.equal('auto_renew' in (await w.call('GET', 'summary', { token: 'owner' })).body, false);
    assert.deepEqual(w.net.telegrams().filter((t) => t.startsWith('🔁')),
        ['🔁 Автопродовження вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · скасовано власником · оплачено до 18.11.2026']);

    // Повторне скасування — нічого не робить.
    const again = await w.call('POST', 'cancel-auto-renew', { token: 'owner' });
    assert.equal(again.statusCode, 200);
    assert.equal(w.net.regularCalls().length, 1);
    // Після скасування можна знову ввімкнути.
    assert.equal((await w.invoice({ auto_renew: true })).statusCode, 200);
});

test('cancel when WayForPay does not confirm REMOVE: 502, auto-renew stays on (no cancel on screen only)', async () => {
    const w = world({ net: { removeFails: true } });
    await w.autoRenewOn();
    const res = await w.call('POST', 'cancel-auto-renew', { token: 'owner' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'AUTO_RENEW_CANCEL_FAILED');
    assert.equal(w.sub().auto_renew, true);
    assert.equal(w.sub().auto_renew_cancelled_at, null);
    // Регулярка вже знята в WayForPay (STATUS = Removed) — скасування вдається.
    w.net.state.regular[w.sub().wfp_regular_order_ref] = 'Removed';
    assert.equal((await w.call('POST', 'cancel-auto-renew', { token: 'owner' })).statusCode, 200);
    assert.equal(w.sub().auto_renew, false);
});

test('REMOVE answering «already removed» (4101 / 4106 / 4107) counts as removed: cancel does not fail forever with 502', async () => {
    for (const code of [4101, 4106, 4107]) {
        const w = world({ net: { removeCode: code } });
        await w.autoRenewOn();
        const res = await w.call('POST', 'cancel-auto-renew', { token: 'owner' });
        assert.equal(res.statusCode, 200, String(code));
        assert.equal(w.sub().auto_renew, false, String(code));
        assert.equal(w.sub().regular_status, 'Removed', String(code));
        assert.deepEqual(w.net.regularCalls().map((c) => c.requestType), ['REMOVE'], 'no STATUS needed for ' + code);
    }
    // Інший код і STATUS без 4100 — не підтверджено.
    const w = world({ net: { removeCode: 4102, statusCode: 1113 } });
    await w.autoRenewOn();
    w.net.state.regular[w.sub().wfp_regular_order_ref] = 'Removed';
    assert.equal((await w.call('POST', 'cancel-auto-renew', { token: 'owner' })).statusCode, 502);
    assert.equal(w.sub().auto_renew, true);
});

test('refund of the first payment or of a renewal: REMOVE and auto-renew off (period cut as before)', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    w.clock.now = NOW + 2 * DAY;
    await w.hook(parent.provider_order_id, { transactionStatus: 'Refunded', refundAmount: 250 });
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().regular_status, 'Removed');
    assert.deepEqual(w.net.regularCalls().map((c) => [c.requestType, c.orderReference]), [['REMOVE', parent.provider_order_id]]);
    assert.equal(w.sub().paid_until, new Date(NOW + 2 * DAY).toISOString(), 'refund cut unchanged');
    assert.ok(w.net.telegrams().includes('🔁 Автопродовження вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · повернення платежу'));

    const r = world();
    const p = await r.autoRenewOn();
    r.clock.now = Date.parse('2026-11-18T07:00:00Z');
    const renewal = p.provider_order_id + '_WFPREG-55';
    await r.approve(renewal);
    assert.equal(r.sub().paid_until, '2026-12-18T09:00:00.000Z');
    await r.hook(renewal, { transactionStatus: 'Refunded', refundAmount: 250 });
    assert.equal(r.renewals()[0].status, 'reversed');
    assert.equal(r.sub().auto_renew, false);
    assert.deepEqual(r.net.regularCalls().map((c) => [c.requestType, c.orderReference]), [['REMOVE', p.provider_order_id]]);

    // Повернення разового платежу (без галочки) регулярку не чіпає.
    const one = world();
    const a = await one.autoRenewOn();
    one.clock.now = NOW + DAY;
    const plain = await one.pay();
    await one.approve(plain.provider_order_id);
    await one.hook(plain.provider_order_id, { transactionStatus: 'Refunded', refundAmount: 250 });
    assert.equal(one.sub().auto_renew, true);
    assert.equal(one.sub().wfp_regular_order_ref, a.provider_order_id);
    assert.equal(one.net.regularCalls().length, 0);
});

test('renewal for a company with auto_renew=false: credited, REMOVE right away, the REMOVE result in the alert', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    w.store.db.subs[ORG].auto_renew = false;
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await w.approve(parent.provider_order_id + '_WFPREG-9');
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z', 'money taken: credited');
    assert.deepEqual(w.net.regularCalls().map((c) => [c.requestType, c.orderReference]), [['REMOVE', parent.provider_order_id]]);
    assert.equal(w.net.telegrams().at(-1),
        '💳 Оплата: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · автосписання · автопродовження вже вимкнене — REMOVE підтверджено · оплачено до 18.12.2026');
    assert.equal(w.sub().auto_renew, false);

    const f = world({ net: { removeFails: true } });
    const p = await f.autoRenewOn();
    f.store.db.subs[ORG].auto_renew = false;
    f.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await f.approve(p.provider_order_id + '_WFPREG-9');
    assert.equal(f.sub().paid_until, '2026-12-18T09:00:00.000Z');
    assert.match(f.net.telegrams().at(-1), /автосписання · автопродовження вже вимкнене — REMOVE не вдався — вимкніть регулярний платіж у кабінеті WayForPay · оплачено до 18\.12\.2026$/);
});

test('renewal of an old (replaced) regular or one waiting for REMOVE: credited, REMOVE now; a «failed charges» pending is undone by a success', async () => {
    // Регулярка чекала REMOVE через скасування власником: списання зараховано, REMOVE підтвердив — вимкнено.
    const w = world({ net: { removeFails: true } });
    const parent = await w.autoRenewOn();
    assert.equal((await w.call('POST', 'cancel-auto-renew', { token: 'owner' })).statusCode, 502);
    w.net.state.removeFails = false;
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await w.approve(parent.provider_order_id + '_WFPREG-1');
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z');
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().regular_status, 'Removed');
    assert.equal(w.sub().auto_renew_cancelled_at, new Date(w.clock.now).toISOString());
    assert.match(w.net.telegrams().at(-1), /автопродовження вже вимкнене — REMOVE підтверджено/);

    // RemovePending через невдалі списання, а потім успішне: картка працює — автопродовження лишається.
    const s = world({ net: { removeFails: true } });
    const p = await s.autoRenewOn();
    s.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await s.decline(p.provider_order_id + '_WFPREG-1');
    s.clock.now += DAY;
    await s.decline(p.provider_order_id + '_WFPREG-2');
    assert.equal(s.sub().regular_status, 'RemovePending');
    s.clock.now += DAY;
    await s.approve(p.provider_order_id + '_WFPREG-3');
    assert.equal(s.sub().auto_renew, true);
    assert.equal(s.sub().regular_status, 'Active');
    assert.equal(s.sub().regular_remove_reason, null);
    assert.equal(s.sub().fail_count, 0);

    // Списання старої регулярки, яку замінила нова: зараховано, стару знято, нова не зачеплена.
    const o = world();
    const old = await o.autoRenewOn();
    o.store.db.subs[ORG].wfp_regular_order_ref = 'tc-newer';
    o.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await o.approve(old.provider_order_id + '_WFPREG-5');
    assert.deepEqual(o.net.regularCalls().map((c) => [c.requestType, c.orderReference]), [['REMOVE', old.provider_order_id]]);
    assert.equal(o.sub().auto_renew, true);
    assert.equal(o.sub().wfp_regular_order_ref, 'tc-newer');
});

test('daily cron: STATUS for every auto-renewing company; inactive in WayForPay → off + admin alert', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    let res = await w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.deepEqual(res.body.auto_renew, { checked: 1, disabled: 0, failed: 0, missing_ref: 0, deferred: 0 });
    assert.equal(w.sub().auto_renew, true);

    w.net.state.regular[parent.provider_order_id] = 'Suspended';
    res = await w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.deepEqual(res.body.auto_renew, { checked: 1, disabled: 1, failed: 0, missing_ref: 0, deferred: 0 });
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().regular_status, 'Suspended');
    assert.ok(w.net.telegrams().includes(
        '🔁 Автопродовження вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · у WayForPay регулярний платіж неактивний (Suspended) · оплачено до 18.11.2026'));
    assert.equal(w.net.regularCalls().every((c) => c.requestType === 'STATUS'), true);
});

test('cron STATUS: only reasonCode 4100 counts; one alert per run for failures and rows without a reference; next_charge_at / card synced', async () => {
    const w = world();
    const parent = await w.autoRenewOn();

    // Синхронізація з WayForPay: nextPaymentDate (unix-секунди) і card.
    w.net.state.statusExtra = { nextPaymentDate: Math.floor(Date.parse('2026-11-20T09:00:00Z') / 1000), card: '53****1111' };
    let res = (await w.call('GET', 'cron', CRON)).body;
    assert.deepEqual(res.auto_renew, { checked: 1, disabled: 0, failed: 0, missing_ref: 0, deferred: 0 });
    assert.equal(w.sub().next_charge_at, '2026-11-20T09:00:00.000Z');
    assert.equal(w.sub().card_mask, '53****1111');
    w.net.state.statusExtra = { nextPaymentDate: '25.11.2026' };
    await w.call('GET', 'cron', CRON);
    assert.equal(w.sub().next_charge_at, '2026-11-25T09:00:00.000Z');
    assert.equal(w.sub().card_mask, '53****1111', 'no card in the answer — mask kept');

    // STATUS без 4100 (навіть зі статусом Removed) — помилка, нічого не вимикаємо, один алерт.
    w.net.state.statusExtra = {};
    w.net.state.statusCode = 1113;
    w.net.state.regular[parent.provider_order_id] = 'Removed';
    const before = w.net.telegrams().length;
    res = (await w.call('GET', 'cron', CRON)).body;
    assert.deepEqual(res.auto_renew, { checked: 0, disabled: 0, failed: 1, missing_ref: 0, deferred: 0 });
    assert.equal(w.sub().auto_renew, true);
    assert.deepEqual(w.net.telegrams().slice(before), ['⚠️ Звірка автопродовження: не вдалося перевірити (regularApi без 4100 або помилка бази): 1 · перевірте вручну']);

    // Рядок без wfp_regular_order_ref: пропускаємо, у той самий один алерт.
    w.net.state.statusCode = 4100;
    w.net.state.regular[parent.provider_order_id] = 'Active';
    w.store.db.subs['10000000-0000-4000-8000-000000000002'] = { org_id: '10000000-0000-4000-8000-000000000002', paid_until: null, auto_renew: true, wfp_regular_order_ref: null };
    const calls = w.net.regularCalls().length;
    const mark = w.net.telegrams().length;
    res = (await w.call('GET', 'cron', CRON)).body;
    assert.deepEqual(res.auto_renew, { checked: 1, disabled: 0, failed: 0, missing_ref: 1, deferred: 0 });
    assert.equal(w.net.regularCalls().length, calls + 1, 'no regularApi call for the row without a reference');
    assert.deepEqual(w.net.telegrams().slice(mark), ['⚠️ Звірка автопродовження: без посилання на регулярку: 1 (Інша) · перевірте вручну']);

    // Усе гаразд — алерту немає.
    delete w.store.db.subs['10000000-0000-4000-8000-000000000002'];
    const quiet = w.net.telegrams().length;
    await w.call('GET', 'cron', CRON);
    assert.equal(w.net.telegrams().length, quiet);
});

test('admin cancel (request by email) and blocking the company: REMOVE; unconfirmed → RemovePending', async () => {
    const w = world();
    await w.autoRenewOn();
    w.clock.now = NOW + DAY;
    assert.deepEqual(await w.service.adminCancelAutoRenew(ORG), { removed: true, paid_until: '2026-11-18T09:00:00.000Z' });
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.sub().auto_renew_cancelled_at, new Date(NOW + DAY).toISOString());
    assert.equal(w.net.telegrams().at(-1), '🔁 Автопродовження вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · скасовано адміністратором · оплачено до 18.11.2026');
    assert.deepEqual(await w.service.adminCancelAutoRenew(ORG), { none: true, paid_until: '2026-11-18T09:00:00.000Z' });

    const b = world({ net: { removeFails: true } });
    await b.autoRenewOn();
    b.store.db.orgs[ORG].status = 'blocked';
    assert.equal((await b.service.orgBlocked(ORG)).pending, true);
    assert.equal(b.sub().auto_renew, true);
    assert.equal(b.sub().regular_remove_reason, 'org_blocked');
    assert.match(b.net.telegrams().at(-1), /^⏳ Автопродовження не вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · компанію заблоковано · WayForPay не підтвердив REMOVE/);
    b.net.state.removeFails = false;
    await b.call('GET', 'cron', CRON);
    assert.equal(b.sub().auto_renew, false);
    assert.equal(b.sub().auto_renew_cancelled_at, null);
});

test('cron: blocked company → REMOVE at once; no active owner / company missing → REMOVE only on the second run in a row', async () => {
    const owner = '00000000-0000-4000-8000-000000000001';
    for (const [label, change, reason, runs] of [
        ['blocked', (w) => { w.store.db.orgs[ORG].status = 'blocked'; }, 'компанію заблоковано', 1],
        ['no owner', (w) => { delete w.store.db.profiles[owner]; }, 'у компанії немає активного власника', 2],
        ['missing', (w) => { delete w.store.db.orgs[ORG]; }, 'компанії немає', 2]
    ]) {
        const w = world();
        const parent = await w.autoRenewOn();
        change(w);
        if (runs === 2) {
            const first = (await w.call('GET', 'cron', CRON)).body;
            assert.deepEqual([first.auto_renew.deferred, first.auto_renew.disabled], [1, 0], label);
            assert.equal(w.sub().auto_renew, true, label);
            assert.equal(w.net.regularCalls().some((c) => c.requestType === 'REMOVE'), false, label + ': no REMOVE on the first run');
        }
        const res = (await w.call('GET', 'cron', CRON)).body;
        assert.equal(res.auto_renew.disabled, 1, label);
        assert.equal(w.sub().auto_renew, false, label);
        assert.equal(w.sub().regular_stop_check, null, label);
        assert.deepEqual(w.net.regularCalls().map((c) => [c.requestType, c.orderReference]), [['REMOVE', parent.provider_order_id]], label);
        assert.ok(w.net.telegrams().at(-1).includes(' · ' + reason), label + ': ' + w.net.telegrams().at(-1));
    }
});

test('cron: an owner without email in the profile is still an owner; a no-owner seen once and then gone is forgotten', async () => {
    const owner = '00000000-0000-4000-8000-000000000001';
    const w = world();
    await w.autoRenewOn();
    w.store.db.profiles[owner].email = null;
    for (let i = 0; i < 3; i += 1) {
        const res = (await w.call('GET', 'cron', CRON)).body;
        assert.deepEqual([res.auto_renew.deferred, res.auto_renew.disabled, res.auto_renew.checked], [0, 0, 1], 'run ' + i);
    }
    assert.equal(w.sub().auto_renew, true);
    assert.equal(w.sub().regular_stop_check, undefined);

    // Власника тимчасово немає (один прогін) — потім знову є: позначку скинуто, REMOVE не було.
    const saved = w.store.db.profiles[owner];
    delete w.store.db.profiles[owner];
    assert.equal((await w.call('GET', 'cron', CRON)).body.auto_renew.deferred, 1);
    assert.equal(w.sub().regular_stop_check, 'no_owner');
    w.store.db.profiles[owner] = saved;
    assert.equal((await w.call('GET', 'cron', CRON)).body.auto_renew.checked, 1);
    assert.equal(w.sub().regular_stop_check, null);
    delete w.store.db.profiles[owner];
    assert.equal((await w.call('GET', 'cron', CRON)).body.auto_renew.deferred, 1, 'the count starts over');
    assert.equal(w.net.regularCalls().some((c) => c.requestType === 'REMOVE'), false);
    assert.equal(w.sub().auto_renew, true);
});

test('database error on the company lookup is not «company missing»: no REMOVE, row counted as failed, one alert', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    w.store.db.failOrgStatus = true;
    const before = w.net.telegrams().length;
    const res = (await w.call('GET', 'cron', CRON)).body;
    assert.deepEqual(res.auto_renew, { checked: 0, disabled: 0, failed: 1, missing_ref: 0, deferred: 0 });
    assert.equal(w.net.regularCalls().some((c) => c.requestType === 'REMOVE'), false, 'no irreversible REMOVE');
    assert.equal(w.sub().auto_renew, true);
    assert.equal(w.sub().regular_status, 'Active');
    assert.deepEqual(w.net.telegrams().slice(before),
        ['⚠️ Звірка автопродовження: не вдалося перевірити (regularApi без 4100 або помилка бази): 1 · перевірте вручну']);

    // Нагадування за 3 дні: помилка бази — лист не шлемо й не позначаємо, решта крону працює.
    w.clock.now = Date.parse('2026-11-15T07:00:00Z');
    const mails = w.mails().length;
    const cron = (await w.call('GET', 'cron', CRON));
    assert.equal(cron.statusCode, 200);
    assert.equal(cron.body.reminders.failed, 1);
    assert.equal(w.mails().length, mails);
    assert.equal(w.sub().reminder_sent_for, null);

    // Автосписання при помилці бази: зараховано, автопродовження обліковано як зазвичай.
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await w.approve(parent.provider_order_id + '_WFPREG-1');
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z');
    assert.equal(w.sub().next_charge_at, '2026-12-18T09:00:00.000Z');
    assert.equal(w.sub().auto_renew, true);

    // Компанії справді немає (успішний запит без рядка) — це org_missing (REMOVE на другому прогоні поспіль).
    w.store.db.failOrgStatus = false;
    delete w.store.db.orgs[ORG];
    assert.equal((await w.call('GET', 'cron', CRON)).body.auto_renew.deferred, 1);
    assert.equal((await w.call('GET', 'cron', CRON)).body.auto_renew.disabled, 1);
});

test('renewal for a blocked company: credited (money taken), regular stopped, admin told', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    w.store.db.orgs[ORG].status = 'blocked';
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');
    await w.approve(parent.provider_order_id + '_WFPREG-1');
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z');
    assert.equal(w.sub().auto_renew, false);
    assert.equal(w.net.telegrams().at(-1), '💳 Оплата: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · автосписання · компанію заблоковано — REMOVE підтверджено · оплачено до 18.12.2026');
});

test('admin API and CRM: cancel_auto_renew action, block stops auto-renew, state per company', () => {
    const admin = read('api/admin.js');
    assert.match(admin, /const billing = createBillingService\(\{ store: createSupabaseStore\(supabase\), fetch: globalThis\.fetch, env: process\.env \}\);/);
    assert.match(admin, /if \(action === 'cancel_auto_renew'\) \{[\s\S]*?billing\.adminCancelAutoRenew\(orgId\)[\s\S]*?audit\(admin\.user\.id, 'cancel_auto_renew'/);
    assert.match(admin, /if \(status === 'blocked'\) \{[\s\S]*?billing\.orgBlocked\(orgId\)/);
    assert.match(admin, /auto_renew: autoRenew\[o\.id\] \|\| null/);
    const html = read('index.html');
    assert.match(html, /onclick="adminCancelAutoRenew\(\\'' \+ c\.org_id \+ '\\'\)">Скасувати автопродовження<\/button>/);
    assert.match(html, /adminApi\('POST', \{ action: 'cancel_auto_renew', org_id: orgId \}\)/);
    assert.match(html, /\(ADMIN_AUTO_RENEW_RESULT\[res\.auto_renew\] \|\| ''\)/);
});

test('3-day reminder: with auto-renew «{date} спишемо {sum} з картки {mask}, скасувати можна тут: {link}»; without — the old text', async () => {
    const w = world();
    await w.autoRenewOn();
    w.clock.now = Date.parse('2026-11-15T07:00:00Z');
    await w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    const mail = w.mails().at(-1);
    assert.equal(mail.subject, 'Trip Control: 18.11.2026 автоматичне продовження');
    assert.equal(mail.text.split('\n')[0], '18.11.2026 спишемо 250 грн з картки 41****8217, скасувати можна тут: https://trip-control.com/?billing=auto-renew');

    const plain = world();
    await plain.approve((await plain.pay()).provider_order_id);
    plain.clock.now = Date.parse('2026-11-15T07:00:00Z');
    await plain.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.equal(plain.mails().at(-1).subject, 'Trip Control: доступ діє до 18.11.2026');
    assert.deepEqual(buildReminderEmail({ paidUntil: '2026-11-18T09:00:00Z', baseUrl: 'https://trip-control.com', orgName: 'А' }),
        buildReminderEmail({ paidUntil: '2026-11-18T09:00:00Z', baseUrl: 'https://trip-control.com', orgName: 'А', autoRenew: null }));
});

test('amount in summary / reminder / alerts comes from the regular\'s first payment, not from a later one-off of another plan', async () => {
    const w = world();
    await w.autoRenewOn('month');
    w.clock.now = NOW + DAY;
    await w.approve((await w.pay({ plan: 'year' })).provider_order_id, { amount: 2500 });
    assert.equal(w.sub().last_plan, 'year');
    const summary = (await w.call('GET', 'summary', { token: 'owner' })).body;
    assert.equal(summary.auto_renew.plan, 'month');
    assert.equal(summary.auto_renew.amount_uah, 250);
    // Нагадування за 3 дні до next_charge_at (18.11), хоча paid_until уже 18.11.2027.
    w.store.db.subs[ORG].paid_until = '2026-11-18T09:00:00.000Z';
    w.clock.now = Date.parse('2026-11-15T07:00:00Z');
    await w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.match(w.mails().at(-1).text, /^18\.11\.2026 спишемо 250 грн з картки/);
    await w.call('POST', 'cancel-auto-renew', { token: 'owner' });
    assert.match(w.net.telegrams().at(-1), /^🔁 Автопродовження вимкнено: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · скасовано власником/);
});

test('renewal price comes from the first payment (offer 4.15), not from the current PLANS; period from parent.plan', async () => {
    const w = world();
    const parent = await w.autoRenewOn();
    // Регулярку ввімкнули, коли місяць коштував 200 грн (зараз 250).
    w.store.db.payments.find((p) => p.id === parent.id).amount_minor = 20000;
    w.clock.now = Date.parse('2026-11-18T07:00:00Z');

    // Поточна ціна (250) для цієї регулярки — не та сума: не зараховано, алерт.
    await w.approve(parent.provider_order_id + '_WFPREG-1', { amount: 250 });
    assert.equal(w.sub().paid_until, '2026-11-18T09:00:00.000Z');
    assert.match(w.net.telegrams().at(-1), /^❗ Автосписання не зараховано: ТОВ «Агро» · сума або валюта не збігаються \(очікували 200 UAH\) · сума 250 UAH/);

    // 200 — зараховано на місяць (parent.plan).
    await w.approve(parent.provider_order_id + '_WFPREG-2', { amount: 200 });
    const row = w.renewals().find((p) => p.provider_order_id === parent.provider_order_id + '_WFPREG-2');
    assert.equal(row.amount_minor, 20000);
    assert.equal(row.plan, 'month');
    assert.equal(w.sub().paid_until, '2026-12-18T09:00:00.000Z');
    assert.equal(w.net.telegrams().at(-1), '💳 Оплата: ТОВ «Агро» · 1 місяць · 200 грн · WayForPay · автосписання · оплачено до 18.12.2026');

    // Summary, нагадування, невдале списання — 200 грн.
    assert.equal((await w.call('GET', 'summary', { token: 'owner' })).body.auto_renew.amount_uah, 200);
    w.clock.now = Date.parse('2026-12-15T07:00:00Z');
    await w.call('GET', 'cron', CRON);
    assert.match(w.mails().at(-1).text, /^18\.12\.2026 спишемо 200 грн з картки/);
    w.clock.now = Date.parse('2026-12-18T07:00:00Z');
    await w.decline(parent.provider_order_id + '_WFPREG-3', { amount: 200 });
    assert.equal(w.net.telegrams().at(-1), '⚠️ Автосписання не пройшло: ТОВ «Агро» · 1 місяць · 200 грн · WayForPay · спроба 1');
    w.clock.now += DAY;
    await w.decline(parent.provider_order_id + '_WFPREG-4', { amount: 200 });
    assert.match(w.mails().at(-1).text, /Двічі не вдалося списати 200 грн/);
});

test('client: with auto-renew on, the 3-day banner does not offer a manual payment', () => {
    const html = read('index.html');
    const banner = html.slice(html.indexOf('function syncBillingBanner()'), html.indexOf('async function loadCabinetAutoRenew()'));
    assert.match(banner, /owner && billingAutoRenewOn \? ' Автопродовження увімкнено: продовжимо автоматично\.'/);
    assert.match(banner, /document\.getElementById\('billing-banner-btn'\)\.hidden = !owner \|\| billingAutoRenewOn;/);
    assert.match(html, /billingAutoRenewOn = !!\(summary\.auto_renew && summary\.auto_renew\.enabled\);\n\s+setBillingEnabled\(summary\.payments_enabled === true\);/);
});

test('without AUTO_RENEW_ENABLED nothing changes: same Purchase, same summary, box refused', async () => {
    const off = world({ flag: false, password: false });
    const on = world();
    await off.pay();
    await on.pay();
    const strip = (params) => { const o = Object.fromEntries(params); delete o.orderReference; delete o.returnUrl; delete o.merchantSignature; return o; };
    assert.deepEqual(strip(off.purchases()[0]), strip(on.purchases()[0]), 'Purchase without the box is the same with and without the flag');

    const refused = await off.invoice({ auto_renew: true });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, 'AUTO_RENEW_UNAVAILABLE');
    const summary = (await off.call('GET', 'summary', { token: 'owner' })).body;
    assert.deepEqual(Object.keys(summary).sort(), ['can_pay', 'legal_version', 'manual_full_access', 'paid', 'paid_until', 'payments_enabled', 'payments', 'prices', 'providers'].sort());
    assert.deepEqual(summary.prices, [{ plan: 'month', label: '1 місяць', uah: 250 }, { plan: 'year', label: '1 рік', uah: 2500 }]);
    const cron = (await off.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } })).body;
    assert.deepEqual(Object.keys(cron).sort(), ['reconcile_failed', 'reconciled', 'reminders']);
    assert.equal(off.net.regularCalls().length, 0);

    // Регулярка, ввімкнена раніше, лишається під контролем і з вимкненим прапорцем: автосписання, скасування.
    const later = world();
    const parent = await later.autoRenewOn();
    const handler = createBillingHandler({ store: later.store, fetch: later.net.fetch, env: baseEnv({ WAYFORPAY_MERCHANT_PASSWORD: WFP_PASSWORD }), now: () => later.clock.now });
    const res = response();
    await handler(request('GET', 'summary', { token: 'owner' }), res);
    assert.equal(res.body.auto_renew.enabled, true);
    assert.equal('auto_renew_available' in res.body, false);
    const cancel = response();
    await handler(request('POST', 'cancel-auto-renew', { token: 'owner' }), cancel);
    assert.equal(cancel.statusCode, 200);
    assert.equal(later.sub().auto_renew, false);
    assert.equal(later.net.regularCalls()[0].orderReference, parent.provider_order_id);
});

test('merchant password is sent only to regularApi and never logged or returned', async () => {
    const logged = [];
    const original = { warn: console.warn, error: console.error, log: console.log };
    for (const name of Object.keys(original)) console[name] = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
        const w = world({ net: { removeFails: true } });
        await w.autoRenewOn();
        const res = await w.call('POST', 'cancel-auto-renew', { token: 'owner' });
        w.net.state.telegramFails = true;
        await w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
        assert.equal(JSON.stringify(res.body).includes(WFP_PASSWORD), false);
        const elsewhere = w.net.calls.filter((c) => c.url !== 'https://api.wayforpay.com/regularApi');
        assert.equal(elsewhere.some((c) => String(c.body || '').includes(WFP_PASSWORD)), false);
    } finally {
        Object.assign(console, original);
    }
    assert.equal(logged.some((line) => line.includes(WFP_PASSWORD)), false, logged.join('\n'));
});

test('wayforpayDate: Kyiv calendar date as dd.mm.yyyy', () => {
    assert.equal(wayforpayDate(Date.parse('2026-11-17T22:30:00Z')), '18.11.2026');
    assert.equal(wayforpayDate(Date.parse('2026-12-31T21:59:00Z')), '31.12.2026');
});

test('client: the box is separate, unchecked, WayForPay only, sends auto_renew only when ticked', () => {
    const html = read('index.html');
    const modal = html.slice(html.indexOf('<div id="tc-billing-modal"'), html.indexOf('<div id="tc-toast"'));
    assert.match(modal, /<label class="tc-billing-consent tc-billing-autorenew" id="billing-autorenew-box" hidden><input type="checkbox" id="billing-autorenew"><span id="billing-autorenew-text">/);
    assert.equal(/id="billing-autorenew"[^>]*checked/.test(modal), false);
    // Текст: сума й період з summary.prices, «скасувати будь-коли в кабінеті».
    assert.match(html, /'Автоматично продовжувати: ' \+ price\.uah \+ ' грн ' \+ \(BILLING_PLAN_EVERY\[plan\] \|\| ''\) \+ '\. Скасувати можна будь-коли в кабінеті'/);
    assert.match(html, /const BILLING_PLAN_EVERY = \{ month: 'кожен місяць', year: 'кожен рік' \};/);
    const sync = html.slice(html.indexOf('function syncBillingAutoRenew()'), html.indexOf('function setBillingMessage('));
    assert.match(sync, /billingSummary\.auto_renew_available === true/);
    assert.match(sync, /provider && provider\.value === 'wayforpay'/);
    assert.match(sync, /!\(billingSummary\.auto_renew && billingSummary\.auto_renew\.enabled\)/);
    assert.match(sync, /if \(!show\) box\.querySelector\('input'\)\.checked = false;/);
    const start = html.slice(html.indexOf('async function startBillingPayment()'), html.indexOf('function showBillingReturn('));
    assert.match(start, /const autoRenew = billingAutoRenewTicked\(providerEl\.value\);/);
    assert.match(start, /if \(autoRenew\) payload\.auto_renew = true;/);
    assert.equal(/price|amount/.test(start.slice(start.indexOf('const payload'), start.indexOf('JSON.stringify(payload)'))), false);
    // Кожне відкриття — галочку знято.
    assert.match(html.slice(html.indexOf('function renderBilling(summary)'), html.indexOf('function ensureBillingFooter()')),
        /document\.getElementById\('billing-autorenew'\)\.checked = false;/);
});

test('client: CREATE_INVOICE fallback (auto_renew false) — owner is told it is one-off; redirect only on a second click', async () => {
    const html = read('index.html');
    const src = html.slice(html.indexOf('async function startBillingPayment()'), html.indexOf('function showBillingReturn('));
    const els = {
        'billing-consent': { checked: true },
        'billing-pay-btn': { disabled: false, textContent: 'Оплатити 250 грн' },
        'billing-msg': { textContent: '', className: '' }
    };
    const location = { href: '/app' };
    const sent = [];
    const ctx = {
        document: {
            getElementById: (id) => els[id],
            querySelector: () => ({ value: 'wayforpay' })
        },
        location,
        uiPreview: false,
        LEGAL_VERSION: '2026-10-20',
        BILLING_PROVIDER_LABEL: {},
        billingOneOffUrl: null,
        billingAutoRenewTicked: () => true,
        selectedBillingPlan: () => 'month',
        setBillingMessage: (text, tone) => { els['billing-msg'].textContent = text; els['billing-msg'].className = tone || ''; },
        billingFetch: async (path, init) => { sent.push(JSON.parse(init.body)); return { payment_id: 'p1', url: 'https://secure.wayforpay.com/invoice/i123', auto_renew: false }; }
    };
    const vm = await import('node:vm');
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.startBillingPayment = startBillingPayment;', ctx);
    await ctx.startBillingPayment();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auto_renew, true);
    assert.equal(location.href, '/app', 'no redirect yet');
    assert.equal(els['billing-pay-btn'].textContent, 'Перейти до разової оплати');
    assert.equal(els['billing-pay-btn'].disabled, false);
    assert.match(els['billing-msg'].textContent, /^Автопродовження зараз не ввімкнулося — це буде разова оплата без автосписань\./);
    await ctx.startBillingPayment();
    assert.equal(sent.length, 1, 'no second invoice');
    assert.equal(location.href, 'https://secure.wayforpay.com/invoice/i123');

    // Автопродовження ввімкнулося (auto_renew true) — одразу на сторінку оплати.
    ctx.billingOneOffUrl = null;
    location.href = '/app';
    ctx.billingFetch = async () => ({ payment_id: 'p2', url: 'https://secure.wayforpay.com/page?vkh=1', auto_renew: true });
    await ctx.startBillingPayment();
    assert.equal(location.href, 'https://secure.wayforpay.com/page?vkh=1');
    // Зміна тарифу / способу скидає разовий рахунок.
    assert.match(html.slice(html.indexOf('function syncBillingPayButton()'), html.indexOf('function syncBillingAutoRenew()')), /billingOneOffUrl = null;/);
    assert.match(html, /if \(providers\) providers\.addEventListener\('change', syncBillingPayButton\);/);
});

test('client: cabinet shows the status and the cancel button to the owner only', () => {
    const html = read('index.html');
    const cabinet = html.slice(html.indexOf('<div id="cabinet-screen">'), html.indexOf('<div id="admin-screen">'));
    assert.match(cabinet, /<div class="cab-autorenew" id="cab-autorenew" hidden>/);
    assert.match(cabinet, /<button type="button" class="btn cab-autorenew-cancel" id="cab-autorenew-cancel" onclick="cancelAutoRenew\(\)">Скасувати автопродовження<\/button>/);
    const load = html.slice(html.indexOf('async function loadCabinetAutoRenew()'), html.indexOf('async function cancelAutoRenew()'));
    assert.match(load, /box\.hidden = true;/);
    assert.match(load, /if \(currentOrgRole !== 'owner' \|\| !billingEnabled\) return;/);
    assert.match(html, /'Автопродовження увімкнено, наступне списання ' \+ billingDate\(ar\.next_charge_at\) \+ \(ar\.card_mask \? ', картка ' \+ ar\.card_mask : ''\)/);
    assert.match(load, /ar\.removing\n\s+\? 'Автопродовження скасовується: чекаємо підтвердження WayForPay \(повторюємо щодня\)\./);
    const cancel = html.slice(html.indexOf('async function cancelAutoRenew()'), html.indexOf('// ===== Демо-режим ====='));
    assert.match(cancel, /billingFetch\('cancel-auto-renew', \{ method: 'POST' \}\)/);
    assert.match(html.slice(html.indexOf('function openCabinet()'), html.indexOf('function openCabinet()') + 4000), /loadCabinetAutoRenew\(\);/);
    assert.match(html, /else if \(mode === 'auto-renew'\) showCabinetAutoRenew\(\);/);
});

test('offer and /payment-refund describe auto-renewal: sum, period, how to cancel, failed charge', () => {
    const offer = read('legal/offer.html');
    assert.equal(offer.includes('Автоматичного продовження та автоматичних списань немає'), false);
    assert.match(offer, /<p>4\.4\. <strong>Автоматичні списання здійснюються лише тоді, коли Власник Організації сам увімкнув Автопродовження<\/strong> \(пункти 4\.9–4\.16\)\./);
    for (const n of ['4.9', '4.10', '4.11', '4.12', '4.13', '4.14', '4.15', '4.16']) assert.ok(offer.includes('<p>' + n + '. '), n);
    assert.match(offer, /<strong>250 грн щомісяця<\/strong> \(тариф «1 місяць»\) або <strong>2 500 грн щороку<\/strong> \(тариф «1 рік»\)/);
    assert.match(offer, /окремою позначкою \(за замовчуванням не встановлена\)/);
    assert.match(offer, /Особистий кабінет → «Скасувати автопродовження»/);
    assert.match(offer, /Після двох невдалих спроб поспіль Автопродовження вимикається/);
    const refund = read('legal/payment-refund.html');
    assert.match(refund, /<h2>Автопродовження<\/h2>/);
    assert.match(refund, /250 грн щомісяця \(тариф «1 місяць»\) або 2 500 грн щороку \(тариф «1 рік»\)/);
    assert.match(refund, /кнопка «Скасувати автопродовження»/);
    assert.match(refund, /Після двох невдалих спроб поспіль автопродовження вимикається/);
    assert.equal(refund.includes('<strong>Автоматичних списань немає.</strong>'), false);
    // Footer CSS did not change: its ?v= stays.
    assert.match(refund, /\/assets\/legal-footer\.css\?v=2026-10-20b/);
});

test('migration: columns, kind / parent, unique order reference kept, clients read paid_until only', () => {
    const sql = read('supabase/migrations/20261020200000_auto_renew.sql');
    for (const column of [
        'auto_renew boolean NOT NULL DEFAULT false', 'wfp_regular_order_ref text NULL', 'card_mask text NULL',
        'next_charge_at timestamptz NULL', 'regular_status text NULL', 'fail_count integer NOT NULL DEFAULT 0',
        'auto_renew_consent_at timestamptz NULL', 'auto_renew_cancelled_at timestamptz NULL',
        "kind text NOT NULL DEFAULT 'initial'", 'parent_payment_id uuid NULL REFERENCES public.payments (id)'
    ]) assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS ' + column), column);
    assert.match(sql, /CHECK \(kind IN \('initial', 'renewal'\)\)/);
    assert.equal(/payments_provider_order_uidx/.test(sql), false, 'unique index untouched');
    assert.match(sql, /GRANT SELECT \(org_id, paid_until, last_plan, reminder_sent_for, updated_at\) ON public\.org_subscriptions TO authenticated;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_renewal_failure\(uuid\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE SELECT ON public\.org_subscriptions FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE SELECT \(auto_renew, wfp_regular_order_ref, card_mask, next_charge_at, regular_status, regular_remove_reason,\n\s+regular_stop_check, fail_count, auto_renew_consent_at, auto_renew_cancelled_at\) ON public\.org_subscriptions FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /Not applied to production by this PR\./);
});

test('auto-renew migration on Postgres (PGlite)', (t) => {
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-auto-renew.mjs', import.meta.url))], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const line of [
        'same _WFPREG- reference twice: unique violation (23505)',
        'renewal credited by apply_payment_success, twice = one month',
        'authenticated cannot read org_subscriptions.card_mask (42501)',
        'authenticated cannot update org_subscriptions.auto_renew (42501)',
        'owner still reads paid_until of own company',
        'payment_events: unmatched renewal event without payment_id, with order_reference',
        'payment_events: still no client access (42501)',
        'anon: SELECT card_mask FROM public.org_subscriptions (42501)'
    ]) assert.ok(run.stdout.includes('PASS ' + line), line);
});
