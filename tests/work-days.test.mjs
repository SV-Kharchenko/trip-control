import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { calculateTrip, sumVehicleTrips, workDaysFromBody, DEFAULT_WORK_DAYS_YEAR } = await import('../api/calculate.js');
const S0 = JSON.parse(read('tests/fixtures/s0-fop.json'));
const html = read('index.html');
const calcSource = read('api/calculate.js');

// S0 with annual overheads and repairs, so the work-days divisor actually matters.
const OVERHEADS = { admin: '900000', otherOperating: '450000', otherExpenses: '300000', amort: '600000', fin: '150000', repair: '300000' };

test('S0 without the field stays 6687 / 5400; workDaysYear 300 equals empty', () => {
    assert.equal(DEFAULT_WORK_DAYS_YEAR, 300);
    const plain = calculateTrip(S0);
    assert.equal(plain.netProfit, 6687);
    assert.equal(plain.taxesTotal, 5400);
    for (const value of [300, '300', ' 300 ', '', null, undefined, 'abc', '250.5', '3e2x']) {
        assert.deepEqual(calculateTrip({ ...S0, workDaysYear: value }), plain, String(value));
        assert.deepEqual(calculateTrip({ ...S0, ...OVERHEADS, workDaysYear: value }), calculateTrip({ ...S0, ...OVERHEADS }), 'with overheads: ' + value);
    }
    // Several vehicles pass it through as well.
    const vehicles = [{ label: 'A', tonnage: 30 }, { label: 'B', tonnage: 30 }];
    assert.deepEqual(sumVehicleTrips({ ...S0, ...OVERHEADS, workDaysYear: '300' }, vehicles), sumVehicleTrips({ ...S0, ...OVERHEADS }, vehicles));
});

test('250 work days raise the overheads per trip exactly 300/250 times; repairs and tank wash scale too', () => {
    const at300 = calculateTrip({ ...S0, ...OVERHEADS });
    const at250 = calculateTrip({ ...S0, ...OVERHEADS, workDaysYear: 250 });
    assert.equal(at300.overheadTotal, 9600);
    assert.equal(at250.overheadTotal, 11520);
    assert.equal(at250.overheadTotal, at300.overheadTotal * 300 / 250);
    assert.equal(at250.taxesTotal, at300.taxesTotal, 'tax on revenue does not depend on work days');
    // Repairs are in the variable costs: 300 000 / 5 vehicles / days × trip days.
    const noRepair = calculateTrip({ ...S0 });
    const repair300 = noRepair.netProfit - calculateTrip({ ...S0, repair: OVERHEADS.repair }).netProfit;
    const repair250 = noRepair.netProfit - calculateTrip({ ...S0, repair: OVERHEADS.repair, workDaysYear: 250 }).netProfit;
    assert.ok(repair300 > 0);
    assert.ok(Math.abs(repair250 - repair300 * 300 / 250) <= 1, repair300 + ' → ' + repair250);
    // Tank wash for a tanker: washCost × washFreq / vehicles / days × trip days.
    const tanker = { ...S0, trailerType: 'цистерна', washCost: '3000', washFreq: '12' };
    const wash300 = noRepair.netProfit - calculateTrip(tanker).netProfit;
    const wash250 = noRepair.netProfit - calculateTrip({ ...tanker, workDaysYear: '250' }).netProfit;
    assert.equal(wash300, 144);
    assert.ok(Math.abs(wash250 - wash300 * 300 / 250) <= 1, wash300 + ' → ' + wash250);
    // The constant is gone: every divisor uses the value from the body.
    assert.equal(/const workDaysYear = 300;/.test(calcSource), false);
    assert.equal((calcSource.match(/workDaysYear\)/g) || []).length >= 6, true);
});

test('outside 1–366 → 400 with a message, before the demo limit', () => {
    for (const value of [0, '0', -5, 367, '400']) {
        const result = calculateTrip({ ...S0, workDaysYear: value });
        assert.equal(result.status, 400, String(value));
        assert.equal(result.code, 'BAD_WORK_DAYS');
        assert.equal(result.error, 'Робочих днів на рік: ціле число від 1 до 366.');
        assert.deepEqual(result.fields, ['workDaysYear']);
    }
    assert.deepEqual(workDaysFromBody(1), { value: 1 });
    assert.deepEqual(workDaysFromBody('366'), { value: 366 });
    assert.deepEqual(workDaysFromBody('1,0'), { value: 1 });
    assert.deepEqual(workDaysFromBody('12.5'), { value: 300 });
    // The handler rejects it before counting a demo calculation.
    const handler = calcSource.slice(calcSource.indexOf('export default async function handler'));
    const early = handler.indexOf('const workDaysEarly = workDaysFromBody(reqBody.workDaysYear);');
    assert.ok(early > 0 && early < handler.indexOf('usage_counters') && early < handler.indexOf('calculateTrip(req.body'));
});

