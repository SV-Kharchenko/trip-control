// POST /api/gps/{connect|test|sync-units|disconnect} — керування підключенням GPS (лише власник організації на
// control_plus). Залежності підмінні (store, провайдер, час), тож логіка тестується без мережі й без БД.
// Токен Wialon: перевіряється, передається в Vault (gps_store_token) і далі ніде не зʼявляється — ні у відповідях,
// ні в логах, ні в повідомленнях помилок. Тіла запитів не логуємо.
import { getProvider as defaultGetProvider } from './index.js';
import { GpsError, gpsMessage, AUTH_CODES } from './errors.js';
import { hostingHost, normalizeLocalUrl, parseApiHost } from './safe-host.js';

export const GPS_ROUTES = ['connect', 'test', 'sync-units', 'disconnect'];
const TOKEN_RE = /^[0-9A-Za-z]{32,128}$/;
const RATE_WINDOW_MS = 10000;
const PROVIDER = 'wialon';

export function createLimiter({ windowMs = RATE_WINDOW_MS, now = () => Date.now() } = {}) {
    const last = new Map();
    return {
        hit(key) {
            const t = now();
            for (const [k, at] of last) if (t - at >= windowMs) last.delete(k);
            if (last.has(key)) return false;
            last.set(key, t);
            return true;
        },
    };
}

// Автопідказка мапінгу: назва юніта = номер авто (lower(trim)). Лише вільні авто, кожне — не більше одного разу.
export function suggestMapping(units, fleet) {
    const byLabel = new Map();
    for (const v of fleet || []) {
        const key = String(v.label || '').trim().toLowerCase();
        if (key && !byLabel.has(key)) byLabel.set(key, v.id);
    }
    const taken = new Set((units || []).map((u) => u.vehicle_id).filter(Boolean));
    const out = new Map();
    for (const u of units || []) {
        if (!u.active || u.vehicle_id) continue;
        const id = byLabel.get(String(u.name || '').trim().toLowerCase());
        if (id && !taken.has(id)) {
            taken.add(id);
            out.set(u.id, id);
        }
    }
    return out;
}

export function publicIntegration(row) {
    if (!row) return null;
    return {
        status: row.status,
        host_kind: row.host_kind,
        api_host: row.api_host,
        provider_account: row.provider_account ?? null,
        units_total: row.units_total ?? null,
        token_hint: row.token_hint ?? null,
        last_checked_at: row.last_checked_at ?? null,
        last_ok_at: row.last_ok_at ?? null,
        last_error_code: row.last_error_code ?? null,
    };
}

