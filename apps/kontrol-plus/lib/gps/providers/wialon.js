// Wialon Remote API (Hosting і Local): https://help.wialon.com/en/api/user-guide
// POST https://{host}/wialon/ajax.html, application/x-www-form-urlencoded: svc, params (JSON), sid.
// Токен — лише в тілі POST (ніколи в URL / query). Помилки приходять з HTTP 200 як {"error": <код>}.
// Невдалий логін не повторюємо (Wialon: не більше 10 невдалих логінів на хвилину з IP).
import { GpsError } from '../errors.js';
import { safeRequest, parseApiHost } from '../safe-host.js';

const PATH = '/wialon/ajax.html';
const UNIT_SPEC = { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' };
const FLAG_BASE = 1; // id, nm
const FLAG_POSITION = 0x400000; // pos: {t, y, x, z, s, c, sc}
const MAX_UNITS = 5000;

export const WIALON_ERRORS = {
    1: 'invalid_session',
    1011: 'invalid_session',
    4: 'bad_params',
    7: 'access_denied',
    8: 'invalid_token',
    9: 'auth_unavailable',
    10: 'rate_limited',
    1003: 'rate_limited',
    '-100': 'network',
    '-101': 'network',
};

export function wialonErrorCode(error) {
    return WIALON_ERRORS[String(error)] || 'provider_error';
}

// creds: { apiHost, hostKind, token }. transport — safeRequest (у тестах — підміна без мережі).
export function createWialonProvider({ transport = safeRequest, timeoutMs = 15000, maxBytes = 5000000 } = {}) {
    async function call(creds, svc, params, sid) {
        const target = parseApiHost(creds.apiHost, creds.hostKind);
        const form = new URLSearchParams();
        form.set('svc', svc);
        form.set('params', JSON.stringify(params));
        if (sid) form.set('sid', sid);
        const res = await transport({ host: target.host, port: target.port, path: PATH, body: form.toString(), timeoutMs, maxBytes });
        if (res.status === 429) throw new GpsError('rate_limited', 'http_429');
        if (res.status !== 200) throw new GpsError('network', 'http_' + res.status);
        let json;
        try {
            json = JSON.parse(res.text);
        } catch {
            throw new GpsError('provider_error', 'bad_json');
        }
        if (json && typeof json === 'object' && !Array.isArray(json) && 'error' in json && json.error !== 0) {
            throw new GpsError(wialonErrorCode(json.error), 'wialon_' + json.error);
        }
        return json;
    }

    async function withSession(creds, fn) {
        if (!creds || typeof creds.token !== 'string' || !creds.token) throw new GpsError('invalid_token', 'empty');
        const login = await call(creds, 'token/login', { token: creds.token, fl: 1 });
        const sid = login && typeof login.eid === 'string' ? login.eid : null;
        if (!sid) throw new GpsError('provider_error', 'no_sid');
        try {
            return await fn(sid, login);
        } finally {
            try {
                await call(creds, 'core/logout', {}, sid);
            } catch {
                // Сесія сама закінчиться на сервері Wialon; помилку виходу не показуємо.
            }
        }
    }

    function search(creds, sid, flags) {
        return call(creds, 'core/search_items', { spec: UNIT_SPEC, force: 1, flags, from: 0, to: 0 }, sid);
    }

    function items(result) {
        return Array.isArray(result && result.items) ? result.items.slice(0, MAX_UNITS) : [];
    }

    // → { ok: true, account, unitsTotal } або { ok: false, code } (без деталей відповіді Wialon).
    async function validateCredentials(creds) {
        try {
            return await withSession(creds, async (sid, login) => {
                const result = await search(creds, sid, FLAG_BASE);
                const total = Number(result && result.totalItemsCount);
                const account = (login && (login.au || (login.user && login.user.nm))) || null;
                return { ok: true, account: account ? String(account).slice(0, 120) : null, unitsTotal: Number.isFinite(total) ? total : items(result).length };
            });
        } catch (error) {
            if (error instanceof GpsError) return { ok: false, code: error.code };
            throw error;
        }
    }

    async function listUnits(creds) {
        return withSession(creds, async (sid) => items(await search(creds, sid, FLAG_BASE))
            .filter((u) => u && (typeof u.id === 'number' || typeof u.id === 'string') && String(u.id).length <= 64)
            .map((u) => ({ externalId: String(u.id), name: String(u.nm == null ? '' : u.nm).slice(0, 200) })));
    }

    // Остання позиція юнітів (для збирача 2b; у 2a ніхто не викликає). Юніти без позиції й приватні точки
    // (pos без x / y) пропускаємо.
    async function fetchPositions(creds, externalIds) {
        const wanted = Array.isArray(externalIds) ? new Set(externalIds.map(String)) : null;
        return withSession(creds, async (sid) => {
            const out = [];
            for (const unit of items(await search(creds, sid, FLAG_BASE | FLAG_POSITION))) {
                if (!unit || (wanted && !wanted.has(String(unit.id)))) continue;
                const pos = unit.pos;
                if (!pos || typeof pos !== 'object') continue;
                const lat = Number(pos.y);
                const lon = Number(pos.x);
                const t = Number(pos.t);
                if (pos.x == null || pos.y == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || !Number.isFinite(t) || t <= 0) continue;
                const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
                out.push({
                    externalId: String(unit.id),
                    t: new Date(t * 1000).toISOString(),
                    lat,
                    lon,
                    speed: num(pos.s),
                    course: num(pos.c),
                    sats: num(pos.sc),
                    altitude: num(pos.z),
                });
            }
            return out;
        });
    }

    return { id: 'wialon', validateCredentials, listUnits, fetchPositions };
}
