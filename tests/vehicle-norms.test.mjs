import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { calculateTrip } = await import('../api/calculate.js');
const calculateSource = readFileSync(new URL('../api/calculate.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/calc-golden.json', import.meta.url), 'utf8'));
const oldMigration = readFileSync(new URL('../supabase/migrations/20261012240000_fleet_vehicles.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261013180000_fleet_vehicle_norms.sql', import.meta.url), 'utf8');

function extractFunction(name, params) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) return new Function(...params, html.slice(open + 1, i));
        }
    }
    throw new Error('unclosed ' + name);
}

const vehicleNormNumber = extractFunction('vehicleNormNumber', ['value', 'min', 'max']);
const applyVehicleNorms = extractFunction('applyVehicleNorms', ['base', 'vehicles']);
globalThis.vehicleNormNumber = vehicleNormNumber;

test('a trip without a selected vehicle keeps every golden result', () => {
    for (const scenario of fixtures) {
        assert.deepEqual(calculateTrip(scenario.payload), scenario.expect);
        assert.deepEqual(calculateTrip(applyVehicleNorms(scenario.payload, null)), scenario.expect);
        assert.deepEqual(calculateTrip(applyVehicleNorms(scenario.payload, [])), scenario.expect);
    }
    assert.equal(calculateSource.includes('fleet_vehicles'), false);
    assert.equal(calculateSource.includes('fuel_load'), false);
    assert.equal(calculateSource.includes('adblue_on'), false);
});

test('one truck replaces only its filled norms and sets the vehicle count to one', () => {
    const base = fixtures[0].payload;
    const next = applyVehicleNorms(base, {
        make_model: 'Volvo FH',
        label: 'AA0001KA',
        year_made: 2019,
        trailer_plate: 'AA1111XP',
        fuel_load: 28,
        fuel_empty: 24,
        adblue_on: true,
        adblue_consumption: 4,
        trailer_type: 'тент'
    });
    assert.equal(base.fuelLoad, 37);
    assert.equal(base.carsCount, 3);
    assert.equal(next.fuelLoad, 28);
    assert.equal(next.fuelEmpty, 24);
    assert.equal(next.adblueConsumption, 4);
    assert.equal(next.useAdblue, true);
    assert.equal(next.trailerType, 'тент');
    assert.equal(next.carsCount, 1);
    assert.equal(next.dist, base.dist);
    assert.equal(next.make_model, undefined);
    assert.notEqual(calculateTrip(next).netProfit, fixtures[0].expect.netProfit);
});

test('several trucks average consumption and keep a shared trailer type', () => {
    const base = fixtures[0].payload;
    const averaged = applyVehicleNorms(base, [
        { fuel_load: 30, fuel_empty: 26, adblue_on: true, adblue_consumption: 4, trailer_type: 'тент' },
        { fuel_load: 36, fuel_empty: 30, adblue_on: false, trailer_type: 'тент' }
    ]);
    assert.equal(averaged.fuelLoad, 33);
    assert.equal(averaged.fuelEmpty, 28);
    assert.equal(averaged.adblueConsumption, 2);
    assert.equal(averaged.useAdblue, true);
    assert.equal(averaged.carsCount, 2);
    assert.equal(averaged.trailerType, 'тент');
    const mixed = applyVehicleNorms(base, [
        { trailer_type: 'тент', fuel_load: 30 },
        { trailer_type: 'зерновоз' }
    ]);
    assert.equal(mixed.trailerType, base.trailerType);
    assert.equal(mixed.fuelLoad, (30 + base.fuelLoad) / 2);
    assert.equal(mixed.carsCount, 2);
    const blank = applyVehicleNorms(base, { fuel_load: 0, fuel_empty: 90, trailer_type: 'фургон' });
    assert.equal(blank.fuelLoad, base.fuelLoad);
    assert.equal(blank.fuelEmpty, base.fuelEmpty);
    assert.equal(blank.trailerType, base.trailerType);
    assert.equal(blank.carsCount, 1);
    assert.equal(vehicleNormNumber(80, 0.1, 80), 80);
    assert.equal(vehicleNormNumber(0, 0.1, 80), null);
});

test('the fleet card explains the company template and stores the new columns separately', () => {
    assert.match(html, /id="vehicle-norm-list"/);
    assert.match(html, /Якщо ці дані заповнені і в розрахунку обране це авто або кілька/);
    assert.match(html, /загального шаблону кабінету/);
    assert.match(html, /Марка \/ модель/);
    assert.match(html, /Витрата порожнім, л\/100 км/);
    assert.match(html, /Витрата з вантажем, л\/100 км/);
    assert.match(html, /Держ\. номер причепа/);
    assert.equal(html.includes('norm_weight'), false);
    assert.equal(oldMigration.includes('fuel_load'), false);
    assert.equal(migration.includes('norm_weight'), false);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS make_model/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS year_made/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS adblue_on/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS trailer_plate/);
    assert.match(migration, /year_made >= 1980 AND year_made <= 2100/);
    assert.match(migration, /зерновоз/);
    assert.equal(migration.includes('GRANT'), false);
    assert.equal(migration.includes('calculateTrip'), false);
});
