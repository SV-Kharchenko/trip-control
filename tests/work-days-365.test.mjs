import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { calculateTrip } = await import('../api/calculate.js');
const S0 = JSON.parse(read('tests/fixtures/s0-fop.json'));

// Annual overheads for S0 (5 vehicles). With the old 300 work days they gave exactly 700 800 грн per trip.
const OVERHEADS = { admin: '65700000', otherOperating: '32850000', otherExpenses: '21900000', amort: '43800000', fin: '10950000' };
const OLD_OVERHEAD_AT_300 = 700800;

test('S0 stays 6687 / 5400 with 365 work days (no overheads in S0)', () => {
    const result = calculateTrip(S0);
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
});

test('overheads on a trip are exactly 300/365 of what they were with 300 days', () => {
    const result = calculateTrip({ ...S0, ...OVERHEADS });
    assert.equal(result.overheadTotal, OLD_OVERHEAD_AT_300 * 300 / 365);
    assert.equal(result.overheadTotal, 576000);
    assert.match(read('api/calculate.js'), /const workDaysYear = 365;/);
});

test('365 is a constant only: no cabinet field, no settings key, no body.workDaysYear', () => {
    const plain = calculateTrip({ ...S0, ...OVERHEADS });
    for (const value of [100, '250', 300, '']) {
        assert.deepEqual(calculateTrip({ ...S0, ...OVERHEADS, workDaysYear: value }), plain, 'body.workDaysYear is ignored: ' + value);
    }
    const calc = read('api/calculate.js');
    assert.equal(/body\.workDays/.test(calc), false);
    const html = read('index.html');
    assert.equal(/workDaysYear|work-days|Робочих днів/.test(html), false);
    assert.equal(/workDays/.test(read('assets/cost-hints.js')), false);
});

test('no hint or UI text mentions 300 or 365 work days', () => {
    const sandbox = { window: {} };
    new Function('window', read('assets/cost-hints.js'))(sandbox.window);
    const hints = sandbox.window.TcCostHints;
    for (const text of [hints.intro, ...Object.values(hints.fields)]) {
        assert.equal(/\b(300|365)\b/.test(text), false, text);
    }
    const sources = ['index.html', 'assets/landing.js', 'assets/cost-hints.js', 'assets/osm-geo.js']
        .concat(readdirSync(new URL('../legal/', import.meta.url)).filter((f) => f.endsWith('.html')).map((f) => 'legal/' + f));
    for (const file of sources) {
        assert.equal(/\b(300|365)\s*(робоч|днів|дн\b|дня|діб|days)/i.test(read(file)), false, file);
        assert.equal(/(робоч\S*\s+дн\S*|днів на рік)[^<\n]{0,20}\b(300|365)\b/i.test(read(file)), false, file);
    }
});
