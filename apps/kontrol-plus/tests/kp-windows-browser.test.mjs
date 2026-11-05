// Браузерна перевірка вікон Контроль+ (справжні стилі сайту й Контроль+, справжній менеджер вікон): діалог над вікном, «брудна» форма від справжнього
// введення, зміна розміру за краї й кути, мінімум 480×320, розгорнуте вікно не ресайзиться. Без playwright-core / його Chromium — пропуск.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');

async function launch() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; } // власний Chromium Playwright, не системний Chrome
}

const siteCss = [...SITE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const PAGE = `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css"><link rel="stylesheet" href="/src/kp-win-scope.css"><link rel="stylesheet" href="/src/kp-windows.css">
</head><body class="layout-studio kp-shell-on" data-theme="light"><aside id="kp-shell-side" class="kp-shell-side"></aside><header id="kp-shell-top" class="kp-shell-top"></header>
<script type="module">
import { createWindowManager } from '/src/kp-windows.js';
import { h } from '/src/ui.js';
import { handleFakeConfig } from '../../../tests/helpers/fake-config.mjs';
window.tcModal = (o) => new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'tc-modal';
    el.innerHTML = '<div class="tc-modal-card"><h3></h3><div class="tc-modal-actions"><button type="button" class="btn" data-act="cancel">Скасувати</button><button type="button" class="btn btn-danger" data-act="ok">Закрити</button></div></div>';
    el.querySelector('h3').textContent = o.title;
    const done = (ok) => { el.remove(); document.removeEventListener('keydown', onKey, true); resolve({ ok }); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    el.addEventListener('click', (e) => { const a = e.target.getAttribute('data-act'); if (a) done(a === 'ok'); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(el);
});
const wm = createWindowManager({ storage: sessionStorage, confirm: (o) => window.tcModal(o), notify() {} });
window.__wm = wm;
window.__openForm = (n, auto) => wm.open({ type: 'form', id: '#/docs/new/invoice/' + n, key: 'form:' + n, title: 'Рахунок ' + n, build: (box) => {
    const client = h('select', { id: 'c' + n }, h('option', { value: '' }, '—'), h('option', { value: 'a' }, 'Агро'));
    const num = h('input', { id: 'n' + n, type: 'text' });
    box.append(client, num);
    if (auto) setTimeout(() => { client.value = 'a'; client.dispatchEvent(new Event('change', { bubbles: true })); num.value = '7'; num.dispatchEvent(new Event('input', { bubbles: true })); }, 50); // автозаповнення скриптом
} });
window.__ready = true;
</script></body></html>`;

async function withPage(t, fn, viewport = { width: 1366, height: 768 }) {
    const browser = await launch();
    if (!browser) { t.skip('no playwright-core / Chromium'); return; }
    const server = createServer((req, res) => {
        if (handleFakeConfig(req, res)) return;
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
        if (url.pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(siteCss); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': path.extname(file) === '.css' ? 'text/css' : 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage({ viewport });
        await page.goto('http://127.0.0.1:' + server.address().port + '/');
        await page.waitForFunction(() => window.__ready === true);
        await fn(page);
    } finally { await browser.close(); server.close(); }
}

test('браузер: діалог «Закрити вікно?» над вікном і панеллю задач; фон напівпрозорий; Esc = «Скасувати»', async (t) => {
    await withPage(t, async (page) => {
        await page.evaluate(() => window.__openForm(1));
        await page.click('#n1');
        await page.keyboard.type('5');
        await page.evaluate(() => { window.__closing = window.__wm.close('form:1'); });
        await page.waitForSelector('.tc-modal');
        const info = await page.evaluate(() => {
            const modal = document.querySelector('.tc-modal');
            const winEl = document.querySelector('.kp-win');
            const task = document.querySelector('.kp-taskbar');
            const z = (el) => Number(getComputedStyle(el).zIndex);
            const card = modal.querySelector('.tc-modal-card').getBoundingClientRect();
            const top = document.elementFromPoint(card.x + card.width / 2, card.y + 20);
            const bg = getComputedStyle(modal).backgroundColor;
            const ok = getComputedStyle(modal.querySelector('[data-act="ok"]'));
            const cancel = getComputedStyle(modal.querySelector('[data-act="cancel"]'));
            return { zModal: z(modal), zWin: z(winEl), zTask: z(task), onTop: modal.contains(top), bg, okBg: ok.backgroundColor, cancelBg: cancel.backgroundColor, h: modal.querySelector('.btn').getBoundingClientRect().height };
        });
        assert.ok(info.zModal > info.zWin && info.zModal > info.zTask, JSON.stringify(info));
        assert.equal(info.onTop, true, 'діалог над вікном');
        const alpha = /rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(info.bg);
        assert.ok(alpha && Number(alpha[1]) > 0 && Number(alpha[1]) < 0.7, 'фон напівпрозорий: ' + info.bg);
        assert.notEqual(info.okBg, info.cancelBg, '«Закрити» і «Скасувати» стилізовані по-різному');
        assert.equal(info.cancelBg, 'rgba(0, 0, 0, 0)', '«Скасувати» — другорядна, без заливки');
        assert.equal(info.h, 28, 'кнопки діалогу 28px');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => window.__closing), false, 'Esc = «Скасувати»: вікно лишилось');
        assert.equal(await page.evaluate(() => window.__wm.count()), 1);
        assert.equal(await page.locator('.tc-modal').count(), 0);
    });
});

test('браузер: «брудна» форма — лише від справжнього введення; відкрив і закрив, автозаповнення скриптом — без питання', async (t) => {
    await withPage(t, async (page) => {
        // Просто відкрив і закрив.
        await page.evaluate(() => window.__openForm(1));
        assert.equal(await page.evaluate(() => window.__wm.close('form:1')), true);
        assert.equal(await page.locator('.tc-modal').count(), 0);
        // Клік по полю без змін — теж без питання.
        await page.evaluate(() => window.__openForm(2));
        await page.click('#n2');
        assert.equal(await page.evaluate(() => window.__wm.close('form:2')), true);
        // Автозаповнення скриптом (форма сама підставила значення й продиспатчила події).
        await page.evaluate(() => window.__openForm(3, true));
        await page.waitForTimeout(150);
        assert.equal(await page.inputValue('#n3'), '7');
        assert.equal(await page.evaluate(() => window.__wm.list()[0].dirty), false);
        assert.equal(await page.evaluate(() => window.__wm.close('form:3')), true);
        assert.equal(await page.locator('.tc-modal').count(), 0, 'жодного діалогу');
        // Справжнє введення → питає; повернув значення → знову не питає.
        await page.evaluate(() => window.__openForm(4));
        await page.click('#n4');
        await page.keyboard.type('12');
        assert.equal(await page.evaluate(() => window.__wm.list()[0].dirty), true);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        assert.equal(await page.evaluate(() => window.__wm.list()[0].dirty), false, 'значення повернули');
        await page.selectOption('#c4', 'a');
        assert.equal(await page.evaluate(() => window.__wm.list()[0].dirty), true, 'вибір у списку');
    });
});

test('браузер: ресайз за 4 краї і 4 кути, мінімум 480×320, у межах робочої області, розмір у sessionStorage, розгорнуте не ресайзиться', async (t) => {
    await withPage(t, async (page) => {
        await page.evaluate(() => window.__wm.setScope('o', 'u', () => null));
        await page.evaluate(() => window.__openForm(1));
        const rect = () => page.evaluate(() => { const r = document.querySelector('.kp-win').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
        const drag = async (dir, dx, dy) => {
            const b = await page.locator('.kp-rs-' + dir).boundingBox();
            const sx = b.x + b.width / 2; const sy = b.y + b.height / 2;
            await page.mouse.move(sx, sy);
            await page.mouse.down();
            await page.mouse.move(sx + dx, sy + dy, { steps: 4 });
            await page.mouse.up();
        };
        assert.equal(await page.locator('.kp-win-rs').count(), 8);
        const cursors = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.kp-win-rs')].map((el) => [el.dataset.dir, getComputedStyle(el).cursor])));
        assert.deepEqual(cursors, { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' });
        const r0 = await rect();
        await drag('se', -60, -40);
        const r1 = await rect();
        assert.deepEqual([r1.x, r1.y, r1.w, r1.h], [r0.x, r0.y, r0.w - 60, r0.h - 40], 'se: лівий верхній кут стоїть');
        await drag('nw', 30, 20);
        const r2 = await rect();
        assert.deepEqual([r2.x + r2.w, r2.y + r2.h], [r1.x + r1.w, r1.y + r1.h], 'nw: правий нижній кут стоїть');
        assert.deepEqual([r2.w, r2.h], [r1.w - 30, r1.h - 20]);
        await drag('e', 40, 0); await drag('s', 0, 30); await drag('w', -20, 0); await drag('n', 0, -10); await drag('ne', 10, -10); await drag('sw', -10, 10);
        const r3 = await rect();
        assert.ok(r3.w > r2.w && r3.h > r2.h);
        // Мінімум.
        await drag('se', -2000, -2000);
        const r4 = await rect();
        assert.deepEqual([r4.w, r4.h], [480, 320]);
        // Не виходить за робочу область (праворуч від меню, нижче верхньої панелі, вище панелі задач).
        await drag('se', 3000, 3000);
        const r5 = await rect();
        assert.ok(r5.x + r5.w <= 1366 && r5.y + r5.h <= 768 - 32, JSON.stringify(r5));
        await drag('nw', -3000, -3000);
        const r6 = await rect();
        assert.ok(r6.x >= 0 && r6.y >= 0);
        // Розмір і позиція — у sessionStorage.
        const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tc_kp_windows:o:u')));
        assert.deepEqual([saved[0].x, saved[0].y, saved[0].w, saved[0].h], [r6.x, r6.y, r6.w, r6.h]);
        // Розгорнуте не ресайзиться; після «відновити» — попередній розмір.
        await page.click('.kp-win-btn[aria-label="Розгорнути"]');
        assert.equal(await page.locator('.kp-win.is-max').count(), 1);
        const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('.kp-rs-se')).display);
        assert.equal(hidden, 'none');
        await page.click('.kp-win-btn[aria-label="Відновити розмір"]');
        assert.deepEqual(await rect(), r6, 'після відновлення — попередній розмір');
    });
});
