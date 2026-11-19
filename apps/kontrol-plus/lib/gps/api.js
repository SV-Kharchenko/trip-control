// POST /api/gps/{connect|test|sync-units|disconnect} — керування підключенням GPS (лише owner організації на
// control_plus). POST /api/gps/positions — карта (етап 2c): будь-який учасник організації на control_plus.
// Залежності підмінні (store, провайдер, час), тож логіка тестується без мережі й без БД.
// Токен Wialon: перевіряється, передається в Vault (gps_store_token) і далі ніде не зʼявляється — ні у відповідях,
// ні в логах, ні в повідомленнях помилок. Тіла запитів не логуємо.
import { getProvider as defaultGetProvider, PROVIDER_IDS } from './index.js';
import { guessKind, isKind } from './kind.js';
import { GpsError, gpsMessage, AUTH_CODES } from './errors.js';
import { hostingHost, normalizeLocalUrl, parseApiHost } from './safe-host.js';
import { readMap } from './map.js';

export const GPS_ROUTES = ['connect', 'test', 'sync-units', 'disconnect', 'positions'];
const TOKEN_RE = /^[0-9A-Za-z]{32,128}$/;
const RATE_WINDOW_MS = 10000;
const PROVIDER = 'wialon';
// Агроконтроль (лише каркас): токен 8–512 друкованих ASCII-символів без пробілів; формат справжнього токена невідомий.
const AGRO_TOKEN_RE = /^[!-~]{8,512}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SELECTION_IDS = 300;
export const KIND_FILTERS = ['truck', 'tractor', 'special', 'van', 'other', 'none'];
// Карта: не частіше одного звернення до Wialon на хвилину на організацію; дані старші за хвилину — застарілі.
export const MAP_LOCK_MS = 60000;
const MAP_STALE_MS = 60000;
// 'error' (мережа / тимчасова помилка) теж оновлюємо, інакше один збій назавжди зупинив би карту до ручної
// «Перевірити підключення». 'error_auth' — ні: недійсний токен не перевіряємо автоматично (ліміт невдалих логінів Wialon).
const MAP_REFRESH_STATUSES = new Set(['active', 'error']);

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
        // Скільки мс до наступного дозволеного hit (0 — можна).
        remaining(key) {
            const at = last.get(key);
            return at === undefined ? 0 : Math.max(0, windowMs - (now() - at));
        },
    };
}

// Статус підключення для карти: 'not_connected' — немає підключення з токеном (або відключено).
export function mapIntegrationStatus(row) {
    if (!row || !row.token_secret_id || row.status === 'disabled') return 'not_connected';
    return row.status;
}

const smallint = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null
    : Math.max(-32768, Math.min(32767, Math.round(Number(v)))));

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

// Провайдер із тіла запиту: без поля — wialon (сумісність із попередніми версіями інтерфейсу).
function providerOf(body) {
    const raw = body.provider;
    if (raw === undefined || raw === null || raw === '') return PROVIDER;
    if (typeof raw !== 'string' || !PROVIDER_IDS.includes(raw)) throw new HttpError(400, 'BAD_PROVIDER', 'Невідомий провайдер GPS.');
    return raw;
}

function idList(value, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new HttpError(400, 'BAD_INPUT', field + ': очікується масив.');
    if (value.length > MAX_SELECTION_IDS) throw new HttpError(400, 'BAD_INPUT', field + ': забагато елементів (максимум ' + MAX_SELECTION_IDS + ').');
    const out = new Set();
    for (const id of value) {
        if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpError(400, 'BAD_INPUT', field + ': некоректний ідентифікатор.');
        out.add(id.toLowerCase());
    }
    return [...out];
}

