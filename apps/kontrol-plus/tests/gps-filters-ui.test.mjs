// #/gps у справжньому браузері (реальні стилі, справжній Leaflet, макет Supabase і /api/gps/*): випадні списки поверх карти на 390 / 1024 / 1366 / 1920,
// закриття по кліку поза списком і Esc, одна висота поля пошуку й кнопок, фільтри таблиці на 721 юніті, оновлення каталогу після sync без F5.
// Без playwright-core / esbuild / Chromium — пропуск (CHROME_PATH=<chrome.exe> вказує браузер).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleFakeConfig } from '../../../tests/helpers/fake-config.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');
const siteCss = [...SITE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const KINDS = ['truck', 'tractor', 'special', 'van', null];
const TOTAL = 721;

function fixtures() {
    const units = Array.from({ length: TOTAL }, (_, i) => {
        const linked = i % 3 === 0;
        return {
            id: 'u' + i, name: i === 0 ? 'AA 2008 EA_DAF' : 'BC' + (1000 + i) + 'XY_' + i, vehicle_id: linked ? 'v' + i : null,
            vehicle_label: linked ? 'BC' + (1000 + i) + ' XY' : null, active: true, external_id: String(5000 + i), kind: KINDS[i % 5], kind_manual: false,
        };
    });
    const members = [];
    units.forEach((u, i) => { if (i < 100) members.push({ group_id: 'g1', gps_vehicle_id: u.id }); else if (i < 150) members.push({ group_id: 'g2', gps_vehicle_id: u.id }); });
    const newMembers = [];
    units.forEach((u, i) => { if (i < 100) newMembers.push({ group_id: 'g1', gps_vehicle_id: u.id }); else if (i >= 200 && i < 220) newMembers.push({ group_id: 'g3', gps_vehicle_id: u.id }); });
    return {
        units,
        fleet: units.filter((u) => u.vehicle_id).slice(0, 40).map((u) => ({ id: u.vehicle_id, label: u.vehicle_label })),
        groups: [{ id: 'g1', name: 'Тягачі', source: 'wialon' }, { id: 'g2', name: 'Старі', source: 'wialon' }],
        newGroups: [{ id: 'g1', name: 'Тягачі', source: 'wialon' }, { id: 'g3', name: 'Нова група', source: 'wialon' }],
        members, newMembers,
    };
}

const ENTRY = `
import { renderGps } from './src/views/gps.js';
const fx = window.__fx;
window.__calls = [];
window.__synced = false;
const table = (name) => {
    if (name === 'gps_vehicles') return fx.units.map((u) => ({ id: u.id, kind: u.kind, kind_manual: u.kind_manual }));
    if (name === 'gps_groups') return window.__synced ? fx.newGroups : fx.groups;
    if (name === 'gps_group_members') return window.__synced ? fx.newMembers : fx.members;
    if (name === 'gps_integrations') return [{ id: 'i1', provider: 'wialon', status: 'active', host_kind: 'hosting', api_host: 'hst-api.wialon.com', provider_account: 'acc', units_total: ${TOTAL}, token_hint: '…abcd', last_checked_at: new Date().toISOString(), last_ok_at: null, last_error_code: null }];
    if (name === 'fleet_vehicles') return fx.fleet;
    return [];
};
const builder = (name) => {
    let rows = table(name);
    const b = { select: () => b, order: () => b, limit: () => b, in: () => b, eq: () => b, range: (a, z) => { rows = rows.slice(a, z + 1); return b; },
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej) };
    return b;
};
const supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
    from: (name) => builder(name),
    rpc: async (name, args) => {
        window.__calls.push([name, args || null]);
        if (name === 'gps_units') return { data: fx.units.map((u) => ({ id: u.id, name: u.name, vehicle_id: u.vehicle_id, vehicle_label: u.vehicle_label, active: u.active, external_id: u.external_id })), error: null };
        return { data: null, error: null };
    },
};
window.fetch = async (url, opts) => {
    window.__calls.push(['fetch', String(url)]);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (String(url).endsWith('/sync-units')) { window.__synced = true; return json({ counts: { total: ${TOTAL}, added: 0, deactivated: 0 }, groups: { synced: true, total: 2 }, units: [] }); }
    if (String(url).endsWith('/positions')) return json({ integration_status: 'active', vehicles: [{ gps_vehicle_id: 'u0', unit_name: 'AA 2008 EA_DAF', plate: 'AA2008EA', linked: true, lat: 50.4, lon: 30.5, speed: 10, kind: 'truck', last_pos_at: new Date().toISOString() }], sync: {}, refreshed: false });
    return json({});
};
const app = { context: { org_id: 'org1', control_plus: true, role: 'owner' }, supabase, onCleanup() {}, onPlanLost() {} };
const root = document.createElement('main'); root.id = 'kp-crm';
document.body.setAttribute('data-kp-view', 'gps');
document.body.append(root);
root.append(renderGps(app));
window.__ready = true;
`;

const PAGE = (fx, seed) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/leaflet.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css">
</head><body class="layout-studio kp-shell-on" data-theme="light"><script>
try { for (const [k, v] of Object.entries(${JSON.stringify(seed || {})})) localStorage.setItem(k, v); } catch (e) {}
window.__fx = ${JSON.stringify(fx)};</script><script type="module" src="/entry.js"></script></body></html>`;

async function run(t, viewport, fn, seed) {
    let pw; let esbuild;
    try { pw = await import('playwright-core'); esbuild = await import('esbuild'); } catch { t.skip('no playwright-core / esbuild'); return; }
    let browser;
    try { browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined }); } catch { t.skip('no Chromium'); return; }
    const built = await esbuild.build({ stdin: { contents: ENTRY, resolveDir: APP, sourcefile: 'entry.js' }, bundle: true, format: 'esm', write: false, absWorkingDir: APP,
        loader: { '.css': 'empty' }, logLevel: 'silent', splitting: false });
    esbuild.stop();
    const js = built.outputFiles[0].text;
    const fx = fixtures();
    const server = createServer((req, res) => {
        if (handleFakeConfig(req, res)) return;
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(fx, seed)); return; }
        if (url.pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(siteCss); return; }
        if (url.pathname === '/leaflet.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(fs.readFileSync(path.join(APP, 'node_modules/leaflet/dist/leaflet.css'))); return; }
        if (url.pathname === '/entry.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(js); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage({ viewport });
        await page.route('**/*openstreetmap.org/**', (route) => route.abort());
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('http://127.0.0.1:' + server.address().port + '/');
        await page.waitForFunction(() => window.__ready === true);
        await page.waitForSelector('.gps-units tbody tr');
        await page.waitForSelector('.gps-map .leaflet-pane', { state: 'attached' });
        await page.waitForFunction(() => document.querySelectorAll('.gps-tfilter .gps-multi-list label').length > 0 && document.querySelectorAll('.gps-filter .gps-multi-list label').length > 0);
        await fn(page);
        assert.deepEqual(errors.filter((e) => !/tile|openstreetmap/i.test(e)), []);
    } finally { await browser.close(); server.close(); }
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const countText = (page) => page.textContent('.gps-tcount');
const rowCount = (page) => page.locator('.gps-units tbody tr').count();
const store = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// Усі вибрані точки списку (рамка й вміст) лежать на самому списку, а не на карті чи панелях Leaflet.
async function listOnTop(page, listSelector) {
    return page.evaluate((sel) => {
        const list = document.querySelector(sel);
        const r = list.getBoundingClientRect();
        const pts = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1], [0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.1, 0.9], [0.5, 0.9], [0.9, 0.9]];
        const bad = [];
        for (const [fx, fy] of pts) {
            const x = r.left + r.width * fx; const y = r.top + r.height * fy;
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
            const top = document.elementFromPoint(x, y);
            if (!top || !list.contains(top)) bad.push([Math.round(x), Math.round(y), top ? top.className : null]);
        }
        const clipped = [];
        for (let el = list.parentElement; el && el !== document.body; el = el.parentElement) {
            const o = getComputedStyle(el);
            if (/hidden|clip|auto|scroll/.test(o.overflow + o.overflowX + o.overflowY)) clipped.push(el.className || el.tagName);
        }
        return { bad, clipped, rect: { w: Math.round(r.width), h: Math.round(r.height) } };
    }, listSelector);
}

for (const [width, height] of [[390, 844], [1024, 768], [1366, 800], [1920, 1080]]) {
    test(`${width}px: «Тип» і «Групи» над картою відкриваються поверх неї, не обрізаються; закриття кліком поза списком і Esc`, async (t) => {
        await run(t, { width, height }, async (page) => {
            for (const which of [1, 0]) { // 0 — «Групи», 1 — «Тип»
                const multi = page.locator('.gps-filter .gps-multi').nth(which);
                await multi.locator('summary').click();
                const sel = `.gps-filter .gps-multi:nth-of-type(${1})`;
                void sel;
                const list = multi.locator('.gps-multi-list');
                await list.waitFor({ state: 'visible' });
                const handle = await list.elementHandle();
                await page.evaluate((el) => el.setAttribute('data-probe', '1'), handle);
                const out = await listOnTop(page, '[data-probe="1"]');
                assert.deepEqual(out.bad, [], 'список поверх карти: ' + JSON.stringify(out));
                assert.deepEqual(out.clipped, [], 'жоден предок не обрізає');
                const z = await page.evaluate((el) => ({ list: Number(getComputedStyle(el).zIndex), filter: Number(getComputedStyle(el.closest('.gps-filter')).zIndex) }), handle);
                assert.ok(z.list > 1000 && z.filter > 1000, 'z-index вищий за Leaflet: ' + JSON.stringify(z));
                await page.evaluate((el) => el.removeAttribute('data-probe'), handle);
                // Клік поза списком закриває; Esc теж.
                await page.click('.gps-map-section h2');
                assert.equal(await multi.evaluate((d) => d.open), false, 'клік поза списком закриває');
                await multi.locator('summary').click();
                assert.equal(await multi.evaluate((d) => d.open), true);
                await page.keyboard.press('Escape');
                assert.equal(await multi.evaluate((d) => d.open), false, 'Esc закриває');
            }
            // Результати пошуку юнітів над картою.
            await page.fill('.gps-filter .gps-unit-search', 'BC10');
            await page.waitForSelector('.gps-filter .gps-unit-result');
            const probe = await page.$('.gps-filter .gps-unit-results');
            await page.evaluate((el) => el.setAttribute('data-probe', '2'), probe);
            const res = await listOnTop(page, '[data-probe="2"]');
            assert.deepEqual(res.bad, [], 'результати пошуку поверх карти: ' + JSON.stringify(res));
            assert.deepEqual(res.clipped, []);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.gps-filter .gps-unit-result').count(), 0, 'Esc закриває результати пошуку');
            await page.fill('.gps-filter .gps-unit-search', 'BC10');
            await page.waitForSelector('.gps-filter .gps-unit-result');
            await page.click('.gps-map-section h2');
            assert.equal(await page.locator('.gps-filter .gps-unit-result').count(), 0, 'клік поза полем закриває результати');
            assert.equal(await noOverflow(page), true, 'без горизонтального скролу');
        });
    });
}

for (const [width, height] of [[390, 844], [1024, 768], [1366, 800], [1920, 1080]]) {
    test(`${width}px: поле пошуку такої самої висоти, як кнопки «Групи», «Тип», «Усі юніти», «Скинути вибір» (і в рядку фільтрів таблиці); кнопки за вмістом`, async (t) => {
        await run(t, { width, height }, async (page) => {
            const heights = await page.evaluate(() => {
                const pick = (root) => [...document.querySelectorAll(root + ' summary, ' + root + ' .btn, ' + root + ' input[type="search"], ' + root + ' select')]
                    .filter((e) => e.offsetParent).map((e) => ({ cls: e.className || e.tagName, h: Math.round(e.getBoundingClientRect().height * 10) / 10, w: Math.round(e.getBoundingClientRect().width) }));
                return { map: pick('.gps-filter'), table: pick('.gps-tfilter'), cw: document.querySelector('.gps-filter').getBoundingClientRect().width };
            });
            for (const group of [heights.map, heights.table]) {
                assert.ok(group.length >= 4, JSON.stringify(group));
                assert.equal(new Set(group.map((x) => x.h)).size, 1, 'одна висота: ' + JSON.stringify(group));
            }
            assert.ok(heights.map.find((x) => /gps-unit-search/.test(x.cls)).w < heights.cw, 'поле пошуку не на всю ширину рядка');
            if (width > 600) for (const b of heights.map.filter((x) => /btn|summary/.test(x.cls) || x.cls === 'SUMMARY')) assert.ok(b.w < 260, 'кнопка за розміром вмісту: ' + JSON.stringify(b));
            // Центр поля пошуку збігається з центром кнопок у тому ж рядку (на широких екранах — один рядок).
            if (width >= 1024) {
                const centers = await page.evaluate(() => [...document.querySelectorAll('.gps-filter-row')][0] && [...document.querySelector('.gps-filter .gps-filter-row').querySelectorAll('summary, .gps-unit-search, .actions .btn')]
                    .map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
                assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, 'вирівнювання по центру: ' + centers);
            }
            assert.equal(await noOverflow(page), true);
        });
    });
}

test('таблиця на 721 юніті: перші 200 і «Показати ще»; пошук із двійниками, група, тип, прив’язка, лічильник, «Скинути», localStorage окремо від карти', async (t) => {
    await run(t, { width: 1366, height: 900 }, async (page) => {
        const f = fixtures();
        assert.equal(await countText(page), 'Показано 200 з ' + TOTAL);
        assert.equal(await rowCount(page), 200);
        await page.click('.gps-units-wrap [data-act="more"], [data-act="more"]');
        assert.equal(await rowCount(page), 400);
        // Номер: кирилиця знаходить латиницю, з debounce.
        await page.fill('.gps-tsearch', 'АА2008ЕА');
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 1 з 721');
        assert.equal(await rowCount(page), 1);
        assert.match(await page.textContent('.gps-units tbody tr'), /AA 2008 EA_DAF/);
        assert.equal(JSON.parse(await store(page, 'kp.gps.table.v1:org1')).q, 'АА2008ЕА');
        assert.equal(await store(page, 'kp.gps.selection.v1:org1'), null, 'вибір карти не зачеплено');
        await page.click('[data-act="treset"]');
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 200 з 721');
        assert.equal(await page.inputValue('.gps-tsearch'), '');
        // Група.
        await page.locator('.gps-tfilter .gps-multi').nth(0).locator('summary').click();
        await page.locator('.gps-tfilter .gps-multi').nth(0).locator('input[value="g1"]').check();
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 100 з 721');
        // Прив’язка у групі: i % 3 === 0 серед 0..99 → 34.
        await page.selectOption('.gps-tlink', 'linked');
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 34 з 721');
        await page.selectOption('.gps-tlink', 'unlinked');
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 66 з 721');
        // Тип «Не визначено» (i % 5 === 4), у групі й серед неприв’язаних.
        await page.locator('.gps-tfilter .gps-multi').nth(1).locator('summary').click();
        await page.locator('.gps-tfilter .gps-multi').nth(1).locator('input[value="none"]').check();
        const expected = f.units.filter((u, i) => i < 100 && !u.vehicle_id && u.kind === null).length;
        await page.waitForFunction((n) => document.querySelector('.gps-tcount').textContent === 'Показано ' + n + ' з 721', expected);
        const saved = JSON.parse(await store(page, 'kp.gps.table.v1:org1'));
        assert.deepEqual([saved.groupIds, saved.kinds, saved.link], [['g1'], ['none'], 'unlinked']);
        await page.click('[data-act="treset"]');
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 200 з 721');
        assert.deepEqual(JSON.parse(await store(page, 'kp.gps.table.v1:org1')), { groupIds: [], kinds: [], q: '', link: 'all' });
        assert.equal(await noOverflow(page), true);
    });
});

test('таблиця: фільтри відновлюються з localStorage після перезавантаження сторінки', async (t) => {
    await run(t, { width: 1024, height: 800 }, async (page) => {
        assert.equal(await countText(page), 'Показано 1 з ' + TOTAL);
        assert.equal(await page.inputValue('.gps-tsearch'), 'АА2008ЕА');
        assert.equal(await page.inputValue('.gps-tlink'), 'all');
    }, { 'kp.gps.table.v1:org1': JSON.stringify({ groupIds: [], kinds: [], q: 'АА2008ЕА', link: 'all' }) });
});

for (const [width, height] of [[390, 844], [1920, 1080]]) {
    test(`${width}px: фільтри таблиці переносяться, кнопки за вмістом, без горизонтального скролу; рядки таблиці не виходять за екран`, async (t) => {
        await run(t, { width, height }, async (page) => {
            assert.equal(await noOverflow(page), true);
            const box = await page.evaluate(() => {
                const r = document.querySelector('.gps-tfilter').getBoundingClientRect();
                return { right: r.right, w: innerWidth, btns: [...document.querySelectorAll('.gps-tfilter .btn')].map((b) => Math.round(b.getBoundingClientRect().width)) };
            });
            assert.ok(box.right <= box.w + 1);
            if (width > 600) for (const w of box.btns) assert.ok(w < 200, 'кнопка за вмістом: ' + w);
        });
    });
}

test('після «Оновити список юнітів» фільтри «Групи» над картою й у таблиці показують нові групи без F5; зниклу групу прибрано з вибору', async (t) => {
    await run(t, { width: 1366, height: 900 }, async (page) => {
        const labels = (root) => page.$$eval(root + ' .gps-multi:first-child .gps-multi-list label', (ls) => ls.map((l) => l.textContent.trim()));
        assert.deepEqual(await labels('.gps-filter'), ['Тягачі (100)', 'Старі (50)']);
        assert.deepEqual(await labels('.gps-tfilter'), ['Тягачі (100)', 'Старі (50)']);
        await page.evaluate(() => { window.__marker = 'same-page'; });
        const before = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'fetch' && /positions$/.test(c[1])).length);
        void before;
        await page.click('button:has-text("Оновити список юнітів")');
        await page.waitForFunction(() => window.__synced === true);
        await page.waitForFunction(() => [...document.querySelectorAll('.gps-filter .gps-multi:first-child .gps-multi-list label')].some((l) => /Нова група/.test(l.textContent)));
        assert.deepEqual(await labels('.gps-filter'), ['Тягачі (100)', 'Нова група (20)']);
        assert.deepEqual(await labels('.gps-tfilter'), ['Тягачі (100)', 'Нова група (20)']);
        assert.equal(await page.evaluate(() => window.__marker), 'same-page', 'сторінку не перезавантажували');
        // Нова група працює у фільтрі таблиці: g3 = юніти 200..219.
        await page.locator('.gps-tfilter .gps-multi').nth(0).locator('summary').click();
        await page.locator('.gps-tfilter .gps-multi').nth(0).locator('input[value="g3"]').check();
        await page.waitForFunction(() => document.querySelector('.gps-tcount').textContent === 'Показано 20 з 721');
    }, { 'kp.gps.selection.v1:org1': JSON.stringify({ all: false, groupIds: ['g2'], unitIds: [], kinds: [] }), 'kp.gps.table.v1:org1': JSON.stringify({ groupIds: ['g2'], kinds: [], q: '', link: 'all' }) });
});

test('невалідна група у збереженому виборі прибирається одразу після оновлення каталогу (pruneSelection) і в карті, і в таблиці', async (t) => {
    await run(t, { width: 1366, height: 900 }, async (page) => {
        await page.click('button:has-text("Оновити список юнітів")');
        await page.waitForFunction(() => window.__synced === true);
        await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('kp.gps.selection.v1:org1')).groupIds.length === 0; } catch { return false; } });
        assert.deepEqual(JSON.parse(await store(page, 'kp.gps.table.v1:org1')).groupIds, []);
        assert.equal(await countText(page), 'Показано 200 з ' + TOTAL, 'таблиця більше не відфільтрована зниклою групою');
    }, { 'kp.gps.selection.v1:org1': JSON.stringify({ all: false, groupIds: ['g2'], unitIds: [], kinds: [] }), 'kp.gps.table.v1:org1': JSON.stringify({ groupIds: ['g2'], kinds: [], q: '', link: 'all' }) });
});
