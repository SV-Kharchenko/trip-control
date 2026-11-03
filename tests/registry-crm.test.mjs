// «Реєстр заявок» у CRM-стилі (Контроль+, PR 2 з 5): колонки, CSV «як на екрані / усі», підсумковий рядок, швидкі статуси; сайт без змін.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('apps/kontrol-plus/src/kp-registry.css');

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
const FUNCS = ['historyCsvCell', 'kpDirectorActive', 'registryDocText', 'registryPayState', 'registryRouteLabel', 'registryVehicleLabel', 'registryColumns', 'registryCellValue',
    'registryFactHtml', 'registryCsv', 'registryColsStorageKey', 'registryColsState', 'registryColsSave', 'registryVisibleColumns', 'registryToggleCol', 'registrySetCsvMode',
    'registryDocLinks', 'registryContractLink', 'registryKpCell', 'registryKpTfoot', 'registryKpSyncQuick', 'registryColsPaint', 'registryQuickStatus'];

function world({ kp = true, team = false, extra = {} } = {}) {
    const store = new Map();
    const foot = { innerHTML: '', removed: false, remove() { this.removed = true; } };
    const table = { tFoot: null, createTFoot() { this.tFoot = foot; return foot; } };
    const els = { 'registry-table': table };
    const ctx = vm.createContext({
        isKP: () => kp, window: {}, currentOrgRole: 'owner', currentOrgId: 'org1', currentUserId: 'u1', currentWorkMode: team ? 'team' : 'solo', uiView: 'director',
        teamState: { members: [] }, savedCalculations: [], historyTripVehicles: () => [], savedAuthorLabel: (id) => 'user:' + id, console, store, foot, table,
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
        document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
        escHtml: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        formatHistoryDate: (v) => String(v), formatHistoryNum: (v, d) => Number(v).toFixed(d), registryRender: () => { ctx.renders = (ctx.renders || 0) + 1; }, ...extra,
    });
    vm.runInContext(['REGISTRY_STATUS_LABELS', 'REGISTRY_PAY_LABELS', 'REGISTRY_DOC_STATUS', 'KP_REGISTRY_COLS_KEY', 'KP_REGISTRY_COL_KEYS'].map(constLine).join('\n')
        + '\nlet registryDocs = {}; let registryKpCols = null; let registryKpColsKey = null;\n' + FUNCS.map((n) => fnSource(n)).join('\n'), ctx);
    return ctx;
}
const run = (ctx, code) => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', ctx));
const ROW = { id: 'c1', registry_no: '2026-0001', status: 'accepted', user_id: 'u1', name: 'А — Б', route_from: 'Київ', route_to: 'Львів', client_name: 'ТОВ А', trip_date: '2026-11-03', distance_km: 540, revenue: 50000, profit: 12000, fact_profit: 13500 };
const money = (n) => String(n);
const csvOf = (ctx, mode) => vm.runInContext('registryCsv([' + JSON.stringify(ROW) + ']' + (mode ? ', "' + mode + '"' : '') + ')', ctx).replace('﻿', '').split('\r\n');

