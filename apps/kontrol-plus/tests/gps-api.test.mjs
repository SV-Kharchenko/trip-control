import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGpsHandler, createLimiter, suggestMapping, publicIntegration } from '../lib/gps/api.js';
import { createSupabaseStore } from '../lib/gps/store.js';
import { GpsError } from '../lib/gps/errors.js';

const TOKEN = 'FAKEgpsToken00000000000000000000000000000000000000000000000000000a1b2';
const OWNER = { id: 'u-owner' };
const ORG = 'org-1';

// Сховище в пам'яті з тим самим інтерфейсом, що createSupabaseStore. vault — окремо, як Supabase Vault.
function memoryStore(overrides = {}, clock = { t: Date.now() }) {
    const s = {
        users: { 'jwt-owner': OWNER, 'jwt-logist': { id: 'u-logist' }, 'jwt-company': { id: 'u-company' }, 'jwt-disabled': { id: 'u-disabled' },
            'jwt-blocked-org': { id: 'u-blocked-org' }, 'jwt-banned': { id: 'u-banned', banned_until: '2999-01-01T00:00:00Z' }, 'jwt-director': { id: 'u-director' } },
        profiles: {
            'u-owner': { org_id: ORG, org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-banned': { org_id: ORG, org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-logist': { org_id: ORG, org_role: 'logist', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-company': { org_id: 'org-2', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-disabled': { org_id: ORG, org_role: 'owner', member_status: 'disabled', org_status: 'active', org_plan: 'control_plus' },
            'u-blocked-org': { org_id: ORG, org_role: 'owner', member_status: 'active', org_status: 'blocked', org_plan: 'control_plus' },
            // Директор Контроль+ — власник своєї (company) організації: керувати GPS чужої org не може.
            'u-director': { org_id: 'org-3', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
        },
        integrations: [],
        units: [],
        fleet: [{ id: 'v1', label: 'AA1111AA' }, { id: 'v2', label: 'BB2222BB' }, { id: 'v3', label: 'CC3333CC' }],
        vault: new Map(),
        calls: [],
    };
    let n = 0;
    const store = {
        async getUser(jwt) { return s.users[jwt] || null; },
        async getProfile(id) { return s.profiles[id] || null; },
        async getIntegration(org, provider) { return s.integrations.find((i) => i.org_id === org && i.provider === provider) || null; },
        async insertIntegration(row) {
            const created = { id: 'int-' + (++n), token_secret_id: null, token_hint: null, consecutive_failures: 0, ...row };
            s.integrations.push(created);
            return { ...created };
        },
        async updateIntegration(id, patch) {
            const row = s.integrations.find((i) => i.id === id);
            Object.assign(row, patch);
            return { ...row };
        },
        // Як RPC gps_connect: одна транзакція — якщо Vault падає, рядок (хост, токен) лишається як був.
        async connect({ orgId, provider, hostKind, apiHost, account, unitsTotal, token, userId }) {
            if (s.vaultDown) throw new Error('vault down');
            let row = s.integrations.find((i) => i.org_id === orgId && i.provider === provider);
            if (!row) {
                row = { id: 'int-' + (++n), org_id: orgId, provider, created_by: userId, status: 'pending', consecutive_failures: 0, token_secret_id: null, token_hint: null };
                s.integrations.push(row);
            }
            row.token_secret_id = 'secret-' + row.id;
            row.token_hint = '…' + token.slice(-4);
            s.vault.set(row.token_secret_id, token);
            const at = new Date(clock.t).toISOString();
            Object.assign(row, { host_kind: hostKind, api_host: apiHost, status: 'active', provider_account: account, units_total: unitsTotal,
                last_checked_at: at, last_ok_at: at, last_error_code: null, last_error_at: null, consecutive_failures: 0 });
            return { ...row };
        },
        async storeToken(id, token) {
            s.calls.push('storeToken');
            const row = s.integrations.find((i) => i.id === id);
            row.token_secret_id = 'secret-' + id;
            row.token_hint = '…' + token.slice(-4);
            s.vault.set(row.token_secret_id, token);
            return row.token_hint;
        },
        async readToken(id) {
            const row = s.integrations.find((i) => i.id === id);
            return row && row.token_secret_id ? s.vault.get(row.token_secret_id) || null : null;
        },
        async deleteToken(id) {
            const row = s.integrations.find((i) => i.id === id);
            s.vault.delete(row.token_secret_id);
            row.token_secret_id = null;
            row.token_hint = null;
            return true;
        },
        async listUnits(integrationId) {
            return s.units.filter((u) => u.integration_id === integrationId).map((u) => ({ ...u }));
        },
        async upsertUnits(rows) {
            for (const row of rows) {
                const found = s.units.find((u) => u.integration_id === row.integration_id && u.external_id === row.external_id);
                if (found) Object.assign(found, row);
                else s.units.push({ id: 'unit-' + row.external_id, vehicle_id: null, ...row });
            }
        },
        async deactivateUnits(integrationId, ids) {
            for (const u of s.units) if (u.integration_id === integrationId && ids.includes(u.id)) u.active = false;
        },
        async fleetVehicles() { return s.fleet; },
        ...overrides,
    };
    return { store, s };
}

function providerOf(script = {}) {
    const calls = [];
    const provider = {
        async validateCredentials(creds) {
            calls.push({ fn: 'validate', creds });
            if (script.validate instanceof Error) throw script.validate;
            return script.validate || { ok: true, account: 'fleet_viewer', unitsTotal: 3 };
        },
        async listUnits(creds) {
            calls.push({ fn: 'list', creds });
            if (script.list instanceof Error) throw script.list;
            return script.list || [{ externalId: '101', name: ' aa1111aa ' }, { externalId: '102', name: 'BB2222BB' }, { externalId: '103', name: 'Тягач' }];
        },
    };
    return { getProvider: (id) => { assert.equal(id, 'wialon'); return provider; }, calls };
}

function harness({ script, clock = { t: Date.parse('2026-10-24T09:00:00Z') }, store: storeOverrides } = {}) {
    const { store, s } = memoryStore(storeOverrides, clock);
    const p = providerOf(script);
    const logs = [];
    const log = { error: (...a) => logs.push(a.join(' ')), log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
    const now = () => new Date(clock.t);
    const handler = createGpsHandler({ store, getProvider: p.getProvider, now, limiter: createLimiter({ now: () => clock.t }), log });
    const call = async (route, { method = 'POST', jwt = 'jwt-owner', body = {} } = {}) => {
        const res = {
            statusCode: 0, headers: {}, body: undefined,
            setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
            status(code) { this.statusCode = code; return this; },
            json(value) { this.body = value; return this; },
        };
        await handler({ method, query: { route }, url: '/api/gps/' + route, headers: jwt ? { authorization: 'Bearer ' + jwt } : {}, body }, res);
        return res;
    };
    return { call, s, p, logs, clock };
}

test('method, route and auth: 405, 404, 401, 403 (with Ukrainian text), no-store everywhere', async () => {
    const h = harness();
    const r405 = await h.call('connect', { method: 'GET' });
    assert.equal(r405.statusCode, 405);
    assert.equal(r405.headers['cache-control'], 'no-store');
    assert.equal((await h.call('poll')).statusCode, 404);
    const r401 = await h.call('connect', { jwt: null });
    assert.equal(r401.statusCode, 401);
    assert.equal(r401.headers['cache-control'], 'no-store');
    assert.equal((await h.call('connect', { jwt: 'jwt-unknown-xxxxxxxxxxxx' })).statusCode, 401);
    for (const [jwt, code] of [['jwt-logist', 'OWNER_ONLY'], ['jwt-company', 'CONTROL_PLUS_REQUIRED'], ['jwt-disabled', 'MEMBER_DISABLED'],
        ['jwt-blocked-org', 'ORG_BLOCKED'], ['jwt-banned', 'USER_BLOCKED'], ['jwt-director', 'CONTROL_PLUS_REQUIRED']]) {
        for (const route of ['connect', 'test', 'sync-units', 'disconnect']) {
            const res = await h.call(route, { jwt, body: { region: 'com', token: TOKEN } });
            assert.equal(res.statusCode, 403, jwt + ' ' + route);
            assert.equal(res.body.code, code);
            assert.match(res.body.error, /[А-Яа-яІіЇїЄєҐґ]/);
        }
    }
    assert.equal(h.p.calls.length, 0, 'provider never called for refused users');
});

test('connect: input validation without echoing the value; hosting only from the allowlist', async () => {
    const h = harness();
    const bad = [
        [{ region: 'com', token: 'short' }, 'BAD_TOKEN_FORMAT'],
        [{ region: 'com', token: 'x'.repeat(129) }, 'BAD_TOKEN_FORMAT'],
        [{ region: 'com', token: TOKEN.slice(0, 40) + '<script>' }, 'BAD_TOKEN_FORMAT'],
        [{ region: 'com', token: [TOKEN] }, 'BAD_TOKEN_FORMAT'],
        [{ region: 'mars', token: TOKEN }, 'BAD_REGION'],
        [{ region: 'local', token: TOKEN }, 'BAD_REGION'],
        [{ region: { host: 'evil.io' }, token: TOKEN }, 'BAD_REGION'],
        [{ token: TOKEN }, 'BAD_INPUT'],
        [{ region: 'com', localUrl: 'https://gps.fleet.com', token: TOKEN }, 'BAD_INPUT'],
        [{ localUrl: 'https://127.0.0.1', token: TOKEN }, 'UNSAFE_HOST'],
        [{ localUrl: 'https://169.254.169.254', token: TOKEN }, 'UNSAFE_HOST'],
        [{ localUrl: 'http://gps.fleet.com', token: TOKEN }, 'UNSAFE_HOST'],
        [{ localUrl: 'https://user:pass@gps.fleet.com', token: TOKEN }, 'UNSAFE_HOST'],
    ];
    for (const [body, code] of bad) {
        const res = await h.call('connect', { body });
        assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
        assert.equal(res.body.code, code);
        const text = JSON.stringify(res.body);
        assert.equal(text.includes(TOKEN) || text.includes('<script>') || text.includes('evil.io') || text.includes('pass'), false, 'no echo');
    }
    assert.equal(h.p.calls.length, 0);
    assert.equal(h.s.integrations.length, 0);
    await h.call('connect', { body: { region: 'eu', token: TOKEN, apiHost: 'evil.io', hostKind: 'local' } });
    assert.deepEqual([h.p.calls[0].creds.apiHost, h.p.calls[0].creds.hostKind], ['hst-api.wialon.eu', 'hosting'], 'apiHost from the body is ignored');
});

test('connect (hosting): token goes to the vault only, response has the mask', async () => {
    const h = harness();
    const res = await h.call('connect', { body: { region: 'com', token: TOKEN } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
        ok: true, status: 'active', host_kind: 'hosting', api_host: 'hst-api.wialon.com', provider_account: 'fleet_viewer', units_total: 3,
        token_hint: '…a1b2', last_checked_at: '2026-10-24T09:00:00.000Z', last_ok_at: '2026-10-24T09:00:00.000Z', last_error_code: null,
    });
    const row = h.s.integrations[0];
    assert.equal(row.org_id, ORG);
    assert.equal(row.created_by, OWNER.id);
    assert.equal(h.s.vault.get(row.token_secret_id), TOKEN);
});

test('connect (local): normalized host is stored and re-checked', async () => {
    const h = harness();
    const res = await h.call('connect', { body: { localUrl: 'https://GPS.fleet-co.com.ua:8443/wialon?x=1', token: TOKEN } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.host_kind, res.body.api_host], ['local', 'gps.fleet-co.com.ua:8443']);
    assert.deepEqual(h.p.calls[0].creds, { apiHost: 'gps.fleet-co.com.ua:8443', hostKind: 'local', token: TOKEN });
});

test('connect: failed check stores no token, only a trace (pending row); Wialon codes become Ukrainian messages', async () => {
    for (const [code, status] of [['invalid_token', 422], ['access_denied', 422], ['network', 502], ['rate_limited', 502], ['tls', 502], ['unsafe_host', 400]]) {
        const h = harness({ script: { validate: { ok: false, code } } });
        const res = await h.call('connect', { body: { region: 'com', token: TOKEN } });
        assert.equal(res.statusCode, status, code);
        assert.equal(res.body.code, code.toUpperCase());
        assert.match(res.body.error, /[А-Яа-яІіЇїЄєҐґ]/);
        assert.equal(h.s.integrations.length, 1);
        const row = h.s.integrations[0];
        assert.deepEqual([row.status, row.token_secret_id, row.token_hint, row.last_error_code, row.last_checked_at],
            ['pending', null, null, code, '2026-10-24T09:00:00.000Z'], 'minimal trace without a token');
        assert.equal(h.s.vault.size, 0);
        assert.equal(h.s.calls.includes('storeToken'), false);
        assert.equal(JSON.stringify(h.s.integrations).includes(TOKEN), false);
    }
});

test('connect: a failed new token does not touch an active connection (host, status, token) — only last_checked_at / error', async () => {
    const h = harness();
    await h.call('connect', { body: { region: 'com', token: TOKEN } });
    const before = { ...h.s.integrations[0] };
    h.p.getProvider('wialon').validateCredentials = async () => ({ ok: false, code: 'invalid_token' });
    h.clock.t += 11000;
    const other = TOKEN.replace('a1b2', 'beef');
    const res = await h.call('connect', { body: { localUrl: 'https://gps.other.com', token: other } });
    assert.equal(res.statusCode, 422);
    const after = h.s.integrations[0];
    assert.deepEqual([after.status, after.api_host, after.host_kind, after.token_hint, after.token_secret_id],
        [before.status, before.api_host, before.host_kind, before.token_hint, before.token_secret_id]);
    assert.equal(h.s.vault.get(after.token_secret_id), TOKEN, 'the old token stays');
    assert.deepEqual([after.last_checked_at, after.last_error_code], ['2026-10-24T09:00:11.000Z', 'invalid_token']);
});

test('connect is atomic: if the vault fails, host and token of the existing connection stay as they were', async () => {
    const h = harness();
    await h.call('connect', { body: { region: 'com', token: TOKEN } });
    const before = { ...h.s.integrations[0] };
    h.s.vaultDown = true;
    h.clock.t += 11000;
    const res = await h.call('connect', { body: { localUrl: 'https://gps.new-server.com:8443', token: TOKEN.replace('a1b2', 'c0de') } });
    assert.deepEqual([res.statusCode, res.body.code], [500, 'TOKEN_STORE']);
    const after = h.s.integrations[0];
    assert.deepEqual([after.api_host, after.host_kind, after.token_hint, after.status], [before.api_host, before.host_kind, before.token_hint, 'active']);
    assert.equal(h.s.vault.get(after.token_secret_id), TOKEN, 'the old token is never paired with the new host');
});

test('rate limit survives a new function instance (kept in the DB via last_checked_at), also for sync-units', async () => {
    const shared = memoryStore({}, { t: Date.parse('2026-10-24T09:00:00Z') });
    const instance = (t) => {
        const clock = { t };
        const p = providerOf({ validate: { ok: false, code: 'invalid_token' } });
        const handler = createGpsHandler({ store: shared.store, getProvider: p.getProvider, now: () => new Date(clock.t),
            limiter: createLimiter({ now: () => clock.t }), log: { error() {} } });
        return async (route, body) => {
            const res = { headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
            await handler({ method: 'POST', query: { route }, headers: { authorization: 'Bearer jwt-owner' }, body }, res);
            return res.statusCode;
        };
    };
    const t0 = Date.parse('2026-10-24T09:00:00Z');
    assert.equal(await instance(t0)('connect', { region: 'com', token: TOKEN }), 422);
    assert.equal(await instance(t0 + 4000)('connect', { region: 'com', token: TOKEN }), 429, 'another instance, empty memory — still limited');
    assert.equal(await instance(t0 + 10000)('connect', { region: 'com', token: TOKEN }), 422);

    const h = harness();
    await h.call('connect', { body: { region: 'com', token: TOKEN } });
    assert.equal((await h.call('sync-units')).statusCode, 429, 'sync-units right after connect');
    h.clock.t += 10000;
    assert.equal((await h.call('sync-units')).statusCode, 200);
    h.clock.t += 2000;
    assert.equal((await h.call('sync-units')).statusCode, 429, 'two syncs within 10 s');
});

test('rate limit: one connect / test per 10 s per org', async () => {
    const h = harness({ script: { validate: { ok: false, code: 'invalid_token' } } });
    assert.equal((await h.call('connect', { body: { region: 'com', token: TOKEN } })).statusCode, 422);
    const limited = await h.call('connect', { body: { region: 'com', token: TOKEN } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    h.clock.t += 10000;
    assert.equal((await h.call('connect', { body: { region: 'com', token: TOKEN } })).statusCode, 422);
    assert.equal(h.p.calls.length, 2);

    const ok = harness();
    await ok.call('connect', { body: { region: 'com', token: TOKEN } });
    ok.clock.t += 3000;
    assert.equal((await ok.call('test')).statusCode, 429, 'test right after connect');
    ok.clock.t += 8000;
    assert.equal((await ok.call('test')).statusCode, 200);
});

test('test: ok / error_auth / error with failures counter; token read from the vault', async () => {
    const h = harness();
    await h.call('connect', { body: { region: 'com', token: TOKEN } });
    h.clock.t += 11000;
    const ok = await h.call('test');
    assert.equal(ok.body.ok, true);
    assert.equal(h.p.calls[1].creds.token, TOKEN);

    const auth = harness({ script: {} });
    await auth.call('connect', { body: { region: 'com', token: TOKEN } });
    auth.p.getProvider('wialon').validateCredentials = async () => ({ ok: false, code: 'invalid_token' });
    auth.clock.t += 11000;
    const failed = await auth.call('test');
    assert.equal(failed.statusCode, 200);
    assert.deepEqual([failed.body.ok, failed.body.status, failed.body.last_error_code], [false, 'error_auth', 'invalid_token']);
    assert.match(failed.body.message, /Токен Wialon недійсний/);

    const net = harness();
    await net.call('connect', { body: { region: 'com', token: TOKEN } });
    net.p.getProvider('wialon').validateCredentials = async () => ({ ok: false, code: 'network' });
    for (let i = 0; i < 2; i++) {
        net.clock.t += 11000;
        await net.call('test');
    }
    assert.deepEqual([net.s.integrations[0].status, net.s.integrations[0].consecutive_failures], ['error', 2]);

    const none = harness();
    assert.equal((await none.call('test')).statusCode, 404);
});

test('sync-units: upsert, deactivate missing units, keep mappings, suggest by plate (lower(trim)) — only free vehicles', async () => {
    const h = harness();
    await h.call('connect', { body: { region: 'com', token: TOKEN } });
    h.clock.t += 11000;
    h.s.units.push({ id: 'unit-099', integration_id: h.s.integrations[0].id, external_id: '099', name: 'Старий', vehicle_id: 'v3', active: true });
    h.s.units.push({ id: 'unit-102', integration_id: h.s.integrations[0].id, external_id: '102', name: 'BB2222BB', vehicle_id: 'v1', active: true });
    const res = await h.call('sync-units');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.counts, { total: 3, added: 2, updated: 1, deactivated: 1 });
    const byExt = Object.fromEntries(res.body.units.map((u) => [u.external_id, u]));
    assert.equal(byExt['099'].active, false);
    assert.equal(byExt['099'].vehicle_id, 'v3', 'mapping of a unit gone from Wialon is kept');
    assert.equal(byExt['102'].vehicle_id, 'v1', 'existing mapping untouched');
    assert.equal(byExt['101'].suggested_vehicle_id, null, 'v1 (AA1111AA) is taken by unit 102 → no suggestion');
    assert.equal(byExt['103'].suggested_vehicle_id, null);
    assert.equal(h.s.integrations[0].units_total, 3);
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);

    const failing = harness();
    await failing.call('connect', { body: { region: 'com', token: TOKEN } });
    failing.clock.t += 11000;
    failing.p.getProvider('wialon').listUnits = async () => { throw new GpsError('access_denied'); };
    const denied = await failing.call('sync-units');
    assert.deepEqual([denied.body.ok, denied.body.status], [false, 'error_auth']);
});

test('suggestMapping', () => {
    const units = [
        { id: 'a', name: ' aa1111aa ', active: true, vehicle_id: null },
        { id: 'b', name: 'AA1111AA', active: true, vehicle_id: null },
        { id: 'c', name: 'BB2222BB', active: true, vehicle_id: null },
        { id: 'd', name: 'CC3333CC', active: false, vehicle_id: null },
        { id: 'e', name: 'DD', active: true, vehicle_id: 'v4' },
    ];
    const fleet = [{ id: 'v1', label: 'AA1111AA' }, { id: 'v2', label: 'bb2222bb ' }, { id: 'v3', label: 'CC3333CC' }, { id: 'v4', label: 'DD' }];
    assert.deepEqual([...suggestMapping(units, fleet)], [['a', 'v1'], ['c', 'v2']]);
});

test('disconnect: secret removed from the vault, status disabled, mask cleared', async () => {
    const h = harness();
    await h.call('connect', { body: { region: 'com', token: TOKEN } });
    const res = await h.call('disconnect');
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.status, res.body.token_hint], ['disabled', null]);
    assert.equal(h.s.vault.size, 0);
    assert.equal(h.s.integrations[0].token_secret_id, null);
    assert.equal((await h.call('test')).statusCode, 404, 'disabled → not connected');
});

test('the token is nowhere: responses, integration columns, logs, error messages', async () => {
    const seen = [];
    const original = {};
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
        original[k] = console[k];
        console[k] = (...a) => seen.push(a.map(String).join(' '));
    }
    try {
        const h = harness();
        const responses = [];
        responses.push(await h.call('connect', { body: { region: 'com', token: TOKEN } }));
        h.clock.t += 11000;
        responses.push(await h.call('test'));
        h.clock.t += 11000;
        responses.push(await h.call('sync-units'));
        h.clock.t += 11000;
        responses.push(await h.call('connect', { body: { localUrl: 'https://gps.fleet.com:8443', token: TOKEN.replace('a1b2', 'ffff') } }));
        responses.push(await h.call('disconnect'));
        // Внутрішня помилка сховища — загальна відповідь без деталей.
        const broken = harness({ store: { connect: async () => { throw new Error('vault failed for ' + TOKEN); } } });
        responses.push(await broken.call('connect', { body: { region: 'com', token: TOKEN } }));
        const crash = harness({ store: { getIntegration: async () => { throw new Error('db down ' + TOKEN); } } });
        responses.push(await crash.call('connect', { body: { region: 'com', token: TOKEN } }));
        assert.deepEqual(responses.map((r) => r.statusCode), [200, 200, 200, 200, 200, 500, 500]);
        const everything = JSON.stringify(responses.map((r) => r.body)) + JSON.stringify(h.s.integrations) + JSON.stringify(broken.s.integrations)
            + seen.join('\n') + h.logs.join('\n') + broken.logs.join('\n') + crash.logs.join('\n');
        for (const t of [TOKEN, TOKEN.replace('a1b2', 'ffff'), 'FAKEgpsToken']) assert.equal(everything.includes(t), false, 'token leaked');
        assert.equal(broken.s.integrations.length, 0, 'nothing written when the vault fails');
        assert.match(crash.logs.join(), /\[gps\] connect: internal error/);
    } finally {
        Object.assign(console, original);
    }
});

test('publicIntegration never exposes token_secret_id', () => {
    const out = publicIntegration({ id: 'x', token_secret_id: 'secret', token_hint: '…a1b2', status: 'active' });
    assert.equal('token_secret_id' in out, false);
    assert.equal('id' in out, false);
});

test('supabase store: token only via RPC, mapping column never written by sync', async () => {
    const ops = [];
    const builder = (table) => {
        const op = { table, chain: [] };
        ops.push(op);
        const api = new Proxy({}, {
            get(_, key) {
                if (key === 'then') return (resolve) => resolve({ data: op.table === 'gps_vehicles' && op.chain[0][0] === 'select' ? [] : { id: 'x' }, error: null });
                return (...args) => { op.chain.push([key, ...args]); return api; };
            },
        });
        return api;
    };
    const rpcs = [];
    const store = createSupabaseStore({
        from: builder,
        rpc: async (name, args) => { rpcs.push([name, args]); return { data: name === 'gps_store_token' ? '…a1b2' : TOKEN, error: null }; },
        auth: { getUser: async () => ({ data: { user: { id: 'u' } }, error: null }) },
    });
    assert.equal(await store.storeToken('int-1', TOKEN), '…a1b2');
    assert.deepEqual(rpcs[0], ['gps_store_token', { p_integration: 'int-1', p_token: TOKEN }]);
    await store.readToken('int-1');
    await store.deleteToken('int-1');
    assert.deepEqual(rpcs.map((r) => r[0]), ['gps_store_token', 'gps_read_token', 'gps_delete_token']);
    await store.connect({ orgId: 'o', provider: 'wialon', hostKind: 'hosting', apiHost: 'hst-api.wialon.com', account: 'a', unitsTotal: 1, token: TOKEN, userId: 'u' });
    assert.deepEqual(rpcs.at(-1), ['gps_connect', { p_org: 'o', p_provider: 'wialon', p_host_kind: 'hosting', p_api_host: 'hst-api.wialon.com',
        p_account: 'a', p_units: 1, p_token: TOKEN, p_user: 'u' }], 'connect is one RPC (one transaction)');
    await store.upsertUnits([{ org_id: 'o', integration_id: 'i', external_id: '1', name: 'n', active: true, last_seen_at: 'now' }]);
    const upsert = ops.at(-1).chain.find((c) => c[0] === 'upsert');
    assert.deepEqual(upsert[2], { onConflict: 'integration_id,external_id' });
    assert.equal('vehicle_id' in upsert[1][0], false);
    await store.getIntegration('o', 'wialon');
    for (const op of ops) assert.equal(JSON.stringify(op.chain).includes(TOKEN), false, 'no token in table writes');
    const failing = createSupabaseStore({ rpc: async () => ({ data: null, error: { message: 'boom ' + TOKEN } }) });
    await assert.rejects(failing.storeToken('i', TOKEN), (e) => !String(e.message).includes(TOKEN));
});

test('Vercel functions: static files share one handler; 405 / 401 before env; 503 without env; no secrets', async () => {
    for (const route of ['connect', 'test', 'sync-units', 'disconnect']) {
        assert.match(fs.readFileSync(new URL('../api/gps/' + route + '.js', import.meta.url), 'utf8'), new RegExp("gpsVercelRoute\\('" + route + "'\\)"));
    }
    const source = fs.readFileSync(new URL('../lib/gps/vercel.js', import.meta.url), 'utf8');
    assert.match(source, /process\.env\.SUPABASE_URL/);
    assert.match(source, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
        const { default: route } = await import('../api/gps/connect.js');
        const resOf = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
        const noJwt = resOf();
        await route({ method: 'POST', url: '/api/gps/connect', headers: {}, body: { region: 'com', token: TOKEN } }, noJwt);
        assert.deepEqual([noJwt.statusCode, noJwt.body.code, noJwt.headers['Cache-Control']], [401, 'AUTH_REQUIRED', 'no-store'], 'no JWT → 401 even without env');
        const get = resOf();
        await route({ method: 'GET', url: '/api/gps/connect', headers: {} }, get);
        assert.equal(get.statusCode, 405);
        const res = resOf();
        await route({ method: 'POST', url: '/api/gps/connect', headers: { authorization: 'Bearer x.y.z' }, body: { region: 'com', token: TOKEN } }, res);
        assert.equal(res.statusCode, 503);
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
    } finally {
        if (saved.url) process.env.SUPABASE_URL = saved.url;
        if (saved.key) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
});
