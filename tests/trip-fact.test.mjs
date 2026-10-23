import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { calculateTrip, sumVehicleTrips, calculateTripFact, tripFactBasis, buildTripFact } = await import('../api/calculate.js');
const { normalizeTripFact, FACT_VERSION } = await import('../lib/trip-fact.js');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/calc-golden.json', import.meta.url), 'utf8'));
const calcSource = readFileSync(new URL('../api/calculate.js', import.meta.url), 'utf8');
const apiSource = calcSource.slice(calcSource.indexOf('async function tripFactRequest('), calcSource.indexOf('export const REQUIRED_FIELD_LABELS'));
const libSource = readFileSync(new URL('../lib/trip-fact.js', import.meta.url), 'utf8');

const base = fixtures[0].payload;
// Одна ходка, одне авто, без простою в плані: зручно рахувати руками.
const oneTrip = {
    ...base, calcType: 'готівка', returnMode: 'циклічний', volume: 22, normWeight: 22, carsCount: 1,
    dist: 500, podachaDist: 0, daysPerTrip: 5, idleDays: 0, idleRate: 1000, rate: 1500, useExtras: false, isRoundTrip: false,
    admin: 1200000, amort: 900000, fin: 300000, repair: 600000, otherOperating: 120000, otherExpenses: 60000
};
const asPlan = (b) => {
    const basis = tripFactBasis(b);
    return { tripDays: basis.tripDays, loadedKm: basis.loadedKm, emptyKm: basis.emptyKm, paidIdleDays: 0, idleRate: basis.idleRate, extraCosts: 0 };
};
const row = (result, needle) => result.detailedRows.filter((r) => r.name.includes(needle)).reduce((s, r) => s + r.val, 0);

test('fact = plan (no planned idle, no paid idle, no extras) gives exactly the calculator result', () => {
    const variants = [];
    for (const f of fixtures) {
        for (const calcType of ['фоп', 'безготівковий', 'готівка']) {
            for (const driverPayMode of ['km', 'pct']) {
                for (const trailerType of ['зерновоз', 'цистерна', 'рефрижератор']) {
                    variants.push({ ...f.payload, calcType, driverPayMode, trailerType, idleDays: 0, washCost: 4000, washFreq: 12 });
                }
            }
        }
    }
    assert.ok(variants.some((v) => v.returnMode === 'разовий') && variants.some((v) => v.returnMode === 'циклічний'));
    for (const payload of variants) {
        const fact = asPlan(payload);
        assert.deepEqual(calculateTripFact(payload, fact), calculateTrip(payload), payload.calcType + ' ' + payload.returnMode);
        const built = buildTripFact(payload, {}, null);
        assert.equal(built.actual.profit, built.planNow.profit);
        assert.equal(built.actual.revenue, built.planNow.revenue);
    }
});

test('fact = plan for a round trip (exact plan days) and for a fleet split', () => {
    const round = { ...oneTrip, volume: 66, carsCount: 2, isRoundTrip: true, rtTotalVolume: 30, rtRate: 900, rtBackhaulDist: 300, rtTransferDist: 40, rtReturnDist: 60 };
    const basis = tripFactBasis(round);
    assert.ok(basis.planDays > basis.tripsCount * round.daysPerTrip, 'the loop adds days to the plan');
    const exact = { ...asPlan(round), tripDays: basis.planDays / basis.tripsCount };
    assert.equal(calculateTripFact(round, exact).netProfit, calculateTrip(round).netProfit);
    assert.equal(basis.tripDays, basis.planDays / basis.tripsCount, 'default: loop days spread per trip, not rounded');
    assert.ok(basis.loadedKm > round.dist * basis.tripsCount, 'plan loaded km include C→D');

    const vehicles = [{ id: 'a', label: 'AA', tonnage: 40 }, { id: 'b', label: 'BB', tonnage: 26, payloadTons: 26 }];
    const fleet = { ...oneTrip, volume: 66, carsCount: 2, vehicles };
    assert.deepEqual(calculateTripFact(fleet, asPlan(fleet)), sumVehicleTrips(fleet, vehicles));
    const more = calculateTripFact(fleet, { ...asPlan(fleet), loadedKm: tripFactBasis(fleet).loadedKm + 100 });
    assert.ok(more.netProfit < sumVehicleTrips(fleet, vehicles).netProfit, 'more km on a fleet split costs more');
    assert.equal(more.vehicleBreakdown.length, 2);
});

