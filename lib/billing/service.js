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
import { buildReminderEmail, buildRenewalFailedEmail, reminderMailConfigured, sendReminderEmail } from './mail.js';
import { MONO_CCY, CURRENCY, PROVIDER_LABEL, PROVIDERS, extendPaidUntil, planFor, publicPrices, wayforpayAmount } from './plans.js';
import * as mono from './mono.js';
import * as wfp from './wayforpay.js';

export const RATE_LIMIT_PER_HOUR = 10;
export const STATUS_CHECK_MIN_AGE_MS = 10 * 60 * 1000;
export const STATUS_CHECK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// Друге поспіль невдале автосписання вимикає автопродовження (REMOVE у WayForPay).
export const RENEWAL_MAX_FAILS = 2;
// Причини зупинки регулярки (regular_remove_reason) — для алертів і дій після підтвердження REMOVE.
export const REMOVE_REASON_LABEL = Object.freeze({
    renewal_failed: 'два невдалі автосписання поспіль',
    refund: 'повернення платежу',
    owner: 'скасовано власником',
    admin: 'скасовано адміністратором',
    org_blocked: 'компанію заблоковано',
    no_owner: 'у компанії немає активного власника',
    org_missing: 'компанії немає'
});
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
// «доступ завершено» (з ручним is_approved у компанії — «оплату скасовано, ручний доступ лишається»);
// часткове / незараховане / з невідомою сумою — з позначкою, що доступ не змінено.
// Автопродовження: 'renewal_failed' (невдале автосписання, спроба N), 'auto_renew_off' (вимкнено, причина);
// renewal — успішне автосписання; afterOff — автосписання прийшло, хоча автопродовження вже вимкнене.
export function paymentAlertText(kind, {
    orgName, plan, provider, paidUntil, partialMinor, notCredited, unknownAmount, manualAccess, now = Date.now(),
    renewal, afterOff, attempt, disabled, reason, removeFailed, removePending, removeConfirmed
}) {
    const planDef = planFor(plan);
    const company = String(orgName || '—').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) || '—';
    const parts = [
        company,
        planDef ? planDef.label : String(plan || ''),
        (planDef ? planDef.uah : '') + ' грн',
        PROVIDER_LABEL[provider] || String(provider || '')
    ];
    const removeNote = 'REMOVE не вдався — вимкніть регулярний платіж у кабінеті WayForPay';
    const pendingNote = 'WayForPay не підтвердив REMOVE — повторюємо щодня, автопродовження поки увімкнене';
    if (kind === 'renewal_failed') {
        parts.push('спроба ' + (attempt || 1));
        if (disabled) parts.push('автопродовження вимкнено');
        if (removePending) parts.push(pendingNote);
        if (removeFailed) parts.push(removeNote);
        return '⚠️ Автосписання не пройшло: ' + parts.join(' · ');
    }
    if (kind === 'auto_renew_pending') {
        if (reason) parts.push(reason);
        parts.push(pendingNote);
        return '⏳ Автопродовження не вимкнено: ' + parts.join(' · ');
    }
    if (kind === 'auto_renew_off') {
        if (reason) parts.push(reason);
        if (removeFailed) parts.push(removeNote);
        if (hasPaidAccess(paidUntil, now)) parts.push('оплачено до ' + formatKyivDate(paidUntil));
        return '🔁 Автопродовження вимкнено: ' + parts.join(' · ');
    }
    if (kind !== 'reversed') {
        if (renewal) parts.push('автосписання');
        if (afterOff) {
            parts.push('автопродовження вже вимкнене — ' + (removeConfirmed ? 'REMOVE підтверджено'
                : (removePending ? pendingNote : removeNote)));
        }
        parts.push('оплачено до ' + (paidUntil ? formatKyivDate(paidUntil) : '—'));
        return '💳 Оплата: ' + parts.join(' · ');
    }
    if (unknownAmount) parts.push('суму повернення не вдалося визначити, доступ не змінено — перевірте вручну');
    else if (partialMinor) parts.push('повернення часткове (' + Math.round(partialMinor) / 100 + ' грн), доступ не змінено');
    else if (notCredited) parts.push('платіж не був зарахований, доступ не змінено');
    if (hasPaidAccess(paidUntil, now)) parts.push('оплачено до ' + formatKyivDate(paidUntil));
    else parts.push(manualAccess ? 'оплату скасовано, ручний доступ лишається' : 'доступ завершено');
    return '↩️ Повернення: ' + parts.join(' · ');
}

