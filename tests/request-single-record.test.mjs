import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createTeamHandler } = await import('../api/team.js');
const { calculateTrip } = await import('../api/calculate.js');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const S0 = JSON.parse(readFileSync(new URL('./fixtures/s0-fop.json', import.meta.url), 'utf8'));

const ORG = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const LOGIST = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const calcId = (n) => '5555555' + n + '-5555-4555-8555-555555555555';
const CAR = '66666666-6666-4666-8666-666666666666';

// ---- Сервер: calc_update ----
function createFake() {
    const state = {
        tokens: { 'owner-token': { id: OWNER }, 'logist-token': { id: LOGIST }, 'other-token': { id: OTHER } },
        profiles: {
            [OWNER]: { id: OWNER, org_id: ORG, org_role: 'owner', member_status: 'active' },
            [LOGIST]: { id: LOGIST, org_id: ORG, org_role: 'logist', member_status: 'active' },
            [OTHER]: { id: OTHER, org_id: ORG, org_role: 'logist', member_status: 'active' }
        },
        org: { id: ORG, name: 'Test', status: 'active', work_mode: 'team' },
        calculations: [], calcVehicles: [], audit: [], fleet: [{ id: CAR, org_id: ORG }], vehicleError: null
    };
    class Query {
        constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.patch = null; this.rowsIn = null; }
        select() { return this; }
        eq(col, val) { this.filters.push((row) => row[col] === val); return this; }
        in(col, list) { this.filters.push((row) => list.includes(row[col])); return this; }
        not(col, _op, list) { const v = String(list).replace(/[()]/g, '').split(','); this.filters.push((row) => !v.includes(row[col])); return this; }
        update(patch) { this.op = 'update'; this.patch = patch; return this; }
        delete() { this.op = 'delete'; return this; }
        insert(row) {
            if (this.table === 'security_audit_log') state.audit.push(row);
            if (this.table === 'calc_vehicles' && state.vehicleError && state.vehicleError.op === 'insert') return Promise.resolve({ error: state.vehicleError.error });
            if (this.table === 'calc_vehicles') state.calcVehicles.push(...[].concat(row));
            return Promise.resolve({ error: null });
        }
        run() {
            if (this.table === 'profiles') return { rows: Object.values(state.profiles).map((p) => ({ ...p, organizations: state.org })) };
            if (this.table === 'fleet_vehicles') return { rows: state.fleet.filter((row) => this.filters.every((f) => f(row))) };
            if (this.table === 'calc_vehicles') {
                const rows = state.calcVehicles.filter((row) => this.filters.every((f) => f(row)));
                if (this.op === 'delete') state.calcVehicles = state.calcVehicles.filter((row) => !rows.includes(row));
                return { rows };
            }
            const rows = state.calculations.filter((row) => this.filters.every((f) => f(row)));
            if (this.op === 'update') rows.forEach((row) => Object.assign(row, this.patch));
            return { rows };
        }
        single() { return this.maybeSingle(); }
        async maybeSingle() { return { data: this.run().rows.filter((r) => this.table !== 'profiles' || this.filters.every((f) => f(r)))[0] || null, error: null }; }
        then(resolve) {
            if (this.table === 'calc_vehicles' && this.op === 'delete' && state.vehicleError && state.vehicleError.op === 'delete') return resolve({ data: null, error: state.vehicleError.error });
            return resolve({ data: this.run().rows, error: null });
        }
    }
    const supabase = {
        auth: { async getUser(token) { const user = state.tokens[token]; return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }; } },
        from: (table) => new Query(table)
    };
    return { state, supabase };
}
async function call(fake, token, body) {
    const handler = createTeamHandler({ supabase: fake.supabase, fetch: async () => ({}), env: {}, now: () => Date.parse('2026-10-27T12:00:00Z') });
    let status = 0; let payload = null;
    const res = { status(c) { status = c; return this; }, json(d) { payload = d; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body }, res);
    return { status, payload };
}
const seed = (fake, rows) => { fake.state.calculations = rows.map((row) => ({ org_id: ORG, status: 'draft', name: 'old', inputs: { dist: 1 }, results: { dist: 1 }, ...row })); };
const upd = (id, extra = {}) => ({ action: 'calc_update', id, name: 'Київ — Одеса', inputs: { dist: 500, vehicles: [{ id: CAR, tonnage: 20, snapshot: { plate: 'AA' } }, { id: 'bad', tonnage: 5 }] }, results: { dist: 500, netProfit: 7 }, ...extra });

