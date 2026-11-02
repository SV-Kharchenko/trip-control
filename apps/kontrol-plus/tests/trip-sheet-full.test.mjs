// Подорожній лист — повноцінний первинний документ: етапи (т·км), підсумки, відмітки, перевірка закриття, PDF / Excel на 2 аркуші.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import { buildTripSheetPdf } from '../src/lib/pdf-trip-sheet.js';
import { buildDocXlsx, tripSheetSheet } from '../src/lib/xlsx-docs.js';
import { tsSections } from '../src/lib/trip-sheet.js';
import {
    MAX_STAGES, STAGE_COLUMNS, addStage, closeProblems, dispatcherName, emptyStage, firstStage, marksFromDoc, marksPayload, moveStage, removeStage,
    stageFromDoc, stageTkm, stageTotals, stagesPayload, tsBackSections, tsFrontMarks, tsStageRows, tsTotals, totalsRows, validateStages,
} from '../src/lib/trip-sheet-stages.js';

const APP = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), 'utf8');
const fonts = {
    regular: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Regular.ttf', APP))),
    bold: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Bold.ttf', APP))),
};

const stage = (over = {}) => emptyStage({ customer: 'Агро', ttn_no: 'ТТН-1', load_point: 'Луцьк', unload_point: 'Рівне', loaded_km: '150,5', tonnage: '22', ...over });
const base = (over = {}) => ({
    kind: 'trip_sheet', id: 'ts1', number: 7, prefix: 'ПЛ-', number_text: 'ПЛ-7', doc_date: '2026-10-28', valid_from: '2026-10-28', valid_to: '2026-10-30', status: 'closed',
    carrier: { name: 'ТОВ Перевізник', code: '12345678', address: 'м. Луцьк' }, driver: { full_name: 'Петренко Петро Петрович', license_no: 'BB654321' },
    vehicle: { make_model: 'DAF XF', reg_number: 'AA1111AA', fuel_load: 30, fuel_empty: 20 },
    task: { customer: 'Агро', route_from: 'Луцьк', route_to: 'Одеса', cargo: 'Пшениця', tonnage: 22, loaded_km: 300 },
    depart_at: '2026-10-28T03:00:00Z', depart_odometer: 100000, depart_fuel_left: 80, fuel_issued: 200, fuel_kind: 'ДП',
    return_at: '2026-10-30T17:00:00Z', return_odometer: 100600, return_fuel_left: 30, distance_km: 600, fuel_actual: 250, fuel_norm: 170, fuel_diff: 80, ...over,
});
const withStages = (n, over = {}, long = false) => base({
    stages: Array.from({ length: n }, (_, i) => ({
        position: i + 1, customer: 'Замовник ' + (i + 1), ttn_no: 'ТТН-' + (i + 1), load_point: (long ? 'Пункт завантаження з дуже довгою назвою, щоб перевірити перенос рядків ' : 'Склад ') + (i + 1),
        unload_point: 'Пункт розвантаження ' + (i + 1), arrive_load_at: '2026-10-28T04:00:00Z', depart_load_at: '2026-10-28T05:00:00Z',
        arrive_unload_at: '2026-10-28T08:00:00Z', depart_unload_at: '2026-10-28T09:00:00Z', loaded_km: 100 + i, tonnage: 20, tkm: (100 + i) * 20,
    })), medical_by: 'Медик Іваненко', medical_at: '2026-10-28T02:30:00Z', medical_ok: true, tech_by: 'Механік', tech_at: '2026-10-28T02:40:00Z', tech_ok: true,
    medical_post_by: 'Медик Коваль', medical_post_at: '2026-10-30T17:30:00Z', medical_post_ok: true, mech_return_by: 'Механік Мельник', mech_return_at: '2026-10-30T17:40:00Z',
    mech_return_accepted: true, dispatcher_name: 'Диспетчер Сидоренко', ...over,
});

