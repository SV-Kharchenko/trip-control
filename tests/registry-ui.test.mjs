// «Реєстр заявок» (PR B): фільтри → filters jsonb, підсумки без скасованих, CSV з причиною, кнопки за ролями й approval_mode,
// solo без колонки логіста, серверна пагінація, розмітка вкладки, мобільна версія, сповіщення.
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
const SYNC = ['registryMonthRange', 'registryDefaultFilters', 'registryNormalizeFilters', 'registryFiltersToJson', 'registryNeedsLocal', 'registryRouteLabel',
    'registryRowMatches', 'registryTotalsOf', 'registryTotalsFromRpc', 'registryFactNote', 'registryRowCan', 'kpDirectorActive', 'registryDocText', 'registryPayState', 'registryDocMatches', 'registryCanMarkPaid', 'registryDocActions', 'canCancelStatus', 'approvalRole', 'registryVehicleLabel', 'registryColumns',
    'registryCellValue', 'registryCsv', 'historyCsvCell', 'registryStorageKey', 'registryReadStored', 'registrySaveFilters', 'registrySelectOptions', 'registrySanitizeFilters'];
const ASYNC = ['registryLoadDocs', 'registryRpcPage', 'registryFetchAllRows', 'registryFetchAll', 'registryLoad'];

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
}
function world(extra = {}) {
    const calls = [];
    const ctx = vm.createContext({
        currentWorkMode: 'team', currentOrgRole: 'owner', currentUserId: 'u-owner', uiView: 'director', uiPreview: false,
        teamState: { members: [], approval_mode: 'owner_only' }, savedCalculations: [], tripActuals: {},
        currentOrgId: 'org-1', isKP: () => false, window: {}, fleetVehicles: [], localStorage: memoryStorage(), tcModal: async () => ({ ok: true }), showToast() {},
        historyTripVehicles: () => [], savedAuthorLabel: (id) => 'user:' + id,
        document: { getElementById: () => null }, console, calls,
        supabaseClient: { rpc: async (name, args) => { calls.push({ name, args }); return { data: [], error: null }; } },
        ...extra,
    });
    vm.runInContext(['REGISTRY_PAGE_SIZE', 'REGISTRY_FETCH_ALL_LIMIT', 'REGISTRY_STATUS_LABELS', 'REGISTRY_UUID', 'REGISTRY_LEGACY_STORAGE_KEY', 'REGISTRY_WARNING', 'REGISTRY_PAY_LABELS', 'REGISTRY_DOC_STATUS'].map(constLine).join('\n')
        + '\nlet registryState = { rows: [], total: 0, page: 0, totals: null, loaded: false, loading: false, error: "", focusId: "" };'
        + '\nlet registryFilters = null;\nlet registryCache = null;\nlet registryClients = null;\nlet registryDocs = {};\nfunction registryRender() {}\n'
        + SYNC.map((n) => fnSource(n)).join('\n') + '\n' + ASYNC.map((n) => fnSource(n, true)).join('\n'), ctx);
    return ctx;
}
const run = (ctx, code) => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', ctx));
const U1 = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222222';

test('фільтри збираються в правильний filters jsonb (період, статус, логіст лише в team, авто); пошук і клієнт — клієнтські', () => {
    const ctx = world();
    const f = run(ctx, 'registryNormalizeFilters({ from: "2026-11-01", to: "2026-11-30", status: "cancelled", user: "' + U1 + '", vehicle: "' + V1 + '", client: "ТОВ А", q: " 2026-0007 " })');
    assert.deepEqual(f, { from: '2026-11-01', to: '2026-11-30', status: 'cancelled', user: U1, vehicle: V1, client: 'ТОВ А', contract: '', pay: '', q: '2026-0007' });
    assert.deepEqual(run(ctx, 'registryFiltersToJson(' + JSON.stringify(f) + ')'), { from: '2026-11-01', to: '2026-11-30', status: 'cancelled', user_id: U1, vehicle: V1 });
    assert.equal(run(ctx, 'registryNeedsLocal(' + JSON.stringify(f) + ')'), true);
    assert.equal(run(ctx, 'registryNeedsLocal({ q: "", client: "" })'), false);
    // Невідомий статус і не-uuid відсікаються; порожній фільтр — порожній jsonb.
    assert.deepEqual(run(ctx, 'registryFiltersToJson(registryNormalizeFilters({ from: "", to: "", status: "draft", user: "x", vehicle: "preview-fleet-1" }))'), {});
    // Solo: логіст у фільтр не потрапляє.
    const solo = world({ currentWorkMode: 'solo' });
    assert.deepEqual(run(solo, 'registryFiltersToJson({ from: "", to: "", status: "", user: "' + U1 + '", vehicle: "", client: "", q: "" })'), {});
});

