// Подорожній лист: дозаправки в дорозі — факт пального, підсумки, попередження про км з вантажем, PDF / Excel, міграція. Усі дані вигадані.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { buildTripSheetPdf } from '../src/lib/pdf-trip-sheet.js';
import { buildDocXlsx, tripSheetSheet } from '../src/lib/xlsx-docs.js';
import { calcTripSheet, tsErrorText, tsFromPrefill } from '../src/lib/trip-sheet.js';
import { loadedKmWarning, totalsRows, tsTotals } from '../src/lib/trip-sheet-stages.js';
import {
    MAX_REFUELS, PAY_METHODS, REFUEL_COLUMNS, addRefuel, emptyRefuel, refuelAmount, refuelFromDoc, refuelsPayload, refuelsTotal, removeRefuel, tsRefuelRows, validateRefuels,
} from '../src/lib/trip-sheet-refuels.js';

const APP = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), 'utf8');
const fonts = {
    regular: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Regular.ttf', APP))),
    bold: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Bold.ttf', APP))),
};

const base = (over = {}) => ({
    kind: 'trip_sheet', id: 'ts1', number: 7, prefix: 'ПЛ-', number_text: 'ПЛ-7', doc_date: '2026-10-28', valid_from: '2026-10-28', valid_to: '2026-10-30', status: 'issued',
    carrier: { name: 'ТОВ Перевізник', code: '12345678', address: 'м. Луцьк' }, driver: { full_name: 'Петренко Петро Петрович', license_no: 'BB654321' },
    vehicle: { make_model: 'DAF XF', reg_number: 'AA1111AA', fuel_load: 30, fuel_empty: 20 },
    task: { customer: 'Агро', route_from: 'Луцьк', route_to: 'Одеса', cargo: 'Пшениця', tonnage: 22, loaded_km: 300 },
    depart_at: '2026-10-28T03:00:00Z', depart_odometer: 100000, depart_fuel_left: 80, fuel_issued: 200, fuel_kind: 'ДП', ...over,
});
const refuel = (n, over = {}) => ({
    position: n, refuel_at: '2026-10-28T11:00:00Z', place: 'АЗС WOG, Житомир ' + n, liters: 100, price_per_l: 55.5, amount: 5550, pay_method: 'card', receipt_no: '№' + n, ...over,
});

// ---- Факт пального ----
test('факт = виїзд + видано + дозаправки − залишок; без дозаправок — як раніше', () => {
    const input = { depart_odometer: 100000, return_odometer: 100600, depart_fuel_left: 80, fuel_issued: 200, return_fuel_left: 50, loaded_km: 300, fuel_load: 30, fuel_empty: 20 };
    assert.equal(calcTripSheet(input).fuel_actual, 230, 'старий лист: 80 + 200 − 50');
    assert.equal(calcTripSheet({ ...input, fuel_refueled: 0 }).fuel_actual, 230);
    assert.equal(calcTripSheet({ ...input, fuel_refueled: 150.5 }).fuel_actual, 380.5);
    assert.equal(calcTripSheet({ ...input, fuel_refueled: 150.5 }).fuel_diff, round1(380.5 - calcTripSheet(input).fuel_norm));
});
const round1 = (n) => Math.round(n * 10) / 10;

test('від’ємний факт — помилка; дозаправки роблять допустимим більший залишок', () => {
    const input = { depart_odometer: 100000, return_odometer: 100600, depart_fuel_left: 80, fuel_issued: 200, return_fuel_left: 290 };
    assert.ok(calcTripSheet(input).errors.return_fuel_left);
    assert.ok(calcTripSheet({ ...input, fuel_refueled: 9 }).errors.return_fuel_left, '80 + 200 + 9 − 290 < 0');
    assert.deepEqual(calcTripSheet({ ...input, fuel_refueled: 10 }).errors, {}, 'рівно 0 — можна');
    assert.equal(calcTripSheet({ ...input, fuel_refueled: 10 }).fuel_actual, 0);
    assert.match(tsErrorText({ message: 'TS_FUEL_NEGATIVE' }), /видачею і дозаправками/);
});

