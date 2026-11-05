// Кабінет суперадміна (#/superadmin): справжній інтерфейс у браузері (справжні стилі, lazy-модуль views/superadmin/) на макеті Supabase.
// «Глобальні функції» (рядка немає → явно + «Створити рядок»), «Організації» (підказка «не працює, бо вимкнено глобально»), «Аудит» по 50,
// підтвердження через tcModal перед кожною зміною, без горизонтального скролу на 390 / 1024 / 1366 / 1920, на телефоні рядки — картки.
// Без playwright-core / esbuild / Chromium — пропуск. Скріни: KP_SA_SHOTS=<тека> node --test tests/superadmin-ui.test.mjs
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

const ORG_A = '9c000000-0000-0000-0000-00000000000a';
const ORG_B = '9c000000-0000-0000-0000-00000000000b';

function fixtures() {
    const audit = Array.from({ length: 120 }, (_, i) => ({
        id: 120 - i, at: new Date(Date.UTC(2026, 10, 1, 12, 0) - i * 60000).toISOString(), admin_id: 'a1', admin_email: 'admin@example.com',
        action: i % 2 ? 'org.feature.set' : 'setting.set', target_type: i % 2 ? 'organization' : 'app_setting', target_id: i % 2 ? ORG_A : 'own_fleet',
        before: i % 2 ? { own_fleet: false } : { enabled: false }, after: i % 2 ? { own_fleet: true } : { enabled: true }, total: 120,
    }));
    const orgs = [
        { id: ORG_A, name: 'Агро Північ ТОВ', edrpou: '90909091', legal_form: 'ТОВ', members: 7, features: { own_fleet: true }, total: 2 },
        { id: ORG_B, name: 'Транс Захід ФОП із дуже довгою назвою для перевірки переносу рядків', edrpou: null, legal_form: 'ФОП', members: 1, features: {}, total: 2 },
    ];
    return { audit, orgs };
}

const ENTRY = `
import { renderSuperadmin } from './src/views/superadmin/index.js';
const cfg = window.__cfg;
const fx = window.__fx;
const calls = [];
window.__calls = calls;
window.__modals = [];
window.__answer = true;
window.tcModal = async (options) => { window.__modals.push(options); return { ok: window.__answer, value: '' }; };
let settings = cfg.settings.map((s) => ({ ...s }));
const supabase = {
    rpc: async (name, args) => {
        calls.push([name, args || null]);
        if (name === 'sa_list_settings') return { data: settings, error: null };
        if (name === 'sa_search_orgs') return { data: fx.orgs, error: null };
        if (name === 'sa_list_audit') return { data: fx.audit.slice(args.p_offset, args.p_offset + args.p_limit), error: null };
        if (name === 'sa_create_setting') { settings = [...settings, { key: args.p_key, enabled: args.p_enabled }]; return { data: {}, error: null }; }
        if (name === 'sa_set_setting') { settings = settings.map((s) => (s.key === args.p_key ? { ...s, enabled: args.p_enabled } : s)); return { data: {}, error: null }; }
        return { data: {}, error: null };
    },
};
const root = document.createElement('main'); root.id = 'kp-crm';
document.body.setAttribute('data-kp-view', 'superadmin');
document.body.append(root);
root.append(renderSuperadmin({ supabase }));
window.__ready = true;
`;

const PAGE = (cfg, fx) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css"><link rel="stylesheet" href="/src/kp-superadmin.css">
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
    const fx = fixtures();
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
        await page.waitForSelector('.kpsa-global');
        await page.waitForSelector('.kpsa-audit');
        await fn(page);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); server.close(); }
}

const shot = async (page, name) => {
    const dir = process.env.KP_SA_SHOTS;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name), fullPage: true });
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const callsOf = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n).map((c) => c[1]), name);
const MISSING = { theme: 'light', settings: [] };
const GLOBAL_OFF = { theme: 'light', settings: [{ key: 'own_fleet', enabled: false }] };

test('три блоки; рядка немає → явно «функція вимкнена» і «Створити рядок»; підказка в компанії з увімкненим прапорцем', async (t) => {
    await run(t, MISSING, { width: 1366, height: 900 }, async (page) => {
        const heads = await page.$$eval('.kpsa-h2', (els) => els.map((e) => e.textContent));
        assert.deepEqual(heads, ['Глобальні функції', 'Організації', 'Аудит']);
        assert.match(await page.textContent('.kpsa-global .kpsa-state'), /Рядка немає — функція вимкнена/);
        assert.equal(await page.getAttribute('.kpsa-global .kpsa-state', 'data-state'), 'missing');
        assert.equal(await page.textContent('.kpsa-global [data-act="create"]'), 'Створити рядок');
        assert.equal(await page.locator('.kpsa-global [data-act="toggle"]').count(), 0, 'перемикача, поки рядка немає, не показуємо');
        assert.match(await page.textContent(`.kpsa-org[data-org="${ORG_A}"] .kpsa-warn`), /Не працює, бо вимкнено глобально/);
        assert.equal(await page.locator(`.kpsa-org[data-org="${ORG_B}"] .kpsa-hint`).count(), 0, 'без прапорця й без глобального — без підказки');
        assert.match(await page.textContent(`.kpsa-org[data-org="${ORG_A}"]`), /ТОВ/);
        assert.equal(await noOverflow(page), true);
        await shot(page, 'superadmin-1366-light.png');
    });
});

