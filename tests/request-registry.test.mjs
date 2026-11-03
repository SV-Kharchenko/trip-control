// «Реєстр заявок», частина A: lib/approvals.js (дзеркало тригера), дії api/team.js (calc_cancel, calc_decide, set_approval_mode),
// міграція 20261113090000_request_registry.sql і КП-перевірки статусу заявки.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createTeamHandler } = await import('../api/team.js');
const approvals = await import('../lib/approvals.js');
const { planTransition, planDelete, canDecide, normalizeApprovalMode, cleanCancelReason, APPROVAL_STATUSES, REGISTRY_STATUSES } = approvals;

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// ---- lib/approvals.js: роль × перехід × режим ----
const ROLES = [
    ['own', { role: 'owner', isAuthor: false }],
    ['dir', { role: 'director', isAuthor: false }],
    ['lgR', { role: 'logist', isAuthor: true, canAccept: true }],
    ['lgN', { role: 'logist', isAuthor: false, canAccept: false }]
];
const MOVES = [
    ['pending>accepted', 'pending', 'accepted', undefined],
    ['pending>rejected', 'pending', 'rejected', undefined],
    ['draft>accepted', 'draft', 'accepted', undefined],
    ['accepted>done', 'accepted', 'done', undefined],
    ['accepted>cancelled', 'accepted', 'cancelled', 'Клієнт відмовився'],
    ['done>cancelled', 'done', 'cancelled', 'Пізно'],
    ['cancelled>accepted', 'cancelled', 'accepted', undefined]
];
const matrix = (approvalMode) => MOVES.map(([name, from, to, reason]) => [name, ROLES.map(([role, ctx]) =>
    role + '=' + (planTransition({ soloMode: false, approvalMode, ...ctx }, from, to, { reason }).ok ? 'ok' : 'no')).join(' ')]);

test('lib/approvals: матриця ролей у режимі owner_only (логіст не приймає навіть з правом; директор нарівні з owner)', () => {
    assert.deepEqual(matrix('owner_only'), [
        ['pending>accepted', 'own=ok dir=ok lgR=no lgN=no'],
        ['pending>rejected', 'own=ok dir=ok lgR=no lgN=no'],
        ['draft>accepted', 'own=no dir=ok lgR=no lgN=no'],
        ['accepted>done', 'own=ok dir=ok lgR=ok lgN=no'],
        ['accepted>cancelled', 'own=ok dir=ok lgR=no lgN=no'],
        ['done>cancelled', 'own=no dir=no lgR=no lgN=no'],
        ['cancelled>accepted', 'own=no dir=no lgR=no lgN=no']
    ]);
});

test('lib/approvals: матриця ролей у режимі logist_can_accept (логіст лише з правом can_accept)', () => {
    assert.deepEqual(matrix('logist_can_accept'), [
        ['pending>accepted', 'own=ok dir=ok lgR=ok lgN=no'],
        ['pending>rejected', 'own=ok dir=ok lgR=ok lgN=no'],
        ['draft>accepted', 'own=no dir=ok lgR=ok lgN=no'],
        ['accepted>done', 'own=ok dir=ok lgR=ok lgN=no'],
        ['accepted>cancelled', 'own=ok dir=ok lgR=ok lgN=no'],
        ['done>cancelled', 'own=no dir=no lgR=no lgN=no'],
        ['cancelled>accepted', 'own=no dir=no lgR=no lgN=no']
    ]);
});

