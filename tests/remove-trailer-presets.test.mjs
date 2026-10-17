import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { calculateTrip, sumVehicleTrips } = await import('../api/calculate.js');
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const S0 = JSON.parse(read('tests/fixtures/s0-fop.json'));
const TRAILERS = ['зерновоз', 'рефрижератор', 'тент', 'цистерна'];

function body(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name + ' is missing from index.html');
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}' && --depth === 0) return html.slice(open + 1, i);
    }
    throw new Error('unclosed ' + name);
}

test('S0 regression: profit 6 687, tax 5 400', () => {
    const result = calculateTrip(S0);
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
});

test('no trailer preset tiles, no applyPreset, no styles or handlers left', () => {
    for (const needle of ['applyPreset', 'preset-tile', 'preset-tiles', 'Пресети причепа', 'pt-ico', 'pt-hint', 'data-preset=']) {
        assert.equal(html.includes(needle), false, needle);
    }
    // «Авто з парку» keeps its label and segment buttons.
    assert.match(html, /<div class="preset-bar-label">Авто з парку<\/div>/);
    assert.match(html, /\.preset-bar-label \{/);
    assert.match(html, /\.preset-btn \{/);
});

test('«Тип причепа» select stays, is visible in step 2 next to the fleet choice, and only syncs extras', () => {
    assert.match(html, /<div class="form-row two-cols">\n\s+<label for="trailer-type">Тип причепа:<\/label>\n\s+<select id="trailer-type" onchange="onTrailerChange\(\)">/);
    assert.match(html, /take\(2, document\.getElementById\('vehicle-norm-row'\)\);\n\s+take\(2, rowOf\('trailer-type'\)\);/);
    assert.equal((html.match(/rowOf\('trailer-type'\)/g) || []).length, 1);
    const onChange = body('onTrailerChange');
    assert.match(onChange, /syncTrailerExtras\(\);\s+calculate\(\);/);
    assert.doesNotMatch(onChange + body('syncTrailerExtras'), /fuel-load|fuel-empty|norm-weight|\.value\s*=/);
});

test('nothing but the fleet choice writes fuel norms; norm weight only from data (settings, saved trip, demo trip)', () => {
    const writes = html.match(/(fuel-load|fuel-empty|norm-weight)'\)\.value\s*=|(fuelLoad|fuelEmpty)\.value\s*=/g) || [];
    assert.deepEqual(writes, ['fuelLoad.value =', 'fuelEmpty.value =']);
    assert.match(body('writeVehicleNormForm'), /fuelLoad\.value = data\.fuelLoad/);
    // Demo trip: STARTER_TRIP values + trailer type, fuel norms untouched.
    const demo = body('fillDemoTrip');
    assert.match(demo, /document\.getElementById\('trailer-type'\)\.value = 'зерновоз';\n\s+syncTrailerExtras\(\);/);
    assert.doesNotMatch(demo, /fuel-load|fuel-empty/);
});

test('changing the trailer type with empty reefer / tank fields does not change the result', () => {
    const base = { ...S0, refFuelRate: '', refHours: '', washCost: '', washFreq: '' };
    const results = TRAILERS.map((trailerType) => calculateTrip({ ...base, trailerType }));
    for (const result of results) {
        assert.equal(result.netProfit, 6687);
        assert.equal(result.taxesTotal, 5400);
        assert.equal(result.grossIncome, results[0].grossIncome);
        assert.equal(result.fuelAndAdblueTotal, results[0].fuelAndAdblueTotal);
    }
});

test('saved trips that used a preset keep their numbers: values live in the fields', () => {
    // Old «Реф» preset wrote 34 / 29 l and 20 t into the form; the saved inputs carry them.
    const saved = { ...S0, trailerType: 'рефрижератор', fuelLoad: '34', fuelEmpty: '29', normWeight: '20' };
    const reopened = JSON.parse(JSON.stringify(saved));
    assert.deepEqual(calculateTrip(reopened), calculateTrip(saved));
    const map = html.match(/const TRIP_FIELD_MAP = \[([\s\S]*?)\];/)[1];
    for (const pair of ["['trailerType', 'trailer-type']", "['fuelLoad', 'fuel-load']", "['fuelEmpty', 'fuel-empty']", "['normWeight', 'norm-weight']"]) {
        assert.ok(map.includes(pair), pair);
    }
});

test('fleet vehicle brings its trailer type and norms (card → resolved norms → calculation)', () => {
    globalThis.FLEET_TRAILER_TYPES = TRAILERS;
    globalThis.companySettings = {};
    globalThis.vehicleNormNumber = new Function('value', 'min', 'max', body('vehicleNormNumber'));
    globalThis.fleetDefaultTrailer = new Function(body('fleetDefaultTrailer'));
    globalThis.fleetTrailerOf = new Function('vehicle', body('fleetTrailerOf'));
    const resolve = new Function('vehicle', body('vehicleResolvedNorms'));
    const norms = resolve({ label: 'AA0001KA', fuel_load: 34, fuel_empty: 29, trailer_type: 'цистерна', adblue_on: false, payload_t: 24 });
    assert.equal(norms.trailerType, 'цистерна');
    assert.equal(norms.fuelLoad, 34);
    assert.equal(norms.fuelEmpty, 29);

    const base = { ...S0, washCost: '3000', washFreq: '1' };
    const viaFleet = sumVehicleTrips(base, [{ label: 'AA0001KA', tonnage: Number(S0.volume), ...norms }]);
    const direct = calculateTrip({ ...base, carsCount: 1, trailerType: 'цистерна', fuelLoad: 34, fuelEmpty: 29, useAdblue: false, adblueConsumption: 0, normWeight: norms.payloadTons || S0.normWeight });
    assert.equal(viaFleet.netProfit, direct.netProfit);
    assert.equal(viaFleet.fuelAndAdblueTotal, direct.fuelAndAdblueTotal);
    assert.notEqual(viaFleet.netProfit, calculateTrip(base).netProfit, 'tank wash and norms of the vehicle are applied');

    // Restoring the company choice writes the trailer back through the select and syncs extras only.
    const write = body('writeVehicleNormForm');
    assert.match(write, /trailer\.value = data\.trailerType;\n\s+syncTrailerExtras\(\);/);
});