function routeOf(req) {
    const fromQuery = req.query && (Array.isArray(req.query.route) ? req.query.route[0] : req.query.route);
    if (fromQuery) return String(fromQuery);
    const path = String(req.url || '').split('?')[0];
    return path.split('/').filter(Boolean).pop() || '';
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

class HttpError extends Error {
    constructor(status, code, message) {
        super(code);
        this.status = status;
        this.code = code;
        this.publicMessage = message;
    }
}

const providerStatus = (code) => (code === 'unsafe_host' ? 400 : AUTH_CODES.has(code) ? 422 : 502);

export function createGpsHandler({ store, getProvider = defaultGetProvider, providerDeps, now = () => new Date(),
    limiter = createLimiter(), log = console } = {}) {
    const provider = () => getProvider(PROVIDER, providerDeps);

    async function authorize(req) {
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) throw new HttpError(401, 'AUTH_REQUIRED', 'Потрібно увійти.');
        const user = await store.getUser(header.slice(7));
        if (!user) throw new HttpError(401, 'BAD_TOKEN', 'Сесія завершилась — увійдіть ще раз.');
        if (user.banned_until && new Date(user.banned_until).getTime() > now().getTime()) {
            throw new HttpError(403, 'USER_BLOCKED', 'Акаунт заблоковано.');
        }
        const profile = await store.getProfile(user.id);
        if (!profile || !profile.org_id) throw new HttpError(403, 'NO_PROFILE', 'Профіль користувача не знайдено.');
        if (profile.member_status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
        if (profile.org_status === 'blocked') throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
        if (profile.org_plan !== 'control_plus') throw new HttpError(403, 'CONTROL_PLUS_REQUIRED', 'GPS доступний у тарифі Контроль+.');
        if (profile.org_role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Підключенням GPS керує власник компанії.');
        return { user, orgId: profile.org_id };
    }

    function limit(orgId, integration) {
        const recent = integration && integration.last_checked_at
            && now().getTime() - new Date(integration.last_checked_at).getTime() < RATE_WINDOW_MS;
        if (recent || !limiter.hit(orgId)) {
            throw new HttpError(429, 'RATE_LIMITED', 'Зачекайте 10 секунд перед наступною перевіркою.');
        }
    }

    async function connected(orgId) {
        const integration = await store.getIntegration(orgId, PROVIDER);
        if (!integration || !integration.token_secret_id || integration.status === 'disabled') {
            throw new HttpError(404, 'NOT_CONNECTED', 'GPS ще не підключено.');
        }
        return integration;
    }

    async function credsOf(integration) {
        const token = await store.readToken(integration.id);
        if (!token) throw new HttpError(409, 'NO_TOKEN', 'Токен не знайдено. Підключіть GPS ще раз.');
        return { apiHost: integration.api_host, hostKind: integration.host_kind, token };
    }

    async function markFailure(integration, code) {
        const at = now().toISOString();
        return store.updateIntegration(integration.id, {
            status: AUTH_CODES.has(code) ? 'error_auth' : 'error',
            last_checked_at: at,
            last_error_code: code,
            last_error_at: at,
            consecutive_failures: (integration.consecutive_failures || 0) + 1,
        });
    }

    async function markOk(integration, extra) {
        const at = now().toISOString();
        return store.updateIntegration(integration.id, {
            status: 'active',
            last_checked_at: at,
            last_ok_at: at,
            last_error_code: null,
            last_error_at: null,
            consecutive_failures: 0,
            ...extra,
        });
    }

    async function connect(auth, body) {
        const hasRegion = body.region !== undefined && body.region !== null && body.region !== '';
        const hasLocal = body.localUrl !== undefined && body.localUrl !== null && body.localUrl !== '';
        if (hasRegion === hasLocal) throw new HttpError(400, 'BAD_INPUT', 'Оберіть Wialon Hosting (регіон) або Wialon Local (адреса сервера).');
        if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) {
            throw new HttpError(400, 'BAD_TOKEN_FORMAT', 'Токен має містити 32–128 латинських літер і цифр.');
        }
        let hostKind;
        let apiHost;
        if (hasRegion) {
            apiHost = typeof body.region === 'string' ? hostingHost(body.region) : null;
            if (!apiHost) throw new HttpError(400, 'BAD_REGION', 'Невідомий регіон Wialon Hosting.');
            hostKind = 'hosting';
        } else {
            const local = normalizeLocalUrl(body.localUrl);
            if (!local.ok) throw new HttpError(400, 'UNSAFE_HOST', gpsMessage('unsafe_host'));
            apiHost = local.apiHost;
            hostKind = 'local';
        }
        const existing = await store.getIntegration(auth.orgId, PROVIDER);
        limit(auth.orgId, existing);
        const result = await provider().validateCredentials({ apiHost, hostKind, token: body.token });
        if (!result.ok) {
            // Невдала перевірка: токен не зберігаємо, наявне підключення не чіпаємо.
            throw new HttpError(providerStatus(result.code), result.code.toUpperCase(), gpsMessage(result.code));
        }
        const at = now().toISOString();
        const fields = {
            host_kind: hostKind,
            api_host: apiHost,
            status: 'active',
            provider_account: result.account,
            units_total: result.unitsTotal,
            last_checked_at: at,
            last_ok_at: at,
            last_error_code: null,
            last_error_at: null,
            consecutive_failures: 0,
        };
        const integration = existing
            ? await store.updateIntegration(existing.id, fields)
            : await store.insertIntegration({ org_id: auth.orgId, provider: PROVIDER, created_by: auth.user.id, ...fields });
        let hint;
        try {
            hint = await store.storeToken(integration.id, body.token);
        } catch {
            await store.updateIntegration(integration.id, { status: 'error', last_error_code: 'token_store', last_error_at: at });
            throw new HttpError(500, 'TOKEN_STORE', 'Не вдалося безпечно зберегти токен. Спробуйте ще раз.');
        }
        return { status: 200, body: { ok: true, ...publicIntegration({ ...integration, token_hint: hint }) } };
    }

    async function test(auth) {
        const integration = await connected(auth.orgId);
        limit(auth.orgId, integration);
        let result;
        try {
            parseApiHost(integration.api_host, integration.host_kind);
            result = await provider().validateCredentials(await credsOf(integration));
        } catch (error) {
            if (!(error instanceof GpsError)) throw error;
            result = { ok: false, code: error.code };
        }
        if (!result.ok) {
            const row = await markFailure(integration, result.code);
            return { status: 200, body: { ok: false, message: gpsMessage(result.code), ...publicIntegration(row) } };
        }
        const row = await markOk(integration, { provider_account: result.account, units_total: result.unitsTotal });
        return { status: 200, body: { ok: true, ...publicIntegration(row) } };
    }

    async function syncUnits(auth) {
        const integration = await connected(auth.orgId);
        let units;
        try {
            units = await provider().listUnits(await credsOf(integration));
        } catch (error) {
            if (!(error instanceof GpsError)) throw error;
            const row = await markFailure(integration, error.code);
            return { status: 200, body: { ok: false, message: gpsMessage(error.code), ...publicIntegration(row) } };
        }
        const at = now().toISOString();
        const existing = await store.listUnits(integration.id);
        const incoming = new Map(units.map((u) => [u.externalId, u]));
        const known = new Set(existing.map((u) => u.external_id));
        const added = units.filter((u) => !known.has(u.externalId)).length;
        const gone = existing.filter((u) => u.active && !incoming.has(u.external_id));
        if (units.length) {
            await store.upsertUnits(units.map((u) => ({
                org_id: auth.orgId,
                integration_id: integration.id,
                external_id: u.externalId,
                name: u.name,
                active: true,
                last_seen_at: at,
            })));
        }
        // Юніти, яких більше нема в провайдері, — неактивні; мапінг не чіпаємо.
        if (gone.length) await store.deactivateUnits(integration.id, gone.map((u) => u.id));
        await markOk(integration, { units_total: units.length });
        const rows = await store.listUnits(integration.id);
        const suggestions = suggestMapping(rows, await store.fleetVehicles(auth.orgId));
        return {
            status: 200,
            body: {
                ok: true,
                counts: { total: units.length, added, updated: units.length - added, deactivated: gone.length },
                units: rows.map((u) => ({
                    id: u.id,
                    external_id: u.external_id,
                    name: u.name,
                    active: u.active,
                    vehicle_id: u.vehicle_id ?? null,
                    suggested_vehicle_id: suggestions.get(u.id) || null,
                })),
            },
        };
    }

    async function disconnect(auth) {
        const integration = await store.getIntegration(auth.orgId, PROVIDER);
        if (!integration) throw new HttpError(404, 'NOT_CONNECTED', 'GPS ще не підключено.');
        await store.deleteToken(integration.id);
        const row = await store.updateIntegration(integration.id, { status: 'disabled', token_secret_id: null, token_hint: null });
        return { status: 200, body: { ok: true, ...publicIntegration(row) } };
    }

    const HANDLERS = { connect, test, 'sync-units': syncUnits, disconnect };

    return async function gpsHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        const route = routeOf(req);
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
        }
        if (!GPS_ROUTES.includes(route)) return res.status(404).json({ code: 'NOT_FOUND', error: 'Невідома дія.' });
        try {
            const auth = await authorize(req);
            const out = await HANDLERS[route](auth, bodyOf(req));
            return res.status(out.status).json(out.body);
        } catch (error) {
            if (error instanceof HttpError) return res.status(error.status).json({ code: error.code, error: error.publicMessage });
            // Лише маршрут і тип: без тіла запиту, без токена, без тексту помилки бази чи провайдера.
            log.error('[gps] ' + route + ': internal error');
            return res.status(500).json({ code: 'INTERNAL', error: 'Не вдалося виконати дію. Спробуйте пізніше.' });
        }
    };
}
