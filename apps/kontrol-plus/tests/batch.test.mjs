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
