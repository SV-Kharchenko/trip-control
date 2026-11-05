// Мобільна версія Контроль+ (PR 5 з 5): шторка, «← Назад», картки замість вікон, ⋯ і «Фільтри (N)», форми 40px / 16px, без горизонтального скролу на 390,
// чистка (мертвий код, тексти ролей, кольори лише змінними). Браузерні перевірки — у власному Chromium Playwright (не Chrome); без нього пропуск.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CARDS_MAX, MOBILE_MAX, backFallback, filterCount, isBackRoute, swipeAction } from '../src/lib/mobile-core.js';
import { handleFakeConfig } from '../../../tests/helpers/fake-config.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(APP, file), 'utf8');
const UUID = '00000000-0000-4000-8000-000000000001';

// ---- чиста логіка ----
test('межі: 899px — шторка і сторінки замість вікон, 699px — картки; свайп шторки', () => {
    assert.deepEqual([MOBILE_MAX, CARDS_MAX], [899, 699]);
    assert.equal(swipeAction({ dx: -90, dy: 5, startX: 200, open: true }), 'close');
    assert.equal(swipeAction({ dx: 90, dy: 5, startX: 10, open: false }), 'open');
    assert.equal(swipeAction({ dx: 90, dy: 5, startX: 200, open: false }), null, 'відкриває лише свайп від лівого краю');
    assert.equal(swipeAction({ dx: -90, dy: 5, startX: 200, open: false }), null);
    assert.equal(swipeAction({ dx: -30, dy: 0, startX: 200, open: true }), null, 'короткий зсув — не свайп');
    assert.equal(swipeAction({ dx: -80, dy: 120, startX: 200, open: true }), null, 'вертикальна прокрутка — не свайп');
});

test('«← Назад»: лише на сторінках карток і форм; запасний шлях — список розділу', () => {
    assert.equal(isBackRoute('#/clients/' + UUID), true);
    assert.equal(isBackRoute('#/docs/new/invoice/' + UUID), true);
    assert.equal(isBackRoute('#/fleet/car/' + UUID), true);
    assert.equal(isBackRoute('#/drivers/new'), true);
    assert.equal(isBackRoute('#/clients'), false);
    assert.equal(isBackRoute('#/dashboard'), false);
    assert.equal(isBackRoute(''), false);
    assert.equal(backFallback('#/fleet/trailer/' + UUID), '#/fleet/trailers');
    assert.equal(backFallback('#/fleet/car/new'), '#/fleet');
    assert.equal(backFallback('#/drivers/' + UUID), '#/drivers');
    assert.equal(backFallback('#/docs/new/act/' + UUID), '#/docs/tab/acts');
    assert.equal(backFallback('#/clients/' + UUID), '#/clients');
});

test('«Фільтри (N)»: рахуються лише змінені відносно початкових', () => {
    assert.equal(filterCount([{ type: 'text', value: '', initial: '' }, { type: 'date', value: '2026-11-01', initial: '2026-11-01' }]), 0);
    assert.equal(filterCount([{ type: 'text', value: 'MAN', initial: '' }, { type: 'select-one', value: 'b', initial: 'a' }, { type: 'checkbox', checked: true, initialChecked: false }]), 3);
    assert.equal(filterCount(null), 0);
});

