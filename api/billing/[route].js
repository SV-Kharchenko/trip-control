import { createClient } from '@supabase/supabase-js';
import { createBillingHandler } from '../../lib/billing/service.js';
import { createSupabaseStore } from '../../lib/billing/store.js';
import { enforceRateLimit } from '../../lib/rate-limit.js';

/**
 * Оплата тарифу організації (plata by mono, WayForPay). Одна функція (динамічний маршрут Vercel, route = req.query.route):
 *   POST /api/billing/create-invoice    — власник, згода, сума з плану → { payment_id, url }
 *   GET|POST /api/billing/return?pid=   — повернення з оплати → 303 /?billing=return&pid=
 *   POST /api/billing/mono-webhook      — x-sign (ECDSA), сире тіло
 *   POST /api/billing/wayforpay-webhook — HMAC_MD5, відповідь accept
 *   GET  /api/billing/status?pid=       — запасна перевірка у провайдера
 *   GET  /api/billing/summary           — paid_until, ціни, доступні провайдери, історія, автопродовження
 *   POST /api/billing/cancel-auto-renew — власник: REMOVE регулярки WayForPay, auto_renew=false
 *   GET  /api/billing/cron              — щоденно (Bearer CRON_SECRET): нагадування, звірка, STATUS автопродовження
 *
 * Env (лише Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_BASE_URL, PAYMENTS_ENABLED,
 * MONO_TOKEN [, MONO_PUBKEY], WAYFORPAY_MERCHANT_ACCOUNT, WAYFORPAY_SECRET_KEY,
 * WAYFORPAY_MERCHANT_DOMAIN [, WAYFORPAY_MERCHANT_PASSWORD, AUTO_RENEW_ENABLED],
 * RESEND_API_KEY, REPORT_FROM_EMAIL, CRON_SECRET, TELEGRAM_*.
 * Див. docs/PAYMENTS.md. req.body не читаємо: підпис mono рахується по сирих байтах.
 */
const env = process.env;
const supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

const unavailable = async (req, res) => res.status(503).json({ error: 'Оплата тимчасово недоступна.' });

// Ліміт запитів за IP — для користувацьких маршрутів. Вебхуки провайдерів (підписані) і cron (Bearer CRON_SECRET) не лімітуємо:
// їх не можна відхиляти за IP, а підроблені відсікає перевірка підпису / секрету.
const UNLIMITED_ROUTES = new Set(['mono-webhook', 'wayforpay-webhook', 'cron']);
const billing = supabase ? createBillingHandler({ store: createSupabaseStore(supabase), fetch: globalThis.fetch, env }) : unavailable;

export default async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://local');
    const route = String((req.query && req.query.route) || url.searchParams.get('route') || '');
    if (!UNLIMITED_ROUTES.has(route) && !(await enforceRateLimit(req, res, 'billing'))) return;
    return billing(req, res);
}
