// Компактний «Розрахунок рейсу» на сайті (без isKP()) і перейменування «калькулятор» → «Розрахунок рейсу» у видимих текстах.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const block = html.slice(html.indexOf('/*TC-COMPACT-START*/'), html.indexOf('/*TC-COMPACT-END*/'));

test('компактний CSS є в index.html і не залежить від isKP() / kp-shell-on', () => {
    assert.ok(block.length > 3000, 'блок TC-COMPACT на місці');
    assert.equal(/kp-shell|isKP|data-app/.test(block), false);
    assert.match(block, /body\.layout-studio\[data-theme\]\[data-studio-view="calc"\] \{[^}]*--tc-h: 30px/);
    assert.match(block, /--kpc-off: var\(--cc-off, var\(--tc-sticky-h, 0px\)\)/);
    assert.match(block, /--kpc-kpi-h: var\(--tc-strip-h, 49px\)/);
    assert.match(block, /clamp\(380px, 34vw, 480px\) minmax\(0, 1fr\)/);
    assert.match(block, /min-height: 360px !important/);
    assert.match(block, /height: 45vh !important/);
    assert.match(block, /@media \(min-width: 901px\) and \(max-width: 1200px\)/);
});

test('висота карти не використовує --tc-map-h; нових зашитих кольорів у блоці немає', () => {
    assert.equal(/height:[^;]*--tc-map-h/.test(block), false);
    assert.match(block, /height: min\(calc\(100vh - var\(--kpc-off\)[^;]*var\(--cc-room, 100vh\)\)[^;]*!important/);
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#(tc-|route-|swap-|studio-|podacha-|vehicle-|demo)[\w-]*/g, '')), false, 'лише змінні тем');
});

test('розмітка розрахунку рейсу і id полів на сайті ті самі', () => {
    for (const id of ['route-name', 'dist', 'podacha-dist', 'volume', 'rate', 'swap-ab-btn', 'route-calc-btn', 'waypoints-list', 'osm-base-wrap', 'tc-kpi-bar']) {
        assert.ok(html.includes('id="' + id + '"') || html.includes("'" + id + "'") || html.includes('"' + id + '"'), id);
    }
    assert.ok(html.includes('<body class="layout-studio" data-theme="light">'));
});

test('сайт: ResizeObserver на мапу шле window resize; у Контроль+ це робить kp-calc.js', () => {
    assert.match(html, /document\.documentElement\.getAttribute\('data-app'\) === 'kp'\) return;/);
    assert.match(html, /querySelector\('#studio-right > \.tc-map-frame'\)/);
});

// Видимі рядки: без коментарів (/* */, <!-- -->, // у кінці рядка).
function visible(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
        .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}
function walk(dir, out = []) {
    for (const name of readdirSync(new URL('../' + dir, import.meta.url))) {
        if (name === 'node_modules' || name === 'dist' || name === 'tests') continue;
        const rel = dir + '/' + name;
        if (statSync(new URL('../' + rel, import.meta.url)).isDirectory()) walk(rel, out);
        else if (/\.(js|mjs|html|css)$/.test(name)) out.push(rel);
    }
    return out;
}