// ---- статичні перевірки ----
test('кольори в KP-стилях — лише змінні (rgba / #hex поза визначеннями змінних = 0)', () => {
    for (const file of ['src/crm.css', 'src/kp-registry.css', 'src/kp-shell.css', 'src/kp-windows.css', 'src/kp-mobile.css', 'src/kp-report.css', 'src/kp-dashboard.css']) {
        const lines = read(file).replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
            .filter((l) => !/^\s*--[\w-]+:/.test(l) && !/\[data-theme="dark"\] \{ --/.test(l) && !/data-theme="dark"\]\.kp-shell-on \.tc-modal \{/.test(l));
        const bad = lines.filter((l) => /rgba\(|#[0-9a-fA-F]{3,6}(?![\w-])/.test(l));
        assert.deepEqual(bad, [], file);
    }
});

test('чистка: мертвий docs-fleet.js прибрано; тексти ролей: «директор», у коментарях — коди ролей', () => {
    assert.equal(fs.existsSync(path.join(APP, 'src/views/docs-fleet.js')), false);
    assert.equal(/VEHICLE_TTN_FIELDS|REGISTRY_SPECS|export function periodDays/.test(read('src/lib/fleet.js') + read('src/lib/registry.js') + read('src/lib/maintenance.js')), false);
    const gps = read('lib/gps/api.js');
    assert.match(gps, /'OWNER_ONLY', 'Підключенням GPS керує директор компанії\.'/, 'код OWNER_ONLY лишився');
    assert.equal(/власник/.test(gps + read('lib/repairs/invites.js')), false);
    assert.match(read('lib/repairs/invites.js'), /лише owner;/);
});

test('підключення: kp-mobile.css і kp-mobile.js лише в Контроль+, сайт не чіпали', () => {
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-mobile\.css';/);
    assert.match(read('src/bridge.js'), /mountMobile\(\);/);
    assert.equal(/kp-mobile/.test(fs.readFileSync(path.join(APP, '../../index.html'), 'utf8')), false);
    const css = read('src/kp-mobile.css');
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((r) => r && !r.startsWith('@'));
    for (const list of rules) for (const sel of list.split(',').map((x) => x.trim()).filter(Boolean)) {
        assert.ok(/^(body\.kp-shell-on|#kp-crm|.tc-history-cards|\.kpd-)/.test(sel) || /^html\[data-app="kp"\] body\.kp-shell-on/.test(sel), 'правило без області КП: ' + sel);
    }
    // Форми на телефоні: 40px, 16px; основна дія закріплена знизу з safe-area.
    assert.match(css, /min-height: 40px; height: 40px; font-size: 16px/);
    assert.match(css, /position: sticky; bottom: 0;[\s\S]*env\(safe-area-inset-bottom/);
    assert.match(css, /\.kpd-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(css, /\.tc-map-frame \{ height: 40vh !important;/);
});

// ---- браузер ----
async function launch() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}
const siteCss = [...fs.readFileSync(path.join(APP, '../../index.html'), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const CSS = ['crm', 'kp-shell', 'kp-registry', 'kp-win-scope', 'kp-windows', 'kp-calc', 'kp-dashboard', 'kp-report', 'kp-mobile'];
const PAGE = `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/site.css">${CSS.map((c) => `<link rel="stylesheet" href="/src/${c}.css">`).join('')}</head><body><script type="module" src="/tests/helpers/kp-mobile-view.js"></script></body></html>`;

async function withBrowser(t, fn) {
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
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const shots = process.env.KP_SHOTS_DIR || null;
    const open = async (w, h, view, theme = 'light') => {
        const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: w < 900 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(base + `?view=${view}&theme=${theme}`);
        await page.waitForFunction(() => window.__ready === true);
        await page.waitForTimeout(250);
        page.errors = errors;
        return page;
    };
    try { await fn({ open, shots }); } finally { await browser.close(); server.close(); }
}

test('браузер: на 390 і 768 немає горизонтального скролу ключових сторінок (світла й темна)', async (t) => {
    await withBrowser(t, async ({ open }) => {
        for (const [w, h] of [[390, 844], [768, 1024]]) {
            for (const theme of ['light', 'dark']) {
                for (const view of ['dashboard', 'report', 'client', 'invoice', 'fleet', 'vehicle', 'drivers', 'repairs']) {
                    const page = await open(w, h, view, theme);
                    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                    assert.ok(over <= 0, `${view} ${w} ${theme}: горизонтальний скрол ${over}px`);
                    assert.deepEqual(page.errors, [], view);
                    await page.close();
                }
            }
        }
    });
});

test('браузер: бургер відкриває й закриває меню (тап по фону, Esc, свайп), пошук-іконка розгортається', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const page = await open(390, 844, 'client');
        const isOpen = () => page.evaluate(() => document.body.classList.contains('kp-shell-open'));
        const sideX = () => page.evaluate(() => Math.round(document.getElementById('kp-shell-side').getBoundingClientRect().left));
        assert.equal(await isOpen(), false);
        assert.ok(await sideX() < 0, 'шторка за межами екрана');
        await page.click('.kp-shell-burger');
        assert.equal(await isOpen(), true);
        assert.equal(await page.getAttribute('.kp-shell-burger', 'aria-expanded'), 'true');
        await page.waitForTimeout(300);
        assert.equal(await sideX(), 0);
        const scrim = await page.evaluate(() => getComputedStyle(document.getElementById('kp-shell-backdrop')).backgroundColor);
        assert.match(scrim, /rgba\(\d+, \d+, \d+, 0\.\d+\)/, 'фон шторки — var(--kp-scrim), напівпрозорий');
        await page.mouse.click(350, 400); // тап по фону
        assert.equal(await isOpen(), false);
        await page.click('.kp-shell-burger');
        await page.keyboard.press('Escape');
        assert.equal(await isOpen(), false, 'Esc закриває');
        // Свайп: вправо від лівого краю відкриває, вліво по відкритій — закриває.
        const swipe = (x0, x1) => page.evaluate(([a, b]) => {
            const mk = (type, x) => { const t = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 300 }); document.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true })); };
            mk('touchstart', a); mk('touchend', b);
        }, [x0, x1]);
        await swipe(8, 150);
        assert.equal(await isOpen(), true, 'свайп вправо від краю');
        await swipe(220, 60);
        assert.equal(await isOpen(), false, 'свайп вліво');
        // Пошук іконкою.
        await page.click('.kp-shell-search');
        assert.equal(await page.evaluate(() => document.body.classList.contains('kp-shell-search-open')), true);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kp-shell-search-in')).display), 'block');
        assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kp-shell-search-in')).fontSize)), 16);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.body.classList.contains('kp-shell-search-open')), false);
        // Шапка: назва компанії видна; на комп'ютері бургера немає.
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kp-shell-company')).display), 'block');
        await page.setViewportSize({ width: 1366, height: 768 });
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kp-shell-burger')).display), 'none');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('kp-shell-backdrop')).display), 'none');
    });
});

test('браузер: картка — повноекранна сторінка з «← Назад» на <900px і вікно на ≥900px', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const phone = await open(390, 844, 'client');
        assert.equal(await phone.evaluate(() => window.__wm.enabled()), false, 'вікон на телефоні немає');
        const res = await phone.evaluate(() => { const r = window.__wm.open({ type: 'client', id: 'x', key: 'client:x', title: 'Клієнт', build() {} }); return [r.ok, r.reason, document.querySelectorAll('.kp-win').length]; });
        assert.deepEqual(res, [false, 'narrow', 0]);
        assert.equal(await phone.isVisible('#kp-shell-back'), true, '«← Назад» на сторінці картки');
        assert.equal(await phone.innerText('.kp-shell-back-btn'), '← Назад');
        assert.equal(await phone.isVisible('.kp-crm .page > .back'), false, 'старе «← До …» не дублює');
        assert.ok(await phone.evaluate(() => document.getElementById('kp-crm').getBoundingClientRect().top > document.getElementById('kp-shell-back').getBoundingClientRect().bottom - 2), 'вміст не під панеллю «Назад»');
        // Back браузера працює: «← Назад» повертає в історію (hash-маршрути ті самі).
        await phone.evaluate(() => { history.pushState(null, '', '#/clients'); history.pushState(null, '', '#/clients/00000000-0000-4000-8000-000000000001'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
        await phone.click('.kp-shell-back-btn');
        await phone.waitForFunction(() => location.hash === '#/clients');
        await phone.close();
        const desk = await open(1366, 768, 'client');
        assert.equal(await desk.evaluate(() => window.__wm.enabled()), true);
        assert.equal(await desk.evaluate(() => { const r = window.__wm.open({ type: 'client', id: 'x', key: 'client:x', title: 'Клієнт', build() {} }); return [r.ok, document.querySelectorAll('.kp-win').length].join(); }), 'true,1');
        assert.equal(await desk.isVisible('#kp-shell-back'), false, 'на комп\'ютері «Назад» немає');
    });
});

test('браузер: рядок-картка — дії в меню «⋯»; фільтри — у панелі «Фільтри (N)»; на широкому все повертається', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const page = await open(390, 844, 'repairs');
        // Фільтри розділу ховаються в панель.
        const toggle = page.locator('.kp-flt-toggle').first();
        assert.equal(await toggle.innerText(), 'Фільтри');
        assert.equal(await page.locator('.kp-flt').first().isVisible(), false);
        await toggle.click();
        assert.equal(await page.locator('.kp-flt').first().isVisible(), true);
        await page.locator('.kp-flt select').first().selectOption({ index: 1 }).catch(() => {});
        assert.match(await toggle.innerText(), /^Фільтри( \(\d\))?$/);
        await page.waitForTimeout(500); // список ремонтів перемальовується після завантаження авто
        // Дії рядка: кілька кнопок у комірці → одна «⋯».
        await page.evaluate(() => {
            const td = document.querySelector('.kpr-cards td:last-child');
            window.__clicks = [];
            td.replaceChildren(...['Одна', 'Друга', 'Третя'].map((t) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = t; b.onclick = () => window.__clicks.push(t); return b; }));
            td.dataset.label = '';
            td.id = 'kp-test-cell';
        });
        await page.waitForSelector('.kp-more-btn');
        assert.equal(await page.locator('#kp-test-cell .kp-more-btn').count(), 1);
        assert.equal(await page.locator('#kp-test-cell .kp-more-menu').isVisible(), false);
        await page.click('#kp-test-cell .kp-more-btn');
        assert.equal(await page.locator('#kp-test-cell .kp-more-menu').isVisible(), true);
        assert.equal(await page.getAttribute('#kp-test-cell .kp-more-btn', 'aria-expanded'), 'true');
        await page.click('#kp-test-cell .kp-more-menu >> text=Друга');
        assert.deepEqual(await page.evaluate(() => window.__clicks), ['Друга'], 'обробник перенесеної кнопки працює');
        assert.equal(await page.locator('#kp-test-cell .kp-more-menu').isVisible(), false, 'меню закрилось після дії');
        // Широкий екран: кнопки на місці, «⋯» і перемикач фільтрів зникли.
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.waitForFunction(() => !document.querySelector('#kp-test-cell .kp-more-btn'));
        assert.equal(await page.locator('#kp-test-cell > button').count(), 3);
        assert.equal(await page.locator('.kp-flt-toggle').count(), 0);
    });
});

