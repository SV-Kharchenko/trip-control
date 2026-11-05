// «Власний парк»: справжній інтерфейс у браузері (справжні стилі, менеджер вікон, lazy-модуль views/own-fleet/) на макеті Supabase.
// Дошка, список, фільтри, лічильники, вікно заявки, призначення з попередженням, вигляд замовника; без горизонтального скролу
// на 390 / 1024 / 1366 / 1920. Без playwright-core / його Chromium — пропуск. Скріни: KP_OF_SHOTS=<тека> node --test tests/own-fleet-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');
const siteCss = [...SITE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

const U1 = '81000000-0000-0000-0000-000000000001';
const U2 = '81000000-0000-0000-0000-000000000002';
const U3 = '81000000-0000-0000-0000-000000000003';
const USER_REQ = '99000000-0000-0000-0000-0000000000a4';
const HOUR = 3600 * 1000;

function fixtures(now) {
    const iso = (offsetH) => new Date(now + offsetH * HOUR).toISOString();
    const req = (n, unit, status, over = {}) => ({
        id: '8a000000-0000-0000-0000-' + String(n).padStart(12, '0'), org_id: 'o1', number: n, unit_id: unit, created_by: USER_REQ, cargo: 'Пшениця', qty_t: 25,
        from_point_id: 'p1', to_point_id: 'p3', from_text: null, to_text: null, wanted_at: iso(20), duration_h: 8, priority: 'normal', note: null, status,
        vehicle_id: null, trailer_id: null, driver_id: null, vehicle_label: null, trailer_label: null, driver_name: null, trip_id: null, cancel_reason: null,
        accepted_at: null, assigned_at: null, started_at: null, done_at: null, cancelled_at: null, created_at: iso(-30), updated_at: iso(-1), ...over,
    });
    const assigned = { vehicle_id: 'v1', vehicle_label: 'AA 1111 AA', trailer_label: 'AA 9999 XX', driver_name: 'Іваненко Іван' };
    return {
        units: [
            { id: U1, org_id: 'o1', name: 'Агро Північ', kind: 'agro', cost_center: 'ЦВ-1', archived: false },
            { id: U2, org_id: 'o1', name: 'Елеватор Центральний', kind: 'elevator', cost_center: null, archived: false },
            { id: U3, org_id: 'o1', name: 'Тваринництво', kind: 'livestock', cost_center: null, archived: false },
        ],
        points: [
            { id: 'p1', org_id: 'o1', unit_id: U1, name: 'Поле 12 (Північ)', kind: 'field', lat: 50.45, lng: 30.52, crop: 'пшениця', area_ha: 120.5, archived: false },
            { id: 'p2', org_id: 'o1', unit_id: U2, name: 'Склад елеватора', kind: 'warehouse', lat: null, lng: null, crop: null, area_ha: null, archived: false },
            { id: 'p3', org_id: 'o1', unit_id: null, name: 'Спільний елеватор', kind: 'elevator', lat: null, lng: null, crop: null, area_ha: null, archived: false },
        ],
        org_unit_members: [{ unit_id: U1, user_id: USER_REQ }],
        requesters: [
            { user_id: 'r1', email: 'ivan@agro.ua', full_name: 'Іван Петренко', unit_ids: [U1], created_at: iso(-100) },
            { user_id: 'r2', email: 'olena@agro.ua', full_name: null, unit_ids: [U1, U2], created_at: iso(-50) },
        ],
        invites: [
            { id: 'i1', email: 'new@agro.ua', unit_ids: [U2], status: 'sent', expires_at: iso(100) },
            { id: 'i2', email: 'old@agro.ua', unit_ids: [U1], status: 'expired', expires_at: iso(-10) },
        ],
        fleet_requests: [
            req(1, U1, 'new', { priority: 'urgent', wanted_at: iso(-3), note: 'Під зерновоз до 10:00' }),
            req(2, U1, 'new', { cargo: 'Соняшник', qty_t: 18.5 }),
            req(3, U2, 'new', { priority: 'high', cargo: 'Кукурудза', wanted_at: iso(30) }),
            req(4, U1, 'accepted', { cargo: 'Ячмінь', accepted_at: iso(-2) }),
            req(5, U2, 'assigned', { ...assigned, cargo: 'Ріпак', assigned_at: iso(-4), wanted_at: iso(2) }),
            req(6, U1, 'in_progress', { ...assigned, cargo: 'Пшениця', started_at: iso(-1), wanted_at: iso(-2) }),
            req(7, U3, 'done', { ...assigned, cargo: 'Силос', done_at: iso(-1), wanted_at: iso(-6) }),
            req(8, U3, 'done', { cargo: 'Старе зерно', done_at: iso(-72), wanted_at: iso(-80) }),
            req(9, U1, 'cancelled', { cancelled_at: iso(-5), cancel_reason: 'Не потрібно', cargo: 'Скасоване' }),
        ],
        fleet_request_log: [],
    };
}

const ENTRY = `
import { renderOwnFleet, renderOwnFleetCard, renderRequestersBlock } from './src/views/own-fleet/index.js';
import { createWindowManager } from './src/kp-windows.js';
const cfg = window.__cfg;
const fx = window.__fx;
const calls = [];
window.__calls = calls;
const visibleUnits = (rows) => (cfg.role === 'requester' ? rows.filter((u) => cfg.unitIds.includes(u.id)) : rows);
function rls(name, rows) {
    if (cfg.role !== 'requester') return rows;
    if (name === 'org_units') return rows.filter((r) => cfg.unitIds.includes(r.id));
    if (name === 'fleet_requests') return rows.filter((r) => cfg.unitIds.includes(r.unit_id));
    if (name === 'org_points') return rows.filter((r) => !r.unit_id || cfg.unitIds.includes(r.unit_id));
    return rows;
}
function table(name) {
    const state = { filters: [] };
    const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { state.filters.push([k, v]); return q; },
        insert(row) { calls.push(['insert', name, row]); return q; },
        update(row) { calls.push(['update', name, row]); return q; },
        then(res) {
            const base = name === 'org_units' ? fx.units : name === 'org_points' ? fx.points : fx[name] || [];
            res({ data: rls(name, base).filter((r) => state.filters.every(([k, v]) => r[k] === v)), error: null });
        },
    };
    return q;
}
window.fetch = async (path, init) => {
    const body = JSON.parse(init.body);
    calls.push(['fetch', path, body]);
    const json = body.action === 'list' ? { ok: true, invites: fx.invites }
        : body.action === 'create' || body.action === 'resend' ? { ok: true, mail_sent: false, link: 'https://app.trip-control.com/?requester_invite=r1.test-link', invite: {} } : { ok: true };
    return { ok: true, status: 200, json: async () => json };
};
const supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
    from: table,
    rpc: async (name, args) => {
        calls.push(['rpc', name, args]);
        if (name === 'own_fleet_requesters_list') return { data: fx.requesters, error: null };
        if (name === 'fleet_request_conflicts') return { data: cfg.conflicts ? [{ request_id: 'x', number: 5, kind: 'vehicle', wanted_at: new Date().toISOString() }] : [], error: null };
        if (name === 'kp_vehicles_list') return { data: [{ id: 'v1', label: 'AA 1111 AA', make_model: 'DAF XF' }, { id: 'v2', label: 'AA 2222 AA' }], error: null };
        if (name === 'kp_trailers_list') return { data: [{ id: 't1', plate: 'AA 9999 XX' }], error: null };
        if (name === 'kp_driver_list') return { data: [{ id: 'd1', full_name: 'Іваненко Іван' }, { id: 'd2', full_name: 'Петренко Петро' }], error: null };
        if (name === 'fleet_request_assign') return { data: { ok: true, conflicts: cfg.conflicts ? [{}] : [] }, error: null };
        return { data: null, error: null };
    },
};
const ownFleet = { org_id: 'o1', role: cfg.role, unit_ids: cfg.unitIds || [] };
const app = { supabase, ownFleet, user: { id: cfg.userId }, go: (hash) => { location.hash = hash; window.__lastGo = hash; }, onCleanup() {} };
const root = document.createElement('main'); root.id = 'kp-crm';
document.body.setAttribute('data-kp-view', 'own-fleet');
document.body.append(root);
const route = { view: 'own-fleet', sub: cfg.sub || 'board' };
if (cfg.mode === 'team') {
    // Вкладка «Команда» кабінету сайту: наш блок стоїть у слоті після картки команди.
    const cab = document.createElement('div'); cab.id = 'cabinet-screen'; cab.style.display = 'block'; document.body.append(cab);
    const panel = document.createElement('div'); panel.className = 'cab-panel active'; cab.append(panel);
    const slot = document.createElement('div'); slot.className = 'cab-slot'; panel.append(slot);
    slot.append(renderRequestersBlock(app));
} else root.append(renderOwnFleet(app, route));
if (matchMedia('(min-width: 900px)').matches) {
    const wm = createWindowManager({ storage: sessionStorage, confirm: async () => ({ ok: true }), notify() {} });
    window.__open = (id) => wm.open({ type: 'of_request', id: id || '', key: 'of_request:' + (id || 'new'), title: 'Заявка на рейс', build: (box) => {
        box.classList.add('kpr-page', 'kpg-page');
        box.append(renderOwnFleetCard({ ...app, closeWindow: () => wm.close('of_request:' + (id || 'new'), { force: true }) }, 'request', id || null));
    } });
}
window.__ready = true;
`;

const PAGE = (cfg, fx) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css"><link rel="stylesheet" href="/src/kp-win-scope.css"><link rel="stylesheet" href="/src/kp-windows.css"><link rel="stylesheet" href="/src/kp-own-fleet.css">
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
    const fx = fixtures(Date.now());
    const server = createServer((req, res) => {
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
    const dir = process.env.KP_OF_SHOTS;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name) });
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const staff = (theme) => ({ role: 'owner', userId: 'staff-1', unitIds: [], theme });

