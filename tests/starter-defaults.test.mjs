import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { calculateTrip } = await import('../api/calculate.js');
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const literal = (name) => Function('return ' + html.match(new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\});'))[1])();
const STARTER_SETTINGS = literal('STARTER_SETTINGS');
const STARTER_TRIP = literal('STARTER_TRIP');

test('starter template for an empty cabinet: 1 truck, 38 / 32 l, 95 UAH/l, per diem 500', () => {
    assert.deepEqual(STARTER_SETTINGS, {
        totalFleet: 1,
        fuelLoad: 38,
        fuelEmpty: 32,
        fuelPrice: 95,
        // AdBlue, driver rates, service and tyres unchanged.
        adblueEnable: 'on',
        adblueConsumption: 2.85,
        adbluePrice: 18,
        driverPayMode: 'km',
        driverRateLoad: 4.03,
        driverRateEmpty: 2.3,
        driverPctVal: 12,
        perDiem: 500,
        toCost: 18000,
        toPeriod: 50000,
        tireCost: 16500,
        tireCount: 14,
        tireMileage: 150000
    });
});

test('demo trip: one truck, the rest unchanged', () => {
    assert.deepEqual(STARTER_TRIP, {
        'route-name': 'Демо: типовий рейс зерновоза',
        'podacha-dist': 40,
        dist: 350,
        volume: 500,
        'norm-weight': 21.5,
        'cars-count': 1,
        'days-per-trip': 1.5,
        rate: 1800
    });
});

test('demo trip clears the fleet choice first, so restoring norms cannot overwrite the demo fields', () => {
    const start = html.indexOf('    function fillDemoTrip() {');
    const fn = html.slice(start, html.indexOf('\n    }\n', start));
    const clear = fn.indexOf('clearVehicleNormChoice();');
    assert.ok(clear !== -1 && clear < fn.indexOf('Object.keys(STARTER_TRIP)'), 'clearVehicleNormChoice() before STARTER_TRIP');
    assert.equal(fn.split('clearVehicleNormChoice();').length - 1, 1, 'only one clearVehicleNormChoice() call');
    assert.match(fn, /^    function fillDemoTrip\(\) \{\n(\s*\/\/.*\n)?\s+clearVehicleNormChoice\(\);/);
});

test('S0 has its own inputs and does not move: 6 687 / 5 400', () => {
    const s0 = JSON.parse(read('tests/fixtures/s0-fop.json'));
    assert.equal(s0.fuelPrice, '57');
    assert.equal(s0.perDiem, '850');
    const result = calculateTrip(s0);
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
});