test('браузер: форми на телефоні — поля 40px / 16px, один стовпчик, основна дія закріплена; рядки рахунку — картки', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const page = await open(390, 844, 'invoice');
        const m = await page.evaluate(() => {
            const box = (sel) => { const el = document.querySelector(sel); const cs = getComputedStyle(el); return { h: Math.round(el.getBoundingClientRect().height), fs: parseFloat(cs.fontSize), w: Math.round(el.getBoundingClientRect().width) }; };
            const grid = getComputedStyle(document.querySelector('.kpd-grid')).gridTemplateColumns.split(' ').length;
            return { client: box('#d-client'), date: box('#d-date'), grid, sticky: getComputedStyle(document.querySelector('.kpr-sticky')).position, type: document.querySelector('#d-date').type, formW: Math.round(document.querySelector('.kpd-form').getBoundingClientRect().width) };
        });
        assert.deepEqual([m.client.h, m.client.fs, m.date.h, m.date.fs], [40, 16, 40, 16]);
        assert.equal(m.type, 'date', 'нативний input type=date');
        assert.equal(m.grid, 1, 'пари полів — в один стовпчик');
        assert.ok(m.client.w >= m.formW - 50, 'поле на всю ширину форми');
        assert.equal(m.sticky, 'sticky');
        // Рядок рахунку — картка зі смітничком.
        await page.click('label.check >> nth=0');
        await page.click('text=/Додати вибрані/');
        await page.waitForSelector('.kpd-lines-table');
        const row = await page.evaluate(() => ({ display: getComputedStyle(document.querySelector('.kpd-row')).display, head: getComputedStyle(document.querySelector('.kpd-lines-table thead')).display, del: !!document.querySelector('.kpd-row .kpd-del[title="Видалити рядок"]'), over: document.documentElement.scrollWidth - innerWidth }));
        assert.deepEqual([row.display, row.head, row.del], ['grid', 'none', true]);
        assert.ok(row.over <= 0);
        // Картка клієнта: поля теж 40px / 16px.
        const card = await open(390, 844, 'vehicle');
        const f = await card.evaluate(() => { const el = document.querySelector('.kpc-body input'); const cs = getComputedStyle(el); return [Math.round(el.getBoundingClientRect().height), parseFloat(cs.fontSize), (() => { const rows = [...document.querySelectorAll('.kpc-body > .kpc-row')].slice(0, 6).map((r) => r.getBoundingClientRect()); return rows.every((r, i) => i === 0 || (r.left === rows[0].left && r.top > rows[i - 1].top)) ? 1 : 2; })()]; });
        assert.deepEqual(f, [40, 16, 1], 'поля картки — в один стовпчик');
    });
});