for (const theme of ['light', 'dark']) {
    test(`дошка 1366 ${theme}: п'ять колонок, лічильники, «Виконана» лише за сьогодні, без горизонтального скролу`, async (t) => {
        await run(t, staff(theme), { width: 1366, height: 800 }, async (page) => {
            await page.waitForSelector('.kpof-board .kpof-card');
            assert.equal(await page.locator('.kpof-col').count(), 5);
            const counts = await page.$$eval('.kpof-col', (cols) => cols.map((c) => Number(c.querySelector('.kpof-count').textContent)));
            assert.deepEqual(counts, [3, 1, 1, 1, 1], 'нова 3, прийнята 1, призначена 1, у рейсі 1, виконана сьогодні 1 (скасована й стара — не на дошці)');
            const stats = await page.$$eval('.kpof-stat', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
            assert.deepEqual(stats, ['3 нових', '1 термінових', '1 прострочених'], 'нових 3; термінових 1 (№1); прострочена лише №1: час минув, а рейс не почався (№6 уже у рейсі)');
            assert.equal(await noOverflow(page), true);
            await shot(page, `fleet-board-1366-${theme}.png`);
        });
    });
}

test('дошка: фільтри (пріоритет, підрозділ, дата) і перемикач «Дошка / Список»', async (t) => {
    await run(t, staff('light'), { width: 1366, height: 800 }, async (page, fx) => {
        await page.waitForSelector('.kpof-board .kpof-card');
        await page.selectOption('select[aria-label="Пріоритет"]', 'urgent');
        assert.equal(await page.locator('.kpof-card').count(), 1);
        await page.selectOption('select[aria-label="Пріоритет"]', '');
        await page.selectOption('select[aria-label="Підрозділ"]', U2);
        assert.equal(await page.locator('.kpof-card').count(), 2, 'елеватор: №3 нова і №5 призначена');
        await page.selectOption('select[aria-label="Підрозділ"]', '');
        await page.click('button[role="radio"]:has-text("Список")');
        assert.equal(await page.locator('.kpof-table tbody tr').count(), 9, 'у списку всі 9 заявок, зокрема скасована й стара виконана');
        const day = await page.evaluate((iso) => iso.slice(0, 10), fx.fleet_requests[1].wanted_at);
        await page.fill('input[type="date"]', day);
        const rows = await page.locator('.kpof-table tbody tr').count();
        assert.ok(rows >= 1 && rows < 9, 'фільтр за датою звужує список: ' + rows);
    });
});

for (const [name, viewport] of [['390', { width: 390, height: 844 }], ['1024', { width: 1024, height: 768 }], ['1920', { width: 1920, height: 1080 }]]) {
    test(`дошка ${name}: без горизонтального скролу сторінки; ${name === '390' ? 'секції-акордеони' : 'колонки'}`, async (t) => {
        await run(t, staff('light'), viewport, async (page) => {
            await page.waitForSelector('.kpof-board .kpof-card');
            assert.equal(await noOverflow(page), true, 'сторінка не скролиться вбік');
            const open = await page.$$eval('.kpof-col', (cols) => cols.map((c) => c.open));
            if (name === '390') {
                assert.deepEqual(open, [true, true, false, false, false], 'на телефоні відкриті лише «Нова» й «Прийнята»');
                await page.click('.kpof-col-assigned .kpof-col-head');
                assert.equal(await page.$eval('.kpof-col-assigned', (c) => c.open), true, 'акордеон відкривається тапом');
                assert.equal(await noOverflow(page), true);
                await shot(page, 'fleet-board-390-light.png');
            } else {
                assert.deepEqual(open, [true, true, true, true, true], 'на широких екранах усі колонки відкриті');
                const cols = await page.$$eval('.kpof-col', (c) => new Set(c.map((x) => Math.round(x.getBoundingClientRect().top))).size);
                assert.ok(name === '1920' ? cols === 1 : cols >= 1, 'колонки в один ряд на 1920');
            }
        });
    });
}

test('вікно заявки 1366: поля, дії для директора, історія; скріншот', async (t) => {
    await run(t, staff('light'), { width: 1366, height: 800 }, async (page, fx) => {
        await page.waitForSelector('.kpof-board .kpof-card');
        await page.evaluate((id) => window.__open(id), fx.fleet_requests[3].id);
        await page.waitForSelector('.kp-win .kpof-card-view h2');
        assert.match(await page.textContent('.kp-win .kpof-card-view h2'), /Заявка № 4/);
        const acts = await page.$$eval('.kp-win [data-act]', (b) => b.map((x) => x.getAttribute('data-act')));
        assert.deepEqual(acts, ['assigned-assign', 'cancelled'], 'прийнята заявка: призначити або скасувати');
        await page.click('.kp-win [data-act="assigned-assign"]');
        await page.waitForSelector('.kp-win .kpof-panel select');
        assert.equal(await page.locator('.kp-win .kpof-panel select').count(), 3, 'авто, причіп, водій');
        await shot(page, 'fleet-request-1366-light.png');
    });
});

test('призначення: попередження про перетин у часі не блокує; виклик fleet_request_assign', async (t) => {
    await run(t, { ...staff('light'), conflicts: true }, { width: 1366, height: 800 }, async (page, fx) => {
        await page.waitForSelector('.kpof-board .kpof-card');
        await page.evaluate((id) => window.__open(id), fx.fleet_requests[3].id);
        await page.click('.kp-win [data-act="assigned-assign"]');
        await page.waitForSelector('.kp-win .kpof-panel select');
        await page.selectOption('.kp-win .kpof-panel select[aria-label="Авто"]', 'v1');
        await page.selectOption('.kp-win .kpof-panel select[aria-label="Водій"]', 'd1');
        await page.waitForSelector('.kp-win .kpof-panel .notice');
        assert.match(await page.textContent('.kp-win .kpof-panel .notice'), /перетин у часі.*авто.*№ 5/);
        await page.click('.kp-win .kpof-panel button:has-text("Призначити")');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'fleet_request_assign'));
        const call = await page.evaluate(() => window.__calls.find((c) => c[1] === 'fleet_request_assign')[2]);
        assert.deepEqual(call, { p_id: fx.fleet_requests[3].id, p_vehicle: 'v1', p_trailer: null, p_driver: 'd1' });
    });
});

