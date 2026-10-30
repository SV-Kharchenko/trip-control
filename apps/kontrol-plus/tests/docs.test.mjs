import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { amountInWords, integerWords, pluralForm, toCents } from '../src/lib/amount-words.js';
import {
    assetPath, assetProblem, dateWords, debtTotals, defaultLineTitle, docErrorText, docFileName, docNumberText, docsAccess,
    dueDateFor, fmtAmount, isMissingFeature, lineAmount, linesPayload, previewTotals, rateProblem, sniffImage, sortDebts,
    tripsToLines, validateLines, validateRequisites,
} from '../src/lib/docs.js';
import { contractText, partyLines, rateLine, totalWords, totalsRows } from '../src/lib/pdf-docs-text.js';
import { parseCrmHash, tabOf } from '../src/lib/route.js';
import { CONTRACT_KEYS, validateClient } from '../src/lib/validate.js';
import { listTotals } from '../src/views/docs.js';
import { clientPayload } from '../src/views/client-form.js';
import { requisitesPayload } from '../src/views/docs-requisites.js';

const APP = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), 'utf8');
const ID = '0b9f2c4e-1a2b-4c3d-8e9f-0123456789ab';
const ID2 = '1c9f2c4e-1a2b-4c3d-8e9f-0123456789ab';

test('amount in words: small numbers, gender and case of гривня', () => {
    assert.equal(amountInWords(0), 'Нуль гривень 00 копійок');
    assert.equal(amountInWords(1), 'Одна гривня 00 копійок');
    assert.equal(amountInWords(2), 'Дві гривні 00 копійок');
    assert.equal(amountInWords(5), 'Пʼять гривень 00 копійок');
    assert.equal(amountInWords(11), 'Одинадцять гривень 00 копійок');
    assert.equal(amountInWords(21), 'Двадцять одна гривня 00 копійок');
    assert.equal(amountInWords(22), 'Двадцять дві гривні 00 копійок');
    assert.equal(amountInWords(101), 'Сто одна гривня 00 копійок');
    assert.equal(amountInWords(112), 'Сто дванадцять гривень 00 копійок');
});

test('amount in words: тисяча / тисячі / тисяч, мільйони, the upper bound', () => {
    assert.equal(amountInWords(1000), 'Одна тисяча гривень 00 копійок');
    assert.equal(amountInWords(2000), 'Дві тисячі гривень 00 копійок');
    assert.equal(amountInWords(5000), 'Пʼять тисяч гривень 00 копійок');
    assert.equal(amountInWords(11000), 'Одинадцять тисяч гривень 00 копійок');
    assert.equal(amountInWords(21000), 'Двадцять одна тисяча гривень 00 копійок');
    assert.equal(amountInWords(2000000), 'Два мільйони гривень 00 копійок');
    assert.equal(amountInWords(1001001), 'Один мільйон одна тисяча одна гривня 00 копійок');
    assert.equal(amountInWords(5000000), 'Пʼять мільйонів гривень 00 копійок');
    assert.equal(amountInWords('999999999.99'),
        'Девʼятсот девʼяносто девʼять мільйонів девʼятсот девʼяносто девʼять тисяч девʼятсот девʼяносто девʼять гривень 99 копійок');
    assert.throws(() => amountInWords('1000000000.00'), RangeError);
    assert.throws(() => amountInWords(-1), RangeError);
    assert.throws(() => amountInWords('abc'), RangeError);
});

test('amount in words: копійки 01 / 10 / 99 and the forms of копійка', () => {
    assert.equal(amountInWords('0.01'), 'Нуль гривень 01 копійка');
    assert.equal(amountInWords('3.02'), 'Три гривні 02 копійки');
    assert.equal(amountInWords('3.10'), 'Три гривні 10 копійок');
    assert.equal(amountInWords('3.11'), 'Три гривні 11 копійок');
    assert.equal(amountInWords('3.21'), 'Три гривні 21 копійка');
    assert.equal(amountInWords(1234.99), 'Одна тисяча двісті тридцять чотири гривні 99 копійок');
});