test('браузер: огляд — KPI по дві в ряд на 390; план/факт — перша колонка липка, решта прокручується всередині таблиці', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const dash = await open(390, 844, 'dashboard');
        const cols = await dash.evaluate(() => getComputedStyle(document.querySelector('.kpd-kpis')).gridTemplateColumns.split(' ').length);
        assert.equal(cols, 2);
        const chart = await dash.evaluate(() => { const c = document.querySelector('.kpd-chart'); const r = c.getBoundingClientRect(); return [Math.round(r.width), document.documentElement.clientWidth]; });
        assert.ok(chart[0] >= chart[1] - 60, 'графік на всю ширину');
        const rep = await open(390, 844, 'report');
        const info = await rep.evaluate(() => { const w = document.querySelector('.kpq-wrap'); const th = document.querySelector('.kpq tbody tr > :first-child'); return { scrolls: w.scrollWidth > w.clientWidth, pos: getComputedStyle(th).position, over: document.documentElement.scrollWidth - innerWidth }; });
        assert.deepEqual([info.scrolls, info.pos], [true, 'sticky']);
        assert.ok(info.over <= 0);
        await rep.evaluate(() => { document.querySelector('.kpq-wrap').scrollLeft = 200; });
        const x = await rep.evaluate(() => Math.round(document.querySelector('.kpq tbody tr > :first-child').getBoundingClientRect().left - document.querySelector('.kpq-wrap').getBoundingClientRect().left));
        assert.ok(x <= 2, 'перша колонка лишається на місці при прокрутці: ' + x);
    });
});

