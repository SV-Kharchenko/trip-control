import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createTeamHandler, MEMBER_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS } = await import('../api/team.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const OWNER = '22222222-2222-4222-8222-222222222222';
const LOGIST = '33333333-3333-4333-8333-333333333333';
const LOGIST2 = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const N1 = '66666666-6666-4666-8666-666666666661';
const N2 = '66666666-6666-4666-8666-666666666662';
const N3 = '66666666-6666-4666-8666-666666666663';

// Мінімальна in-memory підміна Supabase для сервісу команди: рівно ті запити, які роблять нові дії.
function createFake() {
    const state = {
        tokens: {
            'owner-token': { id: OWNER, email: 'owner@x.test' },
            'logist-token': { id: LOGIST, email: 'logist@x.test' },
            'stranger-token': { id: STRANGER, email: 'stranger@x.test' }
        },
        profiles: [
            { id: OWNER, email: 'owner@x.test', org_id: ORG, org_role: 'owner', member_status: 'active', created_at: '2026-01-01' },
            { id: LOGIST, email: 'logist@x.test', org_id: ORG, org_role: 'logist', member_status: 'active', created_at: '2026-01-02' },
            { id: LOGIST2, email: 'logist2@x.test', org_id: ORG, org_role: 'logist', member_status: 'active', created_at: '2026-01-03' },
            { id: STRANGER, email: 'stranger@x.test', org_id: OTHER_ORG, org_role: 'owner', member_status: 'active', created_at: '2026-01-04' }
        ],
        orgs: { [ORG]: { id: ORG, name: 'Test', status: 'active', work_mode: 'team' }, [OTHER_ORG]: { id: OTHER_ORG, name: 'Other', status: 'active', work_mode: 'team' } },
        org_member_permissions: [],
        org_notifications: [
            { id: N1, org_id: ORG, kind: 'approval_pending', ref_kind: 'calculation', ref_id: 'c1', actor_id: LOGIST, meta: { name: 'Київ — Львів' }, created_at: '2026-10-28T10:00:00Z', read_at: null },
            { id: N2, org_id: ORG, kind: 'signature_used', ref_kind: 'document', ref_id: 'd1', actor_id: LOGIST, meta: { doc_kind: 'act', number: 5 }, created_at: '2026-10-28T11:00:00Z', read_at: null },
            { id: N3, org_id: OTHER_ORG, kind: 'approval_pending', ref_kind: 'calculation', ref_id: 'c9', actor_id: STRANGER, meta: {}, created_at: '2026-10-28T12:00:00Z', read_at: null }
        ],
        audit: []
    };
    class Query {
        constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.patch = null; this.max = Infinity; this.sortBy = null; }
        select() { return this; }
        eq(col, val) { this.filters.push((row) => row[col] === val); return this; }
        is(col, val) { this.filters.push((row) => (row[col] === undefined ? null : row[col]) === val); return this; }
        in(col, list) { this.filters.push((row) => list.includes(row[col])); return this; }
        neq(col, val) { this.filters.push((row) => row[col] !== val); return this; }
        gte() { return this; }
        gt() { return this; }
        order(col, opts) { this.sortBy = { col, desc: opts && opts.ascending === false }; return this; }
        limit(n) { this.max = n; return this; }
        update(patch) { this.op = 'update'; this.patch = patch; return this; }
        upsert(row) {
            const list = state[this.table];
            const at = list.findIndex((item) => item.org_id === row.org_id && item.user_id === row.user_id);
            if (at >= 0) list[at] = { ...list[at], ...row };
            else list.push({ ...row });
            return Promise.resolve({ error: null });
        }
        insert(row) { if (this.table === 'security_audit_log') state.audit.push(row); return Promise.resolve({ error: null }); }
        rows() {
            if (this.table === 'profiles') return state.profiles.filter((row) => this.filters.every((f) => f(row))).map((row) => ({ ...row, organizations: state.orgs[row.org_id] }));
            let rows = (state[this.table] || []).filter((row) => this.filters.every((f) => f(row)));
            if (this.sortBy) rows = [...rows].sort((a, b) => (a[this.sortBy.col] < b[this.sortBy.col] ? 1 : -1) * (this.sortBy.desc ? 1 : -1));
            if (this.op === 'update') rows.forEach((row) => Object.assign(row, this.patch));
            return rows.slice(0, this.max);
        }
        single() { return this.maybeSingle(); }
        async maybeSingle() { return { data: this.rows()[0] || null, error: null }; }
        then(resolve) { return resolve({ data: this.rows(), error: null }); }
    }
    const supabase = {
        auth: {
            async getUser(token) {
                const user = state.tokens[token];
                return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
            },
            admin: { async listUsers() { return { data: { users: [] }, error: null }; } }
        },
        from: (table) => new Query(table)
    };
    return { state, supabase };
}

