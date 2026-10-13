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
            if (depth === 0) {
                return new Function(...params, html.slice(open + 1, i));
            }
        }
    }
    throw new Error('unclosed ' + name);
}

const vehicleNormNumber = extractFunction('vehicleNormNumber', ['value', 'min', 'max']);
const vehicleNormPatch = extractFunction('vehicleNormPatch', ['vehicle']);
const applyVehicleNorms = extractFunction('applyVehicleNorms', ['base', 'vehicle']);
globalThis.vehicleNormNumber = vehicleNormNumber;
globalThis.vehicleNormPatch = vehicleNormPatch;

test('a trip without a vehicle keeps every golden result', () => {
    for (const scenario of fixtures) {
        assert.deepEqual(calculateTrip(scenario.payload), scenario.expect);
        assert.deepEqual(calculateTrip(applyVehicleNorms(scenario.payload, null)), scenario.expect);
        assert.deepEqual(calculateTrip(applyVehicleNorms(scenario.payload, {})), scenario.expect);
        assert.deepEqual(calculateTrip(applyVehicleNorms(scenario.payload, {
            fuel_load: '',
            fuel_empty: 0,
            norm_weight: 100,
            trailer_type: 'фургон'
        })), scenario.expect);
    }
    assert.equal(calculateSource.includes('fleet_vehicles'), false);
    assert.equal(calculateSource.includes('fuel_load'), false);
});

test('filled vehicle norms replace only those inputs and do not mutate the company payload', () => {
    const base = fixtures[0].payload;
    const vehicle = { fuel_load: 28, fuel_empty: 24, norm_weight: 22, trailer_type: 'тент', label: 'AA0001KA' };
    const next = applyVehicleNorms(base, vehicle);
    assert.equal(base.fuelLoad, 37);
    assert.equal(base.trailerType, 'тент');
    assert.equal(next.fuelLoad, 28);
    assert.equal(next.fuelEmpty, 24);
    assert.equal(next.normWeight, 22);
    assert.equal(next.trailerType, 'тент');
    assert.equal(next.dist, base.dist);
    assert.equal(next.rate, base.rate);
    assert.notEqual(calculateTrip(next).netProfit, fixtures[0].expect.netProfit);
    const fuelOnly = applyVehicleNorms(base, { fuel_load: 28 });
    assert.equal(fuelOnly.fuelLoad, 28);
    assert.equal(fuelOnly.fuelEmpty, base.fuelEmpty);
    assert.equal(fuelOnly.trailerType, base.trailerType);
});

test('vehicle norm bounds reject empty, zero and values above 80', () => {
    assert.equal(vehicleNormNumber('', 0.1, 80), null);
    assert.equal(vehicleNormNumber(0, 0.1, 80), null);
    assert.equal(vehicleNormNumber(80.1, 0.1, 80), null);
    assert.equal(vehicleNormNumber(80, 0.1, 80), 80);
    assert.equal(vehicleNormNumber('31.5', 0.1, 80), 31.5);
    assert.equal(vehicleNormPatch({ fuel_load: 'привіт', trailer_type: 'тент' }).trailerType, 'тент');
    assert.equal(vehicleNormPatch({ fuel_load: 'привіт' }), null);
});

test('the calculator lists fleet vehicles and the new columns stay in a new migration', () => {
    assert.match(html, /id="vehicle-norm"/);
    assert.match(html, /Норми компанії/);
    assert.match(html, /function onVehicleNormChange\(/);
    assert.equal(oldMigration.includes('fuel_load'), false);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS fuel_load/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS fuel_empty/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS norm_weight/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS trailer_type/);
    assert.match(migration, /fuel_load >= 0\.1 AND fuel_load <= 80/);
    assert.match(migration, /зерновоз/);
    assert.equal(migration.includes('GRANT'), false);
    assert.equal(migration.includes('anon'), false);
    assert.equal(migration.includes('calculateTrip'), false);
});
