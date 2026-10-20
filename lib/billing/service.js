// Оплата тарифу організації: plata by mono і WayForPay. Одна функція api/billing/[route].js —
// динамічний маршрут Vercel: /api/billing/<route> → req.query.route, без rewrites; невідомий маршрут — 404.
//
// deps: { store, fetch, env, now }. Секрети не логуємо й не повертаємо в помилках.
import crypto from 'node:crypto';
import { LEGAL_VERSION } from '../legal.js';
import { userIsBlocked, USER_BLOCKED_ERROR } from '../account-block.js';
import { sendTelegram, telegramConfig } from '../signup-notify.js';
import { cronAuthorized } from '../weekly-report.js';
import { formatKyivDate, hasPaidAccess, kyivYmd, addDaysYmd } from './access.js';
import { buildReminderEmail, reminderMailConfigured, sendReminderEmail } from './mail.js';
import { MONO_CCY, CURRENCY, PROVIDER_LABEL, PROVIDERS, planFor, publicPrices, wayforpayAmount } from './plans.js';
import * as mono from './mono.js';
import * as wfp from './wayforpay.js';

export const RATE_LIMIT_PER_HOUR = 10;
export const STATUS_CHECK_MIN_AGE_MS = 10 * 60 * 1000;
export const STATUS_CHECK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = new Set(['created', 'pending']);

export class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function isUuid(value) {
    return UUID_RE.test(String(value || ''));
}

// Сире тіло: підпис mono рахується по байтах, тож req.body не чіпаємо.
export async function readRawBody(req) {
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
    if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function parseJson(raw) {
    try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
        return text.trim() ? JSON.parse(text) : {};
    } catch (e) {
        return null;
    }
}

// Тіло WayForPay — JSON, але може прийти з Content-Type form-urlencoded: тоді сирий рядок
// усе одно JSON (іноді як єдиний ключ форми). Парсимо в обох випадках.
export function parseWayforpayBody(raw) {
    const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')).trim();
    if (!text) return null;
    const direct = parseJson(text);
    if (direct && typeof direct === 'object') return direct;
    try {
        const params = new URLSearchParams(text);
        for (const [key, value] of params) {
            const fromKey = parseJson(key);
            if (fromKey && typeof fromKey === 'object' && !value) return fromKey;
            const fromValue = value ? parseJson(value) : null;
            if (fromValue && typeof fromValue === 'object') return fromValue;
        }
    } catch (e) { /* fall through */ }
    return null;
}

