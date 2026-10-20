// Спільні фейки для тестів оплати: in-memory store з тим самим інтерфейсом, що lib/billing/store.js,
// і з тією ж семантикою, що SQL apply_payment_success / apply_payment_status; мок fetch; req/res.
import crypto from 'node:crypto';
import { extendPaidUntil } from '../lib/billing/plans.js';

export const NOW = Date.parse('2026-10-18T09:00:00Z');
export const DAY = 24 * 60 * 60 * 1000;
export const ORG = '10000000-0000-4000-8000-000000000001';
export const OWNER = '00000000-0000-4000-8000-000000000001';
export const LOGIST = '00000000-0000-4000-8000-000000000002';
export const OTHER_OWNER = '00000000-0000-4000-8000-000000000003';
export const OTHER_ORG = '10000000-0000-4000-8000-000000000002';

export const WFP_SECRET = 'test-wfp-secret-key';
export const WFP_MERCHANT = 'trip_control_test';

export function monoKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    return {
        pem,
        base64: Buffer.from(pem).toString('base64'),
        sign: (raw) => crypto.sign('sha256', Buffer.from(raw), privateKey).toString('base64')
    };
}

export function baseEnv(extra = {}) {
    return Object.assign({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
        PUBLIC_BASE_URL: 'https://trip-control.com',
        PAYMENTS_ENABLED: '1',
        MONO_TOKEN: 'mono-test-token',
        WAYFORPAY_MERCHANT_ACCOUNT: WFP_MERCHANT,
        WAYFORPAY_SECRET_KEY: WFP_SECRET,
        WAYFORPAY_MERCHANT_DOMAIN: 'trip-control.com',
        RESEND_API_KEY: 're_test',
        REPORT_FROM_EMAIL: 'TRIP-CONTROL <billing@trip-control.com>',
        CRON_SECRET: 'cron-test-secret',
        TELEGRAM_BOT_TOKEN: '1:abc',
        TELEGRAM_CHAT_ID: '777'
    }, extra);
}

