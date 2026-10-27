import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createTeamHandler } = await import('../api/team.js');
const { planTransition, planDelete, cleanRejectReason } = await import('../lib/approvals.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const LOGIST = '33333333-3333-4333-8333-333333333333';
const OTHER_LOGIST = '44444444-4444-4444-8444-444444444444';
const calcId = (n) => '5555555' + n + '-5555-4555-8555-555555555555';

// Мінімальна in-memory підміна Supabase: лише те, що викликає сервіс погоджень.
function createFake(workMode = 'team') {
    const state = {
        tokens: {
            'owner-token': { id: OWNER, email: 'owner@x.test' },
            'logist-token': { id: LOGIST, email: 'logist@x.test' },
            'other-token': { id: OTHER_LOGIST, email: 'other@x.test' }
        },
        profiles: {
            [OWNER]: { id: OWNER, org_id: ORG, org_role: 'owner', member_status: 'active' },
            [LOGIST]: { id: LOGIST, org_id: ORG, org_role: 'logist', member_status: 'active' },
            [OTHER_LOGIST]: { id: OTHER_LOGIST, org_id: ORG, org_role: 'logist', member_status: 'active' }
        },
        org: { id: ORG, name: 'Test', status: 'active', work_mode: workMode },
        calculations: [],
        audit: []
    };
    class Query {
        constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.patch = null; }
        select() { return this; }
        eq(col, val) { this.filters.push((row) => row[col] === val); return this; }
        neq(col, val) { this.filters.push((row) => row[col] !== val); return this; }
        not(col, _op, list) {
            const values = String(list).replace(/[()]/g, '').split(',');
            this.filters.push((row) => !values.includes(row[col]));
            return this;
        }
        update(patch) { this.op = 'update'; this.patch = patch; return this; }
        delete() { this.op = 'delete'; return this; }
        insert(row) { if (this.table === 'security_audit_log') state.audit.push(row); return Promise.resolve({ error: null }); }
        run() {
            if (this.table === 'profiles') {
                const id = this.profileId;
                return { rows: Object.values(state.profiles).map((p) => ({ ...p, organizations: state.org })) };
            }
            const rows = state.calculations.filter((row) => this.filters.every((f) => f(row)));
            if (this.op === 'update') rows.forEach((row) => Object.assign(row, this.patch));
            if (this.op === 'delete') state.calculations = state.calculations.filter((row) => !rows.includes(row));
            return { rows };
        }
        single() { return this.maybeSingle(); }
        async maybeSingle() {
            if (this.table === 'profiles') {
                const filtered = this.run().rows.filter((p) => this.filters.every((f) => f(p)));
                return { data: filtered[0] || null, error: null };
            }
            return { data: this.run().rows[0] || null, error: null };
        }
        then(resolve) {
            if (this.table === 'profiles') {
                const rows = this.run().rows.filter((p) => this.filters.every((f) => f(p)));
                return resolve({ data: rows, error: null });
            }
            return resolve({ data: this.run().rows, error: null });
        }
    }
    const supabase = {
        auth: {
            async getUser(token) {
                const user = state.tokens[token];
                return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
            }
        },
        from: (table) => new Query(table)
    };
    return { state, supabase };
}

async function call(fake, token, body) {
    const handler = createTeamHandler({ supabase: fake.supabase, fetch: async () => ({}), env: {}, now: () => Date.parse('2026-10-27T12:00:00Z') });
    let status = 0;
    let payload = null;
    const res = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body }, res);
    return { status, payload };
}

const seed = (fake, rows) => { fake.state.calculations = rows.map((row) => ({ org_id: ORG, status: 'draft', ...row })); };

test('logist submits own draft; sends pending to the owner', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
    const res = await call(fake, 'logist-token', { action: 'calc_submit', id: calcId(1) });
    assert.equal(res.status, 200);
    assert.equal(fake.state.calculations[0].status, 'pending');
    assert.ok(fake.state.calculations[0].submitted_at);
});

test('logist cannot submit someone else\'s draft', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: OTHER_LOGIST }]);
    const res = await call(fake, 'logist-token', { action: 'calc_submit', id: calcId(1) });
    assert.equal(res.status, 403);
    assert.equal(fake.state.calculations[0].status, 'draft');
});