function header(req, name) {
    const headers = req.headers || {};
    const value = headers[name] != null ? headers[name] : headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

export function providerAvailability(env) {
    const base = !!(String(env.SUPABASE_URL || '').trim() && String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
        && /^https:\/\//.test(String(env.PUBLIC_BASE_URL || '').trim()));
    return {
        mono: base && mono.monoConfigured(env),
        wayforpay: base && wfp.wayforpayConfigured(env)
    };
}

function baseUrl(env) {
    return String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

// Алерт адміну: компанія, тариф, сума, провайдер, оплачено до. Без email, картки чи id платника —
// перелік зафіксований у політиці конфіденційності. Для повернення: нове «оплачено до» або
// «доступ завершено»; часткове / незараховане повернення — з позначкою «доступ не змінено».
export function paymentAlertText(kind, { orgName, plan, provider, paidUntil, partialMinor, notCredited, now = Date.now() }) {
    const planDef = planFor(plan);
    const company = String(orgName || '—').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) || '—';
    const parts = [
        company,
        planDef ? planDef.label : String(plan || ''),
        (planDef ? planDef.uah : '') + ' грн',
        PROVIDER_LABEL[provider] || String(provider || '')
    ];
    if (kind !== 'reversed') {
        parts.push('оплачено до ' + (paidUntil ? formatKyivDate(paidUntil) : '—'));
        return '💳 Оплата: ' + parts.join(' · ');
    }
    if (partialMinor) parts.push('повернення часткове (' + Math.round(partialMinor) / 100 + ' грн), доступ не змінено');
    else if (notCredited) parts.push('платіж не був зарахований, доступ не змінено');
    parts.push(hasPaidAccess(paidUntil, now) ? 'оплачено до ' + formatKyivDate(paidUntil) : 'доступ завершено');
    return '↩️ Повернення: ' + parts.join(' · ');
}

// Сума повернення в копійках. mono: amount − finalAmount (якщо finalAmount є), інакше amount;
// WayForPay: refundAmount (якщо є), інакше amount. NaN — суми немає (повне, за статусом).
export function refundMinor(provider, body, payment) {
    const num = (v) => (v == null || v === '' ? NaN : Number(v));
    if (provider === 'mono') {
        const final = num(body.finalAmount);
        return Number.isFinite(final) ? payment.amount_minor - final : num(body.amount);
    }
    const uah = Number.isFinite(num(body.refundAmount)) ? num(body.refundAmount) : num(body.amount);
    return Number.isFinite(uah) ? Math.round(uah * 100) : NaN;
}

// Часткове — лише коли сума відома й менша за суму платежу.
export function isPartialRefund(minor, payment) {
    return Number.isFinite(minor) && minor > 0 && minor < payment.amount_minor;
}

export function createBillingService(deps) {
    const store = deps.store;
    const env = deps.env || {};
    const fetchImpl = deps.fetch;
    const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
    const monoKeys = deps.monoKeys || mono.createPubKeyCache(fetchImpl, env, { now });

    async function requireMember(req) {
        const auth = String(header(req, 'authorization') || '');
        if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED', 'Необхідна авторизація.');
        const user = await store.getUser(auth.slice('Bearer '.length));
        if (!user) throw new HttpError(401, 'BAD_TOKEN', 'Недійсний токен.');
        if (userIsBlocked(user, now())) throw new HttpError(403, USER_BLOCKED_ERROR.code, USER_BLOCKED_ERROR.error);
        const profile = await store.getProfile(user.id);
        if (!profile || !profile.org_id) throw new HttpError(403, 'NO_PROFILE', 'Профіль користувача не знайдено.');
        if (profile.member_status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
        if (!profile.organizations || profile.organizations.status === 'blocked') {
            throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
        }
        return { user, profile };
    }

    async function requireOwner(req) {
        const actor = await requireMember(req);
        if (actor.profile.org_role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Оплату здійснює власник компанії.');
        if (actor.profile.organizations.status !== 'active') throw new HttpError(403, 'ORG_NOT_ACTIVE', 'Компанія неактивна.');
        return actor;
    }

    async function alert(kind, payment, paidUntil, extra = {}) {
        if (!telegramConfig(env) || typeof fetchImpl !== 'function') return;
        try {
            const orgName = await store.getOrgName(payment.org_id);
            await sendTelegram(paymentAlertText(kind, Object.assign({
                orgName, plan: payment.plan, provider: payment.provider, paidUntil, now: now()
            }, extra)), { fetch: fetchImpl, env, timeoutMs: 3000 });
        } catch (e) {
            console.warn('payment alert failed:', e && e.code);
        }
    }

    async function recordEvent(payment, { status, modified, signatureOk, source, payload }) {
        try {
            await store.insertEvent({
                payment_id: payment.id,
                provider: payment.provider,
                status: status || null,
                provider_modified_at: modified || null,
                signature_ok: signatureOk == null ? null : !!signatureOk,
                source,
                payload: payload || {}
            });
        } catch (e) {
            console.warn('payment event insert failed:', e && e.code);
        }
    }

    // Спільне для вебхуків і status-check: подія, звірка суми, статус з урахуванням порядку,
    // зарахування й алерт лише при фактичній зміні. Повертає { status, paid_until, credited }.
    async function applyUpdate(payment, update) {
        await recordEvent(payment, update);
        const status = update.mapped;
        const amountOk = update.amountOk !== false;
        // Повернення фіксуємо завжди (сума може бути частковою чи в іншому вигляді) — лише попередження.
        const refund = status === 'reversed' || status === 'refunded';
        if (!amountOk) console.warn('payment amount/currency mismatch', payment.id, status || '');
        if (!status || (!amountOk && !refund)) {
            return { status: payment.status, credited: false, ignored: true };
        }
        if (status === 'success') {
            const result = await store.applySuccess(payment.id, update.modified || null);
            if (result && result.credited) await alert('success', payment, result.paid_until);
            return { status: result && (result.credited || result.already_credited) ? 'success' : payment.status, credited: !!(result && result.credited), paid_until: result && result.paid_until };
        }
        if (status === 'reversed') {
            // Повне повернення зарахованого платежу скорочує paid_until на його період (один раз, у SQL);
            // часткове й незараховане — лише статус.
            const partial = isPartialRefund(update.refundMinor, payment);
            const result = await store.applyReversal(payment.id, update.modified || null, partial);
            if (result && result.changed) {
                let paidUntil = result.paid_until;
                if (paidUntil === undefined) {
                    const sub = await store.getSubscription(payment.org_id);
                    paidUntil = sub && sub.paid_until;
                }
                const credited = result.credited !== undefined ? !!result.credited : !!payment.credited_at;
                await alert('reversed', payment, paidUntil, {
                    partialMinor: partial && credited ? update.refundMinor : 0,
                    notCredited: !credited
                });
            }
            return { status: (result && result.status) || payment.status, credited: false };
        }
        const result = await store.applyStatus(payment.id, status, update.modified || null);
        return { status: (result && result.status) || payment.status, credited: false };
    }

    function monoUpdate(body, payment, source, signatureOk) {
        return {
            mapped: mono.monoStatus(body.status),
            status: body.status != null ? String(body.status) : null,
            modified: body.modifiedDate ? new Date(body.modifiedDate).toISOString() : null,
            amountOk: Number(body.amount) === payment.amount_minor && Number(body.ccy) === MONO_CCY,
            refundMinor: refundMinor('mono', body, payment),
            payload: mono.monoEventPayload(body),
            source,
            signatureOk
        };
    }

    function wfpUpdate(body, payment, source, signatureOk) {
        const plan = planFor(payment.plan);
        const expectedAmount = plan ? Number(wayforpayAmount(plan)) : NaN;
        return {
            mapped: wfp.wayforpayStatus(body.transactionStatus),
            status: body.transactionStatus != null ? String(body.transactionStatus) : null,
            modified: wfp.wayforpayModified(body),
            // Порівнюємо числом: 250, 250.00 і "250.00" — одна сума.
            amountOk: Number(body.amount) === expectedAmount && Math.round(Number(body.amount) * 100) === payment.amount_minor
                && String(body.currency || '') === CURRENCY,
            refundMinor: refundMinor('wayforpay', body, payment),
            payload: wfp.wayforpayEventPayload(body),
            source,
            signatureOk
        };
    }

    async function checkWithProvider(payment) {
        const available = providerAvailability(env);
        if (payment.provider === 'mono') {
            if (!available.mono || !payment.provider_invoice_id) return null;
            const body = await mono.invoiceStatus(fetchImpl, env, payment.provider_invoice_id);
            if (String(body.invoiceId || payment.provider_invoice_id) !== payment.provider_invoice_id) return null;
            if (body.reference != null && String(body.reference) !== payment.id) return null;
            return applyUpdate(payment, monoUpdate(body, payment, 'status_check', null));
        }
        if (!available.wayforpay) return null;
        const body = await wfp.checkStatus(fetchImpl, env, payment.provider_order_id);
        if (String(body.orderReference || '') !== payment.provider_order_id) return null;
        return applyUpdate(payment, wfpUpdate(body, payment, 'status_check', true));
    }

    // ----------------------------------------------------------------------------
    // Routes
    // ----------------------------------------------------------------------------

    async function createInvoice(req) {
        if (String(env.PAYMENTS_ENABLED || '') !== '1') {
            throw new HttpError(503, 'PAYMENTS_DISABLED', 'Оплата тимчасово недоступна.');
        }
        const raw = await readRawBody(req);
        const body = parseJson(raw);
        if (!body || typeof body !== 'object') throw new HttpError(400, 'BAD_JSON', 'Некоректний запит.');
        const { user, profile } = await requireOwner(req);

        const plan = planFor(String(body.plan || ''));
        if (!plan) throw new HttpError(400, 'BAD_PLAN', 'Оберіть тариф: 1 місяць або 1 рік.');
        const provider = String(body.provider || '');
        if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'BAD_PROVIDER', 'Оберіть спосіб оплати.');
        if (body.consent !== true || body.legal_version !== LEGAL_VERSION) {
            throw new HttpError(400, 'CONSENT_REQUIRED', 'Потрібна згода з Публічною офертою та Політикою конфіденційності.');
        }
        if (!providerAvailability(env)[provider]) {
            throw new HttpError(503, 'PROVIDER_UNAVAILABLE', 'Цей спосіб оплати зараз недоступний.');
        }

        const orgId = profile.org_id;
        const since = new Date(now() - 60 * 60 * 1000).toISOString();
        if (await store.countPaymentsSince(orgId, since) >= RATE_LIMIT_PER_HOUR) {
            throw new HttpError(429, 'RATE_LIMIT', 'Забагато спроб оплати за годину. Спробуйте пізніше.');
        }

        // Сума — лише з плану. Поля price/amount від клієнта ігноруємо.
        const id = crypto.randomUUID();
        const payment = await store.insertPayment({
            id,
            org_id: orgId,
            created_by: user.id,
            provider,
            plan: plan.code,
            amount_minor: plan.minor,
            currency: CURRENCY,
            status: 'created',
            provider_order_id: provider === 'wayforpay' ? 'tc-' + id : id
        });

        try {
            await store.insertConsent({
                user_id: user.id,
                org_id: orgId,
                kind: 'payment',
                offer_version: LEGAL_VERSION,
                privacy_version: LEGAL_VERSION,
                payment_id: payment.id
            });
        } catch (e) {
            await store.updatePayment(payment.id, { status: 'failure' }).catch(() => {});
            console.warn('payment consent insert failed:', e && e.code);
            throw new HttpError(500, 'CONSENT_NOT_SAVED', 'Не вдалося зберегти згоду. Спробуйте ще раз.');
        }

        const ownerEmail = String(profile.email || user.email || '').trim();
        try {
            if (provider === 'mono') {
                const invoice = await mono.createInvoice(fetchImpl, env, mono.invoiceBody({
                    payment, plan, ownerEmail, baseUrl: baseUrl(env)
                }));
                await store.updatePayment(payment.id, { provider_invoice_id: invoice.invoiceId, status: 'pending' });
                return { payment_id: payment.id, url: invoice.url };
            }
            const fields = wfp.purchaseFields({ payment, plan, ownerEmail, baseUrl: baseUrl(env), env, now: now() });
            const created = await wfp.createPaymentUrl(fetchImpl, env, fields);
            await store.updatePayment(payment.id, { status: 'pending' });
            return { payment_id: payment.id, url: created.url };
        } catch (e) {
            await store.updatePayment(payment.id, { status: 'failure' }).catch(() => {});
            console.warn('invoice create failed:', provider, e && (e.code || e.status));
            throw new HttpError(502, 'PROVIDER_FAILED', 'Не вдалося створити рахунок. Спробуйте ще раз або оберіть інший спосіб оплати.');
        }
    }

    async function monoWebhook(req) {
        const raw = await readRawBody(req);
        const ok = await monoKeys.verify(raw, header(req, 'x-sign'));
        if (!ok) throw new HttpError(401, 'BAD_SIGNATURE', 'Invalid signature');
        const body = parseJson(raw);
        if (!body || !body.invoiceId) return { ok: true };
        let payment = await store.findPayment('mono', 'provider_invoice_id', String(body.invoiceId));
        if (!payment && isUuid(body.reference)) {
            // invoiceId ще не записали (рахунок створено, але відповідь mono до нас не дійшла):
            // шукаємо за reference = id платежу без provider_invoice_id і дописуємо invoiceId.
            const byReference = await store.getPayment(String(body.reference));
            if (byReference && byReference.provider === 'mono' && !byReference.provider_invoice_id) {
                await store.updatePayment(byReference.id, { provider_invoice_id: String(body.invoiceId) });
                payment = Object.assign({}, byReference, { provider_invoice_id: String(body.invoiceId) });
            }
        }
        if (!payment || (body.reference != null && String(body.reference) !== payment.id)) {
            console.warn('mono webhook: unknown invoice');
            return { ok: true };
        }
        await applyUpdate(payment, monoUpdate(body, payment, 'webhook', true));
        return { ok: true };
    }

    async function wayforpayWebhook(req) {
        const raw = await readRawBody(req);
        const body = parseWayforpayBody(raw);
        if (!wfp.wayforpayConfigured(env) || !body || !wfp.verifyNotification(body, env)) {
            throw new HttpError(401, 'BAD_SIGNATURE', 'Invalid signature');
        }
        const orderReference = String(body.orderReference || '');
        const payment = await store.findPayment('wayforpay', 'provider_order_id', orderReference);
        if (payment) {
            try {
                await applyUpdate(payment, wfpUpdate(body, payment, 'webhook', true));
            } catch (e) {
                // Відповідь accept однаково потрібна; статус дотягне status-check / крон.
                console.warn('wayforpay webhook apply failed:', e && e.code);
            }
        } else {
            console.warn('wayforpay webhook: unknown order');
        }
        return wfp.acceptResponse(orderReference, now(), env.WAYFORPAY_SECRET_KEY);
    }

    async function status(req, query) {
        const { profile } = await requireOwner(req);
        const pid = String(query.pid || '');
        if (!isUuid(pid)) throw new HttpError(400, 'BAD_PID', 'Некоректний платіж.');
        let payment = await store.getPayment(pid);
        if (!payment || payment.org_id !== profile.org_id) throw new HttpError(404, 'NOT_FOUND', 'Платіж не знайдено.');
        if (OPEN.has(payment.status)) {
            try {
                await checkWithProvider(payment);
            } catch (e) {
                console.warn('status check failed:', payment.provider, e && (e.code || e.status));
            }
            payment = await store.getPayment(pid);
        }
        const sub = await store.getSubscription(profile.org_id);
        return { status: payment.status, paid_until: sub ? sub.paid_until : null };
    }

    async function summary(req) {
        const { profile } = await requireMember(req);
        const sub = await store.getSubscription(profile.org_id);
        const owner = profile.org_role === 'owner';
        const available = providerAvailability(env);
        const enabled = String(env.PAYMENTS_ENABLED || '') === '1';
        const paidUntil = sub ? sub.paid_until : null;
        return {
            paid_until: paidUntil,
            paid: hasPaidAccess(paidUntil, now()),
            manual_full_access: !!profile.is_approved,
            can_pay: owner && profile.organizations.status === 'active',
            payments_enabled: enabled,
            providers: enabled ? PROVIDERS.filter((p) => available[p]) : [],
            prices: publicPrices(),
            legal_version: LEGAL_VERSION,
            payments: owner ? (await store.listPayments(profile.org_id, 20)).map((p) => ({
                id: p.id,
                provider: p.provider,
                plan: p.plan,
                amount_uah: p.amount_minor / 100,
                status: p.status,
                created_at: p.created_at,
                period_to: p.period_to || null
            })) : []
        };
    }

    async function cron(req) {
        if (!cronAuthorized(header(req, 'authorization'), env.CRON_SECRET)) {
            throw new HttpError(401, 'CRON_UNAUTHORIZED', 'Unauthorized');
        }
        const result = { reminders: { sent: 0, skipped: 0, failed: 0, mail: 'ok' }, reconciled: 0, reconcile_failed: 0 };

        // a) Нагадування: paid_until за Києвом припадає на сьогодні + 3 дні.
        const target = addDaysYmd(kyivYmd(now()), 3);
        const from = new Date(now() + 1 * 24 * 60 * 60 * 1000).toISOString();
        const to = new Date(now() + 5 * 24 * 60 * 60 * 1000).toISOString();
        const due = (await store.subscriptionsEndingBetween(from, to))
            .filter((s) => s.paid_until && kyivYmd(s.paid_until) === target)
            .filter((s) => !s.reminder_sent_for || Date.parse(s.reminder_sent_for) !== Date.parse(s.paid_until));
        if (due.length && !reminderMailConfigured(env)) {
            // Fail closed: без RESEND_API_KEY / REPORT_FROM_EMAIL нічого не шлемо й не позначаємо.
            console.warn('billing cron: reminder mail is not configured');
            result.reminders.mail = 'unconfigured';
            result.reminders.skipped = due.length;
        } else {
            for (const sub of due) {
                const org = await store.orgStatus(sub.org_id);
                if (!org || org.status === 'blocked') { result.reminders.skipped += 1; continue; }
                const owners = await store.activeOwners(sub.org_id);
                const message = buildReminderEmail({ paidUntil: sub.paid_until, baseUrl: baseUrl(env), orgName: org.name });
                let delivered = 0;
                for (const email of owners) {
                    try {
                        await sendReminderEmail(email, message, { env, fetch: fetchImpl });
                        delivered += 1;
                    } catch (e) {
                        console.warn('billing cron: reminder failed', e && e.code);
                    }
                }
                if (delivered) {
                    await store.markReminderSent(sub.org_id, sub.paid_until);
                    result.reminders.sent += 1;
                } else {
                    result.reminders.failed += 1;
                }
            }
        }

        // b) Звірка: відкриті платежі віком від 10 хв до 48 год.
        const open = await store.openPaymentsBetween(
            new Date(now() - STATUS_CHECK_MAX_AGE_MS).toISOString(),
            new Date(now() - STATUS_CHECK_MIN_AGE_MS).toISOString()
        );
        for (const payment of open) {
            try {
                if (await checkWithProvider(payment)) result.reconciled += 1;
            } catch (e) {
                result.reconcile_failed += 1;
                console.warn('billing cron: status check failed', payment.provider, e && (e.code || e.status));
            }
        }
        return result;
    }

    return { createInvoice, monoWebhook, wayforpayWebhook, status, summary, cron, applyUpdate };
}

function send(res, status, payload) {
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(payload);
}

export function createBillingHandler(deps) {
    const service = createBillingService(deps);
    return async function handler(req, res) {
        // api/billing/[route].js: Vercel кладе сегмент шляху в req.query.route.
        const url = new URL(req.url || '/', 'http://local');
        const query = Object.fromEntries(url.searchParams);
        Object.assign(query, req.query || {});
        const route = String(query.route || '');
        const method = String(req.method || 'GET').toUpperCase();
        try {
            if (route === 'return') {
                if (method !== 'GET' && method !== 'POST') return send(res, 405, { error: 'Method Not Allowed' });
                const pid = isUuid(query.pid) ? query.pid : '';
                const location = '/?billing=return' + (pid ? '&pid=' + encodeURIComponent(pid) : '');
                if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
                if (typeof res.redirect === 'function') return res.redirect(303, location);
                res.statusCode = 303;
                res.setHeader('Location', location);
                return res.end();
            }
            if (route === 'create-invoice' && method === 'POST') return send(res, 200, await service.createInvoice(req));
            if (route === 'mono-webhook' && method === 'POST') return send(res, 200, await service.monoWebhook(req));
            if (route === 'wayforpay-webhook' && method === 'POST') return send(res, 200, await service.wayforpayWebhook(req));
            if (route === 'status' && method === 'GET') return send(res, 200, await service.status(req, query));
            if (route === 'summary' && method === 'GET') return send(res, 200, await service.summary(req));
            if (route === 'cron' && (method === 'GET' || method === 'POST')) return send(res, 200, await service.cron(req));
            return send(res, 404, { error: 'Not Found' });
        } catch (e) {
            if (e instanceof HttpError) return send(res, e.status, { code: e.code, error: e.message });
            console.error('billing', route, e && (e.code || e.name));
            return send(res, 500, { error: 'Помилка сервера оплати.' });
        }
    };
}
