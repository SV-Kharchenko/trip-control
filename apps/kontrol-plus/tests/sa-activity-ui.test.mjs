// Вкладка «Активність» кабінету суперадміна у справжньому браузері (реальні стилі, макет sa_* RPC): вкладка, лічильники, фільтри, сортування кліком,
// мітки ролей / тарифу, дата Europe/Kyiv, картки на вузьких екранах, без горизонтального скролу на 390 / 1024 / 1366 / 1920.
// Без playwright-core / esbuild / Chromium — пропуск (CHROME_PATH=<chrome.exe>).
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

function fixtures() {
    const now = Date.now();
    const ago = (d) => new Date(now - d * 86400000).toISOString();
    const base = { org_id: 'o1', org_name: 'Агро Північ ТОВ', org_plan: 'control_plus', member_status: 'active', registered_at: '2026-07-01T09:05:00Z', email_confirmed_at: '2026-07-01T09:06:00Z' };
    return [
        { ...base, user_id: 'u1', email: 'director@agro.example', org_role: 'owner', last_sign_in_at: ago(1), calcs_total: 12, calcs_7d: 4, calcs_30d: 9, last_calc_at: ago(2), last_activity_at: ago(1) },
        { ...base, user_id: 'u2', email: 'manager-з-дуже-довгою-поштою@agro-pivnich.example', org_role: 'director', last_sign_in_at: ago(15), calcs_total: 3, calcs_7d: 0, calcs_30d: 1, last_calc_at: ago(20), last_activity_at: ago(15) },
        { ...base, user_id: 'u3', email: 'logist@trans.example', org_name: 'Транс Захід', org_plan: 'company', org_role: 'logist', last_sign_in_at: ago(90), calcs_total: 0, calcs_7d: 0, calcs_30d: 0, last_calc_at: null, last_activity_at: ago(90) },
        { ...base, user_id: 'u4', email: 'new@nowhere.example', org_id: null, org_name: null, org_plan: null, org_role: null, member_status: null, email_confirmed_at: null, last_sign_in_at: null, calcs_total: 0, calcs_7d: 0, calcs_30d: 0, last_calc_at: null, last_activity_at: null },
        { ...base, user_id: 'u5', email: 'repair@agro.example', org_role: 'repair_manager', last_sign_in_at: ago(3), calcs_total: 25, calcs_7d: 9, calcs_30d: 20, last_calc_at: ago(0.2), last_activity_at: ago(0.2) },
        { ...base, user_id: 'u6', email: 'zakaz@agro.example', org_role: 'requester', last_sign_in_at: ago(5), calcs_total: 1, calcs_7d: 1, calcs_30d: 1, last_calc_at: ago(5), last_activity_at: ago(5) },
    ];
}

const ENTRY = `
import { renderSuperadmin } from './src/views/superadmin/index.js';
const fx = window.__fx;
window.__calls = [];
window.tcModal = async () => ({ ok: true });
const supabase = { rpc: async (name, args) => {
    window.__calls.push([name, args || null]);
    if (name === 'sa_list_user_activity') return window.__actError ? { data: null, error: { message: 'SUPERADMIN_REQUIRED' } } : { data: fx.rows, error: null };
    if (name === 'sa_list_settings') return { data: [], error: null };
    if (name === 'sa_search_orgs' || name === 'sa_list_audit') return { data: [], error: null };
    return { data: {}, error: null };
} };
const root = document.createElement('main'); root.id = 'kp-crm';
document.body.setAttribute('data-kp-view', 'superadmin');
document.body.append(root);
root.append(renderSuperadmin({ supabase }));
window.__ready = true;
`;

