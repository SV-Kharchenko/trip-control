// Розцінка «за тонну» / «за ходку»: у розрахунок завжди йде ціна за тонну (сума за ходку ÷ об'єм); режим і сума зберігаються в inputs заявки.
// Функції беруться з index.html і виконуються з підставним DOM; доходи рахує справжній api/calculate.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const { calculateTrip } = await import('../api/calculate.js');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const S0 = JSON.parse(fs.readFileSync(new URL('./fixtures/s0-fop.json', import.meta.url), 'utf8'));

function functionSource(source, name) {
    const start = source.indexOf((source.includes('async function ' + name + '(') ? 'async function ' : 'function ') + name + '(');
    assert.notEqual(start, -1, name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error('unclosed ' + name);
}
const tripFieldMap = html.match(/const TRIP_FIELD_MAP = (\[[\s\S]*?\n    \]);/)[1];

function form(initial = {}) {
    const els = new Map();
    const get = (id) => {
        if (!els.has(id)) els.set(id, { id, value: '', dataset: {}, hidden: false, textContent: '', style: {}, classList: { toggle() {}, add() {}, remove() {} } });
        return els.get(id);
    };
    for (const [id, value] of Object.entries(initial)) get(id).value = value;
    get('rate-mode').value = 'ton';
    get('rate-field-label').textContent = 'Тариф';
    get('contract-currency').options = ['UAH', 'USD', 'EUR'].map((value) => ({ value, textContent: { UAH: 'грн/т', USD: '$/т', EUR: '€/т' }[value] }));
    get('rate').setAttribute = function (k, v) { this.aria = v; };
    const factory = new Function('get', `
        const document = { getElementById: get };
        let contractCurrency = 'UAH';
        let lastCalcData = {}, lastExport = null;
        const calls = [];
        const TRIP_FIELD_MAP = ${tripFieldMap};
        const setCurrentCalc = () => {}, setPlaceText = () => {}, applySavedVehicles = () => {}, showCalcStep = () => {}, updateRouteBar = () => {}, showToast = () => {};
        const contractFx = () => 1, clientNameValue = () => '', vehiclesForCalc = () => [], readVehicleAssignments = () => [];
        const vehicleSourceMode = 'auto', vehicleSplitMode = 'auto';
        const calculate = () => calls.push('calculate');
        const nodes = (id) => document.getElementById(id);
        ${['rateModeValue', 'ratePerTonFromTrip', 'effectiveRateValue', 'syncRateMode', 'setRateMode', 'onRateModeChange', 'updateContractCurrencyUi', 'applyTripInputs', 'readTripPayload']
            .map((n) => functionSource(html, n)).join('\n')}
        return { rateModeValue, effectiveRateValue, syncRateMode, updateContractCurrencyUi, onRateModeChange, applyTripInputs, readTripPayload, calls, setCurrency: (c) => { contractCurrency = c; } };
    `);
    return { ...factory(get), get };
}
const note = (f) => f.get('rate-eff-note');

test('за ходку: 22 000 при об\'єму 22 т = 1 000 грн/т, дохід такий самий, як при розцінці 1 000 грн/т', () => {
    const f = form({ volume: '22', rate: '22000' });
    f.get('rate-mode').value = 'trip';
    f.get('rate').dataset.mode = 'ton';
    f.onRateModeChange();
    f.get('rate').value = '22000';
    f.syncRateMode();
    assert.equal(f.effectiveRateValue(), '1000');
    assert.equal(note(f).hidden, false);
    assert.match(note(f).textContent, /^= 1\s?000 грн\/т$/);
    assert.equal(f.get('rate-unit').textContent, 'грн');
    const base = { ...S0, volume: '22', carsCount: '1' };
    const perTrip = calculateTrip({ ...base, rate: f.effectiveRateValue() });
    const perTon = calculateTrip({ ...base, rate: '1000' });
    assert.equal(perTrip.grossIncome, perTon.grossIncome);
    assert.equal(perTrip.grossIncome, 22 * 1000);
    assert.equal(perTrip.netProfit, perTon.netProfit);
    // Не-цілий результат: сума за ходку 10 000, об'єм 3 т → дохід лишається 10 000 (без втрати копійок на округленні ціни).
    const odd = calculateTrip({ ...S0, volume: '3', rate: String(Math.round(10000 / 3 * 1e6) / 1e6) });
    assert.ok(Math.abs(odd.grossIncome - 10000) < 0.01);
});

test('об\'єм порожній або 0: ділення на нуль немає, у розрахунок іде порожня ціна, підказка попереджає', () => {
    for (const volume of ['', '0', '-5', 'abc']) {
        const f = form({ volume, rate: '22000' });
        f.get('rate-mode').value = 'trip';
        f.syncRateMode();
        assert.equal(f.effectiveRateValue(), '', 'volume=' + volume);
        const payload = f.readTripPayload();
        assert.equal(payload.rate, '');
        assert.equal(/Infinity|NaN/.test(JSON.stringify(payload)), false);
        assert.equal(note(f).textContent, 'Вкажи об\'єм, щоб порахувати ціну за тонну');
    }
    // calculate() не запускає розрахунок без об'єму в режимі «за ходку» (навіть у разовому рейсі, де «Обсяг» інакше не обов'язковий).
    const calc = functionSource(html, 'calculate');
    assert.match(calc, /rateModeValue\(\) === 'trip' && !\(parseFloat\(document\.getElementById\('volume'\)\.value\) > 0\)[^]*?missing\.push\(\['volume', 'Обсяг'\]\)/);
    assert.ok(calc.indexOf("missing.push(['volume'") < calc.indexOf('const payload = readTripPayload();'));
});

test('режим за тонну (за замовчуванням): rate = поле як є, нічого не ділиться', () => {
    const f = form({ volume: '22', rate: '1800' });
    assert.equal(f.rateModeValue(), 'ton');
    assert.equal(f.effectiveRateValue(), '1800');
    const payload = f.readTripPayload();
    assert.equal(payload.rate, '1800');
    assert.equal(payload.rateMode, 'ton');
    assert.equal(payload.rateTrip, '');
    f.syncRateMode();
    assert.equal(note(f).hidden, true);
    assert.equal(f.get('rate-unit').textContent, 'грн/т');
    assert.match(html, /<option value="ton" selected>Вартість за тонну<\/option>/);
});

test('перемикання режимів: за ходку → за тонну підставляє пораховану ціну; за тонну → за ходку не видає 1 800 грн/т за суму', () => {
    const f = form({ volume: '22', rate: '1800' });
    // за тонну → за ходку: поле очищається
    f.get('rate-mode').value = 'trip';
    f.onRateModeChange();
    assert.equal(f.get('rate').value, '', 'стару ціну за тонну не сприймаємо як суму за ходку');
    assert.equal(f.get('rate-unit').textContent, 'грн');
    f.get('rate').value = '22000';
    f.syncRateMode();
    // за ходку → за тонну: підставляється 1000
    f.get('rate-mode').value = 'ton';
    f.onRateModeChange();
    assert.equal(f.get('rate').value, '1000');
    assert.equal(f.get('rate-unit').textContent, 'грн/т');
    // і назад: повертається введена сума
    f.get('rate-mode').value = 'trip';
    f.onRateModeChange();
    assert.equal(f.get('rate').value, '22000');
    assert.ok(f.calls.length >= 3 && f.calls.every((c) => c === 'calculate'));
    // без валідного об'єму при поверненні «за тонну» поле очищається, а не лишає суму як ціну
    const g = form({ volume: '', rate: '' });
    g.get('rate-mode').value = 'trip';
    g.onRateModeChange();
    g.get('rate').value = '22000';
    g.get('rate-mode').value = 'ton';
    g.onRateModeChange();
    assert.equal(g.get('rate').value, '');
});

test('валюта контракту в одиницях: «EUR» (за ходку) / «EUR/т»', () => {
    const f = form({ volume: '20', rate: '2000' });
    f.setCurrency('EUR');
    f.get('rate-mode').value = 'trip';
    f.syncRateMode();
    assert.equal(f.get('rate-unit').textContent, 'EUR');
    assert.match(note(f).textContent, /^= 100 EUR\/т$/);
    f.get('rate-mode').value = 'ton';
    f.syncRateMode();
    assert.equal(f.get('rate-unit').textContent, 'EUR/т');
});

test('збереження й повторне відкриття: «за ходку» і сума відновлюються; стара заявка без режиму = «за тонну»', () => {
    const a = form({ volume: '22', rate: '22000' });
    a.get('rate-mode').value = 'trip';
    a.get('rate').dataset.mode = 'trip';
    const saved = JSON.parse(JSON.stringify(a.readTripPayload())); // як у inputs розрахунку
    assert.equal(saved.rate, '1000', 'у inputs.rate лежить ефективна ціна за тонну, тож історія й звіти читають її як раніше');
    assert.equal(saved.rateMode, 'trip');
    assert.equal(saved.rateTrip, '22000');

    const b = form();
    b.applyTripInputs(saved, 'Маршрут');
    assert.equal(b.get('rate-mode').value, 'trip');
    assert.equal(b.get('rate').value, '22000');
    assert.equal(b.get('volume').value, '22');
    assert.equal(b.effectiveRateValue(), '1000');
    assert.equal(b.get('rate-unit').textContent, 'грн');

    // Стара заявка (без rateMode / rateTrip) відкривається «за тонну», навіть якщо форма була в режимі «за ходку».
    const old = { volume: '22', rate: '1800', contractCurrency: 'UAH' };
    b.applyTripInputs(old, 'Стара');
    assert.equal(b.get('rate-mode').value, 'ton');
    assert.equal(b.get('rate').value, '1800');
    assert.equal(b.effectiveRateValue(), '1800');
    assert.equal(b.get('rate-unit').textContent, 'грн/т');
    // rateMode=trip без суми — теж «за тонну» (не ламаємо ціною).
    b.applyTripInputs({ volume: '22', rate: '1000', rateMode: 'trip', rateTrip: '' }, 'X');
    assert.equal(b.get('rate-mode').value, 'ton');
});

test('перемикач стосується лише основної розцінки: зворотний вантаж без режиму, лендинг без змін, формули не чіпали', () => {
    assert.equal(html.includes('id="rt-rate-mode"'), false);
    const landing = html.slice(html.indexOf('<div id="landing-screen" hidden>'), html.indexOf('<div id="auth-screen">'));
    assert.equal(/rate-mode|Вартість за ходку/.test(landing), false);
    assert.match(html, /rate: effectiveRateValue\(\),\n\s+rateMode: rateModeValue\(\),/);
    assert.match(html, /take\(2, document\.getElementById\('rate-mode-box'\)\);/);
    assert.match(html, /opCell\('tc-f-rate', 'Тариф', \[rateRow, opById\('rate-mode-box'\)\]\)/);
});

test('лейбл і суфікси: «за ходку» → «Вартість за ходку» і грн / $ / €; назад у «за тонну» → «Тариф» і грн/т / $/т / €/т', () => {
    const f = form({ volume: '22', rate: '30000' });
    const opts = () => f.get('contract-currency').options.map((o) => o.textContent);
    const label = () => f.get('rate-field-label').textContent;
    f.syncRateMode();
    assert.equal(label(), 'Тариф');
    assert.deepEqual(opts(), ['грн/т', '$/т', '€/т']);
    assert.equal(f.get('rate-unit').textContent, 'грн/т');

    f.get('rate-mode').value = 'trip';
    f.syncRateMode();
    assert.equal(label(), 'Вартість за ходку');
    assert.equal(f.get('rate').aria, 'Вартість за ходку');
    assert.deepEqual(opts(), ['грн', '$', '€']);
    assert.equal(f.get('rate-unit').textContent, 'грн');
    assert.deepEqual(f.get('contract-currency').options.map((o) => o.value), ['UAH', 'USD', 'EUR'], 'value валют не змінюється');
    assert.match(note(f).textContent, / грн\/т$/, 'підказка лишається перерахунком на тонну');

    f.setCurrency('USD');
    f.updateContractCurrencyUi();
    assert.equal(f.get('rate-unit').textContent, 'USD');
    assert.deepEqual(opts(), ['грн', '$', '€']);

    f.get('rate-mode').value = 'ton';
    f.syncRateMode();
    assert.equal(label(), 'Тариф');
    assert.equal(f.get('rate').aria, 'Тариф');
    assert.deepEqual(opts(), ['грн/т', '$/т', '€/т']);
    assert.equal(f.get('rate-unit').textContent, 'USD/т');
    assert.equal(f.get('rt-rate-unit').textContent === '' || f.get('rt-rate-unit').textContent === 'USD/т', true, 'зворотний вантаж лишається «/т»');
});

test('відновлена заявка «за ходку» одразу показує лейбл і суфікс; стара заявка — «Тариф» і грн/т', () => {
    const f = form();
    f.applyTripInputs({ volume: '22', rate: '1363.64', rateMode: 'trip', rateTrip: '30000' }, 'X');
    assert.equal(f.get('rate-field-label').textContent, 'Вартість за ходку');
    assert.equal(f.get('rate-unit').textContent, 'грн');
    assert.deepEqual(f.get('contract-currency').options.map((o) => o.textContent), ['грн', '$', '€']);
    f.applyTripInputs({ volume: '22', rate: '1800' }, 'Old');
    assert.equal(f.get('rate-field-label').textContent, 'Тариф');
    assert.deepEqual(f.get('contract-currency').options.map((o) => o.textContent), ['грн/т', '$/т', '€/т']);
});

test('вихідний код: лейбл має id, компактна розкладка синхронізує підписи, #rt-rate-unit і лендинг не чіпали', () => {
    assert.ok(html.includes('<label id="rate-field-label">Розцінка (з ПДВ / ФОП):</label>'));
    assert.ok(html.includes("opCell('tc-f-rate', 'Тариф', [rateRow, opById('rate-mode-box')])"));
    assert.ok(html.includes('<span class="unit" id="rt-rate-unit">грн/т</span>'));
    assert.ok(html.includes('id="t-rate-unit">грн/т</span>'));
    assert.ok(html.includes('<option value="UAH" selected>грн/т</option>'));
    assert.equal(html.includes("' за ходку'"), false);
});