test('lib/approvals: solo, причина скасування, коди помилок, статуси реєстру', () => {
    assert.equal(planTransition({ role: 'owner', isAuthor: true, soloMode: true }, 'draft', 'accepted').ok, true, 'solo: власник приймає власну чернетку');
    assert.equal(planTransition({ role: 'owner', isAuthor: false, soloMode: true }, 'draft', 'accepted').ok, false, 'чужу чернетку — ні');
    assert.equal(planTransition({ role: 'logist', isAuthor: false, soloMode: true, approvalMode: 'logist_can_accept', canAccept: true }, 'draft', 'accepted').ok, false, 'logist у solo одразу не приймає');
    for (const reason of [undefined, null, '', '   ']) {
        const plan = planTransition({ role: 'owner' }, 'accepted', 'cancelled', { reason });
        assert.deepEqual([plan.ok, plan.status, plan.code], [false, 400, 'CANCEL_REASON_REQUIRED']);
    }
    assert.equal(planTransition({ role: 'owner' }, 'accepted', 'cancelled').code, 'CANCEL_REASON_REQUIRED');
    const done = planTransition({ role: 'owner' }, 'done', 'cancelled', { reason: 'x' });
    assert.deepEqual([done.status, done.code], [403, 'DONE_LOCKED']);
    const final = planTransition({ role: 'owner' }, 'cancelled', 'accepted');
    assert.deepEqual([final.status, final.code], [409, 'CANCELLED_FINAL']);
    assert.equal(planTransition({ role: 'logist', isAuthor: true }, 'accepted', 'cancelled', { reason: 'x' }).code, 'CANCEL_FORBIDDEN');
    assert.equal(planTransition({ role: 'owner' }, 'pending', 'cancelled', { reason: 'x' }).code, 'BAD_TRANSITION', 'скасувати можна лише прийняту');
    assert.equal(planTransition({ role: 'owner' }, 'accepted', 'in_work').code, 'BAD_STATUS', 'статусу in_work немає');
    assert.deepEqual(APPROVAL_STATUSES, ['draft', 'pending', 'accepted', 'rejected', 'done', 'cancelled']);
    assert.deepEqual(REGISTRY_STATUSES, ['accepted', 'done', 'cancelled']);
    assert.equal(cleanCancelReason('  ' + 'я'.repeat(600)).length, 500);
    assert.equal(normalizeApprovalMode('logist_can_accept'), 'logist_can_accept');
    for (const bad of ['owner_only', 'x', null, undefined, 1]) assert.equal(normalizeApprovalMode(bad), 'owner_only');
    assert.equal(canDecide({ role: 'logist', approvalMode: 'logist_can_accept', canAccept: true }), true);
    assert.equal(canDecide({ role: 'logist', approvalMode: 'logist_can_accept', canAccept: false }), false);
    assert.equal(canDecide({ role: 'logist', approvalMode: 'owner_only', canAccept: true }), false);
    for (const status of ['accepted', 'done', 'cancelled']) assert.equal(planDelete({ role: 'owner', isAuthor: true }, status).code, 'ACCEPTED_LOCKED', status);
});

// ---- api/team.js з підміною Supabase ----
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '99999999-9999-4999-8999-999999999999';
const OWNER = '22222222-2222-4222-8222-222222222222';
const LOGIST = '33333333-3333-4333-8333-333333333333';
const LOGIST_NR = '44444444-4444-4444-8444-444444444444';
const DIRECTOR = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const CALC = '77777777-7777-4777-8777-777777777777';

function createFake({ mode = null, rights = {}, work = 'team', failUpdate = null } = {}) {
    const state = {
        tokens: Object.fromEntries([[OWNER, 'owner'], [LOGIST, 'logist'], [LOGIST_NR, 'lognr'], [DIRECTOR, 'director'], [STRANGER, 'stranger']]
            .map(([id, name]) => [name + '-token', { id, email: name + '@x.test' }])),
        profiles: [
            { id: OWNER, org_id: ORG, org_role: 'owner', member_status: 'active' },
            { id: LOGIST, org_id: ORG, org_role: 'logist', member_status: 'active' },
            { id: LOGIST_NR, org_id: ORG, org_role: 'logist', member_status: 'active' },
            { id: DIRECTOR, org_id: ORG2, org_role: 'owner', member_status: 'active' },
            { id: STRANGER, org_id: ORG2, org_role: 'owner', member_status: 'active' }
        ],
        organizations: { [ORG]: { id: ORG, name: 'Test', status: 'active', work_mode: work }, [ORG2]: { id: ORG2, name: 'Other', status: 'active', work_mode: 'team' } },
        calculations: [],
        company_settings: mode ? [{ org_id: ORG, settings: { approval_mode: mode } }] : [],
        org_member_permissions: Object.entries(rights).map(([user_id, can_accept]) => ({ org_id: ORG, user_id, can_accept })),
        org_directors: [{ org_id: ORG, user_id: DIRECTOR }],
        calc_vehicles: [],
        audit: [],
        updates: [],
        registrySeq: 0
    };
    class Query {
        constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.patch = null; }
        select() { return this; }
        eq(col, val) { this.filters.push((row) => row[col] === val); return this; }
        neq(col, val) { this.filters.push((row) => row[col] !== val); return this; }
        update(patch) { this.op = 'update'; this.patch = patch; return this; }
        delete() { this.op = 'delete'; return this; }
        insert(row) { if (this.table === 'security_audit_log') state.audit.push(row); return Promise.resolve({ error: null }); }
        rows() {
            if (this.table === 'profiles') return state.profiles.filter((row) => this.filters.every((f) => f(row))).map((row) => ({ ...row, organizations: state.organizations[row.org_id] }));
            if (this.table === 'organizations') return Object.values(state.organizations).filter((row) => this.filters.every((f) => f(row)));
            const rows = (state[this.table] || []).filter((row) => this.filters.every((f) => f(row)));
            if (this.op === 'update' && this.table === 'calculations') {
                if (failUpdate) return { error: failUpdate };
                rows.forEach((row) => {
                    Object.assign(row, this.patch);
                    // Імітація тригера бази: номер реєстру при першому переході в accepted / done.
                    if ((row.status === 'accepted' || row.status === 'done') && !row.registry_no) row.registry_no = '2026-' + String(++state.registrySeq).padStart(4, '0');
                });
                state.updates.push({ ...this.patch });
            }
            if (this.op === 'delete') state.calculations = state.calculations.filter((row) => !rows.includes(row));
            return rows;
        }
        single() { return this.maybeSingle(); }
        async maybeSingle() {
            const rows = this.rows();
            if (rows && rows.error) return { data: null, error: rows.error };
            return { data: rows[0] ? { ...rows[0] } : null, error: null };
        }
        then(resolve) {
            const rows = this.rows();
            if (rows && rows.error) return resolve({ data: null, error: rows.error });
            return resolve({ data: rows, error: null });
        }
    }
    const supabase = {
        auth: {
            async getUser(token) {
                const user = state.tokens[token];
                return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
            }
        },
        rpc: async (name, args) => { state.rpc = (state.rpc || []).concat([{ name, args }]); return { data: args.p_mode, error: null }; },
        from: (table) => new Query(table)
    };
    return { state, supabase };
}