test('дозаправки: сума, Σ літрів, payload, валідація, додавання / видалення', () => {
    assert.equal(refuelAmount('100', '55,5'), 5550);
    assert.equal(refuelAmount('33,3', '48,99'), 1631.37);
    assert.equal(refuelAmount('100', ''), null);
    const list = [emptyRefuel({ liters: '100', price_per_l: '55,5', place: ' АЗС ', pay_method: 'card' }), emptyRefuel(), emptyRefuel({ liters: '50,5', pay_method: 'cash' })];
    assert.equal(refuelsTotal(list), 150.5);
    assert.equal(refuelsTotal([]), 0);
    assert.equal(refuelsTotal([emptyRefuel({ liters: 'abc' }), emptyRefuel({ liters: '-5' })]), 0);
    const payload = refuelsPayload(list);
    assert.equal(payload.length, 2, 'порожній рядок не зберігається');
    assert.deepEqual(payload[0], { refuel_at: null, place: 'АЗС', liters: '100', price_per_l: '55.5', pay_method: 'card', receipt_no: null });
    assert.equal(payload[1].liters, '50.5');
    assert.deepEqual(validateRefuels(list), {});
    assert.ok(validateRefuels([emptyRefuel({ place: 'без літрів' })])[0].liters);
    assert.ok(validateRefuels([emptyRefuel({ liters: '0' })])[0].liters);
    assert.ok(validateRefuels([emptyRefuel({ liters: '5001' })])[0].liters);
    assert.ok(validateRefuels([emptyRefuel({ liters: '5', price_per_l: '-1' })])[0].price_per_l);
    assert.ok(validateRefuels([emptyRefuel({ liters: '5', pay_method: 'bitcoin' })])[0].pay_method);
    assert.deepEqual(Object.keys(PAY_METHODS), ['card', 'cash', 'coupons']);
    let grown = [];
    for (let i = 0; i < MAX_REFUELS + 5; i += 1) grown = addRefuel(grown);
    assert.equal(grown.length, MAX_REFUELS);
    assert.equal(removeRefuel([1, 2, 3], 1).join(), '1,3');
    const row = refuelFromDoc(refuel(1, { liters: 100.5, price_per_l: null }));
    assert.equal(row.liters, '100,5');
    assert.equal(row.price_per_l, '');
    assert.equal(row.pay_method, 'card');
});

// ---- Підсумки ----
test('підсумки: окремий рядок «Дозаправки, л»; факт з дозаправками в прев’ю; закритий лист бере збережене; старий — як раніше', () => {
    const issued = base({ stages: [], task: { loaded_km: 300 } });
    const old = tsTotals(issued, { returnOdometer: 100600, returnFuelLeft: 50 });
    assert.equal(old.refuel_l, 0);
    assert.equal(old.fuel_actual, 230);
    const withRefuels = tsTotals(issued, { refuels: [emptyRefuel({ liters: '100' }), emptyRefuel({ liters: '50,5' })], returnOdometer: 100600, returnFuelLeft: 50 });
    assert.equal(withRefuels.refuel_l, 150.5);
    assert.equal(withRefuels.fuel_actual, 380.5);
    const rows = totalsRows(withRefuels).map((r) => r[0]);
    assert.ok(rows.includes('Дозаправки, л'));
    assert.ok(rows.indexOf('Дозаправки, л') < rows.indexOf('Пальне фактично, л'));
    assert.equal(totalsRows(withRefuels).find((r) => r[0] === 'Дозаправки, л')[1], '150,5');
    assert.equal(totalsRows(old).find((r) => r[0] === 'Дозаправки, л')[1], '0');
    // Збережений лист: сума з сервера (totals.refuel_l) або з рядків.
    const saved = base({ totals: { refuel_l: 150.5, trips: 0 }, refuels: [refuel(1)], return_odometer: 100600, return_fuel_left: 50 });
    assert.equal(tsTotals(saved).refuel_l, 150.5);
    assert.equal(tsTotals(base({ refuels: [refuel(1), refuel(2, { liters: 20.5 })] })).refuel_l, 120.5, 'без totals — з рядків');
    // Закритий: нічого не перераховуємо, факт і норма — збережені.
    const closed = base({ status: 'closed', return_odometer: 100600, return_fuel_left: 50, distance_km: 600, fuel_actual: 380.5, fuel_norm: 170, fuel_diff: 210.5, refuels: [refuel(1)], totals: { refuel_l: 150.5, trips: 0 } });
    const closedTotals = tsTotals(closed);
    assert.equal(closedTotals.fuel_actual, 380.5);
    assert.equal(closedTotals.refuel_l, 150.5);
});