export function memoryStore(clock) {
    const db = {
        users: {
            owner: { id: OWNER, email: 'owner@agro.ua', banned_until: null },
            logist: { id: LOGIST, email: 'logist@agro.ua', banned_until: null },
            other: { id: OTHER_OWNER, email: 'boss@other.ua', banned_until: null }
        },
        profiles: {
            [OWNER]: { id: OWNER, email: 'owner@agro.ua', org_id: ORG, org_role: 'owner', member_status: 'active', is_approved: false },
            [LOGIST]: { id: LOGIST, email: 'logist@agro.ua', org_id: ORG, org_role: 'logist', member_status: 'active', is_approved: false },
            [OTHER_OWNER]: { id: OTHER_OWNER, email: 'boss@other.ua', org_id: OTHER_ORG, org_role: 'owner', member_status: 'active', is_approved: false }
        },
        orgs: {
            [ORG]: { id: ORG, name: 'ТОВ «Агро»', status: 'active' },
            [OTHER_ORG]: { id: OTHER_ORG, name: 'Інша', status: 'active' }
        },
        subs: {},
        payments: [],
        events: [],
        consents: [],
        failInsertEvent: false
    };
    const iso = () => new Date(clock.now).toISOString();
    const store = {
        db,
        async getUser(token) { return db.users[token] || null; },
        async getProfile(userId) {
            const p = db.profiles[userId];
            return p ? Object.assign({}, p, { organizations: Object.assign({}, db.orgs[p.org_id]) }) : null;
        },
        async getSubscription(orgId) { return db.subs[orgId] ? Object.assign({}, db.subs[orgId]) : null; },
        async getOrgName(orgId) { return (db.orgs[orgId] || {}).name || ''; },
        async countPaymentsSince(orgId, sinceIso) {
            return db.payments.filter((p) => p.org_id === orgId && p.created_at >= sinceIso).length;
        },
        async insertPayment(row) {
            if (db.payments.some((p) => p.provider === row.provider && p.provider_order_id === row.provider_order_id)) {
                throw Object.assign(new Error('duplicate'), { code: '23505' });
            }
            const payment = Object.assign({
                currency: 'UAH', provider_invoice_id: null, provider_modified_at: null, credited_at: null,
                period_from: null, period_to: null, refund_note: null, created_at: iso(), updated_at: iso(),
                kind: 'initial', parent_payment_id: null, auto_renew_requested_at: null
            }, row);
            db.payments.push(payment);
            return Object.assign({}, payment);
        },
        async updatePayment(id, patch) {
            Object.assign(db.payments.find((p) => p.id === id), patch, { updated_at: iso() });
        },
        async insertConsent(row) { db.consents.push(Object.assign({ accepted_at: iso() }, row)); },
        async getPayment(id) {
            const p = db.payments.find((row) => row.id === id);
            return p ? Object.assign({}, p) : null;
        },
        async findPayment(provider, field, value) {
            const p = db.payments.find((row) => row.provider === provider && row[field] === value);
            return p ? Object.assign({}, p) : null;
        },
        async listPayments(orgId, limit) {
            return db.payments.filter((p) => p.org_id === orgId).slice().reverse().slice(0, limit).map((p) => Object.assign({}, p));
        },
        async insertEvent(row) {
            if (db.failInsertEvent) throw Object.assign(new Error('db down'), { code: 'EDB' });
            db.events.push(Object.assign({ received_at: iso() }, row));
        },
        async countEvents({ paymentId, orderReference, status }) {
            return db.events.filter((e) => (paymentId ? e.payment_id === paymentId : (e.payment_id == null && e.order_reference === orderReference))
                && (e.status == null ? status == null : e.status === status)).length;
        },
        // Та сама логіка, що apply_payment_success у міграції.
        async applySuccess(id, modified) {
            const p = db.payments.find((row) => row.id === id);
            const sub = db.subs[p.org_id];
            if (p.credited_at) return { credited: false, already_credited: true, paid_until: sub && sub.paid_until };
            if (modified && p.provider_modified_at && Date.parse(modified) < Date.parse(p.provider_modified_at)) {
                return { credited: false, already_credited: false, stale: true, paid_until: sub && sub.paid_until };
            }
            const period = extendPaidUntil(sub && sub.paid_until, p.plan, clock.now);
            db.subs[p.org_id] = Object.assign(sub || { org_id: p.org_id }, {
                paid_until: period.to.toISOString(), last_plan: p.plan, reminder_sent_for: null
            });
            Object.assign(p, {
                status: 'success', credited_at: iso(), period_from: period.from.toISOString(), period_to: period.to.toISOString(),
                provider_modified_at: modified || p.provider_modified_at
            });
            return { credited: true, already_credited: false, paid_until: period.to.toISOString() };
        },
        // Та сама логіка, що apply_payment_status у міграції.
        async applyStatus(id, status, modified) {
            const p = db.payments.find((row) => row.id === id);
            if (p.status === status
                || (modified && p.provider_modified_at && Date.parse(modified) < Date.parse(p.provider_modified_at))
                || (p.credited_at && !['reversed', 'refunded'].includes(status))) {
                return { changed: false, previous: p.status, status: p.status };
            }
            const previous = p.status;
            Object.assign(p, { status, provider_modified_at: modified || p.provider_modified_at });
            return { changed: true, previous, status };
        },
        // Та сама логіка, що apply_payment_reversal (20261020180000_refund_cut.sql).
        async applyReversal(id, modified, partial) {
            const p = db.payments.find((row) => row.id === id);
            const sub = db.subs[p.org_id];
            const base = { previous: p.status, credited: !!p.credited_at, partial: !!partial, paid_until: sub ? sub.paid_until : null };
            if (p.status === 'refunded' || (modified && p.provider_modified_at && Date.parse(modified) < Date.parse(p.provider_modified_at))) {
                return Object.assign(base, { changed: false, cut: false, status: p.status });
            }
            const statusChanged = p.status !== 'reversed';
            const cut = !!(p.credited_at && !p.reversal_applied_at && !partial && p.period_from && p.period_to);
            if (!statusChanged && !cut) return Object.assign(base, { changed: false, cut: false, status: p.status });
            if (cut && sub && sub.paid_until) {
                const until = Date.parse(sub.paid_until);
                const next = Math.min(until, Math.max(clock.now, until - (Date.parse(p.period_to) - Date.parse(p.period_from))));
                Object.assign(sub, { paid_until: new Date(next).toISOString(), reminder_sent_for: null });
                base.paid_until = sub.paid_until;
            }
            Object.assign(p, {
                status: 'reversed',
                reversal_applied_at: cut ? iso() : (p.reversal_applied_at || null),
                provider_modified_at: modified || p.provider_modified_at
            });
            return Object.assign(base, { changed: true, cut, status: 'reversed' });
        },
        async markPartialRefundAlerted(id) {
            const p = db.payments.find((row) => row.id === id);
            if (!p || p.partial_refund_alerted_at) return false;
            p.partial_refund_alerted_at = iso();
            return true;
        },
        async orgHasManualAccess(orgId) {
            return Object.values(db.profiles).some((p) => p.org_id === orgId && p.is_approved === true);
        },
        async subscriptionsEndingBetween(fromIso, toIso) {
            return Object.values(db.subs).filter((s) => s.paid_until >= fromIso && s.paid_until < toIso).map((s) => Object.assign({}, s));
        },
        async activeOwners(orgId) {
            return Object.values(db.profiles).filter((p) => p.org_id === orgId && p.org_role === 'owner' && p.member_status === 'active').map((p) => p.email);
        },
        async orgStatus(orgId) { return db.orgs[orgId] ? { name: db.orgs[orgId].name, status: db.orgs[orgId].status } : null; },
        async markReminderSent(orgId, paidUntil) {
            if (db.subs[orgId] && db.subs[orgId].paid_until === paidUntil) db.subs[orgId].reminder_sent_for = paidUntil;
        },
        // Автопродовження (20261020200000_auto_renew.sql): поля org_subscriptions з тими ж значеннями за замовчуванням.
        async getAutoRenew(orgId) {
            const sub = db.subs[orgId];
            return sub ? Object.assign({ auto_renew: false, fail_count: 0 }, sub) : null;
        },
        async updateAutoRenew(orgId, patch) {
            if (db.subs[orgId]) Object.assign(db.subs[orgId], patch);
        },
        async recordRenewalFailure(orgId) {
            const sub = db.subs[orgId];
            if (!sub) return 0;
            sub.fail_count = (sub.fail_count || 0) + 1;
            return sub.fail_count;
        },
        async autoRenewSubscriptions() {
            return Object.values(db.subs).filter((sub) => sub.auto_renew === true || sub.regular_status === 'RemovePending').map((sub) => Object.assign({ fail_count: 0 }, sub));
        },
        async openPaymentsBetween(fromIso, toIso) {
            return db.payments.filter((p) => ['created', 'pending'].includes(p.status) && p.created_at >= fromIso && p.created_at <= toIso)
                .map((p) => Object.assign({}, p));
        }
    };
    return store;
}