async function call(fake, token, body) {
    const handler = createTeamHandler({ supabase: fake.supabase, fetch: async () => ({}), env: {}, now: () => Date.parse('2026-11-13T12:00:00Z') });
    let status = 0;
    let payload = null;
    const res = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body }, res);
    return { status, payload };
}
const seed = (fake, status, extra = {}) => { fake.state.calculations = [{ id: CALC, org_id: ORG, user_id: LOGIST, status, inputs: {}, results: {}, ...extra }]; };
const cancel = (fake, token, reason) => call(fake, token, { action: 'calc_cancel', id: CALC, reason });

test('calc_cancel: директор скасовує прийняту заявку з причиною; поля скасування й аудит', async () => {
    const fake = createFake();
    seed(fake, 'accepted', { registry_no: '2026-0003' });
    const res = await cancel(fake, 'owner-token', '  Клієнт відмовився  ');
    assert.equal(res.status, 200);
    assert.deepEqual([res.payload.ok, res.payload.status], [true, 'cancelled']);
    const row = fake.state.calculations[0];
    assert.deepEqual([row.status, row.cancel_reason, row.cancelled_by, row.cancelled_at], ['cancelled', 'Клієнт відмовився', OWNER, '2026-11-13T12:00:00.000Z']);
    assert.equal(row.registry_no, '2026-0003', 'номер лишається');
    const audit = fake.state.audit.find((entry) => entry.action === 'calc_cancelled');
    assert.deepEqual([audit.entity_id, audit.detail.from, audit.detail.reason], [CALC, 'accepted', 'Клієнт відмовився']);
});

test('calc_cancel: без причини 400 і нічого не змінюється; чужа організація 404; невідомий id 400', async () => {
    const fake = createFake();
    seed(fake, 'accepted');
    for (const reason of [undefined, '', '   ']) {
        const res = await cancel(fake, 'owner-token', reason);
        assert.deepEqual([res.status, res.payload.code], [400, 'CANCEL_REASON_REQUIRED']);
    }
    assert.equal(fake.state.calculations[0].status, 'accepted');
    assert.equal(fake.state.updates.length, 0);
    assert.equal((await cancel(fake, 'stranger-token', 'x')).status, 404);
    assert.equal((await call(fake, 'owner-token', { action: 'calc_cancel', id: 'nope', reason: 'x' })).status, 400);
});