test('у видимих текстах немає слова «калькулятор»: сайт, лендинг, листи, KP', () => {
    const files = ['index.html', 'landing/kontrol-plus.html', 'lib/weekly-report.js', 'api/calculate.js', 'site.webmanifest', 'scripts/gen-og-image.mjs',
        ...walk('apps/kontrol-plus/src')];
    const bad = [];
    for (const f of files) {
        visible(read(f)).split('\n').forEach((l, i) => { if (/калькулятор/i.test(l)) bad.push(f + ':' + (i + 1)); });
    }
    assert.deepEqual(bad, []);
    assert.match(html, /id="studio-nav-calc"[^>]*>Розрахунок рейсу<\/button>/);
    assert.match(html, /<title>TRIP-CONTROL · розрахунок рейсу/);
    assert.match(html, /tc-panel-eyebrow">Розрахунок рейсу</);
    assert.match(read('apps/kontrol-plus/src/views/request-window.js'), /'Відкрити в розрахунку рейсу'/);
});

// ---- Браузерні перевірки сайту: демо-режим на localhost (?preview=1), власний Chromium Playwright (не Chrome); без нього пропуск ----
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/json', '.jpg': 'image/jpeg' };

async function withSite(t, fn) {
    let pw;
    try { pw = await import('playwright-core'); } catch { t.skip('no playwright-core'); return; }
    let browser;
    try { browser = await pw.chromium.launch({ headless: true }); } catch { t.skip('no Chromium'); return; }
    const server = createServer((req, res) => {
        let p = new URL(req.url, 'http://x').pathname;
        if (p === '/') p = '/index.html';
        const f = join(ROOT, decodeURIComponent(p));
        if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
        res.end(readFileSync(f));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const open = async (w, h, theme = 'light') => {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 900 });
        const page = await ctx.newPage();
        await page.addInitScript((th) => { try { localStorage.setItem('tc_theme', th); } catch { /* приватний режим */ } }, theme);
        await page.goto('http://127.0.0.1:' + server.address().port + '/?preview=1', { waitUntil: 'load' });
        await page.waitForFunction(() => document.body.dataset.studioView === 'calc' && document.querySelector('#tc-op .tc-in'));
        await page.waitForTimeout(700);
        return page;
    };
    try { await fn(open); } finally { await browser.close(); server.close(); }
}
// Стан «після оплати / без першого запуску»: без демо-блоків і банера першого рейсу (у демо кнопка «Розрахувати відстань» прихована).
const realState = (page) => page.evaluate(() => { document.body.classList.remove('demo-mode'); const b = document.getElementById('onboard-banner'); if (b) b.remove(); });

test('браузер 1366×768: «Розрахувати відстань» і крок 1 видно без скролу; поля 30px / 13px, підписи 12px, кнопки 28px (light і dark)', async (t) => {
    await withSite(t, async (open) => {
        for (const theme of ['light', 'dark']) {
            const page = await open(1366, 768, theme);
            await realState(page);
            await page.waitForTimeout(300);
            const m = await page.evaluate(() => {
                const r = (s) => document.querySelector(s).getBoundingClientRect();
                const cs = (s) => getComputedStyle(document.querySelector(s));
                return {
                    btn: r('#route-calc-btn'), btnVisible: r('#route-calc-btn').height > 0, step1: r('#tc-acc-route'), scroll: window.scrollY, vh: innerHeight,
                    field: Math.round(r('#tc-op .tc-in').height), fieldFs: cs('#tc-op .tc-in > input').fontSize, label: cs('#tc-op .form-row > label').fontSize,
                    btnH: Math.round(r('#route-calc-btn').height), clearH: Math.round(r('#tc-op .tc-panel-clear').height), kpi: Math.round(r('.tc-kpi-bar').height),
                    cols: cs('#tc-op .tc-sec-body:has(.tc-f-podacha)').gridTemplateColumns.split(' ').length, over: document.documentElement.scrollWidth - innerWidth,
                };
            });
            assert.equal(m.scroll, 0);
            assert.ok(m.btnVisible && m.btn.top >= 0 && m.btn.bottom <= m.vh, theme + ': кнопка в межах екрана ' + JSON.stringify(m.btn));
            assert.ok(m.step1.bottom <= m.vh, theme + ': крок 1 цілком на екрані: ' + m.step1.bottom);
            assert.deepEqual([m.field, m.fieldFs, m.label, m.btnH, m.clearH], [30, '13px', '12px', 28, 28], theme);
            assert.ok(m.kpi <= 64, 'KPI — тонка смужка: ' + m.kpi);
            assert.equal(m.cols, 2, 'короткі поля парами');
            assert.ok(m.over <= 0);
            await page.close();
        }
    });
});

test('браузер: під мапою немає порожнечі — в кінці сторінки низ мапи ≈ низ колонки форми (1366 і 1920)', async (t) => {
    await withSite(t, async (open) => {
        for (const [w, h] of [[1366, 768], [1920, 1080]]) {
            const page = await open(w, h);
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            await page.waitForTimeout(400);
            const m = await page.evaluate(() => {
                const map = document.querySelector('.tc-map-frame').getBoundingClientRect();
                const left = document.getElementById('studio-left').getBoundingClientRect();
                const room = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cc-room'));
                return { mapBottom: Math.round(map.bottom), leftBottom: Math.round(left.bottom), mapH: Math.round(map.height), mapTop: Math.round(map.top), room };
            });
            assert.ok(Math.abs(m.mapBottom - m.leftBottom) <= 14, w + ': низ мапи ' + m.mapBottom + ' ≈ низ колонки форми ' + m.leftBottom);
            assert.ok(m.mapH <= m.room + 1 && m.mapH >= 360, w + ': висота мапи в межах --cc-room');
            // На початку сторінки мапа sticky: займає видиму висоту, а не лишає порожнє поле під собою у вікні.
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(300);
            const top = await page.evaluate(() => { const b = document.querySelector('.tc-map-frame').getBoundingClientRect(); return [Math.round(b.bottom), innerHeight]; });
            assert.ok(top[0] <= top[1], w + ': мапа в межах вікна на початку сторінки');
            await page.close();
        }
    });
});

test('браузер 390: без горизонтального скролу; поля 40px і 16px (iOS не зумить), одна колонка, мапа ≈ 40vh; те саме на 1024 і 1920', async (t) => {
    await withSite(t, async (open) => {
        for (const theme of ['light', 'dark']) {
            const page = await open(390, 844, theme);
            const m = await page.evaluate(() => {
                const i = document.querySelector('#tc-op .tc-in > input');
                return {
                    over: document.documentElement.scrollWidth - innerWidth, fs: getComputedStyle(i).fontSize, h: Math.round(document.querySelector('#tc-op .tc-in').getBoundingClientRect().height),
                    cols: getComputedStyle(document.querySelector('#tc-op .tc-sec-body:has(.tc-f-podacha)')).gridTemplateColumns.split(' ').length,
                    map: Math.round(document.querySelector('.tc-map-frame').getBoundingClientRect().height), vh: innerHeight,
                };
            });
            assert.ok(m.over <= 0, theme + ': горизонтальний скрол ' + m.over);
            assert.deepEqual([m.fs, m.h, m.cols], ['16px', 40, 1], theme);
            assert.ok(Math.abs(m.map - 0.4 * m.vh) <= 2, theme + ': мапа ' + m.map + ' ≈ 40vh ' + 0.4 * m.vh);
            await page.close();
        }
        for (const [w, h] of [[1024, 768], [1920, 1080]]) {
            const page = await open(w, h);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, w + ': без горизонтального скролу');
            await page.close();
        }
    });
});