test('скасування вимагає причину', async (t) => {
    await run(t, staff('light'), { width: 1366, height: 800 }, async (page, fx) => {
        await page.waitForSelector('.kpof-board .kpof-card');
        await page.evaluate((id) => window.__open(id), fx.fleet_requests[1].id);
        await page.click('.kp-win [data-act="cancelled"]');
        await page.click('.kp-win .kpof-panel button:has-text("Скасувати заявку")');
        assert.match(await page.textContent('.kp-win .kpof-panel .notice'), /причину/);
        assert.equal(await page.evaluate(() => window.__calls.some((c) => c[1] === 'fleet_request_transition')), false, 'без причини RPC не викликається');
        await page.fill('.kp-win .kpof-panel textarea', 'дублікат');
        await page.click('.kp-win .kpof-panel button:has-text("Скасувати заявку")');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'fleet_request_transition'));
        assert.deepEqual(await page.evaluate(() => window.__calls.find((c) => c[1] === 'fleet_request_transition')[2]), { p_id: fx.fleet_requests[1].id, p_to: 'cancelled', p_reason: 'дублікат' });
    });
});

test('замовник підрозділу 390: лише заявки свого підрозділу, без дошки, вкладок і фінансів; скріншот', async (t) => {
    await run(t, { role: 'requester', userId: USER_REQ, unitIds: [U1], theme: 'light' }, { width: 390, height: 844 }, async (page, fx) => {
        await page.waitForSelector('.kpof-table');
        assert.equal(await page.locator('.kpr-tabs').count(), 0, 'без вкладок «Дошка / Підрозділи / Точки»');
        assert.equal(await page.locator('.kpof-board').count(), 0, 'без дошки');
        const nums = await page.$$eval('.kpof-table tbody tr td:first-child', (tds) => tds.map((x) => Number(x.textContent.replace(/\D/g, ''))).sort((a, b) => a - b));
        assert.deepEqual(nums, fx.fleet_requests.filter((r) => r.unit_id === U1).map((r) => r.number).sort((a, b) => a - b), 'лише підрозділ U1');
        assert.match(await page.textContent('.kpof-role'), /Замовник підрозділу/);
        assert.ok(await page.locator('a:has-text("Нова заявка")').count() >= 1);
        assert.equal(await noOverflow(page), true);
        await shot(page, 'fleet-requester-390-light.png');
    });
});

