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
    const view = read('src/views/fleet.js');
    assert.match(view, /h\('input', \{ type: 'text', id: 'kpf-plate'/);
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
    assert.equal((docs.match(/createButtons\(\)/g) || []).length, 1, 'createButtons() викликається один раз');
    const empty = docs.slice(docs.indexOf('if (!rows.length) {'), docs.indexOf('const totals = listTotals(rows);'));
    assert.equal(/createButtons|btn-primary/.test(empty), false);
    assert.match(empty, /Створіть рахунок, акт або ТТН кнопками вгорі/);
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

test('шапка сайту в кабінеті: без «Калькулятор» / «Історія заявок» / «Огляд»; вони — у лівому меню і вкладках «Розрахунків»', () => {
    assert.match(css, /body\.kp-nav-on #studio-nav-calc, body\.kp-nav-on #studio-nav-overview, body\.kp-nav-on #studio-nav-history, body\.kp-nav-on \.tc-studio-nav \{ display: none !important; \}/);
    assert.match(css, /@media \(min-width: 901px\) \{\s+body\.kp-nav-on\.layout-studio \.tc-topbar \{ flex-wrap: nowrap; \}/);
    assert.match(bridge, /id: 'kp-calc-tab-calc', onclick: openSite\('calc'\) \}, 'Розрахунок'\)/);
    assert.match(bridge, /id: 'kp-calc-tab-history', onclick: openSite\('history'\) \}, 'Історія заявок'\)/);
    assert.match(css, /\.kp-calc-tabs \{ display: none;/);
    assert.match(css, /body\.kp-nav-on\[data-studio-view="history"\]:not\(\[data-kp-view\]\) \.kp-calc-tabs/);
});

test('статистика: значення KPI не переносяться', () => {
    assert.match(css, /\.kps-tile b \{ white-space: nowrap; font-size: clamp\(15px, 0\.9vw \+ 8px, 22px\); \}/);
    assert.match(css, /\.kps-tiles \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 150px\), 1fr\)\); \}/);
    assert.match(read('src/views/stats.js'), /'Дохід на км'/);
    assert.match(read('src/views/stats.js'), /' грн\/км'/);
});