test('calc_update: автор оновлює свою чернетку й відхилену на тому ж id; статус, автор, id не змінюються', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }, { id: calcId(2), user_id: LOGIST, status: 'rejected', reject_reason: 'дорого' }]);
    for (const n of [1, 2]) {
        const res = await call(fake, 'logist-token', upd(calcId(n)));
        assert.equal(res.status, 200, 'row ' + n);
    }
    assert.equal(fake.state.calculations.length, 2, 'нових рядків немає');
    const [draft, rejected] = fake.state.calculations;
    assert.equal(draft.status, 'draft');
    assert.equal(rejected.status, 'rejected');
    assert.equal(draft.user_id, LOGIST);
    assert.equal(draft.name, 'Київ — Одеса');
    assert.equal(draft.inputs.dist, 500);
    assert.equal(draft.results.netProfit, 7);
    assert.ok(fake.state.audit.some((a) => a.action === 'calc_updated' && a.entity_id === calcId(1)));
});

test('calc_update: calc_vehicles перезаписуються (старі прибрано, некоректні пропущено)', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
    fake.state.calcVehicles = [{ calc_id: calcId(1), vehicle_id: 'old-car', tonnage: 1 }, { calc_id: calcId(9), vehicle_id: 'x', tonnage: 2 }];
    await call(fake, 'logist-token', upd(calcId(1)));
    await call(fake, 'logist-token', upd(calcId(1)));
    const mine = fake.state.calcVehicles.filter((r) => r.calc_id === calcId(1));
    assert.deepEqual(mine.map((r) => [r.vehicle_id, r.tonnage]), [[CAR, 20]], 'після двох збережень одне авто, без дублів');
    assert.equal(fake.state.calcVehicles.filter((r) => r.calc_id === calcId(9)).length, 1, 'чужа заявка не зачеплена');
});

test('calc_update: pending / accepted / done → 409 NOT_EDITABLE, рядок не змінюється', async () => {
    const fake = createFake();
    seed(fake, ['pending', 'accepted', 'done'].map((status, i) => ({ id: calcId(i + 1), user_id: LOGIST, status })));
    for (const n of [1, 2, 3]) {
        const res = await call(fake, 'owner-token', upd(calcId(n)));
        assert.equal(res.status, 409, 'row ' + n);
        assert.equal(res.payload.code, 'NOT_EDITABLE');
        assert.ok(res.payload.error.length > 10);
    }
    assert.ok(fake.state.calculations.every((r) => r.name === 'old' && r.inputs.dist === 1));
});

test('calc_update: чужа заявка → 403, власник організації може; пусті дані → 400', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: OTHER }]);
    const denied = await call(fake, 'logist-token', upd(calcId(1)));
    assert.equal(denied.status, 403);
    assert.equal(fake.state.calculations[0].name, 'old');
    assert.equal((await call(fake, 'logist-token', { action: 'calc_update', id: calcId(1) })).status, 403);
    assert.equal((await call(fake, 'owner-token', { action: 'calc_update', id: calcId(1), name: '', inputs: null, results: [] })).status, 400);
    assert.equal((await call(fake, 'owner-token', upd(calcId(1)))).status, 200, 'власник організації');
});

test('calc_update: заявка іншої організації не знаходиться (404)', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST, org_id: '99999999-9999-4999-8999-999999999999' }]);
    assert.equal((await call(fake, 'logist-token', upd(calcId(1)))).status, 404);
});

