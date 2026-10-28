import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { docStatusKey, docStatusLabel } from '../src/lib/docs.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const readRoot = (file) => fs.readFileSync(new URL('../../../' + file, import.meta.url), 'utf8');
const css = read('src/crm.css');

// ---- 1. Статуси актів ----
test('п.1: акт — «Створено» / «Підписано» / «Анульовано», рахунок лишає статус оплати', () => {
    assert.equal(docStatusLabel('act', 'issued', false), 'Створено');
    assert.equal(docStatusLabel('act', 'issued', true), 'Підписано');
    assert.equal(docStatusLabel('act', 'cancelled', true), 'Анульовано');
    assert.equal(docStatusKey('act', 'issued', true), 'signed');
    for (const [status, label] of [['issued', 'Виставлено'], ['partial', 'Частково оплачено'], ['paid', 'Оплачено'], ['overdue', 'Прострочено'], ['cancelled', 'Анульовано']]) {
        assert.equal(docStatusLabel('invoice', status), label, status);
    }
    const docs = read('src/views/docs.js');
    assert.match(docs, /statusBadge\(r\.pay_status, r\.kind, signed\.has\(r\.id\)\)/);
    assert.match(docs, /r\.kind === 'act' \? h\('span', \{ class: 'kpd-kind kpd-kind-act' \}, 'Акт'\)/);
    assert.match(css, /\.kpd-st-signed \{/);
    assert.match(read('src/views/docs-card.js'), /rpc\('kp_doc_sign', \{ p_doc: doc\.id, p_signed: !signed \}\)/);
});

test('п.1: міграція підпису акта — окрема таблиця, RPC лише для власника, без прямого доступу', () => {
    const sql = readRoot('supabase/migrations/20261028100000_kp_act_signatures.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kp_document_signatures/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /v_org uuid := public\.kp_docs_org\('owner'\)/);
    assert.match(sql, /v_org uuid := public\.kp_docs_org\('read'\)/);
    assert.match(sql, /DOC_SIGN_ACT_ONLY/);
    assert.equal(/GRANT .* TO anon/i.test(sql), false);
    assert.match(sql, /НЕ застосовувати на прод/);
    // Не редагує старі міграції й викликає лише оголошені функції.
    const declared = new Set();
    for (const name of fs.readdirSync(new URL('../../../supabase/migrations/', import.meta.url))) {
        for (const m of readRoot('supabase/migrations/' + name).matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\s*\(/gi)) declared.add(m[1]);
    }
    for (const m of sql.replace(/--.*$/gm, '').matchAll(/public\.([a-z_0-9]+)\(/g)) assert.ok(declared.has(m[1]), m[1]);
});

// ---- 2. ТТН в Excel: графа 5 — назва одиниці, число — у кількості / масі ----
test('п.2: «Одиниця вимірювання» — назва, число переїжджає в кількість і масу (Excel, PDF-текст, збереження)', async () => {
    const { normalizeCargoLine } = await import('../src/lib/ttn.js');
    const { cargoCells, cargoTotals, CARGO_COLUMNS } = await import('../src/lib/ttn-text.js');
    const { ttnSheet } = await import('../src/lib/xlsx-docs.js');
    assert.deepEqual(normalizeCargoLine({ unit: '22', places: '', gross_t: '' }), { unit: 'т', places: 22, gross_t: 22 });
    assert.deepEqual(normalizeCargoLine({ unit: '22,5', places: null, gross_t: 20 }), { unit: 'т', places: null, gross_t: 20 });
    assert.deepEqual(normalizeCargoLine({ unit: 'кг', places: 3 }), { unit: 'кг', places: 3 }, 'назва лишається як є');
    assert.equal(normalizeCargoLine({ unit: ' 5 ', places: 7, gross_t: 9 }).places, 7, 'заповнені графи не чіпаємо');

    const doc = {
        kind: 'ttn', status: 'issued', number: 1, doc_date: '2026-10-27', cargo_gross_t: 22, operations: [],
        lines: [
            { cargo_name: 'Пшениця', unit: '22', places: null, gross_t: null },
            { cargo_name: 'Ящики', unit: 'шт', places: 40, price: 10, amount: 400, gross_t: 1.2 },
        ],
    };
    const sheet = ttnSheet(doc);
    const unitCol = CARGO_COLUMNS.findIndex((c) => c.key === 'unit');
    const placesCol = CARGO_COLUMNS.findIndex((c) => c.key === 'places');
    const grossCol = CARGO_COLUMNS.findIndex((c) => c.key === 'gross_t');
    assert.equal(CARGO_COLUMNS[unitCol].no, '5');
    const dataRows = sheet.rows.filter((r) => r[1] && (r[1].v === 'Пшениця' || r[1].v === 'Ящики'));
    assert.equal(dataRows.length, 2);
    assert.equal(dataRows[0][unitCol].v, 'т', 'у графі 5 — назва одиниці, а не 22');
    assert.equal(dataRows[0][placesCol].v, 22);
    assert.equal(dataRows[0][grossCol].v, 22);
    assert.equal(dataRows[1][unitCol].v, 'шт');
    assert.equal(dataRows[1][placesCol].v, 40);
    assert.equal(cargoCells(doc.lines[0], 0).unit, 'т');
    assert.equal(cargoTotals(doc).places, '62');
});