test('calc_cancel: логіст — лише в режимі logist_can_accept і з правом can_accept; done і cancelled незмінні', async () => {
    const cases = [
        ['owner_only режим, право є', { mode: null, rights: { [LOGIST]: true } }, 'logist-token', 403],
        ['режим logist_can_accept, права немає', { mode: 'logist_can_accept', rights: { [LOGIST]: false } }, 'logist-token', 403],
        ['режим logist_can_accept, рядка прав немає', { mode: 'logist_can_accept', rights: {} }, 'logist-token', 403],
        ['режим logist_can_accept, право є', { mode: 'logist_can_accept', rights: { [LOGIST]: true } }, 'logist-token', 200],
        ['право є в іншого логіста', { mode: 'logist_can_accept', rights: { [LOGIST]: true } }, 'lognr-token', 403]
    ];
    for (const [name, options, token, expected] of cases) {
        const fake = createFake(options);
        seed(fake, 'accepted', { user_id: OWNER });
        const res = await cancel(fake, token, 'Причина');
        assert.equal(res.status, expected, name);
        assert.equal(fake.state.calculations[0].status, expected === 200 ? 'cancelled' : 'accepted', name);
    }
    const fake = createFake();
    seed(fake, 'done');
    const done = await cancel(fake, 'owner-token', 'Пізно');
    assert.deepEqual([done.status, done.payload.code], [403, 'DONE_LOCKED']);
    seed(fake, 'cancelled', { cancel_reason: 'x' });
    const again = await cancel(fake, 'owner-token', 'ще раз');
    assert.deepEqual([again.status, again.payload.code], [409, 'CANCELLED_FINAL']);
    const reopen = await call(fake, 'owner-token', { action: 'calc_decide', id: CALC, decision: 'accepted' });
    assert.equal(reopen.status, 409, 'з cancelled нікуди не переходить');
    const complete = await call(fake, 'owner-token', { action: 'calc_complete', id: CALC });
    assert.equal(complete.status, 409);
    const removed = await call(fake, 'owner-token', { action: 'calc_delete', id: CALC });
    assert.deepEqual([removed.status, removed.payload.code], [403, 'ACCEPTED_LOCKED'], 'скасовану заявку не видаляють');
    assert.equal(fake.state.calculations.length, 1);
});

test('calc_decide: логіст з правом приймає будь-яку заявку компанії (режим logist_can_accept); без режиму чи права — 403', async () => {
    const on = createFake({ mode: 'logist_can_accept', rights: { [LOGIST]: true } });
    seed(on, 'pending', { user_id: OWNER });
    const ok = await call(on, 'logist-token', { action: 'calc_decide', id: CALC, decision: 'accepted' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.payload.status, ok.payload.registry_no], ['accepted', '2026-0001'], 'номер реєстру повертається');
    assert.equal(on.state.calculations[0].decided_by, LOGIST);
    for (const options of [{ mode: null, rights: { [LOGIST]: true } }, { mode: 'logist_can_accept', rights: {} }]) {
        const off = createFake(options);
        seed(off, 'pending', { user_id: OWNER });
        const denied = await call(off, 'logist-token', { action: 'calc_decide', id: CALC, decision: 'rejected', reason: 'x' });
        assert.deepEqual([denied.status, denied.payload.code], [403, 'OWNER_ONLY']);
        assert.equal(off.state.calculations[0].status, 'pending');
    }
});

test('директор Контроль+ (org_directors) приймає, виконує й скасовує заявку своєї компанії; чужий користувач — 404', async () => {
    const fake = createFake();
    seed(fake, 'pending');
    const accepted = await call(fake, 'director-token', { action: 'calc_decide', id: CALC, decision: 'accepted' });
    assert.equal(accepted.status, 200);
    assert.deepEqual([fake.state.calculations[0].status, fake.state.calculations[0].decided_by], ['accepted', DIRECTOR]);
    assert.equal(fake.state.audit.at(-1).org_id, ORG, 'аудит у компанії заявки, не в профілі директора');
    const cancelled = await cancel(fake, 'director-token', 'Директор скасував');
    assert.equal(cancelled.status, 200);
    seed(fake, 'accepted');
    assert.equal((await call(fake, 'director-token', { action: 'calc_complete', id: CALC })).status, 200);
    seed(fake, 'pending');
    assert.equal((await call(fake, 'stranger-token', { action: 'calc_decide', id: CALC, decision: 'accepted' })).status, 404);
    assert.equal(fake.state.calculations[0].status, 'pending');
    // Директор не редагує й не видаляє заявку: ці дії лишаються власнику та автору.
    assert.equal((await call(fake, 'director-token', { action: 'calc_delete', id: CALC })).status, 404);
});