test('попередження: км з вантажем (857) більше за пробіг за одометрами (500) — не блок; джерело: план із завдання або етапи', () => {
    assert.equal(loadedKmWarning(300, 600, false), '');
    assert.equal(loadedKmWarning(600, 600, false), '', 'рівність — не попередження');
    assert.equal(loadedKmWarning('', 600, false), '');
    assert.equal(loadedKmWarning(857, null, false), '');
    const plan = loadedKmWarning(857, 500, false);
    assert.match(plan, /Км з вантажем \(857\) більше за загальний пробіг за одометрами \(500\)/);
    assert.match(plan, /план із завдання/);
    assert.match(loadedKmWarning(857, 500, true), /км в етапах/);
    const doc = base({ task: { loaded_km: 857 }, return_odometer: 100500, return_fuel_left: 50, status: 'closed', distance_km: 500, fuel_actual: 230, fuel_norm: 100, fuel_diff: 130 });
    const t = tsTotals(doc);
    assert.match(t.loaded_warning, /857/);
    const row = totalsRows(t).find((r) => r[0] === 'Увага');
    assert.ok(row && /857/.test(row[1]), 'попередження друкується в підсумках');
    assert.equal(totalsRows(tsTotals(base({ status: 'closed', distance_km: 600, task: { loaded_km: 300 } }))).some((r) => r[0] === 'Увага'), false);
    // Сервер не блокує закриття через це попередження — лише TS_FUEL_NEGATIVE (перевірка в pgTAP).
    assert.doesNotMatch(read('../../supabase/migrations/20261109090000_kp_trip_sheet_refuels.sql'), /loaded_km[^;]*>[^;]*v_dist[^;]*RAISE/);
});

test('звідки 857: loaded_km листа — це план із заявки (route.dist_km), а не пробіг за одометрами', () => {
    const d = tsFromPrefill({ route: { from: 'Київ', to: 'Одеса', dist_km: 857, feed_km: 40 }, vehicle: { reg_number: 'AA1' } }, '2026-10-28');
    assert.equal(d.task.loaded_km, '857');
    assert.equal(d.task.planned_km, '897');
});

// ---- Норми з префілу ----
test('норми «— / —»: без картки авто беруться з норм заявки / «Витратної частини» (p.norms)', () => {
    const noCard = tsFromPrefill({ norms: { fuel_load: 36.5, fuel_empty: 28 } }, '2026-10-28');
    assert.equal(noCard.vehicle.fuel_load, '36.5');
    assert.equal(noCard.vehicle.fuel_empty, '28');
    const card = tsFromPrefill({ vehicle: { reg_number: 'AA1', fuel_load: 32, fuel_empty: 24 }, norms: { fuel_load: 32, fuel_empty: 24 } }, '2026-10-28');
    assert.equal(card.vehicle.fuel_load, '32');
    const none = tsFromPrefill({ vehicle: { reg_number: 'AA1' } }, '2026-10-28');
    assert.equal(none.vehicle.fuel_load, '');
});

// ---- PDF / Excel ----
const pageSizes = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getSize());

