import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, PROVIDER_IDS } from '../lib/gps/index.js';
import { WIALON_ERRORS } from '../lib/gps/providers/wialon.js';
import { GpsError } from '../lib/gps/errors.js';

const TOKEN = 'FAKEwialonToken0000000000000000000000000000000000000000000000000000cafe';
const HOSTING = { apiHost: 'hst-api.wialon.com', hostKind: 'hosting', token: TOKEN };

// Підміна транспорту: відповіді за svc, без мережі. Кожен виклик зберігається (хост, порт, шлях, розібране тіло).
function transportOf(replies) {
    const calls = [];
    const transport = async (req) => {
        const form = new URLSearchParams(req.body);
        const call = { host: req.host, port: req.port, path: req.path, svc: form.get('svc'), params: JSON.parse(form.get('params')), sid: form.get('sid'), raw: req.body };
        calls.push(call);
        const reply = replies[call.svc];
        const value = typeof reply === 'function' ? reply(call) : reply;
        if (value instanceof Error) throw value;
        if (value && value.status) return value;
        return { status: 200, text: JSON.stringify(value === undefined ? {} : value) };
    };
    return { transport, calls };
}

const LOGIN = { eid: 'sid-1', au: 'fleet_viewer', user: { nm: 'fleet_viewer' } };
const UNITS = { totalItemsCount: 3, items: [{ id: 101, nm: 'AA1111AA' }, { id: 102, nm: 'BB2222BB' }, { id: 103, nm: 'Тягач' }] };

test('registry: wialon only', () => {
    assert.deepEqual(PROVIDER_IDS, ['wialon']);
    assert.throws(() => getProvider('traccar'), /Unknown GPS provider/);
    assert.throws(() => getProvider('__proto__'), /Unknown GPS provider/);
});

test('validateCredentials: token/login → core/search_items → core/logout; token only in the POST body', async () => {
    const { transport, calls } = transportOf({ 'token/login': LOGIN, 'core/search_items': UNITS, 'core/logout': { error: 0 } });
    const out = await getProvider('wialon', { transport }).validateCredentials(HOSTING);
    assert.deepEqual(out, { ok: true, account: 'fleet_viewer', unitsTotal: 3 });
    assert.deepEqual(calls.map((c) => c.svc), ['token/login', 'core/search_items', 'core/logout']);
    assert.deepEqual(calls[0].params, { token: TOKEN, fl: 1 });
    assert.equal(calls[0].sid, null);
    assert.deepEqual(calls[1].params, {
        spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' }, force: 1, flags: 1, from: 0, to: 0,
    });
    assert.equal(calls[1].sid, 'sid-1');
    assert.equal(calls[2].sid, 'sid-1');
    for (const c of calls) {
        assert.equal(c.host, 'hst-api.wialon.com');
        assert.equal(c.port, 443);
        assert.equal(c.path, '/wialon/ajax.html', 'no query string');
        assert.equal(c.host.includes(TOKEN) || c.path.includes(TOKEN), false);
    }
    assert.equal(calls.filter((c) => c.raw.includes(TOKEN)).length, 1, 'the token is sent once, in the login body');
});

test('validateCredentials: Wialon Local host and port from the stored api_host', async () => {
    const { transport, calls } = transportOf({ 'token/login': LOGIN, 'core/search_items': UNITS, 'core/logout': {} });
    const out = await getProvider('wialon', { transport }).validateCredentials({ apiHost: 'gps.fleet-co.com.ua:8443', hostKind: 'local', token: TOKEN });
    assert.equal(out.ok, true);
    assert.deepEqual([calls[0].host, calls[0].port], ['gps.fleet-co.com.ua', 8443]);
    const unsafe = await getProvider('wialon', { transport }).validateCredentials({ apiHost: '169.254.169.254', hostKind: 'local', token: TOKEN });
    assert.deepEqual(unsafe, { ok: false, code: 'unsafe_host' });
    assert.equal(calls.length, 3, 'nothing sent for an unsafe stored host');
});