test('amount in words: USD — долар / центи, EUR — євро (середній рід)', () => {
    assert.equal(amountInWords(1, 'USD'), 'Один долар 00 центів');
    assert.equal(amountInWords(2, 'USD'), 'Два долари 00 центів');
    assert.equal(amountInWords(21.01, 'USD'), 'Двадцять один долар 01 цент');
    assert.equal(amountInWords(5.22, 'USD'), 'Пʼять доларів 22 центи');
    assert.equal(amountInWords(1, 'EUR'), 'Одне євро 00 центів');
    assert.equal(amountInWords(2, 'EUR'), 'Два євро 00 центів');
    assert.equal(amountInWords(1000.5, 'EUR'), 'Одна тисяча євро 50 центів');
    assert.throws(() => amountInWords(1, 'GBP'), RangeError);
});

test('amount helpers: plural forms, integer words, cents without float errors', () => {
    const forms = ['гривня', 'гривні', 'гривень'];
    assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => pluralForm(n, forms)),
        ['гривня', 'гривні', 'гривні', 'гривень', 'гривень', 'гривень', 'гривень', 'гривня', 'гривні', 'гривень', 'гривня', 'гривень']);
    assert.equal(integerWords(0), 'нуль');
    assert.equal(integerWords(40, 'f'), 'сорок');
    assert.equal(toCents('0.1'), 10);
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents('1 234,5'), 123450);
    assert.equal(toCents('1000000.005'), 100000001);
});

test('preview totals follow the server rules: net, gross, not a VAT payer, rounding', () => {
    const one = (price, qty = 1) => [{ qty, price }];
    assert.deepEqual(previewTotals(one(0.01), { vatPayer: true, vatMode: 'net' }), { subtotal: 0.01, vat: 0, total: 0.01, vatRate: 20 });
    assert.deepEqual(previewTotals(one(0.03), { vatPayer: true, vatMode: 'net' }), { subtotal: 0.03, vat: 0.01, total: 0.04, vatRate: 20 });
    assert.deepEqual(previewTotals(one(2000000.01, 0.5), { vatPayer: true, vatMode: 'net' }), { subtotal: 1000000.01, vat: 200000, total: 1200000.01, vatRate: 20 });
    assert.deepEqual(previewTotals(one(120), { vatPayer: true, vatMode: 'gross' }), { subtotal: 100, vat: 20, total: 120, vatRate: 20 });
    assert.deepEqual(previewTotals(one(0.01), { vatPayer: true, vatMode: 'gross' }), { subtotal: 0.01, vat: 0, total: 0.01, vatRate: 20 });
    assert.deepEqual(previewTotals(one(100), { vatPayer: true, vatMode: 'gross' }), { subtotal: 83.33, vat: 16.67, total: 100, vatRate: 20 });
    assert.deepEqual(previewTotals(one(100), { vatPayer: false, vatMode: 'gross' }), { subtotal: 100, vat: 0, total: 100, vatRate: 0 });
    assert.equal(lineAmount(1.5, 2000), 3000);
    assert.equal(lineAmount(3, 33.33), 99.99);
    assert.ok(Number.isNaN(previewTotals([{ qty: 'x', price: 1 }], { vatPayer: true }).total));
});