// Мок мережі: mono, WayForPay, Telegram, Resend. Кожен виклик пишеться в calls.
export function fakeNet(options = {}) {
    const calls = [];
    const state = Object.assign({
        monoKeyBase64: '',
        monoStatus: null,
        wfpOffline: true,
        wfpCheck: null,
        // regularApi: стан регулярок за orderReference; removeFails — REMOVE відповідає помилкою.
        regular: {},
        removeFails: false,
        // removeCode — reasonCode відповіді REMOVE (напр. 4101 «вже видалено»); statusCode / statusExtra — відповідь STATUS.
        removeCode: null,
        statusCode: 4100,
        statusExtra: {},
        telegramFails: false,
        resendFails: false,
        invoiceSeq: 0
    }, options);
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
    async function fetch(url, init = {}) {
        const u = String(url);
        const call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body };
        calls.push(call);
        if (u === 'https://api.monobank.ua/api/merchant/invoice/create') {
            state.invoiceSeq += 1;
            const id = 'inv_' + state.invoiceSeq;
            return json(200, { invoiceId: id, pageUrl: 'https://pay.mbnk.biz/' + id });
        }
        if (u === 'https://api.monobank.ua/api/merchant/pubkey') return json(200, { key: state.monoKeyBase64 });
        if (u.startsWith('https://api.monobank.ua/api/merchant/invoice/status')) return json(200, state.monoStatus || {});
        if (u === 'https://secure.wayforpay.com/pay?behavior=offline') {
            return state.wfpOffline ? json(200, { url: 'https://secure.wayforpay.com/page?vkh=abc123' }) : json(200, { reason: 'unsupported' });
        }
        if (u === 'https://api.wayforpay.com/api') {
            const body = JSON.parse(init.body);
            if (body.transactionType === 'CREATE_INVOICE') return json(200, { invoiceUrl: 'https://secure.wayforpay.com/invoice/i123', reasonCode: 1100 });
            if (body.transactionType === 'CHECK_STATUS') return json(200, state.wfpCheck || {});
        }
        if (u === 'https://api.wayforpay.com/regularApi') {
            const body = JSON.parse(init.body);
            if (body.requestType === 'REMOVE') {
                if (state.removeCode != null) return json(200, { reasonCode: state.removeCode, reason: 'Code ' + state.removeCode });
                if (state.removeFails) return json(200, { reasonCode: 4102, reason: 'Error' });
                state.regular[body.orderReference] = 'Removed';
                return json(200, { reasonCode: 4100, reason: 'Ok' });
            }
            if (body.requestType === 'STATUS') {
                return json(200, Object.assign({ reasonCode: state.statusCode, reason: 'Ok', orderReference: body.orderReference,
                    status: state.regular[body.orderReference] || 'Active' }, state.statusExtra));
            }
        }
        if (u.startsWith('https://api.telegram.org/')) {
            if (state.telegramFails) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            return json(200, { ok: true });
        }
        if (u === 'https://api.resend.com/emails') return state.resendFails ? json(500, {}) : json(200, { id: 'mail_1' });
        return json(404, {});
    }
    const regularCalls = () => calls.filter((c) => c.url === 'https://api.wayforpay.com/regularApi').map((c) => JSON.parse(c.body));
    return { fetch, calls, state, regularCalls, telegrams: () => calls.filter((c) => c.url.startsWith('https://api.telegram.org/')).map((c) => JSON.parse(c.body).text) };
}

export function request(method, route, { token, body, raw, headers = {}, query = {} } = {}) {
    const h = Object.assign({}, headers);
    if (token) h.authorization = 'Bearer ' + token;
    const qs = new URLSearchParams(query).toString();
    const rawBody = raw != null ? Buffer.from(raw) : Buffer.from(body == null ? '' : JSON.stringify(body));
    return { method, url: '/api/billing/' + route + (qs ? '?' + qs : ''), headers: h, query: Object.assign({ route }, query), rawBody };
}

export function response() {
    const res = {
        statusCode: 0, body: null, headers: {}, location: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        redirect(code, location) { this.statusCode = code; this.location = location; return this; },
        end() { return this; }
    };
    return res;
}