test('cabinet: «Робочих днів на рік» in «Витрати автопарку» with a hint; never saved when empty or 300; not in STARTER_SETTINGS', () => {
    assert.match(html, /\{ key: 'workDaysYear', id: 'work-days-year', label: 'Робочих днів на рік', unit: 'днів', step: '1', min: 1, max: 366, placeholder: '300' \},/);
    const parkSection = html.slice(html.indexOf("{ title: 'Парк і накладні'"), html.indexOf("{ title: 'Пальне та AdBlue'"));
    assert.ok(parkSection.includes("key: 'workDaysYear'"), 'in the same card as the overheads (CAB_SECTIONS[0])');
    const starter = html.slice(html.indexOf('const STARTER_SETTINGS = {'), html.indexOf('const STARTER_TRIP = {'));
    assert.equal(starter.includes('workDays'), false);
    const migration = read('supabase/migrations/20261017090000_invite_flow.sql');
    assert.equal(migration.includes('workDays'), false);
    // Hint in assets/cost-hints.js.
    assert.match(read('assets/cost-hints.js'), /workDaysYear: 'Скільки днів на рік ваші авто реально працюють\. Якщо не заповнено — 300'/);
    // Save: empty → no key, 300 → no key, outside 1–366 / not integer → message; nothing else saves it.
    const save = html.slice(html.indexOf('async function saveCabinet()'), html.indexOf('let lastExport = null;'));
    assert.match(save, /if \(raw === '' \|\| raw === null\) \{ delete next\[key\]; continue; \}\n\s+if \(key === 'workDaysYear'\) \{/);
    assert.match(save, /if \(!Number\.isInteger\(days\) \|\| days < 1 \|\| days > 366\) \{\n\s+setMsg\('Робочих днів на рік: ціле число від 1 до 366\.', true\);\n\s+return;/);
    assert.match(save, /if \(days === WORK_DAYS_DEFAULT\) delete next\[key\];\n\s+else next\[key\] = days;/);
    assert.match(html, /const WORK_DAYS_DEFAULT = 300;/);
    // Run the save branch on its own: what ends up in settings.
    const branch = save.slice(save.indexOf("if (key === 'workDaysYear') {"), save.indexOf('const n = parseFloat(raw);'));
    const apply = (raw) => {
        const next = { totalFleet: 1 };
        let message = '';
        const fn = new Function('raw', 'key', 'next', 'setMsg', 'WORK_DAYS_DEFAULT',
            'for (const _ of [0]) { ' + branch + ' } return true;');
        const ok = fn(raw, 'workDaysYear', next, (m) => { message = m; }, 300);
        return { ok, next, message };
    };
    assert.deepEqual(apply('300').next, { totalFleet: 1 });
    assert.deepEqual(apply('250').next, { totalFleet: 1, workDaysYear: 250 });
    assert.equal(apply('0').ok, undefined);
    assert.match(apply('367').message, /від 1 до 366/);
    assert.match(apply('12.5').message, /ціле число/);
});

test('calculator sends body.workDaysYear from the hidden field; empty key clears it; not on the landing', () => {
    assert.match(html, /<input type="number" id="total-fleet" oninput="calculate\(\)">\n\s+<input type="number" id="work-days-year" oninput="calculate\(\)">/);
    assert.match(html, /totalFleet: document\.getElementById\('total-fleet'\)\.value,\n\s+workDaysYear: document\.getElementById\('work-days-year'\)\.value,/);
    assert.match(html, /\['totalFleet', 'total-fleet'\], \['workDaysYear', 'work-days-year'\],/);
    const applySettings = html.slice(html.indexOf('function applySettingsToForm() {'), html.indexOf("if (companyTax) document.getElementById('calc-type').value = companyTax;"));
    assert.match(applySettings, /const workDays = companySettings\.workDaysYear;\n\s+document\.getElementById\('work-days-year'\)\.value = workDays !== undefined && workDays !== null \? workDays : '';/);
    const landing = html.slice(html.indexOf('<div id="landing-screen"'), html.indexOf('<div id="auth-screen">'));
    assert.equal(/work-days|Робочих днів/.test(landing), false);
    assert.equal(/work-days|workDays/.test(read('assets/landing.js')), false);
    const draft = html.slice(html.indexOf("const LANDING_DRAFT_KEY = 'tc_draft_trip';"), html.indexOf('function applyLandingDraft()'));
    assert.equal(draft.includes('work-days'), false);
});
