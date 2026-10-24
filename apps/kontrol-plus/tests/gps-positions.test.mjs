import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGpsHandler, createLimiter, MAP_LOCK_MS, mapIntegrationStatus } from '../lib/gps/api.js';
import { GpsError } from '../lib/gps/errors.js';

const TOKEN = 'FAKEmapToken000000000000000000000000000000000000000000000000000000d00d';
const T0 = Date.parse('2026-10-24T09:00:00Z');

// Сховище в памʼяті з тим самим інтерфейсом, що createSupabaseStore (методи 2a + карти 2c).
function memoryStore({ integration = {}, units, orders } = {}) {
    const s = {
        users: { 'jwt-owner': { id: 'u-owner' }, 'jwt-logist': { id: 'u-logist' }, 'jwt-other-logist': { id: 'u-logist2' }, 'jwt-director': { id: 'u-dir' },
            'jwt-company': { id: 'u-company' }, 'jwt-banned': { id: 'u-banned', banned_until: '2999-01-01T00:00:00Z' }, 'jwt-disabled': { id: 'u-disabled' },
            'jwt-blocked-org': { id: 'u-blocked-org' }, 'jwt-other-org': { id: 'u-b' } },
        profiles: {
            'u-owner': { org_id: 'A', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-logist': { org_id: 'A', org_role: 'logist', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-logist2': { org_id: 'A', org_role: 'logist', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-dir': { org_id: 'D', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-company': { org_id: 'C', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-banned': { org_id: 'A', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-disabled': { org_id: 'A', org_role: 'logist', member_status: 'disabled', org_status: 'active', org_plan: 'control_plus' },
            'u-blocked-org': { org_id: 'A', org_role: 'owner', member_status: 'active', org_status: 'blocked', org_plan: 'control_plus' },
            'u-b': { org_id: 'B', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
        },
        directors: { 'u-dir': 'A' },
        integrations: [
            { id: 'int-A', org_id: 'A', provider: 'wialon', host_kind: 'hosting', api_host: 'hst-api.wialon.com', token_secret_id: 'sec-A', token_hint: '…d00d',
                status: 'active', provider_account: 'viewer', last_ok_at: null, lock_until: null, consecutive_failures: 0, ...integration },
            { id: 'int-B', org_id: 'B', provider: 'wialon', host_kind: 'hosting', api_host: 'hst-api.wialon.eu', token_secret_id: 'sec-B', token_hint: '…bbbb',
                status: 'active', last_ok_at: null, lock_until: null, consecutive_failures: 0 },
        ],
        vault: new Map([['sec-A', TOKEN], ['sec-B', TOKEN.replace('d00d', 'bbbb')]]),
        units: units || [
            { id: 'g1', org_id: 'A', name: 'Unit 1', vehicle_id: 'v1', external_id: '101', active: true, last_pos_at: null },
            { id: 'g2', org_id: 'A', name: 'Unit 2', vehicle_id: 'v2', external_id: '102', active: true, last_pos_at: null },
            { id: 'g3', org_id: 'A', name: 'Unmapped', vehicle_id: null, external_id: '103', active: true },
            { id: 'g4', org_id: 'A', name: 'Gone', vehicle_id: 'v4', external_id: '104', active: false },
            { id: 'gb', org_id: 'B', name: 'B unit', vehicle_id: 'vb', external_id: '201', active: true, last_pos_at: null },
        ],
        fleet: [{ id: 'v1', org_id: 'A', label: 'AA1111AA' }, { id: 'v2', org_id: 'A', label: 'BB2222BB' }, { id: 'v4', org_id: 'A', label: 'DD' },
            { id: 'vb', org_id: 'B', label: 'B-CAR' }],
        orders: orders || [
            { org_id: 'A', vehicle_id: 'v1', calculation_id: 'calc-other-logist', author: 'u-logist2', status: 'accepted', trip_date: '2026-10-23', trip_days: 2,
                route_from: 'Київ', route_to: 'Одеса', client_name: 'Агро' },
            { org_id: 'B', vehicle_id: 'v1', calculation_id: 'calc-foreign', status: 'accepted', trip_date: '2026-10-24', trip_days: 1, route_from: 'X', route_to: 'Y' },
        ],
        positions: [],
        claims: 0,
    };
    const store = {
        async getUser(jwt) { return s.users[jwt] || null; },
        async getProfile(id) { return s.profiles[id] || null; },
        async directorOrg(id) { return s.directors[id] || null; },
        async getIntegration(org) { const r = s.integrations.find((i) => i.org_id === org); return r ? { ...r } : null; },
        async updateIntegration(id, patch) { const r = s.integrations.find((i) => i.id === id); Object.assign(r, patch); return { ...r }; },
        async readToken(id) { const r = s.integrations.find((i) => i.id === id); return r && s.vault.get(r.token_secret_id); },
        // Атомарно, як UPDATE … WHERE lock_until IS NULL OR lock_until < now(): перевірка й запис без await між ними.
        async claimRefresh(id, org, nowIso, untilIso) {
            const r = s.integrations.find((i) => i.id === id && i.org_id === org);
            if (!r || (r.lock_until && r.lock_until >= nowIso)) return false;
            r.lock_until = untilIso;
            s.claims += 1;
            return true;
        },
        async mappedUnits(org) { return s.units.filter((u) => u.org_id === org && u.active && u.vehicle_id).map((u) => ({ ...u })); },
        async insertPositions(rows) {
            for (const row of rows) {
                if (!s.positions.some((p) => p.gps_vehicle_id === row.gps_vehicle_id && p.recorded_at === row.recorded_at)) s.positions.push(row);
            }
        },
        async updateLastPositions(org, updates) {
            for (const u of updates) {
                const unit = s.units.find((x) => x.id === u.id && x.org_id === org);
                if (unit && (!unit.last_pos_at || unit.last_pos_at < u.last_pos_at)) Object.assign(unit, u);
            }
        },
        async fleetVehicles(org) { return s.fleet.filter((v) => v.org_id === org); },
        async currentOrders(org, ids) { return s.orders.filter((x) => x.org_id === org && ids.includes(x.vehicle_id)).map(({ org_id, author, ...rest }) => rest); },
    };
    return { s, store };
}

function harness({ store: storeOpts, points, fail, clock = { t: T0 }, shared } = {}) {
    const m = shared || memoryStore(storeOpts);
    const calls = [];
    const provider = {
        async fetchPositions(creds, ids) {
            calls.push({ creds, ids });
            await new Promise((r) => setImmediate(r));
            if (fail) throw fail;
            return typeof points === 'function' ? points(ids) : (points || [
                { externalId: '101', t: '2026-10-24T08:59:00.000Z', lat: 50.45, lon: 30.52, speed: 71.6, course: 90, sats: 11, altitude: 180 },
                { externalId: '102', t: '2026-10-24T08:20:00.000Z', lat: 46.48, lon: 30.72, speed: 0, course: 0, sats: 9, altitude: null },
            ]);
        },
    };
    const logs = [];
    const log = { error: (...a) => logs.push(a.join(' ')) };
    const now = () => new Date(clock.t);
    const handler = createGpsHandler({ store: m.store, getProvider: () => provider, now, log,
        limiter: createLimiter({ now: () => clock.t }), mapLimiter: createLimiter({ windowMs: MAP_LOCK_MS, now: () => clock.t }) });
    const call = async ({ jwt = 'jwt-owner', body = {}, method = 'POST' } = {}) => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ method, url: '/api/gps/positions', headers: jwt ? { authorization: 'Bearer ' + jwt } : {}, body }, res, 'positions');
        return res;
    };
    return { call, calls, s: m.s, m, clock, logs };
}

test('auth: 401 without / with a bad JWT, 403 company plan / banned / disabled / blocked org, 405 not POST', async () => {
    const h = harness();
    assert.deepEqual([(await h.call({ jwt: null })).statusCode, (await h.call({ jwt: null })).body.code], [401, 'AUTH_REQUIRED']);
    const bad = await h.call({ jwt: 'jwt-unknown' });
    assert.deepEqual([bad.statusCode, bad.body.code], [401, 'BAD_TOKEN']);
    for (const [jwt, code] of [['jwt-company', 'CONTROL_PLUS_REQUIRED'], ['jwt-banned', 'USER_BLOCKED'], ['jwt-disabled', 'MEMBER_DISABLED'], ['jwt-blocked-org', 'ORG_BLOCKED']]) {
        const res = await h.call({ jwt });
        assert.deepEqual([res.statusCode, res.body.code], [403, code], jwt);
        assert.equal(res.headers['cache-control'], 'no-store');
    }
    assert.equal((await h.call({ method: 'GET' })).statusCode, 405);
    assert.equal(h.calls.length, 0);
});

test('200 for owner, logist and director (org_directors); everyone sees the full order of another logist', async () => {
    const h = harness();
    for (const jwt of ['jwt-owner', 'jwt-logist', 'jwt-director']) {
        h.clock.t += 61000;
        const res = await h.call({ jwt });
        assert.equal(res.statusCode, 200, jwt);
        const v1 = res.body.vehicles.find((v) => v.vehicle_id === 'v1');
        assert.deepEqual(v1.order, { calculation_id: 'calc-other-logist', trip_date: '2026-10-23', route_from: 'Київ', route_to: 'Одеса', client_name: 'Агро' }, jwt);
        assert.equal('hidden' in v1.order || 'hidden' in v1, false);
        assert.deepEqual(res.body.vehicles.map((v) => v.gps_vehicle_id).sort(), ['g1', 'g2'], 'only mapped active units of the own org');
        assert.equal(JSON.stringify(res.body).includes('calc-foreign'), false, 'another org never leaks');
    }
});

test('response has no api_host, token_hint, external_id, provider_account; token nowhere (incl. errors, 429, logs)', async () => {
    const seen = [];
    const original = {};
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
        original[k] = console[k];
        console[k] = (...a) => seen.push(a.map(String).join(' '));
    }
    try {
        const ok = harness();
        const bodies = [];
        bodies.push((await ok.call()).body);
        bodies.push((await ok.call({ body: { refresh: true } })).body); // 429
        for (const code of ['access_denied', 'invalid_token', 'rate_limited', 'network']) {
            bodies.push((await harness({ fail: new GpsError(code, 'reason with ' + TOKEN) }).call()).body);
        }
        const crash = harness({ fail: new Error('boom ' + TOKEN) });
        const crashed = await crash.call();
        bodies.push(crashed.body);
        assert.equal(crashed.statusCode, 500);
        const text = JSON.stringify(bodies) + seen.join('\n') + crash.logs.join('\n');
        for (const bad of [TOKEN, 'FAKEmapToken', 'api_host', 'token_hint', 'token_secret', 'external_id', 'provider_account', 'hst-api', 'reason with']) {
            assert.equal(text.includes(bad), false, bad);
        }
        assert.equal(ok.calls[0].creds.token, TOKEN, 'the token is used only for the provider call');
    } finally {
        Object.assign(console, original);
    }
});

