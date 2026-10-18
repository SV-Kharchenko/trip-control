// plata by mono (monobank acquiring). Лише сервер; MONO_TOKEN ніколи не логуємо й не повертаємо.
import crypto from 'node:crypto';
import { MONO_CCY, paymentDestination, productName } from './plans.js';

const API = 'https://api.monobank.ua';
const TIMEOUT_MS = 10000;

export function monoConfigured(env) {
    return !!String(env.MONO_TOKEN || '').trim();
}

async function call(fetchImpl, env, path, init = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
    try {
        const response = await fetchImpl(API + path, Object.assign({}, init, {
            headers: Object.assign({ 'X-Token': String(env.MONO_TOKEN || '').trim() }, init.headers || {}),
            signal: controller ? controller.signal : undefined
        }));
        const text = typeof response.text === 'function' ? await response.text() : '';
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        if (!response.ok) {
            const error = new Error('mono ' + path + ' ' + response.status);
            error.code = 'MONO_HTTP';
            error.status = response.status;
            throw error;
        }
        return json || {};
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Тіло рахунку. merchantPaymInfo з basketOrder обов'язковий: у кабінеті налаштовано ПРРО.
export function invoiceBody({ payment, plan, ownerEmail, baseUrl }) {
    const destination = paymentDestination(plan);
    const info = {
        reference: payment.id,
        destination,
        comment: destination,
        basketOrder: [{
            name: productName(plan),
            qty: 1,
            sum: plan.minor,
            total: plan.minor,
            unit: 'посл.',
            code: plan.basketCode
        }]
    };
    if (ownerEmail) info.customerEmails = [ownerEmail];
    return {
        amount: plan.minor,
        ccy: MONO_CCY,
        redirectUrl: baseUrl + '/api/billing/return?pid=' + encodeURIComponent(payment.id),
        webHookUrl: baseUrl + '/api/billing/mono-webhook',
        validity: 3600,
        paymentType: 'debit',
        merchantPaymInfo: info
    };
}

export async function createInvoice(fetchImpl, env, body) {
    const json = await call(fetchImpl, env, '/api/merchant/invoice/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!json.invoiceId || !/^https:\/\//.test(String(json.pageUrl || ''))) {
        const error = new Error('mono invoice without invoiceId/pageUrl');
        error.code = 'MONO_BAD_RESPONSE';
        throw error;
    }
    return { invoiceId: String(json.invoiceId), url: String(json.pageUrl) };
}

export async function invoiceStatus(fetchImpl, env, invoiceId) {
    return call(fetchImpl, env, '/api/merchant/invoice/status?invoiceId=' + encodeURIComponent(invoiceId), { method: 'GET' });
}

// x-sign: base64 DER-підпис ECDSA SHA-256 сирого тіла. pubKeyPem — PEM-рядок.
export function verifyMonoSignature(rawBody, xSign, pubKeyPem) {
    try {
        if (!xSign || !pubKeyPem) return false;
        const signature = Buffer.from(String(xSign), 'base64');
        if (!signature.length) return false;
        return crypto.verify('sha256', Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)), pubKeyPem, signature);
    } catch (e) {
        return false;
    }
}

export function pemFromBase64(value) {
    const text = Buffer.from(String(value || '').trim(), 'base64').toString('utf8');
    return /-----BEGIN PUBLIC KEY-----/.test(text) ? text : '';
}

// Ключ для перевірки вебхуків: MONO_PUBKEY (base64 PEM) або GET /api/merchant/pubkey, кеш у пам'яті.
// Якщо підпис не зійшовся — один раз перезапитуємо ключ (ротація).
export function createPubKeyCache(fetchImpl, env) {
    let cached = pemFromBase64(env.MONO_PUBKEY) || '';
    async function fetchKey() {
        const json = await call(fetchImpl, env, '/api/merchant/pubkey', { method: 'GET' });
        const pem = pemFromBase64(json && json.key);
        if (!pem) throw Object.assign(new Error('mono pubkey missing'), { code: 'MONO_PUBKEY' });
        cached = pem;
        return pem;
    }
    return {
        async get(force) {
            if (cached && !force) return cached;
            return fetchKey();
        },
        async verify(rawBody, xSign) {
            let key = '';
            try { key = await this.get(false); } catch (e) { key = ''; }
            if (key && verifyMonoSignature(rawBody, xSign, key)) return true;
            try { key = await this.get(true); } catch (e) { return false; }
            return verifyMonoSignature(rawBody, xSign, key);
        }
    };
}

// Статус mono → наш.
export function monoStatus(value) {
    switch (String(value || '')) {
        case 'success': return 'success';
        case 'failure': return 'failure';
        case 'expired': return 'expired';
        case 'reversed': return 'reversed';
        case 'created':
        case 'processing':
        case 'hold':
            return 'pending';
        default: return null;
    }
}

// Лише дозволені поля в payment_events.payload (без email/телефону й сирого тіла).
export function monoEventPayload(body) {
    const info = body && typeof body.paymentInfo === 'object' && body.paymentInfo ? body.paymentInfo : {};
    const out = {};
    if (body.status != null) out.status = String(body.status);
    if (body.amount != null) out.amount = Number(body.amount);
    if (body.ccy != null) out.ccy = Number(body.ccy);
    if (body.modifiedDate != null) out.modifiedDate = String(body.modifiedDate);
    if (body.failureReason != null) out.failureReason = String(body.failureReason).slice(0, 200);
    if (info.paymentMethod != null) out.paymentMethod = String(info.paymentMethod);
    if (info.maskedPan != null) out.maskedPan = String(info.maskedPan).slice(0, 32);
    return out;
}