test('PDF: блок «Дозаправки в дорозі» на зворотному боці перед підсумками, альбомна, дані без обрізання', async () => {
    const doc = base({ status: 'closed', return_odometer: 100600, return_fuel_left: 50, distance_km: 600, fuel_actual: 380.5, fuel_norm: 170, fuel_diff: 210.5,
        totals: { refuel_l: 150.5, trips: 0 }, refuels: [refuel(1), refuel(2, { place: 'АЗС OKKO, Умань', liters: 50.5, price_per_l: null, amount: null, pay_method: 'cash', receipt_no: null })] });
    const { bytes, info } = await buildTripSheetPdf(doc, { fonts });
    for (const { width, height } of await pageSizes(bytes)) assert.ok(width > height, 'landscape');
    const texts = info.texts.map((t) => t.text);
    assert.ok(texts.includes('ДОЗАПРАВКИ В ДОРОЗІ'));
    for (const needle of ['АЗС WOG, Житомир 1', 'АЗС OKKO, Умань', 'картка', 'готівка', '№1', 'Літри', 'Дозаправки, л', '150,5']) {
        assert.ok(texts.some((t) => t.includes(needle)), needle);
    }
    // Тексти йдуть у порядку малювання: таблиця етапів → дозаправки → підсумки.
    const order = (needle) => texts.indexOf(needle);
    assert.ok(order('ЕТАПИ РЕЙСУ') >= 0 && order('ЕТАПИ РЕЙСУ') < order('ДОЗАПРАВКИ В ДОРОЗІ'), 'після етапів');
    assert.ok(order('ДОЗАПРАВКИ В ДОРОЗІ') < order('ПІДСУМКИ'), 'блок дозаправок перед підсумками');
});

test('PDF: закритий лист без дозаправок — один рядок «не було»; незакритий — порожні рядки для заповнення; багато дозаправок — продовження без втрат', async () => {
    const closedNone = await buildTripSheetPdf(base({ status: 'closed', distance_km: 600, fuel_actual: 230 }), { fonts });
    assert.ok(closedNone.info.texts.some((t) => t.text === 'ДОЗАПРАВКИ В ДОРОЗІ: не було'));
    const issued = await buildTripSheetPdf(base(), { fonts });
    assert.ok(issued.info.texts.some((t) => t.text === 'ДОЗАПРАВКИ В ДОРОЗІ'), 'порожня таблиця є і в незакритого листа');
    const many = base({ status: 'closed', distance_km: 600, fuel_actual: 230, refuels: Array.from({ length: 30 }, (_, i) => refuel(i + 1, { place: 'АЗС номер ' + (i + 1) })) });
    const { info, bytes } = await buildTripSheetPdf(many, { fonts });
    for (const { width, height } of await pageSizes(bytes)) assert.ok(width > height);
    for (let i = 1; i <= 30; i += 1) assert.ok(info.texts.some((t) => t.text.includes('АЗС номер ' + i)), 'рядок ' + i);
    assert.ok(info.pages >= 3, 'довгий список переноситься на сторінки-продовження');
    assert.ok(info.texts.some((t) => t.text === 'Зворотний бік (продовження)'));
});

test('Excel: блок дозаправок на аркуші зворотного боку перед підсумками', () => {
    const doc = base({ status: 'closed', distance_km: 600, fuel_actual: 380.5, totals: { refuel_l: 150.5, trips: 0 }, refuels: [refuel(1)] });
    const sheet = tripSheetSheet(doc);
    assert.equal(sheet.landscape, true);
    const values = sheet.rows.flatMap((r) => (Array.isArray(r) ? r : r.cells)).map((c) => c && c.v).filter((v) => typeof v === 'string');
    const at = (needle) => values.indexOf(needle);
    assert.ok(at('Дозаправки в дорозі') > 0);
    for (const needle of ['Літри', 'Ціна за л, грн', 'АЗС WOG, Житомир 1', 'картка', '№1', 'Дозаправки, л']) assert.ok(values.includes(needle), needle);
    assert.ok(at('Дозаправки в дорозі') < at('Підсумки'), 'перед підсумками');
    assert.ok(at('Дозаправки в дорозі') > at('Зворотний бік'));
    assert.ok(sheet.breaks[0] < sheet.rows.findIndex((r) => JSON.stringify(r).includes('Дозаправки в дорозі')), 'після розриву сторінки (зворотний бік)');
    assert.ok(buildDocXlsx(doc).length > 500);
});

