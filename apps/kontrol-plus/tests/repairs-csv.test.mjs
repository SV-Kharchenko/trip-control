import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseDecimal, parseCsvDate, buildImportRows, importTemplateCsv, CsvError, CSV_MAX_ROWS, toCsv } from '../src/lib/csv.js';

const cells = (text) => parseCsv(text).records.map((r) => r.cells);

test('RFC 4180: quotes, "" inside quotes, line breaks inside quotes, BOM, CRLF / LF', () => {
    assert.deepEqual(cells('﻿a;b;c\r\n"x;y";"say ""hi""";"line1\nline2"\r\n'), [['a', 'b', 'c'], ['x;y', 'say "hi"', 'line1\nline2']]);
    const parsed = parseCsv('h1;h2\n"multi\nline";2\nnext;3\n');
    assert.deepEqual(parsed.records.map((r) => r.line), [1, 2, 4], 'line numbers of the file (a quoted break counts)');
    assert.throws(() => parseCsv('a;b\n"open;1\n'), (e) => e instanceof CsvError && e.code === 'UNCLOSED_QUOTE');
});

test('delimiter: «;» or «,» detected by the header; empty lines skipped', () => {
    assert.equal(parseCsv('Назва,Кількість,Ціна\nA,"1,5",2\n').delimiter, ',');
    assert.deepEqual(cells('Назва,Кількість,Ціна\nA,"1,5",2\n')[1], ['A', '1,5', '2']);
    assert.equal(parseCsv('Назва;Кількість;Ціна\nA;1,5;2\n').delimiter, ';');
    assert.deepEqual(cells('a;b\n\n;\n  ;  \nc;d\n'), [['a', 'b'], ['c', 'd']]);
});

test('decimal comma, spaces between thousands, ₴; dates DD.MM.YYYY and YYYY-MM-DD', () => {
    assert.equal(parseDecimal('1 234,50'), '1234.5');
    assert.equal(parseDecimal('1234.5'), '1234.5');
    assert.equal(parseDecimal('2 150,00 ₴'), '2150');
    assert.equal(parseDecimal('0'), '0');
    for (const bad of ['', '-1', '1,2,3', 'abc', '1e3']) assert.equal(parseDecimal(bad), null, bad);
    assert.equal(parseCsvDate('31.12.2025'), '2025-12-31');
    assert.equal(parseCsvDate('1.2.2026'), '2026-02-01');
    assert.equal(parseCsvDate('2026-10-01'), '2026-10-01');
    assert.equal(parseCsvDate(''), '');
    for (const bad of ['30.02.2026', '2026-13-01', '01/10/2026', 'вчора']) assert.equal(parseCsvDate(bad), null, bad);
});

test('header in any order, aliases; missing required columns → error', () => {
    const { rows } = buildImportRows('Примітка;Ціна;Дата;Кількість;Назва;Артикул\nпочаток;"1 200,5";05.10.2026;3;Фільтр;F-1\n');
    assert.deepEqual(rows, [{ line: 2, name: 'Фільтр', article: 'F-1', unit: '', qty: '3', unit_price: '1200.5', date: '2026-10-05', supplier: '', note: 'початок' }]);
    assert.throws(() => buildImportRows('Назва;Кількість\nA;1\n'), (e) => e.code === 'BAD_HEADER' && /Ціна за одиницю/.test(e.message));
    assert.throws(() => buildImportRows(''), (e) => e.code === 'EMPTY');
    const bad = buildImportRows('Назва;Кількість;Ціна\nA;x;-1\n').rows[0];
    assert.deepEqual([bad.qty, bad.unit_price], ['x', '-1'], 'invalid values go to the server as is (it reports the error)');
});

test('limits: 2000 data rows ok, 2001 → error; more than 1 MB → error', () => {
    const header = 'Назва;Кількість;Ціна\n';
    const rowsOf = (n) => header + Array.from({ length: n }, (_, i) => 'Деталь ' + i + ';1;1').join('\n');
    assert.equal(buildImportRows(rowsOf(CSV_MAX_ROWS)).rows.length, 2000);
    assert.throws(() => buildImportRows(rowsOf(CSV_MAX_ROWS + 1)), (e) => e.code === 'TOO_MANY_ROWS');
    assert.throws(() => parseCsv(header + 'x'.repeat(1024 * 1024)), (e) => e.code === 'TOO_LARGE');
});

test('template: UTF-8 BOM, «;», parses with our own parser without errors', () => {
    const template = importTemplateCsv();
    assert.ok(template.startsWith('﻿Назва;Артикул;Одиниця;Кількість;Ціна за одиницю;Дата;Постачальник;Примітка\r\n'));
    const { rows } = buildImportRows(template);
    assert.equal(rows.length, 2);
    for (const row of rows) {
        assert.match(row.qty, /^\d+(\.\d+)?$/);
        assert.match(row.unit_price, /^\d+(\.\d+)?$/);
        assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.match(toCsv(['a'], [[1.5]]), /1,5/, 'export (toCsv) unchanged');
});