// Сума повернення в копійках. mono: amount − finalAmount (якщо finalAmount є), інакше amount;
// WayForPay: лише refundAmount (amount у сповіщенні — сума платежу). NaN — суми немає.
export function refundMinor(provider, body, payment) {
    const num = (v) => (v == null || v === '' ? NaN : Number(v));
    if (provider === 'mono') {
        const final = num(body.finalAmount);
        return Number.isFinite(final) ? payment.amount_minor - final : num(body.amount);
    }
    const uah = num(body.refundAmount);
    return Number.isFinite(uah) ? Math.round(uah * 100) : NaN;
}

// mono: частковий рефанд приходить як success з finalAmount < amount. Повертає суму повернення або 0.
export function monoPartialRefundMinor(body, payment) {
    const final = body && body.finalAmount != null && body.finalAmount !== '' ? Number(body.finalAmount) : NaN;
    if (!Number.isFinite(final)) return 0;
    const minor = payment.amount_minor - final;
    return minor > 0 && minor < payment.amount_minor ? minor : 0;
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
            // Оплачений період скінчився: чи лишається ручний повний доступ у компанії.
            if (kind === 'reversed' && !hasPaidAccess(paidUntil, now()) && typeof store.orgHasManualAccess === 'function') {
                extra = Object.assign({ manualAccess: await store.orgHasManualAccess(payment.org_id) }, extra);
            }
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

    // ----------------------------------------------------------------------------
    // Автопродовження (WayForPay regular). Галочка й нові регулярки — лише з AUTO_RENEW_ENABLED=1;
    // автосписання, скасування й повернення обробляються завжди, щоб уже ввімкнене не лишилось без контролю.
    // ----------------------------------------------------------------------------

    function autoRenewEnabled() {
        return String(env.AUTO_RENEW_ENABLED || '') === '1';
    }

    function autoRenewAvailable() {
        return autoRenewEnabled() && providerAvailability(env).wayforpay && wfp.regularConfigured(env);
    }

    async function getAutoRenew(orgId) {
        if (typeof store.getAutoRenew !== 'function') return null;
        try {
            return await store.getAutoRenew(orgId);
        } catch (e) {
            console.warn('auto-renew read failed:', e && e.code);
            return null;
        }
    }

    // REMOVE у WayForPay. true — регулярки більше немає: 4100, «вже видалено» (4101 / 4106 / 4107)
    // або STATUS (з 4100) каже, що вона неактивна. Інакше false — WayForPay ще може списати.
    async function removeRegular(orderReference) {
        if (!orderReference || !wfp.regularConfigured(env) || typeof fetchImpl !== 'function') return false;
        try {
            const res = await wfp.regularRequest(fetchImpl, env, 'REMOVE', orderReference);
            const code = Number(res.reasonCode);
            if (code === wfp.REGULAR_OK || wfp.REGULAR_ALREADY_GONE.includes(code)) return true;
            const status = await wfp.regularRequest(fetchImpl, env, 'STATUS', orderReference);
            return Number(status.reasonCode) === wfp.REGULAR_OK && wfp.regularInactive(status.status);
        } catch (e) {
            console.warn('wayforpay regular remove failed:', e && e.code);
            return false;
        }
    }

    async function notifyOwners(orgId, message) {
        if (!reminderMailConfigured(env)) return 0;
        let delivered = 0;
        for (const email of await store.activeOwners(orgId)) {
            try {
                await sendReminderEmail(email, message, { env, fetch: fetchImpl });
                delivered += 1;
            } catch (e) {
                console.warn('auto-renew mail failed:', e && e.code);
            }
        }
        return delivered;
    }

    // Тариф регулярки — з її першого платежу (не last_plan: поруч міг бути разовий платіж за інший тариф).
    async function regularPlan(sub) {
        if (!sub || !sub.wfp_regular_order_ref) return planFor(sub && sub.last_plan);
        try {
            const first = await store.findPayment('wayforpay', 'provider_order_id', sub.wfp_regular_order_ref);
            return planFor(first ? first.plan : sub.last_plan);
        } catch (e) {
            return planFor(sub.last_plan);
        }
    }

    // Підтверджене зняття регулярки: auto_renew=false, 'Removed'. Лист «оплатіть вручну» — лише тут,
    // тобто лише після підтвердження WayForPay.
    async function confirmStopped(orgId, sub, reason, cancelledAt) {
        const patch = { auto_renew: false, regular_status: 'Removed', regular_remove_reason: null };
        if (cancelledAt) patch.auto_renew_cancelled_at = cancelledAt;
        await store.updateAutoRenew(orgId, patch);
        if (reason === 'renewal_failed') {
            const plan = await regularPlan(sub);
            await notifyOwners(orgId, buildRenewalFailedEmail({
                baseUrl: baseUrl(env), orgName: await store.getOrgName(orgId),
                uah: plan ? plan.uah : '', paidUntil: sub.paid_until
            }));
        }
    }

    // Зупинити поточну регулярку компанії. REMOVE підтверджено — confirmStopped; ні — regular_status='RemovePending'
    // з причиною, auto_renew лишається true (WayForPay ще може списати), крон повторює REMOVE.
    async function stopRegular(orgId, sub, reason, cancelledAt) {
        if (await removeRegular(sub.wfp_regular_order_ref)) {
            await confirmStopped(orgId, sub, reason, cancelledAt);
            return true;
        }
        await store.updateAutoRenew(orgId, { regular_status: 'RemovePending', regular_remove_reason: reason });
        return false;
    }

    // Початковий orderReference регулярки, до якої належить платіж (сам перший платіж або автосписання).
    function regularRootOf(payment) {
        if (payment.provider !== 'wayforpay') return null;
        if (payment.kind === 'renewal') {
            const parsed = wfp.parseRegularOrderReference(payment.provider_order_id);
            return parsed ? parsed.parent : null;
        }
        return payment.auto_renew_requested_at ? payment.provider_order_id : null;
    }

    // Після зарахування: перший платіж з галочкою вмикає автопродовження; автосписання скидає fail_count.
    async function afterCredit(payment, update, paidUntil) {
        if (payment.provider !== 'wayforpay' || typeof store.updateAutoRenew !== 'function') return { afterOff: false };
        const cardMask = (update.payload && update.payload.maskedPan) || null;
        try {
            if (payment.kind === 'renewal') {
                const root = regularRootOf(payment);
                const sub = await getAutoRenew(payment.org_id);
                const current = !!(sub && sub.auto_renew && sub.wfp_regular_order_ref === root);
                const pending = current && sub.regular_status === 'RemovePending';
                // Поточна регулярка (або чекала REMOVE лише через невдалі списання — картка знову працює).
                if (current && (!pending || sub.regular_remove_reason === 'renewal_failed')) {
                    const patch = { fail_count: 0, next_charge_at: paidUntil, regular_status: 'Active', regular_remove_reason: null };
                    if (cardMask) patch.card_mask = cardMask;
                    await store.updateAutoRenew(payment.org_id, patch);
                    return { afterOff: false };
                }
                // Автопродовження вимкнене, регулярка не поточна або чекає REMOVE: гроші списані — зараховано,
                // але регулярку знімаємо одразу; результат — в алерт.
                const removed = await removeRegular(root);
                if (removed && pending) {
                    const reason = sub.regular_remove_reason;
                    await confirmStopped(payment.org_id, sub, reason,
                        reason === 'owner' || reason === 'admin' ? new Date(now()).toISOString() : null);
                }
                return { afterOff: true, removeConfirmed: removed, removePending: !removed && pending };
            }
            if (payment.auto_renew_requested_at) {
                const sub = await getAutoRenew(payment.org_id);
                // Нова регулярка замінює стару: двох регулярок на компанію не буває.
                if (sub && sub.auto_renew && sub.wfp_regular_order_ref && sub.wfp_regular_order_ref !== payment.provider_order_id
                    && !(await removeRegular(sub.wfp_regular_order_ref))) {
                    const old = await regularPlan(sub);
                    await alert('auto_renew_off', { org_id: payment.org_id, plan: old ? old.code : sub.last_plan, provider: 'wayforpay' },
                        sub.paid_until, { reason: 'замінено новим автопродовженням', removeFailed: true });
                }
                await store.updateAutoRenew(payment.org_id, {
                    auto_renew: true,
                    wfp_regular_order_ref: payment.provider_order_id,
                    card_mask: cardMask,
                    next_charge_at: paidUntil,
                    regular_status: 'Active',
                    fail_count: 0,
                    auto_renew_consent_at: payment.auto_renew_requested_at,
                    auto_renew_cancelled_at: null
                });
            }
        } catch (e) {
            console.warn('auto-renew update failed:', e && e.code);
        }
        return { afterOff: false };
    }

    // Невдале автосписання: fail_count + 1, алерт; на другому поспіль — REMOVE. Вимкнення й лист власнику —
    // лише після підтвердження WayForPay (інакше RemovePending і повтор кроном).
    async function renewalFailed(payment) {
        try {
            const attempt = await store.recordRenewalFailure(payment.org_id);
            const sub = await getAutoRenew(payment.org_id);
            let disabled = false;
            let removePending = false;
            if (attempt >= RENEWAL_MAX_FAILS && sub && sub.auto_renew && sub.regular_status !== 'RemovePending'
                && sub.wfp_regular_order_ref === regularRootOf(payment)) {
                disabled = await stopRegular(payment.org_id, sub, 'renewal_failed');
                removePending = !disabled;
            }
            await alert('renewal_failed', payment, sub && sub.paid_until, { attempt, disabled, removePending });
        } catch (e) {
            console.warn('renewal failure handling failed:', e && e.code);
        }
    }

    // Повернення першого платежу регулярки або автосписання: REMOVE і вимкнення автопродовження.
    async function stopAutoRenewAfterRefund(payment) {
        const root = regularRootOf(payment);
        if (!root) return;
        try {
            const sub = await getAutoRenew(payment.org_id);
            const current = !!(sub && sub.auto_renew && sub.wfp_regular_order_ref === root);
            if (!current) {
                // Не поточна регулярка (стара чи вже вимкнена): лише REMOVE, у підписці нічого не змінюємо.
                await removeRegular(root);
                return;
            }
            const removed = await stopRegular(payment.org_id, sub, 'refund');
            await alert(removed ? 'auto_renew_off' : 'auto_renew_pending', payment, sub.paid_until, { reason: REMOVE_REASON_LABEL.refund });
        } catch (e) {
            console.warn('auto-renew stop after refund failed:', e && e.code);
        }
    }

    // Автосписання: окремий рядок payments (kind='renewal'), ідемпотентно за повним orderReference.
    async function renewalPayment(orderReference) {
        const parsed = wfp.parseRegularOrderReference(orderReference);
        if (!parsed) return null;
        const existing = await store.findPayment('wayforpay', 'provider_order_id', orderReference);
        if (existing) return existing;
        const parent = await store.findPayment('wayforpay', 'provider_order_id', parsed.parent);
        if (!parent || parent.kind === 'renewal') return null;
        const plan = planFor(parent.plan);
        if (!plan) return null;
        try {
            return await store.insertPayment({
                id: crypto.randomUUID(),
                org_id: parent.org_id,
                created_by: parent.created_by,
                provider: 'wayforpay',
                plan: plan.code,
                amount_minor: plan.minor,
                currency: CURRENCY,
                status: 'pending',
                provider_order_id: orderReference,
                kind: 'renewal',
                parent_payment_id: parent.id
            });
        } catch (e) {
            // Паралельний дубль сповіщення вже створив рядок.
            if (e && e.code === '23505') return store.findPayment('wayforpay', 'provider_order_id', orderReference);
            throw e;
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
            if (result && result.credited) {
                const after = await afterCredit(payment, update, result.paid_until);
                await alert('success', payment, result.paid_until, {
                    renewal: payment.kind === 'renewal',
                    afterOff: after.afterOff,
                    removeConfirmed: after.removeConfirmed,
                    removePending: after.removePending
                });
            }
            // mono: частковий рефанд зарахованого платежу (success, finalAmount < amount) — один алерт, підписка без змін.
            const partialMinor = update.monoPartialMinor || 0;
            if (partialMinor && result && (result.credited || result.already_credited)
                && await store.markPartialRefundAlerted(payment.id)) {
                await alert('reversed', payment, result.paid_until, { partialMinor });
            }
            return { status: result && (result.credited || result.already_credited) ? 'success' : payment.status, credited: !!(result && result.credited), paid_until: result && result.paid_until };
        }
        if (status === 'reversed') {
            // Повне повернення зарахованого платежу скорочує paid_until на його період (один раз, у SQL);
            // часткове, незараховане й з невідомою сумою — лише статус.
            let minor = update.refundMinor;
            let unknownAmount = false;
            if (payment.provider === 'wayforpay' && payment.credited_at && !Number.isFinite(minor)) {
                // Refunded / Voided без refundAmount: беремо суму з CHECK_STATUS; без неї період не ріжемо.
                if (update.source !== 'status_check') minor = await wfpRefundFromStatus(payment);
                unknownAmount = !Number.isFinite(minor);
            }
            const partial = unknownAmount || isPartialRefund(minor, payment);
            const result = await store.applyReversal(payment.id, update.modified || null, partial);
            if (result && result.changed) {
                let paidUntil = result.paid_until;
                if (paidUntil === undefined) {
                    const sub = await store.getSubscription(payment.org_id);
                    paidUntil = sub && sub.paid_until;
                }
                const credited = result.credited !== undefined ? !!result.credited : !!payment.credited_at;
                await alert('reversed', payment, paidUntil, {
                    unknownAmount: unknownAmount && credited,
                    partialMinor: partial && credited && !unknownAmount ? minor : 0,
                    notCredited: !credited
                });
                await stopAutoRenewAfterRefund(payment);
            }
            return { status: (result && result.status) || payment.status, credited: false };
        }
        const result = await store.applyStatus(payment.id, status, update.modified || null);
        // Невдале автосписання рахуємо один раз на списання (повтор того самого сповіщення нічого не змінює).
        if (payment.kind === 'renewal' && status === 'failure' && result && result.changed) await renewalFailed(payment);
        return { status: (result && result.status) || payment.status, credited: false };
    }

    function monoUpdate(body, payment, source, signatureOk) {
        return {
            mapped: mono.monoStatus(body.status),
            status: body.status != null ? String(body.status) : null,
            modified: body.modifiedDate ? new Date(body.modifiedDate).toISOString() : null,
            amountOk: Number(body.amount) === payment.amount_minor && Number(body.ccy) === MONO_CCY,
            refundMinor: refundMinor('mono', body, payment),
            monoPartialMinor: mono.monoStatus(body.status) === 'success' ? monoPartialRefundMinor(body, payment) : 0,
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

    // Сума повернення WayForPay з CHECK_STATUS (підпис перевіряє wfp.checkStatus). NaN — не вдалося.
    async function wfpRefundFromStatus(payment) {
        if (!providerAvailability(env).wayforpay) return NaN;
        try {
            const body = await wfp.checkStatus(fetchImpl, env, payment.provider_order_id);
            if (String(body.orderReference || '') !== payment.provider_order_id) return NaN;
            return refundMinor('wayforpay', body, payment);
        } catch (e) {
            console.warn('wayforpay refund amount check failed', e && e.code);
            return NaN;
        }
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
        // Автопродовження — лише окрема галочка (auto_renew: true) і лише WayForPay. Сума й період — з плану.
        const wantsAutoRenew = body.auto_renew === true;
        if (wantsAutoRenew && (provider !== 'wayforpay' || !autoRenewAvailable())) {
            throw new HttpError(400, 'AUTO_RENEW_UNAVAILABLE', 'Автопродовження зараз недоступне. Зніміть галочку або спробуйте пізніше.');
        }

        const orgId = profile.org_id;
        let regular = null;
        let autoRenewConsentAt = null;
        if (wantsAutoRenew) {
            const current = await getAutoRenew(orgId);
            if (current && current.auto_renew) {
                throw new HttpError(409, 'AUTO_RENEW_ACTIVE', 'Автопродовження вже увімкнено. Скасувати його можна в кабінеті.');
            }
            // dateNext — нове «оплачено до» після цієї оплати.
            const sub = await store.getSubscription(orgId);
            regular = wfp.regularFields({ plan, dateNext: extendPaidUntil(sub && sub.paid_until, plan.code, now()).to.getTime() });
            autoRenewConsentAt = new Date(now()).toISOString();
        }
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
            const fields = wfp.purchaseFields({ payment, plan, ownerEmail, baseUrl: baseUrl(env), env, now: now(), regular });
            const created = await wfp.createPaymentUrl(fetchImpl, env, fields);
            if (!regular) {
                await store.updatePayment(payment.id, { status: 'pending' });
                return { payment_id: payment.id, url: created.url };
            }
            // Регулярка створюється лише через behavior=offline; у CREATE_INVOICE — звичайна разова оплата.
            const autoRenew = created.method === 'offline';
            await store.updatePayment(payment.id, autoRenew
                ? { status: 'pending', auto_renew_requested_at: autoRenewConsentAt }
                : { status: 'pending' });
            return { payment_id: payment.id, url: created.url, auto_renew: autoRenew };
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
        // <початковий orderReference>_WFPREG-<цифри> — автосписання: свій рядок payments, зарахування тим самим кодом.
        // Помилка бази тут — 500 (як і для звичайного платежу): WayForPay повторить, рядок автосписання не загубиться.
        const payment = wfp.parseRegularOrderReference(orderReference)
            ? await renewalPayment(orderReference)
            : await store.findPayment('wayforpay', 'provider_order_id', orderReference);
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
        const out = {
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
                period_to: p.period_to || null,
                ...(p.kind === 'renewal' ? { kind: 'renewal' } : {})
            })) : []
        };
        // Галочка — лише з AUTO_RENEW_ENABLED=1; стан увімкненого автопродовження власник бачить завжди.
        if (autoRenewEnabled()) out.auto_renew_available = owner && enabled && profile.organizations.status === 'active' && autoRenewAvailable();
        const ar = owner ? await getAutoRenew(profile.org_id) : null;
        if (ar && ar.auto_renew) {
            const plan = await regularPlan(ar);
            out.auto_renew = {
                enabled: true,
                next_charge_at: ar.next_charge_at || paidUntil,
                card_mask: ar.card_mask || null,
                plan: plan ? plan.code : null,
                amount_uah: plan ? plan.uah : null,
                // Скасування чекає підтвердження WayForPay (RemovePending): списання ще можливе.
                removing: ar.regular_status === 'RemovePending'
            };
        }
        return out;
    }

    // Скасування власником: REMOVE у WayForPay, потім auto_renew=false. Доступ — до paid_until.
    async function cancelAutoRenew(req) {
        // Не requireOwner: власник неактивної компанії теж має змогу зупинити списання.
        const { profile } = await requireMember(req);
        if (profile.org_role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Автопродовженням керує власник компанії.');
        const result = await stopAutoRenewForOrg(profile.org_id, 'owner');
        if (result.pending) {
            // Не знімаємо галочку в себе, поки WayForPay може списати: інакше скасування лише на екрані.
            throw new HttpError(502, 'AUTO_RENEW_CANCEL_FAILED',
                'WayForPay поки не підтвердив скасування. Ми повторюватимемо спробу щодня; можна також спробувати ще раз за кілька хвилин.');
        }
        return { auto_renew: false, paid_until: result.paid_until };
    }

    // Зупинка автопродовження компанії: власник, адміністратор (скасування листом), блокування компанії.
    // { removed } — WayForPay підтвердив; { pending } — RemovePending, крон повторить; { none } — вимикати нічого.
    async function stopAutoRenewForOrg(orgId, reason) {
        const sub = await getAutoRenew(orgId);
        if (!sub || !sub.auto_renew) return { none: true, paid_until: sub ? sub.paid_until : null };
        const cancelledAt = reason === 'owner' || reason === 'admin' ? new Date(now()).toISOString() : null;
        const removed = await stopRegular(orgId, sub, reason, cancelledAt);
        const plan = await regularPlan(sub);
        await alert(removed ? 'auto_renew_off' : 'auto_renew_pending',
            { org_id: orgId, plan: plan ? plan.code : sub.last_plan, provider: 'wayforpay' }, sub.paid_until,
            { reason: REMOVE_REASON_LABEL[reason] || reason });
        return removed ? { removed: true, paid_until: sub.paid_until } : { pending: true, paid_until: sub.paid_until };
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
                // Увімкнене автопродовження — лист про майбутнє списання (дата, сума, маска, де скасувати).
                const ar = await getAutoRenew(sub.org_id);
                const arPlan = ar && ar.auto_renew ? await regularPlan(ar) : null;
                const message = buildReminderEmail({
                    paidUntil: sub.paid_until,
                    baseUrl: baseUrl(env),
                    orgName: org.name,
                    autoRenew: arPlan ? { chargeAt: ar.next_charge_at || sub.paid_until, uah: arPlan.uah, cardMask: ar.card_mask } : null
                });
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

        // c) Звірка автопродовження: RemovePending — повторюємо REMOVE (вимикаємо лише після підтвердження);
        //    інакше STATUS — регулярка у WayForPay неактивна → вимикаємо в себе і пишемо адміну.
        if (wfp.regularConfigured(env) && typeof store.autoRenewSubscriptions === 'function') {
            result.auto_renew = { checked: 0, disabled: 0, failed: 0 };
            for (const sub of await store.autoRenewSubscriptions()) {
                try {
                    if (sub.regular_status === 'RemovePending') {
                        const reason = sub.regular_remove_reason || 'admin';
                        if (!(await removeRegular(sub.wfp_regular_order_ref))) {
                            result.auto_renew.failed += 1;
                            continue;
                        }
                        await confirmStopped(sub.org_id, sub, reason,
                            reason === 'owner' || reason === 'admin' ? new Date(now()).toISOString() : null);
                        result.auto_renew.disabled += 1;
                        const plan = await regularPlan(sub);
                        await alert('auto_renew_off', { org_id: sub.org_id, plan: plan ? plan.code : sub.last_plan, provider: 'wayforpay' },
                            sub.paid_until, { reason: (REMOVE_REASON_LABEL[reason] || reason) + ' · REMOVE підтверджено' });
                        continue;
                    }
                    const remote = await wfp.regularRequest(fetchImpl, env, 'STATUS', sub.wfp_regular_order_ref);
                    result.auto_renew.checked += 1;
                    if (!wfp.regularInactive(remote.status)) continue;
                    const regularStatus = String(remote.status);
                    await store.updateAutoRenew(sub.org_id, { auto_renew: false, regular_status: regularStatus });
                    result.auto_renew.disabled += 1;
                    const plan = await regularPlan(sub);
                    await alert('auto_renew_off', { org_id: sub.org_id, plan: plan ? plan.code : sub.last_plan, provider: 'wayforpay' }, sub.paid_until, {
                        reason: 'у WayForPay регулярний платіж неактивний (' + regularStatus + ')'
                    });
                } catch (e) {
                    result.auto_renew.failed += 1;
                    console.warn('billing cron: regular status failed', e && e.code);
                }
            }
        }
        return result;
    }

    return { createInvoice, monoWebhook, wayforpayWebhook, status, summary, cancelAutoRenew, cron, applyUpdate };
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
            if (route === 'cancel-auto-renew' && method === 'POST') return send(res, 200, await service.cancelAutoRenew(req));
            if (route === 'cron' && (method === 'GET' || method === 'POST')) return send(res, 200, await service.cron(req));
            return send(res, 404, { error: 'Not Found' });
        } catch (e) {
            if (e instanceof HttpError) return send(res, e.status, { code: e.code, error: e.message });
            console.error('billing', route, e && (e.code || e.name));
            return send(res, 500, { error: 'Помилка сервера оплати.' });
        }
    };
}