test('помилки бази зіставляються з кодами API (CANCEL_REASON_REQUIRED, DONE_CANNOT_CANCEL, CANCELLED_FINAL, 42501)', async () => {
    const table = [
        [{ code: 'P0001', message: 'CANCEL_REASON_REQUIRED' }, 400, 'CANCEL_REASON_REQUIRED'],
        [{ code: '42501', message: 'DONE_CANNOT_CANCEL: x' }, 403, 'DONE_LOCKED'],
        [{ code: '42501', message: 'CANCELLED_FINAL: x' }, 409, 'CANCELLED_FINAL'],
        [{ code: '42501', message: 'APPROVAL_FORBIDDEN: x' }, 403, 'APPROVAL_FORBIDDEN']
    ];
    for (const [failUpdate, status, code] of table) {
        const fake = createFake({ failUpdate });
        seed(fake, 'accepted');
        const res = await cancel(fake, 'owner-token', 'x');
        assert.deepEqual([res.status, res.payload.code], [status, code]);
    }
});

// ---- Міграція, тригер, КП-перевірки ----
const migration = read('supabase/migrations/20261113090000_request_registry.sql');

test('міграція: файл для ручного застосування, РУЧНИЙ ВІДКАТ, статус cancelled, колонки, унікальність, лічильник', () => {
    assert.ok(migration.startsWith('-- Apply manually after review. This file is not applied to production by the agent.'));
    assert.match(migration, /РУЧНИЙ ВІДКАТ/);
    for (const part of [
        "CHECK (status IN ('draft', 'pending', 'accepted', 'rejected', 'done', 'cancelled'))",
        'ADD COLUMN IF NOT EXISTS registry_no text', 'ADD COLUMN IF NOT EXISTS cancelled_at timestamptz', 'cancelled_by uuid', 'ADD COLUMN IF NOT EXISTS cancel_reason text',
        'UNIQUE (org_id, registry_no)', 'CREATE TABLE IF NOT EXISTS public.calc_registry_counters',
        'ON CONFLICT (org_id, year) DO UPDATE SET last_no = c.last_no + 1',
        'ADD COLUMN IF NOT EXISTS can_accept boolean NOT NULL DEFAULT false',
        "'acts', 'sign', 'fleet', 'clients', 'contracts', 'accept'",
        "settings ->> 'approval_mode' = 'logist_can_accept'",
        'RETURNS TABLE', 'SECURITY INVOKER', 'public.registry_list', 'public.registry_totals', "'approval_decided'"
    ]) assert.ok(migration.includes(part), part);
    assert.equal(/CREATE POLICY[^;]*calc_registry_counters/.test(migration), false, 'лічильник без політик');
    assert.equal(/SECURITY DEFINER[\s\S]{0,200}registry_(list|totals)/.test(migration), false, 'RPC реєстру не DEFINER');
    assert.ok(migration.includes("status NOT IN ('accepted', 'done', 'cancelled')"), 'видаляти accepted / done / cancelled не можна');
    assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.kp_next_registry_no(uuid, integer) FROM PUBLIC, anon, authenticated, service_role'));
});

test('тригер: перехід-правила та інваріанти в SQL (директор, режим, cancelled, done, причина, номер незмінний)', () => {
    const trigger = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.calculations_enforce_approval()'), migration.indexOf('CREATE OR REPLACE FUNCTION public.calculations_registry()'));
    for (const part of ["NEW.status IN ('accepted', 'rejected') AND OLD.status = 'pending'", 'v_owner OR v_director OR v_logist',
        'OR v_director', 'v_logist AND NOT COALESCE(v_solo, false)', "NEW.status = 'done' AND OLD.status = 'accepted'", 'OLD.user_id = v_uid OR v_owner OR v_director',
        "NEW.status = 'cancelled' AND OLD.status = 'accepted'"]) assert.ok(trigger.includes(part), part);
    const registry = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.calculations_registry()'), migration.lastIndexOf('DROP TRIGGER IF EXISTS trg_calculations_registry'));
    for (const part of ['CANCELLED_FINAL', 'DONE_CANNOT_CANCEL', 'CANCEL_REASON_REQUIRED', 'NEW.registry_no := OLD.registry_no', 'public.kp_next_registry_no(NEW.org_id, v_year)',
        "AT TIME ZONE 'Europe/Kyiv'", 'NEW.cancelled_at := now()', 'coalesce(auth.uid(), NEW.cancelled_by)']) assert.ok(registry.includes(part), part);
    // Порядок спрацювання: enforce_approval (e) раніше registry (r) — за алфавітом назв тригерів.
    assert.ok('trg_calculations_enforce_approval' < 'trg_calculations_registry');
});

