import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { calculateTrip, sumVehicleTrips, missingRequiredFields, REQUIRED_FIELD_LABELS } = await import('../api/calculate.js');
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const calcSource = read('api/calculate.js');
const S0 = JSON.parse(read('tests/fixtures/s0-fop.json'));

// S0: циклічний, 542 км, 60 т, норма 20 т, 1 авто → 3 ходки, 2 порожні повернення B→A.
// Кругорейс: B→C 60 км порожнім, C→D 480 км з вантажем, D→A 40 км порожнім, 1200 грн/т.
const RT = { isRoundTrip: true, rtTransferDist: '60', rtBackhaulDist: '480', rtReturnDist: '40', rtTotalVolume: '40', rtRate: '1200' };
const money = (r) => [r.grossIncome, r.netProfit, r.taxesTotal];

test('golden S0 without a round trip is unchanged: 6 687 / 5 400', () => {
    const r = calculateTrip(S0);
    assert.equal(r.netProfit, 6687);
    assert.equal(r.taxesTotal, 5400);
    assert.equal(r.grossIncome, 90000);
    assert.equal(r.rtWarning, undefined);
});

test('cyclic S0 + round trip: 40 t → 2 replaced returns; 60 t → + last return; 50 t → ceil, last leg 10 t', () => {
    // 40 т: ceil(40/20) = 2 ходки, обидві замінюють порожні B→A. Км ті самі, що й раніше, але контур
    // 580 км на 38 км довший за B→A 542 км: 2 × 38 = 76 км ÷ 451,7 км/добу = 0,168 доби → +143 грн добових.
    assert.deepEqual(money(calculateTrip({ ...S0, ...RT })), [138000, 45119, 8280]);
    // 60 т: 3 ходки — 2 заміни + останнє повернення авто (580 нових км, +1,45 доби).
    const sixty = calculateTrip({ ...S0, ...RT, rtTotalVolume: '60' });
    assert.deepEqual(money(sixty), [162000, 50600, 9720]);
    assert.equal(sixty.rtWarning, '');
    // 50 т: ceil(50/20) = 3, третя ходка везе 10 т з повними витратами на контур.
    assert.deepEqual(money(calculateTrip({ ...S0, ...RT, rtTotalVolume: '50' })), [150000, 39320, 9000]);
    // Більше, ніж 3 ходки × 20 т: чесна підказка, не мовчазне обрізання.
    const over = calculateTrip({ ...S0, ...RT, rtTotalVolume: '70' });
    assert.equal(over.rtWarning, 'Зворотний вантаж: враховано 60 з 70 т — на решту не вистачає авто');
    assert.equal(over.grossIncome, 162000);
});

test('one-off + round trip: one return leg per vehicle as new km; honest notice when cargo does not fit', () => {
    // Разовий: 1 авто × 20 т на 542 км (порожнього повернення немає), швидкість 542 / 2 = 271 км/добу.
    // 40 т зворотного: 1 ходка (по одній на авто), 20 т × 1200 = 24 000; +580 км (100 порожніх, 480 з вантажем), +2,14 доби.
    const one = calculateTrip({ ...S0, ...RT, returnMode: 'разовий' });
    assert.deepEqual(money(one), [54000, 14677, 3240]);
    assert.equal(one.rtWarning, 'Зворотний вантаж: враховано 20 з 40 т — на решту не вистачає авто');
    assert.match(one.tripVolumeText, /⚠️ Зворотний вантаж: враховано 20 з 40 т — на решту не вистачає авто/);
    assert.match(one.fuelSummaryText, /заг\. пробіг 1172 км/, '542 + 50 подача + 580 контур');
    // 15 т: неповна ходка з фактичними тоннами, витрати на контур повні.
    const partial = calculateTrip({ ...S0, ...RT, returnMode: 'разовий', rtTotalVolume: '15' });
    assert.deepEqual(money(partial), [48000, 9037, 2880]);
    assert.equal(partial.rtWarning, '');
    // 2 авто: 2 ходки по 20 т.
    assert.deepEqual(money(calculateTrip({ ...S0, ...RT, returnMode: 'разовий', carsCount: '2' })), [108000, 29354, 6480]);
    // Без кругорейсу разовий S0 — як і раніше.
    assert.deepEqual(money(calculateTrip({ ...S0, returnMode: 'разовий' })), [30000, 9924, 1800]);
});