// ---- «Команда»: блок «Замовники підрозділів» ----
const teamCfg = (theme, role = 'owner') => ({ role, userId: 'staff-1', unitIds: [], theme, mode: 'team' });
const U2_ID = '81000000-0000-0000-0000-000000000002';
const fetchCall = (page, action) => page.evaluate((a) => (window.__calls.find((c) => c[0] === 'fetch' && c[2].action === a) || [])[2], action);
const rpcCall = (page, name) => page.evaluate((n) => (window.__calls.filter((c) => c[0] === 'rpc' && c[1] === n).at(-1) || [])[2], name);

for (const [name, viewport] of [['1366', { width: 1366, height: 800 }], ['390', { width: 390, height: 844 }]]) {
    test(`«Команда» ${name}: блок «Замовники підрозділів» — список, запрошення, підрозділи, без горизонтального скролу; скріншот`, async (t) => {
        await run(t, teamCfg('light'), viewport, async (page) => {
            await page.waitForSelector('.kpof-team .kpof-req');
            assert.equal(await page.locator('.kpof-team .kpof-req[data-user]').count(), 2, 'два замовники');
            assert.equal(await page.locator('.kpof-team .kpof-req[data-invite]').count(), 2, 'два запрошення');
            assert.match(await page.textContent('.kpof-req[data-user="r1"]'), /Іван Петренко · ivan@agro\.ua/);
            const second = await page.textContent('.kpof-req[data-user="r2"]');
            assert.ok(second.includes('olena@agro.ua') && second.includes('Агро Північ') && second.includes('Елеватор Центральний'), 'без ПІБ — пошта; підрозділи чипами');
            assert.match(await page.textContent('.kpof-req[data-invite="i1"]'), /очікує відповіді/);
            assert.match(await page.textContent('.kpof-req[data-invite="i2"]'), /строк минув/);
            assert.equal(await page.locator('.kpof-req[data-invite="i1"] [data-act="revoke"]').count(), 1);
            assert.equal(await page.locator('.kpof-req[data-invite="i2"] [data-act="revoke"]').count(), 0, 'прострочене не скасовують, лише повторюють');
            assert.equal(await noOverflow(page), true);
            await shot(page, `fleet-requesters-${name}-light.png`);
        });
    });
}

