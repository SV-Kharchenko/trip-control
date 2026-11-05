// «Власний парк → Телематика»: справжній інтерфейс у браузері (справжні стилі, lazy-модуль views/own-fleet/) на макеті Supabase.
// Огляд (таблиця / картки, зливи підсвічені, фільтри), імпорт .csv і .xlsx з мапінгом і звітом, тестові дані лише для mock-джерела,
// зіставлення техніки, дрібні фікси (підказка «Центр витрат», панель дошки). Без playwright-core / Chromium — пропуск.
// Скріни: KP_TM_SHOTS=<тека> node --test tests/telematics-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleFakeConfig } from '../../../tests/helpers/fake-config.mjs';
import { buildXlsx } from '../src/lib/xlsx.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');
const siteCss = [...SITE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

const U1 = '82000000-0000-0000-0000-000000000001';
const U2 = '82000000-0000-0000-0000-000000000002';
const V1 = 'v1';
const V2 = 'v2';

function fixtures() {
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    return {
        org_units: [{ id: U1, org_id: 'o1', name: 'Агро Північ', kind: 'agro', cost_center: 'ЦВ-1', archived: false }, { id: U2, org_id: 'o1', name: 'Елеватор', kind: 'elevator', cost_center: null, archived: false }],
        telematics_sources: [{ id: 'src-mock', kind: 'agrocontrol_mock', name: 'Агроконтроль (тестові дані)', status: 'active', last_sync_at: iso(1) }],
        telematics_templates: [],
        telematics_vehicle_units: [{ vehicle_id: V1, unit_id: U1 }],
        telematics_fuel_events: [
            { id: 'e1', kind: 'drain', ts: iso(2), external_vehicle_ref: 'AA1111AA', vehicle_id: V1, liters: '46.0', location: 'Поле 12' },
            { id: 'e2', kind: 'drain', ts: iso(5), external_vehicle_ref: 'ZZ0000ZZ', vehicle_id: null, liters: '30.5', location: null },
        ],
        telematics_reports: [{ external_vehicle_ref: 'ZZ0000ZZ', date: '2026-05-01', vehicle_id: null }, { external_vehicle_ref: 'ZZ0000ZZ', date: '2026-05-02', vehicle_id: null }],
        mock_summary: [
            { ref: 'AA1111AA', vehicle_id: V1, unit_id: U1, days: 30, mileage_km: '5000.0', fuel_used_l: '1750.0', idle_minutes: 2400, engine_hours: '200.0', drain_count: 2, drain_l: '90.0', refuel_l: '2000.0' },
            { ref: 'KE5555AX', vehicle_id: V2, unit_id: null, days: 25, mileage_km: '3000.0', fuel_used_l: '900.0', idle_minutes: 1200, engine_hours: '150.0', drain_count: 0, drain_l: '0', refuel_l: '1500.0' },
        ],
        drains: [
            { id: 'd1', ts: '2026-07-15T19:30:00Z', day: '2026-07-15', ref: 'AA1111AA', vehicle_id: V1, liters: '46.0', location: 'Поле 12' },
            { id: 'd2', ts: '2026-07-10T08:00:00Z', day: '2026-07-10', ref: 'ZZ0000ZZ', vehicle_id: null, liters: '30.5', location: null },
        ],
        mock_drains: [{ id: 'm1', ts: '2026-07-12T10:00:00Z', day: '2026-07-12', ref: 'AA1111AA', vehicle_id: V1, liters: '55.0', location: 'Поза маршрутом' }],
        summary: [
            { ref: 'AA1111AA', vehicle_id: V1, unit_id: U1, days: 20, mileage_km: '2610.0', fuel_used_l: '914.0', idle_minutes: 1850, engine_hours: '120.0', drain_count: 1, drain_l: '46.0', refuel_l: '1200.0' },
            { ref: 'KE5555AX', vehicle_id: V2, unit_id: null, days: 18, mileage_km: '1500.0', fuel_used_l: '450.0', idle_minutes: 300, engine_hours: '80.5', drain_count: 0, drain_l: '0', refuel_l: '600.0' },
            { ref: 'ZZ0000ZZ', vehicle_id: null, unit_id: null, days: 2, mileage_km: '100.0', fuel_used_l: null, idle_minutes: null, engine_hours: null, drain_count: 1, drain_l: '30.5', refuel_l: '0' },
        ],
    };
}

const ENTRY = `
import { renderOwnFleet, renderOwnFleetCard } from './src/views/own-fleet/index.js';
const cfg = window.__cfg;
const fx = window.__fx;
const calls = [];
window.__calls = calls;
function table(name) {
    const st = { filters: [] };
    const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, gte() { return q; }, lt() { return q; },
        eq(k, v) { st.filters.push([k, v, 'eq']); return q; },
        is(k, v) { st.filters.push([k, v, 'is']); return q; },
        then(res) {
            const rows = fx[name] || [];
            res({ data: rows.filter((r) => st.filters.every(([k, v]) => (r[k] === undefined ? null : r[k]) === v)), error: null });
        },
    };
    return q;
}
window.tcModal = async (o) => { calls.push(['modal', o]); return { ok: cfg.modalOk !== false }; };
let importCalls = 0;
const known = new Set(['AA1111AA', 'KE5555AX']);
const CYR = { 'А': 'A', 'В': 'B', 'Е': 'E', 'І': 'I', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X' };
const norm = (s) => String(s).toUpperCase().replace(/[\\s-]+/g, '').replace(/[АВЕІКМНОРСТХ]/g, (c) => CYR[c]);
const supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
    from: table,
    rpc: async (name, args) => {
        calls.push(['rpc', name, args]);
        if (name === 'kp_vehicles_list') return { data: [{ id: 'v1', label: 'AA 1111 AA', make_model: 'DAF XF' }, { id: 'v2', label: 'KE 5555 AX' }], error: null };
        if (name === 'kp_trailers_list') return { data: [], error: null };
        if (name === 'kp_driver_list') return { data: [], error: null };
        if (name === 'tm_summary') return { data: (args.p_mock ? fx.mock_summary : fx.summary).filter((r) => (!args.p_unit || r.unit_id === args.p_unit) && (!args.p_vehicle || r.vehicle_id === args.p_vehicle)), error: null };
        if (name === 'tm_drains') return { data: args.p_mock ? fx.mock_drains : fx.drains, error: null };
        if (name === 'tm_clear_mock') return { data: { reports: 12, events: 3 }, error: null };
        if (name === 'tm_ensure_source') {
            const kind = args.p_kind;
            const id = 'src-' + kind;
            if (!fx.telematics_sources.some((s) => s.id === id)) fx.telematics_sources.push({ id, kind, name: kind === 'file_import' ? 'Файли звітів' : 'Агроконтроль (тестові дані)', status: 'active', last_sync_at: null });
            return { data: id, error: null };
        }
        if (name === 'tm_import_reports' || name === 'tm_import_fuel_events') {
            importCalls += 1;
            if (cfg.failSecondChunk && importCalls >= 2) return { data: null, error: { message: 'boom' } };
            const rows = args.p_rows;
            const refs = new Set(rows.map((r) => norm(r.ref)));
            return { data: { added: rows.length, updated: 0, skipped: 0, unmapped: [...refs].filter((r) => !known.has(r)).length }, error: null };
        }
        if (name === 'tm_set_vehicle_map') { fx.telematics_reports = fx.telematics_reports.filter((r) => r.external_vehicle_ref !== args.p_ref); fx.telematics_fuel_events = fx.telematics_fuel_events.filter((r) => r.external_vehicle_ref !== args.p_ref); return { data: 2, error: null }; }
        if (name === 'tm_set_vehicle_unit' || name === 'tm_save_template') return { data: null, error: null };
        return { data: null, error: null };
    },
};
const ownFleet = { org_id: 'o1', role: cfg.role || 'owner', unit_ids: [] };
const app = { supabase, ownFleet, user: { id: 'u1' }, go: (hash) => { location.hash = hash; }, onCleanup() {} };
const root = document.createElement('main'); root.id = 'kp-crm';
document.body.setAttribute('data-kp-view', 'own-fleet');
document.body.append(root);
if (cfg.card) root.append(renderOwnFleetCard(app, cfg.card, null));
else root.append(renderOwnFleet(app, { view: 'own-fleet', sub: cfg.sub }));
window.__ready = true;
`;

const PAGE = (cfg, fx) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css"><link rel="stylesheet" href="/src/kp-win-scope.css"><link rel="stylesheet" href="/src/kp-own-fleet.css">
</head><body class="layout-studio kp-shell-on" data-theme="${cfg.theme}"><script>window.__cfg = ${JSON.stringify(cfg)}; window.__fx = ${JSON.stringify(fx)};</script><script type="module" src="/entry.js"></script></body></html>`;

async function run(t, cfg, viewport, fn) {
    let pw; let esbuild;
    try { pw = await import('playwright-core'); esbuild = await import('esbuild'); } catch { t.skip('no playwright-core / esbuild'); return; }
    let browser;
    try { browser = await pw.chromium.launch({ headless: true }); } catch { t.skip('no Chromium'); return; }
    const built = await esbuild.build({ stdin: { contents: ENTRY, resolveDir: APP, sourcefile: 'entry.js' }, bundle: true, format: 'esm', write: false, absWorkingDir: APP,
        loader: { '.css': 'empty' }, logLevel: 'silent' });
    esbuild.stop();
    const js = built.outputFiles[0].text;
    const fx = { ...fixtures(), ...(cfg.fx || {}) };
    const server = createServer((req, res) => {
        if (handleFakeConfig(req, res)) return;
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(cfg, fx)); return; }
        if (url.pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(siteCss); return; }
        if (url.pathname === '/entry.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(js); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('http://127.0.0.1:' + server.address().port + '/');
        await page.waitForFunction(() => window.__ready === true);
        await fn(page, fx);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); server.close(); }
}

const shot = async (page, name) => {
    const dir = process.env.KP_TM_SHOTS;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name) });
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const cfgOf = (theme, extra = {}) => ({ theme, sub: 'telematics', ...extra });
const rpcCalls = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === 'rpc' && c[1] === n).map((c) => c[2]), name);
const csvFile = (text) => ({ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + text, 'utf8') });

const VIEWPORTS = [['390', { width: 390, height: 844 }], ['1024', { width: 1024, height: 768 }], ['1366', { width: 1366, height: 800 }], ['1920', { width: 1920, height: 1080 }]];

for (const [name, viewport] of VIEWPORTS) {
    for (const theme of ['light', 'dark']) {
        test(`огляд ${name} ${theme}: таблиця по авто, зливи підсвічені, л/100 км, без горизонтального скролу; ${name === '390' ? 'картки' : 'таблиця'}`, async (t) => {
            await run(t, cfgOf(theme), viewport, async (page) => {
                await page.waitForSelector('.kpt-table tbody tr');
                assert.equal(await page.locator('.kpt-table tbody tr').count(), 3);
                const first = await page.$$eval('.kpt-table tbody tr:first-child td', (tds) => tds.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
                assert.equal(first[0], 'AA 1111 AA · DAF XF');
                assert.equal(first[1], 'Агро Північ');
                assert.match(first[2], /2\s?610,0/);
                assert.match(first[4], /35,0/, '914 л / 2610 км = 35,0 л/100 км');
                assert.equal(first[5], '30 г 50 хв');
                assert.match(first[6], /1 · 46,0 л/);
                assert.equal(await page.locator('.kpt-drain').first().isVisible(), true);
                assert.equal(await page.locator('.kpt-table tr.kpt-row-drain').count(), 2, 'два авто зі зливами підсвічені');
                assert.match(await page.textContent('.kpt-table tbody tr:nth-child(3)'), /не зіставлено/);
                assert.match(await page.textContent('.kpt-total'), /2 зливи за період/);
                assert.equal(await noOverflow(page), true, 'сторінка не скролиться вбік');
                const display = await page.$eval('.kpt-table tbody tr', (tr) => getComputedStyle(tr).display);
                assert.equal(display, name === '390' ? 'block' : 'table-row', name === '390' ? 'на телефоні — картки' : 'таблиця');
                await shot(page, `telematics-overview-${name}-${theme}.png`);
            });
        });
    }
}

test('огляд: фільтри (підрозділ, авто, період) викликають tm_summary з параметрами', async (t) => {
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        await page.selectOption('select[aria-label="Підрозділ"]', U1);
        await page.waitForFunction(() => document.querySelectorAll('.kpt-table tbody tr').length === 1);
        assert.deepEqual((await rpcCalls(page, 'tm_summary')).at(-1).p_unit, U1);
        await page.selectOption('select[aria-label="Підрозділ"]', '');
        await page.selectOption('select[aria-label="Авто"]', V2);
        await page.waitForFunction(() => document.querySelectorAll('.kpt-table tbody tr').length === 1);
        assert.equal((await rpcCalls(page, 'tm_summary')).at(-1).p_vehicle, V2);
        await page.selectOption('select[aria-label="Авто"]', '');
        await page.fill('input[aria-label="Період з"]', '2026-01-01');
        await page.dispatchEvent('input[aria-label="Період з"]', 'change');
        await page.waitForFunction(() => window.__calls.filter((c) => c[1] === 'tm_summary').at(-1)[2].p_from === '2026-01-01');
        assert.ok(await page.locator('.kpt-drain-list li').count() >= 1, 'перелік зливів за період');
        assert.match(await page.textContent('.kpt-drain-list li'), /22:30/, 'час зливу — київський: 19:30 UTC влітку = 22:30');
    });
});

test('джерела: «Синхронізувати (тестові дані)» лише для mock; без джерела — «Підключити»; API-джерело без кнопки', async (t) => {
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-source');
        assert.equal(await page.locator('[data-act="sync-mock"]').count(), 1);
        assert.equal(await page.locator('[data-act="connect-mock"]').count(), 0);
        await page.click('[data-act="sync-mock"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'tm_import_fuel_events'));
        const reports = (await rpcCalls(page, 'tm_import_reports'))[0];
        assert.equal(reports.p_source, 'src-mock');
        assert.ok(reports.p_rows.length > 20, 'звіти за 30 днів для двох авто: ' + reports.p_rows.length);
        assert.deepEqual([...new Set(reports.p_rows.map((r) => r.ref))].sort(), ['AA 1111 AA', 'KE 5555 AX'], 'позначки = держномери без назви моделі');
        assert.deepEqual(Object.keys(reports.p_rows[0]).sort(), ['date', 'engine_hours', 'fuel_used_l', 'idle_minutes', 'mileage_km', 'raw', 'ref']);
    });
    await run(t, cfgOf('light', { fx: { telematics_sources: [{ id: 'src-file_import', kind: 'file_import', name: 'Файли звітів', status: 'active', last_sync_at: null }, { id: 'src-api', kind: 'agrocontrol_api', name: 'Агроконтроль (API)', status: 'paused', last_sync_at: null }] } }),
        { width: 1366, height: 800 }, async (page) => {
            await page.waitForSelector('.kpt-source');
            assert.equal(await page.locator('[data-act="sync-mock"]').count(), 0, 'для file_import і API синхронізації немає');
            assert.equal(await page.locator('[data-act="connect-mock"]').count(), 1);
            assert.match(await page.textContent('.kpt-sources'), /API Агроконтролю ще не підключено\./);
        });
    await run(t, cfgOf('light', { fx: { telematics_sources: [] } }), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('[data-act="connect-mock"]');
        await page.click('[data-act="connect-mock"]');
        await page.waitForSelector('[data-act="sync-mock"]');
        assert.deepEqual((await rpcCalls(page, 'tm_ensure_source')).at(-1), { p_kind: 'agrocontrol_mock' });
    });
});

const REPORT_CSV = 'Дата;Держномер;Пробіг, км;Витрата палива, л;Простій;Мотогодини\n'
    + '31.12.2025;АА 1111 АА;120,5;40,2;1:30;6,5\n'
    + '01.01.2026;KE-5555-AX;80;30;45;4\n'
    + '02.01.2026;ZZ 0000 ZZ;50;20;10;2\n'
    + '03.01.2026;KE5555AX;abc;1;1;1\n'
    + 'вчора;KE5555AX;1;1;1;1\n'
    + '04.01.2026;;5;5;5;5\n';

test('імпорт .csv: попередній перегляд, мапінг за заголовками, звіт «додано / оновлено / пропущено / незмеплено», помилки з номерами рядків', async (t) => {
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        await page.click('button[data-mode="import"]');
        await page.setInputFiles('#kpt-file', csvFile(REPORT_CSV));
        await page.waitForSelector('.kpt-preview');
        assert.equal(await page.locator('.kpt-preview tbody tr').count(), 5, 'перегляд: перші п’ять рядків');
        assert.equal(await page.inputValue('#kpt-map-date'), 'Дата');
        assert.equal(await page.inputValue('#kpt-map-ref'), 'Держномер');
        assert.equal(await page.inputValue('#kpt-map-mileage'), 'Пробіг, км');
        assert.equal(await page.inputValue('#kpt-map-fuel'), 'Витрата палива, л');
        await page.click('[data-act="import"]');
        await page.waitForSelector('.kpt-result');
        const sent = (await rpcCalls(page, 'tm_import_reports')).at(-1);
        assert.equal(sent.p_source, 'src-file_import');
        assert.deepEqual(sent.p_rows.map((r) => [r.date, r.ref, r.mileage_km, r.fuel_used_l, r.idle_minutes]),
            [['2025-12-31', 'АА 1111 АА', '120.5', '40.2', '90'], ['2026-01-01', 'KE-5555-AX', '80', '30', '45'], ['2026-01-02', 'ZZ 0000 ZZ', '50', '20', '10']]);
        const stats = await page.$$eval('.kpt-result [data-stat]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-stat'), Number(e.querySelector('b').textContent)])));
        assert.deepEqual(stats, { додано: 3, оновлено: 0, пропущено: 3, незмеплено: 1 });
        const errs = await page.$$eval('.kpt-error-list li', (li) => li.map((x) => x.textContent));
        assert.equal(errs.length, 3);
        assert.match(errs[0], /^Рядок 5: .*«Пробіг»: «abc» — не число/);
        assert.match(errs[1], /^Рядок 6: .*«Дата»: «вчора»/);
        assert.match(errs[2], /^Рядок 7: .*«Держномер» порожній/);
        assert.equal(await page.evaluate(() => window.__calls.some((c) => c[0] === 'fetch')), false);
        assert.equal(await noOverflow(page), true);
        await shot(page, 'telematics-import-1366-light.png');
    });
});

test('імпорт .xlsx і збереження шаблону мапінгу', async (t) => {
    const xlsx = Buffer.from(buildXlsx({ name: 'Звіт', columns: [12, 14, 10, 10], rows: [['Day', 'Plate', 'Dist', 'Litres'], [{ date: '2026-01-02' }, 'AA 1111 AA', 100.5, 35], [{ date: '2026-01-03' }, 'KE 5555 AX', 90, 30]] }));
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        await page.click('button[data-mode="import"]');
        await page.setInputFiles('#kpt-file', { name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx });
        await page.waitForSelector('.kpt-preview');
        assert.equal(await page.inputValue('#kpt-map-date'), '', '«Day» не вгадано — дату вказують вручну');
        assert.equal(await page.inputValue('#kpt-map-ref'), 'Plate', '«Plate» вгадано');
        await page.click('[data-act="import"]');
        assert.match(await page.textContent('.kpt-import .notice'), /Вкажіть колонки: Дата./);
        await page.selectOption('#kpt-map-date', 'Day');
        await page.selectOption('#kpt-map-ref', 'Plate');
        await page.selectOption('#kpt-map-mileage', 'Dist');
        await page.selectOption('#kpt-map-fuel', 'Litres');
        await page.click('[data-act="save-template"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'tm_save_template'));
        assert.deepEqual((await rpcCalls(page, 'tm_save_template'))[0], { p_kind: 'reports', p_mapping: { date: 'Day', ref: 'Plate', mileage: 'Dist', fuel: 'Litres' } });
        await page.click('[data-act="import"]');
        await page.waitForSelector('.kpt-result');
        const sent = (await rpcCalls(page, 'tm_import_reports')).at(-1);
        assert.deepEqual(sent.p_rows.map((r) => [r.date, r.ref, r.mileage_km, r.fuel_used_l]), [['2026-01-02', 'AA 1111 AA', '100.5', '35'], ['2026-01-03', 'KE 5555 AX', '90', '30']]);
    });
    // збережений шаблон застосовується до наступного файлу
    await run(t, cfgOf('light', { fx: { telematics_templates: [{ kind: 'reports', mapping: { date: 'Day', ref: 'Plate', mileage: 'Dist' } }] } }), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        await page.click('button[data-mode="import"]');
        await page.setInputFiles('#kpt-file', csvFile('Day;Plate;Dist\n02.01.2026;AA1111AA;10\n'));
        await page.waitForSelector('.kpt-preview');
        assert.deepEqual(await page.$$eval('.kpt-map select', (s) => s.map((x) => x.value)), ['Day', 'Plate', 'Dist', '', '', '']);
    });
});

test('імпорт заправок / зливів: окремий тип файлу, тип події за замовчуванням', async (t) => {
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        await page.click('button[data-mode="import"]');
        await page.selectOption('#kpt-kind', 'fuel_events');
        await page.setInputFiles('#kpt-file', csvFile('Дата і час;Авто;Тип;Літри;Місце\n31.12.2025 10:15;AA 1111 AA;Злив;45,5;Поле 12\n31.12.2025 11:00;AA 1111 AA;Заправка;200;АЗС\n31.12.2025 12:00;AA 1111 AA;;30;\n31.12.2025 13:00;AA 1111 AA;Злив;0;\n'));
        await page.waitForSelector('.kpt-preview');
        await page.click('[data-act="import"]');
        await page.waitForSelector('.kpt-result');
        const sent = (await rpcCalls(page, 'tm_import_fuel_events')).at(-1);
        assert.deepEqual(sent.p_rows.map((r) => [r.ts, r.kind, r.liters, r.location]),
            [['2025-12-31T10:15:00', 'drain', '45.5', 'Поле 12'], ['2025-12-31T11:00:00', 'refuel', '200', 'АЗС'], ['2025-12-31T12:00:00', 'drain', '30', '']]);
        assert.match(await page.textContent('.kpt-error-list'), /Рядок 5: .*більше нуля/);
    });
});

test('імпорт: неправильний файл — повідомлення, а не alert', async (t) => {
    await run(t, cfgOf('light'), { width: 390, height: 844 }, async (page) => {
        await page.waitForSelector('.kpt-table, .kpt-source');
        let dialogs = 0;
        page.on('dialog', async (d) => { dialogs += 1; await d.dismiss(); });
        await page.click('button[data-mode="import"]');
        await page.setInputFiles('#kpt-file', { name: 'broken.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a zip') });
        await page.waitForSelector('.kpt-import .notice');
        assert.match(await page.textContent('.kpt-import .notice'), /Файл пошкоджений або не схожий на xlsx/);
        await page.setInputFiles('#kpt-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
        await page.waitForFunction(() => /Підтримуються файли/.test(document.querySelector('.kpt-import .notice').textContent));
        assert.equal(dialogs, 0);
        assert.equal(await noOverflow(page), true);
        await shot(page, 'telematics-import-390-light.png');
    });
});

test('зіставлення: незмеплений список, вибір авто викликає tm_set_vehicle_map; підрозділ авто', async (t) => {
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        assert.match(await page.textContent('button[data-mode="mapping"]'), /Зіставлення \(1\)/);
        await page.click('button[data-mode="mapping"]');
        await page.waitForSelector('tr[data-ref="ZZ0000ZZ"]');
        assert.match(await page.textContent('tr[data-ref="ZZ0000ZZ"]'), /2 дні, 1 подія/);
        await page.click('tr[data-ref="ZZ0000ZZ"] [data-act="map"]');
        assert.equal((await rpcCalls(page, 'tm_set_vehicle_map')).length, 0, 'без вибору авто RPC не викликається');
        await page.selectOption('tr[data-ref="ZZ0000ZZ"] select', V2);
        await page.click('tr[data-ref="ZZ0000ZZ"] [data-act="map"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'tm_set_vehicle_map'));
        assert.deepEqual((await rpcCalls(page, 'tm_set_vehicle_map'))[0], { p_ref: 'ZZ0000ZZ', p_vehicle: V2 });
        await page.waitForSelector('text=Незмепленої техніки немає');
        await page.selectOption('select[aria-label="Підрозділ для KE 5555 AX"]', U2);
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'tm_set_vehicle_unit'));
        assert.deepEqual((await rpcCalls(page, 'tm_set_vehicle_unit'))[0], { p_vehicle: V2, p_unit: U2 });
        assert.equal(await noOverflow(page), true);
    });
});

for (const [name, viewport] of VIEWPORTS) {
    test(`дошка ${name}: перемикач, «+ Нова заявка» й «Оновити» — однакова висота, один ряд (на 390 перемикач окремим рядом), по центру`, async (t) => {
        await run(t, { theme: 'light', sub: 'board' }, viewport, async (page) => {
            await page.waitForSelector('.kpof-actions .segmented');
            const boxes = await page.$$eval('.kpof-actions .segmented, .kpof-actions > a.btn, .kpof-actions > button.btn', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, h: r.height, mid: r.top + r.height / 2 }; }));
            assert.equal(boxes.length, 3);
            assert.ok(boxes.every((b) => Math.abs(b.h - boxes[0].h) < 1.5), 'однакова висота: ' + boxes.map((b) => b.h).join(', '));
            if (name === '390') {
                assert.ok(boxes[1].top > boxes[0].top + boxes[0].h - 1, 'на телефоні перемикач у своєму ряду');
                assert.ok(Math.abs(boxes[1].mid - boxes[2].mid) < 1.5, 'кнопки поруч в одному ряду');
            } else {
                assert.ok(boxes.every((b) => Math.abs(b.mid - boxes[0].mid) < 1.5), 'один ряд, вирівнювання по центру');
            }
            assert.equal(await noOverflow(page), true);
            await shot(page, `board-toolbar-${name}.png`);
        });
    });
}

test('підрозділ: біля «Центр витрат» є підказка field-hint', async (t) => {
    await run(t, { theme: 'light', card: 'unit' }, { width: 1024, height: 768 }, async (page) => {
        await page.waitForSelector('.kpof-form, .kpof-card-wrap');
        const btn = page.locator('.kpc-row:has(label:text-is("Центр витрат")) .kp-hint-btn');
        assert.equal(await btn.count(), 1);
        await btn.click();
        const pop = await page.textContent('.kp-hint-pop');
        assert.equal(pop.trim(), 'Код підрозділу в 1С/BAS для звітів собівартості. Можна лишити порожнім.');
        assert.equal(await page.locator('.kpc-row:has(label:text-is("Назва")) .kp-hint-btn').count(), 0, 'підказка лише біля «Центр витрат»');
    });
});

test('тестові дані: перемикач вимкнений за замовчуванням, показує лише mock з бейджем «тестові дані», без змішування', async (t) => {
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        assert.equal(await page.isChecked('#kpt-show-mock'), false);
        assert.equal((await rpcCalls(page, 'tm_summary')).at(-1).p_mock, false, 'за замовчуванням p_mock = false');
        assert.equal(await page.locator('.kpt-mock').count(), 0, 'реальні дані без бейджа');
        assert.equal(await page.locator('.kpt-table tbody tr').count(), 3);
        await page.check('#kpt-show-mock');
        await page.waitForFunction(() => document.querySelectorAll('.kpt-table tbody tr').length === 2);
        assert.equal((await rpcCalls(page, 'tm_summary')).at(-1).p_mock, true);
        assert.equal((await rpcCalls(page, 'tm_drains')).at(-1).p_mock, true);
        assert.equal(await page.locator('.kpt-table .kpt-mock').count(), 2, 'бейдж біля кожного тестового рядка');
        assert.equal(await page.locator('.kpt-total .kpt-mock').count(), 1, 'бейдж у зведенні');
        assert.equal(await page.locator('.kpt-drain-item .kpt-mock').count(), 1, 'і біля тестового зливу');
        assert.match(await page.textContent('.kpt-table tbody tr'), /5\s?000,0/);
        assert.doesNotMatch(await page.textContent('.kpt-table'), /ZZ0000ZZ|2\s?610,0/, 'реальних рядків у тестовому режимі немає');
        await shot(page, 'telematics-mock-1366-light.png');
        await page.uncheck('#kpt-show-mock');
        await page.waitForFunction(() => document.querySelectorAll('.kpt-table tbody tr').length === 3);
        assert.equal(await page.locator('.kpt-mock').count(), 0);
    });
});

test('«Видалити тестові дані»: підтвердження через tcModal, відповідь з кількістю; скасування нічого не робить; логіст кнопки не бачить', async (t) => {
    await run(t, cfgOf('light', { modalOk: false }), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('[data-act="clear-mock"]');
        await page.click('[data-act="clear-mock"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'modal'));
        assert.equal((await page.evaluate(() => window.__calls.find((c) => c[0] === 'modal')[1])).danger, true);
        assert.equal(await page.evaluate(() => window.__calls.some((c) => c[1] === 'tm_clear_mock')), false, 'без підтвердження RPC не викликається');
    });
    await run(t, cfgOf('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('[data-act="clear-mock"]');
        await page.click('[data-act="clear-mock"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'tm_clear_mock'));
        await page.waitForSelector('text=звітів 12, подій 3');
    });
    await run(t, cfgOf('light', { role: 'logist' }), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-source');
        assert.equal(await page.locator('[data-act="clear-mock"]').count(), 0);
    });
});

test('імпорт пачками: пачка впала посередині → «Імпортовано N з M рядків…»', async (t) => {
    const lines = ['Дата;Держномер;Пробіг'];
    for (let i = 0; i < 1500; i++) lines.push('01.01.2026;AB ' + String(1000 + i) + ' CD;10');
    await run(t, cfgOf('light', { failSecondChunk: true }), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpt-table tbody tr');
        await page.click('button[data-mode="import"]');
        await page.setInputFiles('#kpt-file', csvFile(lines.join('\n')));
        await page.waitForSelector('.kpt-preview');
        await page.click('[data-act="import"]');
        await page.waitForSelector('.kpt-import .notice');
        assert.match(await page.textContent('.kpt-import .notice'), /Імпортовано 1000 з 1500 рядків\. Повторний імпорт цього ж файлу безпечний — дублікатів не буде\./);
        assert.equal((await rpcCalls(page, 'tm_import_reports')).length, 2);
    });
});