test('період за замовчуванням — поточний місяць; скинутий користувачем період лишається порожнім', () => {
    const ctx = world();
    assert.deepEqual(run(ctx, 'registryMonthRange(new Date("2026-02-10T12:00:00Z"))'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(run(ctx, 'registryMonthRange(new Date("2028-02-10T12:00:00Z"))'), { from: '2028-02-01', to: '2028-02-29' });
    // Київ, а не час пристрою: 31.10 22:30 UTC — це вже 1 листопада за Києвом (EET, UTC+2).
    assert.deepEqual(run(ctx, 'registryMonthRange(new Date("2026-10-31T22:30:00Z"))'), { from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(run(ctx, 'registryMonthRange(new Date("2026-06-30T21:30:00Z"))'), { from: '2026-07-01', to: '2026-07-31' }, 'літній час UTC+3');
    const month = run(ctx, 'registryMonthRange()');
    assert.deepEqual(run(ctx, 'registryNormalizeFilters(null)'), { from: month.from, to: month.to, status: '', user: '', vehicle: '', client: '', contract: '', pay: '', q: '' });
    assert.deepEqual(run(ctx, 'registryNormalizeFilters({ from: "", to: "" })').from, '');
});

const ROWS = [
    { id: 'a', registry_no: '2026-0003', status: 'accepted', user_id: 'u1', name: 'А — Б', route_from: 'Київ', route_to: 'Львів', client_name: 'ТОВ А', trip_date: '2026-11-03', distance_km: 540, revenue: 1000, profit: 100, fact_profit: 80, cancel_reason: null },
    { id: 'b', registry_no: '2026-0002', status: 'done', user_id: 'u2', name: 'В — Г', route_from: 'Умань', route_to: 'Одеса', client_name: 'ТОВ Б', trip_date: '2026-11-02', distance_km: 300, revenue: 2000, profit: 300, fact_profit: 250, cancel_reason: null },
    { id: 'c', registry_no: '2026-0001', status: 'cancelled', user_id: 'u1', name: 'Д — Е', route_from: 'Лутськ', route_to: 'Рівне', client_name: 'ТОВ А', trip_date: '2026-11-01', distance_km: 100, revenue: 500, profit: 50, fact_profit: 40, cancel_reason: 'Клієнт; відмовився "зранку"' },
];

test('підсумки: скасовані не входять у суми, їх кількість окремо (локально й з registry_totals)', () => {
    const ctx = world();
    assert.deepEqual(run(ctx, 'registryTotalsOf(' + JSON.stringify(ROWS) + ')'), { count: 2, cancelled: 1, revenue: 3000, profit_plan: 400, profit_fact: 330, fact_count: 2, distance: 840 });
    assert.deepEqual(run(ctx, 'registryTotalsFromRpc({ total_count: 3, cancelled_count: 1, revenue: 3000, profit_plan: 400, profit_fact: 330, fact_count: 2, distance_km: 840 })'),
        { count: 2, cancelled: 1, revenue: 3000, profit_plan: 400, profit_fact: 330, fact_count: 2, distance: 840 });
    assert.deepEqual(run(ctx, 'registryTotalsOf([])'), { count: 0, cancelled: 0, revenue: 0, profit_plan: 0, profit_fact: 0, fact_count: 0, distance: 0 });
    assert.equal(run(ctx, 'registryRowMatches(' + JSON.stringify(ROWS[0]) + ', { q: "2026-0003", client: "" })'), true);
    assert.equal(run(ctx, 'registryRowMatches(' + JSON.stringify(ROWS[0]) + ', { q: "львів", client: "" })'), true, 'пошук за маршрутом без урахування регістру');
    assert.equal(run(ctx, 'registryRowMatches(' + JSON.stringify(ROWS[0]) + ', { q: "", client: "ТОВ Б" })'), false);
});

test('CSV: ті самі колонки, що в таблиці, плюс причина скасування; екранування; без колонки «Логіст» у solo', () => {
    const ctx = world();
    const csv = vm.runInContext('registryCsv(' + JSON.stringify(ROWS) + ')', ctx);
    const lines = csv.replace('﻿', '').split('\r\n');
    assert.equal(lines[0], '№ реєстру;Дата рейсу;Маршрут;Клієнт;Авто;Логіст;Статус;Км;Виручка;Прибуток план;Прибуток факт;Факт внесено;Причина скасування');
    assert.ok(csv.startsWith('﻿'));
    assert.equal(lines.length, 4);
    assert.equal(lines[1], '2026-0003;2026-11-03;Київ → Львів;ТОВ А;;user:u1;Активна;540;1000;100;80;так;');
    assert.ok(lines[3].endsWith(';Скасована;100;500;50;40;так;"Клієнт; відмовився ""зранку"""'), lines[3]);
    const solo = world({ currentWorkMode: 'solo' });
    const soloLines = vm.runInContext('registryCsv(' + JSON.stringify(ROWS) + ')', solo).replace('﻿', '').split('\r\n');
    assert.equal(soloLines[0], '№ реєстру;Дата рейсу;Маршрут;Клієнт;Авто;Статус;Км;Виручка;Прибуток план;Прибуток факт;Факт внесено;Причина скасування');
    assert.equal(soloLines[1].split(';').length, 12);
    assert.deepEqual(run(solo, 'registryColumns().map(c => c.key)'), ['no', 'date', 'route', 'client', 'vehicles', 'status', 'km', 'revenue', 'profit', 'fact']);
    assert.deepEqual(run(ctx, 'registryColumns().map(c => c.key)').includes('user'), true);
});

test('кнопки рядка за ролями й approval_mode (дзеркало lib/approvals.js): «Виконана» — автор або директор, «Скасувати» — директор чи логіст із правом', () => {
    const accepted = { id: 'a', status: 'accepted', user_id: 'u-author' };
    const can = (extra, row = accepted) => run(world(extra), 'registryRowCan(' + JSON.stringify(row) + ')');
    assert.deepEqual(can({}), { complete: true, cancel: true }, 'директор');
    assert.deepEqual(can({ uiView: 'logist' }), { complete: true, cancel: false }, 'директор у виді «Логіст»: виконати можна, скасувати — ні, як у canCancelStatus');
    const logist = (approval_mode, accept, id = 'u-author') => ({
        currentOrgRole: 'logist', currentUserId: id,
        teamState: { approval_mode, members: [{ id, permissions: { accept } }] },
    });
    assert.deepEqual(can(logist('owner_only', true)), { complete: true, cancel: false }, 'автор-логіст: виконує; право без режиму не діє');
    assert.deepEqual(can(logist('logist_can_accept', false)), { complete: true, cancel: false }, 'режим без права');
    assert.deepEqual(can(logist('logist_can_accept', true)), { complete: true, cancel: true }, 'режим і право');
    assert.deepEqual(can(logist('logist_can_accept', true, 'u-other')), { complete: false, cancel: true }, 'не автор із правом: скасовує, але не виконує');
    assert.deepEqual(can(logist('owner_only', false, 'u-other')), { complete: false, cancel: false }, 'не автор без права');
    for (const status of ['done', 'cancelled']) assert.deepEqual(can({}, { id: 'a', status, user_id: 'u-author' }), { complete: false, cancel: false }, status);
});

test('серверна пагінація: 50 на сторінку через registry_list; підсумки з registry_totals; пошук і клієнт тягнуть усе сторінками по 200', async () => {
    const part = Array.from({ length: 50 }, (_, i) => ({ id: 'r' + i, status: 'accepted', total_count: 120 }));
    const ctx = world({ supabaseClient: { rpc: async (name, args) => {
        ctx.calls.push({ name, args });
        if (name === 'registry_totals') return { data: [{ total_count: 120, cancelled_count: 5, revenue: 10, profit_plan: 2, profit_fact: 1, distance_km: 9 }], error: null };
        return { data: part, error: null };
    } } });
    vm.runInContext('registryFilters = registryNormalizeFilters({ from: "2026-11-01", to: "2026-11-30", status: "accepted" }); registryState.page = 2;', ctx);
    await vm.runInContext('registryLoad()', ctx);
    assert.deepEqual(ctx.calls.map((c) => c.name), ['registry_list', 'registry_totals']);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].args)), { p_filters: { from: '2026-11-01', to: '2026-11-30', status: 'accepted' }, p_limit: 50, p_offset: 100 });
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[1].args)), { p_filters: { from: '2026-11-01', to: '2026-11-30', status: 'accepted' } });
    assert.equal(run(ctx, 'registryState.total'), 120);
    assert.deepEqual(run(ctx, 'registryState.totals'), { count: 115, cancelled: 5, revenue: 10, profit_plan: 2, profit_fact: 1, fact_count: 0, distance: 9 });

    const pages = [Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, registry_no: '2026-' + i, status: 'accepted', revenue: 1, client_name: 'К' })), [{ id: 'z', registry_no: '2026-9999', status: 'cancelled', revenue: 5, client_name: 'К' }]];
    const all = world({ supabaseClient: { rpc: async (name, args) => { all.calls.push({ name, args }); return { data: pages[args.p_offset / 200] || [], error: null }; } } });
    vm.runInContext('registryFilters = registryNormalizeFilters({ from: "", to: "", q: "2026-" });', all);
    await vm.runInContext('registryLoad()', all);
    assert.deepEqual(all.calls.map((c) => [c.name, c.args.p_limit, c.args.p_offset]), [['registry_list', 200, 0], ['registry_list', 200, 200]], 'без registry_totals: підсумки рахуються по всіх знайдених');
    assert.equal(run(all, 'registryState.total'), 201);
    assert.equal(run(all, 'registryState.rows.length'), 50, 'таблиця — 50 на сторінку');
    assert.deepEqual(run(all, 'registryState.totals'), { count: 200, cancelled: 1, revenue: 200, profit_plan: 0, profit_fact: 0, fact_count: 0, distance: 0 });
});