test('logist cannot accept or reject (403), status stays pending', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST, status: 'pending' }]);
    for (const decision of ['accepted', 'rejected']) {
        const res = await call(fake, 'logist-token', { action: 'calc_decide', id: calcId(1), decision, reason: 'x' });
        assert.equal(res.status, 403, decision);
        assert.equal(res.payload.code, 'OWNER_ONLY');
    }
    assert.equal(fake.state.calculations[0].status, 'pending');
    assert.equal(fake.state.calculations[0].decided_by, undefined);
});

test('owner accepts and rejects only pending requests; decision fields are stamped', async () => {
    const fake = createFake();
    seed(fake, [
        { id: calcId(1), user_id: LOGIST, status: 'pending' },
        { id: calcId(2), user_id: LOGIST, status: 'pending' },
        { id: calcId(3), user_id: LOGIST, status: 'draft' }
    ]);
    const ok = await call(fake, 'owner-token', { action: 'calc_decide', id: calcId(1), decision: 'accepted' });
    assert.equal(ok.status, 200);
    assert.equal(fake.state.calculations[0].status, 'accepted');
    assert.equal(fake.state.calculations[0].decided_by, OWNER);
    assert.equal(fake.state.calculations[0].decided_at, '2026-10-27T12:00:00.000Z');
    const rejected = await call(fake, 'owner-token', { action: 'calc_decide', id: calcId(2), decision: 'rejected', reason: '  Дорого  ' });
    assert.equal(rejected.status, 200);
    assert.equal(fake.state.calculations[1].status, 'rejected');
    assert.equal(fake.state.calculations[1].reject_reason, 'Дорого');
    const draft = await call(fake, 'owner-token', { action: 'calc_decide', id: calcId(3), decision: 'accepted' });
    assert.equal(draft.status, 403);
    assert.equal(fake.state.calculations[2].status, 'draft');
    const again = await call(fake, 'owner-token', { action: 'calc_decide', id: calcId(1), decision: 'rejected' });
    assert.ok(again.status === 409 || again.status === 403);
    assert.equal(fake.state.calculations[0].status, 'accepted');
    assert.ok(fake.state.audit.some((row) => row.action === 'calc_accepted'));
});

test('accepted requests cannot be deleted by anyone; others can, by author or owner only', async () => {
    const fake = createFake();
    seed(fake, [
        { id: calcId(1), user_id: LOGIST, status: 'accepted' },
        { id: calcId(2), user_id: LOGIST, status: 'done' },
        { id: calcId(3), user_id: LOGIST, status: 'pending' },
        { id: calcId(4), user_id: OTHER_LOGIST, status: 'draft' },
        { id: calcId(5), user_id: LOGIST, status: 'rejected' }
    ]);
    for (const [token, id] of [['logist-token', calcId(1)], ['owner-token', calcId(1)], ['logist-token', calcId(2)], ['owner-token', calcId(2)]]) {
        const res = await call(fake, token, { action: 'calc_delete', id });
        assert.equal(res.status, 403, token + ' ' + id);
        assert.equal(res.payload.code, 'ACCEPTED_LOCKED');
    }
    assert.equal(fake.state.calculations.length, 5);
    assert.equal((await call(fake, 'logist-token', { action: 'calc_delete', id: calcId(4) })).status, 403, 'not the author');
    assert.equal((await call(fake, 'logist-token', { action: 'calc_delete', id: calcId(3) })).status, 200);
    assert.equal((await call(fake, 'logist-token', { action: 'calc_delete', id: calcId(5) })).status, 200);
    assert.equal((await call(fake, 'owner-token', { action: 'calc_delete', id: calcId(4) })).status, 200);
    assert.deepEqual(fake.state.calculations.map((row) => row.status), ['accepted', 'done']);
});

test('solo owner accepts own draft without approval; a logist in team mode never can', async () => {
    const solo = createFake('solo');
    seed(solo, [{ id: calcId(1), user_id: OWNER }, { id: calcId(2), user_id: LOGIST }]);
    assert.equal((await call(solo, 'owner-token', { action: 'calc_decide', id: calcId(1), decision: 'accepted' })).status, 200, 'solo owner accepts own draft');
    assert.equal((await call(solo, 'owner-token', { action: 'calc_decide', id: calcId(2), decision: 'accepted' })).status, 403, 'a draft of someone else needs approval');
    assert.deepEqual(planTransition({ role: 'owner', isAuthor: true, soloMode: true }, 'draft', 'accepted'), { ok: true });
    assert.equal(planTransition({ role: 'owner', isAuthor: true, soloMode: false }, 'draft', 'accepted').status, 403);
    assert.equal(planTransition({ role: 'logist', isAuthor: true, soloMode: true }, 'draft', 'accepted').status, 403);
});

