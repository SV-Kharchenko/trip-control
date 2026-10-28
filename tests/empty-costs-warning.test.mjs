import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const calc = await import('../api/calculate.js');
const { calculateTrip, sumVehicleTrips, emptyCostWarnings, DEFAULT_ADBLUE_RATE, DEFAULT_ADBLUE_PRICE } = calc;

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const S0 = JSON.parse(read('tests/fixtures/s0-fop.json'));
const html = read('index.html');
const keys = (result) => result.warnings.map((item) => item.key);
const row = (result, needle) => result.detailedRows.find((item) => item.name.indexOf(needle) !== -1).val;

const FILLED = {
    amort: '120000', admin: '60000', otherOperating: '30000', otherExpenses: '10000', repair: '50000', fin: '20000'
};

test('S0 regression: profit 6 687, tax 5 400', () => {
    const result = calculateTrip(S0);
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
});

test('empty overheads come back as warnings, one per field', () => {
    assert.deepEqual(calculateTrip(S0).warnings, [
        { key: 'amort', label: 'Амортизація' },
        { key: 'admin', label: 'Адміністративні витрати' },
        { key: 'otherOperating', label: 'Інші операційні витрати' },
        { key: 'otherExpenses', label: 'Інші витрати' },
        { key: 'repair', label: 'Ремонти та інші оп. витрати' },
        { key: 'fin', label: 'Фінансові витрати (кредити)' }
    ]);
    assert.deepEqual(calculateTrip({ ...S0, ...FILLED }).warnings, []);
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, admin: '0', fin: '' })), ['admin', 'fin']);
});

test('every optional cost is checked separately', () => {
    const empty = {
        ...S0, ...FILLED,
        driverRateLoad: '', driverRateEmpty: '0', perDiem: '', toCost: '', tireCost: '0', tireCount: ''
    };
    assert.deepEqual(keys(calculateTrip(empty)), ['driverRateLoad', 'driverRateEmpty', 'perDiem', 'toCost', 'tireCost', 'tireCount']);
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, driverPayMode: 'pct', driverPctVal: '' })), ['driverPctVal']);
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, driverPayMode: 'pct', driverRateLoad: '' })), []);
});

test('wash and reefer fields are checked only for their trailer', () => {
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, trailerType: 'цистерна', washCost: '', washFreq: '' })), ['washCost', 'washFreq']);
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, trailerType: 'цистерна', washCost: '3000', washFreq: '12' })), []);
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, trailerType: 'рефрижератор', refFuelRate: '', refHours: '' })), ['refFuelRate', 'refHours']);
    assert.deepEqual(keys(calculateTrip({ ...S0, ...FILLED, trailerType: 'зерновоз', washCost: '', refFuelRate: '' })), []);
});

test('empty overheads are not replaced with typical values', () => {
    const result = calculateTrip(S0);
    assert.equal(row(result, 'Накладні до EBITDA'), 0);
    assert.equal(row(result, 'Амортизація'), 0);
    assert.equal(emptyCostWarnings({ amort: '-5' })[0].key, 'amort');
});

test('AdBlue on without a rate or price uses 2.5 l/100 km and 18 UAH/l', () => {
    assert.equal(DEFAULT_ADBLUE_RATE, 2.5);
    assert.equal(DEFAULT_ADBLUE_PRICE, 18);
    const explicit = calculateTrip({ ...S0, adblueConsumption: '2.5', adbluePrice: '18' });
    for (const blank of ['', '0', null, undefined]) {
        const result = calculateTrip({ ...S0, adblueConsumption: blank, adbluePrice: blank });
        assert.equal(row(result, 'AdBlue'), row(explicit, 'AdBlue'));
        assert.equal(result.netProfit, explicit.netProfit);
    }
    // 542 × 3 + 542 × 2 + 50 = 2 760 км × 2.5 / 100 × 18 = 1 242 грн
    assert.equal(row(explicit, 'AdBlue'), 1242);
    assert.equal(row(calculateTrip({ ...S0, adbluePrice: '' }), 'AdBlue'), row(calculateTrip(S0), 'AdBlue'));
    assert.equal(keys(calculateTrip({ ...S0, adblueConsumption: '' })).some((key) => /adblue/i.test(key)), false);
});

