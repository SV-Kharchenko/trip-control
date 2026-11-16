// SSO в AGRO (agro.trip-control.com): видача разового підписаного токена для користувача Контроль+. Чиста логіка без мережі (тестується з
// підставним store); у браузерний код (index.html, assets/, apps/kontrol-plus/src/) цей файл НЕ імпортується. Споживач токена — AGRO (окремий
// репозиторій і окрема база). Живе в проєкті trip-control (api/agro/sso.js): Контроль+ проксює на нього /api/* (apps/kontrol-plus/vercel.json),
// а власних функцій у kontrol-plus на Hobby максимум 12 — всі вони вже зайняті.
//
// Токен: JWT HS256 (node:crypto, без залежностей), живе 60 с, містить jti (повторне використання відсікає AGRO). Секрет AGRO_SSO_SECRET лише
// на сервері (Vercel, проєкт trip-control) і в AGRO. Токен іде у fragment URL (#sso=…): fragment не потрапляє в логи серверів і Referer.
// Права вирішує БД (agro_access_for): глобальний вимикач, прапорець компанії, перевизначення користувача, блокування. У логах — лише код дії.
import { createHmac, randomUUID } from 'node:crypto';
// Самодостатньо: тека /apps/ у .vercelignore, тому імпортувати з apps/kontrol-plus сайт не може (ті самі HttpError і ліміт, що в КП).
export class HttpError extends Error {
    constructor(status, code, message) {
        super(code);
        this.status = status;
        this.code = code;
        this.publicMessage = message;
    }
}

export function createSendLimiter({ limit = 10, windowMs = 3600000, now = () => Date.now() } = {}) {
    const hits = new Map();
    return {
        hit(key) {
            const t = now();
            const list = (hits.get(key) || []).filter((at) => t - at < windowMs);
            if (list.length >= limit) {
                hits.set(key, list);
                return false;
            }
            list.push(t);
            hits.set(key, list);
            return true;
        },
    };
}

export const TOKEN_TTL_SECONDS = 60;
export const ISSUER = 'trip-control';
export const AUDIENCE = 'agro';
export const DEFAULT_AGRO_URL = 'https://agro.trip-control.com';
export const MIN_SECRET_LENGTH = 32;
export const ISSUE_LIMIT_PER_MINUTE = 10;

const DENIED_TEXT = {
    global_off: 'Вхід в AGRO тимчасово вимкнено адміністратором платформи.',
    user_blocked: 'Акаунт заблоковано, вхід в AGRO недоступний.',
    email_unconfirmed: 'Спершу підтвердьте пошту, а потім відкрийте AGRO.',
    no_org: 'Для входу в AGRO потрібна компанія в Контроль+.',
    org_blocked: 'Компанію заблоковано, вхід в AGRO недоступний.',
    user_override: 'Адміністратор закрив вам доступ до AGRO.',
    org: 'AGRO не підключено для вашої компанії. Зверніться до адміністратора.',
};

const b64url = (input) => Buffer.from(input).toString('base64url');

export function signJwt(claims, secret) {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const sig = createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
    return head + '.' + body + '.' + sig;
}

export function buildClaims({ user, membership, now, jti }) {
    const iat = Math.floor(now / 1000);
    return {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: user.id,
        email: String(user.email || '').trim().toLowerCase(),
        org_id: membership.org_id,
        org_name: membership.org_name || '',
        org_role: membership.org_role,
        provision: membership.org_role === 'owner',
        iat,
        nbf: iat,
        exp: iat + TOKEN_TTL_SECONDS,
        jti,
    };
}

// Адреса AGRO лише з env і лише origin: https; http://localhost — тільки поза production (VERCEL_ENV !== 'production'). Жодних параметрів із запиту.
export function agroBaseUrl(env = {}) {
    const raw = String(env.AGRO_APP_URL || '').trim() || DEFAULT_AGRO_URL;
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const devOnly = env.VERCEL_ENV !== 'production';
    if (url.protocol !== 'https:' && !(devOnly && local && url.protocol === 'http:')) return null;
    return url.origin;
}

