// Запрошення менеджера з ремонтів (етап 3a). Патерн запрошень логістів сайту (api/team.js), скопійований сюди,
// а не імпортований: токен v2.<id>.<HMAC-SHA256>, у БД лише sha256 токена, перевірка timingSafeEqual, 7 днів.
// Domain separation: підписуємо 'repair_manager|…', тож токен запрошення логіста тут не працює, і навпаки.
// Секрет — env KP_INVITE_SIGNING_SECRET (проєкт kontrol-plus). Токен і email не логуємо й не повертаємо в помилках.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_URL = 'https://app.trip-control.com';
export const SEND_LIMIT_PER_HOUR = 10;
const DOMAIN = 'repair_manager';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAIL_TIMEOUT_MS = 8000;

export class HttpError extends Error {
    constructor(status, code, message) {
        super(code);
        this.status = status;
        this.code = code;
        this.publicMessage = message;
    }
}

export function tokenHash(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}

export function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

export function validEmail(value) {
    const email = normalizeEmail(value);
    return email.length >= 3 && email.length <= 254 && EMAIL_RE.test(email) && !/[\r\n<>"]/.test(email);
}

function signingPayload(invite) {
    return [DOMAIN, invite.id, normalizeEmail(invite.email), new Date(invite.expires_at).toISOString()].join('|');
}

export function inviteSignature(invite, secret) {
    if (!secret) throw new HttpError(503, 'NOT_CONFIGURED', 'Запрошення ще не налаштовано на сервері.');
    return createHmac('sha256', String(secret)).update(signingPayload(invite)).digest('base64url');
}

export function signedInviteToken(invite, secret) {
    return `v2.${invite.id}.${inviteSignature(invite, secret)}`;
}

export function signedInviteTokenIsValid(token, invite, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v2' || parts[1] !== invite.id) return false;
    const actual = Buffer.from(parts[2]);
    const expected = Buffer.from(inviteSignature(invite, secret));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// id запрошення з токена або null (підпис перевіряється потім проти рядка в БД).
export function signedInviteId(token) {
    const text = String(token || '');
    if (text.length < 32 || text.length > 512) return null;
    const parts = text.split('.');
    if (parts.length !== 3 || parts[0] !== 'v2' || !UUID_RE.test(parts[1]) || !/^[A-Za-z0-9_-]{20,}$/.test(parts[2])) return null;
    return parts[1].toLowerCase();
}

// sent / accepted / declined / expired / revoked.
export function inviteStatus(invite, now = Date.now()) {
    if (!invite) return 'revoked';
    if (invite.accepted_at) return 'accepted';
    if (invite.revoked_at) return 'revoked';
    if (invite.declined_at) return 'declined';
    if (!(Date.parse(invite.expires_at) > now)) return 'expired';
    return 'sent';
}

export function inviteLink(token) {
    return APP_URL + '/?repair_invite=' + encodeURIComponent(token);
}

// Resend — лише якщо задано RESEND_API_KEY і INVITE_FROM_EMAIL.
export function mailProvider(env) {
    const apiKey = String((env && env.RESEND_API_KEY) || '').trim();
    const from = String((env && env.INVITE_FROM_EMAIL) || '').trim();
    if (!apiKey || !from || /[\r\n]/.test(from)) return null;
    return { apiKey, from };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildInviteEmail({ orgName, url, expiresAt }) {
    const company = String(orgName || 'компанію').replace(/[\r\n]+/g, ' ').slice(0, 100);
    const until = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(expiresAt));
    const subject = 'Запрошення: менеджер з ремонтів — ' + company;
    const text = ['Вас запрошують у Контроль+ як менеджера з ремонтів компанії «' + company + '».', '',
        'Прийняти: ' + url, 'Посилання дійсне до ' + until + '.', '', 'Якщо ви не чекали цього листа, просто проігноруйте його.'].join('\n');
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0D2A28;max-width:520px">'
        + '<p>Вас запрошують у Контроль+ як менеджера з ремонтів компанії <b>«' + escapeHtml(company) + '»</b>.</p>'
        + '<p style="margin:24px 0"><a href="' + escapeHtml(url) + '" style="display:inline-block;padding:12px 22px;border-radius:8px;'
        + 'background:#0D2A29;color:#F4EFE5;text-decoration:none;font-weight:600">Прийняти запрошення</a></p>'
        + '<p style="color:#5A6B66;font-size:13px">Посилання дійсне до ' + escapeHtml(until) + '. Якщо кнопка не працює, відкрийте:<br>'
        + '<a href="' + escapeHtml(url) + '" style="color:#1A6B65;word-break:break-all">' + escapeHtml(url) + '</a></p></div>';
    return { subject, text, html };
}

export async function sendInviteEmail(to, message, { env, fetch: doFetch, timeoutMs = MAIL_TIMEOUT_MS } = {}) {
    const provider = mailProvider(env);
    if (!provider || typeof doFetch !== 'function') return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await doFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + provider.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: provider.from, to: [to], subject: message.subject, text: message.text, html: message.html }),
            signal: controller.signal,
        });
        return Boolean(res && res.ok);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

