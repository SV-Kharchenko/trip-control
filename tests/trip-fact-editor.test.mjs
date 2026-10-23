import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const { buildTripFact } = await import('../api/calculate.js');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/calc-golden.json', import.meta.url), 'utf8'));
const between = (from, to) => {
    const start = html.indexOf(from);
    const end = html.indexOf(to, start);
    assert.ok(start >= 0 && end > start, from);
    return html.slice(start, end);
};
const editorScript = between('    // Редактор «Факт» (v2)', '    async function saveFactAlertPct() {');
const loadScript = between('    const TRIP_FACT_COLUMNS', '    function isVehicleUuid(');
const markup = between('<div id="fact-editor" hidden>', '<div class="comparison-table">');

class El {
    constructor(id, tag) {
        this.id = id || '';
        this.tagName = tag || 'div';
        this.value = '';
        this.hidden = false;
        this.disabled = false;
        this.className = '';
        this.textContent = '';
        this.children = [];
    }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; }
    scrollIntoView() {}
    createTHead() { const n = new El('', 'thead'); this.children.push(n); return n; }
    createTBody() { const n = new El('', 'tbody'); this.children.push(n); return n; }
    insertRow() { const n = new El('', 'tr'); this.children.push(n); return n; }
    insertCell() { const n = new El('', 'td'); this.children.push(n); return n; }
    get text() { return this.textContent + this.children.map((c) => c.text).join(' | '); }
}