// Чого бракує: 'NOT_CONFIGURED' — env (SUPABASE_URL / SERVICE_ROLE_KEY / секрет ≥ 32); 'SSO_NOT_CONFIGURED' — недопустима AGRO_APP_URL
// (у production лише https-origin); null — усе гаразд.
export function configProblem(env = {}) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || String(env.AGRO_SSO_SECRET || '').length < MIN_SECRET_LENGTH) return 'NOT_CONFIGURED';
    return agroBaseUrl(env) ? null : 'SSO_NOT_CONFIGURED';
}

export function ssoConfig(env = {}) {
    if (configProblem(env)) return null;
    return { secret: String(env.AGRO_SSO_SECRET), base: agroBaseUrl(env) };
}

function must({ data, error }) {
    if (error) {
        const err = new Error(String(error.message || 'db'));
        err.code = error.code;
        throw err;
    }
    return data;
}

export function createAgroStore(supabase) {
    return {
        async getUser(jwt) {
            const { data, error } = await supabase.auth.getUser(jwt);
            return error || !data ? null : data.user;
        },
        async access(userId) {
            return must(await supabase.rpc('agro_access_for', { p_user: userId }));
        },
        async membership(userId) {
            const profile = must(await supabase.from('profiles').select('org_id, org_role').eq('id', userId).maybeSingle());
            if (!profile || !profile.org_id) return null;
            const org = must(await supabase.from('organizations').select('name').eq('id', profile.org_id).maybeSingle());
            return { org_id: profile.org_id, org_name: org ? org.name : '', org_role: profile.org_role };
        },
    };
}

export function createAgroSsoHandler({ store, env = {}, now = () => Date.now(), limiter = createSendLimiter({ limit: ISSUE_LIMIT_PER_MINUTE, windowMs: 60000, now: () => now() }), jti = randomUUID, log = console } = {}) {
    async function issue(req) {
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) throw new HttpError(401, 'AUTH_REQUIRED', 'Потрібно увійти.');
        const problem = configProblem(env);
        const config = problem ? null : ssoConfig(env);
        if (!config) throw new HttpError(503, problem, 'Вхід в AGRO ще не налаштовано на сервері.');
        const user = await store.getUser(header.slice(7));
        if (!user) throw new HttpError(401, 'BAD_TOKEN', 'Сесія завершилась — увійдіть ще раз.');
        if (!limiter.hit(user.id)) throw new HttpError(429, 'AGRO_RATE_LIMIT', 'Забагато спроб входу в AGRO. Зачекайте хвилину.');
        const access = await store.access(user.id);
        const reason = access && typeof access.reason === 'string' ? access.reason : 'org';
        if (!access || access.allowed !== true) {
            const err = new HttpError(403, 'AGRO_ACCESS_DENIED', DENIED_TEXT[reason] || DENIED_TEXT.org);
            err.reason = reason;
            throw err;
        }
        const membership = await store.membership(user.id);
        if (!membership) {
            const err = new HttpError(403, 'AGRO_ACCESS_DENIED', DENIED_TEXT.no_org);
            err.reason = 'no_org';
            throw err;
        }
        const token = signJwt(buildClaims({ user, membership, now: now(), jti: jti() }), config.secret);
        return config.base + '/#sso=' + token;
    }

    return async function agroSsoHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
        }
        try {
            const url = await issue(req);
            log.info('[agro-sso] issue');
            return res.status(200).json({ ok: true, url });
        } catch (error) {
            if (error instanceof HttpError) {
                if (error.status === 403) log.info('[agro-sso] denied');
                return res.status(error.status).json({ code: error.code, error: error.publicMessage, ...(error.reason ? { reason: error.reason } : {}) });
            }
            // Лише дія: без пошти, JWT, токена й тексту помилки бази.
            log.error('[agro-sso] issue: internal error');
            return res.status(500).json({ code: 'INTERNAL', error: 'Не вдалося відкрити AGRO. Спробуйте пізніше.' });
        }
    };
}
