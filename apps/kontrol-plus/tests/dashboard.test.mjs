// Дашборд Контроль+ (PR 4 з 5): період, агрегація по днях (Київ), порівняння, ролі, лише наявні RPC, кольори тільки з тем, вікна PR 3, браузерний рендер.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
    DASHBOARD_RPCS, MAX_CUSTOM_DAYS, clampToToday, fmtSum, PERIOD_KEY, aggregateByDay, chartGeometry, dashboardAccess, delta, docGaps, fmtDelta, fmtShort, mainCurrency, niceCeil,
    normalizePeriod, overdueDebts, periodRange, prevRange, readPeriod, recentRequests, registryFilters, rowDay, sumDebts, writePeriod,
} from '../src/lib/dashboard.js';
import { parseCrmHash, tabOf, windowSpecOf } from '../src/lib/route.js';
import { SHELL_ITEMS, activeKey } from '../src/shell-menu.js';
import { makeFixture, makeRows, TODAY } from './helpers/dashboard-fixture.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(APP, file), 'utf8');

test('період: сьогодні / тиждень / місяць / свій і попередній період тієї ж довжини', () => {
    assert.deepEqual(periodRange({ kind: 'today' }, TODAY), { from: '2026-11-18', to: '2026-11-18' });
    assert.deepEqual(periodRange({ kind: 'week' }, TODAY), { from: '2026-11-12', to: '2026-11-18' });
    assert.deepEqual(periodRange({ kind: 'month' }, TODAY), { from: '2026-11-01', to: '2026-11-18' });
    assert.deepEqual(periodRange({ kind: 'custom', from: '2026-10-05', to: '2026-10-09' }, TODAY), { from: '2026-10-05', to: '2026-10-09' });
    assert.deepEqual(prevRange({ from: '2026-11-12', to: '2026-11-18' }), { from: '2026-11-05', to: '2026-11-11' });
    assert.deepEqual(prevRange({ from: '2026-11-18', to: '2026-11-18' }), { from: '2026-11-17', to: '2026-11-17' });
    assert.deepEqual(prevRange({ from: '2026-11-01', to: '2026-11-18' }), { from: '2026-10-14', to: '2026-10-31' });
    // через перехід на зимовий час (кінець жовтня) дати лишаються цілими днями
    assert.deepEqual(prevRange({ from: '2026-10-26', to: '2026-10-30' }), { from: '2026-10-21', to: '2026-10-25' });
});

test('збережений вибір періоду: ключ kp.dashboard.period, сміття → «Місяць», недоступне сховище не ламає', () => {
    assert.equal(PERIOD_KEY, 'kp.dashboard.period');
    assert.deepEqual(normalizePeriod(null), { kind: 'month' });
    assert.deepEqual(normalizePeriod('{oops'), { kind: 'month' });
    assert.deepEqual(normalizePeriod({ kind: 'year' }), { kind: 'month' });
    assert.deepEqual(normalizePeriod({ kind: 'custom', from: '2026-02-30', to: '2026-03-01' }), { kind: 'month' }, 'неіснуюча дата');
    assert.deepEqual(normalizePeriod({ kind: 'custom', from: '2026-03-05', to: '2026-03-01' }), { kind: 'month' }, 'from > to');
    assert.deepEqual(normalizePeriod({ kind: 'custom', from: '2024-01-01', to: '2026-01-01' }), { kind: 'month' }, 'довше ' + MAX_CUSTOM_DAYS + ' днів');
    assert.deepEqual(normalizePeriod({ kind: 'custom', from: '2026-03-01', to: '2026-03-05', x: 1 }), { kind: 'custom', from: '2026-03-01', to: '2026-03-05' });
    const mem = new Map();
    const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
    writePeriod(storage, { kind: 'week' });
    assert.equal(mem.get('kp.dashboard.period'), '{"kind":"week"}');
    assert.deepEqual(readPeriod(storage), { kind: 'week' });
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.deepEqual(readPeriod(broken), { kind: 'month' });
    assert.doesNotThrow(() => writePeriod(broken, { kind: 'today' }));
    assert.deepEqual(readPeriod(null), { kind: 'month' });
});