test('знімки екранів (KP_SHOTS_DIR): 390 / 768 / 1366 × light / dark', async (t) => {
    await withBrowser(t, async ({ open, shots }) => {
        if (!shots) { t.skip('KP_SHOTS_DIR не задано'); return; }
        fs.mkdirSync(shots, { recursive: true });
        for (const theme of ['light', 'dark']) {
            for (const [w, h] of [[390, 844], [768, 1024], [1366, 768]]) {
                for (const view of ['invoice', 'vehicle', 'dashboard', 'report']) {
                    const page = await open(w, h, view, theme);
                    await page.screenshot({ path: path.join(shots, `${view}-${w}-${theme}.png`) });
                    await page.close();
                }
                if (w === 1366) { const bar = await open(w, h, 'dashboard', theme); await bar.screenshot({ path: path.join(shots, `header-${w}-${theme}.png`), clip: { x: 0, y: 0, width: w, height: 60 } }); await bar.close(); }
                const menu = await open(w, h, 'client', theme);
                if (w < 900) { await menu.click('.kp-shell-burger'); await menu.waitForTimeout(350); }
                await menu.screenshot({ path: path.join(shots, `menu-${w}-${theme}.png`) });
                await menu.close();
            }
        }
    });
});

test('браузер: шапка на ≥900px — порядок як до PR (компанія справа перед дзвіночком); на телефоні — компанія зліва', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const order = (page) => page.evaluate(() => {
            const top = document.getElementById('kp-shell-top');
            const left = (sel) => Math.round(top.querySelector(sel).getBoundingClientRect().left);
            return { dom: [...top.children].map((c) => c.className.split(' ')[0]), company: left('.kp-shell-company'), bell: left('.kp-shell-bell'), search: left('.kp-shell-search') };
        });
        const desk = await open(1366, 768, 'dashboard');
        const d = await order(desk);
        assert.deepEqual(d.dom.slice(0, 2), ['kp-shell-burger', 'kp-shell-search'], 'DOM як у PR 1');
        assert.ok(d.dom.indexOf('kp-shell-company') > d.dom.indexOf('kp-shell-grow') && d.dom.indexOf('kp-shell-company') < d.dom.indexOf('kp-shell-bell'));
        assert.ok(d.search < d.company && d.company < d.bell, 'пошук зліва, компанія справа перед дзвіночком');
        const phone = await open(390, 844, 'dashboard');
        const p = await order(phone);
        assert.ok(p.company < p.search && p.search < p.bell, 'телефон: компанія, пошук, дзвіночок');
    });
});

