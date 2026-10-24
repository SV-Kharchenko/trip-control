import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    maintenanceEval, sortMaintenance, maintenanceBadge, badgeTitle, intervalText, leftKmText, leftDaysText, lastText,
    periodRange, periodError, costTotals, costCsvRows, COST_CSV_HEADER, perKmText, validateTypeForm, validateOdometerForm, PERIODS,
} from '../src/lib/maintenance.js';
import { kyivDate } from '../src/lib/format.js';
import { repairErrorText } from '../src/lib/repairs.js';
import { parseCrmHash } from '../src/lib/route.js';
import { toCsv } from '../src/lib/csv.js';

// Мінімальний DOM для h() / clear(): лише те, що чіпають view-функції під тестом.
class FakeNode {}
class FakeElement extends FakeNode {
    constructor(tag) {
        super();
        this.tagName = String(tag).toUpperCase();
        this.attrs = {};
        this.children = [];
        this.dataset = {};
        this.className = '';
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
}
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => Object.assign(new FakeNode(), { text }),
};
const text = (node) => (node.text !== undefined ? node.text : (node.children || []).map(text).join(''));
const all = (node, tag) => (node.children || []).flatMap((c) => [...(c.tagName === tag ? [c] : []), ...all(c, tag)]);

const { maintenanceTable, paintRepairsBadge } = await import('../src/views/repairs-maintenance.js');
const { costTable } = await import('../src/views/repairs-cost.js');
const { maintenanceChoices, maintenancePayload } = await import('../src/views/repairs-form.js');
const { repairsTabs, maintenanceByRepair } = await import('../src/views/repairs.js');

test('maintenanceEval: the same inclusive boundaries as kp_maintenance_eval', () => {
    const s = (km, days) => maintenanceEval(km, days).status;
    assert.equal(s(5001, null), 'ok');
    assert.equal(s(5000, null), 'yellow');
    assert.equal(s(0, null), 'red');
    assert.equal(s(-1, null), 'red');
    assert.equal(s(null, 15), 'ok');
    assert.equal(s(null, 14), 'yellow');
    assert.equal(s(null, 0), 'red');
    assert.equal(s(null, -3), 'red');
    assert.deepEqual(maintenanceEval(20000, 10), { status: 'yellow', reason: 'time' }, 'km ok + time yellow → yellow (time)');
    assert.deepEqual(maintenanceEval(0, 200), { status: 'red', reason: 'km' }, 'km red + time ok → red (km)');
    assert.deepEqual(maintenanceEval(null, null), { status: 'unknown', reason: null });
    assert.deepEqual(maintenanceEval('5000', ''), { status: 'yellow', reason: 'km' }, 'strings from PostgREST; empty = no dimension');
    assert.deepEqual(maintenanceEval(100, 3), { status: 'yellow', reason: 'km' }, 'tie → km');
});

test('sortMaintenance: red, then yellow, then ok / unknown; closer to due first', () => {
    const rows = [
        { vehicle_label: 'B', type_name: 'Масло', status: 'ok', left_km: 9000, left_days: 100 },
        { vehicle_label: 'A', type_name: 'Масло', status: 'unknown', left_km: null, left_days: null },
        { vehicle_label: 'C', type_name: 'Гальма', status: 'yellow', left_km: 4000, left_days: 300 },
        { vehicle_label: 'D', type_name: 'Масло', status: 'red', left_km: -10, left_days: 50 },
        { vehicle_label: 'E', type_name: 'Масло', status: 'yellow', left_km: null, left_days: 2 },
        { vehicle_label: 'F', type_name: 'Масло', status: 'red', left_km: null, left_days: -40 },
    ];
    assert.deepEqual(sortMaintenance(rows).map((r) => r.vehicle_label), ['F', 'D', 'E', 'C', 'B', 'A']);
    assert.equal(rows[0].vehicle_label, 'B', 'input not mutated');
});

test('maintenanceBadge: red count, else yellow count, zero → none', () => {
    assert.deepEqual(maintenanceBadge([{ status: 'red' }, { status: 'yellow' }, { status: 'red' }]), { count: 2, kind: 'red' });
    assert.deepEqual(maintenanceBadge([{ status: 'yellow' }, { status: 'ok' }]), { count: 1, kind: 'yellow' });
    assert.equal(maintenanceBadge([{ status: 'ok' }, { status: 'unknown' }]), null);
    assert.equal(maintenanceBadge(null), null);
    assert.equal(badgeTitle({ count: 3, kind: 'red' }), 'Протерміноване ТО: 3');
    assert.equal(badgeTitle(null), '');
});