async function call(fake, token, method, body) {
    const handler = createTeamHandler({ supabase: fake.supabase, fetch: async () => ({}), env: {}, now: () => Date.parse('2026-10-28T12:00:00Z') });
    let status = 0;
    let payload = null;
    const res = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
    await handler({ method, headers: { authorization: token ? 'Bearer ' + token : '' }, body, query: {} }, res);
    return { status, payload };
}
const post = (fake, token, body) => call(fake, token, 'POST', body);

test('defaults: every right except signature and stamp', () => {
    assert.deepEqual(MEMBER_PERMISSIONS, ['acts', 'sign', 'fleet', 'clients', 'contracts']);
    assert.deepEqual(DEFAULT_MEMBER_PERMISSIONS, { acts: true, sign: false, fleet: true, clients: true, contracts: true });
});

test('the team list gives the owner every member\'s rights (owner: all, logist: row or defaults), a logist only its own', async () => {
    const fake = createFake();
    fake.state.org_member_permissions.push({ org_id: ORG, user_id: LOGIST2, can_acts: false, can_sign: true, can_fleet: true, can_clients: false, can_contracts: true });
    const owner = await call(fake, 'owner-token', 'GET');
    assert.equal(owner.status, 200);
    const byId = Object.fromEntries(owner.payload.members.map((m) => [m.id, m.permissions]));
    assert.deepEqual(byId[OWNER], { acts: true, sign: true, fleet: true, clients: true, contracts: true });
    assert.deepEqual(byId[LOGIST], DEFAULT_MEMBER_PERMISSIONS);
    assert.deepEqual(byId[LOGIST2], { acts: false, sign: true, fleet: true, clients: false, contracts: true });
    const logist = await call(fake, 'logist-token', 'GET');
    const seen = Object.fromEntries(logist.payload.members.map((m) => [m.id, m.permissions]));
    assert.deepEqual(seen[LOGIST], DEFAULT_MEMBER_PERMISSIONS);
    assert.equal(seen[LOGIST2], undefined, 'a logist does not see the rights of colleagues');
    assert.equal(seen[OWNER], undefined);
});

test('only the owner changes rights: a logist gets 403 and nothing is written', async () => {
    const fake = createFake();
    const body = { action: 'set_permissions', user_id: LOGIST, permissions: { sign: true } };
    const denied = await post(fake, 'logist-token', body);
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.code, 'OWNER_ONLY');
    assert.deepEqual(fake.state.org_member_permissions, []);
    const foreign = await post(fake, 'stranger-token', body);
    assert.equal(foreign.status, 404, 'an owner of another company cannot touch our member');
    assert.deepEqual(fake.state.org_member_permissions, []);
    assert.equal((await post(fake, '', body)).status, 401);
});