test('nothing changed in the editor → fact = plan to the kopiyka (round trips, fleets, non-integer days; 300+ cases)', () => {
    let seed = 20261023;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const num = (lo, hi, digits) => Number((lo + rnd() * (hi - lo)).toFixed(digits || 0));
    let cases = 0;
    let loopCases = 0;
    let fractionalLoop = 0;
    let fleets = 0;
    let caughtByRounding = 0;
    for (let i = 0; i < 360; i++) {
        const p = {
            ...pick(fixtures).payload,
            calcType: pick(['фоп', 'безготівковий', 'готівка']),
            returnMode: pick(['циклічний', 'разовий']),
            driverPayMode: pick(['km', 'pct']),
            driverPctVal: 11,
            trailerType: pick(['зерновоз', 'цистерна', 'рефрижератор', 'тент']),
            contractCurrency: 'UAH', fxRate: 1,
            dist: num(80, 1400), volume: num(20, 900, 1), normWeight: num(18, 26, 1), carsCount: num(1, 5),
            daysPerTrip: num(0.5, 5, 2), idleDays: pick([0, 0.5, 1.25, 2.75]), idleRate: 0,
            podachaDist: pick([0, 35]), rate: num(300, 2500),
            washCost: 5000, washFreq: 20, refFuelRate: 2, refHours: 9,
            admin: 1500000, amort: 800000, fin: 200000, repair: 500000, otherOperating: 90000, otherExpenses: 40000,
            isRoundTrip: rnd() < 0.8
        };
        if (p.isRoundTrip) Object.assign(p, { rtTotalVolume: num(10, 300, 1), rtRate: num(200, 1500), rtBackhaulDist: num(100, 1500), rtTransferDist: num(0, 150), rtReturnDist: num(0, 400) });
        const vehicles = rnd() < 0.3 ? [{ id: 'a', label: 'AA', tonnage: num(10, 300, 1) }, { id: 'b', label: 'BB', tonnage: num(10, 300, 1), payloadTons: 25 }] : null;
        const body = vehicles ? { ...p, vehicles } : p;
        const planResult = vehicles ? sumVehicleTrips(p, vehicles) : calculateTrip(p);
        const basis = tripFactBasis(body);
        cases += 1;
        if (vehicles) fleets += 1;
        if (basis.planDays !== basis.tripsCount * (p.daysPerTrip + p.idleDays)) {
            loopCases += 1;
            if (!Number.isInteger(basis.tripDays * 100)) fractionalLoop += 1;
        }
        // 1) Поля порожні (редактор щойно відкрито).
        const blank = buildTripFact(body, {}, null);
        // 2) Клієнт надсилає незмінені значення, які показав у полях (точні числа з першої відповіді).
        const shown = buildTripFact(body, blank.fact, null);
        for (const built of [blank, shown]) {
            assert.equal(built.actual.profit, built.planNow.profit, 'profit #' + i);
            assert.equal(built.actual.revenue, built.planNow.revenue, 'revenue #' + i);
            assert.equal(built.deviation.profit.abs, 0);
            assert.equal(built.deviation.days.abs, 0);
            assert.equal(built.deviation.km.abs, 0);
            assert.equal(built.row.fact_days, basis.tripDays, 'stores the exact plan days per trip');
            assert.deepEqual(built.asPlan, { tripDays: true, loadedKm: true, emptyKm: true });
        }
        const exact = calculateTripFact(body, { tripDays: null, loadedKm: null, emptyKm: null, paidIdleDays: 0, idleRate: 0, extraCosts: 0 });
        assert.deepEqual(exact, planResult, 'the whole result equals the calculator #' + i);
        // Колишня поведінка (доби округлено до сотих) — на кругорейсах давала відхилення.
        const rounded = calculateTripFact(body, { tripDays: Math.round(basis.tripDays * 100) / 100, loadedKm: basis.loadedKm, emptyKm: basis.emptyKm, paidIdleDays: 0, idleRate: 0, extraCosts: 0 });
        if (rounded.netProfit !== planResult.netProfit) caughtByRounding += 1;
    }
    assert.ok(cases >= 300 && loopCases >= 200 && fractionalLoop >= 150 && fleets >= 50, JSON.stringify({ cases, loopCases, fractionalLoop, fleets }));
    assert.ok(caughtByRounding > 0, 'the old rounding would fail this test');
});