test('браузер: пошук розділу не скидається на hashchange (1366 і 390); мобільний пошук чиститься лише коли був відкритий', async (t) => {
    await withBrowser(t, async ({ open }) => {
        for (const [w, h] of [[1366, 768], [390, 844]]) {
            const page = await open(w, h, 'dashboard');
            await page.evaluate(() => { const i = document.createElement('input'); i.type = 'search'; i.id = 'registry-q'; document.getElementById('kp-crm').prepend(i); });
            await page.fill('#registry-q', 'Умань');
            await page.evaluate(() => { location.hash = '#/clients/00000000-0000-4000-8000-000000000001'; });
            await page.evaluate(() => { location.hash = '#/dashboard'; });
            await page.waitForTimeout(200);
            assert.equal(await page.inputValue('#registry-q'), 'Умань', 'значення збережено (' + w + ')');
            if (w < 900) {
                await page.click('.kp-shell-search');
                await page.fill('.kp-shell-search-in', 'Київ');
                assert.equal(await page.inputValue('#registry-q'), 'Київ', 'відкритий мобільний пошук пересилає текст');
                await page.keyboard.press('Escape');
                assert.equal(await page.inputValue('#registry-q'), '', 'закриття відкритого пошуку очищає');
            }
        }
    });
});

test('браузер: KPI по дві в ряд на 768 і 390 (уся мобільна оболонка), на 1366 — як було', async (t) => {
    await withBrowser(t, async ({ open }) => {
        const cols = async (w, h) => { const p = await open(w, h, 'dashboard'); return p.evaluate(() => getComputedStyle(document.querySelector('.kpd-kpis')).gridTemplateColumns.split(' ').length); };
        assert.equal(await cols(768, 1024), 2);
        assert.equal(await cols(390, 844), 2);
        assert.ok(await cols(1366, 768) > 2);
    });
});