test('calc_decide з іншим варіантом оновлює той самий рядок (id і кількість рядків не змінюються)', async () => {
    const fake = createFake();
    const DIST = Number(S0.dist);
    const variants = [0, 1].map((i) => ({ index: i, summary: 'v' + i, km: DIST + 40 * i, minutes: 600, mainKm: DIST + 40 * i, podachaKm: S0.podachaDist, path: '' }));
    seed(fake, [{ id: calcId(1), user_id: LOGIST, status: 'pending', inputs: { ...S0, routeVariant: { index: 0, km: DIST }, routeVariants: variants }, results: { dist: DIST } }]);
    const res = await call(fake, 'owner-token', { action: 'calc_decide', id: calcId(1), decision: 'accepted', variantIndex: 1 });
    assert.equal(res.status, 200);
    assert.equal(fake.state.calculations.length, 1);
    assert.equal(fake.state.calculations[0].id, calcId(1));
    assert.equal(fake.state.calculations[0].status, 'accepted');
    assert.equal(fake.state.calculations[0].approved_variant.index, 1);
    assert.equal(fake.state.calculations[0].inputs.dist, DIST + 40);
    assert.ok(calculateTrip({ ...S0, dist: DIST + 40, podachaDist: S0.podachaDist }));
});

// ---- Клієнт: Зберегти / Відправити / Прийняти ----
function fnSource(name, isAsync) {
    const start = html.indexOf((isAsync ? 'async ' : '') + 'function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}

function clientContext({ rows = [], userId = LOGIST, role = 'logist', teamFail = null } = {}) {
    const log = { inserts: [], teamCalls: [], toasts: [] };
    const form = { origin: 'Київ', destination: 'Одеса', route: 'Київ — Одеса' };
    const els = { 'route-name': { get value() { return form.route; } }, 'tc-editing-note': { hidden: true, textContent: '' }, 'tc-save-new': { hidden: true } };
    let nextId = 0;
    const context = vm.createContext({
        log,
        savedCalculations: rows.map((r) => ({ userId: LOGIST, status: 'draft', ...r })),
        form, els,
        get lastCalcData() { return { routeName: form.route, dist: 500 }; },
        lastExport: { payload: { dist: 500, vehicles: [] } },
        isDemo: false, isAdmin: false, uiPreview: false, DEMO_MAX_SAVED: 3,
        currentOrgId: ORG, currentUserId: userId, currentOrgRole: role,
        clientNameValue: () => '', tripPlaces: () => ({ origin: form.origin, destination: form.destination }), currentRouteVariant: () => null, storedRouteVariants: () => null,
        document: { getElementById: (id) => els[id] || null },
        window: { scrollTo() {} },
        setStudioView() {}, renderSavedTable() {},
        // Завантаження шаблону / заявки у форму: реальний applyTripInputs починається з setCurrentCalc(null) (перевіряється нижче).
        applyTripInputs(p, name) { vm.runInContext('setCurrentCalc(null)', context); form.origin = p.origin || ''; form.destination = p.destination || ''; form.route = name || 'Заявка'; },
        saveCalcVehicles: async () => '',
        showToast: (text) => log.toasts.push(text),
        dbErrorText: (e) => String(e.message || e), demoSaveLimitText: () => 'limit',
        historyFields: (r) => ({ status: r.status }), requestVariants: () => [],
        supabaseClient: {
            from: () => ({
                insert(row) { log.inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'new-' + (++nextId) }, error: null }) }) }; }
            })
        },
        teamApi: async (_method, body) => {
            log.teamCalls.push(body);
            if (teamFail && teamFail(body)) throw Object.assign(new Error('x'), teamFail(body));
            return { ok: true };
        }
    });
    const parts = [['calcSignature'], ['formCalcSignature'], ['setCurrentCalc'], ['editableCurrentRow'], ['saveCalculation', 1], ['runApproval', 1], ['submitForApproval', 1], ['approveRequest', 1],
        ['sendCurrentForApproval', 1], ['acceptCurrentRequest', 1], ['approvalErrorText'], ['openSaved'], ['clearCalcForm']];
    // clearCalcForm тягне багато залежностей: беремо лише скидання id.
    vm.runInContext('var currentCalcId = null;\n' + parts.filter(([n]) => n !== 'clearCalcForm').map(([n, a]) => fnSource(n, a)).join('\n') +
        '\nfunction resetCalcId() { currentCalcId = null; }', context);
    return context;
}
const run = (context, code) => vm.runInContext(code, context);

