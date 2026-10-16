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

test('UI shows the warning block with a cabinet button and no block without warnings', () => {
    assert.match(html, /<div class="tc-cost-warn" id="cost-warnings" role="status" hidden><\/div>/);
    assert.match(html, /'⚠ Не заповнено: ' \+ list\.map\(function \(item\) \{ return item\.label; \}\)\.join\(', '\) \+\s*'\. Ці статті рахуються як 0 — витрати можуть бути занижені, а прибуток завищений\.'/);
    assert.match(html, /button\.textContent = 'Заповнити в кабінеті';/);
    assert.match(html, /function openCostsCabinet\(\) \{\s*openCabinet\(\);\s*switchCabTab\('costs'\);/);
    assert.match(html, /if \(!list\.length\) \{\s*box\.hidden = true;/);
    assert.match(html, /renderCostWarnings\(result\);\s*renderChart\(/);
    assert.match(html, /function clearCalcVisuals\(\) \{\s*paintProfitHero\(null\);\s*renderCostWarnings\(null\);/);
});

test('cabinet: AdBlue rate defaults to 2.5, starter template keeps S0 at 2.85', () => {
    assert.match(html, /const DEFAULT_ADBLUE_RATE = 2\.5;/);
    assert.match(html, /enable\.value === 'on' && !\(parseFloat\(rate\.value\) > 0\)\) rate\.value = DEFAULT_ADBLUE_RATE;/);
    assert.match(html, /addEventListener\('change', fillCabAdblueDefault\)/);
    assert.match(html, /adblueConsumption: 2\.85,/);
});

test('cabinet highlights empty optional costs', () => {
    assert.match(html, /<small class="cab-empty-hint" hidden>Порожньо = 0 у розрахунку<\/small>/);
    const list = html.match(/const CAB_OPTIONAL_COST_KEYS = \[([^\]]+)\]/)[1];
    for (const key of ['amort', 'admin', 'otherOperating', 'otherExpenses', 'repair', 'fin', 'driverRateLoad', 'driverRateEmpty', 'driverPctVal', 'perDiem', 'toCost', 'tireCost', 'tireCount']) {
        assert.match(list, new RegExp("'" + key + "'"));
    }
    for (const required of ['totalFleet', 'toPeriod', 'tireMileage', 'fuelPrice']) {
        assert.doesNotMatch(list, new RegExp("'" + required + "'"));
    }
    assert.match(html, /row\.classList\.toggle\('is-empty-cost', empty\);/);
    assert.match(html, /fillCabAdblueDefault\(\);\s*refreshCabEmptyHints\(\);/);
});
