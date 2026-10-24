import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { repairsAccess, repairTotals, validateRepairForm, repairPartsPayload, repairErrorText, seatsText, importStatusLabel, stockValue } from '../src/lib/repairs.js';
import { fmtMoneyCents, kyivDate } from '../src/lib/format.js';
import { parseCrmHash, tabOf } from '../src/lib/route.js';
import { importCanCommit } from '../src/views/repairs-import.js';
import { filterParts } from '../src/views/repairs-stock.js';
import { partOptionLabel } from '../src/views/repairs-form.js';

const APP = new URL('../', import.meta.url);

test('repairsAccess: hidden without context; repair manager without own Контроль+ → repairs only', () => {
    assert.deepEqual(repairsAccess(null, { control_plus: true }), { visible: false, role: null, canWrite: false, canManage: false, repairsOnly: false });
    assert.equal(repairsAccess({ org_id: null }, null).visible, false);
    const owner = repairsAccess({ org_id: 'o', role: 'owner', can_write: true, can_manage_handlers: true }, { control_plus: true });
    assert.deepEqual(owner, { visible: true, role: 'owner', canWrite: true, canManage: true, repairsOnly: false });
    const viewer = repairsAccess({ org_id: 'o', role: 'logist', can_write: false, can_manage_handlers: false }, { control_plus: true });
    assert.equal(viewer.canWrite, false, 'logist not assigned → read only');
    const manager = repairsAccess({ org_id: 'o', role: 'repair_manager', can_write: true, can_manage_handlers: false }, { control_plus: false });
    assert.equal(manager.repairsOnly, true);
    assert.equal(manager.canManage, false);
});

test('routes: #/repairs and its sub-tabs; unknown sub → not a route', () => {
    assert.deepEqual(parseCrmHash('#/repairs'), { view: 'repairs', sub: 'list' });
    for (const sub of ['new', 'stock', 'handlers', 'maintenance', 'cost']) assert.deepEqual(parseCrmHash('#/repairs/' + sub), { view: 'repairs', sub });
    assert.equal(tabOf(parseCrmHash('#/repairs/stock')), 'repairs');
    assert.notDeepEqual(parseCrmHash('#/repairs/other'), { view: 'repairs', sub: 'other' });
});

const parts = new Map([
    ['p1', { id: 'p1', name: 'Фільтр', unit: 'шт', qty: '3', avg_cost: '120.3333' }],
    ['p2', { id: 'p2', name: 'Масло', unit: 'л', qty: '10.5', avg_cost: '250' }],
]);

test('repairTotals: parts at current average cost, rounded to kopiyky, + service', () => {
    assert.deepEqual(repairTotals([{ part_id: 'p1', qty: '2' }, { part_id: 'p2', qty: '1.5' }, { part_id: 'x', qty: '9' }], parts, '1000.50'),
        { parts: 615.67, service: 1000.5, total: 1616.17 });
    assert.deepEqual(repairTotals([], parts, ''), { parts: 0, service: 0, total: 0 });
});

test('validateRepairForm: required fields, future date, stock shortage summed over lines', () => {
    const ok = { vehicle_id: 'v', date: '2026-10-24', works: 'ТО', lines: [{ part_id: 'p1', qty: '3' }] };
    assert.deepEqual(validateRepairForm(ok, parts, '2026-10-24'), []);
    const fields = (form) => validateRepairForm(form, parts, '2026-10-24').map((e) => e.field);
    assert.deepEqual(fields({ ...ok, vehicle_id: '' }), ['vehicle']);
    assert.deepEqual(fields({ ...ok, date: '2026-10-25' }), ['date']);
    assert.deepEqual(fields({ ...ok, odometer: '12.5' }), ['odometer']);
    assert.deepEqual(fields({ ...ok, service_cost: '-1' }), ['service_cost']);
    assert.deepEqual(fields({ ...ok, lines: [{ part_id: 'p1', qty: '2' }, { part_id: 'p1', qty: '2' }] }), ['stock'], 'two lines of one part');
    assert.deepEqual(fields({ ...ok, lines: [{ part_id: '', qty: '1' }, { part_id: 'p2', qty: '0' }] }), ['line-0', 'line-1']);
    const shortage = validateRepairForm({ ...ok, lines: [{ part_id: 'p2', qty: '11' }] }, parts, '2026-10-24');
    assert.match(shortage[0].text, /Масло \(є 10\.5 л\)/);
    assert.deepEqual(repairPartsPayload([{ part_id: 'p1', qty: '1.5' }, { part_id: '', qty: '1' }, { part_id: 'p2', qty: '0' }]), [{ part_id: 'p1', qty: 1.5 }]);
});