test('клієнт: Зберегти + Відправити = 1 insert і зміна статусу на тому ж id', async () => {
    const c = clientContext();
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1);
    await run(c, 'sendCurrentForApproval()');
    assert.equal(c.log.inserts.length, 1, 'Відправити не додає рядок');
    const submit = c.log.teamCalls.filter((b) => b.action === 'calc_submit');
    assert.deepEqual(submit.map((b) => b.id), ['new-1']);
    assert.equal(c.savedCalculations.length, 1);
    assert.equal(c.savedCalculations[0].status, 'pending');
});

test('клієнт: повторне Зберегти оновлює чернетку (calc_update), без нового insert', async () => {
    const c = clientContext();
    await run(c, 'saveCalculation()');
    await run(c, 'saveCalculation()');
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1);
    const updates = c.log.teamCalls.filter((b) => b.action === 'calc_update');
    assert.equal(updates.length, 2);
    assert.ok(updates.every((b) => b.id === 'new-1' && b.name === 'Київ — Одеса' && b.inputs && b.results));
    assert.equal(c.savedCalculations.length, 1);
    assert.equal(c.savedCalculations[0].status, 'draft');
});

test('клієнт: відкрита чернетка → Відправити не створює рядок, оновлює й подає той самий id', async () => {
    const c = clientContext({ rows: [{ id: 'draft-1', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' } }] });
    run(c, "openSaved('draft-1')");
    assert.equal(run(c, 'currentCalcId'), 'draft-1');
    await run(c, 'sendCurrentForApproval()');
    assert.equal(c.log.inserts.length, 0);
    assert.deepEqual(c.log.teamCalls.map((b) => [b.action, b.id]), [['calc_update', 'draft-1'], ['calc_submit', 'draft-1']]);
    assert.equal(c.savedCalculations.length, 1);
});

test('клієнт: власник у режимі «Сам» — Прийняти на чернетці: оновлення + calc_decide на тому ж id, без insert', async () => {
    const c = clientContext({ rows: [{ id: 'draft-1', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' }, userId: OWNER }], userId: OWNER, role: 'owner' });
    run(c, "openSaved('draft-1')");
    await run(c, 'acceptCurrentRequest()');
    assert.equal(c.log.inserts.length, 0);
    assert.deepEqual(c.log.teamCalls.map((b) => [b.action, b.id]), [['calc_update', 'draft-1'], ['calc_decide', 'draft-1']]);
    assert.equal(c.savedCalculations[0].status, 'accepted');
});

test('клієнт: відхилену відкрито → Відправити повторно на тому ж id', async () => {
    const c = clientContext({ rows: [{ id: 'rej-1', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' }, status: 'rejected' }] });
    run(c, "openSaved('rej-1')");
    await run(c, 'sendCurrentForApproval()');
    assert.equal(c.log.inserts.length, 0);
    assert.deepEqual(c.log.teamCalls.map((b) => [b.action, b.id]), [['calc_update', 'rej-1'], ['calc_submit', 'rej-1']]);
});

test('клієнт: pending / accepted / done не редагуються — id не запам\'ятовується, id і статус лишаються', async () => {
    for (const status of ['pending', 'accepted', 'done']) {
        const c = clientContext({ rows: [{ id: 'row-1', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' }, status }] });
        run(c, "openSaved('row-1')");
        assert.equal(run(c, 'currentCalcId'), null, status);
        await run(c, 'saveCalculation()');
        assert.equal(c.log.teamCalls.filter((b) => b.action === 'calc_update').length, 0, status);
        assert.equal(c.savedCalculations.find((r) => r.id === 'row-1').status, status);
    }
});

test('клієнт: чужу заявку логіст не редагує (id не запам\'ятовується); новий розрахунок скидає id', async () => {
    const c = clientContext({ rows: [{ id: 'theirs', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' }, userId: OTHER }] });
    run(c, "openSaved('theirs')");
    assert.equal(run(c, 'currentCalcId'), null);
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1, 'збереження — це нова заявка');
    assert.equal(run(c, 'currentCalcId'), 'new-1');
    run(c, 'resetCalcId()');
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 2, 'після скидання — новий запис');
});

test('клієнт: відмова сервера (статус змінився) → зрозуміле повідомлення, Відправити не викликається', async () => {
    const c = clientContext({ rows: [{ id: 'draft-1', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' } }], teamFail: (b) => (b.action === 'calc_update' ? { code: 'NOT_EDITABLE' } : null) });
    run(c, "openSaved('draft-1')");
    await run(c, 'sendCurrentForApproval()');
    assert.ok(c.log.toasts.some((t) => /на погодженні або прийнята/.test(t)));
    assert.equal(c.log.teamCalls.filter((b) => b.action === 'calc_submit').length, 0);
    assert.equal(c.log.inserts.length, 0);
});

test('clearCalcForm скидає заявку (кодова перевірка)', () => {
    assert.match(fnSource('clearCalcForm'), /setCurrentCalc\(null\);/);
});

// ---- Підпис заявки, «Зберегти як нову», шаблони ----
const ROW_A = { id: 'draft-1', routeName: 'Київ — Одеса', inputs: { origin: 'Київ', destination: 'Одеса' } };

test('клієнт: зберіг A → ввів B → зберіг = 2 рядки, A не змінено', async () => {
    const c = clientContext();
    await run(c, 'saveCalculation()');
    const a = JSON.stringify(c.savedCalculations[0]);
    c.form.origin = 'Львів'; c.form.destination = 'Харків'; c.form.route = 'Львів — Харків';
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 2);
    assert.equal(c.log.teamCalls.filter((b) => b.action === 'calc_update').length, 0, 'стару чернетку не перезаписано');
    assert.equal(c.savedCalculations.length, 2);
    assert.equal(JSON.stringify(c.savedCalculations.find((r) => r.id === 'new-1')), a, 'A без змін');
    assert.equal(run(c, 'currentCalcId'), 'new-2');
});

test('клієнт: відкрита чернетка, маршрут змінено → нова заявка; той самий маршрут (регістр, пробіли) → оновлення', async () => {
    const c = clientContext({ rows: [ROW_A] });
    run(c, "openSaved('draft-1')");
    c.form.origin = '  київ ';
    await run(c, 'saveCalculation()');
    assert.deepEqual(c.log.teamCalls.map((b) => b.action), ['calc_update'], 'нормалізований підпис той самий');
    c.form.destination = 'Дніпро';
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1, 'інший маршрут — insert');
    assert.equal(c.savedCalculations.find((r) => r.id === 'draft-1').status, 'draft');
});

test('клієнт: «Зберегти як нову» завжди робить INSERT і переключається на новий запис', async () => {
    const c = clientContext({ rows: [ROW_A] });
    run(c, "openSaved('draft-1')");
    await run(c, 'saveCalculation({ forceNew: true })');
    assert.equal(c.log.inserts.length, 1);
    assert.equal(c.log.teamCalls.length, 0);
    assert.equal(run(c, 'currentCalcId'), 'new-1');
    assert.equal(c.savedCalculations.find((r) => r.id === 'draft-1').status, 'draft');
});

test('клієнт: завантаження шаблону / іншого розрахунку скидає id', async () => {
    const c = clientContext({ rows: [ROW_A] });
    run(c, "openSaved('draft-1')");
    assert.equal(run(c, 'currentCalcId'), 'draft-1');
    c.applyTripInputs({ origin: 'Київ', destination: 'Одеса' }, 'Київ — Одеса'); // шаблон із тим самим маршрутом
    assert.equal(run(c, 'currentCalcId'), null);
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1, 'шаблон не перезаписує стару чернетку');
    assert.match(fnSource('applyTripInputs'), /setCurrentCalc\(null\);/, 'реальний applyTripInputs скидає id');
});

test('клієнт: «Редагується заявка: …» і «Зберегти як нову» показані лише коли заявка відкрита', () => {
    const c = clientContext({ rows: [ROW_A] });
    assert.equal(c.els['tc-save-new'].hidden, true);
    run(c, "openSaved('draft-1')");
    assert.equal(c.els['tc-editing-note'].hidden, false);
    assert.equal(c.els['tc-editing-note'].textContent, 'Редагується заявка: Київ — Одеса');
    assert.equal(c.els['tc-save-new'].hidden, false);
    run(c, 'setCurrentCalc(null)');
    assert.equal(c.els['tc-editing-note'].hidden, true);
    assert.match(html, /id="tc-save-new" onclick="saveCalculation\(\{ forceNew: true \}\)"/);
    assert.doesNotMatch(html, /btn-block[^>]*id="tc-save-new"|id="tc-save-new"[^>]*btn-block/);
});

// ---- Сервер: авто, порядок, розмір ----
const rowsOf = (fake) => JSON.stringify([fake.state.calculations, fake.state.calcVehicles]);
const FOREIGN = '77777777-7777-4777-8777-777777777777';

test('calc_update: чуже авто → 403 CALC_VEHICLE_FORBIDDEN, заявка й calc_vehicles без змін', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
    fake.state.fleet.push({ id: FOREIGN, org_id: '99999999-9999-4999-8999-999999999999' });
    fake.state.calcVehicles = [{ calc_id: calcId(1), vehicle_id: CAR, tonnage: 5 }];
    const before = rowsOf(fake);
    const res = await call(fake, 'logist-token', upd(calcId(1), { inputs: { vehicles: [{ id: CAR, tonnage: 10 }, { id: FOREIGN, tonnage: 10 }] } }));
    assert.equal(res.status, 403);
    assert.equal(res.payload.code, 'CALC_VEHICLE_FORBIDDEN');
    assert.equal(rowsOf(fake), before);
    const unknown = await call(fake, 'logist-token', upd(calcId(1), { inputs: { vehicles: [{ id: '88888888-8888-4888-8888-888888888888', tonnage: 1 }] } }));
    assert.equal(unknown.status, 403, 'неіснуюче авто теж відхиляється');
    assert.equal(rowsOf(fake), before);
});

test('calc_update: >20 авто і snapshot >8 КБ відхиляються без змін', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
    const before = rowsOf(fake);
    const many = Array.from({ length: 21 }, () => ({ id: CAR, tonnage: 1 }));
    assert.equal((await call(fake, 'logist-token', upd(calcId(1), { inputs: { vehicles: many } }))).status, 400);
    const big = await call(fake, 'logist-token', upd(calcId(1), { inputs: { vehicles: [{ id: CAR, tonnage: 1, snapshot: { x: 'a'.repeat(9000) } }] } }));
    assert.equal(big.status, 413);
    assert.equal(rowsOf(fake), before);
    const twenty = Array.from({ length: 20 }, () => ({ id: CAR, tonnage: 1 }));
    assert.equal((await call(fake, 'logist-token', upd(calcId(1), { inputs: { vehicles: twenty } }))).status, 200);
});

test('calc_update: inputs або results > 200 КБ → 413 CALC_TOO_LARGE, без змін', async () => {
    const fake = createFake();
    seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
    const before = rowsOf(fake);
    const huge = 'x'.repeat(200 * 1024 + 10);
    for (const extra of [{ inputs: { note: huge } }, { results: { note: huge } }]) {
        const res = await call(fake, 'logist-token', upd(calcId(1), extra));
        assert.equal(res.status, 413);
        assert.equal(res.payload.code, 'CALC_TOO_LARGE');
    }
    assert.equal(rowsOf(fake), before);
});

test('calc_update: помилка видалення / вставки авто не ковтається (500), відсутня таблиця — ні', async () => {
    for (const op of ['delete', 'insert']) {
        const fake = createFake();
        seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
        fake.state.vehicleError = { op, error: { code: '23503', message: 'fk' } };
        const res = await call(fake, 'logist-token', upd(calcId(1)));
        assert.equal(res.status, 500, op);
        assert.equal(res.payload.code, 'CALC_VEHICLES_FAILED');
    }
    for (const code of ['42P01', 'PGRST205']) {
        const fake = createFake();
        seed(fake, [{ id: calcId(1), user_id: LOGIST }]);
        fake.state.vehicleError = { op: 'insert', error: { code, message: 'no table' } };
        const res = await call(fake, 'logist-token', upd(calcId(1)));
        assert.equal(res.status, 200, code);
        assert.equal(res.payload.vehiclesSaved, false);
    }
});

// ---- Підпис = «звідки | куди»; назва лише для заявок без адрес ----
test('підпис: відкрив чернетку → змінив лише назву → Зберегти / Відправити = calc_update того ж id, без insert', async () => {
    for (const send of [false, true]) {
        const c = clientContext({ rows: [ROW_A] });
        run(c, "openSaved('draft-1')");
        c.form.route = 'Нова назва';
        await run(c, send ? 'sendCurrentForApproval()' : 'saveCalculation()');
        assert.equal(c.log.inserts.length, 0, String(send));
        const updates = c.log.teamCalls.filter((b) => b.action === 'calc_update');
        assert.deepEqual(updates.map((b) => [b.id, b.name]), [['draft-1', 'Нова назва']]);
        if (send) assert.deepEqual(c.log.teamCalls.map((b) => [b.action, b.id]), [['calc_update', 'draft-1'], ['calc_submit', 'draft-1']]);
        assert.equal(c.savedCalculations.length, 1);
    }
});

test('підпис: змінив «куди» → insert, стара чернетка без змін', async () => {
    const c = clientContext({ rows: [ROW_A] });
    run(c, "openSaved('draft-1')");
    const before = JSON.stringify(c.savedCalculations[0]);
    c.form.destination = 'Львів';
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1);
    assert.equal(c.log.teamCalls.length, 0);
    assert.equal(JSON.stringify(c.savedCalculations.find((r) => r.id === 'draft-1')), before);
});

test('підпис: різниця лише в регістрі й пробілах → той самий запис; регекс схлопує пробіли, а не літеру «s»', async () => {
    const c = clientContext({ rows: [ROW_A] });
    run(c, "openSaved('draft-1')");
    c.form.origin = '  КИЇВ  ';
    c.form.destination = 'оДеСа';
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 0);
    assert.deepEqual(c.log.teamCalls.map((b) => b.action), ['calc_update']);
    assert.equal(run(c, "calcSignature({ origin: 'Rostov  on   Don', destination: 'Sumy' })"), 'rostov on don|sumy');
    assert.equal(run(c, "calcSignature({ origin: 'A  B', destination: 'C' }, 'x') === calcSignature({ origin: 'a b', destination: 'c' }, 'y')"), true);
});

test('підпис: адрес нема (стара заявка) → враховується назва: інша назва = новий запис, та сама = оновлення', async () => {
    const old = { id: 'draft-1', routeName: 'Стара', inputs: {} };
    const c = clientContext({ rows: [old] });
    c.form.origin = ''; c.form.destination = ''; c.form.route = 'Стара';
    run(c, "openSaved('draft-1')");
    await run(c, 'saveCalculation()');
    assert.deepEqual(c.log.teamCalls.map((b) => b.action), ['calc_update'], 'та сама назва');
    c.form.route = 'Інша';
    await run(c, 'saveCalculation()');
    assert.equal(c.log.inserts.length, 1, 'інша назва без адрес — новий запис');
    assert.equal(c.savedCalculations.find((r) => r.id === 'draft-1').routeName, 'Стара');
});