test('lines: default title from the trip, validation limits, payload', () => {
    const trip = { calculation_id: ID, route_from: 'Київ', route_to: 'Одеса', trip_date: '2026-10-01', price: 12000 };
    assert.equal(defaultLineTitle(trip), 'Послуги з перевезення вантажу за маршрутом Київ — Одеса, 01.10.2026');
    assert.equal(defaultLineTitle({ name: 'Рейс 7' }), 'Послуги з перевезення вантажу за маршрутом Рейс 7');
    assert.deepEqual(tripsToLines([trip]), [{ title: defaultLineTitle(trip), unit: 'послуга', qty: 1, price: 12000, calculation_id: ID }]);
    assert.equal(validateLines([]).all, 'Додайте хоча б один рядок');
    assert.match(validateLines(Array.from({ length: 201 }, () => ({ title: 'a', qty: 1, price: 1 }))).all, /200/);
    assert.deepEqual(validateLines(Array.from({ length: 200 }, () => ({ title: 'a', qty: 1, price: 1 }))), {});
    const bad = validateLines([{ title: '', qty: 1, price: 1 }, { title: 'a', qty: 0, price: 1 }, { title: 'a', qty: 1, price: -1 }, { title: 'a'.repeat(501), qty: 1, price: 1 },
        { title: 'a', qty: '1,5', price: '10,5' }]);
    assert.deepEqual(Object.keys(bad), ['0', '1', '2', '3']);
    assert.deepEqual(linesPayload([{ title: ' Послуга ', unit: '', qty: '1,5', price: '10,50', calculation_id: ID }]),
        [{ title: 'Послуга', unit: 'послуга', qty: 1.5, price: 10.5, calculation_id: ID }]);
});

test('rate check matches the server boundary; due date from client terms (5 days by default)', () => {
    assert.equal(rateProblem('UAH', '', '', '2026-10-12'), null);
    assert.match(rateProblem('USD', '0', '2026-10-12', '2026-10-12'), /більше 0/);
    assert.match(rateProblem('USD', '-1', '2026-10-12', '2026-10-12'), /більше 0/);
    assert.match(rateProblem('USD', '41,5', '2026-10-13', '2026-10-12'), /пізнішою/);
    assert.match(rateProblem('USD', '41.5', '2026-10-04', '2026-10-12'), /7 днів/);
    assert.equal(rateProblem('EUR', '45.5', '2026-10-05', '2026-10-12'), null);
    assert.equal(dueDateFor('2026-10-14', 10), '2026-10-24');
    assert.equal(dueDateFor('2026-10-14', null), '2026-10-19');
    assert.equal(dueDateFor('2026-12-30', 5), '2027-01-04');
});

test('requisites validation: name and a code required, formats as the database CHECKs, prefixes', () => {
    const ok = validateRequisites({ legal_name: 'ТОВ «Тест»', edrpou: '1436 0570', iban: 'ua21 3223 1300 0002 6007 2335 6600 1', invoice_prefix: 'РФ-' });
    assert.deepEqual(ok.errors, {});
    assert.equal(ok.data.iban, 'UA213223130000026007233566001');
    assert.equal(ok.data.default_vat_mode, 'net');
    const bad = validateRequisites({ legal_name: '', edrpou: '123', iban: 'DE89', invoice_prefix: 'ЗАДОВГИЙПРЕФІКС', default_vat_mode: 'mixed', vat_number: '123' });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['default_vat_mode', 'edrpou', 'iban', 'invoice_prefix', 'legal_name', 'vat_number']);
    assert.equal(validateRequisites({ legal_name: 'X' }).errors.edrpou, 'Для документів потрібен ЄДРПОУ або ІПН');
    assert.ok(validateRequisites({ legal_name: 'X', ipn: '1234567890' }).warnings.iban, 'no IBAN — a warning (acts are fine)');
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/20261026072759_kp_documents.sql', import.meta.url), 'utf8');
    assert.match(sql, /edrpou ~ '\^\[0-9\]\{8\}\$'/);
    assert.match(sql, /iban ~ '\^UA\[0-9\]\{27\}\$'/);
    assert.match(sql, /\^\[0-9A-Za-zА-яҐґЄєІіЇї\/\._-\]\{1,10\}\$/);
    assert.deepEqual(Object.keys(requisitesPayload(null)).sort(), ['act_prefix', 'bank_name', 'default_currency', 'default_vat_mode', 'doc_place', 'edrpou',
        'invoice_prefix', 'ipn', 'legal_address', 'legal_form', 'legal_name', 'signer_name', 'signer_position', 'ttn_prefix', 'vat_number', 'vat_payer', 'iban'].sort());
    assert.equal(requisitesPayload({ legal_name: 'X', signature_path: 'a/signature.png' }).signature_path, undefined, 'asset paths are never resent');
});

