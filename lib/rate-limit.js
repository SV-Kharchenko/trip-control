// Ліміт запитів на /api за IP. Лічильник у Supabase (api_rate_limits + RPC api_rate_hit, лише service_role): працює однаково
// на всіх інстансах Vercel, на відміну від пам'яті процесу (кожен холодний старт і кожен інстанс мав би свій лічильник).
// Вікно фіксоване (60 с): на межі двох вікон можливі до 2× ліміту поспіль — для захисту від перебору цього достатньо.
// Ліміти: ~60/хв, якщо запит несе Authorization: Bearer (сам токен тут не перевіряється — це лише вибір ліміту, доступ усе одно
// вирішує обробник), і ~20/хв для анонімів. IP береться з x-forwarded-for / x-real-ip, які виставляє Vercel; у ключ іде SHA-256
// від IP (сирі адреси в базі не зберігаються). Відмова бази = пропускаємо запит (fail-open): лічильник не повинен класти сайт.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const LIMIT_AUTHED = 60;
export const LIMIT_ANON = 20;
export const WINDOW_SECONDS = 60;

function headerOf(req, name) {
    const headers = (req && req.headers) || {};
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

// Перша адреса з x-forwarded-for (Vercel дописує справжню клієнтську першою), інакше x-real-ip / сокет.
export function clientIp(req) {
    const forwarded = String(headerOf(req, 'x-forwarded-for') || '').split(',')[0].trim();
    const ip = forwarded || String(headerOf(req, 'x-real-ip') || '').trim() || String((req && req.socket && req.socket.remoteAddress) || '').trim();
    return ip || 'unknown';
}

export function hasBearer(req) {
    return /^Bearer\s+\S+/i.test(String(headerOf(req, 'authorization') || ''));
}

export function bucketKey(name, ip) {
    return String(name) + ':' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

let defaultClient = null;
function defaultRpc(env) {
    return async (args) => {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { data: null, error: { message: 'no supabase env' } };
        if (!defaultClient) defaultClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        return defaultClient.rpc('api_rate_hit', args);
    };
}

// → true, якщо запит можна обробляти. Інакше сама відповідає 429 (JSON, Retry-After) і повертає false.
export async function enforceRateLimit(req, res, name, deps = {}) {
    const env = deps.env || process.env;
    const rpc = deps.rpc || defaultRpc(env);
    const limit = hasBearer(req) ? (deps.authed || LIMIT_AUTHED) : (deps.anon || LIMIT_ANON);
    let result = null;
    try {
        const { data, error } = await rpc({ p_bucket: bucketKey(name, clientIp(req)), p_limit: limit, p_window_seconds: WINDOW_SECONDS });
        if (error) throw error;
        result = Array.isArray(data) ? data[0] : data;
    } catch (e) {
        console.warn('rate limit check failed (fail-open):', name, e && (e.code || e.message));
        return true;
    }
    if (!result || result.allowed !== false) return true;
    const retry = Math.max(1, Number(result.retry_after) || WINDOW_SECONDS);
    if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(retry));
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Забагато запитів. Спробуйте за хвилину.', retry_after: retry });
    return false;
}