test('a changed value is used as typed, even close to the plan', () => {
    const round = { ...oneTrip, volume: 44, isRoundTrip: true, rtTotalVolume: 22, rtRate: 900, rtBackhaulDist: 600, rtTransferDist: 40, rtReturnDist: 60 };
    const basis = tripFactBasis(round);
    const typed = buildTripFact(round, { tripDays: '5,67' }, null);
    assert.equal(typed.asPlan.tripDays, false);
    assert.equal(typed.row.fact_days, 5.67);
    assert.ok(Math.abs(typed.deviation.days.abs - (5.67 * basis.tripsCount - basis.planDays)) < 1e-9);
});

test('example: plan 5 days, fact 8, paid idle 3 × 1000 грн, 1 trip', () => {
    const plan = calculateTrip(oneTrip);
    const fact = calculateTripFact(oneTrip, { ...asPlan(oneTrip), tripDays: 8, paidIdleDays: 3, idleRate: 1000 });
    assert.equal(fact.grossIncome - plan.grossIncome, 3000, 'revenue +3000');
    const perDiem = Number(oneTrip.perDiem);
    assert.equal(Math.round((fact.driverTotal - plan.driverTotal) / perDiem), 3, 'per diem for 8 days instead of 5');
    assert.ok(plan.overheadTotal > 1000 && Math.abs(fact.overheadTotal - plan.overheadTotal * 8 / 5) <= 2, 'overhead and amortisation for 8 days');
    assert.equal(row(fact, 'Пальне'), row(plan, 'Пальне'), 'same km → same fuel');
    // Неоплачені доби (факт 8, оплачено 3 понад план 5 → 0 неоплачених) — без компенсації, лише витрати.
    const unpaid = calculateTripFact(oneTrip, { ...asPlan(oneTrip), tripDays: 8 });
    assert.equal(unpaid.grossIncome, plan.grossIncome);
    assert.ok(unpaid.netProfit < plan.netProfit);
});

test('paid idle 0 → no idle compensation, even when the plan had idle days', () => {
    const withIdle = { ...oneTrip, idleDays: 2, idleRate: 1500 };
    const plan = calculateTrip(withIdle);
    const fact = calculateTripFact(withIdle, asPlan(withIdle));
    assert.equal(plan.grossIncome - fact.grossIncome, 3000, 'planned idle compensation is not carried into the fact');
    assert.equal(asPlan(withIdle).tripDays, 7, 'default fact days = days per trip + planned idle');
    const built = buildTripFact(withIdle, { paidIdleDays: '' , idleRate: '' }, null);
    assert.equal(built.fact.paidIdleDays, 0);
    assert.equal(built.fact.idleRate, 1500, 'idle rate defaults to the plan');
});

test('idle compensation uses trips (cyclic) or cars (one-off) and the contract currency', () => {
    const cyclic = { ...oneTrip, volume: 66 }; // 3 ходки
    const c = calculateTripFact(cyclic, { ...asPlan(cyclic), paidIdleDays: 1, idleRate: 1000 });
    assert.equal(c.grossIncome - calculateTrip(cyclic).grossIncome, 3000);
    const oneOff = { ...oneTrip, returnMode: 'разовий', carsCount: 2 };
    const o = calculateTripFact(oneOff, { ...asPlan(oneOff), paidIdleDays: 1, idleRate: 1000 });
    assert.equal(o.grossIncome - calculateTrip(oneOff).grossIncome, 2000);
    const eur = { ...oneTrip, contractCurrency: 'EUR', fxRate: 45, rate: 30, idleRate: 20 };
    const e = calculateTripFact(eur, { ...asPlan(eur), paidIdleDays: 2, idleRate: 20 });
    assert.equal(e.grossIncome - calculateTrip(eur).grossIncome, 2 * 20 * 45);
});