test('several vehicles: return cargo is split between them (2 × 30 t + 20 t → 114 000), not given to each', () => {
    const base = { ...S0, ...RT, rtTotalVolume: '20', carsCount: '2' };
    const two = sumVehicleTrips(base, [{ label: 'A', tonnage: 30 }, { label: 'B', tonnage: 30 }]);
    assert.equal(two.grossIncome, 114000, '90 000 + 20 × 1200');
    assert.match(two.tripVolumeText, /🔄 Кругорейс: 20 т/);
    assert.equal(two.rtWarning, '');
    // An uneven split follows the tonnage; a vehicle with a zero share simply has no return leg.
    const uneven = sumVehicleTrips(base, [{ label: 'A', tonnage: 45 }, { label: 'B', tonnage: 15 }]);
    assert.equal(uneven.grossIncome, 114000);
    const tiny = sumVehicleTrips({ ...base, rtTotalVolume: '0.001' }, [{ label: 'A', tonnage: 59.999 }, { label: 'B', tonnage: 0.001 }]);
    assert.equal(tiny.status, undefined);
    assert.match(calcSource, /splitTonnageShares\(parseFloat\(base\.rtTotalVolume\) \|\| 0, assignments\.map/);
});

test('reefer counts on the loaded C→D leg; only the broker (documents) repeats on a loaded return leg', () => {
    const reef = { ...S0, ...RT, returnMode: 'разовий', trailerType: 'рефрижератор', refHours: '10' };
    const withRef = calculateTrip({ ...reef, refFuelRate: '2' });
    const noRef = calculateTrip({ ...reef, refFuelRate: '' });
    const fuel = (r) => r.detailedRows.find((row) => row.name.includes('Пальне')).val;
    // A→B: 2 л/год × 10 год × 57 грн; C→D: те саме × 480/542. Порожні B→C, D→A — без рефа, як порожні плечі основного маршруту.
    assert.ok(Math.abs((fuel(withRef) - fuel(noRef)) - 2 * 10 * 57 * (1 + 480 / 542)) <= 1);

    const extras = { useExtras: true, tollCost: '500', borderCost: '300', brokerCost: '1000', greenCardCost: '200', ferryCost: '100' };
    const off = calculateTrip({ ...S0, returnMode: 'разовий', ...extras });
    const on = calculateTrip({ ...S0, ...RT, returnMode: 'разовий', ...extras });
    assert.equal(off.extrasTotal, 2100);
    assert.equal(on.extrasTotal, 3100, 'roads, border, green card, ferry stay with A→B; broker + 1000 for the C→D cargo');
});

test('round trip ON with empty fields → MISSING_FIELDS (calculator and API)', () => {
    const empty = calculateTrip({ ...S0, isRoundTrip: true, rtTotalVolume: '', rtRate: '', rtBackhaulDist: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.code, 'MISSING_FIELDS');
    assert.deepEqual(empty.fields, ['rtTotalVolume', 'rtRate', 'rtBackhaulDist']);
    assert.equal(empty.error, 'Заповніть: Обсяг зворотного вантажу, Розцінка зворотного вантажу, Плече C→D');
    assert.equal(calculateTrip({ ...S0, ...RT, rtRate: '0' }).code, 'MISSING_FIELDS');
    // B→C and D→A may be 0 (C = B, D = A).
    assert.equal(calculateTrip({ ...S0, ...RT, rtTransferDist: '', rtReturnDist: '' }).status, undefined);

    assert.deepEqual(missingRequiredFields({ ...S0, isRoundTrip: true, rtTotalVolume: '', rtRate: '0', rtBackhaulDist: '' }),
        ['rtTotalVolume', 'rtRate', 'rtBackhaulDist']);
    assert.deepEqual(missingRequiredFields({ ...S0, ...RT }), []);
    assert.deepEqual(missingRequiredFields(S0), [], 'round trip off: its fields are not required');
    assert.deepEqual(missingRequiredFields({ ...S0, returnMode: 'разовий', volume: '' }), [], 'one-off: volume not required');
    assert.equal(REQUIRED_FIELD_LABELS.rtBackhaulDist, 'Плече C→D');
    assert.match(calcSource, /const missingFields = missingRequiredFields\(reqBody\);\n\s+if \(missingFields\.length\) \{\n\s+return res\.status\(400\)\.json\(\{\n\s+code: 'MISSING_FIELDS',/);
});

test('UI: one-off trip by default; round-trip fields empty with placeholders and required when on', () => {
    assert.match(html, /<option value="циклічний">🟢 Циклічний вивіз/);
    assert.match(html, /<option value="разовий" selected>⚪ Разовий рейс/);
    assert.match(calcSource, /const returnMode = body\.returnMode \|\| 'циклічний';/, 'server default stays cyclic');
    for (const id of ['rt-transfer-dist', 'rt-backhaul-dist', 'rt-return-dist', 'rt-total-volume', 'rt-rate']) {
        const input = html.match(new RegExp('<input type="number" id="' + id + '"[^>]*>'))[0];
        assert.equal(/value="0"/.test(input), false, id);
        assert.match(input, /placeholder="[^"]+"/, id);
    }
    assert.match(html, /const ROUND_TRIP_REQUIRED_FIELDS = \[\n\s+\['rt-total-volume', 'Обсяг зворотного вантажу'\], \['rt-rate', 'Розцінка зворотного вантажу'\], \['rt-backhaul-dist', 'Плече C→D'\]\n\s+\];/);
    assert.match(html, /const roundTripOn = document\.getElementById\('round-trip-enable'\)\.value === 'on';\n\s+const missing = REQUIRED_FIELDS\.concat\(roundTripOn \? ROUND_TRIP_REQUIRED_FIELDS : \[\]\)/);
    // Saved trips and templates restore their own mode.
    assert.match(html, /\['returnMode', 'return-mode'\]/);
});
