// Запрошення замовника підрозділу («Власний парк», етап 1). Токен — 32 випадкові байти (base64url), у БД лише sha256 (як у запрошень
// repair_manager, але без HMAC: підпис нічого не додає до випадкового 256-бітного токена). Права перевіряє БД (own_fleet_invite_reserve
// з p_invited_by): запрошувати можуть owner / director / logist організації з прапорцем own_fleet. Токен і email не логуємо.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    APP_URL, HttpError, INVITE_TTL_MS, createSendLimiter, mailProvider, normalizeEmail, sendInviteEmail, validEmail,
} from '../repairs/invites.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^r1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/i;
const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');
const INVITE_COLUMNS = 'id, org_id, email, unit_ids, expires_at, accepted_at, revoked_at, created_at, last_sent_at';

const DB_ERRORS = {
    OWN_FLEET_FORBIDDEN: [403, 'Запрошувати замовників може директор, менеджер або логіст компанії з модулем «Власний парк».'],
    OWN_FLEET_UNIT_NOT_IN_ORG: [400, 'Оберіть хоча б один підрозділ компанії (не з архіву).'],
    REQUESTER_LIMIT: [409, 'Досягнуто ліміт замовників підрозділів (30, разом із відкритими запрошеннями).'],
    REQUESTER_REQUIRES_OWN_FLEET: [409, 'Модуль «Власний парк» не ввімкнено для компанії.'],
    REQUESTER_WORKS_ELSEWHERE: [409, 'Цей акаунт уже працює в іншій компанії. Увійдіть іншим акаунтом або попросіть надіслати запрошення на іншу пошту.'],
    REQUESTER_IS_MEMBER: [409, 'Ви вже учасник цієї компанії — замовником підрозділу бути не можна.'],
    REQUESTER_INVITE_NOT_FOUND: [404, 'Запрошення не знайдено або строк дії минув.'],
    REQUESTER_INVITE_USED: [409, 'Запрошення вже прийнято.'],
    INVITE_EMAIL_MISMATCH: [403, 'Запрошення надіслано на іншу пошту. Увійдіть акаунтом з тією адресою, на яку прийшов лист.'],
};
const ACTIONS = ['create', 'resend', 'revoke', 'list', 'accept'];

function dbError(error) {
    const text = String((error && (error.message || error.code)) || '');
    const code = Object.keys(DB_ERRORS).find((k) => text.includes(k));
    return code ? new HttpError(DB_ERRORS[code][0], code, DB_ERRORS[code][1]) : null;
}

export function inviteStatus(row, now = Date.now()) {
    if (!row) return 'revoked';
    if (row.accepted_at) return 'accepted';
    if (row.revoked_at) return 'revoked';
    if (!(Date.parse(row.expires_at) > now)) return 'expired';
    return 'sent';
}

function must({ data, error }) {
    if (error) {
        const err = new Error(String(error.message || 'db'));
        err.code = error.code;
        throw err;
    }
    return data;
}