test('підтвердження через tcModal: скасування нічого не пише, «Створити рядок» і перемикання викликають RPC лише після підтвердження', async (t) => {
    await run(t, MISSING, { width: 1366, height: 900 }, async (page) => {
        await page.evaluate(() => { window.__answer = false; });
        await page.click('.kpsa-global [data-act="create"]');
        assert.equal((await callsOf(page, 'sa_create_setting')).length, 0, 'скасовано — без запису');
        assert.equal(await page.evaluate(() => window.__modals.length), 1);
        await page.evaluate(() => { window.__answer = true; });
        await page.click('.kpsa-global [data-act="create"]');
        await page.waitForSelector('.kpsa-global [data-act="toggle"]');
        assert.deepEqual(await callsOf(page, 'sa_create_setting'), [{ p_key: 'own_fleet', p_enabled: false }]);
        assert.equal(await page.getAttribute('.kpsa-global .kpsa-state', 'data-state'), 'off');
        await page.click('.kpsa-global [data-act="toggle"]');
        await page.waitForFunction(() => document.querySelector('.kpsa-global .kpsa-state').getAttribute('data-state') === 'on');
        assert.deepEqual(await callsOf(page, 'sa_set_setting'), [{ p_key: 'own_fleet', p_enabled: true }]);
        const titles = await page.evaluate(() => window.__modals.map((m) => m.title));
        assert.match(titles[2], /Увімкнути «Власний парк» для всієї платформи/);
        assert.match(await page.textContent(`.kpsa-org[data-org="${ORG_A}"]`), /ТОВ/);
        assert.equal(await page.locator(`.kpsa-org[data-org="${ORG_A}"] .kpsa-warn`).count(), 0, 'після глобального вмикання підказки «не працює» немає');
    });
});

test('прапорець компанії: перемикач питає підтвердження, потім sa_set_org_feature; скасування нічого не пише', async (t) => {
    await run(t, GLOBAL_OFF, { width: 1366, height: 900 }, async (page) => {
        await page.evaluate(() => { window.__answer = false; });
        await page.click(`.kpsa-org[data-org="${ORG_B}"] input[type="checkbox"]`);
        assert.equal((await callsOf(page, 'sa_set_org_feature')).length, 0);
        await page.evaluate(() => { window.__answer = true; });
        await page.click(`.kpsa-org[data-org="${ORG_B}"] input[type="checkbox"]`);
        await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'sa_set_org_feature'));
        assert.deepEqual(await callsOf(page, 'sa_set_org_feature'), [{ p_org: ORG_B, p_key: 'own_fleet', p_enabled: true }]);
        assert.match(await page.evaluate(() => window.__modals[1].title), /Транс Захід/);
    });
});

test('аудит: сторінки по 50, «Далі» просить зсув 50, текст «було → стало»', async (t) => {
    await run(t, GLOBAL_OFF, { width: 1366, height: 900 }, async (page) => {
        assert.equal(await page.locator('.kpsa-audit').count(), 50);
        assert.deepEqual((await callsOf(page, 'sa_list_audit'))[0], { p_from: null, p_to: null, p_target_type: null, p_limit: 50, p_offset: 0 });
        assert.match(await page.textContent('#kpsa-audit .kpsa-pager'), /1–50 з 120/);
        assert.match(await page.textContent('#kpsa-audit .kpsa-audit'), /вимкнено → увімкнено/);
        assert.equal(await page.isDisabled('#kpsa-audit [data-act="prev"]'), true);
        await page.click('#kpsa-audit [data-act="next"]');
        await page.waitForFunction(() => document.querySelector('#kpsa-audit .kpsa-pager').textContent.includes('51–100'));
        assert.equal((await callsOf(page, 'sa_list_audit')).pop().p_offset, 50);
        await page.click('#kpsa-audit [data-act="next"]');
        await page.waitForFunction(() => document.querySelector('#kpsa-audit .kpsa-pager').textContent.includes('101–120'));
        assert.equal(await page.locator('.kpsa-audit').count(), 20);
        assert.equal(await page.isDisabled('#kpsa-audit [data-act="next"]'), true);
    });
});

for (const theme of ['light', 'dark']) {
    for (const [width, height] of [[390, 844], [1024, 768], [1366, 800], [1920, 1080]]) {
        test(`${width}px ${theme}: без горизонтального скролу${width <= 700 ? '; рядки — картки з підписами' : ''}`, async (t) => {
            await run(t, { ...GLOBAL_OFF, theme }, { width, height }, async (page) => {
                assert.equal(await noOverflow(page), true, 'сторінка не скролиться вбік');
                const tooWide = await page.$$eval('.kpsa-row', (rows) => rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length);
                assert.equal(tooWide, 0, 'жоден рядок не виходить за межі');
                if (width <= 700) {
                    const cols = await page.$eval('.kpsa-org', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
                    assert.equal(cols, 1, 'картка в одну колонку');
                    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kpsa-org .kpsa-cell'), '::before').content), '"Тип: "');
                }
                await shot(page, `superadmin-${width}-${theme}.png`);
            });
        });
    }
}
