// Документи на основі заявки: вкладки в URL, кнопки й фільтри вкладок, адреси форм, попередження про повтор, маршрут за варіантом директора,
// захист на сервері (міграція) і те, що форми справді мають вибір «На основі заявки».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCrmHash } from '../src/lib/route.js';
import {
    requestDocHash, duplicateWarning, withApprovedVariant, requestOptionLabel, filterRows, TAB_DOC_KIND,
} from '../src/lib/docs-requests.js';
import { tsFromPrefill } from '../src/lib/trip-sheet.js';

const APP = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), 'utf8');
const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '66666666-7777-4888-8999-000000000000';

test('tabs: ТТН | Акти | Рахунки | Подорожні листи live in the URL (F5 and Back keep them)', () => {
    const docs = read('src/views/docs.js');
    const labels = [...docs.slice(docs.indexOf('export function docsTabs()'), docs.indexOf('const TAB_KIND')).matchAll(/key: '([^']+)', hash: '([^']+)', label: '([^']+)'/g)];
    assert.deepEqual(labels.map((m) => m[3]), ['Усі', 'Договори', 'ТТН', 'Акти', 'Рахунки', 'Подорожні листи', 'Інше']);
    for (const [, key, hash] of labels) {
        if (key === 'all') continue;
        assert.deepEqual(parseCrmHash(hash), { view: 'docs', sub: 'list', tab: key }, hash + ' is a real route');
    }
    assert.deepEqual(TAB_DOC_KIND, { ttn: 'ttn', acts: 'act', invoices: 'invoice', trip_sheets: 'trip_sheet' });
    assert.equal(parseCrmHash('#/docs/tab/nope'), null);
    // Активна вкладка береться з маршруту; картки й форми підсвічують свою вкладку.
    assert.match(docs, /const currentKey = route\.tab \|\| cardTab \|\| 'all';/);
    assert.match(docs, /renderDocList\(app, access, TAB_KIND\[route\.tab\] \|\| '', route\.tab \|\| ''\)/);
});