test('lock free → one Wialon call for mapped active units only; points saved; last_* updated', async () => {
    const h = harness();
    const res = await h.call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.refreshed, true);
    assert.equal(res.body.integration_status, 'active');
    assert.equal(res.body.next_refresh_at, new Date(T0 + MAP_LOCK_MS).toISOString());
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].ids.sort(), ['101', '102'], 'no unmapped / inactive units');
    assert.equal(h.s.positions.length, 2);
    assert.equal(h.s.positions[0].speed, 72, 'smallint');
    const v1 = res.body.vehicles.find((v) => v.gps_vehicle_id === 'g1');
    assert.deepEqual([v1.lat, v1.lon, v1.speed, v1.last_pos_at, v1.no_signal], [50.45, 30.52, 72, '2026-10-24T08:59:00.000Z', false]);
    const v2 = res.body.vehicles.find((v) => v.gps_vehicle_id === 'g2');
    assert.equal(v2.no_signal, true, '40 min old → no signal');
    assert.equal(h.s.integrations[0].status, 'active');
    assert.ok(h.s.integrations[0].last_ok_at);
});

test('lock taken (another instance) → no Wialon call, cache, refreshed:false, next_refresh_at = lock_until; refresh:true → 429 with cache', async () => {
    const lock = new Date(T0 + 40000).toISOString();
    const h = harness({ store: { integration: { lock_until: lock } } });
    const res = await h.call();
    assert.deepEqual([res.statusCode, res.body.refreshed, res.body.next_refresh_at], [200, false, lock]);
    assert.equal(res.body.vehicles.length, 2, 'cache is returned');
    const forced = await h.call({ body: { refresh: true } });
    assert.equal(forced.statusCode, 429);
    assert.equal(forced.body.code, 'RATE_LIMITED');
    assert.match(forced.body.error, /Оновлення доступне через 40 с/);
    assert.equal(forced.body.vehicles.length, 2, '429 still carries the cache');
    assert.equal(forced.body.integration_status, 'active');
    assert.equal(h.calls.length, 0);
});

