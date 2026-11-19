// Контроль+ GPS: групи, тип юніта, вибір карти, бюджет часу, каркас Агроконтролю.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGpsHandler, createLimiter, MAP_LOCK_MS, parseSelection } from '../lib/gps/api.js';
import { createSupabaseStore } from '../lib/gps/store.js';
import { guessKind, normalizeUnitName, KINDS } from '../lib/gps/kind.js';
import { createWialonProvider, POSITIONS_BUDGET_MS, CALL_CAP_MS } from '../lib/gps/providers/wialon.js';
import { createAgrocontrolProvider } from '../lib/gps/providers/agrocontrol.js';
import { getProvider } from '../lib/gps/index.js';
import { GpsError } from '../lib/gps/errors.js';
import { emptySelection, loadSelection, saveSelection, searchUnits, selectionBody, pruneSelection } from '../src/lib/gps-catalog.js';

const WIALON_TOKEN = 'FAKEwialonToken000000000000000000000000000000000000000000000000z9y8';
const AGRO_TOKEN = 'AGROsecret-token-DO-NOT-LEAK-0123456789';
const T0 = Date.parse('2026-11-19T09:00:00Z');
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const U = (n) => '00000000-0000-4000-8000-00000000000' + n;

// --------------------------------------------------------------------------------------------------------------------
// guessKind
// --------------------------------------------------------------------------------------------------------------------

test('guessKind: separators «_» and «..», Cyrillic and Latin, plates are ignored', () => {
    const cases = [
        ['AA1234BB_DAF XF', 'truck'],
        ['BC5678CE..John Deere 8R 370', 'tractor'],
        ['КА 1234 ВН MAN TGX', 'truck'],
        ['МАN TGS', 'truck'], // змішані кирилиця / латиниця
        ['AX9999XA_Mercedes Sprinter', 'van'],
        ['Тягач Scania R450', 'truck'],
        ['Самоскид КАМАЗ 6520', 'truck'],
        ['Volvo FH 460', 'truck'],
        ['Renault Magnum', 'truck'],
        ['Renault Master', 'van'],
        ['Iveco Daily', 'van'],
        ['ГАЗель Next', 'van'],
        ['МТЗ-82 Іваненко', 'tractor'],
        ['Т-150К', 'tractor'],
        ['Case IH Magnum 340', 'tractor'],
        ['Кейс 2388', 'tractor'],
        ['New Holland T7.270', 'tractor'],
        ['CLAAS Axion 850', 'tractor'],
        ['Fendt 936', 'tractor'],
        ['John_Deere_6R_145', 'tractor'],
        ['CLAAS LEXION 760', 'special'],
        ['John Deere S690', 'special'],
        ['Комбайн Нива', 'special'],
        ['Manitou MLT 735', 'special'],
        ['JCB 3CX', 'special'],
        ['Причіп Krone', 'other'],
        ['Toyota Camry', 'other'],
    ];
    for (const [name, kind] of cases) assert.equal(guessKind(name), kind, name);
});

test('guessKind: unknown names give null, never a wrong default; word boundaries hold', () => {
    for (const name of ['Unit 15', 'Roman_Ivanov', 'Ivan', '', null, undefined, 'AA1234BB', 'Іваненко І.І.']) assert.equal(guessKind(name), null, String(name));
    assert.equal(guessKind('Showcase 12'), null, '«case» only as a whole word');
    assert.ok(KINDS.every((k) => ['truck', 'tractor', 'special', 'van', 'other'].includes(k)));
    assert.equal(normalizeUnitName('AA1234BB_DAF..XF/Ivan-1'), 'aa1234bb daf xf ivan 1');
});

// --------------------------------------------------------------------------------------------------------------------
// Memory store + fake PostgREST (for createSupabaseStore.selectedUnits)
// --------------------------------------------------------------------------------------------------------------------