test('repairErrorText: STOCK_INSUFFICIENT names the part; codes map to Ukrainian text', () => {
    assert.equal(repairErrorText({ message: 'STOCK_INSUFFICIENT', details: 'Фільтр' }), 'Не вистачає на складі: Фільтр. Нічого не списано.');
    assert.match(repairErrorText({ message: 'REPAIR_VOID_EXPIRED' }), /24 години/);
    assert.match(repairErrorText({ message: 'REPAIR_MANAGER_LIMIT' }), /2 менеджери/);
    assert.equal(repairErrorText({ message: 'something', code: '42501' }), 'Недостатньо прав для цієї дії.');
    assert.equal(repairErrorText({ message: 'boom' }), 'Не вдалося виконати дію. Спробуйте ще раз.');
    assert.equal(repairErrorText(null), '');
});

test('seatsText, importStatusLabel, importCanCommit, stockValue', () => {
    assert.equal(seatsText({ used: 2, limit: 2, pending: 1 }), 'Менеджерів з ремонтів: 2 з 2 (з них очікують: 1)');
    assert.equal(seatsText({ used: 0, limit: 2, pending: 0 }), 'Менеджерів з ремонтів: 0 з 2');
    assert.equal(seatsText(null), '');
    assert.equal(importStatusLabel('new_part'), 'Нова запчастина');
    assert.equal(importStatusLabel('error'), 'Помилка');
    assert.equal(importCanCommit({ summary: { total: 3, errors: 0 } }), true);
    assert.equal(importCanCommit({ summary: { total: 3, errors: 1 } }), false);
    assert.equal(importCanCommit({ summary: { total: 0, errors: 0 } }), false);
    assert.equal(importCanCommit(null), false);
    assert.equal(stockValue({ qty: '3', avg_cost: '120.3333' }), 361);
});

test('filterParts and partOptionLabel', () => {
    const list = [{ name: 'Фільтр масляний', article: 'W712', qty: 2, unit: 'шт' }, { name: 'Масло', article: null, qty: 10.5, unit: 'л' }];
    assert.equal(filterParts(list, 'w712').length, 1);
    assert.equal(filterParts(list, '  ').length, 2);
    assert.equal(filterParts(list, 'масло')[0].name, 'Масло');
    assert.match(partOptionLabel(list[0]), /^Фільтр масляний \(W712\) — залишок 2 шт$/);
    assert.match(partOptionLabel(list[1]), /^Масло — залишок 10,5 л$/);
});

test('fmtMoneyCents and kyivDate', () => {
    assert.match(fmtMoneyCents('1234.5'), /^1\s234,50 ₴$/);
    assert.equal(fmtMoneyCents(''), '—');
    assert.equal(kyivDate(new Date('2026-10-24T21:30:00Z')), '2026-10-25', 'Europe/Kyiv, not UTC');
});

test('repairs views: no innerHTML / outerHTML / insertAdjacentHTML', () => {
    const files = fs.readdirSync(new URL('src/views/', APP)).filter((f) => /^repairs.*\.js$/.test(f));
    assert.deepEqual(files.sort(), ['repairs-cost.js', 'repairs-form.js', 'repairs-handlers.js', 'repairs-import.js', 'repairs-maintenance.js', 'repairs-stock.js', 'repairs.js']);
    for (const file of files) {
        assert.doesNotMatch(fs.readFileSync(new URL('src/views/' + file, APP), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML/, file);
    }
});

test('repairs CSS classes do not collide with the site (its index.html has global .rp-*)', () => {
    const site = fs.readFileSync(new URL('../../index.html', APP), 'utf8');
    const css = fs.readFileSync(new URL('src/crm.css', APP), 'utf8');
    const ours = [...new Set(css.match(/\.kpr-[a-z-]+/g))];
    assert.ok(ours.length > 10);
    for (const cls of ours) assert.ok(!site.includes(cls.slice(1)), cls);
    assert.doesNotMatch(css, /\.rp-/);
});
