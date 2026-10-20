import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDemoAccess } from '../lib/billing/access.js';
import { createBillingHandler } from '../lib/billing/service.js';
import { LEGAL_VERSION } from '../lib/legal.js';
import { baseEnv, DAY, fakeNet, memoryStore, NOW, ORG, request, response, WFP_MERCHANT, WFP_SECRET } from './billing-fakes.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Лише WayForPay: без MONO_TOKEN / MONO_PUBKEY.
function world(envExtra = {}) {
    const clock = { now: NOW };
    const net = fakeNet();
    const store = memoryStore(clock);
    const env = baseEnv(Object.assign({ MONO_TOKEN: '' }, envExtra));
    const handler = createBillingHandler({ store, fetch: net.fetch, env, now: () => clock.now });
    async function call(method, route, options) {
        const res = response();
        await handler(request(method, route, options), res);
        return res;
    }
    const pay = (body) => call('POST', 'create-invoice', { token: 'owner', body: Object.assign({ consent: true, legal_version: LEGAL_VERSION }, body) });
    function wfpBody(fields) {
        const body = Object.assign({ merchantAccount: WFP_MERCHANT, currency: 'UAH', authCode: '541963', cardPan: '41****8217', reasonCode: 1100 }, fields);
        body.merchantSignature = crypto.createHmac('md5', WFP_SECRET).update([
            body.merchantAccount, body.orderReference, body.amount, body.currency, body.authCode, body.cardPan, body.transactionStatus, body.reasonCode
        ].join(';'), 'utf8').digest('hex');
        return body;
    }
    const wfpHook = (body) => call('POST', 'wayforpay-webhook', { raw: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { clock, net, store, call, pay, wfpBody, wfpHook };
}

test('PAYMENTS_ENABLED=1 with WAYFORPAY_* only: mono is hidden, 250 грн moves paid_until once, one Telegram alert', async () => {
    const w = world();
    const summary = await w.call('GET', 'summary', { token: 'owner' });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.body.payments_enabled, true);
    assert.deepEqual(summary.body.providers, ['wayforpay']);

    const mono = await w.pay({ plan: 'month', provider: 'mono' });
    assert.equal(mono.statusCode, 503);
    assert.equal(mono.body.code, 'PROVIDER_UNAVAILABLE');

    const created = await w.pay({ plan: 'month', provider: 'wayforpay' });
    assert.equal(created.statusCode, 200, JSON.stringify(created.body));
    assert.match(created.body.url, /^https:\/\/secure\.wayforpay\.com\//);
    assert.equal(w.store.db.payments[0].amount_minor, 25000);
    assert.equal(w.net.calls.some((c) => c.url.startsWith('https://api.monobank.ua/')), false);

    const ok = w.wfpBody({ orderReference: 'tc-' + created.body.payment_id, amount: 250, transactionStatus: 'Approved', processingDate: 1760778300 });
    assert.equal((await w.wfpHook(ok)).body.status, 'accept');
    const until = w.store.db.subs[ORG].paid_until;
    assert.equal(until, '2026-11-18T09:00:00.000Z');
    assert.deepEqual(w.net.telegrams(), ['💳 Оплата: ТОВ «Агро» · 1 місяць · 250 грн · WayForPay · оплачено до 18.11.2026']);

    // Повторна нотифікація: accept, але paid_until і сповіщення не змінюються.
    w.clock.now += 5 * 60 * 1000;
    assert.equal((await w.wfpHook(ok)).body.status, 'accept');
    assert.equal(w.store.db.subs[ORG].paid_until, until);
    assert.equal(w.net.telegrams().length, 1);
});

test('without PAYMENTS_ENABLED: no providers in summary and create-invoice is refused', async () => {
    for (const value of [undefined, '', '0', 'true']) {
        const w = world({ PAYMENTS_ENABLED: value });
        const summary = await w.call('GET', 'summary', { token: 'owner' });
        assert.equal(summary.body.payments_enabled, false, String(value));
        assert.deepEqual(summary.body.providers, []);
        const res = await w.pay({ plan: 'month', provider: 'wayforpay' });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, 'PAYMENTS_DISABLED');
        assert.equal(w.store.db.payments.length, 0);
    }
});

test('reminder 3 days before the end is email (Resend) only, no Telegram', async () => {
    const w = world();
    w.store.db.subs[ORG] = { org_id: ORG, paid_until: new Date(NOW + 3 * DAY).toISOString(), reminder_sent_for: null };
    const res = await w.call('GET', 'cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.equal(res.body.reminders.sent, 1);
    assert.equal(w.net.calls.filter((c) => c.url === 'https://api.resend.com/emails').length, 1);
    assert.deepEqual(w.net.telegrams(), []);
});

test('manual is_approved stays permanent full access; a paid company is full access until paid_until', () => {
    assert.equal(isDemoAccess({ is_approved: true }, null, NOW), false);
    assert.equal(isDemoAccess({ is_approved: true }, new Date(NOW - DAY).toISOString(), NOW), false);
    assert.equal(isDemoAccess({ is_approved: false }, new Date(NOW + DAY).toISOString(), NOW), false);
    assert.equal(isDemoAccess({ is_approved: false }, new Date(NOW - DAY).toISOString(), NOW), true);
    const sql = read('supabase/migrations/20261018190000_payments.sql');
    assert.match(sql, /SELECT p\.is_approved OR coalesce\(public\.org_has_paid_access\(public\.current_org_id\(\)\), false\)/);
});

test('POI search (api/poi.js) lets a paid company in, same rule as /api/calculate', () => {
    const source = read('api/poi.js');
    assert.match(source, /import \{ isDemoAccess, loadPaidUntil \} from '\.\.\/lib\/billing\/access\.js';/);
    assert.match(source, /\.select\('is_approved, org_id, member_status, organizations\(status\)'\)/);
    assert.match(source, /if \(!profile \|\| isDemoAccess\(profile, profile\.is_approved \? null : await loadPaidUntil\(admin, profile\.org_id\)\)\) \{/);
    assert.equal(/!profile\.is_approved\)/.test(source), false);
});

test('client: the billing screen exists only when the server says payments_enabled', () => {
    const html = read('index.html');
    assert.match(html, /<button type="button" role="menuitem" class="tc-menu-item" id="tc-menu-billing" hidden onclick="menuGo\('billing'\)">Тариф і оплата<\/button>/);
    assert.match(html, /setBillingEnabled\(summary\.payments_enabled === true\);/);
    assert.match(html, /catch \(e\) \{\n\s+setBillingEnabled\(false\);/);
    assert.match(html, /if \(!modal \|\| !billingEnabled\) return;/);
    assert.match(html, /if \(!billingEnabled\) return;\n\s+if \(mode === 'pay'\) openBillingModal\(\);/);
    assert.match(html, /const show = billingEnabled && !billingManualAccess/);
    assert.match(html, /refreshBillingAvailability\(\)\.then\(handleBillingParams\);/);
});

test('merge with main keeps the landing, cost hints and 365 work days', () => {
    const html = read('index.html');
    assert.match(html, /<div id="landing-screen" hidden>/);
    assert.match(html, /\/assets\/landing\.js\?v=2026-10-20/);
    assert.match(html, /\/assets\/cost-hints\.js\?v=2026-10-20/);
    assert.match(html, /else if \(landingDraftApplied\) showToast\('Підставили дані з головної — натисни «Розрахувати»'\);\n\s+refreshBillingAvailability\(\)/);
    assert.match(html, /#rt-info\.is-warning \{ color: var\(--warning-text\) !important; \}\n\s+\/\* Тариф і оплата/);
    assert.match(read('api/calculate.js'), /const workDaysYear = 365;/);
});
