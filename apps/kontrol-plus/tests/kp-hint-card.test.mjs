// Браузерна перевірка «?» у картці авто (спільний cardField): підказка над сусідніми полями й у межах вікна на 1366 і 390, light / dark.
// Без playwright-core / його Chromium — пропуск.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = fs.readFileSync(path.join(APP, '../../index.html'), 'utf8');
const siteCss = [...SITE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

const ENTRY = `
import { cardField, cardLayout } from './src/views/registry.js';
import { VEHICLE_FIELDS } from './src/lib/registry.js';
import { h } from './src/ui.js';
document.body.setAttribute('data-kp-view', 'fleet');
const main = document.createElement('main'); main.id = 'kp-crm'; document.body.append(main);
const rows = VEHICLE_FIELDS.map((spec) => (spec.section ? h('h3', { class: 'kpc-section' }, spec.section) : cardField(spec, '', { options: [] }).row));
main.append(cardLayout({ title: 'Нове авто', fields: rows, message: h('div'), actions: [] }));
window.__ready = true;
`;
const PAGE = (theme) => `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-shell.css">
</head><body class="layout-studio kp-shell-on" data-theme="${theme}"><script type="module" src="/entry.js"></script></body></html>`;

async function run(t, theme, viewport, fn) {
    let pw; let esbuild;
    try { pw = await import('playwright-core'); esbuild = await import('esbuild'); } catch { t.skip('no playwright-core / esbuild'); return; }
    let browser;
    try { browser = await pw.chromium.launch({ headless: true }); } catch { t.skip('no Chromium'); return; }
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
        await fn(page);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); server.close(); }
}

for (const [name, viewport] of [['1366', { width: 1366, height: 768 }], ['390', { width: 390, height: 844 }]]) {
    for (const theme of ['light', 'dark']) {
        test(`браузер ${name} ${theme}: «?» у картці авто — над сусідніми полями, у межах вікна, одна відкрита`, async (t) => {
            await run(t, theme, viewport, async (page) => {
                const btns = page.locator('.kpc-row .kp-hint-btn');
                const count = await btns.count();
                assert.ok(count >= 15, 'підказок у картці: ' + count);
                for (let i = 0; i < count; i++) {
                    await btns.nth(i).scrollIntoViewIfNeeded();
                    await page.waitForTimeout(30);
                    await btns.nth(i).click();
                    const info = await page.evaluate(() => {
                        const open = [...document.querySelectorAll('.kp-hint-pop:not([hidden])')];
                        const pop = open[0];
                        const r = pop.getBoundingClientRect();
                        const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 10, r.top + 10], [r.right - 10, r.bottom - 10]];
                        return {
                            n: open.length, text: pop.textContent,
                            over: pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return e === pop || pop.contains(e); }),
                            inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, w: r.width,
                        };
                    });
                    assert.equal(info.n, 1, 'одна відкрита');
                    assert.equal(info.over, true, 'над полями: ' + info.text);
                    assert.equal(info.inside, true, 'у межах вікна: ' + info.text);
                    assert.ok(info.w <= 281);
                    await page.keyboard.press('Escape');
                }
            });
        });
    }
}
