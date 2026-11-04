// «Скасувати сторно» (UI): кнопка лише для ролей з правом, модалка підтвердження над вікном, після дії ремонт активний, тост, помилки.
// RPC repair_unstorno перевіряє pgTAP (supabase/tests/repairs_unstorno.sql, запускає db/check-db.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { repairsAccess, repairErrorText } from '../src/lib/repairs.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

test('права: «Скасувати сторно» — лише owner і repair_manager з правом запису', () => {
    const can = (role, can_write = true) => repairsAccess({ org_id: 'o', role, can_write }, { control_plus: role !== 'repair_manager' }).canUnstorno;
    assert.equal(can('owner'), true);
    assert.equal(can('repair_manager'), true);
    assert.equal(can('director'), false);
    assert.equal(can('logist'), false);
    assert.equal(can('owner', false), false, 'без права запису — ні');
    assert.equal(repairsAccess(null, null).canUnstorno, false);
    assert.match(repairErrorText({ message: 'REPAIR_NOT_VOID' }), /не сторновано/);
    assert.match(repairErrorText({ message: 'STOCK_INSUFFICIENT', details: 'Фільтр' }), /Не вистачає на складі: Фільтр/);
});

test('міграція: repair_unstorno, статус до сторно, журнал, гранти; старі міграції не чіпали', () => {
    const files = fs.readdirSync(path.join(APP, '../../supabase/migrations')).filter((f) => /_repair_unstorno\.sql$/.test(f));
    assert.equal(files.length, 1);
    const sql = fs.readFileSync(path.join(APP, '../../supabase/migrations', files[0]), 'utf8');
    assert.match(sql, /^-- Apply manually after review\./);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.repair_unstorno\(p_repair_id uuid\)[\s\S]*SECURITY DEFINER/);
    assert.match(sql, /NOT IN \('owner', 'repair_manager'\)/);
    assert.match(sql, /status_before_void/);
    assert.match(sql, /repair_status_log/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.repair_unstorno\(uuid\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public\.repair_unstorno\(uuid\) TO authenticated, service_role;/);
    assert.match(read('db/check-db.mjs'), /repairs_unstorno\.sql/);
});

