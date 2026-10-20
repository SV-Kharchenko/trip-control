// WayForPay. Лише сервер; WAYFORPAY_SECRET_KEY ніколи не логуємо й не повертаємо.
import crypto from 'node:crypto';
import { CURRENCY, productName, wayforpayAmount } from './plans.js';

const PAY_OFFLINE = 'https://secure.wayforpay.com/pay?behavior=offline';
const API = 'https://api.wayforpay.com/api';
const TIMEOUT_MS = 10000;

export function wayforpayConfigured(env) {
    return !!(String(env.WAYFORPAY_MERCHANT_ACCOUNT || '').trim()
        && String(env.WAYFORPAY_SECRET_KEY || '').trim()
        && String(env.WAYFORPAY_MERCHANT_DOMAIN || '').trim());
}

// HMAC_MD5(secret, parts.join(';')), UTF-8, hex.
export function wfpSign(secret, parts) {
    return crypto.createHmac('md5', String(secret)).update(parts.map((p) => (p == null ? '' : String(p))).join(';'), 'utf8').digest('hex');
}

export function signaturesMatch(expected, got) {
    const a = Buffer.from(String(expected || ''), 'utf8');
    const b = Buffer.from(String(got || ''), 'utf8');
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Регулярні платежі (автопродовження). Пароль мерчанта — лише для regularApi, лише сервер.
const REGULAR_API = 'https://api.wayforpay.com/regularApi';
export const REGULAR_OK = 4100;
// REMOVE відповів, що регулярки вже немає (видалена / не знайдена): для нас це те саме, що успіх.
export const REGULAR_ALREADY_GONE = Object.freeze([4101, 4106, 4107]);
export const REGULAR_FIELDS = Object.freeze(['regularMode', 'regularAmount', 'dateNext', 'regularOn', 'regularBehavior']);
const REGULAR_INACTIVE = new Set(['Removed', 'Suspended', 'Completed']);

export function regularConfigured(env) {
    return wayforpayConfigured(env) && !!String(env.WAYFORPAY_MERCHANT_PASSWORD || '').trim();
}

// Кожне регулярне списання: orderReference = <початковий orderReference>_WFPREG-<цифри>.
export function parseRegularOrderReference(value) {
    const match = /^(.+)_WFPREG-(\d+)$/.exec(String(value || ''));
    return match ? { parent: match[1], seq: match[2] } : null;
}

// dateNext — дата за Києвом, dd.mm.yyyy.
export function wayforpayDate(at) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(at));
    const get = (type) => parts.find((p) => p.type === type).value;
    return get('day') + '.' + get('month') + '.' + get('year');
}

// Поля регулярного платежу для Purchase: сума й період — лише з плану на сервері.
export function regularFields({ plan, dateNext }) {
    return {
        regularMode: plan.regularMode,
        regularAmount: wayforpayAmount(plan),
        dateNext: wayforpayDate(dateNext),
        regularOn: '1',
        regularBehavior: 'preset'
    };
}

export function regularInactive(status) {
    return REGULAR_INACTIVE.has(String(status || ''));
}

// regularApi: STATUS / REMOVE за orderReference першого платежу. Тіло з паролем не логуємо.
export async function regularRequest(fetchImpl, env, requestType, orderReference) {
    const res = await post(fetchImpl, REGULAR_API, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requestType,
            merchantAccount: String(env.WAYFORPAY_MERCHANT_ACCOUNT).trim(),
            merchantPassword: String(env.WAYFORPAY_MERCHANT_PASSWORD).trim(),
            orderReference: String(orderReference)
        })
    });
    if (!res.ok) throw Object.assign(new Error('WayForPay regularApi ' + res.status), { code: 'WFP_REGULAR_HTTP' });
    return res.json;
}