test('розмітка: вкладка поруч із «Заявками», фільтри, підсумки, таблиця, картки, експорт; фільтри в localStorage; мобільні фільтри згортаються', () => {
    assert.ok(html.includes(`<button type="button" id="studio-nav-registry" onclick="setStudioView('registry')">Реєстр заявок</button>`));
    assert.ok(html.indexOf('id="studio-nav-history"') < html.indexOf('id="studio-nav-registry"'));
    for (const id of ['registry-section', 'registry-q', 'registry-from', 'registry-to', 'registry-status', 'registry-vehicle', 'registry-client', 'registry-user',
        'registry-totals', 'registry-table', 'registry-cards', 'registry-pager', 'registry-filter-toggle']) assert.ok(html.includes('id="' + id + '"'), id);
    assert.ok(html.includes('<label class="team-feature" for="registry-user">Логіст'), 'фільтр логіста лише в team (клас team-feature)');
    for (const label of ['Усі статуси', 'Активні', 'Виконані', 'Скасовані']) assert.ok(html.includes(label), label);
    assert.ok(html.includes("const REGISTRY_LEGACY_STORAGE_KEY = 'tc_registry_filters';"));
    assert.match(fnSource('registrySaveFilters'), /localStorage\.setItem\(registryStorageKey\(\)/);
    assert.match(fnSource('registryOpen'), /registryReadStored\(\)/, 'після оновлення фільтри відновлюються');
    assert.match(fnSource('setStudioView'), /registryOpen\(\)/);
    assert.ok(html.includes('#registry-section .comparison-table { display: none; }'), 'на ≤720px таблиця → картки');
    assert.ok(html.includes('#registry-filters:not(.is-open) { display: none; }'), 'на ≤720px фільтри згорнуті в блок «Фільтри»');
    assert.ok(html.includes('.tc-registry-row.is-cancelled'), 'скасовані приглушені');
    assert.ok(html.includes('class="tc-history-reason">Скасовано: '), 'причина під маршрутом');
    assert.ok(html.includes("for (let offset = 0; offset < REGISTRY_FETCH_ALL_LIMIT; offset += 200)"));
    // Лише наявні змінні кольорів, без нових HEX у стилях реєстру.
    const css = html.slice(html.indexOf('.tc-registry-head {'), html.indexOf('.tc-registry-row.is-focus'));
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(css), false);
});