const PAGE = (fx, theme) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css"><link rel="stylesheet" href="/src/kp-superadmin.css">
</head><body class="layout-studio kp-shell-on" data-theme="${theme}"><script>window.__fx = ${JSON.stringify({ rows: fx })};</script><script type="module" src="/entry.js"></script></body></html>`;

async function run(t, viewport, fn, { theme = 'light', actError = false } = {}) {
    let pw; let esbuild;
    try { pw = await import('playwright-core'); esbuild = await import('esbuild'); } catch { t.skip('no playwright-core / esbuild'); return; }
    let browser;
    try { browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined }); } catch { t.skip('no Chromium'); return; }
    const built = await esbuild.build({ stdin: { contents: ENTRY, resolveDir: APP, sourcefile: 'entry.js' }, bundle: true, format: 'esm', write: false, absWorkingDir: APP, loader: { '.css': 'empty' }, logLevel: 'silent' });
    esbuild.stop();
    const js = built.outputFiles[0].text;
    const server = createServer((req, res) => {
        if (handleFakeConfig(req, res)) return;
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(fixtures(), theme)); return; }
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
        await page.addInitScript((e) => { window.__actError = e; }, actError);
        await page.goto('http://127.0.0.1:' + server.address().port + '/');
        await page.waitForFunction(() => window.__ready === true);
        await fn(page);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); server.close(); }
}

const open = async (page) => { await page.click('.kpsa-tab[data-tab="activity"]'); await page.waitForSelector('.kpsa-act[data-user]'); };
const order = (page) => page.$$eval('.kpsa-act[data-user]', (els) => els.map((e) => e.getAttribute('data-user')));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('вкладка: «Керування» за замовчуванням, «Активність» вантажиться лише при відкритті; лічильники за статусами; порядок за замовчуванням — остання дія спаданням, «Не входив» в кінці', async (t) => {
    await run(t, { width: 1366, height: 900 }, async (page) => {
        assert.equal(await page.isVisible('.kpsa-panel#kpsa-panel-manage'), true);
        assert.equal(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'sa_list_user_activity').length), 0);
        await open(page);
        assert.equal(await page.isVisible('.kpsa-panel#kpsa-panel-manage'), false);
        assert.deepEqual(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'sa_list_user_activity').map((c) => c[1])), [{ p_days: 30 }]);
        const chips = await page.$$eval('.kpsa-chip', (els) => els.map((e) => e.getAttribute('data-status') + ':' + e.querySelector('b').textContent));
        assert.deepEqual(chips, ['all:6', 'active:3', 'fading:1', 'inactive:1', 'never:1']);
        assert.deepEqual(await order(page), ['u5', 'u1', 'u6', 'u2', 'u3', 'u4']);
        assert.equal(await page.getAttribute('.kpsa-act[data-user="u4"]', 'data-status'), 'never');
        assert.equal(await page.textContent('.kpsa-act[data-user="u4"] .kpsa-state'), 'Не входив');
        assert.equal(await page.textContent('.kpsa-act[data-user="u3"] .kpsa-state'), 'Неактивний');
        assert.equal(await page.textContent('.kpsa-act[data-user="u2"] .kpsa-state'), 'Згасає');
        assert.equal(await page.textContent('.kpsa-act[data-user="u1"] .kpsa-state'), 'Активний');
        assert.match(await page.textContent('.kpsa-act-count'), /Показано 6 з 6/);
    });
});

test('мітки ролей і тарифу, «так / ні» для пошти, дата Europe/Kyiv ДД.ММ.РРРР ГГ:ХХ', async (t) => {
    await run(t, { width: 1366, height: 900 }, async (page) => {
        await open(page);
        const cell = (user, label) => page.textContent(`.kpsa-act[data-user="${user}"] .kpsa-cell[data-label="${label}"]`);
        assert.deepEqual(await Promise.all(['u1', 'u2', 'u3', 'u5', 'u6'].map((u) => cell(u, 'Роль'))), ['Директор', 'Менеджер', 'Логіст', 'Відповідальний за ремонти', 'Замовник підрозділу']);
        assert.equal(await cell('u1', 'Тариф'), 'Контроль+');
        assert.equal(await cell('u3', 'Тариф'), 'Сайт');
        assert.equal(await cell('u4', 'Тариф'), '—');
        assert.equal(await cell('u1', 'Пошта підтверджена'), 'так');
        assert.equal(await cell('u4', 'Пошта підтверджена'), 'ні');
        assert.equal(await cell('u1', 'Реєстрація'), '01.07.2026 12:05');
        assert.match(await cell('u4', 'Останній вхід'), /—/);
        assert.deepEqual(await Promise.all(['За 7 днів', 'За 30 днів', 'Усього'].map((l) => cell('u5', l))), ['9', '20', '25']);
    });
});

test('фільтри: статус (лічильник-кнопка), пошук за email або компанією; повторний клік знімає статус', async (t) => {
    await run(t, { width: 1366, height: 900 }, async (page) => {
        await open(page);
        await page.click('.kpsa-chip[data-status="fading"]');
        assert.deepEqual(await order(page), ['u2']);
        assert.equal(await page.getAttribute('.kpsa-chip[data-status="fading"]', 'aria-pressed'), 'true');
        await page.click('.kpsa-chip[data-status="fading"]');
        assert.equal((await order(page)).length, 6);
        await page.fill('.kpsa-act-q', 'ТРАНС');
        assert.deepEqual(await order(page), ['u3']);
        await page.fill('.kpsa-act-q', 'repair@');
        assert.deepEqual(await order(page), ['u5']);
        await page.click('.kpsa-chip[data-status="active"]');
        assert.deepEqual(await order(page), ['u5']);
        await page.fill('.kpsa-act-q', 'немає');
        assert.equal((await order(page)).length, 0);
        assert.match(await page.textContent('.kpsa-act-count'), /Показано 0 з 6/);
    });
});

test('сортування: клік по заголовку міняє стовпець і напрямок, nulls last; за замовчуванням — остання дія ↓', async (t) => {
    await run(t, { width: 1920, height: 1000 }, async (page) => {
        await open(page);
        assert.equal(await page.getAttribute('.kpsa-th[data-sort="last_activity_at"]', 'aria-sort'), 'descending');
        await page.click('.kpsa-th[data-sort="email"]');
        const emails = await page.$$eval('.kpsa-act[data-user] .kpsa-act-email b', (els) => els.map((e) => e.textContent));
        assert.deepEqual(emails, [...emails].sort((a, b) => a.localeCompare(b, 'uk')), 'email за зростанням');
        await page.click('.kpsa-th[data-sort="email"]');
        const desc = await page.$$eval('.kpsa-act[data-user] .kpsa-act-email b', (els) => els.map((e) => e.textContent));
        assert.deepEqual(desc, [...emails].reverse());
        await page.click('.kpsa-th[data-sort="calcs_total"]');
        assert.deepEqual((await order(page)).slice(0, 2), ['u5', 'u1']);
        await page.click('.kpsa-th[data-sort="last_activity_at"]');
        await page.click('.kpsa-th[data-sort="last_activity_at"]');
        assert.equal((await order(page)).at(-1), 'u4', 'порожня остання дія — завжди в кінці');
    });
});

for (const theme of ['light', 'dark']) {
    for (const [width, height] of [[390, 844], [1024, 768], [1366, 800], [1920, 1080]]) {
        test(`${width}px ${theme}: без горизонтального скролу; ${width < 1500 ? 'рядки — картки з підписами, вибір сортування' : 'повний рядок із заголовками'}`, async (t) => {
            await run(t, { width, height }, async (page) => {
                await open(page);
                assert.equal(await noOverflow(page), true);
                const tooWide = await page.$$eval('.kpsa-act[data-user]', (rows) => rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length);
                assert.equal(tooWide, 0);
                const head = await page.isVisible('.kpsa-act-head');
                assert.equal(head, width >= 1500);
                if (width < 1500) {
                    assert.equal(await page.isVisible('.kpsa-sortbar'), true);
                    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kpsa-act .kpsa-cell[data-label]'), '::before').content.length > 2), true, 'підписи полів видно');
                    await page.selectOption('.kpsa-sort-select', 'calcs_total');
                    assert.equal((await order(page))[0], 'u5');
                }
                if (width <= 700) {
                    const cols = await page.$eval('.kpsa-act[data-user]', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
                    assert.equal(cols, 1, 'картка в одну колонку');
                }
                // Кнопки за розміром вмісту (не на всю ширину).
                const wide = await page.$$eval('.kpsa-tab, .kpsa-chip, [data-act="reload"]', (els) => els.filter((e) => e.getBoundingClientRect().width > innerWidth * 0.9).length);
                assert.equal(wide, 0);
            }, { theme });
        });
    }
}

test('помилка RPC показується через superadminErrorText з кнопкою «Повторити», без падіння', async (t) => {
    await run(t, { width: 390, height: 844 }, async (page) => {
        await page.click('.kpsa-tab[data-tab="activity"]');
        await page.waitForSelector('#kpsa-activity [data-act="reload"]');
        assert.match(await page.textContent('#kpsa-activity'), /Немає доступу: ця сторінка лише для адміністраторів платформи\./);
        assert.equal(await page.textContent('#kpsa-activity [data-act="reload"]'), 'Повторити');
    }, { actError: true });
});