test('рядки таблиці: сума з бази, перерахунок без неї; безпечні порожні значення', () => {
    const rows = tsRefuelRows({ refuels: [refuel(1), refuel(2, { liters: 10, price_per_l: 50, amount: null }), { liters: 5 }] });
    assert.equal(rows[0].length, REFUEL_COLUMNS.length);
    assert.equal(rows[0][5], '5550');
    assert.equal(rows[1][5], '500');
    assert.deepEqual(rows[2].slice(1), ['—', '—', '5', '—', '—', '—', '—']);
    assert.deepEqual(tsRefuelRows({}), []);
});

// ---- UI і міграція ----
test('картка: редактор дозаправок, збереження через kp_trip_sheet_refuels_save, факт у формі закриття враховує дозаправки', () => {
    const card = read('src/views/docs-ts-card.js');
    assert.match(card, /rpc\('kp_trip_sheet_refuels_save', \{ p_id: doc\.id, p_rows: refuelsPayload\(refEditor\.get\(\)\) \}\)/);
    assert.match(card, /refuels: refEditor\.get\(\)/);
    assert.match(card, /fuel_refueled: ctx\.refuelL/);
    assert.match(card, /Дозаправки в дорозі/);
    const editor = read('src/views/docs-ts-refuels.js');
    assert.match(editor, /Додати дозаправку/);
    assert.match(editor, /data-amount/);
    assert.equal(/cellInput\(i, 'amount'|control\(i, 'amount'/.test(editor), false, 'сума рахується автоматично, не редагується');
    assert.doesNotMatch(editor, /innerHTML/);
});

test('міграція: ідемпотентна, після 20261108090000, RLS через kp_org_id(), запис лише через RPC, факт з дозаправками, відкат описано', () => {
    const files = fs.readdirSync(new URL('../../supabase/migrations/', APP)).filter((f) => /_kp_trip_sheet_refuels\.sql$/.test(f));
    assert.equal(files.length, 1);
    assert.ok(files[0] > '20261108090000', 'номер після 20261108090000');
    const sql = read('../../supabase/migrations/' + files[0]);
    assert.match(sql, /^-- Apply manually after review\. This file is not applied to production by the agent\./);
    assert.match(sql, /РУЧНИЙ ВІДКАТ/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kp_trip_sheet_refuels/);
    assert.match(sql, /sheet_id uuid NOT NULL REFERENCES public\.kp_doc_trip_sheet \(id\) ON DELETE CASCADE/);
    assert.match(sql, /org_id uuid NOT NULL REFERENCES public\.organizations/);
    assert.match(sql, /USING \(org_id = public\.kp_org_id\(\)\)/);
    assert.match(sql, /GRANT SELECT ON TABLE public\.kp_trip_sheet_refuels TO authenticated/);
    assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]* ON TABLE public\.kp_trip_sheet_refuels TO authenticated/);
    assert.match(sql, /v_t\.depart_fuel_left \+ v_t\.fuel_issued \+ v_refuel - v_left/);
    assert.match(sql, /TS_FUEL_NEGATIVE/);
    assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /DROP TABLE|DROP COLUMN|DELETE FROM public\.(calculations|kp_doc)/, 'міграція нічого не видаляє');
    for (const old of fs.readdirSync(new URL('../../supabase/migrations/', APP)).filter((f) => f < files[0])) {
        assert.doesNotMatch(read('../../supabase/migrations/' + old), /kp_trip_sheet_refuels/, old + ': старі міграції не змінюються');
    }
});