test('день заявки — за Києвом: дата рейсу важливіша, потім рішення, потім створення (зима UTC+2, літо UTC+3)', () => {
    assert.equal(rowDay({ trip_date: '2026-11-05', decided_at: '2026-11-01T10:00:00Z' }), '2026-11-05');
    assert.equal(rowDay({ trip_date: null, decided_at: '2026-11-17T22:30:00Z' }), '2026-11-18', 'зима: 22:30 UTC уже наступний день');
    assert.equal(rowDay({ trip_date: null, decided_at: '2026-11-17T21:59:00Z' }), '2026-11-17');
    assert.equal(rowDay({ trip_date: null, decided_at: '2026-07-01T21:30:00Z' }), '2026-07-02', 'літо: 21:30 UTC уже наступний день');
    assert.equal(rowDay({ trip_date: null, decided_at: '2026-07-01T20:59:00Z' }), '2026-07-01');
    assert.equal(rowDay({ trip_date: null, decided_at: null, created_at: '2026-11-17T22:05:00Z' }), '2026-11-18');
    assert.equal(rowDay({ trip_date: 'bad', decided_at: 'bad', created_at: null }), null);
    assert.equal(rowDay(null), null);
});

test('виручка по днях: межі періоду включно, дні без заявок — нулі, скасовані й чужі дні не рахуються', () => {
    const range = { from: '2026-11-10', to: '2026-11-14' };
    const rows = [
        { status: 'accepted', trip_date: '2026-11-10', revenue: '1000' },
        { status: 'done', trip_date: '2026-11-10', revenue: 500 },
        { status: 'done', trip_date: '2026-11-14', revenue: 2000 },
        { status: 'cancelled', trip_date: '2026-11-12', revenue: 9999 },
        { status: 'accepted', trip_date: '2026-11-09', revenue: 7777 }, // до початку
        { status: 'accepted', trip_date: '2026-11-15', revenue: 8888 }, // після кінця
        { status: 'accepted', trip_date: null, decided_at: '2026-11-13T22:30:00Z', revenue: 300 }, // 14.11 за Києвом
        { status: 'accepted', trip_date: '2026-11-11', revenue: null },
    ];
    const agg = aggregateByDay(rows, range, '2026-12-31');
    assert.deepEqual(agg.days.map((d) => d.date), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    assert.deepEqual(agg.days.map((d) => d.revenue), [1500, 0, 0, 0, 2300]);
    assert.deepEqual(agg.days.map((d) => d.count), [2, 1, 0, 0, 2]);
    assert.equal(agg.total, 3800);
    assert.equal(agg.count, 5);
    assert.equal(agg.weekly, false);
    assert.equal(aggregateByDay([], range, '2026-12-31').total, 0);
    assert.equal(aggregateByDay(null, range, '2026-12-31').days.length, 5);
    assert.deepEqual(aggregateByDay([{ status: 'done', trip_date: '2026-11-18', revenue: 5 }], { from: '2026-11-18', to: '2026-11-18' }, '2026-12-31').days, [{ date: '2026-11-18', revenue: 5, count: 1 }]);
});

test('довгий період (>92 днів) групується по тижнях з понеділка', () => {
    const range = { from: '2026-01-01', to: '2026-06-30' };
    const agg = aggregateByDay([{ status: 'done', trip_date: '2026-03-04', revenue: 10 }, { status: 'done', trip_date: '2026-03-06', revenue: 5 }], range, '2026-12-31');
    assert.equal(agg.weekly, true);
    const week = agg.days.find((d) => d.date === '2026-03-02');
    assert.deepEqual(week, { date: '2026-03-02', revenue: 15, count: 2 });
    assert.ok(agg.days.every((d) => new Date(d.date + 'T00:00:00Z').getUTCDay() === 1), 'усі ключі — понеділки');
    assert.equal(agg.total, 15);
});

test('єдиний формат сум: як у KPI — пробіли тисяч, без копійок, «₴»; інша валюта з кодом', () => {
    const nb = (s) => s.replace(/\s/g, ' ');
    assert.equal(nb(fmtSum(396000)), '396 000 ₴');
    assert.equal(nb(fmtSum(70000, 'UAH')), '70 000 ₴');
    assert.equal(nb(fmtSum('45000.00')), '45 000 ₴');
    assert.equal(nb(fmtSum(1234.56, 'USD')), '1 235 USD');
    assert.equal(fmtSum(null), '—');
});

test('вісь графіка не йде за сьогодні (Київ): майбутні дні відрізані, нулі в минулому лишаються', () => {
    const rows = [{ status: 'done', trip_date: '2026-11-18', revenue: 100 }, { status: 'done', trip_date: '2026-11-19', revenue: 999 }];
    const agg = aggregateByDay(rows, { from: '2026-11-16', to: '2026-11-22' }, '2026-11-18');
    assert.deepEqual(agg.days.map((d) => d.date), ['2026-11-16', '2026-11-17', '2026-11-18']);
    assert.deepEqual(agg.days.map((d) => d.revenue), [0, 0, 100]);
    assert.equal(agg.total, 100);
    assert.equal(aggregateByDay(rows, { from: '2026-11-16', to: '2026-11-18' }, '2026-11-18').days.length, 3, 'до сьогодні включно — без змін');
    assert.deepEqual(aggregateByDay(rows, { from: '2026-11-19', to: '2026-11-22' }, '2026-11-18').days, []);
    assert.deepEqual(clampToToday({ from: '2026-11-01', to: '2026-11-30' }, '2026-11-18'), { from: '2026-11-01', to: '2026-11-18' });
    assert.equal(clampToToday({ from: '2026-11-19', to: '2026-11-30' }, '2026-11-18'), null);
});

test('порівняння з попереднім періодом: ▲ ▼, без бази (0 / невідомо) — нічого', () => {
    assert.deepEqual(delta(120, 100), { pct: 20, dir: 'up' });
    assert.deepEqual(delta(75, 100), { pct: -25, dir: 'down' });
    assert.deepEqual(delta(100, 100), { pct: 0, dir: 'flat' });
    assert.deepEqual(delta(10, 3), { pct: 233.3, dir: 'up' });
    assert.equal(delta(10, 0), null);
    assert.equal(delta(10, null), null);
    assert.equal(delta(null, 10), null);
    assert.equal(delta(undefined, undefined), null);
    assert.equal(delta('x', 5), null);
    assert.equal(fmtDelta({ pct: 20, dir: 'up' }), '▲ +20%');
    assert.equal(fmtDelta({ pct: -12.5, dir: 'down' }), '▼ −12,5%');
    assert.equal(fmtDelta(null), '');
});

test('фільтри registry_*: директор (org_directors) читає свою компанію явним org_id, як реєстр сайту', () => {
    const range = { from: '2026-11-01', to: '2026-11-18' };
    assert.deepEqual(registryFilters({ role: 'owner', org_id: 'x' }, range), { from: '2026-11-01', to: '2026-11-18' });
    assert.deepEqual(registryFilters({ role: 'logist', org_id: 'x' }, range), range);
    assert.deepEqual(registryFilters({ role: 'director', org_id: 'org-1' }, range), { ...range, org_id: 'org-1' });
    assert.deepEqual(registryFilters({ role: 'owner' }, null, { status: ['accepted'] }), { status: ['accepted'] });
    assert.deepEqual(registryFilters(null, range), range);
});

test('списки: останні заявки без скасованих, прострочені за днями, борги по валютах окремо', () => {
    const rows = makeRows(14);
    const recent = recentRequests(rows, 6);
    assert.equal(recent.length, 6);
    assert.ok(recent.every((r) => r.status !== 'cancelled'));
    const debts = [
        { client_id: 'a', currency: 'UAH', debt: 100, overdue: 0, overdue_days: 0, invoices: 1 },
        { client_id: 'b', currency: 'UAH', debt: 300, overdue: 200, overdue_days: 5, invoices: 2 },
        { client_id: 'c', currency: 'USD', debt: 50, overdue: 50, overdue_days: 40, invoices: 1 },
        { client_id: 'd', currency: 'UAH', debt: 80, overdue: 80, overdue_days: 40, invoices: 1 },
    ];
    assert.deepEqual(overdueDebts(debts).map((r) => r.client_id), ['d', 'c', 'b'], 'за днями, потім за сумою');
    assert.equal(overdueDebts(debts, 1).length, 1);
    const sums = sumDebts(debts);
    assert.deepEqual(sums.UAH, { debt: 480, overdue: 280, invoices: 4 });
    assert.deepEqual(sums.USD, { debt: 50, overdue: 50, invoices: 1 });
    assert.equal(mainCurrency(sums), 'UAH');
    assert.equal(mainCurrency({ USD: {} }), 'USD');
    assert.equal(mainCurrency({}), null);
    assert.deepEqual(sumDebts(null), {});
});

test('документи без акта / підпису: виконана заявка без чинного акта, договір не підписано; скасовані й невідомі пропускаються', () => {
    const reqs = [
        { id: 'r1', status: 'done' }, { id: 'r2', status: 'done' }, { id: 'r3', status: 'accepted' }, { id: 'r4', status: 'cancelled' }, { id: 'r5', status: 'done' }, { id: 'r6', status: 'accepted' },
    ];
    const docs = [
        { calculation_id: 'r1', contract_id: null, contract_status: null, docs: [] },                                                             // done без акта
        { calculation_id: 'r2', contract_id: 'k', contract_status: 'signed', docs: [{ kind: 'act', status: 'issued' }] },                         // усе гаразд
        { calculation_id: 'r3', contract_id: 'k', contract_status: 'draft', docs: [] },                                                          // accepted: акта ще не чекаємо, договір не підписано
        { calculation_id: 'r4', contract_id: 'k', contract_status: 'draft', docs: [] },                                                          // скасована
        { calculation_id: 'r5', contract_id: 'k', contract_status: 'sent', docs: [{ kind: 'act', status: 'cancelled' }] },                         // анульований акт = немає акта
        // r6 — сервер документів не віддав (логіст не бачить): не вигадуємо
    ];
    const out = docGaps(reqs, docs, 10);
    assert.deepEqual(out.map((g) => [g.request.id, g.problems]), [
        ['r1', ['немає акта']], ['r3', ['договір не підписано']], ['r5', ['немає акта', 'договір не підписано']],
    ]);
    assert.equal(docGaps(reqs, docs, 2).length, 2);
    assert.deepEqual(docGaps(reqs, null), []);
    assert.deepEqual(docGaps(null, docs), []);
});

test('геометрія графіка: стовпчики в межах, нульові дні, порожні дані, шкала й підписи', () => {
    const days = Array.from({ length: 18 }, (_, i) => ({ date: '2026-11-' + String(i + 1).padStart(2, '0'), revenue: i % 4 === 0 ? 0 : 1000 * i, count: 1 }));
    const g = chartGeometry(days, { width: 640, height: 200 });
    assert.equal(g.bars.length, 18);
    for (const b of g.bars) {
        assert.ok(b.x >= g.padLeft && b.x + b.w <= 640, 'по ширині');
        assert.ok(b.y >= g.padTop - 0.01 && b.y + b.h <= g.axisY + 0.01, 'по висоті');
        assert.ok(b.h >= 0);
    }
    assert.equal(g.bars[0].h, 0);
    assert.ok(g.top >= 17000);
    assert.ok(g.labels.length >= 2 && g.labels.length <= 18);
    assert.deepEqual(g.ticks.map((t) => t.value), [0, g.top / 2, g.top]);
    const narrow = chartGeometry(days, { width: 260, height: 170 });
    assert.ok(narrow.bars.every((b) => b.x + b.w <= 260));
    const none = chartGeometry([{ date: '2026-11-01', revenue: 0, count: 0 }]);
    assert.equal(none.top, 0);
    assert.equal(none.bars[0].h, 0);
    assert.equal(niceCeil(0), 0);
    assert.equal(niceCeil(17), 20);
    assert.equal(niceCeil(2300), 2500);
    assert.equal(niceCeil(6100), 10000);
    assert.equal(fmtShort(0), '0');
    assert.equal(fmtShort(12500), '12,5 тис');
    assert.equal(fmtShort(1200000), '1,2 млн');
    assert.equal(fmtShort(NaN), '—');
});

test('ролі: Директор / власник / логіст бачать фінанси, пишуть лише owner і logist; без тарифу — лише читання', () => {
    const ctx = (role, control_plus = true) => ({ control_plus, role });
    assert.deepEqual(dashboardAccess(ctx('owner')), { finance: true, canWrite: true });
    assert.deepEqual(dashboardAccess(ctx('logist')), { finance: true, canWrite: true });
    assert.deepEqual(dashboardAccess(ctx('director')), { finance: true, canWrite: false }, 'директор Контроль+ — перегляд');
    assert.deepEqual(dashboardAccess(ctx('owner', false)), { finance: false, canWrite: false }, 'тріал закінчився — тариф без Контроль+');
    assert.deepEqual(dashboardAccess(ctx('repair_manager')), { finance: false, canWrite: false });
    assert.deepEqual(dashboardAccess(null), { finance: false, canWrite: false });
});

test('меню «Огляд» і маршрут #/dashboard: Контроль+ веде на дашборд, сайтовий «Огляд компанії» не змінено', () => {
    const item = SHELL_ITEMS.find((i) => i.key === 'overview');
    assert.equal(item.kind, 'hash');
    assert.equal(item.hash, '#/dashboard');
    assert.deepEqual(parseCrmHash('#/dashboard'), { view: 'dashboard' });
    assert.equal(parseCrmHash('#/dashboard/x'), null);
    assert.equal(tabOf({ view: 'dashboard' }), 'dashboard');
    assert.equal(activeKey({ hash: '#/dashboard', studioView: 'calc', cabinetOpen: false }), 'overview');
    assert.equal(activeKey({ hash: '', studioView: 'overview', cabinetOpen: false }), 'overview', 'сайтовий огляд теж підсвічує «Огляд»');
    const bridge = read('src/bridge.js');
    assert.match(bridge, /\['overview', 'Огляд', go\('#\/dashboard'\), false\]/);
    assert.match(bridge, /route\.view === 'dashboard'\) view = lazyView\(\(\) => import\('\.\/views\/dashboard\.js'\)/);
    assert.match(bridge, /openSite: \(view\) => openSite\(view\)\(\)/, 'дашборд відкриває розділи сайту наявним openSite');
});

test('швидкі дії й рядки списків відкривають вікна PR 3 (hash-маршрути вікон) і доступні лише за правами', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    assert.deepEqual(windowSpecOf(parseCrmHash('#/requests/' + id), '#/requests/' + id), { type: 'request', id, key: 'request:' + id });
    const form = windowSpecOf(parseCrmHash('#/docs/new/invoice'), '#/docs/new/invoice');
    assert.equal(form.type, 'form');
    const client = windowSpecOf(parseCrmHash('#/clients/' + id), '#/clients/' + id);
    assert.equal(client.type, 'client');
    const src = read('src/views/dashboard.js');
    assert.match(src, /href: '#\/requests\/' \+ encodeURIComponent\(r\.id\)/);
    assert.match(src, /href: '#\/clients\/' \+ encodeURIComponent\(r\.client_id\)/);
    assert.match(src, /id: 'kpd-new-invoice', href: '#\/docs\/new\/invoice'/);
    assert.match(src, /id: 'kpd-calc', onclick: openSite\('calc'\)/);
    assert.doesNotMatch(src, new RegExp('Нова заявка|kpd-new' + '-request'), 'окремого створення заявки немає — кнопки-дубля теж');
    const targets = [...src.matchAll(/id: '(kpd-[a-z-]+)', (?:onclick: openSite\('([a-z]+)'\)|href: '([^']+)')/g)].map((m) => m[2] || m[3]);
    assert.equal(new Set(targets).size, targets.length, 'усі швидкі дії ведуть у різні місця: ' + targets);
    assert.doesNotMatch(src, /fmtMoney|fmtAmount/, 'суми лише через fmtSum');
    assert.match(src, /id: 'kpd-registry', onclick: openSite\('registry'\)/);
    assert.match(src, /fin && canWrite \? h\('a'/, '«Новий рахунок» лише тим, хто може створювати');
    assert.match(src, /disabled: true, title: READ_ONLY_HINT/, 'без прав кнопки disabled з підказкою');
});

test('лише наявні RPC під RLS: список викликів дашборда = DASHBOARD_RPCS; жодних таблиць, innerHTML, нових функцій', () => {
    const src = read('src/views/dashboard.js');
    const used = new Set([...src.matchAll(/(?:call\(app,|loadRows|rpc\()\s*'([a-z_]+)'/g)].map((m) => m[1]));
    for (const m of src.matchAll(/call\(app, '([a-z_]+)'/g)) used.add(m[1]);
    assert.deepEqual([...used].sort(), [...DASHBOARD_RPCS].sort());
    const allowed = ['registry_totals', 'registry_list', 'report_plan_fact', 'kp_client_debts', 'kp_unpaid_invoices_count', 'kp_doc_list', 'registry_documents', 'kp_trip_sheet_list'];
    for (const name of DASHBOARD_RPCS) assert.ok(allowed.includes(name), name);
    // кожна RPC є в міграціях, а нової міграції PR не додає
    const migrations = fs.readdirSync(path.join(APP, '../../supabase/migrations')).map((f) => fs.readFileSync(path.join(APP, '../../supabase/migrations', f), 'utf8')).join('\n');
    for (const name of DASHBOARD_RPCS) assert.match(migrations, new RegExp('FUNCTION public\\.' + name + '\\('), name + ' є в міграціях');
    assert.doesNotMatch(src, /supabase\.from\(|\.from\('/);
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.doesNotMatch(read('src/lib/dashboard.js'), /innerHTML/);
    assert.doesNotMatch(src, /fetch\(|\/api\//, 'жодних Vercel-функцій');
});

test('CSS дашборда: лише змінні тем — жодних hex / rgb / hsl', () => {
    const css = read('src/kp-dashboard.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'hex-колір');
    assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklch|oklab)\(/i);
    assert.doesNotMatch(css, /\b(?:white|black|red|green|blue|gray|grey|orange|yellow)\b\s*[;}]/i, 'іменовані кольори');
    assert.match(css, /var\(--font-mono/, 'числа — JetBrains Mono');
    assert.match(css, /tabular-nums/);
    assert.match(css, /@media \(max-width: 900px\)/);
    assert.match(css, /repeat\(5, minmax\(0, 1fr\)\)/, '≥1200 — 5 KPI в ряд');
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-dashboard\.css';/);
});

test('сайт не змінено: index.html у цьому PR не чіпали, «Огляд компанії» сайту на місці', () => {
    const site = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');
    assert.match(site, /id="studio-nav-overview"/);
    assert.match(site, /function renderStudioOverview\(/);
    assert.doesNotMatch(site, /kp-dashboard|#\/dashboard|renderDashboard/);
});

// ---------------- Браузерна перевірка рендеру (без playwright-core / Chrome — пропуск) ----------------
async function loadBrowser() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
    for (const executablePath of candidates) {
        try { return await pw.chromium.launch({ executablePath, headless: true }); } catch { /* наступний */ }
    }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const PAGE = `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-dashboard.css">
<style>:root{--font-mono:'JetBrains Mono',ui-monospace,monospace} body{margin:0;padding:14px 18px;font-family:system-ui,sans-serif;background:var(--bg-page,Canvas)} body[data-theme=light]{background:#F4EFE4} body[data-theme=dark]{background:#0E1117}</style></head>
<body><section id="kp-crm"></section><script type="module">
const q = new URLSearchParams(location.search);
document.body.dataset.theme = q.get('theme') || 'light'; document.body.dataset.kpView = 'dashboard';
const { makeFixture, makeRows } = await import('/tests/helpers/dashboard-fixture.mjs');
const { renderDashboard } = await import('/src/views/dashboard.js');
const fx = makeFixture({ role: q.get('role') || 'owner', fail: (q.get('fail') || '').split(',').filter(Boolean), delay: Number(q.get('delay') || 0),
    rows: q.get('empty') ? [] : makeRows(Number(q.get('rows') || 14)), plan: q.get('plan') !== '0' });
window.__calls = fx.calls;
const nav = [];
const app = { supabase: { rpc: fx.rpc }, context: fx.context, openSite: (v) => nav.push(v), onCleanup() {}, onPlanLost() { nav.push('plan-lost'); } };
window.__nav = nav;
const store = new Map(); if (q.get('custom')) { const [f, t] = q.get('custom').split(','); store.set('kp.dashboard.period', JSON.stringify({ kind: 'custom', from: f, to: t })); }
document.getElementById('kp-crm').append(renderDashboard(app, { today: () => '2026-11-18', storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } }));
window.__store = store;
window.__ready = true;
</script></body></html>`;

async function withDashboard(t, fn) {
    const browser = await loadBrowser();
    if (!browser) { t.skip('no playwright-core / Chrome'); return; }
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(PAGE); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    try { await fn(browser, base); } finally { await browser.close(); server.close(); }
}

const SHOTS = process.env.KP_SHOTS_DIR || null;

test('браузер: skeleton → дані, без горизонтального скролу, числа не обрізані (1920, 1366, 1024, 390; світла й темна)', async (t) => {
    await withDashboard(t, async (browser, base) => {
        for (const [w, hgt] of [[1920, 900], [1366, 768], [1024, 768], [390, 844]]) {
            for (const theme of ['light', 'dark']) {
                const page = await browser.newPage({ viewport: { width: w, height: hgt } });
                const errors = [];
                page.on('pageerror', (e) => errors.push(String(e)));
                await page.goto(base + '?theme=' + theme + '&delay=250');
                await page.waitForFunction(() => window.__ready === true);
                assert.ok(await page.locator('.kpd-skel').count() > 0, 'skeleton до даних (' + w + ')');
                await page.waitForFunction(() => document.querySelectorAll('.kpd-skel').length === 0 && document.querySelectorAll('[aria-busy="true"]').length === 0, null, { timeout: 8000 });
                const m = await page.evaluate(() => {
                    const clipped = [...document.querySelectorAll('.kpd-kpi-value, .kpd-kpi-sub, .kpd-row-side .kpd-mono')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className + ':' + el.textContent);
                    const cols = getComputedStyle(document.querySelector('.kpd-kpis')).gridTemplateColumns.split(' ').length;
                    const gridCols = getComputedStyle(document.querySelector('.kpd-grid')).gridTemplateColumns.split(' ').length;
                    return {
                        overflow: document.documentElement.scrollWidth - window.innerWidth, clipped, cols, gridCols, kpis: document.querySelectorAll('.kpd-kpi').length,
                        bars: document.querySelectorAll('.kpd-bar').length, rows: document.querySelectorAll('.kpd-list li').length, value: document.querySelector('[data-kpi="revenue"] .kpd-kpi-value').textContent,
                        mono: getComputedStyle(document.querySelector('.kpd-kpi-value .kpd-mono')).fontVariantNumeric,
                    };
                });
                assert.ok(m.overflow <= 0, 'немає горизонтального скролу при ' + w + ' (' + theme + '): ' + m.overflow);
                assert.deepEqual(m.clipped, [], 'числа не обрізані при ' + w);
                assert.equal(m.kpis, 5);
                assert.ok(m.bars >= 18 && m.rows > 0 && /₴/.test(m.value), 'дані намальовано: ' + JSON.stringify(m));
                assert.match(m.mono, /tabular-nums/);
                if (w >= 1200) { assert.equal(m.cols, 5, '5 KPI в ряд'); assert.equal(m.gridCols, 2, 'дві колонки'); }
                else if (w > 900) assert.equal(m.cols, 6, '3+2');
                else { assert.equal(m.cols, 1); assert.equal(m.gridCols, 1); }
                assert.deepEqual(errors, []);
                if (SHOTS && (w === 1366 || w === 1920)) await page.screenshot({ path: path.join(SHOTS, `dashboard-${w}-${theme}.png`) });
                await page.close();
            }
        }
    });
});

test('браузер: тултіп на hover і фокус, період зберігається в kp.dashboard.period, свій період перевіряється', async (t) => {
    await withDashboard(t, async (browser, base) => {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base);
        await page.waitForSelector('.kpd-bar');
        assert.equal(await page.locator('.kpd-tip').isHidden(), true);
        await page.locator('.kpd-bar').nth(4).hover();
        assert.equal(await page.locator('.kpd-tip').isVisible(), true);
        assert.match(await page.locator('.kpd-tip').innerText(), /₴.*\n?.*заявок/s);
        await page.mouse.move(5, 5);
        await page.locator('.kpd-bar').nth(2).focus();
        assert.equal(await page.locator('.kpd-tip').isVisible(), true, 'тултіп і з клавіатури');
        await page.getByRole('radio', { name: 'Тиждень' }).click();
        await page.waitForFunction(() => window.__store.get('kp.dashboard.period') === '{"kind":"week"}');
        const calls = await page.evaluate(() => window.__calls.filter((c) => c.name === 'registry_totals').slice(-3).map((c) => c.args.p_filters));
        assert.ok(calls.some((f) => f.from === '2026-11-12' && f.to === '2026-11-18'), 'період тижня пішов у RPC');
        assert.ok(calls.some((f) => f.from === '2026-11-05' && f.to === '2026-11-11'), 'попередній період');
        await page.getByRole('radio', { name: 'Свій' }).click();
        await page.locator('.kpd-date').first().fill('2026-11-20');
        await page.locator('.kpd-date').first().dispatchEvent('change');
        assert.equal(await page.locator('.kpd-head ~ p.kpd-soft-error').first().isVisible(), true, 'from > to — повідомлення, не падіння');
        await page.close();
    });
});

test('браузер: помилка однієї RPC — тиха картка, решта працює; порожній стан з дією; ролі й read-only', async (t) => {
    await withDashboard(t, async (browser, base) => {
        let page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?fail=kp_client_debts,registry_documents');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.ok(await page.locator('.kpd-bar').count() > 0, 'графік працює, хоча дебіторка впала');
        assert.match(await page.locator('[data-kpi="debt"]').innerText(), /Не вдалося|—/);
        assert.ok(await page.locator('.kpd-card .kpd-soft-error').count() >= 2, 'помилки лишились у картках');
        await page.close();

        page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?fail=registry_totals,registry_list');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.equal(await page.locator('.kpd-bar').count(), 0);
        assert.ok(await page.locator('.kpd-soft-error').count() >= 3);
        await page.close();

        page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?empty=1');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.match(await page.locator('.kpd-card-chart').innerText(), /Ще немає заявок за період/);
        await page.getByRole('button', { name: 'Розрахувати рейс' }).first().click();
        assert.deepEqual(await page.evaluate(() => window.__nav), ['calc']);
        await page.close();

        // Директор (перегляд): фінанси є, кнопки створення disabled з підказкою, «Новий рахунок» немає.
        page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?role=director');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.equal(await page.locator('[data-kpi="debt"]').count(), 1);
        assert.equal(await page.locator('#kpd-calc').isDisabled(), true);
        assert.match(await page.locator('#kpd-calc').getAttribute('title'), /Лише перегляд/);
        assert.equal(await page.locator('#kpd-new-invoice').count(), 0);
        assert.ok((await page.evaluate(() => window.__calls)).some((c) => c.name === 'registry_totals' && c.args.p_filters.org_id), 'директор читає компанію явним org_id');
        await page.close();

        // Власник: усе доступно, швидкі дії ведуть у розділи.
        page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base);
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.equal(await page.locator('#kpd-calc').isDisabled(), false);
        assert.equal(await page.locator('#kpd-new-invoice').getAttribute('href'), '#/docs/new/invoice');
        await page.locator('#kpd-registry').click();
        await page.getByRole('button', { name: 'Детальний огляд →' }).click();
        assert.deepEqual(await page.evaluate(() => window.__nav), ['registry', 'overview']);
        assert.equal(await page.locator('[data-kpi="debt"]').count(), 1);
        await page.close();

        // Без тарифу (тріал закінчився) і роль без доступу до документів: фінансових карток немає і RPC документів не викликаються.
        page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?plan=0');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.equal(await page.locator('[data-kpi="debt"]').count(), 0);
        assert.equal(await page.locator('#kpd-calc').isDisabled(), true);
        const names = (await page.evaluate(() => window.__calls)).map((c) => c.name);
        assert.ok(!names.some((n) => n.startsWith('kp_') || n === 'registry_documents'), 'фінансові RPC не викликались: ' + names);
        await page.close();
    });
});

test('браузер: усі суми в одному форматі; свій період у майбутнє — графік до сьогодні', async (t) => {
    await withDashboard(t, async (browser, base) => {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?custom=2026-11-10,2026-11-25');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        const text = await page.evaluate(() => document.querySelector('.kpd').innerText);
        assert.doesNotMatch(text, /грн|\d,\d\d\b/, 'без «грн» і копійок');
        const sums = await page.evaluate(() => [...document.querySelectorAll('.kpd-kpi-value, .kpd-row-side .kpd-mono, .kpd-kpi-sub .kpd-mono')].map((e) => e.textContent.replace(/\s/g, ' ')));
        assert.ok(sums.length >= 8);
        for (const s of sums) assert.match(s, /^[\d ]+ ₴( \+ інші валюти)?$|^\d+$/, 'формат: ' + s);
        const fonts = await page.evaluate(() => [...document.querySelectorAll('.kpd-kpi-value .kpd-mono, .kpd-row-side .kpd-mono')].every((e) => /JetBrains Mono/.test(getComputedStyle(e).fontFamily) && /tabular-nums/.test(getComputedStyle(e).fontVariantNumeric)));
        assert.equal(fonts, true, 'JetBrains Mono + tabular-nums');
        assert.equal(await page.locator('.kpd-bar').count(), 9, '10–18.11 включно, без 19–25');
        await page.close();
    });
});

test('браузер: понад 1000 заявок — «агреговано за перші N», сторінки по 200', async (t) => {
    await withDashboard(t, async (browser, base) => {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?rows=1300');
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0);
        assert.match(await page.locator('.kpd-note').innerText(), /Агреговано за перші 1000 із 1300/);
        const lists = await page.evaluate(() => window.__calls.filter((c) => c.name === 'registry_list').map((c) => [c.args.p_limit, c.args.p_offset]));
        assert.deepEqual(lists, [[200, 0], [200, 200], [200, 400], [200, 600], [200, 800]]);
        const docs = await page.evaluate(() => window.__calls.find((c) => c.name === 'registry_documents').args.p_calcs.length);
        assert.ok(docs <= 200);
        await page.close();
    });
});