test('error codes with HTTP 200 are mapped; no retry of a failed login', async () => {
    const expected = { 1: 'invalid_session', 1011: 'invalid_session', 4: 'bad_params', 7: 'access_denied', 8: 'invalid_token',
        9: 'auth_unavailable', 10: 'rate_limited', 1003: 'rate_limited', '-100': 'network', '-101': 'network', 5: 'provider_error', 6: 'provider_error' };
    for (const [code, mapped] of Object.entries(expected)) {
        const { transport, calls } = transportOf({ 'token/login': { error: Number(code), reason: 'secret details ' + TOKEN } });
        const out = await getProvider('wialon', { transport }).validateCredentials(HOSTING);
        assert.deepEqual(out, { ok: false, code: mapped }, code);
        assert.equal(calls.length, 1, 'login is not retried and there is no session to log out');
        assert.equal(JSON.stringify(out).includes('secret'), false);
    }
    assert.equal(WIALON_ERRORS[8], 'invalid_token');
});

test('core/logout runs even when a call after login fails', async () => {
    const { transport, calls } = transportOf({ 'token/login': LOGIN, 'core/search_items': { error: 7 }, 'core/logout': { error: 1 } });
    const out = await getProvider('wialon', { transport }).validateCredentials(HOSTING);
    assert.deepEqual(out, { ok: false, code: 'access_denied' });
    assert.deepEqual(calls.map((c) => c.svc), ['token/login', 'core/search_items', 'core/logout']);
    const net = transportOf({ 'token/login': LOGIN, 'core/search_items': new GpsError('network', 'timeout'), 'core/logout': {} });
    await assert.rejects(getProvider('wialon', { transport: net.transport }).listUnits(HOSTING), (e) => e.code === 'network');
    assert.equal(net.calls.at(-1).svc, 'core/logout');
});

test('HTTP errors, timeouts and broken JSON', async () => {
    const cases = [
        [{ status: 500, text: 'boom' }, 'network'],
        [{ status: 429, text: '' }, 'rate_limited'],
        [{ status: 200, text: '<html>' }, 'provider_error'],
        [new GpsError('network', 'timeout'), 'network'],
        [new GpsError('tls', 'tls'), 'tls'],
        [{ status: 200, text: JSON.stringify({ au: 'x' }) }, 'provider_error'],
    ];
    for (const [reply, code] of cases) {
        const { transport } = transportOf({ 'token/login': reply });
        assert.deepEqual(await getProvider('wialon', { transport }).validateCredentials(HOSTING), { ok: false, code });
    }
    const { transport } = transportOf({});
    assert.deepEqual(await getProvider('wialon', { transport }).validateCredentials({ ...HOSTING, token: '' }), { ok: false, code: 'invalid_token' });
});

test('listUnits: id and name of every unit', async () => {
    const { transport } = transportOf({ 'token/login': LOGIN, 'core/search_items': UNITS, 'core/logout': {} });
    assert.deepEqual(await getProvider('wialon', { transport }).listUnits(HOSTING), [
        { externalId: '101', name: 'AA1111AA' }, { externalId: '102', name: 'BB2222BB' }, { externalId: '103', name: 'Тягач' },
    ]);
});

test('fetchPositions: flags 4194305, pos=null and private points (no x / y) skipped, filter by ids', async () => {
    const t = 1761300000;
    const { transport, calls } = transportOf({
        'token/login': LOGIN,
        'core/search_items': { items: [
            { id: 101, nm: 'A', pos: { t, y: 50.45, x: 30.52, z: 180, s: 72, c: 90, sc: 11 } },
            { id: 102, nm: 'B', pos: null },
            { id: 103, nm: 'C', pos: { t, s: 0, c: 0, sc: 0 } },
            { id: 104, nm: 'D', pos: { t, y: 48.1, x: 24.2, s: 10, c: 5, sc: 7 } },
            { id: 105, nm: 'E', pos: { t, y: 120, x: 30 } },
        ] },
        'core/logout': {},
    });
    const provider = getProvider('wialon', { transport });
    const all = await provider.fetchPositions(HOSTING);
    assert.equal(calls[1].params.flags, 4194305);
    assert.deepEqual(all, [
        { externalId: '101', t: new Date(t * 1000).toISOString(), lat: 50.45, lon: 30.52, speed: 72, course: 90, sats: 11, altitude: 180 },
        { externalId: '104', t: new Date(t * 1000).toISOString(), lat: 48.1, lon: 24.2, speed: 10, course: 5, sats: 7, altitude: null },
    ]);
    assert.deepEqual((await provider.fetchPositions(HOSTING, ['104'])).map((p) => p.externalId), ['104']);
});
