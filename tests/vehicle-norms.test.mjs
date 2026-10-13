import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { calculateTrip, sumVehicleTrips, splitTonnageShares } = await import('../api/calculate.js');
const calculateSource = readFileSync(new URL('../api/calculate.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/calc-golden.json', import.meta.url), 'utf8'));
const oldMigration = readFileSync(new URL('../supabase/migrations/20261012240000_fleet_vehicles.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261013180000_fleet_vehicle_norms.sql', import.meta.url), 'utf8');
const calcVehicles = readFileSync(new URL('../supabase/migrations/20261013190000_calc_vehicles.sql', import.meta.url), 'utf8');

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
const clientSplit = extractFunction('splitTonnageShares', ['totalTons', 'weights']);
const vehicleResolvedNorms = extractFunction('vehicleResolvedNorms', ['vehicle']);
globalThis.vehicleNormNumber = vehicleNormNumber;

function moneyOf(result, needle) {
    return (result.detailedRows || [])
        .filter((row) => String(row.name).includes(needle))
        .reduce((sum, row) => sum + row.val, 0);
}

test('a trip without a selected vehicle keeps every golden result', () => {
    for (const scenario of fixtures) {
        assert.deepEqual(calculateTrip(scenario.payload), scenario.expect);
    }
    assert.equal(sumVehicleTrips(fixtures[0].payload, null), null);
    assert.equal(sumVehicleTrips(fixtures[0].payload, []), null);
    assert.equal(calculateSource.includes('fleet_vehicles'), false);
    assert.equal(calculateSource.includes('fuel_load'), false);
    assert.equal(calculateSource.includes('adblue_on'), false);
    assert.equal(html.includes('усереднюються'), false);
    assert.equal(html.includes('applyVehicleNorms'), false);
});