test('t·km = km × t, rounded to 0.1, empty when a factor is missing; the row is not editable (no input for it)', () => {
    assert.equal(stageTkm('150,5', '22'), 3311);
    assert.equal(stageTkm(400, 20.5), 8200);
    assert.equal(stageTkm('10,25', '3'), 30.8);
    assert.equal(stageTkm('', '22'), null);
    assert.equal(stageTkm('10', ''), null);
    assert.equal(stageTkm('abc', '2'), null);
    const view = read('src/views/docs-ts-stages.js');
    assert.match(view, /data-tkm/);
    assert.equal(/cellInput\(i, 'tkm'/.test(view), false);
});

test('totals: sum of km, sum of t·km, trips; blank rows do not count; old docs without stages', () => {
    const list = [stage(), stage({ loaded_km: '400', tonnage: '20,5' }), emptyStage(), stage({ loaded_km: '', tonnage: '' })];
    assert.deepEqual(stageTotals(list), { loaded_km: 550.5, tkm: 11511, trips: 3 });
    assert.deepEqual(stageTotals([]), { loaded_km: null, tkm: null, trips: 0 });
    const old = tsTotals(base());
    assert.equal(old.trips, 0);
    assert.equal(old.loaded_km, null);
    assert.equal(old.distance_km, 600);
    assert.deepEqual(totalsRows(old).map((r) => r[0]), [
        'Загальний пробіг (за одометрами), км', 'Пробіг із вантажем, км', 'Сума т·км', 'Кількість їздок', 'Пальне за нормою, л', 'Дозаправки, л', 'Пальне фактично, л', 'Різниця, л']);
});

test('totals: mileage from the odometers, fuel norm by the stage km when stages exist (as the database does), else by the task plan', () => {
    const doc = base({ status: 'issued' });
    const withPlan = tsTotals(doc, { stages: [] });
    // 300 км з вантажем (план) і 300 порожніх: 300 × 30 / 100 + 300 × 20 / 100 = 150
    assert.equal(withPlan.fuel_norm, 150);
    const withRows = tsTotals(doc, { stages: [stage({ loaded_km: '400', tonnage: '20' }), stage({ loaded_km: '100', tonnage: '10' })] });
    // 500 з вантажем і 100 порожніх: 150 + 20 = 170
    assert.equal(withRows.fuel_norm, 170);
    assert.equal(withRows.fuel_actual, 250);
    assert.equal(withRows.fuel_diff, 80);
    assert.equal(withRows.distance_km, 600);
    // закритий лист: збережені значення сервера, а не формула (norm 130 ≠ 150)
    const stored = tsTotals(base({ fuel_norm: 130, fuel_diff: 120, fuel_actual: 250 }));
    assert.deepEqual([stored.fuel_norm, stored.fuel_diff, stored.fuel_actual, stored.distance_km], [130, 120, 250, 600]);
    // збережений лист: км з вантажем, т·км й їздки — з doc.totals (сервер), а не з етапів
    const server = tsTotals(base({ stages: [{ loaded_km: 1, tonnage: 1 }], totals: { distance_km: 600, loaded_km: 777, tkm: 5555, trips: 4 } }));
    assert.deepEqual([server.loaded_km, server.tkm, server.trips], [777, 5555, 4]);
    assert.equal(withRows.tkm, 8000 + 1000);
    // повернення ще не внесено → пробігу й пального ще немає
    const open = tsTotals(base({ status: 'issued', return_odometer: null, return_fuel_left: null, distance_km: null }));
    assert.equal(open.distance_km, null);
    assert.equal(open.fuel_norm, null);
    // уведені у формі закриття значення мають перевагу над збереженими
    assert.equal(tsTotals(open && base({ status: 'issued', return_odometer: null, return_fuel_left: null }), { returnOdometer: '100250', returnFuelLeft: '60' }).distance_km, 250);
});

test('rows: add / remove / move, limit of 50, blank rows are not saved, payload keeps order', () => {
    let list = [];
    list = addStage(list, { customer: 'A' });
    list = addStage(list, { customer: 'B' });
    list = addStage(list, { customer: 'C' });
    assert.deepEqual(list.map((s) => s.customer), ['A', 'B', 'C']);
    list = moveStage(list, 2, -1);
    assert.deepEqual(list.map((s) => s.customer), ['A', 'C', 'B']);
    list = moveStage(list, 0, -1);
    assert.deepEqual(list.map((s) => s.customer), ['A', 'C', 'B'], 'the first row cannot move up');
    list = moveStage(list, 2, 1);
    assert.deepEqual(list.map((s) => s.customer), ['A', 'C', 'B'], 'the last row cannot move down');
    list = removeStage(list, 1);
    assert.deepEqual(list.map((s) => s.customer), ['A', 'B']);
    let many = [];
    for (let i = 0; i < MAX_STAGES + 5; i += 1) many = addStage(many);
    assert.equal(many.length, MAX_STAGES);
    const payload = stagesPayload([stage({ customer: 'Перший' }), emptyStage(), stage({ customer: 'Другий', loaded_km: '12,5' })]);
    assert.deepEqual(payload.map((p) => p.customer), ['Перший', 'Другий']);
    assert.equal(payload[1].loaded_km, '12.5');
    assert.equal(payload[0].tonnage, '22');
    assert.equal('tkm' in payload[0], false, 't·km is never sent');
});

test('validation of rows: numbers ≥ 0, departure not before arrival', () => {
    assert.deepEqual(validateStages([stage()]), {});
    assert.ok(validateStages([stage({ loaded_km: '-1' })])[0].loaded_km);
    assert.ok(validateStages([stage({ tonnage: 'x' })])[0].tonnage);
    assert.ok(validateStages([stage({ arrive_load_at: '2026-10-28T09:00', depart_load_at: '2026-10-28T08:00' })])[0].depart_load_at);
    assert.ok(validateStages([stage({ arrive_unload_at: '2026-10-28T09:00', depart_unload_at: '2026-10-28T08:00' })])[0].depart_unload_at);
    assert.deepEqual(validateStages([stage({ arrive_load_at: '2026-10-28T08:00', depart_load_at: '2026-10-28T09:00' })]), {});
});

test('closing: the return date and time and the return odometer are required (the same the server checks)', () => {
    const doc = { depart_at: '2026-10-28T03:00:00Z', depart_odometer: 100000 };
    assert.deepEqual(Object.keys(closeProblems({}, doc)).sort(), ['return_at', 'return_fuel_left', 'return_odometer']);
    assert.deepEqual(Object.keys(closeProblems({ return_at: '2026-10-29T20:00', return_odometer: '', return_fuel_left: '10' }, doc)), ['return_odometer']);
    assert.ok(closeProblems({ return_at: '2026-10-29T20:00', return_odometer: '99999', return_fuel_left: '10' }, doc).return_odometer);
    assert.ok(closeProblems({ return_at: '2026-10-27T20:00', return_odometer: '100500', return_fuel_left: '10' }, doc).return_at);
    assert.deepEqual(closeProblems({ return_at: '2026-10-29T20:00', return_odometer: '100500', return_fuel_left: '10' }, doc), {});
    const card = read('src/views/docs-ts-card.js');
    assert.match(card, /closeProblems\(\{ return_at: at\.value/);
    // Серверні коди помилок зрозумілі користувачу.
    return import('../src/lib/trip-sheet.js').then(({ tsErrorText }) => {
        assert.match(tsErrorText({ message: 'TS_FIELD_REQUIRED:return_at' }), /Повернення: дата і час — обовʼязково/);
        assert.match(tsErrorText({ message: 'TS_FIELD_REQUIRED:return_odometer' }), /Повернення: спідометр, км — обовʼязково/);
        assert.match(tsErrorText({ message: 'TS_FIELD_INVALID:stages.loaded_km' }), /Етап: км з вантажем — перевірте значення/);
    });
});

test('marks: form ↔ payload, dispatcher defaults to the current user', () => {
    const doc = withStages(1);
    const marks = marksFromDoc(doc);
    assert.equal(marks.medical_ok, true);
    assert.equal(marks.mech_return_accepted, true);
    assert.equal(marks.dispatcher_name, 'Диспетчер Сидоренко');
    assert.match(marks.medical_at, /^2026-10-28T\d\d:\d\d$/);
    const payload = marksPayload(marks);
    assert.equal(payload.medical_by, 'Медик Іваненко');
    assert.match(payload.medical_post_at, /^2026-10-30T\d\d:\d\d:00[+-]\d\d:\d\d$/);
    assert.equal(payload.medical_post_ok, true);
    assert.equal(marksPayload(marksFromDoc(base())).dispatcher_name, null);
    assert.equal(dispatcherName({ email: 'd@example.com' }), 'd@example.com');
    assert.equal(dispatcherName({ email: 'd@example.com', user_metadata: { full_name: 'Іван Диспетчер' } }), 'Іван Диспетчер');
    assert.equal(dispatcherName(null), '');
    assert.equal(firstStage({ task: { customer: 'Агро', route_from: 'Луцьк', route_to: 'Одеса', loaded_km: '300', tonnage: '22' } }).load_point, 'Луцьк');
    assert.equal(stageFromDoc({ customer: 'A', loaded_km: 12.5, tonnage: 22, arrive_load_at: '2026-10-28T04:00:00Z' }).loaded_km, '12,5');
});

test('old sheets open and print: no new fields, no stages', async () => {
    const old = base();
    assert.doesNotThrow(() => tsSections(old));
    assert.doesNotThrow(() => tsFrontMarks(old));
    assert.doesNotThrow(() => tsBackSections(old));
    assert.deepEqual(tsStageRows(old), []);
    assert.equal(tsFrontMarks(old).rows[0][1], '—');
    const pdf = await buildTripSheetPdf(old, { fonts });
    assert.equal(pdf.info.pages, 2);
    assert.ok((await pageSizes(pdf.bytes)).every(({ width, height }) => width > height), 'an old sheet: both pages landscape');
    const oldIssued = await buildTripSheetPdf(base({ status: 'issued', return_at: null, return_odometer: null, return_fuel_left: null, distance_km: null, fuel_actual: null, fuel_norm: null, fuel_diff: null }), { fonts });
    assert.equal(oldIssued.info.pages, 2);
    assert.ok(buildDocXlsx(old).length > 500);
    assert.doesNotThrow(() => tsSections({ ...old, status: 'issued', return_at: null, return_odometer: null, return_fuel_left: null }));
});

const pageSizes = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((pg) => pg.getSize());

test('PDF: exactly two pages, both A4 landscape, with stages, marks and totals; no «ШАПКА» plaque; nothing truncated', async () => {
    const doc = withStages(6);
    const { bytes, info } = await buildTripSheetPdf(doc, { fonts });
    assert.equal(info.pages, 2);
    const sizes = await pageSizes(bytes);
    assert.equal(sizes.length, 2);
    for (const { width, height } of sizes) {
        assert.ok(width > height, 'landscape');
        assert.ok(Math.abs(width - 841.89) < 0.1 && Math.abs(height - 595.28) < 0.1, 'A4');
    }
    const src = read('src/lib/pdf-trip-sheet.js');
    assert.match(src, /plaque: false/, 'the header block is drawn without a section plaque');
    assert.doesNotMatch(src, /ШАПКА/);
    assert.ok(src.includes('const PAGE = [841.89, 595.28];'));
    // порожній зворотний бік (без етапів) теж друкується на двох аркушах — з порожніми рядками для ручного заповнення
    assert.equal((await buildTripSheetPdf(base(), { fonts })).info.pages, 2);
    // довгі значення у лицьовому боці (кілька колонок) не виштовхують його на другу сторінку
    const longFront = withStages(6, {
        driver: { full_name: 'Петренко Петро Петрович-Старший-Молодший', license_no: 'BB654321', tab_no: '17' },
        vehicle: { make_model: 'DAF XF 480 FTG Super Space Cab', reg_number: 'AA1111AA', garage_no: '5', trailer_make_model: 'Schmitz Cargobull SKO 24', trailer_reg_number: 'AA2222XX', fuel_load: 30, fuel_empty: 20 },
        task: { customer: 'ТОВ «Агропромислова компанія Золотий колос»', route_from: 'м. Луцьк, вул. Промислова, 1', route_to: 'м. Одеса, порт, термінал 7', feed_point: 'с. Рівне', via: ['Київ', 'Біла Церква', 'Умань'], cargo: 'Пшениця 3 класу', tonnage: 22, loaded_km: 300 },
    });
    assert.equal((await buildTripSheetPdf(longFront, { fonts })).info.pages, 2);
    assert.equal((await buildTripSheetPdf(withStages(6, { status: 'cancelled', cancelled_at: '2026-10-31T00:00:00Z', cancelled_reason: 'Помилка' }), { fonts })).info.watermark, true);
    // багато етапів не обрізаються: таблиця переходить на наступні аркуші, заголовок повторюється
    const many = await buildTripSheetPdf(withStages(30, {}, true), { fonts });
    assert.ok(many.info.pages > 2);
});

test('Excel: print setup is landscape, fit to width; stage table with 10 columns, front and back on separate printed pages', () => {
    const doc = withStages(3);
    const sh = tripSheetSheet(doc);
    assert.equal(sh.landscape, true);
    assert.equal(sh.columns.length, STAGE_COLUMNS.length);
    assert.equal(sh.breaks.length, 1);
    const flat = JSON.stringify(sh.rows);
    for (const needle of ['Допуск до рейсу', 'Зворотний бік', 'Підсумки', 'Медогляд після рейсу', 'Механік при поверненні', 'Диспетчер', 'Км з вантажем', 'т·км', 'Замовник 1', 'ТТН-3']) {
        assert.ok(flat.includes(needle), needle);
    }
    const cellsOf = (r) => (Array.isArray(r) ? r : r.cells);
    const headRow = cellsOf(sh.rows.find((r) => cellsOf(r) && cellsOf(r)[0] && cellsOf(r)[0].s === 'head'));
    assert.deepEqual(headRow.map((c) => c.v), STAGE_COLUMNS.map(([t]) => t));
    // розрив — після лицьового боку, перед заголовком «Зворотний бік»
    assert.equal(cellsOf(sh.rows[sh.breaks[0]])[0].v, 'Зворотний бік');
    const xml = strFromU8(unzipSync(buildDocXlsx(doc))['xl/worksheets/sheet1.xml']);
    assert.match(xml, /<pageSetup [^>]*orientation="landscape"[^>]*fitToWidth="1"/);
    assert.match(xml, /<pageSetUpPr fitToPage="1"\/>/);
    assert.match(xml, /<rowBreaks count="1" manualBreakCount="1"><brk id="\d+" max="16383" man="1"\/><\/rowBreaks>/);
});

test('migration 20261107090000: additive and idempotent, RLS through kp_org_id(), cascade, generated t·km, server-side close check', () => {
    const sql = read('../../supabase/migrations/20261107090000_kp_trip_sheet_full.sql');
    assert.match(sql, /^-- Apply manually after review\./);
    assert.match(sql, /РУЧНИЙ ВІДКАТ/);
    assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 8);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kp_trip_sheet_stages/);
    assert.match(sql, /sheet_id uuid NOT NULL REFERENCES public\.kp_doc_trip_sheet \(id\) ON DELETE CASCADE/);
    assert.match(sql, /org_id uuid NOT NULL REFERENCES public\.organizations \(id\) ON DELETE CASCADE/);
    assert.match(sql, /tkm numeric\(14, 1\) GENERATED ALWAYS AS \(round\(loaded_km \* tonnage, 1\)\) STORED/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /USING \(org_id = public\.kp_org_id\(\)\)/);
    assert.match(sql, /GRANT SELECT ON TABLE public\.kp_trip_sheet_stages TO authenticated;/);
    assert.doesNotMatch(sql, /GRANT (ALL|INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
    assert.match(sql, /TS_FIELD_REQUIRED:return_at[\s\S]*TS_FIELD_REQUIRED:return_odometer/);
    assert.doesNotMatch(sql, /^\s*(DROP TABLE|TRUNCATE)\b/im);
    // Старі міграції не змінено цією зміною (перевіряє security-grants; тут — лише що файл новий і останній).
    const names = fs.readdirSync(new URL('../../supabase/migrations/', APP)).sort();
    assert.ok(names.includes('20261107090000_kp_trip_sheet_full.sql'));
    assert.ok(names.indexOf('20261107090000_kp_trip_sheet_full.sql') > names.indexOf('20261106090000_kp_contract_cancelled_guards.sql'), 'after the previous migration');
});

test('UI: buttons by content size (no stretched buttons without .btn-block), no innerHTML, mobile cards for the stage table', () => {
    for (const file of ['src/views/docs-ts-stages.js', 'src/views/docs-ts-card.js', 'src/views/docs-ts-form.js']) {
        const code = read(file);
        assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
        assert.doesNotMatch(code, /btn-block|width:\s*100%/, file);
    }
    const stages = read('src/views/docs-ts-stages.js');
    assert.match(stages, /table-wrap kpr-cards kpts-table/);
    assert.match(stages, /data-label/);
    const css = read('src/crm.css');
    assert.match(css, /kpr-cards td::before \{ content: attr\(data-label\)/);
    assert.match(css, /#kp-crm \.kpts-table input \{ width: 100%; min-width: 0; \}/);
    const form = read('src/views/docs-ts-form.js');
    assert.match(form, /kp_trip_sheet_extra_save/);
    assert.match(form, /d\.dispatcher = dispatcherName\(app\.user\)/);
});

const longStages = (n) => withStages(n, { fuel_norm: 123.4, fuel_diff: 126.6 }, true).stages.map((r, i) => ({
    ...r, customer: 'ТОВ «Агропромислова компанія Золотий колос» ' + (i + 1), ttn_no: 'ТТН-2026/' + (i + 1) + '-ЄҐЇ',
    unload_point: 'м. Одеса, порт, термінал 7, причал 12 (' + (i + 1) + ')',
}));

test('closed sheet: the stored norm / fuel / difference are shown once in PDF and Excel (the server is the source of truth)', async () => {
    const doc = withStages(8, { fuel_norm: 123.4, fuel_diff: 126.6, totals: { distance_km: 600, loaded_km: 828, tkm: 17000, trips: 8 } }, true);
    doc.stages = longStages(8);
    const { info } = await buildTripSheetPdf(doc, { fonts });
    const texts = info.texts.map((t) => t.text);
    // формула дала б 170, збережене значення — 123,4; воно одне, і «Розрахунку» окремо немає
    assert.equal(texts.filter((t) => t === '123,4').length, 1);
    assert.equal(texts.filter((t) => t === '+126,6 (перевитрата)').length, 1);
    assert.equal(texts.filter((t) => t === '828').length, 1, 'km with cargo from doc.totals');
    assert.equal(texts.filter((t) => /^17000$/.test(t)).length, 1, 't·km from doc.totals');
    assert.equal(texts.filter((t) => t === 'РОЗРАХУНОК').length, 0);
    assert.equal(texts.filter((t) => t === 'ПІДСУМКИ').length, 1);
    const sh = tripSheetSheet(doc);
    const values = sh.rows.flatMap((r) => (Array.isArray(r) ? r : r.cells)).map((c) => c && c.v).filter((v) => typeof v === 'string');
    assert.equal(values.filter((v) => v === '123,4').length, 1);
    assert.equal(values.filter((v) => v === 'Підсумки').length, 1);
    assert.equal(values.filter((v) => v === 'Розрахунок').length, 0);
});

test('8 long stages: every page landscape, continuation pages are labelled with a repeated header, nothing cut, totals present', async () => {
    const doc = withStages(8, { fuel_norm: 123.4, fuel_diff: 126.6, totals: { distance_km: 600, loaded_km: 828, tkm: 17000, trips: 8 } }, true);
    doc.stages = longStages(8);
    const { bytes, info } = await buildTripSheetPdf(doc, { fonts });
    const sizes = await pageSizes(bytes);
    assert.equal(sizes.length, info.pages);
    assert.ok(sizes.every(({ width, height }) => width > height), 'all pages landscape');
    const all = info.texts.map((t) => t.text).join(' ');
    // повний текст кожного довгого пункту є в PDF (перенесений по рядках, але не обрізаний)
    for (let i = 1; i <= 8; i += 1) {
        for (const word of ['Агропромислова', 'Золотий', 'ТТН-2026/' + i + '-ЄҐЇ', 'термінал', 'причал', '(' + i + ')']) assert.ok(all.includes(word), word + ' #' + i);
    }
    for (const needle of ['ПІДСУМКИ', 'Сума т·км', 'Кількість їздок', 'ПОВЕРНЕННЯ', 'ПІСЛЯ РЕЙСУ']) assert.ok(all.includes(needle), needle);
    // сторінки-продовження: підпис і повтор шапки таблиці (або лише блоки без таблиці, але теж з підписом)
    const continuationPages = new Set(info.texts.filter((t) => t.text === 'Зворотний бік (продовження)').map((t) => t.page));
    assert.equal(continuationPages.size, info.pages - 2);
    for (let page = 3; page <= info.pages; page += 1) assert.ok(continuationPages.has(page), 'page ' + page + ' is labelled');
    // кожна сторінка таблиці має шапку
    const headerPages = new Set(info.texts.filter((t) => t.text === '№ ТТН').map((t) => t.page));
    assert.ok(headerPages.has(2));
    // «№ ТТН» не рветься посимвольно: номер у одному рядку
    const ttnCells = info.texts.filter((t) => /^ТТН-2026\/\d-ЄҐЇ$/.test(t.text));
    assert.equal(ttnCells.length, 8);
    // 20 етапів — таблиця на кількох сторінках, усі альбомні, шапка таблиці повторюється
    const many = withStages(20, { totals: { distance_km: 600, loaded_km: 1, tkm: 1, trips: 20 } }, true);
    many.stages = longStages(20);
    const big = await buildTripSheetPdf(many, { fonts });
    assert.ok((await pageSizes(big.bytes)).every(({ width, height }) => width > height));
    const headers = new Set(big.info.texts.filter((t) => t.text === '№ ТТН').map((t) => t.page));
    assert.ok(headers.size >= 2, 'the table header repeats on the continuation pages');
    assert.ok(big.info.texts.some((t) => t.text === 'Зворотний бік (продовження)'));
});

test('front side: the date line does not touch the 14 pt heading; one page', async () => {
    const src = read('src/lib/pdf-trip-sheet.js');
    assert.match(src, /L\.y -= 17;\n    L\.text\(`від \$\{fmtDate\(doc\.doc_date\)\}`/);
    assert.ok(src.includes('альбомна') && !src.includes('книжна'));
    const { info } = await buildTripSheetPdf(withStages(2), { fonts });
    assert.equal(info.texts.filter((t) => t.page === 1).some((t) => t.text === 'Зворотний бік'), false);
    assert.equal(info.pages, 2);
});

test('migration: kp_ts_time is STABLE (it parses text → timestamptz depending on the session time zone)', () => {
    const sql = read('../../supabase/migrations/20261107090000_kp_trip_sheet_full.sql');
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.kp_ts_time'), sql.indexOf('CREATE OR REPLACE FUNCTION public.kp_ts_text'));
    assert.match(fn, /\nSTABLE\n/);
    assert.doesNotMatch(fn, /IMMUTABLE/);
});