test('signature / stamp files: PNG or JPEG up to 512 KB, type checked by the first bytes, path per org', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(sniffImage(png), 'png');
    assert.equal(sniffImage(jpg), 'jpg');
    assert.equal(sniffImage(new Uint8Array([0x47, 0x49, 0x46])), null);
    assert.equal(assetProblem({ type: 'image/png', size: 1000, bytes: png }), null);
    assert.equal(assetProblem({ type: 'image/jpeg', size: 524288, bytes: jpg }), null);
    assert.equal(assetProblem({ type: 'image/png', size: 524289, bytes: png }), 'Файл більший за 512 КБ');
    assert.equal(assetProblem({ type: 'image/gif', size: 10 }), 'Лише PNG або JPEG');
    assert.equal(assetProblem({ type: 'image/png', size: 10, bytes: new Uint8Array([1, 2, 3]) }), 'Файл не схожий на PNG чи JPEG');
    assert.equal(assetProblem({ type: 'image/png', size: 10, bytes: jpg }), 'Розширення не відповідає вмісту файлу');
    assert.equal(assetPath('org-1', 'signature', 'jpg'), 'org-1/signature.jpg');
    assert.equal(assetPath('org-1', 'stamp', 'png'), 'org-1/stamp.png');
});

test('debts: totals per currency, sorting by overdue / debt / days / name', () => {
    const rows = [
        { client_name: 'Бета', currency: 'UAH', invoiced: 300, paid: 100, debt: 200, overdue: 200, overdue_days: 10 },
        { client_name: 'Альфа', currency: 'UAH', invoiced: 1500, paid: 0, debt: 1500, overdue: 1000, overdue_days: 1 },
        { client_name: 'Гамма', currency: 'USD', invoiced: 120, paid: 20, debt: 100, overdue: 0, overdue_days: null },
    ];
    assert.deepEqual(debtTotals(rows), { UAH: { invoiced: 1800, paid: 100, debt: 1700, overdue: 1200 }, USD: { invoiced: 120, paid: 20, debt: 100, overdue: 0 } });
    assert.deepEqual(sortDebts(rows).map((r) => r.client_name), ['Альфа', 'Бета', 'Гамма']);
    assert.deepEqual(sortDebts(rows, 'debt').map((r) => r.client_name), ['Альфа', 'Бета', 'Гамма']);
    assert.deepEqual(sortDebts(rows, 'days').map((r) => r.client_name), ['Бета', 'Альфа', 'Гамма']);
    assert.deepEqual(sortDebts(rows, 'name').map((r) => r.client_name), ['Альфа', 'Бета', 'Гамма']);
    assert.deepEqual(listTotals([{ kind: 'invoice', status: 'issued', currency: 'UAH', total: 10.1, debt: 5 }, { kind: 'invoice', status: 'cancelled', currency: 'UAH', total: 99, debt: 99 },
        { kind: 'act', status: 'issued', currency: 'UAH', total: 50 }, { kind: 'invoice', status: 'issued', currency: 'UAH', total: 0.2, debt: 0.2 }]), { UAH: { total: 10.3, debt: 5.2 } });
});

