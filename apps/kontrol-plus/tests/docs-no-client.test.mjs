// Заявка без клієнта: замість глухого кута — блок «оберіть клієнта → привʼязати і продовжити» (спільний для ТТН, акта, рахунку, подорожнього листа).
// Сервер створює документи з заявки лише для привʼязаного клієнта (calculation_clients), тому привʼязка іде ДО підстановки й створення; БД не чіпаємо.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { linkCalcClient } from '../src/views/docs-link-client.js';

const APP = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), 'utf8');
const fakeApp = (result, calls = []) => ({
    supabase: { from: (table) => ({ insert: async (row) => { calls.push([table, row]); return result; } }) },
});

test('linking: insert into calculation_clients (the same path as client-card.js)', async () => {
    const calls = [];
    assert.equal(await linkCalcClient(fakeApp({ error: null }, calls), 'calc-1', 'client-1'), null);
    assert.deepEqual(calls, [['calculation_clients', { calculation_id: 'calc-1', client_id: 'client-1' }]]);
    assert.match(read('src/views/client-card.js'), /from\('calculation_clients'\)\s*\n?\s*\.insert\(\{ calculation_id: r\.calculation_id, client_id: clientId \}\)/);
});

test('linking failed: readable text (no rights → ask the owner), no throw', async () => {
    const forbidden = await linkCalcClient(fakeApp({ error: { message: 'CLIENT_LINK_FORBIDDEN', code: '42501' } }), 'c', 'k');
    assert.equal(forbidden, 'Немає права привʼязувати рейси, зверніться до власника.');
    const other = await linkCalcClient(fakeApp({ error: { message: 'boom' } }), 'c', 'k');
    assert.equal(typeof other, 'string');
    assert.ok(other.length > 0);
    const thrown = await linkCalcClient({ supabase: { from: () => { throw new Error('offline'); } } }, 'c', 'k');
    assert.equal(typeof thrown, 'string');
});

test('panel: shared component, success opens the normal form, failure shows the text and does not', () => {
    const picker = read('src/views/docs-link-client.js');
    const panel = picker.slice(picker.indexOf('export function linkClientPanel'));
    assert.match(panel, /У заявці не вказано клієнта\. Оберіть клієнта — його буде привʼязано до заявки\./);
    assert.match(panel, /'Привʼязати і продовжити'/);
    assert.match(panel, /href: '#\/docs\/new\/' \+ kind \}, 'Створити без заявки'/);
    assert.match(panel, /const failure = await linkCalcClient\(app, calcId, select\.value\);\s*if \(failure\) \{[^}]*return clear\(message, notice\(failure\)\);\s*\}\s*onLinked\(select\.value\);/);
    assert.doesNotMatch(picker, /alert\(|confirm\(/);
    assert.doesNotMatch(panel, /btn-block/);
    // Усі чотири форми беруть один компонент, а не копіюють його.
    for (const [file, kind] of [['docs-ttn-form.js', 'ttn'], ['docs-form.js', 'kind'], ['docs-ts-form.js', 'trip_sheet']]) {
        const code = read('src/views/' + file);
        assert.match(code, /import \{ linkClientPanel \} from '\.\/docs-link-client\.js'/, file);
        const kindArg = kind === 'kind' ? 'kind,' : "kind: '" + kind + "',";
        assert.ok(code.includes('linkClientPanel(app, { ' + kindArg + ' calcId: route.calc'), file);
        assert.match(code, /const load = async \(\) => \{/, file + ': форма перезавантажується після привʼязки');
    }
    assert.doesNotMatch(read('src/views/docs-ttn-form.js'), /У заявки немає клієнта\. Додайте клієнта/, 'no dead end');
});

test('forms: without a client the panel replaces the form; with it (or after linking) the usual prefilled form opens', () => {
    const ttn = read('src/views/docs-ttn-form.js');
    assert.match(ttn, /if \(!route\.client\) \{\s*clear\(root, back, linkClientPanel\(/);
    assert.match(ttn, /onLinked: \(client\) => \{ route = \{ \.\.\.route, client \}; clear\(root, spinner\(\)\); load\(\); \}/);
    const sheet = read('src/views/docs-ts-form.js');
    assert.match(sheet, /if \(!pre\.client\) \{\s*return clear\(root,[^]*linkClientPanel\(app, \{ kind: 'trip_sheet'[^]*onLinked: \(\) => \{ clear\(root, spinner\(\)\); load\(\); \}/);
    // Після привʼязки kp_calc_doc_prefill викликається знову (load), а не береться стара відповідь.
    assert.ok(sheet.indexOf("rpc('kp_calc_doc_prefill'") > sheet.indexOf('const load = async'));
    const doc = read('src/views/docs-form.js');
    assert.match(doc, /if \(route\.calc && !route\.client\) \{\s*clear\(root,[^]*linkClientPanel\(app, \{ kind, calcId: route\.calc/);
    // Форма ТТН і далі не зберігається без клієнта.
    assert.match(ttn, /if \(!clientSel\.value\) return clear\(message, notice\('Оберіть клієнта \(замовника\)\.'\)\);/);
});

test('picker: «no client» warning for every document type, without blocking the choice', () => {
    const picker = read('src/views/docs-request-picker.js');
    assert.match(picker, /if \(!row\.client_id\) toast\('У заявки немає клієнта — оберете його на наступному кроці', 'info'\);\s*app\.go\(requestDocHash\(/);
    assert.doesNotMatch(picker, /kind === 'invoice' \|\| kind === 'act'\) && !row\.client_id/);
});

test('layout: the new button is content-sized and the panel does not widen the page', () => {
    const css = read('src/crm.css');
    const rule = css.match(/#kp-crm \.kpd-page \.kpd-link-client \.actions > \.btn:not\(\.btn-block\) \{([^}]*)\}/);
    assert.ok(rule, 'rule for panel buttons');
    for (const part of [/justify-self: start/, /flex: 0 0 auto/, /width: auto/, /min-width: 0/]) assert.match(rule[1], part);
    assert.doesNotMatch(rule[1], /width: (100%|\d{3,}px)/, 'not wider than its content');
    assert.match(css, /#kp-crm \.kpd-link-client \{ display: grid; gap: 10px; max-width: 560px; \}/);
    assert.match(css, /#kp-crm \.kpd-link-client select \{ width: 100%; max-width: 100%; min-width: 0; \}/);
    // Блок лежить усередині .kpd-page: у ньому немає ні alert/confirm, ні .btn-block.
    assert.match(read('src/views/docs.js'), /kpd-page/);
});

// Статичні перевірки не ловлять ReferenceError: кожен хелпер ui.js, який викликає файл документів, має бути в його import з ../ui.js.
test('every ui.js helper called in the Documents views is imported there (no «notice is not defined»)', () => {
    const helpers = ['h', 'clear', 'spinner', 'notice', 'toast'];
    for (const file of fs.readdirSync(new URL('src/views/', APP)).filter((f) => /^docs.*\.js$/.test(f))) {
        const code = read('src/views/' + file);
        const imp = code.match(/import \{([^}]*)\} from '\.\.\/ui\.js'/);
        const imported = new Set(imp ? imp[1].split(',').map((x) => x.trim()) : []);
        for (const name of helpers) {
            const declared = new RegExp('(function|const|let) ' + name + '\\b').test(code);
            const called = new RegExp('(^|[^.\\w$])' + name + '\\(', 'm').test(code);
            if (called && !declared) assert.ok(imported.has(name), file + ': ' + name + '() is called but not imported from ui.js');
        }
    }
});