test('tabs: each one has its own filters (period, client, status, number; vehicle / driver for waybills) and its own create button', () => {
    const docs = read('src/views/docs.js');
    assert.match(docs, /presetKind \? null : labeled\('Тип', kind\)/, 'a tab with a fixed kind has no type selector');
    assert.match(docs, /labeled\('Номер', number\)/);
    assert.match(docs, /\['ttn', 'trip_sheet'\]\.includes\(presetKind\) \? labeled\('Авто \/ водій', vehicle\)/);
    assert.match(docs, /filterRows\(\[/);
    const rows = [
        { number_text: 'АКТ-7', vehicle_reg: 'AA1111BB', driver_name: 'Петренко П.' },
        { number_text: 'АКТ-12', vehicle_reg: 'CC2222DD', driver_name: 'Іваненко І.' },
        { number: 5, prefix: 'Т-' },
    ];
    assert.equal(filterRows(rows, { number: '12' }).length, 1);
    assert.equal(filterRows(rows, { number: 'акт' }).length, 2, 'number search ignores case');
    assert.equal(filterRows(rows, { vehicle: 'aa1111' })[0].number_text, 'АКТ-7');
    assert.equal(filterRows(rows, { vehicle: 'іваненко' })[0].number_text, 'АКТ-12', 'by driver');
    assert.equal(filterRows(rows, { number: 'т-5' }).length, 1, 'prefix + number when there is no number_text');
    assert.equal(filterRows(rows, {}).length, 3);
});

test('create from a request: the right form address for every document type', () => {
    assert.equal(requestDocHash('ttn', ID), '#/docs/new/ttn/calc/' + ID);
    assert.equal(requestDocHash('trip_sheet', ID), '#/docs/new/trip_sheet/calc/' + ID);
    assert.equal(requestDocHash('act', ID, ID2), '#/docs/new/act/' + ID2 + '/' + ID);
    assert.equal(requestDocHash('invoice', ID, ID2), '#/docs/new/invoice/' + ID2 + '/' + ID);
    assert.equal(requestDocHash('act', ID), '#/docs/new/act/calc/' + ID, 'a request without a client: the form picks the client');
    assert.equal(requestDocHash('contract', ID), null);
    assert.equal(requestDocHash('ttn', null), null);
    // Кожна адреса розбирається маршрутизатором.
    assert.deepEqual(parseCrmHash('#/docs/new/act/calc/' + ID), { view: 'docs', sub: 'new', kind: 'act', client: null, calc: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/invoice/calc/' + ID), { view: 'docs', sub: 'new', kind: 'invoice', client: null, calc: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/ttn/calc/' + ID), { view: 'docs', sub: 'new', kind: 'ttn', client: null, calc: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/trip_sheet/calc/' + ID), { view: 'docs', sub: 'new', kind: 'trip_sheet', client: null, calc: ID });
    assert.deepEqual(parseCrmHash('#/docs/new/act/' + ID2 + '/' + ID), { view: 'docs', sub: 'new', kind: 'act', client: ID2, calc: ID });
    assert.equal(parseCrmHash('#/docs/new/act/calc/not-a-uuid'), null);
});

test('create from a request: all four forms have «На основі заявки» and the documents of the request; invoice / act take the client from the request', () => {
    for (const [file, kind] of [['docs-form.js', 'kind'], ['docs-ttn-form.js', "'ttn'"], ['docs-ts-form.js', "'trip_sheet'"]]) {
        const code = read('src/views/' + file);
        assert.match(code, new RegExp('requestPicker\\(app, ' + kind + ', \\{ current: route\\.calc \\}\\)'), file);
        assert.match(code, new RegExp('requestDocsNotice\\(app, ' + kind + ', route\\.calc\\)'), file);
    }
    assert.match(read('src/views/docs-form.js'), /from\('calculation_clients'\)\.select\('client_id'\)\.eq\('calculation_id', route\.calc\)/);
    const picker = read('src/views/docs-request-picker.js');
    assert.match(picker, /rpc\('kp_calc_accepted_list'/, 'only saved and accepted requests are offered');
    assert.match(picker, /rpc\('kp_calc_documents'/);
    assert.match(picker, /app\.go\(requestDocHash\(kind, row\.calculation_id, row\.client_id\)\)/);
    assert.match(picker, /event\.key === 'Enter'\) event\.preventDefault\(\)/, 'Enter in the search box does not submit the form');
    assert.doesNotMatch(picker, /innerHTML|style:\s*['"]/);
    assert.equal(requestOptionLabel({ name: 'Рейс 1', trip_date: '2026-10-20', route_from: 'Луцьк', route_to: 'Одеса', client_name: 'Агро' }, (d) => d), '2026-10-20 · Рейс 1 · Луцьк — Одеса · Агро');
    assert.equal(requestOptionLabel({}, (d) => d), 'Заявка');
});

test('create from a request: a repeat is a warning, not a ban', () => {
    const docs = [
        { kind: 'act', number_text: 'АКТ-7', status: 'issued' },
        { kind: 'act', number_text: 'АКТ-3', status: 'cancelled' },
        { kind: 'ttn', number_text: '15', status: 'issued' },
    ];
    assert.equal(duplicateWarning('act', docs), 'Вже є акт № АКТ-7. Створити ще один?', 'a cancelled act does not count');
    assert.equal(duplicateWarning('ttn', docs), 'Вже є ТТН № 15. Створити ще один?');
    assert.equal(duplicateWarning('invoice', docs), '');
    assert.equal(duplicateWarning('trip_sheet', []), '');
    // Попередження лише інформує: форма не блокує відправку.
    assert.doesNotMatch(read('src/views/docs-request-picker.js'), /disabled|submit\.disabled|return false/);
});

test('route from the request: the variant picked by the director wins over the logist one', () => {
    const pre = {
        route: { from: 'Луцьк', to: 'Одеса', dist_km: 815, feed_km: 40, variant: { index: 0 }, approved_variant: { index: 1, km: 844, podachaKm: 55, logistIndex: 0 } },
        cargo: { tonnage: 22 }, dates: { trip_date: '2026-10-28', days: 2 },
    };
    const eff = withApprovedVariant(pre);
    assert.equal(eff.route.dist_km, 844);
    assert.equal(eff.route.feed_km, 55);
    assert.equal(eff.route.variant_source, 'director');
    assert.equal(pre.route.dist_km, 815, 'the input is not mutated');
    const sheet = tsFromPrefill(eff, '2026-10-28');
    assert.equal(sheet.task.loaded_km, '844', 'trip sheet: loaded km from the director variant');
    assert.equal(sheet.task.planned_km, '899', 'trip sheet: planned km = loaded + feed of the director variant');
    // Без вибору директора або з порожнім км — як було.
    const plain = { route: { dist_km: 500, feed_km: 40 } };
    assert.equal(withApprovedVariant(plain), plain);
    assert.equal(withApprovedVariant({ route: { dist_km: 500, approved_variant: { km: 0 } } }).route.dist_km, 500);
    assert.equal(withApprovedVariant({ route: { dist_km: 500, approved_variant: { index: 1 } } }).route.dist_km, 500);
    assert.equal(withApprovedVariant(null), null);
    for (const file of ['docs-ttn-form.js', 'docs-ts-form.js']) assert.match(read('src/views/' + file), /withApprovedVariant\(res\.data\)/, file);
});

test('server: the migration lists accepted requests, links documents to requests and refuses non-accepted ones', () => {
    const sql = read('../../supabase/migrations/20261104090000_kp_docs_from_requests.sql');
    assert.match(sql, /^-- Apply manually after review\. This file is not applied to production by the agent\./);
    assert.match(sql, /РУЧНИЙ ВІДКАТ/);
    assert.match(sql, /c\.status IN \('accepted', 'done'\)/);
    assert.match(sql, /kp_docs_org\('write'\)/, 'only roles that can write documents pick a source');
    assert.match(sql, /c\.org_id = v_org/, 'own organisation only');
    assert.match(sql, /RAISE EXCEPTION 'CALC_NOT_ACCEPTED'/);
    assert.match(sql, /RAISE EXCEPTION 'DOC_TRIP_FORBIDDEN'/);
    assert.match(sql, /BEFORE INSERT ON public\.kp_document_lines/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.kp_calc_accepted_list\(text\) FROM PUBLIC, anon, authenticated, service_role/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|UPDATE public\./, 'existing data is not touched');
    assert.match(read('src/lib/docs.js'), /CALC_NOT_ACCEPTED/, 'readable error text');
});

test('layout: compact tabs, buttons by text size, full width only through .btn-block', () => {
    const css = read('src/crm.css');
    assert.match(css, /#kp-crm \.kpr-tabs \{ display: flex; gap: 4px; flex-wrap: wrap;/, 'tabs wrap, they are not stretched');
    assert.match(css, /#kp-crm \.kpd-req \.kpd-req-select \{ width: auto; max-width: min\(100%, 460px\)/);
    assert.match(css, /@media \(max-width: 560px\) \{\n    #kp-crm \.kpr-tab \{ padding: 6px 10px; \}/);
    for (const file of ['docs-request-picker.js', 'docs.js']) assert.doesNotMatch(read('src/views/' + file), /btn-block/, file);
});

test('«← До документів» leads back to the tab the user came from (default: the tab of the document kind)', async () => {
    const { docsBackHash, rememberDocsList } = await import('../src/lib/docs-requests.js');
    rememberDocsList(null);
    assert.equal(docsBackHash('act'), '#/docs/tab/acts');
    assert.equal(docsBackHash('invoice'), '#/docs/tab/invoices');
    assert.equal(docsBackHash('ttn'), '#/docs/tab/ttn');
    assert.equal(docsBackHash('trip_sheet'), '#/docs/tab/trip_sheets');
    rememberDocsList('#/docs/tab/invoices');
    assert.equal(docsBackHash('ttn'), '#/docs/tab/invoices', 'the remembered tab wins');
    rememberDocsList('#/docs');
    assert.equal(docsBackHash('act'), '#/docs', 'came from «Усі»');
    rememberDocsList('https://evil.example/');
    assert.equal(docsBackHash('act'), '#/docs/tab/acts', 'only #/docs… addresses are remembered');
    for (const file of ['docs-card.js', 'docs-form.js', 'docs-ttn-card.js', 'docs-ttn-form.js', 'docs-ts-card.js', 'docs-ts-form.js']) {
        const code = read('src/views/' + file);
        assert.match(code, /docsBackHash\(/, file);
        assert.doesNotMatch(code, /class: 'back', href: '#\/docs'/, file + ': no fixed link to #/docs');
    }
    assert.match(read('src/views/docs.js'), /if \(sub === 'list'\) rememberDocsList\(route\.tab \? '#\/docs\/tab\/' \+ route\.tab : '#\/docs'\)/);
});

test('buttons in Documents are content-sized, even the one in the waybill form on 390px', () => {
    const css = read('src/crm.css');
    assert.match(css, /#kp-crm \.kpd-page \.btn:not\(\.btn-block\), #kp-crm \.kpd-page button\.btn:not\(\.btn-block\) \{ flex: 0 0 auto; width: auto; min-width: 0; \}/);
    assert.match(css, /#kp-crm \.kpd-page \.kpr-cards td \.actions > :not\(\.btn-block\) \{ flex: 0 0 auto; \}/);
    assert.match(css, /#kp-crm \.btn-block \{ width: 100%; \}/, 'full width only through .btn-block');
    const ttn = read('src/views/docs-ttn-form.js');
    assert.match(ttn, /class: 'btn btn-sm kpt-fill', onclick: fill }, 'Заповнити завантаження масами з форми'/);
    assert.match(ttn, /class: 'btn btn-sm btn-ghost kpt-line-del'/);
    // Обидві кнопки лежать у grid (.kpd-form, .kpt-line-main): без justify-self вони розтягуються на всю клітинку (1068px / 300px / 138px).
    const fillRule = css.match(/#kp-crm .kpd-page .kpt-fill {([^}]*)}/);
    assert.ok(fillRule, 'правило .kpt-fill');
    for (const part of [/justify-self: start/, /align-self: start/, /width: auto/, /flex: 0 0 auto/]) assert.match(fillRule[1], part);
    const delRule = css.match(/#kp-crm .kpd-page .kpt-line-del {([^}]*)}/);
    assert.ok(delRule, 'правило .kpt-line-del');
    for (const part of [/justify-self: start/, /width: 30px/, /flex: 0 0 auto/]) assert.match(delRule[1], part);
    assert.doesNotMatch(delRule[1] + fillRule[1], /width: (100%|d{3,}px)/, 'не ширші за вміст');
    for (const file of fs.readdirSync(new URL('src/views/', APP)).filter((f) => /^docs.*\.js$/.test(f))) {
        const code = read('src/views/' + file);
        for (const m of code.matchAll(/class: '([^']*btn-block[^']*)'/g)) assert.fail(file + ': .btn-block in Documents: ' + m[1]);
    }
});
