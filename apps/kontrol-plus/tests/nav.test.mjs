import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normPlate, plateMatches } from '../src/lib/plates.js';
import { DOC_TABS, legacyRedirect, parseCrmHash, tabOf } from '../src/lib/route.js';
import { COUNTED_STATUSES, byMonth, countedRows, monthsChartShapes, summarize } from '../src/lib/stats.js';
import { NAV_ICON_NAMES } from '../src/nav-icons.js';
import { vehicleRows } from '../src/views/fleet.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const css = read('src/crm.css');
const bridge = read('src/bridge.js');

test('держномер: нормалізація кирилиця → латиниця, без пробілів і дефісів, регістр не важливий', () => {
    assert.equal(normPlate('аа 4821 кт'), normPlate('AA4821KT'));
    assert.equal(normPlate('аа 4821 кт'), 'AA4821KT');
    assert.equal(normPlate('AA-4821-KT'), 'AA4821KT');
    assert.equal(normPlate('ВС 7705 ОА'), 'BC7705OA');
    assert.equal(normPlate(null), '');
    for (const query of ['4821', 'aa4821', 'аа 48', 'КТ', 'aa 4821 kt', '4821-kt']) assert.equal(plateMatches('AA 4821 KT', query), true, query);
    assert.equal(plateMatches('AA 4821 KT', ''), true, 'порожнє поле показує все');
    assert.equal(plateMatches('AA 4821 KT', '9999'), false);
});