function harness(rows, actuals, opts = {}) {
    const ids = [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const nodes = Object.fromEntries(ids.map((id) => [id, new El(id)]));
    ['fact-editor', 'fact-legacy', 'fact-v2', 'fact-manual', 'fact-preview'].forEach((id) => { nodes[id].hidden = true; });
    const calls = { fetch: [], upsert: [], toast: [] };
    const context = {
        console, JSON, Number, String, Math, Object, Promise,
        setTimeout: () => 0, clearTimeout: () => {},
        document: { getElementById: (id) => nodes[id] || null, createElement: (tag) => new El('', tag) },
        savedCalculations: rows, tripActuals: actuals, factEditorId: null, currentOrgRole: opts.role || 'owner',
        currentOrgId: 'org-1', currentUserId: 'user-1', currentSessionToken: 't',
        historyFields: (row) => ({ status: row.status, date: row.tripDate, from: 'Київ', to: 'Львів', name: 'Київ — Львів', revenue: row.revenue, profit: row.profit }),
        canEditSaved: () => true, factWindowOpen: () => true, historyRouteLabel: (f) => f.from + ' → ' + f.to,
        displayMinus: (t) => String(t).replace(/-(?=\d)/g, '−'),
        formatMoney: (n) => Math.round(n) + ' грн', formatHistoryNum: (n, d) => String(Math.round(n * 10 ** (d || 0)) / 10 ** (d || 0)),
        ukDaysLabel: () => 'діб', showToast: (t) => calls.toast.push(t), renderSavedTable: () => {},
        plannedOverheadOf: (row) => (actuals[row.id] ? actuals[row.id].plannedOverhead : 0),
        actualTripProfit: (r, c, o) => (Number(r) >= 0 && Number(c) >= 0 && r !== '' && c !== '' ? Number(r) - Number(c) - Number(o) : null),
        dbErrorText: (e) => String(e && e.message),
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            calls.fetch.push({ url, body, auth: init.headers.Authorization });
            if (opts.offline) throw new Error('offline');
            const row = rows.find((r) => r.id === body.calculationId);
            const built = buildTripFact(row.inputs, body.fact, { revenue: row.revenue, profit: row.profit });
            return { ok: !built.status, json: async () => (built.status ? { code: built.code, error: built.error } : JSON.parse(JSON.stringify(built))) };
        },
        supabaseClient: {
            auth: { getSession: async () => ({ data: { session: { access_token: 'fresh' } } }) },
            from: () => ({
                upsert(payload) {
                    calls.upsert.push(payload);
                    const overhead = payload.fact_version ? 0 : 5000;
                    const saved = Object.assign({}, payload, { planned_overhead: overhead, profit: payload.revenue - payload.costs - overhead });
                    return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
                }
            })
        }
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext('var factEditorMode = "", factPreviewTimer = null, factPreviewSeq = 0, factPreviewData = null, factPreviewKey = "";\n' +
        loadScript + editorScript +
        '\nglobalThis.api = { openFactEditor, startNewTripFact, runFactPreview, saveTripActual, closeFactEditor, tripActualFromRow,' +
        ' mode: () => factEditorMode, columns: TRIP_FACT_COLUMNS };', context);
    return { api: context.api, nodes, calls, context };
}

const inputs = { ...fixtures[0].payload, idleDays: 0, idleRate: 1000 };
const plan = buildTripFact(inputs, {}, null).planNow;
const trip = (id, extra) => Object.assign({ id, status: 'done', tripDate: '2026-10-20', inputs, revenue: plan.revenue, profit: plan.profit }, extra || {});
const flush = () => new Promise((r) => setImmediate(r));

test('editor markup: the fields asked for, theme tokens only, no dialogs, no innerHTML', () => {
    for (const id of ['fact-days', 'fact-loaded-km', 'fact-empty-km', 'fact-podacha', 'fact-paid-idle', 'fact-idle-rate', 'fact-extra', 'fact-extra-note', 'fact-preview', 'fact-save']) {
        assert.match(markup, new RegExp('id="' + id + '"'), id);
    }
    assert.match(markup, /<textarea id="fact-extra-note" maxlength="500"/);
    assert.equal(/style="/.test(markup), false, 'styled by classes (themes)');
    assert.equal(/\b(alert|confirm|prompt)\(/.test(editorScript), false);
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(editorScript), false);
    const css = between('        #fact-editor[hidden], #fact-editor [hidden]', '        .tc-history-actions { display: flex;');
    assert.equal(/#[0-9a-f]{3,6}\b/i.test(css), false, 'colors come from theme variables (Ocean / Dark / Light)');
    assert.match(css, /@media \(max-width: 560px\)/);
});

test('new fact: plan values prefilled, live plan/fact preview, v2 row saved with updated_at', async () => {
    const h = harness([trip('t1')], {});
    h.api.openFactEditor('t1');
    await flush(); await flush();
    assert.equal(h.api.mode(), 'v2');
    assert.equal(h.nodes['fact-v2'].hidden, false);
    assert.equal(h.nodes['fact-manual'].hidden, true);
    const basis = buildTripFact(inputs, {}, null).basis;
    assert.equal(Number(h.nodes['fact-days'].value), basis.tripDays);
    assert.equal(Number(h.nodes['fact-loaded-km'].value), Math.round(basis.loadedKm * 100) / 100);
    assert.equal(h.nodes['fact-paid-idle'].value, '0');
    assert.equal(h.nodes['fact-idle-rate'].value, '1000');
    assert.equal(h.nodes['fact-preview'].hidden, false);
    assert.match(h.nodes['fact-preview'].text, /Дохід/);
    assert.match(h.nodes['fact-preview'].text, /Різниця діб: 0/);
    assert.equal(h.nodes['fact-save'].disabled, false);
    assert.equal(h.calls.fetch[0].url, '/api/calculate?mode=fact');
    assert.equal(h.calls.fetch[0].auth, 'Bearer fresh');

    h.nodes['fact-days'].value = String(basis.tripDays + 3);
    h.nodes['fact-paid-idle'].value = '3';
    h.nodes['fact-extra'].value = '700';
    h.nodes['fact-extra-note'].value = 'Штраф';
    await h.api.saveTripActual();
    const payload = h.calls.upsert[0];
    assert.equal(payload.fact_version, 'v2');
    assert.equal(payload.planned_overhead, 0);
    assert.equal(payload.fact_days, basis.tripDays + 3);
    assert.equal(payload.paid_idle_days, 3);
    assert.equal(payload.extra_costs, 700);
    assert.equal(payload.extra_costs_note, 'Штраф');
    assert.equal(payload.costs, payload.revenue - payload.profit);
    assert.ok(payload.updated_at, 'new site marks its writes for trip_actuals_guard');
    assert.equal(payload.revenue - plan.revenue, 3 * 1000 * basis.tripsCount, 'paid idle adds revenue');
    assert.equal(h.context.tripActuals.t1.version, 'v2');
    assert.deepEqual(h.calls.toast, ['Факт збережено']);
});

test('old manual fact is shown and replaced only after «Внести новий факт»', async () => {
    const actuals = { t2: { revenue: 90000, costs: 60000, plannedOverhead: 5000, profit: 25000, version: null } };
    const h = harness([trip('t2')], actuals);
    h.api.openFactEditor('t2');
    await flush();
    assert.equal(h.api.mode(), 'legacy');
    assert.equal(h.nodes['fact-legacy'].hidden, false);
    assert.equal(h.nodes['fact-v2'].hidden, true);
    assert.equal(h.nodes['fact-save'].hidden, true, 'nothing to save until the user starts a new fact');
    assert.match(h.nodes['fact-legacy-text'].textContent, /дохід 90000 грн, витрати 65000 грн, прибуток 25000 грн/);
    assert.equal(h.calls.fetch.length, 0);
    await h.api.saveTripActual();
    assert.equal(h.calls.upsert.length, 0, 'the old fact is not overwritten');
    h.api.startNewTripFact();
    await flush(); await flush();
    assert.equal(h.api.mode(), 'v2');
    assert.equal(h.nodes['fact-save'].hidden, false);
    assert.equal(h.nodes['fact-save'].textContent, 'Замінити старий факт');
    await h.api.saveTripActual();
    assert.equal(h.calls.upsert.length, 1);
    assert.equal(h.calls.upsert[0].fact_version, 'v2');
});

test('saved v2 fact reopens with its values', async () => {
    const actuals = { t3: { revenue: 1, costs: 1, plannedOverhead: 0, profit: 0, version: 'v2', days: 7.5, loadedKm: 1234, emptyKm: 99, paidIdleDays: 2, idleRate: 800, extraCosts: 150, extraNote: 'Мийка' } };
    const h = harness([trip('t3')], actuals);
    h.api.openFactEditor('t3');
    await flush(); await flush();
    assert.equal(h.nodes['fact-days'].value, '7.5');
    assert.equal(h.nodes['fact-loaded-km'].value, '1234');
    assert.equal(h.nodes['fact-idle-rate'].value, '800');
    assert.equal(h.nodes['fact-extra-note'].value, 'Мийка');
    assert.equal(h.nodes['fact-note-count'].textContent, '5 / 500');
    assert.equal(h.calls.fetch[0].body.fact.tripDays, 7.5, 'unchanged field → the exact saved number');
});

test('round trip: open, change nothing, save → deviation exactly 0 (shown days are rounded, sent days are exact)', async () => {
    const round = { ...inputs, calcType: 'безготівковий', returnMode: 'циклічний', volume: 154, normWeight: 22, carsCount: 3,
        daysPerTrip: 2.35, idleDays: 0.75, idleRate: 0, isRoundTrip: true, rtTotalVolume: 70, rtRate: 950,
        rtBackhaulDist: 830, rtTransferDist: 45, rtReturnDist: 190 };
    const roundPlan = buildTripFact(round, {}, null);
    const exactDays = roundPlan.basis.tripDays;
    assert.ok(!Number.isInteger(exactDays * 100), 'plan days per trip are not a round number: ' + exactDays);
    const h = harness([trip('t7', { inputs: round, revenue: roundPlan.planNow.revenue, profit: roundPlan.planNow.profit })], {});
    h.api.openFactEditor('t7');
    await flush(); await flush();
    assert.equal(h.nodes['fact-days'].value, String(Math.round(exactDays * 100) / 100), 'the field shows the rounded value');
    assert.match(h.nodes['fact-preview'].text, /Прибуток \| [^|]+ \| [^|]+ \| 0 грн · 0%/);
    await h.api.saveTripActual();
    const payload = h.calls.upsert[0];
    assert.equal(payload.revenue, roundPlan.planNow.revenue);
    assert.equal(payload.profit, roundPlan.planNow.profit, 'fact profit = plan profit');
    assert.equal(payload.fact_days, exactDays, 'stores the exact plan days, not the rounded field');
    await h.api.runFactPreview(false);
    const sent = h.calls.fetch[h.calls.fetch.length - 1].body.fact;
    assert.equal(sent.tripDays, exactDays, 'the unchanged (rounded-looking) field sends the exact plan value');
    assert.match(h.nodes['fact-preview'].text, /Різниця діб: 0/);
    // Нічого не змінено → повторне відкриття знову дає 0.
    const again = harness([trip('t7', { inputs: round, revenue: payload.revenue, profit: payload.profit })], { t7: h.context.tripActuals.t7 });
    again.api.openFactEditor('t7');
    await flush(); await flush();
    await again.api.saveTripActual();
    assert.equal(again.calls.upsert[0].profit, roundPlan.planNow.profit);
    // Користувач увів саме те, що бачить (округлене), — це вже зміна, рахується як введено.
    h.nodes['fact-days'].value = h.nodes['fact-days'].value + '1';
    await h.api.runFactPreview(false);
    assert.equal(h.calls.fetch[h.calls.fetch.length - 1].body.fact.tripDays, h.nodes['fact-days'].value);
});

test('a trip without calculator inputs keeps the manual fact (old payload)', async () => {
    const h = harness([trip('t4', { inputs: {} })], {});
    h.api.openFactEditor('t4');
    assert.equal(h.api.mode(), 'manual');
    assert.equal(h.nodes['fact-manual'].hidden, false);
    h.nodes['fact-revenue'].value = '50000';
    h.nodes['fact-costs'].value = '30000';
    await h.api.saveTripActual();
    assert.equal(h.calls.fetch.length, 0);
    assert.equal(h.calls.upsert[0].fact_version, undefined);
    assert.equal(h.calls.upsert[0].revenue, 50000);
});

test('server errors and no connection: message in the editor, save disabled', async () => {
    const h = harness([trip('t5')], {}, { offline: true });
    h.api.openFactEditor('t5');
    await flush(); await flush();
    assert.match(h.nodes['fact-editor-error'].textContent, /Немає звʼязку/);
    assert.equal(h.nodes['fact-save'].disabled, true);
    const bad = harness([trip('t6')], {});
    bad.api.openFactEditor('t6');
    await flush(); await flush();
    bad.nodes['fact-days'].value = '-1';
    await bad.api.runFactPreview(false);
    assert.match(bad.nodes['fact-editor-error'].textContent, /Фактичний час на ходку/);
    await bad.api.saveTripActual();
    assert.equal(bad.calls.upsert.length, 0);
});

test('history loads v2 columns and falls back to the old columns before the migration', () => {
    const h = harness([], {});
    assert.match(h.api.columns, /fact_version/);
    assert.match(loadScript, /select\('calculation_id, revenue, costs, planned_overhead, profit'\)/);
    const row = h.api.tripActualFromRow({ calculation_id: 'x', revenue: '10', costs: '4', planned_overhead: '1', profit: '5' });
    assert.equal(row.version, null);
    assert.equal(row.profit, 5);
    assert.equal(row.days, null);
});