test('«Команда»: змінити підрозділи, прибрати, запросити, повторити й скасувати запрошення — виклики RPC та API', async (t) => {
    await run(t, teamCfg('light'), { width: 1366, height: 800 }, async (page) => {
        await page.waitForSelector('.kpof-team .kpof-req');
        await page.click('.kpof-req[data-user="r2"] [data-act="edit-units"]');
        await page.waitForSelector('.kpof-req[data-user="r2"] .kpof-checks');
        assert.deepEqual(await page.$$eval('.kpof-req[data-user="r2"] .kpof-checks input', (i) => i.map((x) => x.checked)), [true, true, false], 'поточні підрозділи позначені');
        await page.uncheck('.kpof-req[data-user="r2"] .kpof-checks input >> nth=0');
        await page.click('.kpof-req[data-user="r2"] [data-act="save-units"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'own_fleet_requester_set_units'));
        assert.deepEqual(await rpcCall(page, 'own_fleet_requester_set_units'), { p_user: 'r2', p_unit_ids: [U2_ID] });
        await page.waitForSelector('.kpof-team .kpof-req');
        await page.click('.kpof-req[data-user="r1"] button:has-text("Прибрати")');
        await page.click('.kpof-req[data-user="r1"] button:has-text("Точно")');
        await page.waitForFunction(() => window.__calls.some((c) => c[1] === 'own_fleet_requester_remove'));
        assert.deepEqual(await rpcCall(page, 'own_fleet_requester_remove'), { p_user: 'r1' });
        await page.click('.kpof-invite [data-act="invite"]');
        assert.match(await page.textContent('.kpof-team .notice'), /пошту/, 'без пошти запрошення не йде');
        await page.fill('.kpof-invite input[type="email"]', 'boss@agro.ua');
        await page.click('.kpof-invite [data-act="invite"]');
        assert.match(await page.textContent('.kpof-team .notice'), /підрозділ/, 'без підрозділу запрошення не йде');
        await page.check('.kpof-invite .kpof-checks input >> nth=1');
        await page.click('.kpof-invite [data-act="invite"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'fetch' && c[2].action === 'create'));
        assert.deepEqual(await fetchCall(page, 'create'), { action: 'create', email: 'boss@agro.ua', unit_ids: [U2_ID] });
        assert.match(await page.textContent('.kpof-team .kpof-link'), /requester_invite=r1\.test-link/, 'пошта не налаштована — посилання для копіювання');
        await page.click('.kpof-req[data-invite="i1"] [data-act="resend"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'fetch' && c[2].action === 'resend'));
        assert.deepEqual(await fetchCall(page, 'resend'), { action: 'resend', id: 'i1' });
        await page.click('.kpof-req[data-invite="i1"] [data-act="revoke"]');
        await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'fetch' && c[2].action === 'revoke'));
        assert.deepEqual(await fetchCall(page, 'revoke'), { action: 'revoke', id: 'i1' });
    });
});

test('«Команда»: блок бачать лише директор і менеджер; логіст і замовник — ні, і без запитів за списками', async (t) => {
    for (const [role, visible] of [['owner', true], ['director', true], ['logist', false], ['requester', false]]) {
        await run(t, { ...teamCfg('light', role), unitIds: role === 'requester' ? [U1] : [] }, { width: 1366, height: 800 }, async (page) => {
            await page.waitForFunction(() => document.querySelector('.cab-slot').children.length > 0);
            if (visible) await page.waitForSelector('.kpof-team .kpof-req');
            assert.equal(await page.locator('.kpof-team').count(), visible ? 1 : 0, role);
            assert.equal(await page.evaluate(() => window.__calls.filter((c) => c[1] === 'own_fleet_requesters_list' || c[0] === 'fetch').length), visible ? 2 : 0, role);
        });
    }
});