// Вибір карти: all | group_ids[] і/або unit_ids[]; kinds[] — додатковий фільтр за типом ('none' — тип невизначено).
export function parseSelection(body) {
    const kinds = body.kinds === undefined || body.kinds === null ? [] : body.kinds;
    if (!Array.isArray(kinds) || kinds.length > KIND_FILTERS.length || kinds.some((k) => !KIND_FILTERS.includes(k))) {
        throw new HttpError(400, 'BAD_INPUT', 'kinds: некоректний тип.');
    }
    const sel = { all: body.all === true, groupIds: idList(body.group_ids, 'group_ids'), unitIds: idList(body.unit_ids, 'unit_ids'), kinds: [...new Set(kinds)] };
    sel.active = sel.all || sel.groupIds.length > 0 || sel.unitIds.length > 0 || sel.kinds.length > 0;
    sel.mode = sel.all ? 'all' : (sel.groupIds.length || sel.unitIds.length ? 'custom' : (sel.kinds.length ? 'kinds' : 'linked'));
    return sel;
}

const providerStatus = (code) => (code === 'unsafe_host' ? 400 : AUTH_CODES.has(code) ? 422 : 502);

export function createGpsHandler({ store, getProvider = defaultGetProvider, providerDeps, now = () => new Date(),
    limiter = createLimiter(), mapLimiter, log = console } = {}) {
    const provider = (id = PROVIDER) => getProvider(id, providerDeps);
    // Перший бар'єр карти — у памʼяті інстансу; другий, міжінстансний — лок у БД (store.claimRefresh).
    const mapGate = mapLimiter || createLimiter({ windowMs: MAP_LOCK_MS, now: () => now().getTime() });

    // Спільне для всіх маршрутів: JWT → користувач (не заблокований) → профіль.
    async function authenticate(req) {
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) throw new HttpError(401, 'AUTH_REQUIRED', 'Потрібно увійти.');
        const user = await store.getUser(header.slice(7));
        if (!user) throw new HttpError(401, 'BAD_TOKEN', 'Сесія завершилась — увійдіть ще раз.');
        if (user.banned_until && new Date(user.banned_until).getTime() > now().getTime()) {
            throw new HttpError(403, 'USER_BLOCKED', 'Акаунт заблоковано.');
        }
        return { user, profile: await store.getProfile(user.id) };
    }

    // Карта: будь-який учасник організації на control_plus (owner, logist, інші ролі) або її директор
    // (org_directors, як kp_org_id()). Усі бачать усі авто своєї організації.
    async function authorizeMember(req) {
        const { user, profile } = await authenticate(req);
        if (profile && profile.org_id && profile.org_plan === 'control_plus') {
            if (profile.org_status === 'blocked') throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
            if (profile.member_status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
            return { user, orgId: profile.org_id, role: profile.org_role || null };
        }
        const directorOf = await store.directorOrg(user.id);
        if (directorOf) return { user, orgId: directorOf, role: 'director' };
        if (!profile || !profile.org_id) throw new HttpError(403, 'NO_PROFILE', 'Профіль користувача не знайдено.');
        if (profile.member_status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
        if (profile.org_status === 'blocked') throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
        throw new HttpError(403, 'CONTROL_PLUS_REQUIRED', 'GPS доступний у тарифі Контроль+.');
    }

    async function authorize(req) {
        const { user, profile } = await authenticate(req);
        if (!profile || !profile.org_id) throw new HttpError(403, 'NO_PROFILE', 'Профіль користувача не знайдено.');
        if (profile.member_status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
        if (profile.org_status === 'blocked') throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
        if (profile.org_plan !== 'control_plus') throw new HttpError(403, 'CONTROL_PLUS_REQUIRED', 'GPS доступний у тарифі Контроль+.');
        if (profile.org_role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Підключенням GPS керує директор компанії.');
        return { user, orgId: profile.org_id };
    }

    function limit(orgId, integration) {
        const recent = integration && integration.last_checked_at
            && now().getTime() - new Date(integration.last_checked_at).getTime() < RATE_WINDOW_MS;
        if (recent || !limiter.hit(orgId)) {
            throw new HttpError(429, 'RATE_LIMITED', 'Зачекайте 10 секунд перед наступним запитом до Wialon.');
        }
    }

    async function connected(orgId, providerId = PROVIDER) {
        const integration = await store.getIntegration(orgId, providerId);
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
        // Агроконтроль без інтеграції: підключення лишається «очікує», це не збій і не лічильник невдач.
        if (code === 'not_configured') {
            return store.updateIntegration(integration.id, { status: 'pending', last_checked_at: at, last_error_code: code, last_error_at: at });
        }
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

    // Агроконтроль: лише зберігаємо доступ (токен — у Vault). Нікуди не звертаємось; статус лишається «очікує».
    async function connectAgro(auth, body) {
        if (typeof body.token !== 'string' || !AGRO_TOKEN_RE.test(body.token)) {
            throw new HttpError(400, 'BAD_TOKEN_FORMAT', 'Токен має містити 8–512 символів без пробілів.');
        }
        const existing = await store.getIntegration(auth.orgId, 'agrocontrol');
        limit(auth.orgId, existing);
        let integration;
        try {
            integration = await store.connect({
                orgId: auth.orgId, provider: 'agrocontrol', hostKind: 'hosting', apiHost: 'not-configured', account: null,
                unitsTotal: null, token: body.token, userId: auth.user.id,
            });
        } catch {
            throw new HttpError(500, 'TOKEN_STORE', 'Не вдалося безпечно зберегти токен. Спробуйте ще раз.');
        }
        const at = now().toISOString();
        const row = await store.updateIntegration(integration.id, {
            status: 'pending', last_checked_at: at, last_ok_at: null, last_error_code: 'not_configured', last_error_at: at,
        });
        return { status: 200, body: { ok: true, code: 'not_configured', message: gpsMessage('not_configured'), ...publicIntegration(row) } };
    }

    async function connect(auth, body) {
        if (providerOf(body) === 'agrocontrol') return connectAgro(auth, body);
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
            await recordFailedConnect(auth, existing, { hostKind, apiHost, code: result.code });
            throw new HttpError(providerStatus(result.code), result.code.toUpperCase(), gpsMessage(result.code));
        }
        // Одна транзакція в БД (RPC gps_connect): поля підключення й секрет у Vault разом. Якщо збереження секрету
        // впаде, не змінюється нічого — ні api_host / host_kind, ні старий токен.
        let integration;
        try {
            integration = await store.connect({
                orgId: auth.orgId, provider: PROVIDER, hostKind, apiHost, account: result.account,
                unitsTotal: result.unitsTotal, token: body.token, userId: auth.user.id,
            });
        } catch {
            throw new HttpError(500, 'TOKEN_STORE', 'Не вдалося безпечно зберегти токен. Спробуйте ще раз.');
        }
        return { status: 200, body: { ok: true, ...publicIntegration(integration) } };
    }

    // Невдалий connect: токен не зберігаємо; хост, статус і токен наявного підключення не чіпаємо. Лишаємо в БД лише
    // час спроби (last_checked_at) і код помилки — так ліміт 10 с діє між інстансами функції. Для організації без
    // підключення — мінімальний слід: рядок 'pending' без токена (інтерфейс показує для нього форму підключення).
    async function recordFailedConnect(auth, existing, { hostKind, apiHost, code }) {
        const at = now().toISOString();
        const trace = { last_checked_at: at, last_error_code: code, last_error_at: at };
        try {
            if (existing) await store.updateIntegration(existing.id, trace);
            else {
                await store.insertIntegration({
                    org_id: auth.orgId, provider: PROVIDER, created_by: auth.user.id, host_kind: hostKind, api_host: apiHost,
                    status: 'pending', ...trace,
                });
            }
        } catch {
            // Слід не записався — лишається ліміт у памʼяті інстансу; відповідь клієнту та сама.
        }
    }

    async function test(auth, body) {
        const providerId = providerOf(body);
        const integration = await connected(auth.orgId, providerId);
        limit(auth.orgId, integration);
        let result;
        try {
            if (providerId === PROVIDER) parseApiHost(integration.api_host, integration.host_kind);
            result = await provider(providerId).validateCredentials(await credsOf(integration));
        } catch (error) {
            if (!(error instanceof GpsError)) throw error;
            result = { ok: false, code: error.code };
        }
        if (!result.ok) {
            const row = await markFailure(integration, result.code);
            return { status: 200, body: { ok: false, ...(result.code === 'not_configured' ? { code: result.code } : {}), message: gpsMessage(result.code), ...publicIntegration(row) } };
        }
        const row = await markOk(integration, { provider_account: result.account, units_total: result.unitsTotal });
        return { status: 200, body: { ok: true, ...publicIntegration(row) } };
    }

    // Юніти + групи + вгаданий тип. Тип (kind) пишемо лише юнітам без kind_manual: ручні йдуть окремим upsert БЕЗ колонки kind,
    // тож PostgREST їх не чіпає (а тригер gps_vehicles_kind_guard у БД — друга лінія захисту). Ручні групи sync не бачить взагалі:
    // gps_sync_groups працює лише з source = 'wialon'. Помилка читання / збереження груп не ховається: groups.error у відповіді.
    async function syncUnits(auth, body) {
        const providerId = providerOf(body);
        const integration = await connected(auth.orgId, providerId);
        limit(auth.orgId, integration);
        let listed;
        try {
            const api = provider(providerId);
            const creds = await credsOf(integration);
            listed = typeof api.listUnitsWithGroups === 'function'
                ? await api.listUnitsWithGroups(creds)
                : { units: await api.listUnits(creds), groups: null, groupsError: null };
        } catch (error) {
            if (!(error instanceof GpsError)) throw error;
            const row = await markFailure(integration, error.code);
            return { status: 200, body: { ok: false, ...(error.code === 'not_configured' ? { code: error.code } : {}), message: gpsMessage(error.code), ...publicIntegration(row) } };
        }
        const units = listed.units;
        const at = now().toISOString();
        const existing = await store.listUnits(integration.id);
        const incoming = new Map(units.map((u) => [u.externalId, u]));
        const known = new Set(existing.map((u) => u.external_id));
        const manualKind = new Set(existing.filter((u) => u.kind_manual).map((u) => u.external_id));
        const added = units.filter((u) => !known.has(u.externalId)).length;
        const gone = existing.filter((u) => u.active && !incoming.has(u.external_id));
        const base = (u) => ({ org_id: auth.orgId, integration_id: integration.id, external_id: u.externalId, name: u.name, active: true, last_seen_at: at });
        const auto = units.filter((u) => !manualKind.has(u.externalId)).map((u) => ({ ...base(u), kind: guessKind(u.name) }));
        const manual = units.filter((u) => manualKind.has(u.externalId)).map(base);
        if (auto.length) await store.upsertUnits(auto);
        if (manual.length) await store.upsertUnits(manual);
        // Юніти, яких більше нема в провайдері, — неактивні; мапінг, ручний тип і ручні групи не чіпаємо.
        if (gone.length) await store.deactivateUnits(integration.id, gone.map((u) => u.id));
        const groups = { synced: false, total: null, removed: null, members: null, error: listed.groupsError || null };
        if (Array.isArray(listed.groups)) {
            try {
                const out = await store.syncGroups(integration.id, listed.groups.map((g) => ({ external_id: g.externalId, name: g.name, units: g.unitIds })));
                Object.assign(groups, { synced: true, total: out.groups_total ?? null, removed: out.groups_removed ?? null, members: out.members_total ?? null });
            } catch {
                groups.error = 'groups_store';
            }
        }
        if (groups.error) groups.message = gpsMessage(groups.error);
        await markOk(integration, { units_total: units.length });
        const rows = await store.listUnits(integration.id);
        const suggestions = suggestMapping(rows, await store.fleetVehicles(auth.orgId));
        return {
            status: 200,
            body: {
                ok: true,
                counts: { total: units.length, added, updated: units.length - added, deactivated: gone.length },
                groups,
                units: rows.map((u) => ({
                    id: u.id,
                    external_id: u.external_id,
                    name: u.name,
                    active: u.active,
                    vehicle_id: u.vehicle_id ?? null,
                    kind: u.kind ?? null,
                    kind_manual: u.kind_manual === true,
                    suggested_vehicle_id: suggestions.get(u.id) || null,
                })),
            },
        };
    }

    async function disconnect(auth, body) {
        const integration = await store.getIntegration(auth.orgId, providerOf(body));
        if (!integration) throw new HttpError(404, 'NOT_CONNECTED', 'GPS ще не підключено.');
        await store.deleteToken(integration.id);
        const row = await store.updateIntegration(integration.id, { status: 'disabled', token_secret_id: null, token_hint: null });
        return { status: 200, body: { ok: true, ...publicIntegration(row) } };
    }

    // Нові точки → gps_positions (без дублів) і last_* юніта, лише якщо точка новіша за збережену.
    async function savePoints(orgId, units, points, seenIso) {
        const byExt = new Map(units.map((u) => [String(u.external_id), u]));
        const rows = [];
        const latest = new Map();
        for (const p of points || []) {
            const unit = byExt.get(String(p.externalId));
            if (!unit || !Number.isFinite(Date.parse(p.t))) continue;
            const row = {
                org_id: orgId,
                gps_vehicle_id: unit.id,
                recorded_at: new Date(p.t).toISOString(),
                lat: p.lat,
                lon: p.lon,
                speed: smallint(p.speed),
                course: smallint(p.course),
                sats: smallint(p.sats),
                altitude: p.altitude === null || p.altitude === undefined || !Number.isFinite(Number(p.altitude)) ? null : Number(p.altitude),
            };
            rows.push(row);
            const prev = latest.get(unit.id);
            if (!prev || prev.recorded_at < row.recorded_at) latest.set(unit.id, row);
        }
        await store.insertPositions(rows);
        const updates = [];
        for (const unit of units) {
            const row = latest.get(unit.id);
            if (!row) continue;
            if (unit.last_pos_at && Date.parse(row.recorded_at) <= Date.parse(unit.last_pos_at)) continue;
            updates.push({ id: unit.id, last_pos_at: row.recorded_at, last_lat: row.lat, last_lon: row.lon,
                last_speed: row.speed, last_course: row.course, last_seen_at: seenIso });
        }
        if (updates.length) await store.updateLastPositions(orgId, updates);
    }

    function isStale(integration, units, t) {
        const okAt = Date.parse(integration.last_ok_at || '');
        const lastPos = Math.max(...units.map((u) => Date.parse(u.last_pos_at || '')).filter(Number.isFinite), -Infinity);
        return !Number.isFinite(okAt) || t.getTime() - okAt > MAP_STALE_MS || !Number.isFinite(lastPos) || t.getTime() - lastPos > MAP_STALE_MS;
    }

    // Карта: віддаємо рядки з бази; перед цим — оновлення з Wialon, якщо дані застарілі або просять refresh,
    // і лише під локом (не частіше разу на хвилину на організацію). Лок зайнятий — це не помилка: кеш + next_refresh_at.
    async function positions(auth, body) {
        const selection = parseSelection(body);
        const t = now();
        const nowIso = t.toISOString();
        const refresh = body.refresh === true;
        const integration = await store.getIntegration(auth.orgId, PROVIDER);
        const lockedUntil = integration && Date.parse(integration.lock_until || '') > t.getTime() ? integration.lock_until : null;
        let nextRefreshAt = lockedUntil;
        let refreshed = false;
        let refreshError = null;
        let refreshErrorCode = null;
        let rateLimited = false;
        let current = integration;
        if (integration && integration.token_secret_id && MAP_REFRESH_STATUSES.has(integration.status)) {
            const units = selection.active ? await store.selectedUnits(auth.orgId, selection) : await store.mappedUnits(auth.orgId);
            if (units.length && (refresh || isStale(integration, units, t))) {
                const until = new Date(t.getTime() + MAP_LOCK_MS).toISOString();
                // gps_integrations.lock_until у 2c належить ЛИШЕ ліміту оновлення карти. Збирач 2b має отримати
                // власне поле локу (окрема міграція в 2b) і не перевикористовувати це.
                const claimed = mapGate.hit(auth.orgId) && await store.claimRefresh(integration.id, auth.orgId, nowIso, until);
                if (!claimed) {
                    rateLimited = refresh;
                    const memoryWait = mapGate.remaining(auth.orgId);
                    nextRefreshAt = lockedUntil || new Date(t.getTime() + (memoryWait || MAP_LOCK_MS)).toISOString();
                } else {
                    nextRefreshAt = until;
                    try {
                        const creds = await credsOf(integration);
                        // Wialon віддає позиції всіх юнітів одним search_items, тож під спільним локом організації зберігаємо точки й last_*
                        // для ВСІХ активних юнітів (незалежно від привʼязки й вибору): інший користувач з іншим вибором за хвилину не побачить
                        // застарілих даних. Відповідь карти фільтрується за вибором нижче. Бюджет часу 8 с — усередині провайдера.
                        const everyone = await store.selectedUnits(auth.orgId, { all: true, groupIds: [], unitIds: [], kinds: [] });
                        const points = await provider().fetchPositions(creds, everyone.map((u) => String(u.external_id)));
                        await savePoints(auth.orgId, everyone, points, nowIso);
                        current = await markOk(integration, {});
                        refreshed = true;
                    } catch (error) {
                        if (error instanceof GpsError) {
                            current = await markFailure(integration, error.code);
                            refreshError = gpsMessage(error.code);
                            refreshErrorCode = error.code;
                        } else if (error instanceof HttpError) {
                            refreshError = error.publicMessage;
                        } else throw error;
                    }
                }
            }
        }
        const vehicles = await readMap(store, auth.orgId, t, selection.active ? selection : null);
        // Стан синхронізації для екрана: статус, час останнього успіху / спроби, код останньої помилки (текст — окремо).
        const out = {
            integration_status: mapIntegrationStatus(current),
            refreshed,
            next_refresh_at: nextRefreshAt,
            sync: {
                last_ok_at: current ? current.last_ok_at ?? null : null,
                last_checked_at: current ? current.last_checked_at ?? null : null,
                last_error_code: current ? current.last_error_code ?? null : null,
            },
            selection: { mode: selection.mode, total: vehicles.length },
            vehicles,
        };
        if (refreshError) {
            out.refresh_error = refreshError;
            out.refresh_error_code = refreshErrorCode;
        }
        if (rateLimited) {
            const seconds = Math.max(1, Math.ceil((Date.parse(nextRefreshAt) - t.getTime()) / 1000));
            return { status: 429, body: { code: 'RATE_LIMITED', error: 'Оновлення доступне через ' + seconds + ' с.', ...out } };
        }
        return { status: 200, body: out };
    }

    const HANDLERS = { connect, test, 'sync-units': syncUnits, disconnect, positions };

    // route — з імені статичного файлу api/gps/<route>.js (lib/gps/vercel.js); без нього — з URL.
    return async function gpsHandler(req, res, forcedRoute) {
        res.setHeader('Cache-Control', 'no-store');
        const route = forcedRoute || routeOf(req);
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
        }
        if (!GPS_ROUTES.includes(route)) return res.status(404).json({ code: 'NOT_FOUND', error: 'Невідома дія.' });
        try {
            const auth = route === 'positions' ? await authorizeMember(req) : await authorize(req);
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