test('texts: intervals, left km / days, last execution', () => {
    assert.match(intervalText(15000, 12), /^15\s000 км \/ 12 міс$/);
    assert.equal(intervalText(null, 6), '6 міс');
    assert.equal(intervalText(null, null), '—');
    assert.match(leftKmText({ left_km: 5000, interval_km: 10000 }), /^5\s000 км$/);
    assert.match(leftKmText({ left_km: -1200, interval_km: 10000 }), /^прострочено на 1\s200 км$/);
    assert.equal(leftKmText({ left_km: null, interval_km: 10000 }), 'Вкажіть показник одометра');
    assert.equal(leftKmText({ left_km: null, interval_km: null }), '—');
    assert.equal(leftDaysText({ left_days: 0 }), 'сьогодні');
    assert.equal(leftDaysText({ left_days: -3 }), 'прострочено на 3 дн');
    assert.equal(leftDaysText({ left_days: 14 }), '14 дн');
    assert.match(lastText({ last_on: '2026-09-05', last_km: 125000, last_source: 'repair' }), /^05\.09\.2026 \/ 125\s000 км$/);
    assert.match(lastText({ last_on: '2026-09-01', last_km: 120000, last_source: 'start' }), /^Старт: 01\.09\.2026/);
    assert.equal(lastText({ last_on: null }), 'Вкажіть показник одометра');
});

