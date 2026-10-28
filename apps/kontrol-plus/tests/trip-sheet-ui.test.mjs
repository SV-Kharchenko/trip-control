import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCrmHash } from '../src/lib/route.js';
import { TRIP_STATUS_LABELS, DOC_KIND_LABELS, docStatusLabel } from '../src/lib/docs.js';
import { TS_STATUS_LABELS, TS_FIELD_LABELS } from '../src/lib/trip-sheet.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

test('маршрути: картка листа, нова форма (з рейсом і без), документи з прийнятої заявки', () => {
    assert.deepEqual(parseCrmHash('#/docs/trip_sheet/' + ID), { view: 'docs', sub: 'trip_sheet', id: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/trip_sheet'), { view: 'docs', sub: 'new', kind: 'trip_sheet', client: null, calc: null });
    assert.deepEqual(parseCrmHash('#/docs/new/trip_sheet/calc/' + ID), { view: 'docs', sub: 'new', kind: 'trip_sheet', client: null, calc: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/ttn/calc/' + ID), { view: 'docs', sub: 'new', kind: 'ttn', client: null, calc: ID });
    assert.deepEqual(parseCrmHash(`#/docs/new/ttn/${CLIENT}/${ID}`), { view: 'docs', sub: 'new', kind: 'ttn', client: CLIENT, calc: ID }, 'старий маршрут ТТН працює');
    assert.equal(parseCrmHash('#/docs/trip_sheet/zzz'), null);
    assert.equal(parseCrmHash('#/docs/new/trip_sheet/calc/zzz'), null);
});

test('статуси: Видано / Закрито / Анульовано в списку, картці й логіці однакові', () => {
    assert.deepEqual(TRIP_STATUS_LABELS, TS_STATUS_LABELS);
    assert.equal(docStatusLabel('trip_sheet', 'closed'), 'Закрито');
    assert.equal(docStatusLabel('trip_sheet', 'issued'), 'Видано');
    assert.equal(DOC_KIND_LABELS.trip_sheet, 'Подорожній');
});

test('список: подорожні листи разом із ТТН, мітка «Подорожній», фільтр за статусом, права', async () => {
    const fakeDom = { createElement: (tag) => ({ tagName: tag, children: [], attrs: {}, setAttribute() {}, append() {}, addEventListener() {}, classList: { add() {} } }), createTextNode: (text) => ({ text }) };
    Object.defineProperty(globalThis, 'document', { value: fakeDom, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Node', { value: class {}, configurable: true, writable: true });
    try {
        const { tsListRow, tsStatusFilter, ttnStatusFilter } = await import('../src/views/docs.js');
        const row = tsListRow({ id: ID, status: 'closed', number: 4, doc_date: '2026-10-28', vehicle_reg: 'AA1' });
        assert.equal(row.kind, 'trip_sheet');
        assert.equal(row.pay_status, 'closed');
        assert.equal(row.total, null);
        assert.deepEqual(tsStatusFilter('closed'), { include: true, value: 'closed' });
        assert.deepEqual(tsStatusFilter('paid'), { include: false, value: null }, 'статуси оплати подорожніх листів не стосуються');
        assert.deepEqual(ttnStatusFilter('closed'), { include: false, value: null }, '«Закрито» — не статус ТТН');
    } finally {
        delete globalThis.document;
        delete globalThis.Node;
    }
    const docs = read('src/views/docs.js');
    assert.match(docs, /rpc\('kp_trip_sheet_list'/);
    assert.match(docs, /kpd-kind kpd-kind-ts' \}, 'Подорожній'/);
    assert.match(docs, /Створити подорожній лист/);
    assert.match(docs, /kp_trip_sheet_cancel/);
    assert.match(docs, /access\.isOwner && r\.status === 'issued' \? cancelControl/, 'анулює лише власник і лише видані');
});

test('форма: позначка «змінено» й повернення значення із заявки, без персональних даних, без заявки лишається порожня форма', () => {
    const form = read('src/views/docs-ts-form.js');
    assert.match(form, /kp_calc_doc_prefill/);
    assert.match(form, /class: 'kpts-changed'/);
    assert.match(form, /Повернути значення із заявки/);
    assert.match(form, /CALC_NOT_ACCEPTED/);
    assert.match(form, /route\.calc/);
    assert.doesNotMatch(form, /phone|passport|ipn|address|kp_driver_details/);
    assert.match(form, /pre \? tsFromPrefill\(pre, today\) : emptyTripSheet\(today\)/);
    for (const label of ['Виїзд: спідометр, км', 'Передрейсовий медогляд: хто', 'Технічно справний']) assert.ok(Object.values(TS_FIELD_LABELS).includes(label), label);
});

test('картка: закриття лише для видано + права запису, розрахунок наперед, ТТН цього рейсу', () => {
    const card = read('src/views/docs-ts-card.js');
    assert.match(card, /issued && access\.canWrite \? closeForm\(doc\)/);
    assert.match(card, /rpc\('kp_trip_sheet_close'/);
    assert.match(card, /calcTripSheet\(/);
    assert.match(card, /access\.isOwner && issued/);
    assert.match(card, /ТТН цього рейсу/);
    assert.match(card, /p_calculation: doc\.calculation_id/);
    assert.doesNotMatch(card, /innerHTML/);
});

test('вкладка перейменована: ніде в UI не лишилось «2-ТН»', () => {
    for (const file of ['src/views/docs.js', 'src/views/docs-ts-card.js', 'src/views/docs-ts-form.js', 'src/bridge.js', 'src/lib/trip-sheet.js']) {
        assert.doesNotMatch(read(file).replace(/^\/\/.*$/gm, ''), /2-ТН/, file);
    }
});