// Поля Purchase. productName/Price/Count — це й дані чека ПРРО. regular — поля regularFields() або null.
export function purchaseFields({ payment, plan, ownerEmail, baseUrl, env, now, regular }) {
    const amount = wayforpayAmount(plan);
    const fields = {
        merchantAccount: String(env.WAYFORPAY_MERCHANT_ACCOUNT).trim(),
        merchantAuthType: 'SimpleSignature',
        merchantDomainName: String(env.WAYFORPAY_MERCHANT_DOMAIN).trim(),
        merchantTransactionSecureType: 'AUTO',
        orderReference: payment.provider_order_id,
        orderDate: String(Math.floor(now / 1000)),
        amount,
        currency: CURRENCY,
        productName: [productName(plan)],
        productPrice: [amount],
        productCount: ['1'],
        clientEmail: ownerEmail || '',
        language: 'UA',
        returnUrl: baseUrl + '/api/billing/return?pid=' + encodeURIComponent(payment.id),
        serviceUrl: baseUrl + '/api/billing/wayforpay-webhook',
        orderLifetime: '3600',
        paymentSystems: 'card;applePay;googlePay'
    };
    // Регулярні поля в підпис Purchase не входять.
    if (regular) Object.assign(fields, regular);
    fields.merchantSignature = purchaseSignature(fields, env.WAYFORPAY_SECRET_KEY);
    return fields;
}

export function purchaseSignature(fields, secret) {
    return wfpSign(secret, [
        fields.merchantAccount, fields.merchantDomainName, fields.orderReference, fields.orderDate,
        fields.amount, fields.currency,
        ...fields.productName, ...fields.productCount, ...fields.productPrice
    ]);
}

function formBody(fields) {
    const params = new URLSearchParams();
    Object.entries(fields).forEach(([key, value]) => {
        if (Array.isArray(value)) value.forEach((item) => params.append(key + '[]', item));
        else if (value !== '') params.append(key, value);
    });
    return params.toString();
}

async function post(fetchImpl, url, init) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
    try {
        const response = await fetchImpl(url, Object.assign({ method: 'POST', signal: controller ? controller.signal : undefined }, init));
        const text = typeof response.text === 'function' ? await response.text() : '';
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        return { ok: response.ok, status: response.status, json: json || {} };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Посилання на hosted-сторінку оплати. Спершу Purchase з behavior=offline (повертає {url}, без
// HTML-форми, тож CSP form-action 'self' не змінюється). Якщо мерчант так не відповідає —
// CREATE_INVOICE (invoiceUrl; returnUrl там немає). Регулярні поля працюють лише з behavior=offline:
// у CREATE_INVOICE їх не передаємо, тож автопродовження там не вмикається. Повертає { url, method }.
export async function createPaymentUrl(fetchImpl, env, fields) {
    let offline = null;
    try {
        offline = await post(fetchImpl, PAY_OFFLINE, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody(fields)
        });
    } catch (e) {
        offline = null;
    }
    if (offline && offline.ok && /^https:\/\//.test(String(offline.json.url || ''))) {
        return { url: String(offline.json.url), method: 'offline' };
    }

    const invoice = Object.assign({}, fields, { transactionType: 'CREATE_INVOICE', apiVersion: 1 });
    delete invoice.returnUrl;
    delete invoice.merchantTransactionSecureType;
    REGULAR_FIELDS.forEach((key) => { delete invoice[key]; });
    invoice.productCount = invoice.productCount.map(Number);
    invoice.productPrice = invoice.productPrice.map(Number);
    invoice.orderLifetime = Number(invoice.orderLifetime);
    invoice.orderDate = Number(invoice.orderDate);
    const created = await post(fetchImpl, API, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invoice)
    });
    const url = String(created.json.invoiceUrl || '');
    if (!created.ok || !/^https:\/\//.test(url)) {
        const error = new Error('WayForPay invoice failed');
        error.code = 'WFP_BAD_RESPONSE';
        error.reasonCode = created.json && created.json.reasonCode;
        throw error;
    }
    return { url, method: 'create_invoice' };
}