test('refresh:true right after a refresh (same instance) → 429; after 60 s → a new call', async () => {
    const h = harness();
    await h.call();
    h.clock.t += 20000;
    const again = await h.call({ body: { refresh: true } });
    assert.equal(again.statusCode, 429);
    assert.match(again.body.error, /через 40 с/);
    h.clock.t += 40001;
    assert.equal((await h.call({ body: { refresh: true } })).body.refreshed, true);
    assert.equal(h.calls.length, 2);
});

test('two parallel calls → one fetchPositions (same instance and two instances sharing the DB)', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.call(), h.call()]);
    assert.equal(h.calls.length, 1);
    assert.deepEqual([a.body.refreshed, b.body.refreshed].sort(), [false, true]);
    const shared = memoryStore();
    const one = harness({ shared });
    const two = harness({ shared });
    await Promise.all([one.call(), two.call()]);
    assert.equal(one.calls.length + two.calls.length, 1, 'the DB lock is the cross-instance barrier');
    assert.equal(shared.s.claims, 1);
});

test('fresh data (last_ok_at and positions < 60 s) → no Wialon call on open', async () => {
    const h = harness({
        store: {
            integration: { last_ok_at: new Date(T0 - 20000).toISOString() },
            units: [{ id: 'g1', org_id: 'A', name: 'U', vehicle_id: 'v1', external_id: '101', active: true, last_pos_at: new Date(T0 - 30000).toISOString(), last_lat: 50, last_lon: 30 }],
        },
    });
    const res = await h.call();
    assert.deepEqual([res.body.refreshed, h.calls.length], [false, 0]);
});

