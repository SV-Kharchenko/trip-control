import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { calculateTrip } = await import('../api/calculate.js');
const source = readFileSync(new URL('../api/calculate.js', import.meta.url), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/calc-golden.json', import.meta.url), 'utf8'));

test('golden trips keep the current calculation', () => {
    assert.equal(fixtures.length >= 4, true);
    const names = fixtures.map((item) => item.name);
    assert.equal(names.includes('Київ — Львів'), true);
    assert.equal(names.includes('Львів — Одеса'), true);
    assert.equal(names.includes('Одеса — Київ'), true);
    for (const scenario of fixtures) {
        // warnings — довідка про порожні статті, на гроші не впливає.
        const { warnings, ...money } = calculateTrip(scenario.payload);
        assert.deepEqual(money, scenario.expect);
        assert.equal(Array.isArray(warnings), true);
        assert.equal(typeof scenario.expect.netProfit, 'number');
        assert.equal(scenario.expect.status, undefined);
    }
});

test('a broken contract rate is rejected before any money is returned', () => {
    const base = fixtures[0].payload;
    assert.deepEqual(calculateTrip({ ...base, contractCurrency: 'EUR', fxRate: 1 }), {
        status: 400,
        code: 'BAD_FX',
        error: 'Немає курсу НБУ для валюти контракту. Оновіть сторінку.'
    });
    assert.deepEqual(calculateTrip({ ...base, contractCurrency: 'PLN' }), {
        status: 400,
        code: 'BAD_CCY',
        error: 'Валюта контракту: гривня, долар або євро.'
    });
});

test('the request handler still wraps the same function and keeps the demo flag', () => {
    assert.match(source, /export function calculateTrip\(body\)/);
    assert.match(source, /: calculateTrip\(req\.body \|\| \{\}\)/);
    assert.match(source, /sumVehicleTrips\(req\.body \|\| \{\}, vehicleSplit\.list\)/);
    assert.match(source, /demo: demoInfo/);
    assert.match(source, /grossIncome \* 0\.06/);
    assert.match(source, /const workDaysYear = 300/);
    assert.match(source, /const vatDivisor = calcType === 'безготівковий' \? 1\.2 : 1\.0/);
});