test('one truck with its own consumption replaces the company fuel and stays one row', () => {
    const base = fixtures[0].payload;
    const assignment = {
        id: '11111111-1111-4111-8111-111111111111',
        label: 'AA0001KA',
        tonnage: 126,
        fuelLoad: 28,
        fuelEmpty: 24,
        useAdblue: true,
        adblueConsumption: 4,
        trailerType: 'тент'
    };
    const result = sumVehicleTrips(base, [assignment]);
    const alone = calculateTrip({
        ...base,
        carsCount: 1,
        volume: 126,
        fuelLoad: 28,
        fuelEmpty: 24,
        useAdblue: true,
        adblueConsumption: 4,
        trailerType: 'тент'
    });
    assert.equal(result.netProfit, alone.netProfit);
    assert.equal(result.fuelTotal, alone.fuelTotal);
    assert.equal(result.grossIncome, alone.grossIncome);
    assert.equal(result.driverTotal, alone.driverTotal);
    assert.equal(result.taxesTotal, alone.taxesTotal);
    assert.equal(result.vehicleBreakdown.length, 1);
    assert.equal(result.vehicleBreakdown[0].profit, result.netProfit);
    assert.equal(result.vehicleBreakdown[0].fuel, moneyOf(result, 'Пальне'));
    assert.equal(result.vehicleBreakdown[0].adblue, moneyOf(result, 'AdBlue'));
    assert.equal(result.assignedTonnage, 126);
    assert.notEqual(result.netProfit, fixtures[0].expect.netProfit);
    assert.notEqual(result.fuelTotal, fixtures[0].expect.fuelTotal);
    assert.equal(result.netProfit, -47901);
    assert.equal(result.fuelTotal, 92923);
    const resolved = vehicleResolvedNorms({
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
    assert.equal(resolved.fuelLoad, 28);
    assert.equal(resolved.fuelEmpty, 24);
    assert.equal(resolved.make_model, undefined);
    assert.equal(resolved.label, undefined);
    const blank = vehicleResolvedNorms({ fuel_load: 0, fuel_empty: 90, trailer_type: 'фургон', payload_t: 0 });
    assert.deepEqual(blank, {});
    const company = sumVehicleTrips(base, [{ label: 'Без норми', tonnage: 126 }]);
    const companyAlone = calculateTrip({ ...base, carsCount: 1, volume: 126 });
    assert.equal(company.netProfit, companyAlone.netProfit);
    assert.equal(company.fuelTotal, companyAlone.fuelTotal);
});

test('two trucks keep their own norms and the rounded money sums to the total', () => {
    const base = fixtures[0].payload;
    const first = {
        label: 'AA0001KA',
        tonnage: 60,
        fuelLoad: 28,
        fuelEmpty: 24,
        useAdblue: true,
        adblueConsumption: 4,
        trailerType: 'тент',
        payloadTons: 22
    };
    const second = {
        label: 'AA0002KA',
        tonnage: 40,
        fuelLoad: 36,
        fuelEmpty: 31,
        useAdblue: false,
        trailerType: 'зерновоз',
        payloadTons: 18
    };
    const result = sumVehicleTrips(base, [first, second]);
    const left = calculateTrip({
        ...base,
        carsCount: 1,
        volume: 60,
        normWeight: 22,
        fuelLoad: 28,
        fuelEmpty: 24,
        useAdblue: true,
        adblueConsumption: 4,
        trailerType: 'тент'
    });
    const right = calculateTrip({
        ...base,
        carsCount: 1,
        volume: 40,
        normWeight: 18,
        fuelLoad: 36,
        fuelEmpty: 31,
        useAdblue: false,
        adblueConsumption: 0,
        trailerType: 'зерновоз'
    });
    assert.equal(result.netProfit, left.netProfit + right.netProfit);
    assert.equal(result.fuelTotal, left.fuelTotal + right.fuelTotal);
    assert.equal(result.driverTotal, left.driverTotal + right.driverTotal);
    assert.equal(result.taxesTotal, left.taxesTotal + right.taxesTotal);
    assert.equal(result.grossIncome, left.grossIncome + right.grossIncome);
    assert.equal(result.vehicleBreakdown[0].profit + result.vehicleBreakdown[1].profit, result.netProfit);
    assert.equal(result.vehicleBreakdown[0].fuel + result.vehicleBreakdown[1].fuel, moneyOf(result, 'Пальне'));
    assert.equal(result.vehicleBreakdown[0].adblue + result.vehicleBreakdown[1].adblue, moneyOf(result, 'AdBlue'));
    assert.equal(result.vehicleBreakdown[0].costs + result.vehicleBreakdown[1].costs, (result.detailedRows || []).reduce((sum, row) => {
        if (String(row.name).includes('Пальне') || String(row.name).includes('AdBlue')) return sum;
        return sum + row.val;
    }, 0));
    assert.equal(result.assignedTonnage, 100);
    assert.equal(result.vehicleBreakdown[0].tonnage + result.vehicleBreakdown[1].tonnage, 100);
    assert.notEqual(result.vehicleBreakdown[0].fuel, result.vehicleBreakdown[1].fuel);
    assert.notEqual(left.fuelTotal, right.fuelTotal);
    assert.match(result.tripVolumeText, /розкладено 100 з 126/);
    assert.equal(result.netProfit, -65910);
    assert.equal(result.fuelTotal, 94900);
    assert.deepEqual(splitTonnageShares(100, [1, 1, 1]), [33.333, 33.333, 33.334]);
    assert.deepEqual(splitTonnageShares(126, [22, 18]), [69.3, 56.7]);
    assert.deepEqual(clientSplit(100, [1, 1, 1]), splitTonnageShares(100, [1, 1, 1]));
    assert.deepEqual(clientSplit(126, [22, 18]), splitTonnageShares(126, [22, 18]));
    assert.equal(vehicleNormNumber(80, 0.1, 80), 80);
    assert.equal(vehicleNormNumber(0, 0.1, 80), null);
});

test('company mode keeps a vehicle choice out of the calculation', () => {
    const vehiclesForCalc = extractFunction('vehiclesForCalc', ['sourceMode', 'assignments']);
    const vehiclePlateMatches = extractFunction('vehiclePlateMatches', ['plate', 'query']);
    const kept = [{ id: 'a', tonnage: 60 }, { id: 'b', tonnage: 40 }];
    assert.deepEqual(vehiclesForCalc('company', kept), []);
    assert.deepEqual(vehiclesForCalc('fleet', kept), kept);
    assert.deepEqual(vehiclesForCalc('fleet', null), []);
    assert.equal(vehiclePlateMatches('AA0001KA', '0001'), true);
    assert.equal(vehiclePlateMatches('AA0001KA', 'aa0001ka'), true);
    assert.equal(vehiclePlateMatches('AA0001KA', 'volvo'), false);
    assert.equal(vehiclePlateMatches('AA0001KA', '  '), true);
    assert.match(html, /Весь автопарк/);
    assert.match(html, /Вибір авто/);
    assert.match(html, /placeholder="Номер авто"/);
    assert.match(html, /max-height: 280px/);
    assert.match(html, /class="tc-info"/);
    assert.match(html, /ще /);
    assert.equal(html.includes('Познач одне або кілька'), false);
    assert.equal(html.includes('Загально'), false);
    const payload = html.slice(html.indexOf('function readTripPayload'), html.indexOf('function renderVehicleBreakdown'));
    assert.match(payload, /vehiclesForCalc\(vehicleSourceMode, readVehicleAssignments\(\)\)/);
    const calc = html.slice(html.indexOf('async function calculate()'), html.indexOf('function clearCalcVisuals()'));
    assert.match(calc, /if \(fleetChoiceActive\(\)\)/);
    const pickerCss = html.slice(html.indexOf('.tc-vehicle-label {'), html.indexOf('#vehicle-tons .tc-vehicle-pick'));
    assert.equal(pickerCss.includes('ocean'), false);
    assert.equal(pickerCss.includes('[data-theme="ocean"]'), false);
});

test('the fleet card explains the split and the calc_vehicles migration stays unapplied in its own file', () => {
    assert.match(html, /id="vehicle-norm-list"/);
    assert.match(html, /id="vehicle-breakdown"/);
    assert.match(html, /Порівну/);
    assert.match(html, /За вантажопідйомністю/);
    assert.match(html, /Вручну/);
    assert.match(html, /Якщо ці дані заповнені і в розрахунку обране це авто або кілька/);
    assert.match(html, /загального шаблону кабінету/);
    assert.match(html, /сума по авто дорівнює підсумку/);
    assert.match(html, /Вантажопідйомність, т/);
    assert.match(html, /Витрата порожнім, л\/100 км/);
    assert.match(html, /calc_vehicles/);
    assert.equal(html.includes('norm_weight'), false);
    const css = html.slice(html.indexOf('#vehicle-split {'), html.indexOf('#vehicle-breakdown tr.is-total'));
    assert.equal(css.includes('ocean'), false);
    assert.equal(css.includes('[data-theme="ocean"]'), false);
    assert.equal(oldMigration.includes('fuel_load'), false);
    assert.equal(migration.includes('norm_weight'), false);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS payload_t/);
    assert.match(migration, /payload_t >= 0\.1 AND payload_t <= 80/);
    assert.equal(migration.includes('GRANT'), false);
    assert.equal(migration.includes('calc_vehicles'), false);
    assert.match(calcVehicles, /CREATE TABLE IF NOT EXISTS public\.calc_vehicles/);
    assert.match(calcVehicles, /calc_id uuid NOT NULL REFERENCES public\.calculations/);
    assert.match(calcVehicles, /vehicle_id uuid REFERENCES public\.fleet_vehicles/);
    assert.match(calcVehicles, /tonnage numeric NOT NULL/);
    assert.match(calcVehicles, /snapshot jsonb/);
    assert.match(calcVehicles, /tonnage > 0/);
    assert.match(calcVehicles, /UNIQUE \(calc_id, vehicle_id\)/);
    assert.match(calcVehicles, /calc_vehicles_select_role/);
    assert.match(calcVehicles, /is_org_owner\(\)/);
    assert.match(calcVehicles, /org_logists_see_all\(\)/);
    assert.match(calcVehicles, /Do not apply/);
    assert.match(calcVehicles, /REVOKE ALL ON TABLE public\.calc_vehicles FROM PUBLIC, anon, authenticated/);
    assert.equal(calcVehicles.includes('TO anon'), false);
    assert.equal(calcVehicles.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calc_vehicles TO anon'), false);
});