test('fuel, AdBlue, maintenance and km salary follow the fact km', () => {
    const plan = calculateTrip(oneTrip);
    const longer = calculateTripFact(oneTrip, { ...asPlan(oneTrip), loadedKm: 600, emptyKm: 0 });
    const fuelPerKm = Number(oneTrip.fuelLoad) / 100 * Number(oneTrip.fuelPrice);
    assert.ok(Math.abs(row(longer, 'Пальне') - row(plan, 'Пальне') - 100 * fuelPerKm) <= 1);
    assert.ok(row(longer, 'AdBlue') > row(plan, 'AdBlue'));
    assert.ok(longer.toTotal > plan.toTotal);
    const salary = 100 * Number(oneTrip.driverRateLoad) * 1.22;
    assert.ok(Math.abs(longer.driverTotal - plan.driverTotal - salary) <= 1);
    const empty = calculateTripFact(oneTrip, { ...asPlan(oneTrip), emptyKm: 200 });
    assert.ok(Math.abs(empty.driverTotal - plan.driverTotal - 200 * Number(oneTrip.driverRateEmpty) * 1.22) <= 1);
});

test('percent salary is taken from the fact revenue', () => {
    const pct = { ...oneTrip, driverPayMode: 'pct', driverPctVal: 10 };
    const plan = calculateTrip(pct);
    const fact = calculateTripFact(pct, { ...asPlan(pct), paidIdleDays: 1, idleRate: 1000 });
    assert.equal(fact.grossIncome - plan.grossIncome, 1000);
    assert.ok(Math.abs(fact.driverTotal - plan.driverTotal - 1000 * 0.10 * 1.22) <= 1);
});

test('extra costs: added in full, like the calculator extras (no VAT divisor, no FX); taxes by calcType', () => {
    for (const calcType of ['фоп', 'безготівковий', 'готівка']) {
        const p = { ...oneTrip, calcType };
        const plan = calculateTrip(p);
        const fact = calculateTripFact(p, { ...asPlan(p), extraCosts: 1200 });
        assert.equal(plan.netProfit - fact.netProfit, 1200, calcType);
        assert.equal(fact.taxesTotal, plan.taxesTotal, calcType + ': tax base is revenue, not costs');
        assert.equal(row(fact, 'Незаплановані'), 1200);
    }
    // У калькуляторі супутні витрати так само без дільника ПДВ.
    const vat = { ...oneTrip, calcType: 'безготівковий', useExtras: true, tollCost: 1200, borderCost: 0, brokerCost: 0, greenCardCost: 0, ferryCost: 0 };
    assert.equal(calculateTrip({ ...vat, useExtras: false }).netProfit - calculateTrip(vat).netProfit, 1200);
    const eur = { ...oneTrip, contractCurrency: 'EUR', fxRate: 45, rate: 30 };
    assert.equal(calculateTrip(eur).netProfit - calculateTripFact(eur, { ...asPlan(eur), extraCosts: 1200 }).netProfit, 1200, 'extra costs are UAH');
    assert.equal(row(calculateTripFact(oneTrip, asPlan(oneTrip)), 'Незаплановані'), 0, 'no row when 0');
});

test('VAT / FOP / cash: same tax logic as the plan', () => {
    for (const [calcType, check] of [
        ['фоп', (r) => assert.equal(r.taxesTotal, Math.round(r.grossIncome * 0.06))],
        ['безготівковий', (r) => { assert.equal(r.taxesTotal, 0); assert.equal(r.netIncome, Math.round(r.grossIncome / 1.2)); }],
        ['готівка', (r) => { assert.equal(r.taxesTotal, 0); assert.equal(r.netIncome, r.grossIncome); }]
    ]) {
        const p = { ...oneTrip, calcType };
        check(calculateTripFact(p, { ...asPlan(p), tripDays: 6, paidIdleDays: 1, extraCosts: 500 }));
    }
});