test('AdBlue on in a vehicle card without a rate also uses the default', () => {
    const base = { ...S0, useAdblue: false, adblueConsumption: '', adbluePrice: '' };
    const result = sumVehicleTrips(base, [{ tonnage: 60, label: 'AA1111AA', useAdblue: true }]);
    assert.equal(row(result, 'AdBlue'), 1242);
});

test('AdBlue off is 0 with no warning', () => {
    const result = calculateTrip({ ...S0, useAdblue: false, adblueConsumption: '', adbluePrice: '' });
    assert.equal(row(result, 'AdBlue'), 0);
    assert.equal(keys(result).some((key) => /adblue/i.test(key)), false);
    const vehicle = sumVehicleTrips(S0, [{ tonnage: 60, label: 'AA1111AA', useAdblue: false }]);
    assert.equal(row(vehicle, 'AdBlue'), 0);
});

test('several vehicles return each warning once', () => {
    const result = sumVehicleTrips(S0, [{ tonnage: 30, label: 'A' }, { tonnage: 30, label: 'B' }]);
    assert.deepEqual(keys(result), ['amort', 'admin', 'otherOperating', 'otherExpenses', 'repair', 'fin']);
});

// Мінімальний DOM для блоку попереджень: функції беремо прямо з index.html.
function fakeElement(tag) {
    return {
        tag, children: [], hidden: false, className: '', type: '', id: '', listeners: {}, focused: false, panel: null,
        _text: '',
        get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
        set textContent(value) { this._text = String(value); this.children = []; },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(name, fn) { this.listeners[name] = fn; },
        click() { if (this.listeners.click) this.listeners.click(); },
        focus() { this.focused = true; },
        scrollIntoView() {},
        closest() { return this.panel; }
    };
}

function warningUi({ role, fields = {} }) {
    const start = html.indexOf('    // Усі статті вводяться в калькуляторі');
    const end = html.indexOf('    function applyCalcResult(');
    assert.ok(start > 0 && end > start);
    const box = fakeElement('div');
    const inputs = {};
    for (const [id, step] of Object.entries(fields)) {
        inputs[id] = fakeElement('input');
        inputs[id].id = id;
        if (step) inputs[id].panel = { id: 'tc-step-panel-' + step };
    }
    const calls = [];
    const document = {
        getElementById: (id) => (id === 'cost-warnings' ? box : inputs[id] || null),
        createElement: fakeElement
    };
    const dock = [];
    const plural = (n, forms) => (n % 10 === 1 && n % 100 !== 11 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? forms[1] : forms[2]);
    const render = new Function('document', 'currentOrgRole', 'openCabinet', 'switchCabTab', 'showCalcStep', 'toggleResultDock', 'plural',
        html.slice(start, end) + '\nreturn renderCostWarnings;')(
        document, role,
        () => calls.push('openCabinet'),
        (tab) => calls.push('tab:' + tab),
        (step) => calls.push('step:' + step),
        (open) => dock.push(open),
        plural
    );
    const full = () => box.children.find((child) => child.className === 'tc-cost-warn-full');
    const short = () => box.children.find((child) => child.className === 'tc-cost-warn-short');
    const buttons = () => full().children.filter((child) => child.tag === 'button');
    return { box, inputs, calls, dock, full, short, buttons, render };
}

const OVERHEAD_WARNINGS = [{ key: 'amort', label: 'Амортизація' }, { key: 'fin', label: 'Фінансові витрати (кредити)' }];
const WARNING_TEXT = '⚠ Не заповнено: Амортизація, Фінансові витрати (кредити). Ці статті рахуються як 0 — витрати можуть бути занижені, а прибуток завищений.';
const REEF_WARNINGS = [{ key: 'refHours', label: 'Години роботи рефрижератора' }, { key: 'refFuelRate', label: 'Витрата пального рефрижератора' }];