export function createOwnFleetStore(supabase) {
    return {
        async getUser(jwt) {
            const { data, error } = await supabase.auth.getUser(jwt);
            return error || !data ? null : data.user;
        },
        async access(userId) {
            const rows = must(await supabase.rpc('own_fleet_access_for', { p_user: userId }));
            return rows && rows[0] ? rows[0] : null;
        },
        async orgName(orgId) {
            const data = must(await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle());
            return data ? data.name : null;
        },
        async listInvites(orgId) {
            return must(await supabase.from('requester_invites').select(INVITE_COLUMNS).eq('org_id', orgId).order('created_at', { ascending: false }).limit(100)) || [];
        },
        async getInvite(id) {
            return must(await supabase.from('requester_invites').select(INVITE_COLUMNS).eq('id', id).maybeSingle());
        },
        async reserve(args) {
            return must(await supabase.rpc('own_fleet_invite_reserve', {
                p_org: args.orgId, p_invite: args.inviteId, p_email: args.email, p_token_hash: args.tokenHash,
                p_invited_by: args.invitedBy, p_expires_at: args.expiresAt, p_unit_ids: args.unitIds,
            }));
        },
        async revoke(orgId, id) {
            return must(await supabase.rpc('own_fleet_invite_revoke', { p_org: orgId, p_invite: id }));
        },
        async accept(hash, userId, email) {
            return must(await supabase.rpc('own_fleet_invite_accept', { p_token_hash: hash, p_user: userId, p_email: email }));
        },
    };
}

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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildEmail({ orgName, url, expiresAt }) {
    const company = String(orgName || 'компанію').replace(/[\r\n]+/g, ' ').slice(0, 100);
    const until = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(expiresAt));
    return {
        subject: 'Запрошення: замовник підрозділу — ' + company,
        text: 'Вас запрошують у Контроль+ як замовника підрозділу компанії «' + company + '».\n\nПрийняти: ' + url + '\nПосилання дійсне до ' + until
            + '.\n\nЯкщо ви не чекали цього листа, просто проігноруйте його.',
        html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0D2A28;max-width:520px"><p>Вас запрошують у Контроль+ як замовника підрозділу компанії <b>«'
            + escapeHtml(company) + '»</b>.</p><p style="margin:24px 0"><a href="' + escapeHtml(url)
            + '" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#0D2A29;color:#F4EFE5;text-decoration:none;font-weight:600">Прийняти запрошення</a></p>'
            + '<p style="color:#5A6B66;font-size:13px">Посилання дійсне до ' + escapeHtml(until) + '.</p></div>',
    };
}

