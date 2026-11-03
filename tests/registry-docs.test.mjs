// «Реєстр заявок» PR C: документи й оплати (лише Контроль+): колонки, фільтри, дії, CSV, міграція 20261116090000.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const migration = read('supabase/migrations/20261116090000_registry_documents.sql');

function fnSource(name, isAsync) {
    const start = html.indexOf((isAsync ? 'async ' : '') + 'function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}
const constLine = (name) => {
    const start = html.indexOf('    const ' + name + ' = ');
    assert.ok(start > 0, name);
    return html.slice(start, html.indexOf(';\n', start) + 1);
};
const SYNC = ['historyCsvCell', 'kpDirectorActive', 'registryDocText', 'registryPayState', 'registryDocMatches', 'registryCanMarkPaid', 'registryDocActions', 'registryNeedsLocal',
    'registryNormalizeFilters', 'registryDefaultFilters', 'registryMonthRange', 'registryColumns', 'registryCellValue', 'registryCsv', 'registryRouteLabel', 'registryVehicleLabel'];
function world(extra = {}) {
    const ctx = vm.createContext({
        isKP: () => true, window: {}, currentOrgRole: 'owner', currentUserId: 'u1', currentWorkMode: 'solo', uiView: 'director', teamState: { members: [] },
        savedCalculations: [], historyTripVehicles: () => [], savedAuthorLabel: (id) => 'user:' + id, calls: [], console, ...extra,
    });
    vm.runInContext(['REGISTRY_STATUS_LABELS', 'REGISTRY_PAY_LABELS', 'REGISTRY_DOC_STATUS'].map(constLine).join('\n') + '\nlet registryDocs = {};\n'
        + SYNC.map((n) => fnSource(n)).join('\n') + '\n' + fnSource('registryLoadDocs', true), ctx);
    return ctx;
}
const run = (ctx, code) => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', ctx));
const doc = (kind, number, paid, status = 'issued') => ({ id: kind + number, kind, number: String(number), status, paid });
const ROW = { id: 'c1', registry_no: '2026-0001', status: 'accepted', user_id: 'u1', name: 'А — Б', route_from: 'Київ', route_to: 'Львів', client_name: 'ТОВ А', trip_date: '2026-11-03', distance_km: 100, revenue: 1000, profit: 100, fact_profit: null };

test('колонки «Договір / Рахунок / Акт / Оплата» є лише в Контроль+; на сайті таблиця й CSV без змін', () => {
    const kp = run(world(), 'registryColumns().map(c => c.key)');
    assert.deepEqual(kp.slice(-4), ['contract', 'invoice', 'act', 'pay']);
    const site = world({ isKP: () => false });
    assert.equal(run(site, 'registryColumns().map(c => c.key)').some((k) => ['contract', 'invoice', 'act', 'pay'].includes(k)), false);
    assert.deepEqual(run(site, 'registryColumns().map(c => c.key)'), ['no', 'date', 'route', 'client', 'vehicles', 'status', 'km', 'revenue', 'profit', 'fact']);
    const csvHead = (ctx) => vm.runInContext('registryCsv([])', ctx).replace('﻿', '').split('\r\n')[0];
    assert.ok(csvHead(world()).endsWith('Прибуток факт;Факт внесено;Договір;Рахунок;Акт;Оплата;Причина скасування'));
    assert.equal(csvHead(site).includes('Договір'), false);
    assert.equal(csvHead(site).includes('Оплата'), false);
    // Фільтри «Договір» і «Оплата» на сайті не діють і не вмикають локальний режим.
    assert.equal(run(site, 'registryNeedsLocal({ q: "", client: "", contract: "yes", pay: "paid" })'), false);
    assert.equal(run(world(), 'registryNeedsLocal({ q: "", client: "", contract: "yes", pay: "" })'), true);
    assert.equal(run(world(), 'registryNeedsLocal({ q: "", client: "", contract: "", pay: "unpaid" })'), true);
    // Розмітка: фільтри приховані, поки сторінка не в КП.
    assert.ok(html.includes('id="registry-contract" aria-label="Договір" onchange="registryFilterChanged()" hidden>'));
    assert.ok(html.includes('id="registry-pay" aria-label="Оплата" onchange="registryFilterChanged()" hidden>'));
    assert.match(fnSource('registryOpen', true), /el\.hidden = !isKP\(\)/);
});

test('значення колонок: договір, рахунок і акт (номер і статус), оплата — оплачено / не оплачено / частково; CSV містить ті самі колонки', () => {
    const ctx = world();
    const info = { contract_no: 'Д-1/2026', docs: [doc('invoice', 7, true), doc('act', 3, true), doc('act', 4, false), doc('act', 5, false, 'cancelled')] };
    vm.runInContext('registryDocs[' + JSON.stringify(ROW.id) + '] = ' + JSON.stringify(info), ctx);
    const cell = (key) => vm.runInContext('registryCellValue(' + JSON.stringify(ROW) + ', "' + key + '")', ctx);
    assert.equal(cell('contract'), 'Д-1/2026');
    assert.equal(cell('invoice'), '7 (виданий)');
    assert.equal(cell('act'), '3 (виданий), 4 (виданий), 5 (анульований)');
    assert.equal(cell('pay'), 'частково', 'один із двох актів не оплачено; анульований не рахується');
    const pay = (docs) => vm.runInContext('registryPayState(' + JSON.stringify({ docs }) + ')', ctx);
    assert.equal(pay([doc('invoice', 1, true), doc('act', 1, true)]), 'paid');
    assert.equal(pay([doc('invoice', 1, false), doc('act', 1, false)]), 'unpaid');
    assert.equal(pay([doc('invoice', 1, false, 'cancelled')]), '', 'лише анульовані — оплати немає');
    assert.equal(pay([]), '');
    const csv = vm.runInContext('registryCsv([' + JSON.stringify(ROW) + '])', ctx).replace('﻿', '').split('\r\n');
    const head = csv[0].split(';');
    const body = csv[1].split(';');
    const at = (title) => body[head.indexOf(title)];
    assert.deepEqual([at('Договір'), at('Рахунок'), at('Оплата')], ['Д-1/2026', '7 (виданий)', 'частково']);
    assert.equal(at('Акт'), '3 (виданий), 4 (виданий), 5 (анульований)');
});

test('фільтри «Договір» і «Оплата»: збереження в нормалізованих фільтрах і відбір рядків за завантаженими документами', () => {
    const ctx = world();
    assert.deepEqual(run(ctx, 'registryNormalizeFilters({ from: "", to: "", contract: "yes", pay: "partial" })'), { from: '', to: '', status: '', user: '', vehicle: '', client: '', contract: 'yes', pay: 'partial', q: '' });
    assert.deepEqual(run(ctx, 'registryNormalizeFilters({ from: "", to: "", contract: "x", pay: "?" })').contract, '');
    assert.equal(run(ctx, 'registryNormalizeFilters({ from: "", to: "", pay: "?" })').pay, '');
    vm.runInContext('registryDocs.a = { contract_no: "Д-1", docs: [' + JSON.stringify(doc('invoice', 1, true)) + '] }; registryDocs.b = { contract_no: null, docs: [' + JSON.stringify(doc('invoice', 2, false)) + '] }; registryDocs.c = { docs: [] };', ctx);
    const m = (id, f) => vm.runInContext('registryDocMatches({ id: "' + id + '" }, ' + JSON.stringify(f) + ')', ctx);
    assert.deepEqual(['a', 'b', 'c'].map((id) => m(id, { contract: 'yes', pay: '' })), [true, false, false]);
    assert.deepEqual(['a', 'b', 'c'].map((id) => m(id, { contract: 'no', pay: '' })), [false, true, true]);
    assert.deepEqual(['a', 'b', 'c'].map((id) => m(id, { contract: '', pay: 'paid' })), [true, false, false]);
    assert.deepEqual(['a', 'b', 'c'].map((id) => m(id, { contract: '', pay: 'unpaid' })), [false, true, false], 'без документів — не «не оплачено»');
    // Ключ localStorage лишається tc_registry_filters:<org>:<user>.
    assert.match(fnSource('registryStorageKey'), /REGISTRY_LEGACY_STORAGE_KEY \+ ':' \+ \(currentOrgId \|\| '-'\) \+ ':' \+ \(currentUserId \|\| '-'\)/);
});

test('дії рядка: «Створити рахунок / акт» або «Відкрити», оплата лише для тих, хто має право; директор КП не створює', () => {
    const labels = (ctx, row = ROW) => run(ctx, 'registryDocActions(' + JSON.stringify(row) + ').map(a => a.label)');
    const withDocs = (ctx, docs) => vm.runInContext('registryDocs.c1 = { docs: ' + JSON.stringify(docs) + ' }', ctx);
    const none = world();
    assert.deepEqual(labels(none), ['Створити рахунок', 'Створити акт'], 'документів немає');
    const part = world();
    withDocs(part, [doc('invoice', 1, false)]);
    assert.deepEqual(labels(part), ['Відкрити рахунок', 'Створити акт', 'Позначити оплаченим']);
    const full = world();
    withDocs(full, [doc('invoice', 1, true), doc('act', 1, true)]);
    assert.deepEqual(labels(full), ['Відкрити рахунок', 'Відкрити акт', 'Зняти оплату']);
    assert.deepEqual(run(full, 'registryDocActions(' + JSON.stringify(ROW) + ').find(a => a.kind === "pay")'), { kind: 'pay', doc: 'invoice1', paid: false, label: 'Зняти оплату' }, 'ціль — рахунок; сервер закриє всі акти');
    // Не КП, скасована заявка, чернетка — кнопок документів немає.
    assert.deepEqual(labels(world({ isKP: () => false })), []);
    assert.deepEqual(labels(world(), { ...ROW, status: 'cancelled' }), []);
    // Директор КП: відкриває й ставить оплату, але документи не створює.
    const director = world({ window: { tcKpRole: 'director' }, currentOrgRole: 'logist', teamState: { members: [] } });
    withDocs(director, [doc('invoice', 1, false)]);
    assert.deepEqual(labels(director), ['Відкрити рахунок', 'Позначити оплаченим']);
    // Логіст: оплата лише з правом на документи (can_acts).
    const logist = (acts) => { const c = world({ currentOrgRole: 'logist', teamState: { members: [{ id: 'u1', permissions: { acts } }] } }); withDocs(c, [doc('invoice', 1, false)]); return c; };
    assert.equal(labels(logist(true)).includes('Позначити оплаченим'), true);
    assert.equal(labels(logist(false)).includes('Позначити оплаченим'), false);
    assert.equal(vm.runInContext('registryCanMarkPaid()', world({ currentOrgRole: 'owner' })), true);
    // «Створити» веде в наявну форму документа заявки, «Відкрити» — в картку документа.
    assert.ok(html.includes("openCalcDoc(\\'' + a.docKind + '\\', \\'' + id + '\\')"));
    assert.match(fnSource('openRegistryDoc'), /'#\/docs\/' \+ encodeURIComponent\(docId\)/);
    assert.match(fnSource('registrySetPaid', true), /rpc\('registry_doc_set_paid', \{ p_doc: docId, p_paid: paid \}\)/);
});

test('завантаження документів: сторінка — по id рядків (≤200 за запит), без запиту на сайті, повторно не питає', async () => {
    const ctx = world({ supabaseClient: { rpc: async (name, args) => { ctx.calls.push({ name, args }); return { data: args.p_calcs.slice(0, 1).map((id) => ({ calculation_id: id, contract_no: 'Д', docs: [] })), error: null }; } } });
    const ids = Array.from({ length: 450 }, (_, i) => 'id' + i);
    await vm.runInContext('registryLoadDocs(' + JSON.stringify(ids) + ')', ctx);
    assert.deepEqual(ctx.calls.map((c) => [c.name, c.args.p_calcs.length]), [['registry_documents', 200], ['registry_documents', 200], ['registry_documents', 50]]);
    await vm.runInContext('registryLoadDocs(' + JSON.stringify(ids) + ')', ctx);
    assert.equal(ctx.calls.length, 3, 'уже завантажені не запитуються');
    assert.equal(run(ctx, 'Object.keys(registryDocs).length'), 450, 'заявка без відповіді отримує порожній запис');
    const site = world({ isKP: () => false, supabaseClient: { rpc: async () => { throw new Error('на сайті RPC документів не викликається'); } } });
    await vm.runInContext('registryLoadDocs(["a"])', site);
    assert.match(fnSource('registryLoad', true), /if \(isKP\(\)\) await registryLoadDocs\(/);
    assert.match(fnSource('registryFetchAll', true), /registryLoadDocs\(full\.rows/);
    assert.match(fnSource('registryExportCsv', true), /if \(isKP\(\)\) await registryLoadDocs\(rows/);
});

test('міграція: paid_at / paid_by, guard, registry_doc_set_paid (атомарно, права, зв\'язка за parent_id), registry_documents, відкат', () => {
    assert.ok(migration.startsWith('-- Apply manually after review. This file is not applied to production by the agent.'));
    for (const part of ['ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL', 'ADD COLUMN IF NOT EXISTS paid_by uuid NULL REFERENCES auth.users (id) ON DELETE SET NULL',
        "ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancelled_reason', 'paid_at', 'paid_by']",
        'CREATE OR REPLACE FUNCTION public.registry_doc_set_paid(p_doc uuid, p_paid boolean)', "v_root := CASE WHEN v_doc.kind = 'invoice' THEN v_doc.id ELSE v_doc.parent_id END;",
        '(d.id = v_root OR d.parent_id = v_root)', "d.status = 'issued'", 'FOR UPDATE', 'WHERE id = ANY (v_ids);', "RAISE EXCEPTION 'DOC_FORBIDDEN' USING ERRCODE = '42501';",
        "RAISE EXCEPTION 'PAYMENT_FORBIDDEN' USING ERRCODE = '42501';", "public.member_can('acts')", "v_role IS DISTINCT FROM 'director'", 'public.can_view_org(v_org)', "public.kp_docs_org('read')",
        'CREATE OR REPLACE FUNCTION public.registry_documents(p_calcs uuid[])', 'public.kp_trip_visible(c.user_id)', 'x.cancelled_at IS NULL',
        'GRANT EXECUTE ON FUNCTION public.registry_doc_set_paid(uuid, boolean) TO authenticated, service_role;']) assert.ok(migration.includes(part), part);
    assert.equal(/CREATE (OR REPLACE )?TRIGGER|CREATE POLICY|GRANT (UPDATE|INSERT|DELETE|ALL)/.test(migration.slice(migration.indexOf('\nBEGIN;\n'))), false, 'без тригерів (рекурсії немає) і без розширення RLS / прав таблиць');
    const head = migration.slice(migration.indexOf('-- РУЧНИЙ ВІДКАТ'), migration.indexOf('\nBEGIN;\n'));
    const at = (t) => { const i = head.indexOf(t); assert.ok(i >= 0, t); return i; };
    assert.ok(at('DROP FUNCTION IF EXISTS public.registry_doc_set_paid') < at('kp_documents_guard()'));
    assert.ok(at('kp_documents_guard()') < at('DROP COLUMN IF EXISTS paid_by'));
    const tap = read('supabase/tests/registry_documents.sql');
    assert.match(tap, /SELECT plan\(19\)/);
    assert.equal(tap.split('\n').filter((l) => /^SELECT is\(/.test(l)).length, 19);
});
