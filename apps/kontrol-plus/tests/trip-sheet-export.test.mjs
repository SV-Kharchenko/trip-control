import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTripSheetPdf } from '../src/lib/pdf-trip-sheet.js';
import { buildDocXlsx, docSheet, tripSheetSheet, xlsxFileName } from '../src/lib/xlsx-docs.js';
import { tsSections, tsFileName } from '../src/lib/trip-sheet.js';

const APP = new URL('../', import.meta.url);
const fonts = {
    regular: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Regular.ttf', APP))),
    bold: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Bold.ttf', APP))),
};
const sheet = (over = {}) => ({
    kind: 'trip_sheet', id: 'ts1', number: 7, prefix: 'ПЛ-', number_text: 'ПЛ-7', doc_date: '2026-10-28', valid_from: '2026-10-28', valid_to: '2026-10-30', status: 'closed',
    carrier: { name: 'ТОВ Перевізник', code: '12345678', address: 'м. Луцьк' }, driver: { full_name: 'Петренко Петро Петрович', license_no: 'BB654321', tab_no: '17' },
    vehicle: { make_model: 'DAF XF', reg_number: 'AA1111AA', garage_no: '5', trailer_make_model: 'Schmitz', trailer_reg_number: 'AA2222XX' },
    task: { customer: 'Агро', route_from: 'Луцьк', route_to: 'Одеса', feed_point: 'Рівне', via: ['Київ'], cargo: 'Пшениця', tonnage: 22, loaded_km: 300 },
    depart_at: '2026-10-28T03:00:00Z', depart_odometer: 100000, depart_fuel_left: 80, fuel_issued: 200, fuel_kind: 'ДП',
    medical_by: 'Мед. пункт', medical_at: '2026-10-28T02:30:00Z', tech_by: 'Механік', tech_at: '2026-10-28T02:40:00Z', tech_ok: true,
    return_at: '2026-10-30T17:00:00Z', return_odometer: 100500, return_fuel_left: 70, distance_km: 500, fuel_actual: 210, fuel_norm: 130, fuel_diff: 80, ...over,
});

test('PDF: A4, лицьовий і зворотний бік; анульований — водяний знак', async () => {
    const ok = await buildTripSheetPdf(sheet(), { fonts });
    assert.equal(ok.info.pages, 2);
    assert.equal(ok.info.watermark, false);
    assert.equal(Buffer.from(ok.bytes.slice(0, 5)).toString(), '%PDF-');
    const cancelled = await buildTripSheetPdf(sheet({ status: 'cancelled', cancelled_at: '2026-10-29T00:00:00Z', cancelled_reason: 'Помилка' }), { fonts });
    assert.equal(cancelled.info.watermark, true);
    await assert.rejects(() => buildTripSheetPdf({ kind: 'ttn' }, { fonts }));
});

test('Excel: ті самі розділи й поля по порядку, що в картці й PDF; без персональних даних', () => {
    const doc = sheet();
    const sh = docSheet(doc);
    assert.equal(sh, docSheet(doc) && sh);
    const labels = sh.rows.map((r) => (Array.isArray(r) && r[0] && r[0].s === 'label' ? r[0].v : null)).filter(Boolean);
    const expected = tsSections(doc).flatMap((s) => s.rows.map((r) => r[0]));
    assert.deepEqual(labels, expected);
    const values = sh.rows.map((r) => (Array.isArray(r) && r[2] ? r[2].v : null)).filter(Boolean).join('|');
    assert.match(values, /Петренко Петро Петрович/);
    assert.match(values, /Київ/);
    assert.match(values, /\+80 \(перевитрата\)/);
    assert.doesNotMatch(JSON.stringify(sh.rows), /phone|passport|телефон|паспорт|ІПН/);
    assert.equal(tripSheetSheet(doc).landscape, false);
    assert.ok(buildDocXlsx(doc).length > 500);
    assert.equal(xlsxFileName(doc), 'podorozhnii_list_7_2026-10-28.xlsx');
    assert.equal(tsFileName(sheet({ status: 'cancelled' })), 'podorozhnii_list_7_2026-10-28_anulovano.pdf');
});