export function createOwnFleetInvitesHandler({ store, env = {}, fetch: doFetch, now = () => new Date(), limiter = createSendLimiter({ now: () => now().getTime() }), log = console } = {}) {
    const blocked = (user) => Boolean(user.banned_until && new Date(user.banned_until).getTime() > now().getTime());

    async function authenticate(req) {
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) throw new HttpError(401, 'AUTH_REQUIRED', 'Потрібно увійти.');
        const user = await store.getUser(header.slice(7));
        if (!user) throw new HttpError(401, 'BAD_TOKEN', 'Сесія завершилась — увійдіть ще раз.');
        if (blocked(user)) throw new HttpError(403, 'USER_BLOCKED', 'Акаунт заблоковано.');
        return user;
    }

    // Керувати запрошеннями: owner / director / logist організації з прапорцем own_fleet (та сама логіка, що в БД).
    async function inviter(user) {
        const access = await store.access(user.id);
        if (!access || !['owner', 'director', 'logist'].includes(access.role)) throw new HttpError(403, 'OWN_FLEET_FORBIDDEN', DB_ERRORS.OWN_FLEET_FORBIDDEN[1]);
        return access.org_id;
    }

    function requireConfirmedEmail(user) {
        if (!user.email_confirmed_at) throw new HttpError(403, 'EMAIL_NOT_CONFIRMED', 'Спершу підтвердьте пошту, а потім відкрийте посилання-запрошення.');
    }

    const publicInvite = (row, t) => ({ id: row.id, email: row.email, unit_ids: row.unit_ids, status: inviteStatus(row, t), expires_at: row.expires_at, created_at: row.created_at });

    async function issue(orgId, inviteId, email, unitIds, invitedBy, t) {
        if (!limiter.hit(orgId)) throw new HttpError(429, 'INVITE_RATE_LIMIT', 'Забагато запрошень: не більше 10 на годину.');
        const expiresAt = new Date(t + INVITE_TTL_MS).toISOString();
        const token = 'r1.' + inviteId + '.' + randomBytes(24).toString('base64url');
        try {
            await store.reserve({ orgId, inviteId, email, tokenHash: sha256(token), invitedBy, expiresAt, unitIds });
        } catch (error) {
            throw dbError(error) || error;
        }
        const url = APP_URL + '/?requester_invite=' + encodeURIComponent(token);
        const orgName = await store.orgName(orgId);
        const mailed = mailProvider(env) ? await sendInviteEmail(email, buildEmail({ orgName, url, expiresAt }), { env, fetch: doFetch }) : false;
        // Посилання бачить лише той, хто запрошує, і лише якщо листа не надіслано.
        return { invite: { id: inviteId, email, status: 'sent', expires_at: expiresAt, unit_ids: unitIds }, mail_sent: mailed, ...(mailed ? {} : { link: url }) };
    }

    const unitIdsOf = (body) => (Array.isArray(body.unit_ids) ? body.unit_ids.map(String).filter((id) => UUID_RE.test(id)).slice(0, 50) : []);

    const handlers = {
        async list(user) {
            const orgId = await inviter(user);
            const t = now().getTime();
            return { status: 200, body: { ok: true, invites: (await store.listInvites(orgId)).map((r) => publicInvite(r, t)) } };
        },
        async create(user, body) {
            const orgId = await inviter(user);
            if (!validEmail(body.email)) throw new HttpError(400, 'BAD_EMAIL', 'Вкажіть коректну пошту.');
            const unitIds = unitIdsOf(body);
            if (!unitIds.length) throw new HttpError(400, 'OWN_FLEET_UNIT_NOT_IN_ORG', DB_ERRORS.OWN_FLEET_UNIT_NOT_IN_ORG[1]);
            return { status: 200, body: { ok: true, ...(await issue(orgId, randomUUID(), normalizeEmail(body.email), unitIds, user.id, now().getTime())) } };
        },
        async resend(user, body) {
            const orgId = await inviter(user);
            const id = String(body.id || '');
            if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_INVITE', 'Запрошення не знайдено.');
            const row = await store.getInvite(id);
            if (!row || row.org_id !== orgId || row.accepted_at) throw new HttpError(404, 'REQUESTER_INVITE_NOT_FOUND', DB_ERRORS.REQUESTER_INVITE_NOT_FOUND[1]);
            return { status: 200, body: { ok: true, ...(await issue(orgId, row.id, row.email, row.unit_ids, user.id, now().getTime())) } };
        },
        async revoke(user, body) {
            const orgId = await inviter(user);
            const id = String(body.id || '');
            if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_INVITE', 'Запрошення не знайдено.');
            if (!(await store.revoke(orgId, id))) throw new HttpError(404, 'REQUESTER_INVITE_NOT_FOUND', DB_ERRORS.REQUESTER_INVITE_NOT_FOUND[1]);
            return { status: 200, body: { ok: true } };
        },
        async accept(user, body) {
            requireConfirmedEmail(user);
            const token = String(body.token || '');
            if (!TOKEN_RE.test(token) || token.length > 200) throw new HttpError(404, 'REQUESTER_INVITE_NOT_FOUND', DB_ERRORS.REQUESTER_INVITE_NOT_FOUND[1]);
            try {
                const orgId = await store.accept(sha256(token), user.id, normalizeEmail(user.email));
                return { status: 200, body: { ok: true, org_name: await store.orgName(orgId) } };
            } catch (error) {
                throw dbError(error) || error;
            }
        },
    };

    return async function ownFleetInvitesHandler(req, res) {
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
            const out = await handlers[action](user, body);
            return res.status(out.status).json(out.body);
        } catch (error) {
            if (error instanceof HttpError) return res.status(error.status).json({ code: error.code, error: error.publicMessage });
            // Лише дія й тип: без токена, без email, без тексту помилки бази.
            log.error('[own-fleet-invites] ' + (ACTIONS.includes(action) ? action : 'unknown') + ': internal error');
            return res.status(500).json({ code: 'INTERNAL', error: 'Не вдалося виконати дію. Спробуйте пізніше.' });
        }
    };
}