test('браузер: перемикач «покроково / усе одразу» і каскад прибутку на місці й працюють', async (t) => {
    await withSite(t, async (open) => {
        const page = await open(1366, 768);
        const ids = await page.evaluate(() => ({ stepper: !!document.querySelector('#tc-acc, .tc-acc'), cascade: !!document.getElementById('tc-cascade'), kpi: !!document.querySelector('.tc-kpi-bar'), detail: !!document.querySelector('.tc-kb-detail') }));
        assert.deepEqual(ids, { stepper: true, cascade: true, kpi: true, detail: true });
        await page.click('.tc-kb-detail');
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.body.dataset.calcDetail), '1', '«Детально» відкриває каскад');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('tc-cascade')).display !== 'none'), true);
    });
});

test('браузер: ДЕМО-стан (банер першого запуску + демо-блоки) 1366×768 light/dark — останнє поле кроку 1 і «Підставити демо-рейс» без скролу; банер тонкий; 390 без h-скролу', async (t) => {
    await withSite(t, async (open) => {
        for (const theme of ['light', 'dark']) {
            const page = await open(1366, 768, theme);
            const m = await page.evaluate(() => {
                const r = (s) => document.querySelector(s).getBoundingClientRect();
                const list = document.getElementById('setup-checks');
                return {
                    demo: document.body.classList.contains('demo-mode'), bannerVisible: r('#onboard-banner').height > 0, banner: Math.round(r('#onboard-banner').height),
                    action: r('#onboard-banner .btn'), close: r('#onboard-banner .hint-close'), truck: r('#tc-op .tc-f-truck'), scroll: window.scrollY, vh: innerHeight,
                    chipsFit: [...list.children].every((c) => c.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1),
                    note: getComputedStyle(document.getElementById('tc-demo-fields-note')).display !== 'none', over: document.documentElement.scrollWidth - innerWidth,
                };
            });
            assert.equal(m.demo, true);
            assert.ok(m.bannerVisible && m.banner <= 64, theme + ': банер — тонкий блок: ' + m.banner);
            assert.ok(m.action.top >= 0 && m.action.bottom <= m.vh && m.action.height >= 24, theme + ': «Підставити демо-рейс» видно ' + JSON.stringify(m.action));
            assert.ok(m.close.bottom <= m.vh, theme + ': хрестик на місці');
            assert.ok(m.truck.bottom <= m.vh, theme + ': останнє поле кроку 1 без скролу: ' + m.truck.bottom);
            assert.equal(m.scroll, 0);
            assert.equal(m.chipsFit, true, theme + ': статуси налаштувань не обрізані');
            assert.equal(m.note, true, 'демо-підказка на місці (зміст не прибрано)');
            assert.ok(m.over <= 0);
            await page.close();
        }
        for (const theme of ['light', 'dark']) {
            const page = await open(390, 844, theme);
            assert.ok(await page.evaluate(() => document.body.classList.contains('demo-mode')));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, theme + ': демо на 390 без горизонтального скролу');
            await page.close();
        }
    });
});