test('unauthenticated and unknown requests are refused', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
    assert.equal((await call(fake, 'bad-token', { action: 'calc_submit', id: calcId(1) })).status, 401);
    assert.equal((await call(fake, 'logist-token', { action: 'calc_submit', id: 'not-a-uuid' })).status, 400);
    assert.equal((await call(fake, 'logist-token', { action: 'calc_submit', id: calcId(9) })).status, 404);
    assert.equal((await call(fake, 'owner-token', { action: 'calc_decide', id: calcId(1), decision: 'maybe' })).status, 400);
});

test('transition matrix and reject reason cleanup', () => {
    const logist = { role: 'logist', isAuthor: true, soloMode: false };
    const owner = { role: 'owner', isAuthor: false, soloMode: false };
    assert.equal(planTransition(logist, 'draft', 'pending').ok, true);
    assert.equal(planTransition(logist, 'rejected', 'pending').ok, true);
    assert.equal(planTransition(logist, 'pending', 'accepted').status, 403);
    assert.equal(planTransition(logist, 'pending', 'rejected').status, 403);
    assert.equal(planTransition(owner, 'pending', 'accepted').ok, true);
    assert.equal(planTransition(owner, 'pending', 'rejected').ok, true);
    assert.equal(planTransition(owner, 'accepted', 'pending').status, 409);
    assert.equal(planTransition(owner, 'accepted', 'rejected').status, 409);
    assert.equal(planDelete(logist, 'accepted').status, 403);
    assert.equal(planDelete(owner, 'accepted').status, 403);
    assert.equal(planDelete(logist, 'pending').ok, true);
    assert.equal(planDelete({ role: 'logist', isAuthor: false }, 'draft').status, 403);
    assert.equal(cleanRejectReason('   '), null);
    assert.equal(cleanRejectReason('a'.repeat(900)).length, 500);
});

test('migration: columns, statuses, trigger and delete policy', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20261027140559_calc_approvals.sql', import.meta.url), 'utf8');
    for (const column of ['submitted_at', 'decided_by', 'decided_at', 'reject_reason']) assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS ' + column), column);
    assert.ok(sql.includes("CHECK (status IN ('draft', 'pending', 'accepted', 'rejected', 'done'))"));
    assert.ok(sql.includes("WHERE status = 'proposed'"));
    assert.match(sql, /CREATE TRIGGER trg_calculations_enforce_approval\s+BEFORE INSERT OR UPDATE ON public\.calculations/);
    assert.match(sql, /ERRCODE = '42501'/);
    assert.match(sql, /status NOT IN \('accepted', 'done'\)/);
    assert.match(sql, /IF NOT v_owner THEN\s+RAISE EXCEPTION 'APPROVAL_FORBIDDEN: only the owner decides'/);
    assert.equal(/GRANT .* TO anon/i.test(sql), false);
    // Міграція не застосовується автоматично: лише файл у supabase/migrations.
    assert.match(sql, /НЕ застосовувати на прод/);
});

test('migration only calls public functions that earlier migrations declare (is_org_admin does not exist in prod)', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = new URL('../supabase/migrations/', import.meta.url);
    const target = '20261027140559_calc_approvals.sql';
    const sql = readFileSync(new URL(target, dir), 'utf8');
    assert.equal(sql.includes('is_org_admin'), false);
    assert.ok(sql.includes('public.is_org_owner()'));
    const declared = new Set();
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql'))) {
        const text = readFileSync(new URL(name, dir), 'utf8');
        for (const match of text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\s*\(/gi)) declared.add(match[1]);
    }
    const body = sql.replace(/--.*$/gm, '');
    const called = new Set([...body.matchAll(/public\.([a-z_0-9]+)\(/g)].map((match) => match[1]));
    assert.ok(called.size >= 3, 'the migration calls public functions');
    for (const name of called) assert.ok(declared.has(name), 'public.' + name + '() is not declared in any migration');
    // Колонки/таблиці, на які спирається міграція, вже є в попередніх міграціях.
    const earlier = readdirSync(dir).filter((file) => file.endsWith('.sql') && file !== target).map((file) => readFileSync(new URL(file, dir), 'utf8')).join('\n');
    assert.match(earlier, /ADD COLUMN IF NOT EXISTS work_mode text/);
    assert.match(earlier, /calculations_status_check/);
    assert.match(earlier, /org_role/);
});