test('автопарк: рядки таблиць Авто / Причепи з kp_vehicles_list; фільтр працює на обох вкладках', () => {
    const vehicles = [
        { label: 'AA 4821 KT', make_model: 'DAF XF', vehicle_type: 'Тягач', service_on: '2026-11-02', trailer_plate: 'AA 2210 XP', trailer_make_model: 'Schmitz', trailer_type: 'зерновоз' },
        { label: 'BC 7705 OA', make_model: 'MAN TGX', vehicle_type: 'Тягач', service_on: null, trailer_plate: null },
    ];
    const cars = vehicleRows(vehicles, 'cars', '2026-10-27');
    assert.deepEqual(cars.map((r) => r.plate), ['AA 4821 KT', 'BC 7705 OA']);
    assert.equal(cars[0].service, '2026-11-02');
    const trailers = vehicleRows(vehicles, 'trailers', '2026-10-27');
    assert.deepEqual(trailers.map((r) => r.plate), ['AA 2210 XP']);
    assert.equal(trailers[0].model, 'Schmitz');
    assert.deepEqual(cars.filter((r) => plateMatches(r.plate, 'ка 77')).map((r) => r.plate), [], '«ка 77» не збігається');
    assert.deepEqual(cars.filter((r) => plateMatches(r.plate, 'вс 77')).map((r) => r.plate), ['BC 7705 OA']);
    const view = read('src/views/fleet.js');
    assert.match(view, /Нічого не знайдено/);
    assert.match(view, /kpf-clear/);
    assert.equal(/class: 'chip|chips/.test(view), false, 'чіпів-зразків немає');
    assert.match(view, /placeholder: 'напр\. 4821'/);
});

test('маршрути: нові розділи, підвкладки і редіректи зі старих #/docs/…', () => {
    assert.deepEqual(parseCrmHash('#/fleet'), { view: 'fleet', sub: 'cars' });
    assert.deepEqual(parseCrmHash('#/fleet/trailers'), { view: 'fleet', sub: 'trailers' });
    assert.deepEqual(parseCrmHash('#/drivers'), { view: 'drivers' });
    assert.deepEqual(parseCrmHash('#/company'), { view: 'company' });
    assert.deepEqual(parseCrmHash('#/stats'), { view: 'stats' });
    assert.deepEqual(parseCrmHash('#/report/debts'), { view: 'report', sub: 'debts' });
    for (const tab of DOC_TABS) assert.deepEqual(parseCrmHash('#/docs/tab/' + tab), { view: 'docs', sub: 'list', tab });
    assert.equal(parseCrmHash('#/docs/tab/zzz'), null);
    assert.equal(parseCrmHash('#/fleet/x'), null);
    assert.equal(legacyRedirect('#/docs/fleet'), '#/fleet');
    assert.equal(legacyRedirect('#/docs/requisites'), '#/company');
    assert.equal(legacyRedirect('#/docs/debts'), '#/report/debts');
    assert.equal(legacyRedirect('#/docs/debts?x=1'), '#/report/debts');
    assert.equal(legacyRedirect('#/docs'), null);
    assert.equal(legacyRedirect('#/report'), null);
    assert.equal(legacyRedirect(''), null);
    for (const view of ['fleet', 'drivers', 'company', 'stats']) assert.equal(tabOf({ view }), view);
    assert.equal(tabOf({ view: 'report', sub: 'debts' }), 'report');
    assert.match(bridge, /legacyRedirect\(location\.hash\)/);
    assert.match(bridge, /history\.replaceState\(null, '', location\.pathname \+ location\.search \+ moved\)/);
});

test('меню: порядок, підписи, іконки inline SVG, згортання до іконок на ≤1024', async () => {
    const { NAV_ITEMS } = await import('../src/bridge.js');
    assert.deepEqual(NAV_ITEMS.map((item) => item[1]),
        ['Огляд', 'Розрахунки', 'Клієнти', 'Автопарк', 'Водії', 'Ремонти', 'GPS', 'Документи', 'План/факт', 'Статистика', 'Реквізити компанії']);
    for (const [key] of NAV_ITEMS) assert.ok(NAV_ICON_NAMES.includes(key), 'іконка для ' + key);
    const icons = read('src/nav-icons.js');
    assert.match(icons, /svgEl\('svg', \{ viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor'/);
    assert.equal(/[▦∑⛟☺▤⇄◔☰]/.test(icons), false, 'символів шрифту немає');
    assert.match(css, /@media \(max-width: 1024px\) \{\s+body\.kp-nav-on \{ --kp-nav-w: 60px; \}/);
    assert.match(css, /#kp-side \.kp-nav button \.lb \{ display: none; \}/);
    assert.match(bridge, /title: label/, 'підказки title на кнопках меню');
});

test('реквізити компанії: рядки grid 160px auto, поле одразу за підписом, ширини за змістом, картка по центру', () => {
    assert.match(css, /\.kpr-req \.form \{ display: block; max-width: 640px; margin-inline: auto;/);
    assert.match(css, /\.kpr-req \.form \.field \{ display: grid; grid-template-columns: 160px auto; column-gap: 12px;[^}]*justify-content: start;/);
    const block = css.slice(css.indexOf('/* ===== Реквізити компанії'), css.indexOf('/* ===== Статистика'));
    assert.equal(/space-between|margin-left: auto/.test(block), false);
    assert.match(block, /input#q-iban \{ width: 300px; \}/);
    assert.match(block, /input#q-edrpou[^{]*\{ width: 140px; \}/);
    assert.match(block, /input#q-legal_name[^{]*\{ width: 360px; \}/);
    assert.match(block, /\.field > select \{ width: 100px; \}/);
    assert.match(block, /text-align: left;/);
    assert.match(block, /\.form \.actions \{ justify-content: flex-end;/);
    const company = read('src/views/company.js');
    assert.match(company, /kpr-req/);
    assert.match(company, /renderRequisites\(app, access\)/);
    // Логіку збереження не міняли: kp_requisites_save і та сама валідація.
    const requisites = read('src/views/docs-requisites.js');
    assert.match(requisites, /rpc\('kp_requisites_save', \{ p_data: data \}\)/);
});

test('документи: підвкладки Усі · Договори · ТТН / 2-ТН · Акти · Інше, борги / автопарк / реквізити звідти прибрані', () => {
    const docs = read('src/views/docs.js');
    const labels = [...docs.slice(docs.indexOf('export function docsTabs()'), docs.indexOf('const TAB_KIND')).matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['Усі', 'Договори', 'ТТН / 2-ТН', 'Акти', 'Інше']);
    assert.equal(/renderDebts|renderRequisites|renderFleet/.test(docs), false);
    assert.match(docs, /Договорів ще немає/);
    assert.match(docs, /TAB_KIND = \{ ttn: 'ttn', acts: 'act' \}/);
});

test('план/факт: підвкладки План/факт · Борги, звіт без змін', () => {
    const report = read('src/views/report.js');
    assert.match(report, /\{ sub: 'main', hash: '#\/report', label: 'План\/факт' \}/);
    assert.match(report, /\{ sub: 'debts', hash: '#\/report\/debts', label: 'Борги' \}/);
    assert.match(report, /exportBtn\),\s+reportTabs\('main'\)/);
    assert.match(bridge, /import\('\.\/views\/docs-debts\.js'\)/);
});

test('водії: режим «drivers» docs-fleet, порожній стан «Скоро тут будуть водії», без нових таблиць', () => {
    const fleet = read('src/views/docs-fleet.js');
    assert.match(fleet, /mode === 'drivers'/);
    assert.match(fleet, /Скоро тут будуть водії/);
    assert.match(read('src/views/drivers.js'), /renderFleet\(app, access, 'drivers'\)/);
});

test('статистика: плитки (рейси, дохід, прибуток, км, дохід на км) і графік по місяцях з наявних розрахунків', () => {
    const rows = [
        { trip_date: '2026-10-05', distance_km: 500, revenue: 100000, profit: 20000, status: 'accepted' },
        { trip_date: '2026-10-20', distance_km: 300, revenue: 60000, profit: 10000, status: 'done' },
        { trip_date: '2026-10-21', distance_km: 999, revenue: 999999, profit: 99999, status: 'draft' },
        { created_at: '2026-09-10T08:00:00Z', distance_km: 200, revenue: 30000, profit: 5000, status: 'accepted' },
    ];
    assert.deepEqual(COUNTED_STATUSES, ['accepted', 'done']);
    const october = summarize(countedRows(rows, '2026-10-01', '2026-10-31'));
    assert.deepEqual(october, { trips: 2, revenue: 160000, profit: 30000, km: 800, revenuePerKm: 200 });
    assert.equal(summarize([]).revenuePerKm, null);
    const months = byMonth(rows, '2026-10-27', 6);
    assert.deepEqual(months.map((m) => m.key), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    assert.equal(months[4].revenue, 30000);
    assert.equal(months[5].trips, 2);
    const shapes = monthsChartShapes(months);
    assert.equal(shapes.filter(([tag]) => tag === 'rect').length, 12);
    const view = read('src/views/stats.js');
    for (const label of ['Рейси', 'Дохід', 'Прибуток', 'Кілометри', 'Дохід на км']) assert.ok(view.includes("'" + label + "'"), label);
    assert.match(view, /svgEl\('svg'/);
});