test('браузер: мапа доходить до низу вікна на будь-якому скролі (room() перераховується на scroll); у кінці — до низу лівої колонки', async (t) => {
    await withSite(t, async (open) => {
        const geo = (page) => page.evaluate(() => {
            const m = document.querySelector('.tc-map-frame').getBoundingClientRect();
            return { top: Math.round(m.top), bottom: Math.round(m.bottom), kpi: Math.round(document.getElementById('tc-kpi-bar').getBoundingClientRect().bottom), left: Math.round(document.getElementById('studio-left').getBoundingClientRect().bottom), vh: innerHeight };
        });
        const scrollTo = async (page, y) => { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(450); };
        for (const [w, h] of [[1366, 768], [1280, 600]]) {
            for (const theme of ['light', 'dark']) {
                const page = await open(w, h, theme);
                await scrollTo(page, 300);
                const g = await geo(page);
                assert.ok(g.bottom >= g.vh - 16, w + 'x' + h + ' ' + theme + ': низ мапи ' + g.bottom + ' ≥ ' + (g.vh - 16) + ' (порожнечі під нею немає)');
                assert.ok(g.top >= g.kpi, w + 'x' + h + ': верх мапи ' + g.top + ' не під KPI-смугою ' + g.kpi);
                await page.close();
            }
        }
        // Початок сторінки: мапа в межах вікна; кінець: низ мапи ≈ низ лівої колонки (±14px).
        for (const [w, h] of [[1366, 768], [1920, 1080]]) {
            const page = await open(w, h);
            await scrollTo(page, 0);
            const g0 = await geo(page);
            assert.ok(g0.bottom <= g0.vh, w + ': на скролі 0 мапа в межах вікна: ' + g0.bottom);
            await scrollTo(page, 99999);
            const g1 = await geo(page);
            assert.ok(Math.abs(g1.bottom - g1.left) <= 14, w + ': у кінці низ мапи ' + g1.bottom + ' ≈ низ колонки ' + g1.left);
            await page.close();
        }
        // 1920×1080 не зламався: посередині мапа не виходить за вікно і не заходить нижче колонки; без горизонтального скролу.
        const page = await open(1920, 1080);
        await scrollTo(page, 300);
        const g = await geo(page);
        assert.ok(g.bottom <= g.vh && g.bottom <= g.left + 14 && g.top >= g.kpi, '1920 посередині: ' + JSON.stringify(g));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0);
        // Телефон: нічого не змінилось — мапа 40vh і після прокрутки.
        const phone = await open(390, 844);
        await scrollTo(phone, 300);
        const mh = await phone.evaluate(() => Math.round(document.querySelector('.tc-map-frame').getBoundingClientRect().height));
        assert.ok(Math.abs(mh - 0.4 * 844) <= 2, '390: мапа 40vh: ' + mh);
    });
});
