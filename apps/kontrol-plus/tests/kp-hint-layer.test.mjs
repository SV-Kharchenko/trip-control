// Браузерна перевірка підказок «?» у справжній формі (рядок вантажу) у справжньому вікні Контроль+: підказка — окремий шар над усіма полями,
// у межах вікна браузера на 1366 і 390, відкрита лише одна, Esc / скрол / повторний клік закривають. Без playwright-core / його Chromium — пропуск.
// Скріни (за бажанням): KP_HINT_SHOTS=<тека> node --test tests/kp-hint-layer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');
const siteCss = [...SITE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

async function launch() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}

const ENTRY = `
import { createWindowManager } from './src/kp-windows.js';
import { MIN_WIDE } from './src/lib/windows-core.js';
import { renderTtnForm } from './src/views/docs-ttn-form.js';
const chain = () => { const p = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? (res) => res({ data: [{ id: 'c1', name: 'Клієнт Тест', archived_at: null }], error: null }) : p), apply: () => p }); return p; };
const supabase = {
    rpc: async (name) => ({ data: name === 'kp_requisites_get' ? [{ edrpou: '12345678', name: 'ТОВ Тест' }] : [], error: null }),
    from: () => chain(),
};
const app = { supabase, go() {}, notify() {} };
const wm = createWindowManager({ storage: sessionStorage, confirm: async () => ({ ok: true }), notify() {} });
window.__wm = wm;
if (window.matchMedia('(min-width: ' + MIN_WIDE + 'px)').matches) {
    wm.open({ type: 'form', id: '#/docs/new/x', key: 'form:x', title: 'Документ', build: (box) => { box.append(renderTtnForm(app, { isOwner: true }, {})); } });
} else {
    // вузький екран: вікон немає, форма — звичайна сторінка розділу
    document.body.setAttribute('data-kp-view', 'docs');
    const main = document.createElement('main'); main.id = 'kp-crm'; document.body.append(main);
    main.append(renderTtnForm(app, { isOwner: true }, {}));
}
window.__ready = true;
`;
const PAGE = (theme) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css"><link rel="stylesheet" href="/src/kp-win-scope.css"><link rel="stylesheet" href="/src/kp-windows.css">
</head><body class="layout-studio kp-shell-on" data-theme="${theme}"><script type="module" src="/entry.js"></script></body></html>`;

async function withPage(t, theme, viewport, fn) {
    const browser = await launch();
    if (!browser) { t.skip('no playwright-core / Chromium'); return; }
    let esbuild;
    try { esbuild = await import('esbuild'); } catch { await browser.close(); t.skip('no esbuild'); return; }
    const built = await esbuild.build({ stdin: { contents: ENTRY, resolveDir: APP, sourcefile: 'entry.js' }, bundle: true, format: 'esm', write: false, absWorkingDir: APP, logLevel: 'silent' });
    const js = built.outputFiles[0].text;
    esbuild.stop();
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(theme)); return; }
        if (url.pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(siteCss); return; }
        if (url.pathname === '/entry.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(js); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': path.extname(file) === '.css' ? 'text/css' : 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('http://127.0.0.1:' + server.address().port + '/');
        await page.waitForFunction(() => window.__ready === true);
        await page.waitForSelector('#t-client', { timeout: 5000 }).catch(async (e) => { throw new Error(e.message + ' | ' + errors.join(';') + ' | ' + (await page.evaluate(() => document.body.innerHTML.slice(0, 600)))); });
        await page.selectOption('#t-client', 'c1');
        await page.waitForTimeout(600);
        await page.waitForSelector('.kpt-line .kp-hint-btn', { timeout: 5000 }).catch(async (e) => { throw new Error(e.message + ' | ' + errors.join(';') + ' | ' + (await page.evaluate(() => document.body.innerText.slice(0, 1500)))); });
        await fn(page);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); server.close(); }
}

// Відкрита підказка: у центрі й кутах її самої — вона сама (над усіма полями), у межах вікна браузера, у body.
async function inspect(page) {
    return page.evaluate(() => {
        const pop = document.querySelector('.kp-hint-pop:not([hidden])');
        const r = pop.getBoundingClientRect();
        const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 10, r.top + 10], [r.right - 10, r.bottom - 10], [r.left + 10, r.bottom - 10], [r.right - 10, r.top + 10]];
        return {
            parentIsBody: pop.parentElement === document.body,
            dbg: JSON.stringify({ r, pos: getComputedStyle(pop).position, z: getComputedStyle(pop).zIndex, at: pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.tagName + '.' + e.className); }) }),
            overFields: pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return e === pop || pop.contains(e); }),
            inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            width: r.width,
            bg: getComputedStyle(pop).backgroundColor,
            text: pop.textContent,
        };
    });
}

for (const [name, viewport] of [['1366', { width: 1366, height: 768 }], ['390', { width: 390, height: 844 }]]) {
    for (const theme of ['light', 'dark']) {
        test(`браузер ${name} ${theme}: підказка в рядку вантажу над усіма полями й у межах вікна; друга закриває першу; Esc, скрол, повторний клік закривають`, async (t) => {
            await withPage(t, theme, viewport, async (page) => {
                const btns = page.locator('.kpt-line .kp-hint-btn');
                const count = await btns.count();
                assert.ok(count >= 3, 'у рядку вантажу кілька «?»: ' + count);
                const open = () => page.locator('.kp-hint-pop:not([hidden])');
                for (let i = 0; i < count; i++) {
                    await btns.nth(i).scrollIntoViewIfNeeded();
                    await btns.nth(i).click();
                    const info = await inspect(page);
                    assert.equal(info.parentIsBody, true, 'підказка лежить у body');
                    assert.equal(info.overFields, true, 'над усіма полями: ' + info.dbg);
                    assert.equal(info.inViewport, true, 'у межах вікна браузера: ' + info.text);
                    assert.ok(info.width <= 281, 'max-width 280: ' + info.width);
                    assert.match(info.bg, /^rgb\(/, 'суцільний фон');
                    assert.equal(await open().count(), 1, 'відкрита одна');
                    await page.keyboard.press('Escape');
                    assert.equal(await open().count(), 0, 'Esc закриває');
                }
                await btns.nth(0).scrollIntoViewIfNeeded();
                await btns.nth(0).click();
                const first = await open().textContent();
                await btns.nth(1).scrollIntoViewIfNeeded();
                await page.waitForTimeout(400); // скрол-події після прокрутки до другого «?» не повинні закрити нову підказку
                await btns.nth(1).click();
                assert.equal(await open().count(), 1, 'друга закриває першу');
                assert.notEqual(await open().textContent(), first);
                assert.equal(await btns.nth(0).getAttribute('aria-expanded'), 'false');
                assert.equal(await btns.nth(1).getAttribute('aria-expanded'), 'true');
                const dir = process.env.KP_HINT_SHOTS;
                if (dir) {
                    fs.mkdirSync(dir, { recursive: true });
                    await page.screenshot({ path: path.join(dir, `cargo-hint-${name}-${theme}.png`) });
                }
                await btns.nth(1).click();
                assert.equal(await open().count(), 0, 'повторний клік закриває');
                await btns.nth(1).click();
                await page.waitForTimeout(400); // після короткого «заспокоєння» скрол закриває
                await page.evaluate(() => { const w = document.querySelector('.kp-win-body'); if (w) w.scrollTop += 40; else window.scrollBy(0, 40); });
                await page.waitForTimeout(150);
                assert.equal(await open().count(), 0, 'скрол закриває');
            });
        });
    }
}
