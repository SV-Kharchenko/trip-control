// Етап 4b: Excel (власний OOXML + fflate), захист від formula injection, ТТН (обовʼязкові поля, маса, PDF), «Авто й водії».
// Усі дані — вигадані.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { buildXlsx, excelSerial, safeSheetName, needsQuotePrefix, cleanText, colName } from '../src/lib/xlsx.js';
import { buildDocXlsx, docSheet, xlsxFileName } from '../src/lib/xlsx-docs.js';
import { massInWords, placesInWords, massTriple, toKg } from '../src/lib/count-words.js';
import { amountInWords } from '../src/lib/amount-words.js';
import {
    TTN_REQUIRED, TTN_TRAILER_REQUIRED, validateTtn, ttnPayload, ttnFromPrefill, totalMass, massWarning, linesGross, ttnErrorText, ttnErrorField,
    createTtn, parseNum,
} from '../src/lib/ttn.js';
import { frontFields, cargoCells, operationRows, partyText, codeText, amountWords, FOOTNOTES, CARGO_COLUMNS, APPENDIX_REF } from '../src/lib/ttn-text.js';
import { buildTtnPdf } from '../src/lib/pdf-ttn.js';
import { fleetBadge, docState, validateVehicleTtn, validateDriver } from '../src/lib/fleet.js';
import { ttnListRow, ttnStatusFilter } from '../src/views/docs.js';
import { parseCrmHash } from '../src/lib/route.js';