function fakeSupabase(tables) {
    return {
        from(name) {
            const filters = [];
            const b = {
                select() { return b; },
                eq(col, v) { filters.push((r) => r[col] === v); return b; },
                in(col, vs) { filters.push((r) => vs.includes(r[col])); return b; },
                not(col, op, v) { if (op === 'is' && v === null) filters.push((r) => r[col] !== null && r[col] !== undefined); return b; },
                limit() { return b; },
                then(res, rej) { return Promise.resolve({ data: (tables[name] || []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }).then(res, rej); },
            };
            return b;
        },
    };
}

function world() {
    const w = {
        integrations: [{ id: 'int-A', org_id: 'A', provider: 'wialon', host_kind: 'hosting', api_host: 'hst-api.wialon.com', token_secret_id: 'sec-A', token_hint: '…z9y8',
            status: 'active', last_ok_at: null, lock_until: null, consecutive_failures: 0 }],
        vault: new Map([['sec-A', WIALON_TOKEN]]),
        units: [
            { id: U(1), org_id: 'A', integration_id: 'int-A', name: 'AA1111AA_DAF', vehicle_id: 'v1', external_id: '101', active: true, last_pos_at: null, kind: 'truck', kind_manual: false },
            { id: U(2), org_id: 'A', integration_id: 'int-A', name: 'John Deere 8R', vehicle_id: null, external_id: '102', active: true, last_pos_at: null, kind: 'tractor', kind_manual: false },
            { id: U(3), org_id: 'A', integration_id: 'int-A', name: 'Неприв’язаний бус', vehicle_id: null, external_id: '103', active: true, last_pos_at: null, kind: null, kind_manual: false },
            { id: U(4), org_id: 'A', integration_id: 'int-A', name: 'Неактивний', vehicle_id: null, external_id: '104', active: false, last_pos_at: null, kind: null, kind_manual: false },
            { id: U(5), org_id: 'A', integration_id: 'int-A', name: 'Ручний тип', vehicle_id: null, external_id: '105', active: true, last_pos_at: null, kind: 'special', kind_manual: true },
            { id: U(9), org_id: 'B', integration_id: 'int-B', name: 'Чужий', vehicle_id: null, external_id: '901', active: true, last_pos_at: null, kind: 'truck', kind_manual: false },
        ],
        groups: [
            { id: G1, org_id: 'A', integration_id: 'int-A', source: 'wialon', external_id: 'g1', name: 'Тягачі' },
            { id: G2, org_id: 'A', integration_id: null, source: 'manual', external_id: null, name: 'Моя група' },
        ],
        members: [
            { group_id: G1, gps_vehicle_id: U(1), org_id: 'A' }, { group_id: G1, gps_vehicle_id: U(2), org_id: 'A' }, { group_id: G1, gps_vehicle_id: U(4), org_id: 'A' },
            { group_id: G2, gps_vehicle_id: U(3), org_id: 'A' },
        ],
        fleet: [{ id: 'v1', org_id: 'A', label: 'AA1111AA' }],
        orders: [{ org_id: 'A', vehicle_id: 'v1', calculation_id: 'c1', status: 'accepted', trip_date: '2026-11-19', trip_days: 1, route_from: 'Київ', route_to: 'Одеса', client_name: 'Агро' }],
        positions: [],
        calls: [],
        upserts: [],
        groupSyncs: [],
    };
    const sup = createSupabaseStore(fakeSupabase({ gps_vehicles: w.units, gps_group_members: w.members }));
    const store = {
        async getUser(jwt) { return { 'jwt-owner': { id: 'u-owner' }, 'jwt-logist': { id: 'u-logist' } }[jwt] || null; },
        async getProfile(id) {
            return { org_id: 'A', org_role: id === 'u-owner' ? 'owner' : 'logist', member_status: 'active', org_status: 'active', org_plan: 'control_plus' };
        },
        async directorOrg() { return null; },
        async getIntegration(org, provider) { const r = w.integrations.find((i) => i.org_id === org && i.provider === provider); return r ? { ...r } : null; },
        async updateIntegration(id, patch) { const r = w.integrations.find((i) => i.id === id); Object.assign(r, patch); return { ...r }; },
        async insertIntegration(row) { const r = { id: 'int-' + (w.integrations.length + 1), token_secret_id: null, token_hint: null, consecutive_failures: 0, ...row }; w.integrations.push(r); return { ...r }; },
        async connect({ orgId, provider, hostKind, apiHost, account, unitsTotal, token }) {
            let r = w.integrations.find((i) => i.org_id === orgId && i.provider === provider);
            if (!r) { r = { id: 'int-' + (w.integrations.length + 1), org_id: orgId, provider, consecutive_failures: 0 }; w.integrations.push(r); }
            r.token_secret_id = 'sec-' + r.id;
            r.token_hint = '…' + token.slice(-4);
            w.vault.set(r.token_secret_id, token);
            Object.assign(r, { host_kind: hostKind, api_host: apiHost, status: 'active', provider_account: account, units_total: unitsTotal, last_ok_at: new Date(T0).toISOString(), last_checked_at: new Date(T0).toISOString() });
            return { ...r };
        },
        async readToken(id) { const r = w.integrations.find((i) => i.id === id); return r && w.vault.get(r.token_secret_id); },
        async deleteToken() { return true; },
        async claimRefresh(id, org, nowIso, untilIso) {
            const r = w.integrations.find((i) => i.id === id && i.org_id === org);
            if (!r || (r.lock_until && r.lock_until >= nowIso)) return false;
            r.lock_until = untilIso;
            return true;
        },
        async listUnits(integrationId) { return w.units.filter((u) => u.integration_id === integrationId).map((u) => ({ ...u })); },
        // Як PostgREST upsert: пишуться лише колонки, які є в рядку (відсутня kind не чіпається).
        async upsertUnits(rows) {
            w.upserts.push(rows.map((r) => ({ ...r })));
            for (const row of rows) {
                const found = w.units.find((u) => u.integration_id === row.integration_id && u.external_id === row.external_id);
                if (found) Object.assign(found, row);
                else w.units.push({ id: 'new-' + row.external_id, vehicle_id: null, kind: null, kind_manual: false, last_pos_at: null, ...row });
            }
        },
        async deactivateUnits(integrationId, ids) { for (const u of w.units) if (u.integration_id === integrationId && ids.includes(u.id)) u.active = false; },
        // Як RPC gps_sync_groups: лише групи source = 'wialon' цього підключення.
        async syncGroups(integrationId, groups) {
            w.groupSyncs.push(JSON.parse(JSON.stringify(groups)));
            const ext = new Set(groups.map((g) => g.external_id));
            const before = w.groups.length;
            w.groups = w.groups.filter((g) => !(g.source === 'wialon' && g.integration_id === integrationId && !ext.has(g.external_id)));
            for (const g of groups) {
                let row = w.groups.find((x) => x.source === 'wialon' && x.integration_id === integrationId && x.external_id === g.external_id);
                if (!row) { row = { id: 'grp-' + g.external_id, org_id: 'A', integration_id: integrationId, source: 'wialon', external_id: g.external_id, name: g.name }; w.groups.push(row); }
                row.name = g.name;
                w.members = w.members.filter((m) => m.group_id !== row.id);
                for (const unitExt of g.units) {
                    const unit = w.units.find((u) => u.integration_id === integrationId && u.external_id === unitExt);
                    if (unit) w.members.push({ group_id: row.id, gps_vehicle_id: unit.id, org_id: 'A' });
                }
            }
            return { groups_total: w.groups.filter((g) => g.source === 'wialon').length, groups_removed: before - w.groups.length, members_total: w.members.length };
        },
        async fleetVehicles(org) { return w.fleet.filter((v) => v.org_id === org); },
        async mappedUnits(org) { return w.units.filter((u) => u.org_id === org && u.active && u.vehicle_id).map((u) => ({ ...u })); },
        async selectedUnits(org, selection) { return sup.selectedUnits(org, selection); },
        async insertPositions(rows) { w.positions.push(...rows); },
        async updateLastPositions(org, updates) { for (const u of updates) Object.assign(w.units.find((x) => x.id === u.id && x.org_id === org), u); },
        async currentOrders(org, ids) { return w.orders.filter((o) => o.org_id === org && ids.includes(o.vehicle_id)).map(({ org_id, ...rest }) => rest); },
    };
    return { w, store };
}

function harness({ provider = {}, clock = { t: T0 }, store: storeOverrides = {} } = {}) {
    const { w, store: base } = world();
    const store = { ...base, ...storeOverrides };
    const logs = [];
    const fetches = [];
    const api = {
        async fetchPositions(creds, ids, opts) {
            fetches.push({ ids: [...ids], opts, creds });
            return ids.map((id, i) => ({ externalId: id, t: '2026-11-19T08:59:00.000Z', lat: 50 + i / 10, lon: 30, speed: 40, course: 90, sats: 9, altitude: null }));
        },
        async listUnits() { return [{ externalId: '101', name: 'AA1111AA_DAF' }, { externalId: '102', name: 'John Deere 8R' }, { externalId: '105', name: 'Ручний тип МТЗ' },
            { externalId: '106', name: 'Тягач Scania R450' }]; },
        async listUnitsWithGroups() {
            return { units: await api.listUnits(), groups: [{ externalId: 'g1', name: 'Тягачі 2', unitIds: ['101', '106'] }], groupsError: null };
        },
        async validateCredentials() { return { ok: true, account: 'viewer', unitsTotal: 4 }; },
        ...provider,
    };
    const agro = createAgrocontrolProvider();
    const getProv = (id) => (id === 'agrocontrol' ? agro : api);
    const handler = createGpsHandler({ store, getProvider: getProv, now: () => new Date(clock.t), log: { error: (...a) => logs.push(a.join(' ')) },
        limiter: createLimiter({ now: () => clock.t }), mapLimiter: createLimiter({ windowMs: MAP_LOCK_MS, now: () => clock.t }) });
    const call = async (route, { jwt = 'jwt-owner', body = {} } = {}) => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ method: 'POST', url: '/api/gps/' + route, headers: { authorization: 'Bearer ' + jwt }, body }, res, route);
        return res;
    };
    return { call, w, fetches, logs, clock };
}