test('tank wash and repair follow the fact days', () => {
    const tank = { ...oneTrip, trailerType: 'цистерна', washCost: 6000, washFreq: 24, repair: 0, amort: 0, admin: 0, otherOperating: 0, otherExpenses: 0, fin: 0 };
    const plan = calculateTrip(tank);
    const fact = calculateTripFact(tank, { ...asPlan(tank), tripDays: 10 });
    const washPlan = 6000 * 24 / Number(tank.totalFleet) / 365 * 5;
    const perDiem = Number(tank.perDiem) * 5;
    assert.ok(Math.abs((fact.toTotal - plan.toTotal) - washPlan) <= 1, 'wash doubles with days');
    assert.ok(Math.abs((fact.driverTotal - plan.driverTotal) - perDiem) <= 1);
});

test('round trip: fact km already include the loop, no extra loop days are added', () => {
    const round = { ...oneTrip, volume: 44, carsCount: 1, isRoundTrip: true, rtTotalVolume: 22, rtRate: 900, rtBackhaulDist: 600, rtTransferDist: 40, rtReturnDist: 60 };
    const basis = tripFactBasis(round);
    const plan = calculateTrip(round);
    const fact = calculateTripFact(round, { ...asPlan(round), tripDays: round.daysPerTrip });
    assert.equal(fact.grossIncome, plan.grossIncome, 'backhaul income stays as planned');
    const perDiem = Number(round.perDiem);
    assert.ok(Math.abs((plan.driverTotal - fact.driverTotal) - (basis.planDays - 2 * round.daysPerTrip) * perDiem) <= 1,
        'loop days are not added on top of the fact days');
    assert.equal(basis.isRoundTrip, true);
    assert.ok(basis.planDays > 2 * round.daysPerTrip, 'the plan has loop days');
});

test('validation: blanks take the plan, bad values are refused, comma decimals work', () => {
    const basis = tripFactBasis(oneTrip);
    assert.deepEqual(normalizeTripFact({}, basis).value, {
        tripDays: 5, loadedKm: basis.loadedKm, emptyKm: basis.emptyKm, paidIdleDays: 0, idleRate: 1000, extraCosts: 0, extraCostsNote: ''
    });
    assert.equal(normalizeTripFact({ tripDays: '5,5', extraCosts: ' 1 200 ' }, basis).value.tripDays, 5.5);
    assert.equal(normalizeTripFact({ extraCosts: ' 1 200 ' }, basis).value.extraCosts, 1200);
    for (const bad of [{ tripDays: '0x10' }, { tripDays: '1e3' }, { loadedKm: '1e3' }, { tripDays: [5] }, { tripDays: ['5'] },
        { tripDays: { v: 5 } }, { tripDays: true }, { tripDays: 'Infinity' }, { tripDays: Infinity }, { tripDays: NaN },
        { extraCosts: '5.' }, { extraCosts: '1.2.3' }, { extraCosts: '+5' }, { extraCostsNote: 123 }, { extraCostsNote: ['x'] },
        { extraCostsNote: { text: 'x' } }, { extraCostsNote: true },
        { tripDays: 0 }, { tripDays: -1 }, { tripDays: 'abc' }, { loadedKm: -1 }, { emptyKm: -0.5 },
        { paidIdleDays: -1 }, { idleRate: -5 }, { extraCosts: -1 }, { tripDays: 400 }, { extraCostsNote: 'x'.repeat(501) }]) {
        const res = normalizeTripFact(bad, basis);
        assert.equal(res.code, 'BAD_FACT', JSON.stringify(bad).slice(0, 40));
    }
    const zero = normalizeTripFact({ loadedKm: 0, emptyKm: 0, paidIdleDays: 0, extraCosts: 0, idleRate: 0 }, basis);
    assert.equal(zero.value.loadedKm, 0);
    assert.equal(normalizeTripFact({ extraCostsNote: 'я'.repeat(500) }, basis).value.extraCostsNote.length, 500);
    assert.equal(normalizeTripFact({ extraCostsNote: '   ' }, basis).value.extraCostsNote, '');
    assert.equal(normalizeTripFact({ extraCostsNote: null }, basis).value.extraCostsNote, '');
    assert.equal(normalizeTripFact({ tripDays: 6 }, basis).value.tripDays, 6, 'a number is a number');
    assert.equal(normalizeTripFact({ tripDays: ' 6,25 ' }, basis).value.tripDays, 6.25);
    assert.equal(normalizeTripFact({ loadedKm: '1 250' }, basis).value.loadedKm, 1250);
    assert.equal(normalizeTripFact({ loadedKm: '1\u00a0250,5' }, basis).value.loadedKm, 1250.5);
    const zeroKm = calculateTripFact(oneTrip, { ...asPlan(oneTrip), loadedKm: 0, emptyKm: 0 });
    assert.ok(Number.isFinite(zeroKm.netProfit));
});

