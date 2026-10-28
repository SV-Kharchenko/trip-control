import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { navTopPx } from '../src/bridge.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const css = read('src/crm.css');
const bridge = read('src/bridge.js');

test('меню стартує під шапкою: висота шапки рахується одразу, після першого кадру і через ResizeObserver', () => {
    assert.equal(navTopPx(86.4), 86);
    assert.equal(navTopPx(0), 0);
    assert.equal(navTopPx(-40), 0, 'шапка пролистана геть — меню біля верху вікна');
    assert.equal(navTopPx(undefined), 0);
    assert.equal(navTopPx('abc'), 0);
    const watch = bridge.slice(bridge.indexOf('function watchHeader()'), bridge.indexOf('// Кнопки «Калькулятор»'));
    assert.match(watch, /syncNavTop\(\);\s+if \(typeof requestAnimationFrame === 'function'\) requestAnimationFrame\(syncNavTop\);/);
    assert.match(watch, /new ResizeObserver\(syncNavTop\)\.observe\(head\)/);
    assert.match(bridge, /function syncNav\(\) \{\n    syncNavTop\(\);/, 'і при зміні маршруту');
    assert.match(bridge, /\n    watchHeader\(\);\n/);
});

test('«Держномер»: поле type=text без нативного хрестика, лишається власний «×»', () => {
    const view = read('src/views/registry.js');
    assert.match(view, /h\('input', \{ type: 'text', id: cfg\.id \+ '-q'/);
    assert.equal(/type: 'search'/.test(view), false);
    assert.match(view, /class: 'kpf-clear'/);
});

test('реквізити: одна кнопка «Зберегти» звичайної ширини справа, «Підпис і печатка» всередині картки в тому ж grid', () => {
    const source = read('src/views/docs-requisites.js');
    assert.equal((source.match(/type: 'submit'/g) || []).length, 1);
    assert.match(source, /h\('button', \{ type: 'submit', class: 'btn btn-primary' \}, 'Зберегти'\)/);
    assert.match(source, /card\.insertBefore\(group, anchor\)/);
    assert.match(source, /class: 'field kpr-asset'/);
    assert.equal(/grid-2/.test(source), false, 'окремих карток підпису / печатки більше немає');
    assert.match(css, /\.kpr-req \.form \.actions \.btn \{ width: auto; flex: 0 0 auto; \}/);
    assert.match(css, /\.kpr-req \.form \.actions \{ justify-content: flex-end;/);
    assert.match(css, /\.kpr-req \.kpr-asset \{ display: grid; grid-template-columns: 160px auto;/);
});

test('документи: фільтри компактні inline, кнопки створення лише раз угорі, у порожньому стані — підказка', () => {
    const docs = read('src/views/docs.js');
    assert.equal((docs.match(/createButtonsFor\(tab\)\.length \? h\('div'/g) || []).length, 1, 'панель кнопок створення — один раз угорі');
    const empty = docs.slice(docs.indexOf('if (!rows.length) {'), docs.indexOf('const totals = listTotals(rows);'));
    assert.equal(/createButtons\(|h\('a', \{ class: 'btn/.test(empty), false, 'кнопок створення в порожньому стані немає');
    assert.match(empty, /Створіть документ кнопками вгорі/);
    assert.match(docs, /const labeled = \(text, control\) => h\('label', \{ class: 'kpd-f' \}, h\('span', null, text\), control\);/);
    assert.match(docs, /h\('div', \{ class: 'toolbar kpd-filters' \}, labeled\('Період з', from\)/);
    assert.match(css, /\.kpd-f input \{ width: 150px; flex: 0 0 auto; \}/);
    assert.match(css, /\.kpd-f select \{ width: auto; max-width: 200px;/);
});

test('заголовок звіту — «План/факт» (як у меню)', () => {
    const report = read('src/views/report.js');
    assert.equal((report.match(/h\('h1', null, 'План\/факт'\)/g) || []).length, 2);
    assert.equal(/h\('h1', null, 'Звіт план\/факт'\)/.test(report), false);
});

test('шапка сайту в кабінеті: без «Калькулятор» / «Заявки» / «Огляд»; вони — у лівому меню і вкладках «Розрахунків»', () => {
    assert.match(css, /body\.kp-nav-on #studio-nav-calc, body\.kp-nav-on #studio-nav-overview, body\.kp-nav-on #studio-nav-history, body\.kp-nav-on \.tc-studio-nav \{ display: none !important; \}/);
    assert.match(css, /@media \(min-width: 901px\) \{\s+body\.kp-nav-on\.layout-studio \.tc-topbar \{ flex-wrap: nowrap; \}/);
    assert.match(bridge, /id: 'kp-calc-tab-calc', onclick: openSite\('calc'\) \}, 'Розрахунок'\)/);
    assert.match(bridge, /id: 'kp-calc-tab-history', onclick: openSite\('history'\) \}, 'Заявки'\)/);
    assert.match(css, /\.kp-calc-tabs \{ display: none;/);
    assert.match(css, /body\.kp-nav-on\[data-studio-view="history"\]:not\(\[data-kp-view\]\) \.kp-calc-tabs/);
});

test('статистика: значення KPI не переносяться', () => {
    assert.match(css, /\.kps-tile b \{ white-space: nowrap; font-size: clamp\(15px, 0\.9vw \+ 8px, 22px\); \}/);
    assert.match(css, /\.kps-tiles \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 150px\), 1fr\)\); \}/);
    assert.match(read('src/views/stats.js'), /'Дохід на км'/);
    assert.match(read('src/views/stats.js'), /' грн\/км'/);
});

test('вкладки «Розрахунок / Заявки» вставляються одразу після шапки, над калькулятором', async () => {
    const { insertAfterHeader } = await import('../src/bridge.js');
    const calls = [];
    const main = { insertBefore: (node, ref) => calls.push([node, ref]) };
    const root = { name: 'kp-crm' };
    const afterHeader = { name: 'tc-kpi-bar-or-columns' };
    insertAfterHeader(main, 'tabs', { nextSibling: afterHeader }, root);
    assert.deepEqual(calls[0], ['tabs', afterHeader], 'перед тим, що йде за шапкою (#studio-columns / KPI-смуга), а не після калькулятора');
    insertAfterHeader(main, 'tabs', null, root);
    assert.deepEqual(calls[1], ['tabs', root], 'без шапки — старе місце перед #kp-crm');
    assert.match(bridge, /insertAfterHeader\(main, calcTabs, document\.getElementById\('sticky-top'\), root\);/);
    assert.equal(/main\.insertBefore\(calcTabs, root\)/.test(bridge), false);
});

test('історія заявок і огляд мають той самий бічний відступ від меню, що й калькулятор', () => {
    assert.match(css, /body\.kp-nav-on\.layout-studio #main-app \{ max-width: none !important; margin-left: 0 !important; margin-right: 0 !important; padding-left: calc\(var\(--kp-nav-w, 224px\) \+ var\(--kp-gap, 24px\)\) !important;/);
    assert.match(css, /body\.kp-nav-on\.layout-studio #sticky-top \{ margin-left: calc\(-1 \* \(var\(--kp-nav-w, 224px\) \+ var\(--kp-gap, 24px\)\)\) !important;/);
    assert.match(bridge, /\}\)\.observe\(document\.body, \{ attributes: true, attributeFilter: \['data-studio-view', 'data-theme'\] \}\);\n    syncNav\(\);\n    return true;/, 'підсвітка при першому рендері');
    assert.match(bridge, /leave\(\);\n        syncNav\(\);\n    \}\)/, 'syncNav після кожної зміни розділу сайту');
});