test('access: owner writes and cancels, logist writes, director reads, others nothing', () => {
    assert.deepEqual(docsAccess({ control_plus: true, role: 'owner' }), { visible: true, canWrite: true, isOwner: true });
    assert.deepEqual(docsAccess({ control_plus: true, role: 'logist' }), { visible: true, canWrite: true, isOwner: false });
    assert.deepEqual(docsAccess({ control_plus: true, role: 'director' }), { visible: true, canWrite: false, isOwner: false });
    assert.deepEqual(docsAccess({ control_plus: false, role: 'owner' }), { visible: false, canWrite: false, isOwner: false });
    assert.deepEqual(docsAccess(null), { visible: false, canWrite: false, isOwner: false });
});

test('database codes → Ukrainian text; missing migration detected', () => {
    assert.match(docErrorText({ message: 'TRIP_ALREADY_BILLED' }), /уже є в активному документі/);
    assert.match(docErrorText({ message: 'DOC_NUMBER_TAKEN' }), /номером/);
    assert.match(docErrorText({ message: 'PAYMENT_EXCEEDS' }), /більша за залишок/);
    assert.match(docErrorText({ message: 'DOC_ALREADY_CANCELLED' }), /уже анульовано/);
    assert.match(docErrorText({ message: 'DOC_CANCELLED' }), /не приймає оплат/);
    assert.match(docErrorText({ message: 'PAYMENT_BAD_DATE' }), /не в майбутньому/);
    assert.match(docErrorText({ message: 'KP_FORBIDDEN' }), /Недостатньо прав/);
    assert.match(docErrorText({ message: 'update or delete on table "clients" violates foreign key constraint "kp_documents_client_id_fkey"' }), /архів/);
    assert.match(docErrorText({ message: 'CONTROL_PLUS_REQUIRED' }), /Контроль\+/);
    assert.equal(isMissingFeature({ code: 'PGRST202', message: 'Could not find the function public.kp_doc_list' }), true);
    assert.equal(isMissingFeature({ code: 'P0001', message: 'KP_FORBIDDEN' }), false);
});

test('document texts: number, dates, file name, parties, rate line, totals', () => {
    assert.equal(docNumberText({ prefix: 'РФ-', number: 12 }), 'РФ-12');
    assert.equal(docNumberText({ number_text: 'АКТ-3', number: 3 }), 'АКТ-3');
    assert.equal(dateWords('2026-10-12'), '12 жовтня 2026 р.');
    assert.equal(dateWords('2026-01-01'), '1 січня 2026 р.');
    assert.equal(docFileName({ kind: 'invoice', number: 12, doc_date: '2026-10-12', status: 'issued' }), 'rakhunok_12_2026-10-12.pdf');
    assert.equal(docFileName({ kind: 'act', number: 3, doc_date: '2026-10-12', status: 'cancelled' }), 'akt_3_2026-10-12_anulovano.pdf');
    assert.equal(fmtAmount(1234.5, 'UAH').replace(/\s/g, ' '), '1 234,50 грн');
    assert.equal(fmtAmount(10, 'USD').replace(/\s/g, ' '), '10,00 USD');
    const buyer = { name: 'Зерно', edrpou: '23456789', contract_no: 'Д-15/2026', contract_date: '2026-01-15', vat_payer: false };
    assert.deepEqual(partyLines(buyer, { contract: true }), ['Зерно', 'Код ЄДРПОУ 23456789', 'Не є платником ПДВ', 'Договір № Д-15/2026 від 15.01.2026']);
    assert.equal(contractText(buyer), '№ Д-15/2026 від 15.01.2026');
    assert.equal(rateLine({ currency: 'UAH' }), null);
    assert.equal(rateLine({ currency: 'USD', rate: 41.123456, rate_date: '2026-10-05', total_uah: 4934.81 }).replace(/\s/g, ' '),
        'Курс НБУ на 05.10.2026: 1 USD = 41,123456 грн; еквівалент 4 934,81 грн');
    assert.deepEqual(totalsRows({ vat_rate: 0, subtotal: 100, total: 100, currency: 'UAH' }).map((r) => r[0]), ['Разом:', 'ПДВ:', 'Всього:']);
    assert.equal(totalsRows({ vat_rate: 0, subtotal: 100, total: 100, currency: 'UAH' })[1][1], 'Без ПДВ');
    assert.deepEqual(totalsRows({ vat_rate: 20, subtotal: 100, vat_amount: 20, total: 120, currency: 'UAH' }).map((r) => r[0]), ['Разом без ПДВ:', 'ПДВ 20 %:', 'Всього з ПДВ:']);
    assert.match(totalWords({ vat_rate: 20, total: 120, vat_amount: 20, currency: 'UAH' }), /^Сто двадцять гривень 00 копійок, у т\.ч\. ПДВ 20,00/);
    assert.match(totalWords({ vat_rate: 0, total: 100, currency: 'EUR' }), /^Сто євро 00 центів, без ПДВ$/);
});