test('no duplicate points; an older point never rolls back last_*', async () => {
    let round = 0;
    const h = harness({
        points: () => (++round === 1
            ? [{ externalId: '101', t: '2026-10-24T08:59:00.000Z', lat: 50, lon: 30, speed: 10 }]
            : [{ externalId: '101', t: '2026-10-24T08:59:00.000Z', lat: 50, lon: 30, speed: 10 },
                { externalId: '101', t: '2026-10-24T08:10:00.000Z', lat: 10, lon: 10, speed: 99 }]),
    });
    await h.call();
    h.clock.t += 61000;
    await h.call({ body: { refresh: true } });
    assert.equal(h.calls.length, 2);
    assert.equal(h.s.positions.filter((p) => p.gps_vehicle_id === 'g1').length, 2, 'the repeated point is not duplicated');
    const g1 = h.s.units.find((u) => u.id === 'g1');
    assert.deepEqual([g1.last_pos_at, g1.last_lat, g1.last_speed], ['2026-10-24T08:59:00.000Z', 50, 10]);
});

test('Wialon errors → cache + refresh_error; integration status as in 2a; lock kept', async () => {
    for (const [code, status] of [['access_denied', 'error_auth'], ['invalid_token', 'error_auth'], ['rate_limited', 'error'], ['network', 'error']]) {
        const h = harness({ fail: new GpsError(code) });
        const res = await h.call();
        assert.equal(res.statusCode, 200, code);
        assert.equal(res.body.refreshed, false);
        assert.match(res.body.refresh_error, /[А-Яа-яІіЇїЄєҐґ]/);
        assert.equal(res.body.integration_status, status, code);
        assert.equal(res.body.vehicles.length, 2, 'cache');
        assert.equal(h.s.integrations[0].status, status);
        assert.equal(h.s.integrations[0].lock_until, new Date(T0 + MAP_LOCK_MS).toISOString(), 'lock not released');
        assert.equal(h.s.integrations[0].consecutive_failures, 1);
    }
});

test('error_auth / disabled / not connected → no Wialon call, cache + status', async () => {
    for (const [integration, expected] of [[{ status: 'error_auth' }, 'error_auth'], [{ status: 'disabled' }, 'not_connected'],
        [{ token_secret_id: null, status: 'pending' }, 'not_connected']]) {
        const h = harness({ store: { integration } });
        const res = await h.call({ body: { refresh: true } });
        assert.deepEqual([res.statusCode, res.body.integration_status, res.body.refreshed, h.calls.length], [200, expected, false, 0]);
    }
    assert.equal(mapIntegrationStatus(null), 'not_connected');
    // Тимчасова помилка ('error') не зупиняє карту назавжди: наступне оновлення пробує знову.
    const transient = harness({ store: { integration: { status: 'error' } } });
    assert.equal((await transient.call()).body.refreshed, true);
});