test('дії: «Виконана» через calc_complete, «Скасувати» з тим самим діалогом, що в «Заявках»; сповіщення approval_decided відкриває реєстр', () => {
    assert.match(fnSource('registryComplete', true), /'calc_complete'/);
    assert.match(fnSource('registryCancel', true), /promptCancelReason\(/);
    assert.match(fnSource('cancelRequest', true), /promptCancelReason\(/);
    assert.match(fnSource('registryAct', true), /teamApi\('POST'/);
    assert.match(fnSource('openNotification', true), /note\.kind === 'approval_decided'[\s\S]*openRegistryFor\(note\.ref_id, note\.meta\.registry_no\)/);
    assert.match(fnSource('openRegistryFor'), /setStudioView\('registry'\)/);
    assert.match(fnSource('openRegistryRow'), /openSaved\(id\)/, 'клік по рядку — наявна картка заявки');
    assert.match(fnSource('registryExportCsv', true), /registryFetchAll\(/, 'експорт усіх рядків за фільтром, не сторінки');
    assert.match(fnSource('registryExportCsv', true), /downloadHistoryFile\(/);
});

test('тексти реєстру не вживають слово «власник»', () => {
    const start = html.indexOf('<section class="card" id="registry-section"');
    const markup = html.slice(start, html.indexOf('</section>', start));
    const code = html.slice(html.indexOf('// ===== Реєстр заявок: статуси'), html.indexOf('async function exportHistory('));
    assert.equal(/власник/i.test(markup), false);
    assert.equal(/власник/i.test(code.replace(/\/\/[^\n]*/g, '')), false);
});

test('ключ фільтрів: tc_registry_filters:<org>:<user>; старий спільний ключ видаляється при першому читанні; фільтри різних користувачів не змішуються', () => {
    const ctx = world();
    ctx.localStorage.setItem('tc_registry_filters', JSON.stringify({ status: 'done' }));
    ctx.localStorage.setItem('tc_registry_filters:org-1:u-other', JSON.stringify({ status: 'cancelled' }));
    assert.equal(vm.runInContext('registryStorageKey()', ctx), 'tc_registry_filters:org-1:u-owner');
    assert.equal(vm.runInContext('registryReadStored()', ctx), null, 'старе значення не підхоплюється');
    assert.equal(ctx.localStorage.getItem('tc_registry_filters'), null, 'старий ключ видалено');
    vm.runInContext('registryFilters = registryNormalizeFilters({ status: "accepted", from: "", to: "" }); registrySaveFilters();', ctx);
    assert.deepEqual(JSON.parse(ctx.localStorage.getItem('tc_registry_filters:org-1:u-owner')).status, 'accepted');
    assert.equal(JSON.parse(ctx.localStorage.getItem('tc_registry_filters:org-1:u-other')).status, 'cancelled', 'чужий ключ не зачеплено');
    assert.equal(run(ctx, 'registryReadStored().status'), 'accepted');
    const other = world({ currentUserId: 'u-other', localStorage: ctx.localStorage });
    assert.equal(run(other, 'registryReadStored().status'), 'cancelled');
});

test('відновлення: збережені user / vehicle / client без відповідної опції скидаються на «Усі»', () => {
    const ctx = world({
        fleetVehicles: [{ id: V1, label: 'AA0001KA' }],
        teamState: { members: [{ id: U1, email: 'l@x.test' }], approval_mode: 'owner_only' },
        savedCalculations: [{ id: 'a', clientName: 'ТОВ А' }],
    });
    const stored = { from: '2026-11-01', to: '2026-11-30', status: 'done', user: U1, vehicle: V1, client: 'ТОВ А', contract: '', pay: '', q: 'x' };
    assert.deepEqual(run(ctx, 'registrySanitizeFilters(registryNormalizeFilters(' + JSON.stringify(stored) + '), registrySelectOptions())'), stored);
    const stale = { ...stored, user: '99999999-9999-4999-8999-999999999999', vehicle: '88888888-8888-4888-8888-888888888888', client: 'Видалений клієнт' };
    assert.deepEqual(run(ctx, 'registrySanitizeFilters(registryNormalizeFilters(' + JSON.stringify(stale) + '), registrySelectOptions())'), { ...stored, user: '', vehicle: '', client: '' });
    const solo = world({ currentWorkMode: 'solo', teamState: { members: [{ id: U1 }] } });
    assert.equal(run(solo, 'registrySanitizeFilters(registryNormalizeFilters({ user: "' + U1 + '", from: "", to: "" }), registrySelectOptions()).user'), '', 'у solo логіста немає');
});

test('ліміт 5000: попередження над підсумками й у CSV перед завантаженням; точно до ліміту не ставиться, якщо сторінка коротка', async () => {
    const full = world({ supabaseClient: { rpc: async (name, args) => { full.calls.push({ name, args }); return { data: Array.from({ length: 200 }, (_, i) => ({ id: 'x' + args.p_offset + '-' + i, registry_no: 'x-' + i, status: 'accepted' })), error: null }; } } });
    vm.runInContext('registryFilters = registryNormalizeFilters({ from: "", to: "", q: "x" });', full);
    await vm.runInContext('registryLoad()', full);
    assert.equal(full.calls.length, 25, '25 сторінок по 200 = ліміт 5000');
    assert.equal(run(full, 'registryState.truncated'), true);
    assert.equal(run(full, 'registryState.total'), 5000);
    const short = world({ supabaseClient: { rpc: async (name, args) => { short.calls.push({ name, args }); return { data: [{ id: 'y', status: 'accepted' }], error: null }; } } });
    vm.runInContext('registryFilters = registryNormalizeFilters({ from: "", to: "", q: "" , client: "К"});', short);
    await vm.runInContext('registryLoad()', short);
    assert.equal(run(short, 'registryState.truncated'), false);
    assert.ok(html.includes("const REGISTRY_WARNING = 'Показано перші 5000 записів, звузь період або фільтри';"));
    assert.ok(html.includes('id="registry-warning"'));
    assert.match(fnSource('registryRender'), /warnEl\.textContent = registryState\.truncated \? REGISTRY_WARNING/);
    const exportSrc = fnSource('registryExportCsv', true);
    assert.ok(exportSrc.indexOf('registryState.truncated') < exportSrc.indexOf('downloadHistoryFile('), 'попередження — до завантаження');
    assert.match(exportSrc, /tcModal\(\{ title: 'Експорт неповний', text: REGISTRY_WARNING/);
});

test('кеш повної вибірки: пошук і клієнт фільтруються по кешу без нових RPC; зміна періоду чи статусу — новий запит', async () => {
    const data = [
        { id: '1', registry_no: '2026-0001', status: 'accepted', route_from: 'Київ', route_to: 'Львів', client_name: 'А' },
        { id: '2', registry_no: '2026-0002', status: 'done', route_from: 'Умань', route_to: 'Одеса', client_name: 'Б' },
    ];
    const ctx = world({ supabaseClient: { rpc: async (name, args) => { ctx.calls.push({ name, args }); return { data, error: null }; } } });
    const load = async (filters) => { vm.runInContext('registryFilters = registryNormalizeFilters(' + JSON.stringify(filters) + ');', ctx); await vm.runInContext('registryLoad()', ctx); };
    await load({ from: '2026-11-01', to: '2026-11-30', q: 'київ' });
    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(run(ctx, 'registryState.rows.map(r => r.id)'), ['1']);
    await load({ from: '2026-11-01', to: '2026-11-30', q: 'одеса' });
    await load({ from: '2026-11-01', to: '2026-11-30', q: '', client: 'Б' });
    await load({ from: '2026-11-01', to: '2026-11-30', q: '2026-0002' });
    assert.equal(ctx.calls.length, 1, 'пошук і клієнт — без нових RPC');
    assert.deepEqual(run(ctx, 'registryState.rows.map(r => r.id)'), ['2']);
    await load({ from: '2026-10-01', to: '2026-11-30', q: 'київ' });
    assert.equal(ctx.calls.length, 2, 'інший період — новий запит');
    await load({ from: '2026-10-01', to: '2026-11-30', q: 'київ', status: 'done' });
    assert.equal(ctx.calls.length, 3, 'інший статус — новий запит');
    vm.runInContext('registryCache = null;', ctx);
    await load({ from: '2026-10-01', to: '2026-11-30', q: 'київ', status: 'done' });
    assert.equal(ctx.calls.length, 4, 'скинутий кеш (дія, скидання фільтрів, повторне відкриття) — новий запит');
});

test('CSV: значення з \\t і \\r на початку отримують префікс апострофа (формули не виконуються), решта екранування без змін', () => {
    const ctx = world();
    const cell = (v) => vm.runInContext('historyCsvCell(' + JSON.stringify(v) + ')', ctx);
    for (const lead of ['=', '+', '-', '@']) assert.equal(cell(lead + 'SUM(A1)'), "'" + lead + 'SUM(A1)');
    assert.equal(cell('\tcmd'), "'\tcmd");
    assert.equal(cell('\rcmd'), '"\'\rcmd"');
    assert.equal(cell('a;b'), '"a;b"');
    assert.equal(cell('звичайний'), 'звичайний');
    const csv = vm.runInContext('registryCsv(' + JSON.stringify([{ id: 'a', registry_no: '2026-0001', status: 'cancelled', user_id: 'u', name: '=HYPERLINK("x")', cancel_reason: '\tшкідливо', trip_date: '2026-11-01' }]) + ')', ctx);
    assert.ok(csv.includes("'=HYPERLINK") && csv.includes("'\tшкідливо"));
});

test('мобільні картки реєстру: другим рядком клієнт, авто й км', () => {
    const cards = html.slice(html.indexOf("cards.innerHTML = registryState.rows.map"), html.indexOf('function openRegistryRow('));
    assert.ok(cards.includes("registryCellValue(row, 'client'), registryCellValue(row, 'vehicles')"));
    assert.ok(cards.includes("+ ' км'"));
});

test('директор Контроль+ (org_directors, role director) бачить «Виконана» і «Скасувати» нарівні з директором; без КП-контексту — ні', () => {
    const row = { id: 'a', status: 'accepted', user_id: 'u-author' };
    const can = (extra) => run(world(extra), 'registryRowCan(' + JSON.stringify(row) + ')');
    // Профіль директора — звичайний користувач (логіст/власник своєї компанії); роль director дає kp_context() через міст.
    for (const role of ['logist', 'owner']) {
        assert.deepEqual(can({ isKP: () => true, window: { tcKpRole: 'director' }, currentOrgRole: role, currentUserId: 'u-director', uiView: 'logist' }), { complete: true, cancel: true }, role);
    }
    assert.deepEqual(can({ isKP: () => true, window: { tcKpRole: 'logist' }, currentOrgRole: 'logist', currentUserId: 'u-director' }), { complete: false, cancel: false }, 'роль logist у КП');
    assert.deepEqual(can({ isKP: () => false, window: { tcKpRole: 'director' }, currentOrgRole: 'logist', currentUserId: 'u-director' }), { complete: false, cancel: false }, 'на сайті ролі director немає');
    for (const status of ['done', 'cancelled']) {
        assert.deepEqual(run(world({ isKP: () => true, window: { tcKpRole: 'director' } }), 'registryRowCan({ id: "a", status: "' + status + '" })'), { complete: false, cancel: false }, status);
    }
    const bridge = fs.readFileSync(new URL('../apps/kontrol-plus/src/bridge.js', import.meta.url), 'utf8');
    assert.ok(bridge.includes('window.tcKpRole = state.context.role || null;'), 'міст передає роль зі kp_context()');
    assert.ok(bridge.includes('window.tcKpRole = null;'));
});

test('фільтр «Клієнт»: у КП — uuid із clients на сервер (без локального режиму й registryFetchAll), на сайті — назва й локальний режим', async () => {
    const C1 = '33333333-3333-4333-8333-333333333333';
    const kp = world({ isKP: () => true, supabaseClient: { rpc: async (name, args) => { kp.calls.push({ name, args }); return { data: name === 'registry_totals' ? [{ total_count: 1, cancelled_count: 0 }] : (name === 'registry_documents' ? [] : [{ id: 'r', status: 'accepted', total_count: 1 }]), error: null }; } } });
    const f = run(kp, 'registryNormalizeFilters({ from: "", to: "", client: "' + C1 + '" })');
    assert.deepEqual(run(kp, 'registryFiltersToJson(' + JSON.stringify(f) + ')'), { client: C1 });
    assert.equal(run(kp, 'registryNeedsLocal(' + JSON.stringify(f) + ')'), false);
    assert.equal(run(kp, 'registryNeedsLocal({ q: "x", client: "" })'), true, 'пошук за назвою/№ лишається локальним');
    vm.runInContext('registryFilters = registryNormalizeFilters({ from: "", to: "", client: "' + C1 + '" });', kp);
    // registryFetchAll у КП не викликається: підміняємо на пастку.
    vm.runInContext('registryFetchAll = async function () { throw new Error("registryFetchAll не має викликатись"); };', kp);
    await vm.runInContext('registryLoad()', kp);
    assert.equal(run(kp, 'registryState.error'), '');
    assert.deepEqual(kp.calls.map((c) => [c.name, c.args.p_limit]), [['registry_list', 50], ['registry_totals', undefined], ['registry_documents', undefined]], 'серверна пагінація 50, не вибірка по 200; документи лише для рядків сторінки');
    assert.deepEqual(JSON.parse(JSON.stringify(kp.calls[0].args.p_filters)), { client: C1 });
    // Сайт: назва → локальний режим.
    const site = world({ supabaseClient: { rpc: async (name, args) => { site.calls.push({ name, args }); return { data: [], error: null }; } } });
    assert.equal(run(site, 'registryNeedsLocal({ q: "", client: "ТОВ А" })'), true);
    assert.deepEqual(run(site, 'registryFiltersToJson({ from: "", to: "", status: "", user: "", vehicle: "", client: "ТОВ А", q: "" })'), {});
    assert.equal(run(site, 'registryRowMatches({ client_name: "ТОВ Б" }, { client: "ТОВ А", q: "" })'), false);
    // У КП варіанти — clients (id → назва); збережений uuid, якого немає у списку, скидається.
    const withClients = world({ isKP: () => true });
    vm.runInContext('registryClients = [["' + C1 + '", "ТОВ А"]];', withClients);
    assert.deepEqual(run(withClients, 'registrySelectOptions().client'), [[C1, 'ТОВ А']]);
    assert.equal(run(withClients, 'registrySanitizeFilters({ client: "' + C1 + '", user: "", vehicle: "" }, registrySelectOptions()).client'), C1);
    assert.equal(run(withClients, 'registrySanitizeFilters({ client: "44444444-4444-4444-8444-444444444444", user: "", vehicle: "" }, registrySelectOptions()).client'), '');
    assert.match(fnSource('registryOpen', true), /isKP\(\) && registryClients === null\) await registryLoadClients\(\)/);
    assert.match(fnSource('registryLoadClients', true), /from\('clients'\)\.select\('id, name'\)/);
});

test('«Прибуток факт»: сума = факт, інакше план (скасовані не входять); рядок «факт у N з M»; таблиця й картки — план сірим курсивом; CSV окремо з «Факт внесено»', () => {
    const ctx = world();
    const rows = [
        { id: 'a', status: 'accepted', profit: 100, fact_profit: 80, user_id: 'u', trip_date: '2026-11-01' },
        { id: 'b', status: 'done', profit: 300, fact_profit: null, user_id: 'u', trip_date: '2026-11-02' },
        { id: 'c', status: 'accepted', profit: 50000, fact_profit: undefined, user_id: 'u', trip_date: '2026-11-03' },
        { id: 'd', status: 'cancelled', profit: 999, fact_profit: 5, user_id: 'u', trip_date: '2026-11-04' },
    ];
    const t = run(ctx, 'registryTotalsOf(' + JSON.stringify(rows) + ')');
    assert.deepEqual([t.count, t.cancelled, t.profit_plan, t.profit_fact, t.fact_count], [3, 1, 50400, 50380, 1], 'факт 80 + план 300 + план 50000; скасована не рахується');
    const noFact = run(ctx, 'registryTotalsOf(' + JSON.stringify(rows.slice(1, 3)) + ')');
    assert.deepEqual([noFact.profit_fact, noFact.fact_count], [50300, 0], 'факту немає зовсім — сума за планом, не 0');
    const note = (totals) => vm.runInContext('registryFactNote(' + JSON.stringify(totals) + ')', ctx);
    assert.equal(note({ count: 3, fact_count: 1 }), 'факт у 1 з 3, решта за планом');
    assert.equal(note({ count: 3, fact_count: 3 }), 'за внесеним фактом');
    assert.equal(note({ count: 0, fact_count: 0 }), 'за внесеним фактом');
    assert.deepEqual(run(ctx, 'registryTotalsFromRpc({ total_count: 9, cancelled_count: 0, profit_fact: 168000, fact_count: 3 })').fact_count, 3);
    assert.ok(html.includes("['Прибуток факт', money(t.profit_fact), registryFactNote(t)],"));
    // Таблиця й картки: без факту — план у span.tc-registry-fact-plan з підказкою «за планом».
    const withFn = world();
    vm.runInContext(fnSource('registryFactHtml') + ' const escHtml = (v) => String(v);', withFn);
    const cell = (row) => vm.runInContext('registryFactHtml(' + JSON.stringify(row) + ', (n) => n + " грн")', withFn);
    assert.equal(cell({ status: 'accepted', profit: 300, fact_profit: 80 }), '80 грн');
    assert.equal(cell({ status: 'accepted', profit: 300, fact_profit: null }), '<span class="tc-registry-fact-plan" title="за планом">300 грн</span>');
    assert.equal(cell({ status: 'accepted', profit: null, fact_profit: null }), '—');
    assert.ok(html.includes("if (c.key === 'fact') return '<td class=\"is-num\">' + registryFactHtml(row, money) + '</td>';"));
    assert.ok(html.includes("' · Факт ' + registryFactHtml(row, money)"), 'мобільні картки');
    assert.ok(html.includes('.tc-registry-fact-plan { color: var(--text-muted); font-style: italic; }'));
    // CSV: колонка факту без плану, «Факт внесено» так / ні.
    const csv = vm.runInContext('registryCsv(' + JSON.stringify([{ id: 'a', registry_no: '1', status: 'accepted', user_id: 'u', profit: 300, fact_profit: null }, { id: 'b', registry_no: '2', status: 'done', user_id: 'u', profit: 300, fact_profit: 80 }]) + ')', world({ currentWorkMode: 'solo' }));
    const lines = csv.replace('﻿', '').split('\r\n');
    const head = lines[0].split(';');
    const fi = head.indexOf('Прибуток факт');
    assert.equal(head[fi + 1], 'Факт внесено');
    assert.deepEqual([lines[1].split(';')[fi], lines[1].split(';')[fi + 1]], ['', 'ні'], 'план у колонку факту не потрапляє');
    assert.deepEqual([lines[2].split(';')[fi], lines[2].split(';')[fi + 1]], ['80', 'так']);
});
