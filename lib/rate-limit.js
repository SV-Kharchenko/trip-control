// Ліміт запитів на /api. Лічильник у Supabase (api_rate_limits + RPC api_rate_hit, лише service_role): працює однаково на всіх
// інстансах Vercel, на відміну від пам'яті процесу (кожен холодний старт і кожен інстанс мав би свій лічильник).
// Вікно фіксоване (60 с): на межі двох вікон можливі до 2× ліміту поспіль — для захисту від перебору цього достатньо.
// Ліміти: залогінені — 120/хв на ендпоінт за id користувача (sub з токена, перевіреного supabase.auth.getUser; /api/poi — 240/хв),
// аноніми — 20/хв за IP. Підробний, прострочений чи невалідний Bearer вищого ліміту не дає: такий запит рахується як анонім за IP.
// Перевірка токена обмежена 1,5 с (далі — анонім) і кешується в межах запиту (WeakMap за req). IP: x-vercel-forwarded-for, потім x-real-ip, потім перший
// x-forwarded-for; у ключ іде SHA-256 (сирі адреси та id в базі не зберігаються). Відмова бази = пропускаємо запит (fail-open).
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const LIMIT_AUTHED = 120;
export const LIMIT_AUTHED_POI = 240;
export const LIMIT_ANON = 20;
export const WINDOW_SECONDS = 60;
export const GETUSER_TIMEOUT_MS = 1500;

function headerOf(req, name) {
    const headers = (req && req.headers) || {};
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

// x-vercel-forwarded-for виставляє Vercel (клієнт його підробити не може), далі x-real-ip, потім перший x-forwarded-for / сокет.
export function clientIp(req) {
    const first = (value) => String(value || '').split(',')[0].trim();
    const ip = first(headerOf(req, 'x-vercel-forwarded-for')) || first(headerOf(req, 'x-real-ip')) || first(headerOf(req, 'x-forwarded-for'))
        || String((req && req.socket && req.socket.remoteAddress) || '').trim();
    return ip || 'unknown';
}

export function bearerToken(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(headerOf(req, 'authorization') || '').trim());
    return m ? m[1] : '';
}

export function hasBearer(req) {
    return Boolean(bearerToken(req));
}

export function bucketKey(name, subject) {
    return String(name) + ':' + crypto.createHash('sha256').update(String(subject)).digest('hex').slice(0, 32);
}

let defaultClient = null;
function supabaseFor(env) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
    if (!defaultClient) defaultClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    return defaultClient;
}

function defaultRpc(env) {
    return async (args) => {
        const client = supabaseFor(env);
        if (!client) return { data: null, error: { message: 'no supabase env' } };
        return client.rpc('api_rate_hit', args);
    };
}

// Перевірка підпису токена Supabase Auth: id користувача або null (будь-яка помилка = не довіряємо).
function defaultGetUser(env) {
    return async (token) => {
        const client = supabaseFor(env);
        if (!client) return null;
        const { data, error } = await client.auth.getUser(token);
        return error || !data || !data.user ? null : data.user.id;
    };
}

const verified = new WeakMap();
// → id користувача з перевіреного токена або null. Результат кешується на запит (кілька викликів лімітера не множать перевірки).
async function verifiedUserId(req, deps, env) {
    const token = bearerToken(req);
    if (!token) return null;
    if (req && typeof req === 'object' && verified.has(req)) return verified.get(req);
    let id = null;
    try {
        // Перевірка токена не повинна вішати запит: за 1,5 с без відповіді рахуємо як анонім за IP.
        let timer = null;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs || GETUSER_TIMEOUT_MS); });
        try {
            const found = await Promise.race([Promise.resolve((deps.getUser || defaultGetUser(env))(token)), timeout]);
            id = typeof found === 'string' && found ? found : null;
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        id = null;
    }
    if (req && typeof req === 'object') verified.set(req, id);
    return id;
}

// → true, якщо запит можна обробляти. Інакше сама відповідає 429 (JSON, Retry-After) і повертає false.
export async function enforceRateLimit(req, res, name, deps = {}) {
    const env = deps.env || process.env;
    const rpc = deps.rpc || defaultRpc(env);
    const userId = await verifiedUserId(req, deps, env);
    const subject = userId ? 'user:' + userId : 'ip:' + clientIp(req);
    const limit = userId ? (deps.authed || LIMIT_AUTHED) : (deps.anon || LIMIT_ANON);
    let result = null;
    try {
        const { data, error } = await rpc({ p_bucket: bucketKey(name, subject), p_limit: limit, p_window_seconds: WINDOW_SECONDS });
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