// Підпис сповіщення serviceUrl і відповіді CHECK_STATUS.
export function notificationSignature(body, secret) {
    return wfpSign(secret, [
        body.merchantAccount, body.orderReference, body.amount, body.currency,
        body.authCode, body.cardPan, body.transactionStatus, body.reasonCode
    ]);
}

// Суму WayForPay підписує в тому вигляді, як вона стоїть у тілі. Після JSON.parse число 250.00
// стає 250, тож перевіряємо підпис з String(amount), а якщо не зійшовся — з Number(amount).toFixed(2).
export function amountSignatureForms(amount) {
    const forms = [String(amount)];
    const n = Number(amount);
    if (amount !== '' && amount != null && Number.isFinite(n) && !forms.includes(n.toFixed(2))) forms.push(n.toFixed(2));
    return forms;
}

export function verifyNotification(body, env) {
    if (!body || typeof body !== 'object') return false;
    if (String(body.merchantAccount || '') !== String(env.WAYFORPAY_MERCHANT_ACCOUNT || '').trim()) return false;
    return amountSignatureForms(body.amount).some((amount) =>
        signaturesMatch(notificationSignature(Object.assign({}, body, { amount }), env.WAYFORPAY_SECRET_KEY), body.merchantSignature));
}

// Відповідь на сповіщення: без неї WayForPay ретраїть до 4 діб.
export function acceptResponse(orderReference, nowMs, secret) {
    const time = Math.floor(nowMs / 1000);
    return {
        orderReference: String(orderReference),
        status: 'accept',
        time,
        signature: wfpSign(secret, [orderReference, 'accept', time])
    };
}

export async function checkStatus(fetchImpl, env, orderReference) {
    const merchantAccount = String(env.WAYFORPAY_MERCHANT_ACCOUNT).trim();
    const request = {
        transactionType: 'CHECK_STATUS',
        merchantAccount,
        orderReference,
        merchantSignature: wfpSign(env.WAYFORPAY_SECRET_KEY, [merchantAccount, orderReference]),
        apiVersion: 1
    };
    const res = await post(fetchImpl, API, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!res.ok) throw Object.assign(new Error('WayForPay CHECK_STATUS ' + res.status), { code: 'WFP_HTTP' });
    const body = res.json;
    // Відповідь підписана так само, як сповіщення; без валідного підпису не довіряємо.
    if (!verifyNotification(body, env)) {
        throw Object.assign(new Error('WayForPay CHECK_STATUS bad signature'), { code: 'WFP_BAD_SIGNATURE' });
    }
    return body;
}

// Статус WayForPay → наш.
export function wayforpayStatus(value) {
    switch (String(value || '')) {
        case 'Approved': return 'success';
        case 'Declined': return 'failure';
        case 'Expired': return 'expired';
        case 'Refunded':
        case 'Voided':
            return 'reversed';
        case 'InProcessing':
        case 'Pending':
        case 'WaitingAuthComplete':
        case 'Created':
            return 'pending';
        default: return null;
    }
}

// Час зміни статусу: processingDate (unix сек), інакше createdDate.
export function wayforpayModified(body) {
    const sec = Number(body && (body.processingDate || body.createdDate));
    return Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null;
}

export function wayforpayEventPayload(body) {
    const out = {};
    if (body.transactionStatus != null) out.status = String(body.transactionStatus);
    if (body.amount != null) out.amount = Number(body.amount);
    if (body.currency != null) out.currency = String(body.currency);
    const modified = wayforpayModified(body);
    if (modified) out.modifiedDate = modified;
    if (body.reasonCode != null) out.reasonCode = String(body.reasonCode);
    if (body.paymentSystem != null) out.paymentSystem = String(body.paymentSystem);
    if (body.cardPan != null) out.maskedPan = String(body.cardPan).slice(0, 32);
    return out;
}