test('overhead warnings are shown for owner and logist without a cabinet button or note', () => {
    for (const role of ['owner', 'logist']) {
        const ui = warningUi({ role });
        ui.render({ warnings: OVERHEAD_WARNINGS });
        assert.equal(ui.box.hidden, false);
        assert.equal(ui.full().children[0].textContent, WARNING_TEXT);
        assert.equal(ui.buttons().length, 0);
        assert.equal(ui.full().textContent, WARNING_TEXT);
        assert.deepEqual(ui.calls, []);
    }
    assert.equal(html.includes('openCostsCabinet'), false, '«Значення за замовчуванням» прибрано разом зі сторінкою');
    assert.equal(html.includes('Заповнити в кабінеті'), false);
});

test('trip-only warnings focus the calculator field instead of the cabinet', () => {
    for (const role of ['owner', 'logist']) {
        const ui = warningUi({ role, fields: { 'ref-fuel-rate': 4, 'ref-hours': 4 } });
        ui.render({ warnings: REEF_WARNINGS });
        assert.deepEqual(ui.buttons().map((b) => b.textContent), ['Заповнити в калькуляторі']);
        assert.equal(ui.full().textContent.includes('Попросіть власника'), false);
        ui.buttons()[0].click();
        assert.deepEqual(ui.calls, ['step:4']);
        assert.equal(ui.inputs['ref-hours'].focused, true);
        assert.equal(ui.inputs['ref-fuel-rate'].focused, false);
    }
});

test('tank with empty wash: the button focuses wash-cost on step 4', () => {
    for (const role of ['owner', 'logist']) {
        const ui = warningUi({ role, fields: { 'wash-cost': 4, 'wash-freq': 4 } });
        ui.render({ warnings: [{ key: 'washCost', label: 'Вартість промивки цистерни' }, { key: 'washFreq', label: 'Промивок на рік' }] });
        assert.deepEqual(ui.buttons().map((b) => b.textContent), ['Заповнити в калькуляторі']);
        ui.buttons()[0].click();
        assert.deepEqual(ui.calls, ['step:4']);
        assert.equal(ui.inputs['wash-cost'].focused, true);
        assert.equal(ui.inputs['wash-freq'].focused, false);
    }
});

test('wash fields live on calculator step 4 next to the reefer fields', () => {
    const sync = html.slice(html.indexOf('<div id="main-sync-fields"'), html.indexOf('<div class="card" id="saved-section"'));
    assert.ok(sync.length > 0);
    assert.doesNotMatch(sync, /wash-cost|wash-freq/);
    assert.match(html, /id="ref-hours"[\s\S]{0,200}<div class="form-row dynamic-field" id="field-wash-cost">\s*<label for="wash-cost">Вартість промивки цистерни:<\/label>\s*<input type="number" id="wash-cost" oninput="calculate\(\)">/);
    assert.match(html, /<div class="form-row dynamic-field" id="field-wash-freq">\s*<label for="wash-freq">Промивок на рік:<\/label>\s*<input type="number" id="wash-freq" oninput="calculate\(\)">/);
    assert.match(html, /take\(4, rowOf\('ref-hours'\)\);\s*take\(4, rowOf\('wash-cost'\)\);\s*take\(4, rowOf\('wash-freq'\)\);/);
    // Видимість лише для цистерни — наявна логіка .dynamic-field.active.
    assert.match(html, /if \(trailer === 'цистерна'\) \{ washCost\.classList\.add\('active'\); washFreq\.classList\.add\('active'\); \}/);
    // Payload і відкриття збереженого розрахунку читають ті самі id.
    assert.match(html, /washCost: document\.getElementById\('wash-cost'\) \? document\.getElementById\('wash-cost'\)\.value : 0,/);
    assert.match(html, /\['washCost', 'wash-cost'\], \['washFreq', 'wash-freq'\]/);
});