const APP = new URL('../', import.meta.url);
const ROOT = new URL('../../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, APP), 'utf8');
const fonts = {
    regular: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Regular.ttf', APP))),
    bold: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Bold.ttf', APP))),
};

// Мінімальна перевірка well-formed XML: теги збалансовані, атрибути в лапках, лише відомі сутності, без сирих < і &.
function assertWellFormed(xml, name) {
    const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
    const stack = [];
    const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
    let m;
    let roots = 0;
    while ((m = re.exec(body))) {
        if (m[6]) assert.fail(name + ': stray < at ' + m.index);
        if (m[5] !== undefined) {
            assert.doesNotMatch(m[5], /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/, name + ': bad entity');
            if (!stack.length) assert.match(m[5], /^\s*$/, name + ': text outside the root');
            continue;
        }
        const [, close, tag, attrs, self] = m;
        assert.doesNotMatch(attrs, /&(?!(amp|lt|gt|quot|apos|#\d+);)/, name + ': bad entity in attributes');
        if (close) {
            assert.equal(stack.pop(), tag, name + ': </' + tag + '> closes another tag');
        } else if (!self) {
            if (!stack.length) roots += 1;
            stack.push(tag);
        } else if (!stack.length) roots += 1;
    }
    assert.equal(stack.length, 0, name + ': unclosed ' + stack.join(','));
    assert.equal(roots, 1, name + ': one root element');
}

function unpack(bytes) {
    const files = unzipSync(bytes);
    const out = {};
    for (const [k, v] of Object.entries(files)) out[k] = strFromU8(v);
    return out;
}

const PARTS = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'];

// Індекс стилю комірки → чи має quotePrefix.
function quoteStyles(styles) {
    const xfs = styles.split('<cellXfs')[1].split('</cellXfs>')[0].match(/<xf [^>]*>/g);
    return xfs.map((x) => /quotePrefix="1"/.test(x));
}

function cellsOf(files) {
    const strings = [...files['xl/sharedStrings.xml'].matchAll(/<t xml:space="preserve">([\s\S]*?)<\/t>/g)].map((m) => m[1]);
    const quote = quoteStyles(files['xl/styles.xml']);
    return [...files['xl/worksheets/sheet1.xml'].matchAll(/<c r="([A-Z]+\d+)" s="(\d+)"(?: t="(\w+)")?(?:\/>|><v>([^<]*)<\/v><\/c>)/g)].map((m) => ({
        ref: m[1], style: Number(m[2]), type: m[3] || null, raw: m[4], text: m[3] === 's' ? strings[Number(m[4])] : null, quote: quote[Number(m[2])],
    }));
}

test('xlsx: a valid zip with all required parts; every XML part is well-formed', () => {
    const files = unpack(buildXlsx({ name: 'Тест', columns: [10, 20], rows: [['Привіт', 1.5], [{ date: '2026-01-01', s: 'date' }, { v: 'ґудзик їжак єнот пʼять', s: 'cell' }]] }));
    for (const part of PARTS) assert.ok(files[part], part);
    for (const [name, xml] of Object.entries(files)) assertWellFormed(xml, name);
    assert.match(files['[Content_Types].xml'], /spreadsheetml\.sheet\.main\+xml/);
    assert.match(files['xl/workbook.xml'], /<sheet name="Тест" sheetId="1" r:id="rId1"\/>/);
    assert.match(files['xl/worksheets/sheet1.xml'], /<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"\/>/, 'A4, fit to width');
    assert.match(files['xl/worksheets/sheet1.xml'], /<pageSetUpPr fitToPage="1"\/>/);
});

test('xlsx: numbers are t="n", dates are Excel serials (1900 bug), Cyrillic and the apostrophe intact', () => {
    assert.equal(excelSerial('2026-01-01'), 46023);
    assert.equal(excelSerial('1900-03-01'), 61, 'after the fake 29.02.1900');
    assert.equal(excelSerial('1900-02-28'), 59);
    assert.equal(excelSerial('1900-01-01'), 1);
    assert.equal(excelSerial('bad'), null);
    const files = unpack(buildXlsx({ name: 'x', rows: [[{ v: 1234.5, s: 'money' }, { v: 24.09, s: 'mass' }, { date: '2026-01-01', s: 'date' }, 'Пʼять ґудзиків, їжак і єнот — «лапки»', '42']] }));
    const cells = cellsOf(files);
    assert.deepEqual(cells.slice(0, 3).map((c) => [c.type, c.raw]), [['n', '1234.5'], ['n', '24.09'], ['n', '46023']]);
    assert.equal(cells[3].text, 'Пʼять ґудзиків, їжак і єнот — «лапки»');
    assert.equal(cells[4].type, 's', 'a numeric-looking string stays text');
    assert.match(files['xl/styles.xml'], /formatCode="#,##0\.00"/);
    assert.match(files['xl/styles.xml'], /formatCode="0\.000"/);
    assert.match(files['xl/styles.xml'], /formatCode="dd\.mm\.yyyy"/);
});

test('xlsx: 1 and 200 rows', () => {
    for (const n of [1, 200]) {
        const rows = Array.from({ length: n }, (_, i) => [i + 1, 'Рядок ' + (i + 1), { v: (i + 1) * 10.25, s: 'money' }]);
        const files = unpack(buildXlsx({ name: 'Рядки', rows }));
        assert.equal((files['xl/worksheets/sheet1.xml'].match(/<row /g) || []).length, n);
        assert.match(files['xl/worksheets/sheet1.xml'], new RegExp(`<dimension ref="A1:C${n}"/>`));
        assertWellFormed(files['xl/worksheets/sheet1.xml'], 'sheet ' + n);
    }
});

test('xlsx formula injection: = + - @ TAB CR → text with quotePrefix; no <f> at all; XML escaped; control characters removed', () => {
    const evil = ['=1+1', '+cmd', '-2', '@SUM(A1)', '\t=x', '\r=x', '=HYPERLINK("http://x","y")'];
    const files = unpack(buildXlsx({ name: 'x', rows: [evil, ['<script>alert(1)</script>', 'A & B', 'say "hi"', 'ok\u0000\u0007\u001Fdone', 'tab\there', 'line\nbreak', 'безпечно']] }));
    const sheet = files['xl/worksheets/sheet1.xml'];
    assert.doesNotMatch(Object.values(files).join(''), /<f[ >]/, 'no formulas anywhere');
    const cells = cellsOf(files);
    for (const c of cells.slice(0, evil.length)) {
        assert.equal(c.type, 's', c.ref + ' is text');
        assert.equal(c.quote, true, c.ref + ' has quotePrefix');
    }
    assert.equal(cells[5].text, '=x', 'CR removed, the leading = still quoted');
    assert.equal(cells[4].text, '\t=x', 'TAB kept');
    const second = cells.slice(evil.length);
    assert.equal(second.every((c) => !c.quote), true, 'ordinary text has no quotePrefix');
    const shared = files['xl/sharedStrings.xml'];
    assert.match(shared, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(shared, /A &amp; B/);
    assert.match(shared, /say &quot;hi&quot;/);
    assert.doesNotMatch(shared, /<script>/);
    assert.equal(second[3].text, 'okdone', 'control characters removed');
    assert.equal(second[4].text, 'tab\there');
    assert.equal(second[5].text, 'line\nbreak');
    assert.doesNotMatch(shared + sheet, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    assert.equal(needsQuotePrefix('ціна'), false);
    assert.equal(cleanText('a\u0000b￾c'), 'abc');
});

test('xlsx: sheet name ≤ 31 characters without []:*?/\\', () => {
    assert.equal(safeSheetName('Рахунок [1]: a/b\\c*d?'), 'Рахунок 1 a b c d');
    assert.equal(safeSheetName('x'.repeat(40)).length, 31);
    assert.equal(safeSheetName(''), 'Аркуш');
    assert.equal(safeSheetName("'Акт'"), 'Акт');
    assert.equal(colName(0) + colName(25) + colName(26) + colName(27), 'AZAAAB');
});

const seller = { legal_name: 'ТОВ «Тест Перевезення»', edrpou: '12345678', iban: 'UA213223130000026007233566001', vat_payer: true, vat_number: '123456789012',
    signer_name: 'Петренко Петро', signer_position: 'Директор', doc_place: 'м. Київ' };
const buyer = { name: 'Зерно', legal_name: 'ТОВ «Зерно» — пʼять ґудзиків, їжак і єнот', edrpou: '23456789', contract_no: 'Д-15', contract_date: '2026-01-15' };
const invoice = (extra = {}) => ({ id: 'd1', kind: 'invoice', number: 12, number_text: 'РФ-12', doc_date: '2026-10-12', seller, buyer, currency: 'UAH', rate: 1,
    rate_date: '2026-10-12', vat_rate: 20, vat_mode: 'net', subtotal: 1000, vat_amount: 200, total: 1200, total_uah: 1200, due_date: '2026-10-22', status: 'issued',
    lines: [{ sort: 1, title: '=cmd|"/c calc"!A1 перевезення', unit: 'послуга', qty: 1, price: 1000, amount: 1000 }], ...extra });

test('xlsx of an invoice and an act: the same data as the PDF, amount in words, cancelled marked on top, money as numbers', () => {
    const inv = unpack(buildDocXlsx(invoice()));
    const strings = inv['xl/sharedStrings.xml'];
    assert.match(strings, /Рахунок на оплату № РФ-12/);
    assert.match(strings, new RegExp(amountInWords(1200, 'UAH')));
    assert.match(strings, /у т\.ч\. ПДВ/);
    const cells = cellsOf(inv);
    assert.ok(cells.some((c) => c.type === 'n' && c.raw === '1200'), 'total is a number');
    assert.ok(cells.some((c) => c.text && c.text.startsWith('=cmd') && c.quote), 'line title from data stays text with quotePrefix');
    assert.doesNotMatch(Object.values(inv).join(''), /<f[ >]/);
    const act = unpack(buildDocXlsx(invoice({ kind: 'act', number_text: 'АКТ-3', status: 'cancelled', cancelled_reason: 'помилка' })));
    const first = cellsOf(act)[0];
    assert.match(first.text, /^АНУЛЬОВАНО/, 'the cancelled line is the first cell');
    assert.match(act['xl/sharedStrings.xml'], /Акт надання послуг № АКТ-3/);
    assert.equal(xlsxFileName(invoice()), 'rakhunok_12_2026-10-12.xlsx');
    assert.equal(xlsxFileName({ kind: 'ttn', number: 5, doc_date: '2026-10-20', status: 'cancelled' }), 'ttn_5_2026-10-20_anulovano.xlsx');
});

const ttn = (extra = {}) => ({
    id: '11111111-2222-4333-8444-555555555555', kind: 'ttn', number: 7, number_text: 'ТТН-7', doc_date: '2026-10-20', status: 'issued', place_of_issue: 'м. Біла Церква',
    transport_kind: null, vehicle_parking_place: null, carrier: { name: 'ТОВ «Тест Логістик»', code: '12345670', signer_name: 'Коваль Ганна', signer_position: 'Директор' },
    shipper: { name: 'ТОВ «Агро Тест»', code: '34567812' }, consignee: { name: 'ТОВ «Порт Тест»', code: '45678123', address: 'м. Одеса' }, customer: null,
    driver: { full_name: 'Мельник Олег Іванович', license_no: 'ВХА123456' },
    vehicle: { make_model: 'DAF XF 480', type: 'Тягач сідловий', reg_number: 'AA1111TT', trailer_make_model: 'Schmitz SKO', trailer_type: 'Напівпричіп-зерновоз',
        trailer_reg_number: 'AA2222XT', length_m: 16.5, width_m: 2.55, height_m: 4 },
    load_point: 'с. Тестове', unload_point: 'м. Одеса, порт', places_count: null, cargo_net_t: 24.09, cargo_gross_t: 24.09, tare_t: 15.75, total_mass_t: 39.84,
    total_amount: null, vat_amount: null, received_by: 'Мельник О. І., водій', released_by: null, accepted_by: null,
    operations: [{ op: 'load', gross_t: 39.84, tare_t: 15.75, net_t: 24.09, arrival: '08:00', departure: '09:30' }, { op: 'unload' }],
    lines: [{ sort: 1, cargo_name: 'Пшениця 3 клас', unit: 'т', owner_price: true, packaging: 'Насипом', gross_t: 24.09, bulk: true }],
    ...extra,
});

test('xlsx of a waybill: all form fields in order, cargo table graphs 1–11, operations «39,84/15,75/24,09», landscape', () => {
    const files = unpack(buildDocXlsx(ttn()));
    const strings = files['xl/sharedStrings.xml'];
    for (const text of ['Додаток 7 до Правил перевезень', 'Форма № 1-ТН', 'ТОВАРНО-ТРАНСПОРТНА НАКЛАДНА № ТТН-7', 'Місце, де зберігається автомобіль*', 'Автомобільний перевізник',
        'ВІДОМОСТІ ПРО ВАНТАЖ', 'ВАНТАЖНО-РОЗВАНТАЖУВАЛЬНІ ОПЕРАЦІЇ', '39,84/15,75/24,09', 'двадцять чотири тонни 90 кг', 'ОЦВТ****', 'Здав (відповідальна особа вантажовідправника)']) {
        assert.ok(strings.includes(xmlText(text)), text);
    }
    for (const c of CARGO_COLUMNS) assert.ok(strings.includes(xmlText(c.title)), c.title);
    assert.match(files['xl/worksheets/sheet1.xml'], /orientation="landscape"/);
    assert.ok(cellsOf(files).some((c) => c.type === 'n' && c.raw === '24.09'), 'gross mass is a number');
    for (const [name, xml] of Object.entries(files)) assertWellFormed(xml, name);
    const cancelled = unpack(buildDocXlsx(ttn({ status: 'cancelled', cancelled_reason: 'тест' })));
    assert.match(cellsOf(cancelled).find((c) => c.ref === 'A2').text, /^АНУЛЬОВАНО/, 'cancelled line right after the appendix reference');
    assert.equal(docSheet(ttn()).landscape, true);
});

function xmlText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

test('mass and places in words', () => {
    const cases = [[0, 'нуль тонн'], [1, 'одна тонна'], [2, 'дві тонни'], [5, 'пʼять тонн'], [11, 'одинадцять тонн'], [21, 'двадцять одна тонна'],
        [24.09, 'двадцять чотири тонни 90 кг'], [8.3, 'вісім тонн 300 кг'], [0.5, 'нуль тонн 500 кг'], [39.84, 'тридцять девʼять тонн 840 кг'],
        ['24,090', 'двадцять чотири тонни 90 кг'], [22.0005, 'двадцять дві тонни 1 кг']];
    for (const [value, words] of cases) assert.equal(massInWords(value), words, String(value));
    assert.equal(toKg('15,75'), 15750);
    assert.throws(() => massInWords('abc'), RangeError);
    assert.equal(placesInWords(0), 'нуль місць');
    assert.equal(placesInWords(1), 'одне місце');
    assert.equal(placesInWords(3), 'три місця');
    assert.equal(placesInWords(12), 'дванадцять місць');
    assert.equal(placesInWords(21), 'двадцять одне місце');
    assert.equal(placesInWords(1002), 'одна тисяча два місця');
    assert.throws(() => placesInWords(1.5), RangeError);
    assert.equal(massTriple(39.84, 15.75, 24.09), '39,84/15,75/24,09');
    assert.equal(massTriple(40, null, ''), '40/—/—');
    assert.equal(amountInWords('1,01', 'UAH'), 'Одна гривня 01 копійка', 'amount-words unchanged');
});

const formData = () => ({
    ...ttnFromPrefill({
        place_of_issue: 'м. Київ', customer: { name: 'ТОВ «Агро Тест»', code: '34567812' },
        vehicle: { make_model: 'DAF XF', type: 'Тягач сідловий', reg_number: 'AA1111TT', trailer_make_model: 'Schmitz', trailer_type: 'Напівпричіп', trailer_reg_number: 'AA2222XT',
            length_m: 16.5, width_m: 2.55, height_m: 4 },
        tare_t: 15.75, max_mass_t: 40, cargo_net_t: 24.09, driver: { id: 'd1', full_name: 'Мельник Олег', license_no: 'ВХА123456' }, load_point: 'с. Тестове', unload_point: 'м. Одеса',
    }),
    shipper: { name: 'ТОВ «Агро Тест»', code: '34567812', address: '' },
    consignee: { name: 'ТОВ «Порт Тест»', code: '45678123', address: '' },
    lines: [{ cargo_name: 'Пшениця', unit: 'т', gross_t: '24,09', bulk: true, owner_price: true, price: '' }],
});

test('prefill: shipper and consignee empty, carrier from requisites, gross = net, total mass = tare + gross', () => {
    const d = ttnFromPrefill({ customer: { name: 'Клієнт', code: '12345678' }, cargo_net_t: 24.09, tare_t: 15.75 });
    assert.deepEqual(d.shipper, { name: '', code: '', address: '' });
    assert.deepEqual(d.consignee, { name: '', code: '', address: '' });
    assert.equal(d.customer.name, 'Клієнт');
    assert.equal(d.cargo_gross_t, '24.09');
    assert.equal(totalMass(d.tare_t, d.cargo_gross_t), 39.84);
    assert.equal(totalMass('15,75', '24,09'), 39.84);
    assert.equal(totalMass(null, 1), null);
    assert.equal(massWarning(15.75, 24.09, 40), null);
    assert.match(massWarning(15.75, 25, 40), /40 т/, 'above the maximum mass → a warning');
    assert.equal(linesGross([{ gross_t: '10,5' }, { gross_t: 13.59 }]), 24.09);
    assert.equal(linesGross([{ gross_t: '' }]), null);
    assert.deepEqual(validateTtn(formData()), {}, 'a complete form has no errors');
});

// Клієнтська валідація дзеркалить kp_ttn_create: окремий тест на кожне обовʼязкове поле.
for (const [path, label] of [...TTN_REQUIRED, ...TTN_TRAILER_REQUIRED]) {
    test('waybill client validation: ' + path + ' is required', () => {
        const d = formData();
        const keys = path.split('.');
        let o = d;
        for (const k of keys.slice(0, -1)) o = o[k];
        o[keys[keys.length - 1]] = '';
        if (path.startsWith('vehicle.trailer_')) d.vehicle.trailer_reg_number = path === 'vehicle.trailer_reg_number' ? '' : 'AA2222XT';
        if (path === 'vehicle.trailer_reg_number') d.vehicle.trailer_make_model = 'Schmitz';
        const errors = validateTtn(d);
        assert.ok(errors[path], path + ' → error');
        assert.match(errors[path], new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
}

test('waybill client validation: formats and limits as the server', () => {
    const v = (patch) => validateTtn({ ...formData(), ...patch });
    assert.ok(v({ shipper: { name: 'X', code: '1234' } })['shipper.code'], 'code of 4 digits');
    assert.deepEqual(v({ shipper: { name: 'X', code: 'аб 123456' } })['shipper.code'], undefined, 'passport series lowercased and spaced is fine');
    assert.ok(v({ cargo_gross_t: '0' }).cargo_gross_t);
    assert.ok(v({ cargo_net_t: '30', cargo_gross_t: '24,09' }).cargo_net_t, 'net above gross');
    assert.ok(v({ vehicle: { ...formData().vehicle, length_m: '30,5' } })['vehicle.length_m']);
    assert.ok(v({ tare_t: '101' }).tare_t);
    assert.ok(v({ lines: [] }).lines);
    assert.ok(v({ lines: Array.from({ length: 51 }, () => ({ cargo_name: 'x' })) }).lines);
    assert.ok(v({ lines: [{ cargo_name: 'x', gross_t: '20' }] }).cargo_gross_t, 'lines gross must add up');
    assert.ok(v({ lines: [{ cargo_name: 'x', owner_price: true, price: '10', gross_t: '24,09' }] })['lines.0']);
    assert.ok(v({ vat_amount: '10' }).vat_amount, 'VAT without a total');
    assert.ok(v({ customer: { name: 'X', code: '' } })['customer.code'], 'optional party: name and code together');
    assert.deepEqual(v({ customer: { name: '', code: '', address: '' } }), {}, 'empty optional party is fine');
    assert.deepEqual(v({ vehicle: { ...formData().vehicle, trailer_make_model: '', trailer_type: '', trailer_reg_number: '' } }), {}, 'no trailer — trailer fields optional');
    assert.ok(v({ place_of_issue: 'Київ\u0007' }).place_of_issue, 'control characters');
    assert.equal(parseNum('16,5'), 16.5);
    assert.ok(Number.isNaN(parseNum('1e3')));
});

test('waybill payload: numbers as numbers, empty → null, owner price drops the price', () => {
    const p = ttnPayload({ ...formData(), total_amount: '', places_count: '3', lines: [{ cargo_name: ' Пшениця ', owner_price: true, price: '5', gross_t: '24,09', bulk: true }] });
    assert.equal(p.tare_t, 15.75);
    assert.equal(p.cargo_gross_t, 24.09);
    assert.equal(p.vehicle.length_m, 16.5);
    assert.equal(p.total_amount, null);
    assert.equal(p.places_count, 3);
    assert.deepEqual(p.lines[0], { cargo_name: 'Пшениця', animal_id: null, animal_kind: null, temperature: null, unit: null, places: null, price: null, owner_price: true,
        amount: null, packaging: null, docs: null, gross_t: 24.09, bulk: true });
    assert.equal(p.shipper.code, '34567812');
    assert.equal(p.customer.name, 'ТОВ «Агро Тест»');
    assert.equal(p.forwarder, null);
    assert.equal(p.driver.id, 'd1');
    assert.equal('total_mass_t' in p, false, 'the total mass is computed by the server');
});

test('waybill errors: field from the server error, known codes in Ukrainian', () => {
    assert.deepEqual(ttnErrorField({ message: 'TTN_FIELD_REQUIRED:vehicle.length_m' }), { kind: 'TTN_FIELD_REQUIRED', field: 'vehicle.length_m' });
    assert.equal(ttnErrorText({ message: 'TTN_FIELD_REQUIRED:shipper.code' }), 'Вантажовідправник: код ЄДРПОУ / РНОКПП / паспорт — обовʼязково.');
    assert.match(ttnErrorText({ message: 'TTN_FIELD_INVALID:vehicle.height_m' }), /Висота ТЗ, м — перевірте/);
    assert.match(ttnErrorText({ message: 'VEHICLE_FIELD_INVALID:tare_t' }), /Тара/);
    assert.match(ttnErrorText({ message: 'DOC_NUMBER_TAKEN' }), /ТТН з таким номером/);
    assert.match(ttnErrorText({ message: 'TTN_MASS_MISMATCH' }), /сумі мас/);
    assert.match(ttnErrorText({ message: 'KP_FORBIDDEN' }), /прав/);
});

test('createTtn: asset snapshot first, then kp_ttn_create with the same id; one retry on DOC_ASSETS_NOT_COPIED', async () => {
    const calls = [];
    let n = 0;
    const app = { supabase: { rpc: async (fn, args) => { calls.push([fn, args]); n += 1; return n === 1 ? { error: { message: 'DOC_ASSETS_NOT_COPIED' } } : { data: args.p_id }; } } };
    const callApi = async (_app, url) => { calls.push([url]); return { ok: true, doc_id: 'id-' + calls.length }; };
    const out = await createTtn(app, { p_client: 'c', p_doc_date: '2026-10-20', p_data: {} }, callApi);
    assert.deepEqual(calls.map((c) => c[0]), ['/api/docs/assets', 'kp_ttn_create', '/api/docs/assets', 'kp_ttn_create']);
    assert.equal(out.id, calls[3][1].p_id);
    const denied = await createTtn(app, {}, async () => ({ ok: false, code: 'KP_FORBIDDEN', error: 'x' }));
    assert.equal(denied.error.message, 'KP_FORBIDDEN');
});

test('waybill texts: every appendix 7 field, empty ones as a dash; codes named; ОЦВТ and bulk footnotes', () => {
    const labels = frontFields(ttn()).map(([label]) => label);
    assert.deepEqual(labels.slice(0, 17), ['Місце складання', 'Автомобіль', 'Причіп / напівпричіп', 'Вид перевезень', 'Місце, де зберігається автомобіль*',
        'Автомобільний перевізник', 'Водій', 'Вантажовідправник', 'Вантажоодержувач', 'Пункт навантаження', 'Пункт розвантаження', 'Кількість місць',
        'Масою брутто, т', 'Отримав водій / експедитор', 'Відомості про транспортний засіб', 'Усього відпущено на загальну суму', 'Супровідні документи на вантаж']);
    const values = Object.fromEntries(frontFields(ttn()).map(([l, v]) => [l, v]));
    assert.equal(values['Вид перевезень'], '—');
    assert.equal(values['Кількість місць'], '—');
    assert.equal(values['Масою брутто, т'], 'двадцять чотири тонни 90 кг');
    assert.match(values['Відомості про транспортний засіб'], /довжина 16,50 м; ширина 2,55 м; висота 4,00 м; 39,84 т з вантажем/);
    assert.equal(values['Усього відпущено на загальну суму'], 'ОЦВТ****, у тому числі ПДВ —');
    assert.equal(frontFields(ttn({ customer: { name: 'Замовник', code: '12345678' } })).at(-1)[0], 'Замовник (платник)', 'customer — additional requisite');
    assert.match(Object.fromEntries(frontFields(ttn({ places_count: 21, total_amount: 1200.5, vat_amount: 200.08 })).map(([l, v]) => [l, v]))['Кількість місць'], /двадцять одне місце/);
    assert.equal(amountWords(ttn({ total_amount: 1200.5, lines: [] })), 'Одна тисяча двісті гривень 50 копійок');
    assert.equal(codeText('12345678'), 'код ЄДРПОУ 12345678');
    assert.equal(codeText('1234567890'), 'РНОКПП 1234567890');
    assert.equal(codeText('АБ123456'), 'паспорт АБ123456');
    assert.equal(partyText(null), '—');
    const cells = cargoCells(ttn().lines[0], 0);
    assert.equal(cells.price, 'ОЦВТ****');
    assert.equal(cells.packaging, 'Насипом*****');
    assert.equal(cells.gross_t, '24,09');
    assert.equal(cells.animal_id, '—');
    assert.deepEqual(operationRows(ttn()).map((o) => o.mass), ['39,84/15,75/24,09', '—']);
    assert.equal(FOOTNOTES.length, 5);
    assert.match(APPENDIX_REF, /^Додаток 7 до Правил перевезень вантажів автомобільним транспортом в Україні/);
    assert.equal(CARGO_COLUMNS.length, 12, '№ з/п and graphs 1–11');
});

test('masses in figures everywhere except «масою брутто, т (словами)» (the form requires words only there)', async () => {
    const doc = ttn({ lines: [{ sort: 1, cargo_name: 'Пшениця', unit: 'т', gross_t: 24.09, bulk: true, owner_price: true }] });
    const words = /тонн|кілограм|\bкг\b/;
    const fields = frontFields(doc).filter(([, value]) => words.test(value)).map(([label]) => label);
    assert.deepEqual(fields, ['Масою брутто, т'], 'only one line in words');
    for (const cell of Object.values(cargoCells(doc.lines[0], 0))) assert.doesNotMatch(cell, words, 'cargo table in figures');
    for (const op of operationRows(doc)) assert.doesNotMatch(Object.values(op).join(' '), words, 'operations in figures');
    assert.equal(operationRows(doc)[0].mass, '39,84/15,75/24,09');
    const strings = unpack(buildDocXlsx(doc))['xl/sharedStrings.xml'];
    assert.equal((strings.match(/тонн/g) || []).length, 1, 'Excel: words only in that line');
    assert.match(read('src/lib/ttn-text.js'), /\['Масою брутто, т', grossWords\(doc\), '\(словами\)'\]/);
    assert.equal((read('src/lib/ttn-text.js').match(/massInWords\(/g) || []).length, 1, 'massInWords used once');
});

function png(width, height) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((width * 4 + 1) * height, 120);
    for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('waybill PDF: A4 landscape, front and back; 1 and 50 lines; with and without signature; cancelled watermark; 3 copies', async () => {
    const one = await buildTtnPdf(ttn(), { fonts });
    assert.deepEqual([one.info.pages, one.info.signature, one.info.stamp, one.info.watermark, one.info.copies], [2, false, false, false, 1]);
    const parsed = await PDFDocument.load(one.bytes);
    const { width, height } = parsed.getPage(0).getSize();
    assert.ok(width > height && Math.round(width) === 842 && Math.round(height) === 595, 'A4 landscape');
    assert.match(parsed.getTitle(), /ТТН № ТТН-7 від 20\.10\.2026/);
    const lines = Array.from({ length: 50 }, (_, i) => ({ sort: i + 1, cargo_name: 'Вантаж ' + (i + 1) + ' — пʼять ґудзиків', unit: 'шт', places: 2, price: 10, amount: 24,
        packaging: 'Ящик', gross_t: 0.4818, bulk: false }));
    const fifty = await buildTtnPdf(ttn({ lines, cargo_gross_t: 24.09, status: 'cancelled' }), { fonts, images: { signature: png(60, 20), stamp: png(40, 40) } });
    assert.ok(fifty.info.pages >= 3, '50 lines continue on more pages: ' + fifty.info.pages);
    assert.deepEqual([fifty.info.signature, fifty.info.stamp, fifty.info.watermark], [true, true, true]);
    assert.equal((await PDFDocument.load(fifty.bytes)).getSubject(), 'АНУЛЬОВАНО');
    const three = await buildTtnPdf(ttn(), { fonts, copies: 3 });
    assert.deepEqual([three.info.pages, three.info.copies], [6, 3], '3 copies × 2 pages');
    await assert.rejects(buildTtnPdf({ kind: 'invoice' }, { fonts }), /ttn only/);
});

test('vehicles: TO / insurance badge as on the site (overdue red, soon yellow), field limits as the CHECKs', () => {
    assert.equal(docState('2026-10-01', '2026-10-26'), 'overdue');
    assert.equal(docState('2026-11-10', '2026-10-26'), 'soon');
    assert.equal(docState('2027-03-01', '2026-10-26'), 'ok');
    assert.equal(docState(null, '2026-10-26'), 'empty');
    assert.equal(fleetBadge({ oscpv_on: '2027-03-01' }, '2026-10-26'), null);
    assert.deepEqual([fleetBadge({ oscpv_on: '2026-11-01', kasko_on: '2026-11-02' }, '2026-10-26').tone, fleetBadge({ oscpv_on: '2026-11-01', kasko_on: '2026-11-02' }, '2026-10-26').count], ['soon', 2]);
    assert.deepEqual([fleetBadge({ oscpv_on: '2026-10-01', kasko_on: '2026-11-02' }, '2026-10-26').tone, fleetBadge({ oscpv_on: '2026-10-01', kasko_on: '2026-11-02' }, '2026-10-26').count], ['overdue', 2]);
    assert.deepEqual(validateVehicleTtn({ length_m: '16,5', tare_t: '15,75', max_mass_t: '40', vehicle_type: ' Тягач ' }).data,
        { vehicle_type: 'Тягач', trailer_make_model: null, length_m: 16.5, width_m: null, height_m: null, tare_t: 15.75, max_mass_t: 40, default_driver_id: null });
    assert.deepEqual(Object.keys(validateVehicleTtn({ length_m: '0', width_m: '-1', height_m: '31', tare_t: '101', max_mass_t: '0' }).errors).sort(),
        ['height_m', 'length_m', 'max_mass_t', 'tare_t', 'width_m']);
    assert.ok(validateVehicleTtn({ tare_t: '40', max_mass_t: '40' }).errors.tare_t, 'tare not below the maximum mass');
    assert.ok(validateVehicleTtn({ vehicle_type: 'x'.repeat(101) }).errors.vehicle_type);
    assert.deepEqual(validateDriver({ full_name: '  Мельник  Олег ', license_no: 'вха 123456' }).data, { full_name: 'Мельник Олег', license_no: 'ВХА123456' });
    assert.ok(validateDriver({ full_name: '' }).errors.full_name);
});

test('documents list: waybills join the list without payments; status filter mapping', () => {
    const row = ttnListRow({ id: 't', number: 3, status: 'cancelled', total_amount: null, doc_date: '2026-10-20' });
    assert.deepEqual([row.kind, row.pay_status, row.debt, row.currency], ['ttn', 'cancelled', null, 'UAH']);
    assert.deepEqual(ttnStatusFilter(''), { include: true, value: null });
    assert.deepEqual(ttnStatusFilter('cancelled'), { include: true, value: 'cancelled' });
    assert.deepEqual(ttnStatusFilter('unpaid'), { include: false, value: null }, 'payment statuses exclude waybills');
    assert.deepEqual(parseCrmHash('#/docs/new/ttn/' + '11111111-2222-4333-8444-555555555555'), { view: 'docs', sub: 'new', kind: 'ttn', client: '11111111-2222-4333-8444-555555555555', calc: null });
});

test('new views: only h() / textContent (scanner), lazy xlsx and pdf, buttons wired', () => {
    for (const file of ['src/views/docs-ttn-form.js', 'src/views/docs-ttn-card.js', 'src/views/docs-fleet.js', 'src/views/docs.js', 'src/views/client-card.js']) {
        const code = read(file);
        assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, file);
        assert.doesNotMatch(code, /from ['"](fflate|pdf-lib)['"]|xlsx(-docs)?\.js['"]|pdf-ttn\.js['"]/, file + ': heavy modules only lazily');
    }
    const client = read('src/lib/docs-pdf-client.js');
    assert.match(client, /import\('\.\/xlsx-docs\.js'\)/);
    assert.match(client, /import\('\.\/pdf-ttn\.js'\)/);
    assert.match(read('src/lib/xlsx.js'), /from 'fflate'/);
    const writer = (read('src/lib/xlsx.js') + read('src/lib/xlsx-docs.js')).replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(writer, /<f>|<f |<f\/|\bformula/i, 'no formula writer');
    assert.match(read('src/views/docs.js'), /'Створити ТТН'/);
    assert.match(read('src/views/docs.js'), /excelButton\(app, r\.id/);
    assert.match(read('src/views/docs-card.js'), /excelButton\(app, doc\.id/);
    assert.match(read('src/views/client-card.js'), /#\/docs\/new\/ttn\/' \+ clientId \+ '\/' \+ r\.calculation_id/);
    assert.match(read('src/views/docs-fleet.js'), /aria-expanded': 'false'/, 'TO / insurance block collapsed by default');
});

const git = (...args) => { try { return execFileSync('git', args, { cwd: new URL('.', ROOT), encoding: 'utf8' }); } catch { return null; } };
const mainRef = git('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : null;

test('package.json: fflate is a dependency (exact version, MIT, no dependencies of its own), no other new dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.dependencies.fflate, /^\d+\.\d+\.\d+$/, 'exact version');
    const lock = JSON.parse(read('package-lock.json'));
    const entry = lock.packages['node_modules/fflate'];
    assert.equal(entry.version, pkg.dependencies.fflate);
    assert.equal(entry.license, 'MIT');
    assert.equal(entry.dependencies, undefined, 'no transitive dependencies');
    for (const name of ['xlsx', 'exceljs', 'sheetjs', 'jszip']) assert.equal(pkg.dependencies[name] || (pkg.devDependencies || {})[name], undefined, name);
    const base = mainRef && git('show', mainRef + ':apps/kontrol-plus/package.json');
    if (base) {
        const before = JSON.parse(base);
        const added = Object.keys(pkg.dependencies).filter((k) => !(k in before.dependencies));
        assert.ok('fflate' in before.dependencies, 'fflate is already in main');
        assert.deepEqual(added.filter((k) => k !== 'fflate'), [], 'no new dependencies besides fflate');
        assert.deepEqual(pkg.devDependencies, before.devDependencies, 'dev dependencies unchanged');
        for (const [k, v] of Object.entries(before.dependencies)) assert.equal(pkg.dependencies[k], v, k + ' unchanged');
    }
});

test('vercel.json: the CSP line equals main (4b adds no domains)', { skip: !mainRef && 'no origin/main' }, () => {
    const csps = (c) => c.headers.flatMap((b) => b.headers.filter((x) => x.key === 'Content-Security-Policy').map((x) => b.source + ' => ' + x.value));
    assert.deepEqual(csps(JSON.parse(read('vercel.json'))), csps(JSON.parse(git('show', mainRef + ':apps/kontrol-plus/vercel.json'))));
});

test('sample waybill: no sample scans in the repository (only invented mock data in tests)', () => {
    const files = (git('ls-files') || '').split('\n').concat(git('ls-files', '--others', '--exclude-standard') || '').filter(Boolean);
    assert.equal(files.some((f) => /ttn-samples|ttn-page\d/i.test(f)), false);
    assert.equal(files.some((f) => /^apps\/kontrol-plus\/.*\.(jpe?g|png)$/i.test(f) && /ttn|waybill|nakladn/i.test(f)), false);
});

test('built dist/: xlsx (fflate) and the waybill PDF are lazy chunks, not in the main bundle', { skip: !fs.existsSync(new URL('dist/index.html', APP)) && 'run npm run build first' }, () => {
    const assets = fs.readdirSync(new URL('dist/kp-assets/', APP));
    const bridge = assets.find((f) => /^site-bridge-.*\.js$/.test(f));
    const main = fs.readFileSync(new URL('dist/kp-assets/' + bridge, APP), 'utf8');
    assert.ok(assets.some((f) => /^xlsx-docs-.*\.js$/.test(f)), 'xlsx chunk');
    assert.ok(assets.some((f) => /^pdf-ttn-.*\.js$/.test(f)), 'waybill PDF chunk');
    assert.doesNotMatch(main, /zipSync|sharedStrings\.xml|kp_ttn_create/, 'xlsx writer and the waybill views are not in the main bundle');
});