async function launch() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}
const siteCss = [...fs.readFileSync(path.join(APP, '../../index.html'), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const CSS = ['crm', 'kp-shell', 'kp-registry', 'kp-win-scope', 'kp-windows', 'kp-calc', 'kp-dashboard', 'kp-report', 'kp-mobile'];
const PAGE = `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/site.css">${CSS.map((c) => `<link rel="stylesheet" href="/src/${c}.css">`).join('')}</head><body><script type="module" src="/tests/helpers/kp-mobile-view.js"></script></body></html>`;

async function withBrowser(t, fn) {
    const browser = await launch();
    if (!browser) { t.skip('no playwright-core / Chromium'); return; }
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
        if (url.pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(siteCss); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': path.extname(file) === '.css' ? 'text/css' : 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const open = async (w, h, role, theme = 'light') => {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        page.errors = [];
        page.on('pageerror', (e) => page.errors.push(String(e)));
        await page.goto(base + `?view=repairs&role=${role}&theme=${theme}`);
        await page.waitForFunction(() => window.__ready === true);
        await page.waitForSelector('.kpr-cards tbody tr');
        return page;
    };
    try { await fn({ open, shots: process.env.KP_SHOTS_DIR || null }); } finally { await browser.close(); server.close(); }
}

test('браузер: кнопку «Скасувати сторно» видно лише owner і repair_manager, поруч із «Створити копію»', async (t) => {
    await withBrowser(t, async ({ open }) => {
        for (const [role, visible] of [['owner', true], ['repair_manager', true], ['director', false], ['logist', false], ['viewer', false]]) {
            const page = await open(1366, 768, role);
            assert.equal(await page.locator('button[data-act="unstorno"]').count(), visible ? 1 : 0, role);
            if (visible) {
                const labels = await page.locator('tr.is-void td:last-child button').allInnerTexts();
                assert.deepEqual(labels, ['Створити копію', 'Скасувати сторно'], role);
            }
            assert.deepEqual(page.errors, []);
            await page.close();
        }
    });
});

test('браузер: модалка підтвердження над вікном; «Скасувати» нічого не робить; після підтвердження ремонт активний і тост', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const page = await open(1366, 768, 'owner');
        await page.evaluate(() => { globalThis.__rpcCalls = []; });
        await page.click('button[data-act="unstorno"]');
        await page.waitForSelector('.tc-modal');
        const info = await page.evaluate(() => {
            const modal = document.querySelector('.tc-modal');
            const card = modal.querySelector('.tc-modal-card').getBoundingClientRect();
            return { text: modal.innerText, z: Number(getComputedStyle(modal).zIndex), bg: getComputedStyle(modal).backgroundColor, onTop: modal.contains(document.elementFromPoint(card.x + 30, card.y + 20)) };
        });
        assert.match(info.text, /Скасувати сторно\?/);
        assert.match(info.text, /знову списано зі складу/);
        assert.match(info.text, /документи[\s\S]*перевірте їх вручну/);
        assert.ok(info.z >= 3400 && info.onTop, 'над вікнами і панеллю задач');
        assert.match(info.bg, /rgba\(\d+, \d+, \d+, 0\.\d+\)/, 'напівпрозорий фон');
        await page.click('.tc-modal [data-act="cancel"]');
        assert.equal(await page.evaluate(() => globalThis.__rpcCalls.length), 0, 'відмова — без запиту');
        assert.equal(await page.locator('tr.is-void').count(), 1);
        await page.click('button[data-act="unstorno"]');
        await page.click('.tc-modal [data-act="ok"]');
        await page.waitForFunction(() => document.querySelectorAll('tr.is-void').length === 0);
        assert.deepEqual(await page.evaluate(() => globalThis.__rpcCalls), [['repair_unstorno', { p_repair_id: '00000000-0000-4000-8000-000000000062' }]]);
        assert.equal(await page.locator('button[data-act="unstorno"]').count(), 0, 'ремонт знову активний: кнопки сторно-дій зникли');
        assert.equal(await page.locator('.kpr-void-tag').count(), 0);
        assert.match(await page.locator('#kp-toast').innerText(), /Сторно скасовано/);
        assert.deepEqual(page.errors, []);
    });
});

test('браузер: помилка RPC (не вистачає на складі) — повідомлення, ремонт лишається сторнованим', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const page = await open(1366, 768, 'repair_manager');
        await page.evaluate(() => { globalThis.__unstornoError = 'STOCK_INSUFFICIENT'; });
        await page.click('button[data-act="unstorno"]');
        await page.click('.tc-modal [data-act="ok"]');
        await page.waitForSelector('.notice');
        assert.match(await page.locator('.notice').first().innerText(), /Не вистачає на складі/);
        assert.equal(await page.locator('tr.is-void').count(), 1);
    });
});

test('знімки екранів (KP_SHOTS_DIR): 1366 і 390 × light / dark', async (t) => {
    await withBrowser(t, async ({ open, shots }) => {
        if (!shots) { t.skip('KP_SHOTS_DIR не задано'); return; }
        fs.mkdirSync(shots, { recursive: true });
        for (const theme of ['light', 'dark']) {
            for (const [w, h] of [[1366, 768], [390, 844]]) {
                const list = await open(w, h, 'owner', theme);
                await list.screenshot({ path: path.join(shots, `list-${w}-${theme}.png`) });
                await list.click('tr.is-void button[data-act="unstorno"]').catch(async () => { await list.click('.kp-more-btn'); await list.click('button[data-act="unstorno"]'); });
                await list.waitForSelector('.tc-modal');
                await list.screenshot({ path: path.join(shots, `confirm-${w}-${theme}.png`) });
                await list.click('.tc-modal [data-act="ok"]');
                await list.waitForFunction(() => document.querySelectorAll('tr.is-void').length === 0);
                await list.waitForTimeout(300);
                await list.screenshot({ path: path.join(shots, `restored-${w}-${theme}.png`) });
                await list.close();
            }
        }
    });
});