test('a trip field that is on no calculator step gets no button', () => {
    const ui = warningUi({ role: 'owner', fields: { 'ref-fuel-rate': 0 } });
    ui.render({ warnings: [{ key: 'refFuelRate', label: 'Витрата пального рефрижератора' }] });
    assert.equal(ui.box.hidden, false);
    assert.equal(ui.buttons().length, 0);
    assert.equal(ui.full().textContent.includes('Попросіть власника'), false);
});

const MIXED_WARNINGS = [
    { key: 'amort', label: 'Амортизація' },
    { key: 'washCost', label: 'Вартість промивки цистерни' },
    { key: 'washFreq', label: 'Промивок на рік' }
];

test('mixed warnings: only the calculator button, no cabinet button or note', () => {
    for (const role of ['owner', 'logist']) {
        const ui = warningUi({ role, fields: { 'wash-cost': 4, 'wash-freq': 4 } });
        ui.render({ warnings: MIXED_WARNINGS });
        assert.deepEqual(ui.buttons().map((b) => b.textContent), ['Заповнити в калькуляторі']);
        assert.equal(ui.full().textContent.includes('Попросіть власника'), false);
        ui.buttons()[0].click();
        assert.deepEqual(ui.calls, ['step:4']);
        assert.equal(ui.inputs['wash-cost'].focused, true);
    }
});

test('mobile: the collapsed dock shows only a short line that opens the dock', () => {
    const ui = warningUi({ role: 'owner', fields: { 'wash-cost': 4, 'wash-freq': 4 } });
    ui.render({ warnings: MIXED_WARNINGS });
    assert.equal(ui.short().textContent, '⚠ Не заповнено: 3 статті');
    assert.equal(ui.short().type, 'button');
    ui.short().click();
    assert.deepEqual(ui.dock, [true]);
    // Дія згортає док перед переходом.
    ui.buttons()[0].click();
    assert.deepEqual(ui.dock, [true, false]);
    const one = warningUi({ role: 'owner' });
    one.render({ warnings: [{ key: 'amort', label: 'Амортизація' }] });
    assert.equal(one.short().textContent, '⚠ Не заповнено: 1 стаття');
    const many = warningUi({ role: 'owner' });
    many.render({ warnings: calculateTrip(S0).warnings });
    assert.equal(many.short().textContent, '⚠ Не заповнено: 6 статей');
    // Короткий рядок видно лише на мобільному в згорнутому доку, повний текст там сховано.
    assert.match(html, /\.tc-cost-warn-short \{ display: none; \}/);
    const mobile = html.slice(html.indexOf('/* Док результату: згорнутий'), html.indexOf('/* Док результату: згорнутий') + 6000);
    assert.match(mobile, /#dispatcher-result:not\(\.is-open\) \.tc-cost-warn-full \{ display: none; \}/);
    assert.match(mobile, /#dispatcher-result:not\(\.is-open\) \.tc-cost-warn-short \{\s*display: block;/);
});

test('step 4 labels focus their inputs', () => {
    for (const id of ['ref-fuel-rate', 'ref-hours', 'wash-cost', 'wash-freq']) {
        assert.match(html, new RegExp('<label for="' + id + '">[^<]+</label>\\s*<input type="number" id="' + id + '"'));
    }
});

test('no warnings, no block', () => {
    const ui = warningUi({ role: 'owner' });
    ui.render({ warnings: OVERHEAD_WARNINGS });
    ui.render({ warnings: [] });
    assert.equal(ui.box.hidden, true);
    assert.equal(ui.box.children.length, 0);
    ui.render(null);
    assert.equal(ui.box.hidden, true);
    assert.match(html, /<div class="tc-cost-warn" id="cost-warnings" role="status" hidden><\/div>/);
    assert.match(html, /renderCostWarnings\(result\);\s*renderChart\(/);
    assert.match(html, /function clearCalcVisuals\(\) \{\s*paintProfitHero\(null\);\s*renderCostWarnings\(null\);/);
});