test('сайт: реєстр без змін — колонки, CSV, розмітка (нічого з CRM-вигляду не виконується)', () => {
    const site = world({ kp: false });
    assert.deepEqual(run(site, 'registryColumns().map(c => c.key)'), ['no', 'date', 'route', 'client', 'vehicles', 'status', 'km', 'revenue', 'profit', 'fact']);
    assert.deepEqual(run(site, 'registryVisibleColumns(registryColumns()).map(c => c.key)'), ['no', 'date', 'route', 'client', 'vehicles', 'status', 'km', 'revenue', 'profit', 'fact'], 'на сайті колонки не ховаються');
    // Навіть із «схованими» колонками в localStorage сайт показує все й експортує все.
    vm.runInContext('store.set("tc_kp_registry_cols:org1:u1", JSON.stringify({ hidden: ["km", "revenue"], csv: "screen" }))', site);
    assert.equal(run(site, 'registryVisibleColumns(registryColumns()).length'), 10);
    assert.ok(csvOf(site)[0].startsWith('№ реєстру;Дата рейсу;Маршрут;Клієнт;Авто;Статус;Км;Виручка;Прибуток план;Прибуток факт;Факт внесено;Причина скасування'));
    // Статична розмітка секції реєстру не містить жодного елемента CRM-вигляду: їх створює JS лише при isKP().
    const section = html.slice(html.indexOf('<section class="card" id="registry-section"'), html.indexOf('<div class="card" id="saved-section"'));
    for (const marker of ['kp-reg', 'registry-quick', 'registry-cols', 'registry-csv-mode', 'registry-tfoot']) assert.equal(section.includes(marker), false, marker + ' не у розмітці сайту');
    // Усі CRM-гілки в registryRender і registryOpen — за isKP().
    const render = fnSource('registryRender');
    assert.match(render, /if \(isKP\(\)\) \{\s+registryKpSyncQuick\(\);/);
    assert.match(render, /if \(isKP\(\)\) return registryKpCell\(row, c, money, money0\);/);
    assert.match(render, /\(isKP\(\) \? ' data-col="' \+ c\.key \+ '"' : ''\)/);
    assert.match(fnSource('registryOpen', true), /if \(isKP\(\)\) \{\s+registryKpEnhance\(\);/);
    assert.match(fnSource('registryVisibleColumns'), /if \(!isKP\(\)\) return columns;/);
    assert.match(fnSource('registryCsv'), /isKP\(\) && \(mode \|\| registryColsState\(\)\.csv\) !== 'all'/);
});

test('КП: панель фільтрів (швидкі статуси, «Колонки», режим CSV) і підсумковий рядок створюються JS-ом, стилі лише під body.kp-shell-on', () => {
    const enhance = fnSource('registryKpEnhance');
    for (const part of ["quick.id = 'registry-quick'", "KP_REGISTRY_QUICK.map", 'id="registry-cols-btn"', 'id="registry-cols-menu"', "mode.id = 'registry-csv-mode'", 'CSV: як на екрані', 'CSV: усі колонки',
        "section.classList.add('kp-reg')"]) assert.ok(enhance.includes(part), part);
    assert.match(constLine('KP_REGISTRY_QUICK'), /\['', 'Усі'\], \['accepted', 'Активні'\], \['done', 'Виконані'\], \['cancelled', 'Скасовані'\]/);
    // Швидкі кнопки лише пишуть у наявний select і кличуть наявний registryFilterChanged (логіка й ключ tc_registry_filters:<org>:<user> без змін).
    assert.match(fnSource('registryQuickStatus'), /el\.value = value;\s+registryFilterChanged\(\);/);
    assert.match(fnSource('registryStorageKey'), /REGISTRY_LEGACY_STORAGE_KEY \+ ':' \+ \(currentOrgId \|\| '-'\) \+ ':' \+ \(currentUserId \|\| '-'\)/);
    // Підсумковий рядок: ті самі значення, що registryState.totals (registry_totals), підпис «факт у N з M».
    const ctx = world();
    const t = { count: 12, cancelled: 2, revenue: 600000, profit_plan: 140000, profit_fact: 150000, fact_count: 9, distance: 6400 };
    const cols = vm.runInContext('registryVisibleColumns(registryColumns())', ctx);
    vm.runInContext('registryKpTfoot(registryVisibleColumns(registryColumns()), ' + JSON.stringify(t) + ', (n) => String(n))', ctx);
    const foot = ctx.foot.innerHTML;
    assert.match(foot, /^<tr class="kp-reg-total">/);
    assert.ok(foot.includes('Разом: 12') && foot.includes('скасованих: 2'));
    assert.ok(foot.includes('<b>6400</b>') && foot.includes('<b>600000</b>') && foot.includes('<b>140000</b>') && foot.includes('<b>150000</b>'));
    assert.ok(foot.includes('факт у 9 з 12'));
    assert.equal((foot.match(/<td/g) || []).length, cols.length + 1, 'комірка на кожну видиму колонку + «Дії»');
    // Немає даних → підсумок прибирається.
    ctx.table.tFoot = ctx.foot;
    vm.runInContext('registryKpTfoot(registryVisibleColumns(registryColumns()), null, (n) => String(n))', ctx);
    assert.equal(ctx.foot.removed, true);
    // Стилі лише під body.kp-shell-on; мобільна версія (≤720px) не чіпається.
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((r) => r && !r.startsWith('@'));
    for (const list of rules) for (const sel of list.split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(sel.startsWith('body.kp-shell-on'), 'правило без області КП: ' + sel);
    assert.match(css, /@media \(min-width: 721px\)/);
    for (const part of ['position: sticky; top: 0', 'bottom: 0', 'height: 28px', 'JetBrains Mono', '.kp-fact.is-ok', '.kp-fact.is-low', 'nth-child(even)', 'flex-wrap: nowrap']) assert.ok(css.includes(part), part);
    assert.match(read('apps/kontrol-plus/src/site-bridge.js'), /import '\.\/kp-registry\.css';/);
    assert.equal(html.includes('kp-registry.css'), false, 'сайт стилі CRM не підключає');
});

test('колонки: «Колонки» ховає й показує, стан у tc_kp_registry_cols:<org>:<user>; «№ реєстру» сховати не можна', () => {
    const ctx = world();
    assert.equal(run(ctx, 'registryColsStorageKey()'), 'tc_kp_registry_cols:org1:u1');
    assert.deepEqual(run(ctx, 'registryColsState()'), { hidden: [], csv: 'screen' }, 'за замовчуванням усе видно, CSV як на екрані');
    vm.runInContext('registryToggleCol("km", false); registryToggleCol("fact", false); registryToggleCol("no", false); registryToggleCol("bogus", false)', ctx);
    assert.deepEqual(run(ctx, 'registryColsState().hidden'), ['km', 'fact']);
    assert.equal(ctx.renders, 2, 'таблиця перемальовується лише при зміні (№ реєстру й невідомі ключі ігноруються)');
    assert.deepEqual(JSON.parse(ctx.store.get('tc_kp_registry_cols:org1:u1')), { hidden: ['km', 'fact'], csv: 'screen' });
    assert.equal(run(ctx, 'registryVisibleColumns(registryColumns()).map(c => c.key).includes("km")'), false);
    vm.runInContext('registryToggleCol("km", true)', ctx);
    assert.deepEqual(run(ctx, 'registryColsState().hidden'), ['fact']);
    // Стан читається з localStorage (інша сесія), сміття відкидається.
    const again = world();
    again.store.set('tc_kp_registry_cols:org1:u1', JSON.stringify({ hidden: ['pay', 'no', 'xx', 5], csv: 'all' }));
    assert.deepEqual(run(again, 'registryColsState()'), { hidden: ['pay'], csv: 'all' });
    const broken = world();
    broken.store.set('tc_kp_registry_cols:org1:u1', '{не json');
    assert.deepEqual(run(broken, 'registryColsState()'), { hidden: [], csv: 'screen' });
    // Меню: чекбокс на кожну колонку, «№ реєстру» заблоковано.
    assert.match(fnSource('registryColsPaint'), /\(c\.key === 'no' \? ' disabled' : ''\)/);
    // Окремий стан для іншої пари компанія / користувач.
    const other = world({ extra: { currentOrgId: 'org2', currentUserId: 'u9' } });
    assert.equal(run(other, 'registryColsStorageKey()'), 'tc_kp_registry_cols:org2:u9');
});

test('CSV: «як на екрані» — лише видимі колонки (сховані не потрапляють), «усі» — усі колонки; на сайті завжди всі', () => {
    const ctx = world();
    const all = csvOf(ctx, 'all')[0].split(';');
    assert.deepEqual(all.slice(-5), ['Договір', 'Рахунок', 'Акт', 'Оплата', 'Причина скасування']);
    vm.runInContext('registryToggleCol("km", false); registryToggleCol("revenue", false); registryToggleCol("fact", false); registryToggleCol("contract", false)', ctx);
    const screen = csvOf(ctx, 'screen');
    const head = screen[0].split(';');
    for (const hidden of ['Км', 'Виручка', 'Прибуток факт', 'Факт внесено', 'Договір']) assert.equal(head.includes(hidden), false, hidden + ' не в CSV «як на екрані»');
    for (const shown of ['№ реєстру', 'Дата рейсу', 'Маршрут', 'Клієнт', 'Авто', 'Статус', 'Прибуток план', 'Рахунок', 'Акт', 'Оплата', 'Причина скасування']) assert.ok(head.includes(shown), shown);
    assert.equal(screen[1].split(';').length, head.length, 'рядки даних відповідають шапці');
    // Без аргумента береться вибір зі стану (за замовчуванням «як на екрані»), «усі» повертає сховані колонки.
    assert.deepEqual(csvOf(ctx)[0].split(';'), head);
    vm.runInContext('registrySetCsvMode("all")', ctx);
    assert.deepEqual(csvOf(ctx)[0].split(';'), all, 'режим «усі»: сховані колонки повертаються');
    assert.deepEqual(JSON.parse(ctx.store.get('tc_kp_registry_cols:org1:u1')).csv, 'all');
    vm.runInContext('registrySetCsvMode("screen")', ctx);
    assert.equal(csvOf(ctx)[0].includes('Км'), false);
    // Логіст (team) і колонка «Логіст»: ховається так само.
    const team = world({ team: true });
    vm.runInContext('registryToggleCol("user", false)', team);
    assert.equal(csvOf(team)[0].split(';').includes('Логіст'), false);
    assert.equal(csvOf(team, 'all')[0].split(';').includes('Логіст'), true);
    // «Факт внесено» залежить від колонки факту.
    const factOn = world();
    assert.ok(csvOf(factOn)[0].split(';').includes('Факт внесено'));
});

test('комірки КП: моно-клас, суми праворуч, план сірим курсивом, факт жирний зелений / червоний, документи посиланнями, відсутні — «—»', () => {
    const ctx = world();
    const cell = (row, key) => vm.runInContext('registryKpCell(' + JSON.stringify(row) + ', registryColumns().find(c => c.key === "' + key + '"), ' + money.toString() + ', (n) => n === null ? "—" : String(n))', ctx);
    assert.match(cell(ROW, 'no'), /^<td class="is-num kp-mono" data-col="no"><b>2026-0001<\/b>/);
    assert.match(cell(ROW, 'revenue'), /^<td class="is-num kp-mono" data-col="revenue">50000<\/td>$/);
    assert.match(cell(ROW, 'km'), /class="is-num kp-mono"/);
    assert.match(cell(ROW, 'profit'), /class="is-num kp-mono kp-plan"/);
    assert.match(cell({ ...ROW, distance_km: 540 }, 'vehicles'), /class="kp-mono"/);
    assert.match(cell(ROW, 'fact'), /kp-fact is-ok/, 'факт 13500 ≥ плану 12000 — зелений');
    assert.match(cell({ ...ROW, fact_profit: 12000 }, 'fact'), /kp-fact is-ok/, 'рівно план — зелений');
    assert.match(cell({ ...ROW, fact_profit: 9000 }, 'fact'), /kp-fact is-low/, 'менше плану — червоний');
    assert.match(cell({ ...ROW, fact_profit: null }, 'fact'), /tc-registry-fact-plan/, 'факту немає — план сірим курсивом');
    // Документи: посилання на картку, відсутні — «—».
    vm.runInContext('registryDocs.c1 = { contract_no: "Д-1/2026", client_id: "cl1", docs: [{ id: "i1", kind: "invoice", number: "7", status: "issued", paid: true }, { id: "a1", kind: "act", number: "3", status: "cancelled", paid: false }] }', ctx);
    assert.ok(cell(ROW, 'invoice').includes('href="#/docs/i1"') && cell(ROW, 'invoice').includes('>7</a>'));
    assert.ok(cell(ROW, 'act').includes('href="#/docs/a1"') && cell(ROW, 'act').includes('is-cancelled'));
    assert.ok(cell(ROW, 'contract').includes('href="#/clients/cl1"') && cell(ROW, 'contract').includes('Д-1/2026'));
    assert.match(cell(ROW, 'pay'), /kp-pay is-partial|kp-pay is-paid|kp-pay is-unpaid/);
    const none = world();
    const cellNone = (key) => vm.runInContext('registryKpCell(' + JSON.stringify(ROW) + ', registryColumns().find(c => c.key === "' + key + '"), ' + money.toString() + ', (n) => String(n))', none);
    for (const key of ['contract', 'invoice', 'act', 'pay']) assert.ok(cellNone(key).includes('kp-reg-none">—</span>'), key + ' → «—»');
    assert.ok(cell(ROW, 'invoice').includes('onclick="event.stopPropagation()"'), 'клік по посиланню не відкриває заявку');
    // Клік по рядку відкриває заявку тим самим способом, що й раніше.
    assert.ok(fnSource('registryRender').includes("' onclick=\"openRegistryRow(\\'' + escHtml(row.id) + '\\')\">'"));
});

test('ліміт 5000 і мобільні картки не зачеплені', () => {
    const render = fnSource('registryRender');
    assert.match(render, /warnEl\.hidden = !registryState\.truncated;/);
    assert.match(render, /warnEl\.textContent = registryState\.truncated \? REGISTRY_WARNING : '';/);
    assert.ok(render.includes("cards.innerHTML = registryState.rows.map(function (row) {"));
    assert.ok(render.includes('class="tc-history-card'));
    assert.match(constLine('REGISTRY_WARNING'), /5000/);
    assert.ok(html.includes('#registry-section .comparison-table { display: none; }'), 'мобільні правила сайту на місці');
    assert.ok(css.includes('@media (max-width: 720px)'));
});

test('колонки читаються під актуальним ключем: зміна компанії / користувача й повторне відкриття реєстру скидають registryKpCols і режим CSV', () => {
    const ctx = world();
    ctx.store.set('tc_kp_registry_cols:org1:u1', JSON.stringify({ hidden: ['km'], csv: 'all' }));
    ctx.store.set('tc_kp_registry_cols:org2:u1', JSON.stringify({ hidden: ['pay', 'act'], csv: 'screen' }));
    ctx.store.set('tc_kp_registry_cols:org1:u2', JSON.stringify({ hidden: ['revenue'], csv: 'screen' }));
    assert.deepEqual(run(ctx, 'registryColsState()'), { hidden: ['km'], csv: 'all' });
    // Інша компанія в тій самій сторінці → стан іншого ключа, а не кеш попередньої.
    ctx.currentOrgId = 'org2';
    assert.deepEqual(run(ctx, 'registryColsState()'), { hidden: ['pay', 'act'], csv: 'screen' });
    assert.equal(run(ctx, 'registryColsStorageKey()'), 'tc_kp_registry_cols:org2:u1');
    // Інший користувач.
    ctx.currentOrgId = 'org1';
    ctx.currentUserId = 'u2';
    assert.deepEqual(run(ctx, 'registryColsState()'), { hidden: ['revenue'], csv: 'screen' });
    // Нова пара без збереженого стану → типовий стан (усі колонки, CSV як на екрані), а не стан попередньої пари.
    ctx.currentUserId = 'u3';
    assert.deepEqual(run(ctx, 'registryColsState()'), { hidden: [], csv: 'screen' });
    // Зміна колонок пишеться під ключем поточної пари й не чіпає чужі.
    vm.runInContext('registryToggleCol("act", false)', ctx);
    assert.deepEqual(JSON.parse(ctx.store.get('tc_kp_registry_cols:org1:u3')), { hidden: ['act'], csv: 'screen' });
    assert.deepEqual(JSON.parse(ctx.store.get('tc_kp_registry_cols:org2:u1')), { hidden: ['pay', 'act'], csv: 'screen' });
    // CSV використовує колонки поточної пари.
    const head = vm.runInContext('registryCsv([' + JSON.stringify(ROW) + '])', ctx).replace('﻿', '').split('\r\n')[0].split(';');
    assert.equal(head.includes('Акт'), false);
    ctx.currentUserId = 'u2';
    assert.equal(vm.runInContext('registryCsv([' + JSON.stringify(ROW) + '])', ctx).replace('﻿', '').split('\r\n')[0].split(';').includes('Виручка'), false, 'u2 ховав виручку');
    // Повторне відкриття реєстру (там же, де registryCache = null) обнуляє registryKpCols і підтягує режим CSV у select.
    const open = fnSource('registryOpen', true);
    assert.ok(open.indexOf('registryCache = null;') < open.indexOf('registryKpCols = null;'), 'скидання колонок поруч зі скиданням кешу');
    assert.match(open, /registryKpCols = null;[^\n]*\n/);
    assert.match(open, /csvMode\.value = registryColsState\(\)\.csv;/);
    // Ключ, під яким прочитано стан, зберігається; без нього кеш не відрізнив би пари.
    assert.match(fnSource('registryColsState'), /registryKpCols && registryKpColsKey === key/);
});

test('JetBrains Mono: self-host woff2 лише для КП (400 і 600), font-display: swap, резервні моноширинні шрифти; на сайті не вантажиться', () => {
    const faces = css.match(/@font-face \{[^}]*\}/g) || [];
    assert.equal(faces.length, 4, 'latin і cyrillic × 400 і 600');
    assert.deepEqual([...new Set(faces.map((f) => /font-weight: (\d+)/.exec(f)[1]))].sort(), ['400', '600'], 'лише ваги 400 і 600');
    for (const face of faces) {
        assert.match(face, /font-family: 'JetBrains Mono'/);
        assert.match(face, /font-display: swap/);
        assert.match(face, /src: url\('\/fonts\/JetBrainsMono-(latin|cyrillic)-(400|600)\.woff2'\) format\('woff2'\)/);
        assert.match(face, /unicode-range:/);
    }
    for (const name of ['latin-400', 'latin-600', 'cyrillic-400', 'cyrillic-600']) {
        const file = new URL('../apps/kontrol-plus/public/fonts/JetBrainsMono-' + name + '.woff2', import.meta.url);
        const bytes = readFileSync(file);
        assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', name + ' — справжній woff2');
        assert.ok(bytes.length > 3000 && bytes.length < 40000, name + ' розмір');
    }
    assert.match(readFileSync(new URL('../apps/kontrol-plus/public/fonts/JetBrainsMono-OFL.txt', import.meta.url), 'utf8'), /SIL Open Font License/);
    // Резервні шрифти лишилися.
    assert.match(read('apps/kontrol-plus/src/kp-shell.css'), /--kp-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;/);
    assert.match(css, /font-family: var\(--kp-mono, 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace\)/);
    // Сайт self-host шрифт не підключає: ні @font-face, ні файлів /fonts/JetBrainsMono-* в index.html, sw.js і vercel.json кореня
    // (власне підключення шрифту сайтом через Google Fonts не змінено).
    assert.equal(/@font-face[^}]*JetBrains|JetBrainsMono-/.test(html), false, 'index.html сайту без self-host JetBrains Mono');
    assert.equal(/JetBrainsMono/.test(read('vercel.json') + read('sw.js')), false);
    assert.ok(html.includes('family=JetBrains+Mono:wght@400;500;600;700'), 'підключення шрифту сайтом не чіпали');
});