test('routes: #/docs and its sub-pages; bad kinds or ids → not a route', () => {
    assert.deepEqual(parseCrmHash('#/docs'), { view: 'docs', sub: 'list' });
    assert.deepEqual(parseCrmHash('#/docs/debts'), { view: 'docs', sub: 'debts' });
    assert.deepEqual(parseCrmHash('#/docs/requisites'), { view: 'docs', sub: 'requisites' });
    assert.deepEqual(parseCrmHash('#/docs/' + ID), { view: 'docs', sub: 'doc', id: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/invoice'), { view: 'docs', sub: 'new', kind: 'invoice', client: null, calc: null });
    assert.deepEqual(parseCrmHash('#/docs/new/act/' + ID), { view: 'docs', sub: 'new', kind: 'act', client: ID, calc: null });
    assert.deepEqual(parseCrmHash('#/docs/new/act/' + ID + '/' + ID2), { view: 'docs', sub: 'new', kind: 'act', client: ID, calc: ID2 });
    assert.deepEqual(parseCrmHash('#/docs/new/ttn'), { view: 'docs', sub: 'new', kind: 'ttn', client: null, calc: null }, '4b: waybill form');
    assert.deepEqual(parseCrmHash('#/docs/ttn/' + ID), { view: 'docs', sub: 'ttn', id: ID }, '4b: waybill card');
    assert.deepEqual(parseCrmHash('#/docs/fleet'), { view: 'docs', sub: 'fleet' }, '4b: vehicles and drivers');
    for (const hash of ['#/docs/new/cmr', '#/docs/new', '#/docs/new/act/abc', '#/docs/xyz', '#/docs/debts/1', '#/docs/new/act/' + ID + '/' + ID2 + '/x', '#/docs/ttn', '#/docs/ttn/abc', '#/docs/fleet/1']) {
        assert.equal(parseCrmHash(hash), null, hash);
    }
    assert.equal(tabOf(parseCrmHash('#/docs/debts')), 'docs');
    assert.deepEqual(parseCrmHash('#/clients'), { view: 'clients' }, 'other routes unchanged');
});

test('client contract fields: validation as the CHECKs; sent only when the database has the columns', () => {
    const ok = validateClient({ name: 'X', contract_no: ' Д-1 ', contract_date: '2026-01-15', payment_terms_days: '10' });
    assert.deepEqual(ok.errors, {});
    assert.equal(ok.data.contract_no, 'Д-1');
    assert.equal(ok.data.payment_terms_days, 10);
    assert.equal(validateClient({ name: 'X' }).data.payment_terms_days, null);
    const bad = validateClient({ name: 'X', contract_no: 'x'.repeat(101), contract_date: '15.01.2026', payment_terms_days: '366' });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['contract_date', 'contract_no', 'payment_terms_days']);
    assert.ok(validateClient({ name: 'X', payment_terms_days: '-1' }).errors.payment_terms_days);
    assert.ok(validateClient({ name: 'X', payment_terms_days: '1.5' }).errors.payment_terms_days);
    assert.deepEqual(CONTRACT_KEYS, ['contract_no', 'contract_date', 'payment_terms_days']);
    const data = { name: 'X', contract_no: null, contract_date: null, payment_terms_days: null };
    assert.deepEqual(clientPayload(data, null, {}), { name: 'X' }, 'new client without a contract — no new keys (works before the migration)');
    assert.deepEqual(clientPayload({ ...data, contract_no: 'Д-1' }, null, {}), { name: 'X', contract_no: 'Д-1' });
    assert.deepEqual(clientPayload(data, 'c1', { name: 'X' }), { name: 'X' }, 'existing client loaded without the columns');
    assert.deepEqual(clientPayload(data, 'c1', { name: 'X', contract_no: null, contract_date: null, payment_terms_days: null }), data, 'columns exist — all sent');
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/20261026072759_kp_documents.sql', import.meta.url), 'utf8');
    assert.match(sql, /char_length\(btrim\(contract_no\)\) BETWEEN 1 AND 100/);
    assert.match(sql, /payment_terms_days BETWEEN 0 AND 365/);
});

test('documents views: only h() / textContent, no innerHTML / outerHTML / insertAdjacentHTML, no inline styles or dialogs', () => {
    const files = fs.readdirSync(new URL('src/views/', APP)).filter((f) => /^docs.*\.js$/.test(f));
    assert.deepEqual(files.sort(), ['docs-card.js', 'docs-debts.js', 'docs-fleet.js', 'docs-form.js', 'docs-request-picker.js', 'docs-requisites.js', 'docs-ts-card.js', 'docs-ts-form.js', 'docs-ttn-card.js', 'docs-ttn-form.js', 'docs.js']);
    for (const file of [...files.map((f) => 'src/views/' + f), 'src/lib/docs.js', 'src/lib/pdf-docs.js', 'src/lib/pdf-docs-text.js', 'src/lib/docs-pdf-client.js', 'src/lib/amount-words.js',
        'src/lib/ttn.js', 'src/lib/ttn-text.js', 'src/lib/pdf-ttn.js', 'src/lib/trip-sheet.js', 'src/lib/pdf-trip-sheet.js', 'src/lib/count-words.js', 'src/lib/fleet.js', 'src/lib/xlsx.js', 'src/lib/xlsx-docs.js']) {
        const code = read(file);
        assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
        assert.doesNotMatch(code, /window\.(alert|confirm|prompt)\(|\balert\(/, file);
        assert.doesNotMatch(code, /\bstyle:\s*['"]|setAttribute\(\s*['"]style/, file + ': inline style (CSP style-src without unsafe-inline)');
        assert.doesNotMatch(code, /localStorage|sessionStorage|createClient/, file);
        assert.doesNotMatch(code, /bank\.gov\.ua/, file + ': the NBU only through /api/docs/rate');
    }
    assert.match(read('src/views/docs-requisites.js'), /readAsDataURL/, 'signature / stamp preview through data: URLs');
    assert.doesNotMatch(read('src/views/docs-requisites.js'), /createObjectURL/, 'no blob: in img-src');
});

test('PDF is lazy: pdf-lib only in pdf-docs.js, loaded by dynamic import', () => {
    for (const file of fs.readdirSync(new URL('src/views/', APP)).map((f) => 'src/views/' + f).concat(['src/bridge.js', 'src/lib/docs.js', 'src/lib/pdf-docs-text.js'])) {
        assert.doesNotMatch(read(file), /from ['"](pdf-lib|@pdf-lib\/fontkit)['"]|pdf-docs\.js['"]/, file);
    }
    assert.match(read('src/lib/docs-pdf-client.js'), /import\('\.\/pdf-docs\.js'\)/);
    assert.match(read('src/lib/pdf-docs.js'), /from 'pdf-lib'/);
    assert.match(read('src/bridge.js'), /import\('\.\/views\/docs\.js'\)/, 'the documents views are a lazy chunk too');
    assert.doesNotMatch(read('src/bridge.js'), /from '\.\/views\/docs\.js'/);
});

test('built dist/: pdf-lib and the documents views are separate lazy chunks; fonts served from /fonts/', { skip: !fs.existsSync(new URL('dist/index.html', APP)) && 'run npm run build first' }, () => {
    const assets = fs.readdirSync(new URL('dist/kp-assets/', APP));
    const bridge = assets.find((f) => /^site-bridge-.*\.js$/.test(f));
    const pdfChunk = assets.find((f) => /^pdf-docs-.*\.js$/.test(f));
    const docsChunk = assets.find((f) => /^docs-.*\.js$/.test(f));
    assert.ok(pdfChunk && docsChunk, 'lazy chunks exist');
    const main = fs.readFileSync(new URL('dist/kp-assets/' + bridge, APP), 'utf8');
    assert.doesNotMatch(main, /PDFDocument|fontkit|registerFontkit/, 'pdf-lib is not in the main bundle');
    assert.doesNotMatch(main, /kp_payment_add/, 'documents views are not in the main bundle');
    assert.ok(main.includes(docsChunk), 'the bridge loads the documents chunk lazily');
    assert.match(fs.readFileSync(new URL('dist/kp-assets/' + pdfChunk, APP), 'utf8'), /\/fonts\/NotoSans-Regular\.ttf/);
    assert.ok(fs.existsSync(new URL('dist/fonts/NotoSans-Regular.ttf', APP)) && fs.existsSync(new URL('dist/fonts/OFL.txt', APP)));
});

test('dependencies: pdf-lib and @pdf-lib/fontkit (4a) and fflate (4b), pinned; fonts with the OFL license', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.dependencies['pdf-lib'], '1.17.1');
    assert.equal(pkg.dependencies['@pdf-lib/fontkit'], '1.1.1');
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@pdf-lib/fontkit', '@supabase/supabase-js', 'fflate', 'leaflet', 'pdf-lib']);
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@electric-sql/pglite', 'vite']);
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.packages['node_modules/pdf-lib'].version, '1.17.1');
    assert.equal(lock.packages['node_modules/pdf-lib'].license, 'MIT');
    assert.equal(lock.packages['node_modules/@pdf-lib/fontkit'].version, '1.1.1');
    assert.equal(lock.packages['node_modules/@pdf-lib/fontkit'].license, 'MIT');
    for (const font of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']) {
        const bytes = fs.readFileSync(new URL('public/fonts/' + font, APP));
        assert.ok(bytes.length > 100000, font);
        assert.deepEqual([...bytes.subarray(0, 4)], [0, 1, 0, 0], font + ' is TrueType');
    }
    assert.match(read('public/fonts/OFL.txt'), /SIL Open Font License, Version 1\.1/);
});

// CSP застосунку не змінюється етапом 4a: рядки дорівнюють main (і ці константи).
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://*.supabase.co; "
    + "manifest-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
test('vercel.json: CSP unchanged (same strings as main); no blob: in the strict img-src, no new domains', () => {
    const cfg = JSON.parse(read('vercel.json'));
    const csps = (c) => c.headers.flatMap((b) => b.headers.filter((x) => x.key === 'Content-Security-Policy').map((x) => b.source + ' => ' + x.value));
    const now = csps(cfg);
    assert.equal(now.length, 2);
    assert.ok(now.some((line) => line.endsWith(' => ' + STRICT_CSP)), 'strict CSP as before');
    let main = null;
    try {
        main = JSON.parse(execFileSync('git', ['show', 'origin/main:apps/kontrol-plus/vercel.json'], { cwd: new URL('.', APP), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { /* без origin/main — лише константа */ }
    if (main) assert.deepEqual(now, csps(main), 'CSP headers equal origin/main');
    assert.doesNotMatch(STRICT_CSP, /blob:|unsafe-inline|unsafe-eval|bank\.gov\.ua/);
});