test('the owner switches rights: merged with the defaults, one row per logist, audited', async () => {
    const fake = createFake();
    const first = await post(fake, 'owner-token', { action: 'set_permissions', user_id: LOGIST, permissions: { sign: true } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload.permissions, { acts: true, sign: true, fleet: true, clients: true, contracts: true });
    const second = await post(fake, 'owner-token', { action: 'set_permissions', user_id: LOGIST, permissions: { clients: false, contracts: false } });
    assert.deepEqual(second.payload.permissions, { acts: true, sign: true, fleet: true, clients: false, contracts: false });
    const rows = fake.state.org_member_permissions;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].can_acts, rows[0].can_sign, rows[0].can_fleet, rows[0].can_clients, rows[0].can_contracts, rows[0].updated_by], [true, true, true, false, false, OWNER]);
    assert.equal(fake.state.audit.filter((row) => row.action === 'set_member_permissions').length, 2);
});

test('bad rights requests are refused: unknown key, non-boolean, empty, the owner as a target, a foreign id', async () => {
    const fake = createFake();
    for (const permissions of [{ admin: true }, { sign: 'yes' }, {}, [], null, { sign: 1 }]) {
        const res = await post(fake, 'owner-token', { action: 'set_permissions', user_id: LOGIST, permissions });
        assert.equal(res.status, 400, JSON.stringify(permissions));
        assert.equal(res.payload.code, 'BAD_PERMISSIONS');
    }
    const self = await post(fake, 'owner-token', { action: 'set_permissions', user_id: OWNER, permissions: { sign: false } });
    assert.equal(self.status, 400);
    assert.equal(self.payload.code, 'OWNER_ALL_RIGHTS');
    assert.equal((await post(fake, 'owner-token', { action: 'set_permissions', user_id: 'nope', permissions: { sign: true } })).status, 400);
    assert.equal((await post(fake, 'owner-token', { action: 'set_permissions', user_id: STRANGER, permissions: { sign: true } })).status, 404);
    assert.deepEqual(fake.state.org_member_permissions, []);
});

test('notifications: the owner reads own organisation (newest first, with the author and the unread count), a logist gets 403', async () => {
    const fake = createFake();
    const list = await post(fake, 'owner-token', { action: 'notifications' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.payload.items.map((item) => item.id), [N2, N1], 'the other organisation notification is not visible');
    assert.equal(list.payload.unread, 2);
    assert.equal(list.payload.items[0].actor_email, 'logist@x.test');
    assert.equal(list.payload.items[0].kind, 'signature_used');
    assert.equal(list.payload.items[1].ref_kind, 'calculation');
    const logist = await post(fake, 'logist-token', { action: 'notifications' });
    assert.equal(logist.status, 403);
    assert.equal((await post(fake, '', { action: 'notifications' })).status, 401);
});

test('notifications: mark as read one by one or all; a foreign id changes nothing; the unread count follows', async () => {
    const fake = createFake();
    const one = await post(fake, 'owner-token', { action: 'notifications_read', ids: [N1] });
    assert.equal(one.status, 200);
    assert.equal(one.payload.marked, 1);
    assert.ok(fake.state.org_notifications[0].read_at);
    assert.equal(fake.state.org_notifications[0].read_by, OWNER);
    assert.equal((await post(fake, 'owner-token', { action: 'notifications' })).payload.unread, 1);
    const foreign = await post(fake, 'owner-token', { action: 'notifications_read', ids: [N3] });
    assert.equal(foreign.payload.marked, 0);
    assert.equal(fake.state.org_notifications[2].read_at, null, 'another organisation is untouched');
    const all = await post(fake, 'owner-token', { action: 'notifications_read', all: true });
    assert.equal(all.payload.marked, 1);
    assert.equal((await post(fake, 'owner-token', { action: 'notifications' })).payload.unread, 0);
    assert.equal(fake.state.org_notifications[2].read_at, null);
    for (const bad of [{}, { ids: [] }, { ids: ['x'] }, { ids: 'all' }]) {
        const res = await post(fake, 'owner-token', { action: 'notifications_read', ...bad });
        assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(fake, 'logist-token', { action: 'notifications_read', all: true })).status, 403);
});