// --------------------------------------------------------------------------------------------------------------------
// positions: group_ids / unit_ids / all, independent of the link to the Fleet
// --------------------------------------------------------------------------------------------------------------------

test('positions: group_ids fetches the active members of the group, linked or not; inactive and foreign units never', async () => {
    const h = harness();
    const res = await h.call('positions', { body: { refresh: true, group_ids: [G1] } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(h.fetches[0].ids.sort(), ['101', '102'], 'unit 104 is inactive');
    assert.deepEqual(res.body.vehicles.map((v) => v.gps_vehicle_id).sort(), [U(1), U(2)]);
    assert.deepEqual(res.body.selection, { mode: 'custom', total: 2 });
    const linked = res.body.vehicles.find((v) => v.gps_vehicle_id === U(1));
    const free = res.body.vehicles.find((v) => v.gps_vehicle_id === U(2));
    assert.deepEqual([linked.linked, linked.plate, linked.order.route_to], [true, 'AA1111AA', 'Одеса'], 'linked: plate from the Fleet + current order');
    assert.deepEqual([free.linked, free.plate, free.unit_name, free.order, free.kind], [false, null, 'John Deere 8R', null, 'tractor'], 'unlinked: Wialon name, no order');
    assert.equal(JSON.stringify(res.body).includes(WIALON_TOKEN), false);
});

test('positions: unit_ids (a unit with no link) and a manual group; group + unit ids are united', async () => {
    const h = harness();
    const one = await h.call('positions', { body: { refresh: true, unit_ids: [U(3)] } });
    assert.deepEqual(h.fetches[0].ids, ['103']);
    assert.deepEqual(one.body.vehicles.map((v) => v.gps_vehicle_id), [U(3)]);
    h.clock.t += 61000;
    const both = await h.call('positions', { body: { refresh: true, group_ids: [G2], unit_ids: [U(1)] } });
    assert.deepEqual(h.fetches[1].ids.sort(), ['101', '103']);
    assert.equal(both.body.selection.total, 2);
});

test('positions: all = every active unit of the own org (no foreign, no inactive); kinds narrows the selection', async () => {
    const h = harness();
    const all = await h.call('positions', { body: { refresh: true, all: true } });
    assert.deepEqual(h.fetches[0].ids.sort(), ['101', '102', '103', '105']);
    assert.equal(all.body.selection.mode, 'all');
    h.clock.t += 61000;
    const kinds = await h.call('positions', { body: { refresh: true, all: true, kinds: ['truck', 'none'] } });
    assert.deepEqual(h.fetches[1].ids.sort(), ['101', '103'], 'truck + kind unknown');
    assert.equal(kinds.body.vehicles.length, 2);
});

test('positions: without a selection — only linked units (as before); the position goes to units regardless of the link', async () => {
    const h = harness();
    const res = await h.call('positions', { body: { refresh: true } });
    assert.deepEqual(h.fetches[0].ids, ['101']);
    assert.equal(res.body.selection.mode, 'linked');
});

test('positions: the saved position lands on an unlinked unit too', async () => {
    const h = harness();
    await h.call('positions', { body: { refresh: true, unit_ids: [U(2)] } });
    assert.equal(h.w.units.find((u) => u.id === U(2)).last_lat, 50);
    assert.equal(h.w.positions.length, 1);
    assert.equal(h.w.positions[0].gps_vehicle_id, U(2));
});

test('positions: bad selection → 400, no call to Wialon; response carries the sync state and the error code', async () => {
    const h = harness();
    for (const body of [{ group_ids: 'x' }, { group_ids: ['not-a-uuid'] }, { unit_ids: [1] }, { kinds: ['bus'] },
        { unit_ids: Array.from({ length: 301 }, (_, i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0')) }]) {
        const res = await h.call('positions', { body });
        assert.deepEqual([res.statusCode, res.body.code], [400, 'BAD_INPUT'], JSON.stringify(body).slice(0, 40));
    }
    assert.equal(h.fetches.length, 0);
    assert.deepEqual(parseSelection({ all: true }).mode, 'all');
    const failing = harness({ provider: { async fetchPositions() { throw new GpsError('timeout', 'budget'); } } });
    const res = await failing.call('positions', { body: { refresh: true, all: true } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.refresh_error_code, 'timeout');
    assert.match(res.body.refresh_error, /8 с/);
    assert.equal(res.body.sync.last_error_code, 'timeout');
    assert.equal(res.body.integration_status, 'error');
});

// --------------------------------------------------------------------------------------------------------------------
// Wialon: budget 8 s, every call min(4 s, rest), logout in finally
// --------------------------------------------------------------------------------------------------------------------

function budgetProvider({ steps, onSearch }) {
    const clock = { t: 0 };
    const calls = [];
    const transport = async ({ body, timeoutMs }) => {
        const form = new URLSearchParams(body);
        const svc = form.get('svc');
        calls.push({ svc, timeoutMs });
        clock.t += steps[svc] || 0;
        if (svc === 'token/login') return { status: 200, text: JSON.stringify({ eid: 'sid', au: 'viewer' }) };
        if (svc === 'core/search_items') {
            if (onSearch) throw onSearch;
            return { status: 200, text: JSON.stringify({ items: [{ id: 101, nm: 'A', pos: { x: 30, y: 50, t: 1700000000, s: 10, c: 1, sc: 5, z: 1 } }] }) };
        }
        return { status: 200, text: JSON.stringify({ error: 0 }) };
    };
    return { provider: createWialonProvider({ transport, now: () => clock.t }), calls, clock };
}
const CREDS = { apiHost: 'hst-api.wialon.com', hostKind: 'hosting', token: WIALON_TOKEN };

test('fetchPositions: budget 8 s, each call min(4 s, the rest), logout always last', async () => {
    assert.deepEqual([POSITIONS_BUDGET_MS, CALL_CAP_MS], [8000, 4000]);
    const a = budgetProvider({ steps: { 'token/login': 3000, 'core/search_items': 3500 } });
    const points = await a.provider.fetchPositions(CREDS, ['101']);
    assert.equal(points.length, 1);
    assert.deepEqual(a.calls.map((c) => [c.svc, c.timeoutMs]), [['token/login', 4000], ['core/search_items', 4000], ['core/logout', 1500]]);
});

test('fetchPositions: the search gets only what is left; a failure still logs out (finally)', async () => {
    const a = budgetProvider({ steps: { 'token/login': 7900 }, onSearch: new GpsError('network', 'x') });
    await assert.rejects(() => a.provider.fetchPositions(CREDS, ['101']), (e) => e instanceof GpsError && e.code === 'network');
    assert.deepEqual(a.calls.map((c) => [c.svc, c.timeoutMs]), [['token/login', 4000], ['core/search_items', 100], ['core/logout', 500]]);
});

test('fetchPositions: exhausted budget → timeout without the search call, logout still sent; token never in the error', async () => {
    const a = budgetProvider({ steps: { 'token/login': 8200 } });
    await assert.rejects(() => a.provider.fetchPositions(CREDS, ['101']), (e) => e instanceof GpsError && e.code === 'timeout' && !String(e.message + e.reason).includes(WIALON_TOKEN));
    assert.deepEqual(a.calls.map((c) => c.svc), ['token/login', 'core/logout']);
});

test('listUnitsWithGroups: group members from avl_unit_group; a group error does not hide itself or kill the units', async () => {
    const responses = [];
    const transport = async ({ body }) => {
        const form = new URLSearchParams(body);
        const svc = form.get('svc');
        const params = JSON.parse(form.get('params'));
        responses.push(svc);
        if (svc === 'token/login') return { status: 200, text: JSON.stringify({ eid: 'sid' }) };
        if (svc === 'core/search_items') {
            if (params.spec.itemsType === 'avl_unit_group') {
                return responses.includes('FAIL') ? { status: 200, text: JSON.stringify({ error: 7 }) }
                    : { status: 200, text: JSON.stringify({ items: [{ id: 5, nm: 'Тягачі', u: [101, 102, 101] }, { id: 6, nm: 'Порожня' }] }) };
            }
            return { status: 200, text: JSON.stringify({ items: [{ id: 101, nm: 'DAF' }, { id: 102, nm: 'MAN' }] }) };
        }
        return { status: 200, text: JSON.stringify({ error: 0 }) };
    };
    const out = await createWialonProvider({ transport }).listUnitsWithGroups(CREDS);
    assert.deepEqual(out.groups, [{ externalId: '5', name: 'Тягачі', unitIds: ['101', '102'] }, { externalId: '6', name: 'Порожня', unitIds: [] }]);
    assert.equal(out.groupsError, null);
    responses.push('FAIL');
    const bad = await createWialonProvider({ transport }).listUnitsWithGroups(CREDS);
    assert.deepEqual([bad.units.length, bad.groups, bad.groupsError], [2, null, 'access_denied']);
});

// --------------------------------------------------------------------------------------------------------------------
// sync-units: kind guess, kind_manual, manual groups
// --------------------------------------------------------------------------------------------------------------------

test('sync-units: guesses kind from the name, never overwrites kind_manual, never touches manual groups', async () => {
    const h = harness();
    const res = await h.call('sync-units');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    const by = (ext) => h.w.units.find((u) => u.external_id === ext);
    assert.equal(by('102').kind, 'tractor');
    assert.equal(by('106').kind, 'truck', 'a new unit is guessed from the name');
    // Ручний тип: «Ручний тип МТЗ» вгадався б як трактор, але kind_manual = true → лишається 'special'.
    assert.deepEqual([by('105').kind, by('105').kind_manual], ['special', true]);
    const manualRows = h.w.upserts.flat().filter((r) => r.external_id === '105');
    assert.equal(manualRows.length, 1);
    assert.equal('kind' in manualRows[0], false, 'a manual unit is written WITHOUT the kind column');
    assert.equal(h.w.upserts.flat().filter((r) => r.external_id !== '105').every((r) => 'kind' in r), true);
    // Групи: лише wialon-дзеркало; ручна група й її склад на місці.
    assert.deepEqual(h.w.groupSyncs[0], [{ external_id: 'g1', name: 'Тягачі 2', units: ['101', '106'] }]);
    assert.equal(h.w.groups.find((g) => g.source === 'manual').name, 'Моя група');
    assert.deepEqual(h.w.members.filter((m) => m.group_id === G2).map((m) => m.gps_vehicle_id), [U(3)]);
    assert.equal(res.body.groups.synced, true);
    assert.equal(res.body.groups.error, null);
    const row105 = res.body.units.find((u) => u.external_id === '105');
    assert.deepEqual([row105.kind, row105.kind_manual], ['special', true]);
});

test('sync-units: vanished units are deactivated, their manual kind and manual groups stay', async () => {
    const h = harness({ provider: { async listUnits() { return [{ externalId: '101', name: 'AA1111AA_DAF' }]; } } });
    h.w.units.find((u) => u.id === U(3)).kind_manual = true;
    h.w.units.find((u) => u.id === U(3)).kind = 'van';
    const res = await h.call('sync-units');
    assert.equal(res.body.counts.deactivated, 3, 'units 102, 103 and 105 vanished from Wialon; 104 was inactive already');
    const u3 = h.w.units.find((u) => u.id === U(3));
    assert.deepEqual([u3.active, u3.kind, u3.kind_manual], [false, 'van', true]);
    assert.equal(h.w.members.some((m) => m.group_id === G2), true, 'manual group membership stays');
});

test('sync-units: the group error is shown (code + text), not hidden; units are still synced', async () => {
    const failGroups = harness({ provider: { async listUnitsWithGroups() { return { units: [{ externalId: '101', name: 'DAF' }], groups: null, groupsError: 'access_denied' }; } } });
    const a = await failGroups.call('sync-units');
    assert.equal(a.body.ok, true);
    assert.deepEqual([a.body.groups.synced, a.body.groups.error], [false, 'access_denied']);
    assert.match(a.body.groups.message, /Wialon/);
    assert.equal(failGroups.w.groupSyncs.length, 0, 'no groups read → nothing is synced (nothing deleted)');
    const storeFail = harness({ store: { async syncGroups() { throw new Error('db down: secret internals'); } } });
    const b = await storeFail.call('sync-units');
    assert.equal(b.body.ok, true, 'units are synced even when the groups could not be saved');
    assert.deepEqual([b.body.groups.synced, b.body.groups.error], [false, 'groups_store']);
    assert.equal(JSON.stringify(b.body).includes('secret internals'), false, 'no database text in the response');
});

// --------------------------------------------------------------------------------------------------------------------
// Агроконтроль: каркас
// --------------------------------------------------------------------------------------------------------------------

test('agrocontrol: connect saves the access (token only to the Vault), test says not_configured, token never leaves', async () => {
    const h = harness();
    const connect = await h.call('connect', { body: { provider: 'agrocontrol', token: AGRO_TOKEN } });
    assert.equal(connect.statusCode, 200);
    assert.equal(connect.body.code, 'not_configured');
    assert.equal(connect.body.status, 'pending', 'saved, but not active');
    assert.equal(connect.body.token_hint, '…' + AGRO_TOKEN.slice(-4));
    const row = h.w.integrations.find((i) => i.provider === 'agrocontrol');
    assert.equal(h.w.vault.get(row.token_secret_id), AGRO_TOKEN, 'the token is in the vault');
    assert.equal(JSON.stringify(connect.body).includes(AGRO_TOKEN), false);
    h.clock.t += 11000;
    const test1 = await h.call('test', { body: { provider: 'agrocontrol' } });
    assert.equal(test1.statusCode, 200);
    assert.deepEqual([test1.body.ok, test1.body.code], [false, 'not_configured']);
    assert.match(test1.body.message, /не налаштовано/);
    assert.equal(test1.body.status, 'pending', 'not_configured is not a connection error');
    h.clock.t += 11000;
    const sync = await h.call('sync-units', { body: { provider: 'agrocontrol' } });
    assert.deepEqual([sync.body.ok, sync.body.code], [false, 'not_configured']);
    // Жодна відповідь і жоден лог не містять токена.
    for (const r of [connect, test1, sync]) assert.equal(JSON.stringify(r.body).includes(AGRO_TOKEN), false);
    assert.equal(h.logs.join('\n').includes(AGRO_TOKEN), false);
    // wialon не зачеплено
    assert.equal(h.w.integrations.find((i) => i.provider === 'wialon').status, 'active');
});

test('agrocontrol: bad token format and unknown provider are 400; only the owner may connect', async () => {
    const h = harness();
    const short = await h.call('connect', { body: { provider: 'agrocontrol', token: 'short' } });
    assert.deepEqual([short.statusCode, short.body.code], [400, 'BAD_TOKEN_FORMAT']);
    h.clock.t += 11000;
    const spaces = await h.call('connect', { body: { provider: 'agrocontrol', token: 'has a space inside token' } });
    assert.equal(spaces.statusCode, 400);
    const unknown = await h.call('test', { body: { provider: 'traccar' } });
    assert.deepEqual([unknown.statusCode, unknown.body.code], [400, 'BAD_PROVIDER']);
    const logist = await h.call('connect', { jwt: 'jwt-logist', body: { provider: 'agrocontrol', token: AGRO_TOKEN } });
    assert.deepEqual([logist.statusCode, logist.body.code], [403, 'OWNER_ONLY']);
});

test('agrocontrol provider: every method says not_configured, nothing is fetched, no real URLs in the skeleton', async () => {
    const p = getProvider('agrocontrol');
    for (const fn of ['connect', 'test', 'validateCredentials']) assert.deepEqual(await p[fn]({ token: AGRO_TOKEN }), { ok: false, code: 'not_configured' }, fn);
    for (const fn of ['units', 'listUnits', 'positions', 'fetchPositions']) {
        await assert.rejects(() => p[fn]({ token: AGRO_TOKEN }), (e) => e instanceof GpsError && e.code === 'not_configured' && !String(e.message).includes(AGRO_TOKEN), fn);
    }
    const src = fs.readFileSync(new URL('../lib/gps/providers/agrocontrol.js', import.meta.url), 'utf8');
    assert.equal(/https?:\/\/|fetch\(|safeRequest/.test(src.replace(/^\s*\/\/.*$/gm, '')), false, 'no network code in the skeleton');
    assert.match(src, /TODO/);
});

// --------------------------------------------------------------------------------------------------------------------
// Migration and project limits
// --------------------------------------------------------------------------------------------------------------------

const MIGRATION = fs.readdirSync(new URL('../../../supabase/migrations/', import.meta.url)).find((f) => /^\d{14}_kp_gps_groups\.sql$/.test(f));

test('migration kp_gps_groups: first line is the manual-apply notice; every UPDATE and DELETE has an explicit WHERE (safeupdate)', () => {
    assert.ok(MIGRATION, 'migration exists');
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/' + MIGRATION, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
    assert.equal(sql.split('\n')[0], '-- Apply manually after review. This file is not applied to any database by the agent.');
    const code = sql.replace(/^\s*--.*$/gm, '');
    const statements = [];
    for (const m of code.matchAll(/\b(UPDATE\s+(?:ONLY\s+)?[\w."]+(?:\s+AS\s+\w+)?\s+SET\b|DELETE\s+FROM\b|DO\s+UPDATE\s+SET\b)/gi)) {
        const rest = code.slice(m.index);
        const end = rest.indexOf(';');
        statements.push(rest.slice(0, end < 0 ? rest.length : end));
    }
    assert.ok(statements.length >= 4, 'the migration has UPDATE / DELETE statements (found ' + statements.length + ')');
    for (const st of statements) assert.match(st, /\bWHERE\b/i, 'no WHERE: ' + st.slice(0, 80).replace(/\s+/g, ' '));
    assert.equal(/CREATE EXTENSION/i.test(code), false);
});

test('migration kp_gps_groups: RLS on both tables, writes for owner / director only, manual groups only', () => {
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/' + MIGRATION, import.meta.url), 'utf8');
    assert.match(sql, /ALTER TABLE public\.gps_groups ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.gps_group_members ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /kp_role\(\) IN \('owner', 'director'\)/);
    assert.match(sql, /source = 'manual'/);
    assert.equal(/GRANT[^;]*gps_sync_groups[^;]*authenticated/i.test(sql.replace(/REVOKE[^;]*;/g, '')), false, 'sync is not callable by clients');
});

test('api/: exactly 12 Serverless Functions; vercel.json gets only "regions": ["fra1"]', () => {
    const files = fs.readdirSync(new URL('../api/', import.meta.url), { recursive: true }).map((f) => String(f).split(String.fromCharCode(92)).join('/'))
        .filter((f) => /\.(js|mjs|cjs|ts)$/.test(f) && !f.split('/').some((part) => part.startsWith('_')));
    assert.equal(files.length, 12, files.join(', '));
    const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.deepEqual(cfg.regions, ['fra1']);
    assert.deepEqual(Object.keys(cfg.functions).length, 7, 'functions block untouched');
    assert.deepEqual(cfg.rewrites[0], { source: '/api/:path*', destination: 'https://trip-control.com/api/:path*' });
});

// --------------------------------------------------------------------------------------------------------------------
// Вибір на екрані: пошук, localStorage, тіло запиту
// --------------------------------------------------------------------------------------------------------------------

test('catalog: unit search by Wialon name and by the Fleet plate; body of the positions request', () => {
    const units = [
        { id: 'a', name: 'AA1111AA_DAF XF', vehicle_label: 'AA 1111 AA', active: true },
        { id: 'b', name: 'John Deere 8R', vehicle_label: null, active: true },
        { id: 'c', name: 'DAF старий', vehicle_label: 'BB2222BB', active: false },
    ];
    assert.deepEqual(searchUnits(units, 'aa1111').map((u) => u.id), ['a'], 'plate without spaces / case');
    assert.deepEqual(searchUnits(units, 'deere').map((u) => u.id), ['b']);
    assert.deepEqual(searchUnits(units, 'daf').map((u) => u.id), ['a'], 'inactive units are not offered');
    assert.deepEqual(searchUnits(units, '  '), []);
    assert.deepEqual(selectionBody(emptySelection(), false), { refresh: false });
    assert.deepEqual(selectionBody({ all: false, groupIds: ['g'], unitIds: ['u'], kinds: ['truck'] }, true), { refresh: true, group_ids: ['g'], unit_ids: ['u'], kinds: ['truck'] });
    assert.deepEqual(selectionBody({ all: true, groupIds: ['g'], unitIds: ['u'], kinds: [] }, false), { refresh: false, all: true });
    assert.deepEqual(pruneSelection({ all: false, groupIds: ['g', 'x'], unitIds: ['u', 'y'], kinds: ['van'] }, { groups: [{ id: 'g' }], units: [{ id: 'u' }] }),
        { all: false, groupIds: ['g'], unitIds: ['u'], kinds: ['van'] });
});

test('catalog: the selection is saved per organization in localStorage; broken or missing storage is harmless', () => {
    const mem = new Map();
    const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
    saveSelection('org-1', { all: false, groupIds: ['g1'], unitIds: ['u1'], kinds: ['truck', 'bogus'] }, store);
    assert.deepEqual(loadSelection('org-1', store), { all: false, groupIds: ['g1'], unitIds: ['u1'], kinds: ['truck'] });
    assert.deepEqual(loadSelection('org-2', store), emptySelection());
    mem.set('kp.gps.selection.v1:org-3', '{broken');
    assert.deepEqual(loadSelection('org-3', store), emptySelection());
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.deepEqual(loadSelection('org-1', throwing), emptySelection());
    assert.doesNotThrow(() => saveSelection('org-1', emptySelection(), throwing));
});

test('store.selectedUnits: only own org, active; groups union units; foreign group ids give nothing', async () => {
    const { w } = world();
    const store = createSupabaseStore(fakeSupabase({ gps_vehicles: w.units, gps_group_members: w.members }));
    const ids = (rows) => rows.map((r) => r.id).sort();
    assert.deepEqual(ids(await store.selectedUnits('A', { all: true })), [U(1), U(2), U(3), U(5)]);
    assert.deepEqual(ids(await store.selectedUnits('A', { groupIds: [G1] })), [U(1), U(2)]);
    assert.deepEqual(ids(await store.selectedUnits('A', { groupIds: [G1], unitIds: [U(3), U(9)] })), [U(1), U(2), U(3)], 'a foreign unit id is dropped by the org filter');
    assert.deepEqual(ids(await store.selectedUnits('B', { groupIds: [G1] })), [], 'org B has no access to the group of A');
    assert.deepEqual(ids(await store.selectedUnits('A', {})), [U(1)], 'no selection → linked');
});

test('layout: buttons of the map filter and the GPS tab are content-sized (no .btn-block), the filter collapses to one column on a phone', () => {
    const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
    for (const file of ['../src/views/gps-map.js', '../src/views/gps.js']) assert.equal(/btn-block/.test(read(file)), false, file);
    const css = read('../src/crm.css');
    const block = css.slice(css.indexOf('.gps-filter {'), css.indexOf('.kp-marker.is-unlinked'));
    assert.equal(/(^|[\s;{])width:\s*100%/.test(block.replace(/\.gps-unit-(search|result) [^\n]*/g, '')), false, 'only the search field and the rows of the result list fill their cell');
    assert.match(css, /@media \(max-width: 600px\) \{\s*\/\* Телефон[^\n]*\n\s*#kp-crm \.gps-filter-row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(read('../src/cabinet-slot.css'), /\.gps-filter-row/, 'the generated slot copy has the new rules');
});