test('КП-перевірки статусу заявки: усі — білий список IN (accepted, done), тож cancelled нові документи не отримують; існуючі не чіпаємо', () => {
    const dir = new URL('../supabase/migrations/', import.meta.url);
    const checks = [];
    for (const file of readdirSync(dir)) {
        if (file === '20261113090000_request_registry.sql') continue;
        const lines = readFileSync(new URL(file, dir), 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (/status (NOT )?IN \('accepted', 'done'\)/.test(line) && !/^\s*--/.test(line)) checks.push(file + ':' + (i + 1));
        });
    }
    assert.ok(checks.length >= 10, 'знайдено перевірки статусу: ' + checks.length);
    for (const file of ['20261012220000_trip_actuals', '20261023091124_trip_fact_v2', '20261028110121_kp_trip_sheets', '20261028140901_kp_trip_sheet_followups',
        '20261030140232_kp_docs_from_requests', '20261109090000_kp_trip_sheet_refuels']) {
        assert.ok(checks.some((entry) => entry.startsWith(file)), file);
    }
    // Тригери перевірки документів спрацьовують лише на INSERT: наявні документи скасованої заявки не блокуються і не видаляються.
    assert.match(read('supabase/migrations/20261028110121_kp_trip_sheets.sql'), /BEFORE INSERT ON public\.kp_doc_ttn/);
    assert.match(read('supabase/migrations/20261030140232_kp_docs_from_requests.sql'), /BEFORE INSERT ON public\.kp_document_lines/);
    assert.equal(/DELETE FROM public\.kp_/.test(migration), false, 'міграція не видаляє документи');
    assert.match(read('apps/kontrol-plus/src/lib/docs.js'), /calcAccepted = \(status\) => status === 'accepted' \|\| status === 'done'/);
    assert.match(read('api/calculate.js'), /calc\.status !== 'accepted' && calc\.status !== 'done'/);
});

test('pgTAP-тест реєстру: 38 перевірок, матриця ролей × переходів × режимів, нумерація, RLS', () => {
    const tap = read('supabase/tests/request_registry.sql');
    assert.match(tap, /SELECT plan\(38\)/);
    assert.equal(tap.split('\n').filter((line) => /^SELECT (is|ok|results_eq|throws_ok|matches)\(/.test(line)).length, 38);
    for (const part of ['logist_can_accept', 'owner_only', 'registry_list', 'registry_totals', 'kp_next_registry_no', 'P0001', 'approval_decided']) assert.ok(tap.includes(part), part);
});

// ---- Інтерфейс (мінімум: режим прийняття в «Команді», право на сайті, кнопка «Скасувати» з причиною) ----
test('index.html: право «Приймати заявки в роботу» видиме на сайті поряд з Автопарком; режим прийняття лише в team; кнопка «Скасувати» з причиною', () => {
    const html = read('index.html');
    assert.ok(html.includes("['accept', 'Приймати заявки в роботу']"));
    assert.ok(html.includes("return isKP() || item[0] === 'fleet' || item[0] === 'accept';"), 'фільтр !isKP() з PR #103 оновлено');
    assert.ok(html.includes("['cancelled', 'Скасована']"));
    assert.ok(html.includes('id="team-approval-mode"'));
    assert.ok(html.includes("action: 'set_approval_mode'"));
    assert.ok(html.includes("'calc_cancel'"));
    assert.ok(html.includes('Причина скасування'));
    assert.ok(html.includes('approval_decided:'), 'текст сповіщення approval_decided');
    // Режим прийняття — у панелі «Команда» (isOwner && team); у solo її немає.
    const gate = html.indexOf("if (isOwner && currentWorkMode === 'team') {");
    const mode = html.indexOf('id="team-approval-mode"');
    const end = html.indexOf('box.innerHTML = html;', gate);
    assert.ok(gate > 0 && gate < mode && mode < end, 'перемикач режиму лише в панелі «Команда» (team), у solo його немає');
    // Тип approval_decided не входить у сховані на сайті КП-типи.
    const kpOnly = html.slice(html.indexOf('function noteKpOnly(note) {'), html.indexOf('function visibleNotes'));
    assert.equal(kpOnly.includes('approval_decided'), false);
    assert.equal(kpOnly.includes("'calculation'"), false);
});