test('periods: Місяць / Квартал / Рік / Свій in Kyiv time, including the year change', () => {
    assert.deepEqual(PERIODS.map((p) => p.label), ['Місяць', 'Квартал', 'Рік', 'Свій період']);
    assert.deepEqual(periodRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(periodRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' }, 'leap year');
    assert.deepEqual(periodRange('quarter', '2026-05-31'), { from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(periodRange('quarter', '2026-12-31'), { from: '2026-10-01', to: '2026-12-31' });
    assert.deepEqual(periodRange('year', '2026-10-24'), { from: '2026-01-01', to: '2026-12-31' });
    assert.deepEqual(periodRange('custom', '2026-10-24', { from: '2025-11-01', to: '2026-01-31' }), { from: '2025-11-01', to: '2026-01-31' });
    // 31.12 о 22:30 UTC — у Києві вже 1 січня: місяць, квартал і рік — нові.
    const newYear = kyivDate(new Date('2026-12-31T22:30:00Z'));
    assert.equal(newYear, '2027-01-01');
    assert.deepEqual(periodRange('month', newYear), { from: '2027-01-01', to: '2027-01-31' });
    assert.deepEqual(periodRange('quarter', newYear), { from: '2027-01-01', to: '2027-03-31' });
    assert.deepEqual(periodRange('year', newYear), { from: '2027-01-01', to: '2027-12-31' });
    assert.deepEqual(periodRange('month', kyivDate(new Date('2026-12-31T21:59:00Z'))), { from: '2026-12-01', to: '2026-12-31' }, '23:59 Kyiv is still December');
});

test('periodError: both dates, from ≤ to, under 3 years (as the server)', () => {
    assert.equal(periodError({ from: '2026-09-01', to: '2026-09-01' }), '');
    assert.equal(periodError({ from: '2026-09-02', to: '2026-09-01' }), '«З» має бути не пізніше «по».');
    assert.equal(periodError({ from: '', to: '2026-09-01' }), 'Вкажіть обидві дати.');
    assert.equal(periodError({ from: '2023-01-02', to: '2026-01-01' }), '');
    assert.equal(periodError({ from: '2023-01-01', to: '2026-01-01' }), 'Період — менше 3 років.');
});

test('cost: totals, ₴/km with 2 decimals, "немає пробігу", CSV', () => {
    const rows = [
        { vehicle_label: 'AA 1', repairs_count: 2, parts_cost: '200.00', service_cost: '400.00', cost: '600.00', km: '550.0', cost_per_km: '1.09' },
        { vehicle_label: '=cmd', repairs_count: 1, parts_cost: '0.00', service_cost: '50.00', cost: '50.00', km: '0', cost_per_km: null },
    ];
    assert.deepEqual(costTotals(rows), { parts: 200, service: 450, cost: 650, km: 550, perKm: 1.18 });
    assert.equal(costTotals([]).perKm, null);
    assert.equal(perKmText(null), 'немає пробігу');
    assert.match(perKmText('1.09'), /^1,09 ₴\/км$/);
    const csv = toCsv(COST_CSV_HEADER, costCsvRows(rows));
    assert.match(csv, /^﻿Авто;Ремонтів;/);
    assert.match(csv, /AA 1;2;200;400;600;550;1,09/);
    assert.match(csv, /'=cmd;1;0;50;50;0;\r\n/, 'formula-like label escaped, empty ₴/km');
    assert.match(csv, /Разом;3;200;450;650;550;1,18/);
});

test('forms: type template and odometer validation', () => {
    assert.deepEqual(validateTypeForm({ name: 'Масло', interval_km: '15000', interval_months: '' }), []);
    assert.equal(validateTypeForm({ name: ' ', interval_km: '1', interval_months: '' }).length, 1);
    assert.equal(validateTypeForm({ name: 'x'.repeat(81), interval_km: '1' }).length, 1);
    assert.deepEqual(validateTypeForm({ name: 'X', interval_km: '', interval_months: '' }), ['Вкажіть інтервал у км або в місяцях.']);
    assert.equal(validateTypeForm({ name: 'X', interval_km: '0', interval_months: '121' }).length, 2);
    assert.deepEqual(validateOdometerForm({ vehicle_id: 'v', date: '2026-10-24', km: '120000' }, '2026-10-24'), []);
    assert.equal(validateOdometerForm({ vehicle_id: 'v', date: '2026-10-25', km: '1' }, '2026-10-24').length, 1, 'future date');
    assert.equal(validateOdometerForm({ vehicle_id: '', date: '2026-10-24', km: '1.5' }, '2026-10-24').length, 2);
    assert.equal(validateOdometerForm({ vehicle_id: 'v', date: '2026-10-24', km: '' }, '2026-10-24').length, 1);
});

test('errors: Ukrainian texts for the new codes', () => {
    assert.match(repairErrorText({ message: 'MAINT_TYPE_ARCHIVED' }), /в архіві/);
    assert.match(repairErrorText({ message: 'MAINT_TYPE_EXISTS' }), /вже є/);
    assert.match(repairErrorText({ message: 'REPAIR_ALREADY_VOID' }), /сторновано/);
    assert.match(repairErrorText({ message: 'REPAIR_VEHICLE_NOT_FOUND' }), /автопарку вашої компанії/);
    assert.match(repairErrorText({ message: 'PERIOD_TOO_LONG' }), /3 років/);
    assert.match(repairErrorText({ message: 'ODOMETER_BAD_VALUES' }), /одометра/);
    assert.match(repairErrorText({ message: 'REPAIR_NOT_FOUND' }), /Ремонт не знайдено/);
});

test('routes and sub-tabs: ТО and Вартість на км', () => {
    assert.deepEqual(parseCrmHash('#/repairs/maintenance'), { view: 'repairs', sub: 'maintenance' });
    assert.deepEqual(parseCrmHash('#/repairs/cost'), { view: 'repairs', sub: 'cost' });
    assert.deepEqual(repairsTabs({ canManage: false }).map((t) => t.label), ['Ремонти', 'ТО', 'Вартість на км', 'Склад']);
    assert.deepEqual(repairsTabs({ canManage: true }).map((t) => t.sub), ['list', 'maintenance', 'cost', 'stock', 'handlers']);
});

test('UI badge: painted with h() / textContent, replaced and removed', () => {
    const button = new FakeElement('button');
    button.append(document.createTextNode('Ремонти'));
    assert.deepEqual(paintRepairsBadge(button, [{ status: 'red' }, { status: 'red' }, { status: 'yellow' }]), { count: 2, kind: 'red' });
    assert.equal(text(button), 'Ремонти2');
    assert.equal(button.children[1].className, 'kpr-nav-badge kpr-nav-badge-red');
    assert.equal(button.getAttribute('aria-label'), 'Ремонти. Протерміноване ТО: 2');
    paintRepairsBadge(button, [{ status: 'yellow' }]);
    assert.equal(button.children.length, 2, 'one badge, not two');
    assert.equal(button.children[1].className, 'kpr-nav-badge kpr-nav-badge-yellow');
    paintRepairsBadge(button, [{ status: 'ok' }]);
    assert.equal(text(button), 'Ремонти');
    assert.equal(button.getAttribute('title'), null);
    assert.equal(paintRepairsBadge(null, []), null);
});

test('UI list: problems first, user text as text nodes, left km / days and last execution', () => {
    const rows = [
        { vehicle_id: 'v1', vehicle_label: 'AA 0001', type_name: 'Масло', interval_km: 15000, interval_months: 12, status: 'ok', reason: 'km',
            left_km: 9000, left_days: 200, last_on: '2026-09-01', last_km: 120000, last_source: 'start', odometer_km: 126000 },
        { vehicle_id: 'v2', vehicle_label: '<img src=x onerror=alert(1)>', type_name: 'Гальма', interval_km: 40000, interval_months: 24, status: 'red', reason: 'km',
            left_km: -500, left_days: 30, last_on: '2026-01-10', last_km: 80000, last_source: 'repair', overridden: true, odometer_km: 120500 },
    ];
    const table = maintenanceTable(rows);
    const trs = all(table, 'TR').slice(1);
    assert.equal(trs[0].className, 'kpr-row-red', 'red first');
    assert.equal(text(trs[0].children[0]), '<img src=x onerror=alert(1)>', 'label stays text');
    assert.match(text(trs[0].children[1]), /Гальма 40\s000 км \/ 24 міс.*своє/);
    assert.equal(text(trs[0].children[2]), 'Протерміновано');
    assert.match(text(trs[0].children[3]), /прострочено на 500 км/);
    assert.equal(trs[0].children[3].className, 'mono kpr-why', 'the dimension that fired is highlighted');
    assert.equal(text(trs[0].children[4]), '30 дн');
    assert.match(text(trs[1].children[5]), /^Старт: 01\.09\.2026 \/ 120\s000 км$/);
    assert.deepEqual(all(table, 'TH').map(text), ['Авто', 'Тип ТО', 'Статус', 'Залишок км', 'Залишок днів', 'Остання: дата / км']);
});

test('UI cost table: per vehicle and total row', () => {
    const table = costTable([
        { vehicle_label: 'AA 1', repairs_count: 2, parts_cost: '200.00', service_cost: '400.00', cost: '600.00', km: '550.0', cost_per_km: '1.09' },
        { vehicle_label: 'BB 2', repairs_count: 1, parts_cost: '0.00', service_cost: '50.00', cost: '50.00', km: '0', cost_per_km: null },
    ]);
    const trs = all(table, 'TR');
    assert.equal(trs.length, 4, 'head + 2 vehicles + total');
    assert.match(text(trs[1].children[6]), /^1,09 ₴\/км$/);
    assert.equal(text(trs[2].children[6]), 'немає пробігу');
    assert.match(text(trs[3]), /^Разом3.*1,18 ₴\/км$/);
});

test('UI repair form: «Виконане ТО» only with a vehicle; payload keeps chosen active types', () => {
    const types = [{ id: 't1', name: 'Масло', is_active: true }, { id: 't2', name: 'Старе', is_active: false }, { id: 't3', name: 'Гальма', is_active: true }];
    assert.deepEqual(maintenanceChoices(types, ''), [], 'no vehicle → hidden');
    assert.deepEqual(maintenanceChoices(types, 'v1').map((t) => t.id), ['t1', 't3']);
    assert.deepEqual(maintenancePayload(['t3', 't1', 't3', 't2', 'zz'], maintenanceChoices(types, 'v1')), ['t3', 't1']);
    assert.deepEqual(maintenancePayload([], maintenanceChoices(types, 'v1')), []);
    assert.deepEqual([...maintenanceByRepair([{ repair_id: 'r1', type_name: 'Масло' }, { repair_id: 'r1', type_name: 'Фільтри' }, { repair_id: 'r2', type_name: 'Гальма' }])],
        [['r1', 'Масло, Фільтри'], ['r2', 'Гальма']]);
});

test('3b sources: no innerHTML / outerHTML / insertAdjacentHTML; RPC names exist in the migration', () => {
    const app = new URL('../', import.meta.url);
    const sources = ['src/views/repairs-maintenance.js', 'src/views/repairs-cost.js', 'src/views/repairs-form.js', 'src/lib/maintenance.js', 'src/bridge.js']
        .map((f) => fs.readFileSync(new URL(f, app), 'utf8')).join('\n');
    assert.doesNotMatch(sources, /innerHTML|outerHTML|insertAdjacentHTML/);
    const dir = new URL('../../supabase/migrations/', app);
    const migration = fs.readdirSync(dir).find((f) => /^\d{14}_repairs_maintenance\.sql$/.test(f));
    const sql = fs.readFileSync(new URL(migration, dir), 'utf8');
    const rpcs = new Set([...sources.matchAll(/rpc\('(kp_[a-z_]+)'/g)].map((m) => m[1]));
    for (const name of ['kp_maintenance_status', 'kp_maintenance_seed_defaults', 'kp_maintenance_type_upsert', 'kp_maintenance_type_archive',
        'kp_maintenance_override_set', 'kp_maintenance_override_clear', 'kp_odometer_add', 'kp_odometer_list', 'kp_vehicle_mileage',
        'kp_repair_set_maintenance', 'kp_repair_cost_per_km']) {
        assert.ok(rpcs.has(name), 'UI calls ' + name);
        assert.match(sql, new RegExp('FUNCTION public\\.' + name + '\\('), name + ' in the migration');
    }
    assert.ok(!rpcs.has('kp_vehicle_trip_km') && !rpcs.has('kp_vehicle_mileage_at'), 'internal functions are never called from the UI');
});