test('buildTripFact: v2 row, deviations, stored plan and trips without calculator inputs', () => {
    const built = buildTripFact(oneTrip, { tripDays: 8, paidIdleDays: 3, idleRate: 1000, extraCosts: 500, extraCostsNote: ' КПП ' }, { revenue: 33000, profit: 5000 });
    assert.equal(FACT_VERSION, 'v2');
    assert.equal(built.row.fact_version, 'v2');
    assert.equal(built.row.planned_overhead, 0);
    assert.equal(built.row.costs, built.row.revenue - built.row.profit);
    assert.equal(built.row.extra_costs_note, 'КПП');
    assert.equal(built.row.fact_days, 8);
    assert.deepEqual(built.plan, { revenue: 33000, costs: 28000, profit: 5000 }, 'compared with the saved plan');
    assert.equal(built.deviation.profit.abs, built.actual.profit - 5000);
    assert.equal(built.deviation.days.abs, 3);
    assert.equal(built.deviation.km.abs, 0);
    assert.equal(buildTripFact(oneTrip, {}, null).row.extra_costs_note, null);
    assert.equal(buildTripFact({}, {}, null).code, 'NO_INPUTS');
    assert.equal(buildTripFact({ dist: 500 }, {}, null).code, 'NO_INPUTS');
    assert.equal(buildTripFact(oneTrip, { tripDays: -1 }, null).code, 'BAD_FACT');
});

test('POST /api/calculate?mode=fact takes the inputs from the saved trip, never from the request, and does not write', () => {
    assert.ok(apiSource.length > 500);
    const handler = calcSource.slice(calcSource.indexOf('export default async function handler('));
    const branch = "if (req.query && req.query.mode === 'fact') return tripFactRequest(req, res);";
    assert.ok(handler.indexOf(branch) > handler.indexOf("return res.status(405)"), 'after the method check');
    assert.ok(handler.indexOf(branch) < handler.indexOf('const authHeader'), 'before the calculator path, which stays as it was');
    assert.equal(handler.split('tripFactRequest').length, 2, 'the only entry to the fact path');
    assert.equal(/^import /m.test(libSource), false, 'lib/trip-fact.js has no imports (no cycle with api/calculate.js)');
    assert.match(apiSource, /\.select\('id, org_id, user_id, status, inputs, results, revenue, profit'\)/);
    assert.match(apiSource, /buildTripFact\(calc\.inputs \|\| \{\}, body\.fact, stored\)/);
    assert.equal(/body\.inputs|req\.body\.inputs/.test(apiSource), false);
    assert.equal(/\.(insert|update|upsert|delete)\(/.test(apiSource), false);
    assert.match(apiSource, /calc\.org_id !== profile\.org_id/);
    assert.match(apiSource, /profile\.org_role !== 'owner' && calc\.user_id !== user\.id/);
    assert.match(apiSource, /calc\.status !== 'accepted' && calc\.status !== 'done'/);
    assert.equal(apiSource.includes('bump_calc_usage'), false, 'does not consume the demo calculator quota');
});