// Ліміт create + resend: 10 на організацію за годину (у памʼяті інстансу + за last_sent_at у БД).
export function createSendLimiter({ limit = SEND_LIMIT_PER_HOUR, windowMs = 3600000, now = () => Date.now() } = {}) {
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

const DB_ERRORS = {
    REPAIR_MANAGER_LIMIT: [409, 'Уже 2 менеджери з ремонтів (разом із чинними запрошеннями). Скасуйте запрошення або приберіть менеджера.'],
    REPAIR_INVITE_EXISTS: [409, 'Цю адресу вже запрошено. Надішліть запрошення ще раз зі списку.'],
    REPAIR_MANAGER_EXISTS: [409, 'Ця людина вже менеджер з ремонтів вашої компанії.'],
    REPAIR_INVITE_CLOSED: [409, 'Запрошення вже прийняте, скасоване або відхилене.'],
    REPAIR_INVITE_NOT_FOUND: [404, 'Запрошення не знайдено або строк дії минув.'],
    REPAIR_INVITE_USED: [409, 'Запрошення вже прийнято.'],
    INVITE_EMAIL_MISMATCH: [403, 'Запрошення надіслано на іншу пошту. Увійдіть акаунтом з тією адресою, на яку прийшов лист.'],
    REPAIR_MANAGER_IS_MEMBER: [409, 'Ви вже учасник цієї компанії — менеджером з ремонтів бути не можна.'],
    REPAIR_MANAGER_IS_DIRECTOR: [409, 'Ви директор цієї компанії — менеджером з ремонтів бути не можна.'],
    CONTROL_PLUS_REQUIRED: [403, 'Компанія не на тарифі Контроль+.'],
};

function dbError(error) {
    const text = String((error && (error.message || error.code)) || '');
    const code = Object.keys(DB_ERRORS).find((k) => text.includes(k));
    if (!code) return null;
    return new HttpError(DB_ERRORS[code][0], code, DB_ERRORS[code][1]);
}

const ACTIONS = ['create', 'resend', 'revoke', 'list', 'accept', 'decline'];
const MANAGER_ACTIONS = new Set(['create', 'resend', 'revoke', 'list']);

function bodyOf(req) {
    const raw = req.body;
    if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
    if (typeof raw === 'string' && raw.length <= 4096) {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

export function createRepairInvitesHandler({ store, secret, env = {}, fetch: doFetch, now = () => new Date(),
    limiter = createSendLimiter({ now: () => now().getTime() }), log = console } = {}) {

    async function authenticate(req) {
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) throw new HttpError(401, 'AUTH_REQUIRED', 'Потрібно увійти.');
        const user = await store.getUser(header.slice(7));
        if (!user) throw new HttpError(401, 'BAD_TOKEN', 'Сесія завершилась — увійдіть ще раз.');
        if (user.banned_until && new Date(user.banned_until).getTime() > now().getTime()) {
            throw new HttpError(403, 'USER_BLOCKED', 'Акаунт заблоковано.');
        }
        return user;
    }

    // Запрошує власник своєї організації на control_plus або директор такої організації.
    async function inviter(user) {
        const profile = await store.getProfile(user.id);
        if (profile && profile.org_id && profile.org_plan === 'control_plus' && profile.org_status !== 'blocked'
            && profile.member_status === 'active' && profile.org_role === 'owner') {
            return { orgId: profile.org_id, role: 'owner' };
        }
        const directorOf = await store.directorOrg(user.id);
        if (directorOf) return { orgId: directorOf, role: 'director' };
        throw new HttpError(403, 'REPAIRS_FORBIDDEN', 'Запрошувати менеджерів з ремонтів може власник або директор компанії на тарифі Контроль+.');
    }

    function publicInvite(row, t) {
        return {
            id: row.id,
            email: row.email,
            status: inviteStatus(row, t),
            expires_at: row.expires_at,
            created_at: row.created_at,
            last_sent_at: row.last_sent_at,
        };
    }

    async function seats(orgId, t) {
        const [managers, invites] = await Promise.all([store.countManagers(orgId), store.listInvites(orgId)]);
        const pending = invites.filter((i) => inviteStatus(i, t) === 'sent').length;
        return { used: managers + pending, limit: 2, managers, pending };
    }

    async function guardSends(orgId, t) {
        const recent = await store.recentSends(orgId, new Date(t - 3600000).toISOString());
        if (recent >= SEND_LIMIT_PER_HOUR || !limiter.hit(orgId)) {
            throw new HttpError(429, 'RATE_LIMITED', 'Забагато запрошень за годину. Спробуйте пізніше.');
        }
    }

    async function issue(orgId, inviteId, email, invitedBy, t) {
        const expiresAt = new Date(t + INVITE_TTL_MS).toISOString();
        const invite = { id: inviteId, email, expires_at: expiresAt };
        const token = signedInviteToken(invite, secret);
        try {
            await store.reserve({ orgId, inviteId, email, tokenHash: tokenHash(token), invitedBy, expiresAt });
        } catch (error) {
            throw dbError(error) || error;
        }
        const url = inviteLink(token);
        const orgName = await store.orgName(orgId);
        const mailed = await sendInviteEmail(email, buildInviteEmail({ orgName, url, expiresAt }), { env, fetch: doFetch });
        // Посилання бачить лише той, хто запрошує, і лише якщо листа не надіслано.
        return { invite: { id: inviteId, email, status: 'sent', expires_at: expiresAt }, mail_sent: mailed, ...(mailed ? {} : { link: url }) };
    }

    const handlers = {
        async list(user) {
            const { orgId } = await inviter(user);
            const t = now().getTime();
            const invites = await store.listInvites(orgId);
            return { status: 200, body: { ok: true, invites: invites.map((i) => publicInvite(i, t)), seats: await seats(orgId, t) } };
        },
        async create(user, body) {
            const { orgId } = await inviter(user);
            if (!validEmail(body.email)) throw new HttpError(400, 'BAD_EMAIL', 'Вкажіть коректну пошту.');
            const t = now().getTime();
            await guardSends(orgId, t);
            return { status: 200, body: { ok: true, ...(await issue(orgId, randomUUID(), normalizeEmail(body.email), user.id, t)) } };
        },
        async resend(user, body) {
            const { orgId } = await inviter(user);
            const id = String(body.id || '');
            if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_INVITE', 'Запрошення не знайдено.');
            const row = await store.getInvite(id);
            if (!row || row.org_id !== orgId) throw new HttpError(404, 'REPAIR_INVITE_NOT_FOUND', DB_ERRORS.REPAIR_INVITE_NOT_FOUND[1]);
            const t = now().getTime();
            await guardSends(orgId, t);
            return { status: 200, body: { ok: true, ...(await issue(orgId, row.id, row.email, user.id, t)) } };
        },
        async revoke(user, body) {
            const { orgId } = await inviter(user);
            const id = String(body.id || '');
            if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_INVITE', 'Запрошення не знайдено.');
            const done = await store.revoke(orgId, id);
            if (!done) throw new HttpError(404, 'REPAIR_INVITE_NOT_FOUND', DB_ERRORS.REPAIR_INVITE_NOT_FOUND[1]);
            return { status: 200, body: { ok: true } };
        },
        async accept(user, body) {
            const token = await checkedToken(body.token);
            try {
                const orgId = await store.accept(tokenHash(token), user.id, normalizeEmail(user.email));
                return { status: 200, body: { ok: true, org_name: await store.orgName(orgId) } };
            } catch (error) {
                throw dbError(error) || error;
            }
        },
        async decline(user, body) {
            const token = await checkedToken(body.token);
            try {
                await store.decline(tokenHash(token), normalizeEmail(user.email));
                return { status: 200, body: { ok: true } };
            } catch (error) {
                throw dbError(error) || error;
            }
        },
    };

    // Підроблений, чужий (логіста), прострочений, скасований, відхилений — однаково 404.
    async function checkedToken(token) {
        const notFound = new HttpError(404, 'REPAIR_INVITE_NOT_FOUND', DB_ERRORS.REPAIR_INVITE_NOT_FOUND[1]);
        const id = signedInviteId(token);
        if (!id) throw notFound;
        const row = await store.getInvite(id);
        if (!row || !signedInviteTokenIsValid(token, row, secret)) throw notFound;
        const status = inviteStatus(row, now().getTime());
        if (status === 'accepted') throw new HttpError(409, 'REPAIR_INVITE_USED', DB_ERRORS.REPAIR_INVITE_USED[1]);
        if (status !== 'sent') throw notFound;
        return String(token);
    }

    return async function repairInvitesHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
        }
        const body = bodyOf(req);
        const action = String(body.action || '');
        try {
            const user = await authenticate(req);
            if (!ACTIONS.includes(action)) throw new HttpError(400, 'BAD_ACTION', 'Невідома дія.');
            if (!secret) throw new HttpError(503, 'NOT_CONFIGURED', 'Запрошення ще не налаштовано на сервері.');
            const out = await handlers[action](user, body);
            return res.status(out.status).json(out.body);
        } catch (error) {
            if (error instanceof HttpError) return res.status(error.status).json({ code: error.code, error: error.publicMessage });
            // Лише дія й тип: без токена, без email, без тексту помилки бази.
            log.error('[repairs-invites] ' + (ACTIONS.includes(action) ? action : 'unknown') + ': internal error');
            return res.status(500).json({ code: 'INTERNAL', error: 'Не вдалося виконати дію. Спробуйте пізніше.' });
        }
    };
}

export { MANAGER_ACTIONS };
