import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceBetween(source, startMark, endMark) {
    const start = source.indexOf(startMark);
    const end = source.indexOf(endMark, start + startMark.length);
    assert.ok(start !== -1 && end !== -1, startMark + ' … ' + endMark);
    return source.slice(start, end);
}

const onepage = sliceBetween(html, 'const CALC_ONEPAGE = true;', 'function arrangeDispatcherForm()');
const build = sliceBetween(onepage, 'function buildOnePage()', 'function focusMissingField(');
const css = sliceBetween(html, '/* ===== Калькулятор, розкладка v2', '</style>');

test('the stepper UI is gone: strip, head and Back/Next are removed, panels stay visible', () => {
    assert.match(build, /strip\.remove\(\)/);
    assert.match(build, /\.tc-step-head, #tc-step-nav'\)\.forEach\(function \(el\) \{ el\.remove\(\); \}\)/);
    assert.match(build, /el\.hidden = false/);
    assert.match(html, /const on = CALC_ONEPAGE \|\| i === calcStep;/);
    assert.match(html, /lp-t-tab/);
    assert.equal(/wizard|майстер/i.test(onepage), false);
});

test('KPI strip is a direct child of #main-app, sticky and wide as the content', () => {
    assert.match(build, /bar\.id = 'tc-kpi-bar'/);
    for (const id of ['kb-profit', 'kb-km', 'kb-be', 'kb-margin', 'kb-detail']) assert.ok(build.includes('id="' + id + '"'), id);
    for (const text of ['Чистий прибуток', 'грн/км', 'Беззбитковість', 'Маржа', 'Детально →']) assert.ok(build.includes(text), text);
    assert.match(build, /main\.insertBefore\(bar, sticky \? sticky\.nextSibling : main\.firstChild\)/);
    assert.match(css, /\.tc-kpi-bar \{\n\s+position: sticky; top: var\(--tc-sticky-h, 0px\); z-index: 30;/);
    assert.match(css, /max-width: 1840px; margin-inline: auto; padding-inline: var\(--tc-pad\)/);
    assert.match(css, /#main-app \{ max-width: none; padding-inline: 0; overflow: visible; \}/);
    assert.match(css, /\.tc-work > \.card \{[^}]*overflow: visible; \}/);
    // Нижче меню (#sticky-top, z-index 40).
    assert.match(html, /#sticky-top \{ position: sticky; top: 0; z-index: 40;/);
    const paint = sliceBetween(onepage, 'function paintKpiBar(', '// «Детально»');
    assert.match(paint, /Чистий прибуток · вкажіть витрату пального/);
    assert.match(paint, /breakevenFullPerTon/);
    // У КП смуга схована (crm.css) і не перекриває меню.
    assert.match(readFileSync(new URL('../apps/kontrol-plus/src/crm.css', import.meta.url), 'utf8'), /body\[data-kp-view\] #tc-kpi-bar/);
});

test('two columns: panel minmax(380px, 40%) + sticky full-height map; ≤900 strip → map 260px → panel', () => {
    assert.match(css, /grid-template-columns: minmax\(380px, 40%\) minmax\(0, 1fr\);/);
    assert.match(css, /position: sticky; top: calc\(var\(--tc-sticky-h, 0px\) \+ var\(--tc-strip-h, 66px\)\);/);
    assert.match(css, /height: var\(--tc-map-h, calc\(100vh - var\(--tc-sticky-h, 0px\) - var\(--tc-strip-h, 66px\) - var\(--tc-pad\)\)\) !important;/);
    assert.match(onepage, /setProperty\('--tc-map-h'/);
    assert.match(css, /#studio-right \{ align-self: stretch; display: block !important;/);
    assert.match(css, /#studio-right \{ order: -1;/);
    assert.match(css, /height: 260px !important;/);
    assert.match(css, /\.tc-kpi-bar \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    assert.match(onepage, /--tc-strip-h/);
    assert.match(onepage, /ro\.observe\(bar\)/);
});

test('panel «Параметри заявки»: 4 accordion rows, fields in the mockup order, no taxes block', () => {
    assert.match(build, /Параметри заявки/);
    const rows = [...build.matchAll(/opAccRow\('([a-z]+)', '([^']+)', '([^']+)'/g)].map((m) => m[1] + ':' + m[3]);
    assert.deepEqual(rows, ['route:Назва / маршрут заявки', 'fuel:Пальне', 'extras:Додаткові параметри', 'recent:Останні маршрути']);
    assert.match(build, /opAccRow\('route', '1', 'Назва \/ маршрут заявки', panel1, true\)/);
    assert.match(build, /opAccRow\('recent', '↺', 'Останні маршрути', recentBody, true\)/);
    const order = build.slice(build.indexOf('panel1.appendChild(nameRow)'), build.indexOf('if (routeTools)'));
    const at = (needle) => order.indexOf(needle);
    assert.ok(at("'Звідки'") > -1 && at("'Звідки'") < at("'Куди'") && at("'Куди'") < at("'Відстань'"));
    assert.ok(at("'Відстань'") < at("'Подача авто'") && at("'Подача авто'") < at("'Вага вантажу'") && at("'Вага вантажу'") < at('rate'));
    assert.ok(at('rate') < at("'Повернення'") && at("'Повернення'") < at('truck]'));
    // Блок «Податки і накладні» прибрано з UI; поля лишаються в прихованому #main-sync-fields.
    assert.equal(/Податки і накладні/.test(build), false);
    assert.equal(/id="tc-acc-tax"|tc-acc-body-tax/.test(onepage), false);
    assert.match(html, /#main-sync-fields \{ display: none !important; \}/);
    for (const id of ['total-fleet', 'to-cost', 'to-period', 'tire-cost', 'tire-count', 'tire-mileage']) {
        assert.equal((html.match(new RegExp('<input[^>]* id="' + id + '"', 'g')) || []).length, 1, id);
        assert.equal(build.includes("'" + id + "'"), false, id + ' stays in #main-sync-fields');
    }
    // Тариф + валюта — одне поле; всі id формул у одному екземплярі.
    assert.match(build, /rateBox\.appendChild\(currency\)/);
    for (const id of ['dist', 'volume', 'rate', 'podacha-dist', 'return-mode', 'contract-currency', 'fuel-load', 'fuel-empty', 'fuel-price', 'calc-type']) {
        assert.equal((html.match(new RegExp('<(?:input|select)[^>]* id="' + id + '"', 'g')) || []).length, 1, id);
    }
    const upd = sliceBetween(onepage, 'function updateOnePage(', 'function opToggleRecent(');
    assert.match(upd, /stepSummaryText\(1\)/);
    assert.match(upd, /' л'/);
    assert.match(upd, /'AdBlue ' \+ opNum\(rate, 2\) \+ ' л\/100км'/);
    assert.match(upd, /'без AdBlue'/);
    assert.match(upd, /'Немає витрати пального для '/);
    assert.match(upd, /if \(fuelOff && !opFuelWasMissing\) setAccOpen\('fuel', true\)/);
    assert.match(build, /Вкажіть витрату — без неї пальне не рахується/);
    assert.match(css, /\.tc-acc-row\.is-open \.tc-acc-sum \{ display: none; \}/);
});

test('fields: equal height, full cell width, units as suffix inside the box, 4 → 2 → 1 grid', () => {
    const wrap = sliceBetween(onepage, 'function opWrapFields(', '// Клітинка сітки');
    assert.match(wrap, /box\.className = 'tc-in'/);
    assert.match(css, /--tc-h: clamp\(40px, 2\.4vw \+ 10px, 46px\);/);
    assert.match(css, /\.tc-in \{ display: flex; align-items: center; height: var\(--tc-h\);/);
    assert.match(css, /\.tc-in > \.unit \{ flex: none; padding-right: 12px;/);
    assert.match(css, /\.tc-sg \{ display: grid; gap: 12px; grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 130px\), 1fr\)\);/);
    assert.match(css, /\.tc-sg\.two \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 250px\), 1fr\)\);/);
    assert.match(css, /--tc-fs: clamp\(14px, 0\.35vw \+ 10\.5px, 16px\);/);
    assert.match(css, /--tc-pad: clamp\(12px, 2vw, 32px\);/);
    // Лише токени тем сайту: жодного нового hex-кольору.
    const stripped = css.replace(/rgba?\([^)]*\)/g, '').replace(/#[a-z][\w-]*/g, '');
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(stripped), false);
    assert.match(css, /var\(--positive\)/);
    assert.match(css, /var\(--negative\)/);
    assert.match(css, /var\(--font-mono\)/);
});

test('recent routes: compact «Місто → Місто» list, title has the full address, 5 + «ще»', () => {
    const paint = sliceBetween(html, 'function renderMergedRecent()', 'function renderRecentRoutes()');
    assert.match(paint, /split\(','\)\[0\]/);
    assert.match(paint, /title="/);
    assert.match(paint, /chips\.slice\(0, opRecentExpanded \? chips\.length : 5\)/);
    assert.match(paint, /'ще ' \+ \(chips\.length - 5\) \+ ' →'/);
    assert.match(paint, /getElementById\('saved-recent'\)/);
    assert.match(build, /recentBlock\.remove\(\)/);
});

test('validation: nothing red on load — only after an attempt or after a touched empty field', () => {
    const vis = sliceBetween(onepage, 'function opVisibleMissing(', '// input + одиниця');
    assert.match(vis, /opAttempted \? missing : missing\.filter/);
    const calc = sliceBetween(html, 'async function calculate()', 'function clearCalcVisuals()');
    assert.match(calc, /const shown = opVisibleMissing\(missing\);/);
    assert.match(calc, /markInvalidFields\(shown\)/);
    assert.match(calc, /mh\.style\.display = 'none'/);
    assert.equal(calc.includes('showCalcStep'), false);
    assert.equal(calc.includes('calcStep'), false);
    assert.match(sliceBetween(html, 'async function runDemoCalc()', 'const AUTH_RATE'), /opAttempted = true;/);
    assert.match(build, /opTouched\[el\.id\] = true/);
    assert.match(build, /closest\('#tc-result-actions button, \.tc-kb-detail'\)\) opAttempted = true/);
    assert.match(sliceBetween(html, 'function markInvalidFields(missing)', 'function revealInvalidStep()'), /openAccFor\(input\)/);
    assert.match(sliceBetween(html, 'function revealInvalidStep()', 'function missingHintHtml('), /openAccFor\(bad\)/);
    assert.match(sliceBetween(html, 'function missingHintHtml(missing)', 'function showToast('), /data-field=/);
});

test('vehicle without a fuel norm: the fuel row opens itself and the fields get .miss', () => {
    const fn = sliceBetween(onepage, 'function opFuelMissing()', 'function opNum(');
    const make = (fields, vehicles, active) => {
        const els = {};
        for (const [id, value] of Object.entries(fields)) els[id] = { value };
        const document = { getElementById: (id) => els[id] || null };
        const resolved = (v) => ({ fuelLoad: v.fuel_load || undefined, fuelEmpty: v.fuel_empty || undefined });
        return new Function('opById', 'fleetChoiceActive', 'chosenFleetVehicles', 'vehicleResolvedNorms', fn + '\nreturn opFuelMissing;')(
            document.getElementById, () => active, () => vehicles, resolved);
    };
    assert.deepEqual(make({ 'fuel-load': '', 'fuel-empty': '' }, [{ label: 'AA1' }], true)(), ['AA1']);
    assert.deepEqual(make({ 'fuel-load': '', 'fuel-empty': '' }, [{ label: 'AA1', fuel_load: 30, fuel_empty: 25 }], true)(), []);
    assert.deepEqual(make({ 'fuel-load': '32', 'fuel-empty': '27' }, [{ label: 'AA1' }], true)(), []);
    assert.deepEqual(make({ 'fuel-load': '', 'fuel-empty': '' }, [], false)(), []);
});

test('«Детально» and «← До розрахунку» switch body[data-calc-detail]; the same map and actions move', () => {
    const fn = sliceBetween(onepage, 'function setCalcDetail(on)', '// Права колонка');
    const attrs = {};
    const dock = { classList: { toggle(name, on) { attrs.dock = [name, on]; } } };
    const document = {
        body: { setAttribute: (k, v) => { attrs[k] = v; } },
        getElementById: (id) => (id === 'dispatcher-result' ? dock : null),
    };
    let placed = 0;
    const run = new Function('document', 'window', 'opById', 'opPlace', fn + '\nreturn setCalcDetail;')(
        document, { scrollTo() {} }, (id) => document.getElementById(id), () => { placed += 1; });
    run(true);
    assert.equal(attrs['data-calc-detail'], '1');
    run(false);
    assert.equal(attrs['data-calc-detail'], '0');
    assert.equal(placed, 2);
    assert.match(build, /back\.textContent = '← До розрахунку'/);
    const place = sliceBetween(onepage, 'function opPlace()', 'function opSyncStickyTop()');
    assert.match(place, /querySelector\('\.tc-map-frame'\)/);
    assert.match(place, /side\.appendChild\(actions\)/);
    assert.equal((html.match(/id="map"/g) || []).length, 1);
    assert.equal((html.match(/id="tc-result-actions"/g) || []).length, 1);
    assert.match(css, /#studio-right > \.tc-map-frame \{ grid-column: 1 !important; grid-row: 2 !important; height: 440px !important;/);
    assert.match(css, /#studio-right > #tc-det-side \{ grid-column: 2 !important; grid-row: 2 !important;/);
    assert.match(css, /#studio-right > #tc-det-back \{ display: inline-flex; grid-column: 1 \/ -1 !important; grid-row: 1 !important; justify-self: start;/);
    const actions = sliceBetween(html, 'id="tc-result-actions"', '</div>');
    assert.match(actions, /saveCalculation\(\)/);
    assert.match(actions, /window\.print\(\)/);
    assert.match(actions, /exportExcel\(\)/);
});

test('formulas and the API are untouched by the layout', () => {
    const calc = sliceBetween(html, 'async function calculate()', 'function clearCalcVisuals()');
    assert.equal(calc.includes('buildOnePage'), false);
    assert.equal(calc.includes('setCalcDetail'), false);
    assert.equal(onepage.includes('supabaseClient'), false);
    assert.equal(onepage.includes('fetch('), false);
});

test('currency and return selects keep short labels', () => {
    const sel = (id) => sliceBetween(html, '<select id="' + id + '"', '</select>');
    const currency = sel('contract-currency');
    assert.match(currency, />грн\/т<\/option>/);
    assert.match(currency, />\$\/т<\/option>/);
    assert.match(currency, />€\/т<\/option>/);
    const ret = sel('return-mode');
    assert.match(ret, /<option value="циклічний">🟢 Циклічний вивіз<\/option>/);
    assert.match(ret, /<option value="разовий" selected>⚪ Разовий, без повернення<\/option>/);
});

// ----- Браузерні перевірки (мок-дані ?preview=1). Без playwright-core або Chrome тести пропускаються. -----
async function loadBrowser() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
    for (const executablePath of candidates) {
        try { return await pw.chromium.launch({ executablePath, headless: true }); } catch { /* наступний */ }
    }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}

async function withPage(t, widths, fn) {
    const browser = await loadBrowser();
    if (!browser) { t.skip('no playwright-core / Chrome'); return; }
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://localhost:' + server.address().port + '/index.html?preview=1';
    try {
        for (const width of widths) {
            for (const theme of ['light', 'dark']) {
                const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 } });
                await page.goto(url + '&theme=' + theme, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('#tc-kpi-bar', { timeout: 15000 });
                await fn(page, width, theme);
                await page.close();
            }
        }
    } finally {
        await browser.close();
        server.close();
    }
}

const WIDTHS = [1920, 1440, 1280, 1024, 390];

test('browser: no horizontal scroll, uncut fields, no errors on load, no taxes block (1920 … 390)', async (t) => {
    await withPage(t, WIDTHS, async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, 'horizontal scroll ' + overflow + at);
        const clipped = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('#tc-op .tc-in > input:not([type="hidden"]), #tc-op .tc-in > select').forEach((el) => {
                if (el.offsetParent === null) return;
                if (el.scrollWidth > el.clientWidth + 1) out.push(el.id + ':scroll');
                if (el.tagName === 'SELECT') {
                    const ctx = document.createElement('canvas').getContext('2d');
                    const cs = getComputedStyle(el);
                    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
                    const need = Math.max(...[...el.options].map((o) => ctx.measureText(o.text).width));
                    if (need > el.clientWidth - 28) out.push(el.id + ':text ' + Math.ceil(need) + '>' + (el.clientWidth - 28));
                }
                if (el.type === 'number' && el.offsetWidth < 70) out.push(el.id + ':narrow ' + el.offsetWidth);
            });
            return out;
        });
        assert.deepEqual(clipped, [], 'clipped fields' + at);
        const heights = await page.evaluate(() => [...new Set([...document.querySelectorAll('#tc-step-panel-1 .tc-in')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)))]);
        assert.ok(heights.length <= 1, 'unequal field heights ' + heights.join(',') + at);
        const units = await page.evaluate(() => [...document.querySelectorAll('#tc-op .tc-in > .unit')].filter((u) => u.offsetParent).filter((u) => {
            const box = u.parentElement.getBoundingClientRect();
            const r = u.getBoundingClientRect();
            return r.right > box.right + 1 || r.bottom > box.bottom + 1;
        }).map((u) => u.textContent));
        assert.deepEqual(units, [], 'units outside the field' + at);
        const errors = await page.evaluate(() => ({
            invalid: document.querySelectorAll('#tc-op .invalid, #tc-op .tc-invalid, #tc-op [aria-invalid="true"], #tc-op .miss').length,
            banner: ['missing-hint', 'onboard-banner', 'cab-warning'].some((id) => { const el = document.getElementById(id); return el && el.offsetParent !== null && /Підсвічено/.test(el.textContent); }),
        }));
        assert.equal(errors.invalid, 0, 'invalid fields on load' + at);
        assert.equal(errors.banner, false, 'missing banner on load' + at);
        assert.equal(await page.evaluate(() => /Податки і накладні/.test(document.getElementById('tc-op').textContent)), false, 'taxes block' + at);
        assert.equal(await page.evaluate(() => !!document.getElementById('tc-step-strip')), false);
    });
});

test('browser: strip sticks at top 0 below the header, map and panel do not intersect (1920 … 390)', async (t) => {
    await withPage(t, WIDTHS, async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        await page.evaluate(() => window.scrollTo(0, 600));
        const g = await page.evaluate(() => {
            const bar = document.getElementById('tc-kpi-bar').getBoundingClientRect();
            const head = document.getElementById('sticky-top').getBoundingClientRect();
            const panel = document.getElementById('tc-op').getBoundingClientRect();
            const map = document.querySelector('.tc-map-frame').getBoundingClientRect();
            return {
                top: bar.top, overlapHeader: head.bottom > 0 && bar.top < head.bottom - 1, w: bar.width,
                mapPanel: !(map.right <= panel.left + 1 || panel.right <= map.left + 1 || map.bottom <= panel.top + 1 || panel.bottom <= map.top + 1),
            };
        });
        assert.ok(g.top >= 0 && g.top <= 1, 'strip top ' + g.top + at);
        assert.equal(g.overlapHeader, false, 'strip overlaps header' + at);
        assert.equal(g.mapPanel, false, 'map intersects panel' + at);
        if (width >= 1920) assert.ok(g.w <= 1840 + 1, 'strip wider than 1840' + at);
        if (width > 900) {
            const two = await page.evaluate(() => {
                const panel = document.getElementById('tc-op').getBoundingClientRect();
                const map = document.querySelector('.tc-map-frame').getBoundingClientRect();
                return { panelW: panel.width, mapW: map.width };
            });
            assert.ok(two.panelW >= 380 && two.mapW > two.panelW * 0.9, 'columns ' + JSON.stringify(two) + at);
        } else {
            const mapH = await page.evaluate(() => Math.round(document.querySelector('.tc-map-frame').getBoundingClientRect().height));
            assert.ok(mapH >= 240 && mapH <= 280, 'mobile map height ' + mapH + at);
        }
    });
});

test('browser: «Детально» layout and back button (1280 / 1024 / 390)', async (t) => {
    await withPage(t, [1280, 1024, 390], async (page, width) => {
        await page.click('#kb-detail');
        const boxes = await page.evaluate(() => {
            const a = document.querySelector('.tc-map-frame').getBoundingClientRect();
            const b = document.getElementById('tc-det-side').getBoundingClientRect();
            return { a: [a.left, a.top, a.right, a.bottom], b: [b.left, b.top, b.right, b.bottom] };
        });
        const [a, b] = [boxes.a, boxes.b];
        assert.ok(a[2] <= b[0] + 1 || b[2] <= a[0] + 1 || a[3] <= b[1] + 1 || b[3] <= a[1] + 1, 'map and side overlap at ' + width);
        await page.click('#tc-det-back');
        assert.equal(await page.evaluate(() => document.body.getAttribute('data-calc-detail')), '0');
        assert.equal(await page.evaluate(() => document.getElementById('tc-op').offsetParent !== null), true);
    });
});

test('fix pass: currency width, A/B inside .tc-in, no empty cells, label for «Фура», clear button, onboarding, km, dark button', () => {
    assert.ok(html.includes('.tc-in > select.cur { min-width: 84px; }'));
    assert.match(build, /box\.className = 'tc-in is-addr'/);
    assert.match(build, /mark\.textContent = pair\[1\]/);
    assert.ok(html.includes('.tc-in.is-addr { overflow: visible; position: relative; }'));
    assert.match(onepage, /function opSweepCells\(\)/);
    assert.match(onepage, /cell\.hidden = !live/);
    assert.match(onepage, /new MutationObserver\(opSweepCells\)/);
    assert.ok(html.includes('.tc-f[hidden] { display: none !important; }'));
    assert.match(build, /truckLab\.textContent = 'Фура'/);
    assert.match(build, /id=\"tc-clear\" onclick=\"clearCalcForm\(\)\">Очистити/);
    const clear = sliceBetween(onepage, 'function clearCalcForm()', 'function opToggleRecent()');
    assert.match(clear, /clearVehicleNormChoice\(\)/);
    assert.match(clear, /calculate\(\)/);
    assert.equal(clear.includes('fetch('), false);
    assert.match(build, /\[head, onboard, acc\]/);
    const paint = sliceBetween(html, 'function renderMergedRecent()', 'function renderRecentRoutes()');
    assert.match(paint, /tc-rr-km/);
    assert.match(paint, /chip\.km > 0/);
    assert.ok(html.includes('.tc-kpi-bar .btn.tc-kb-detail,'));
    assert.match(onepage, /const slack = Math\.max\(0, document\.documentElement\.scrollHeight/);
});

test('browser: A/B height equals other fields, no empty cells, map inside the window, currency uncut (1920 / 1440)', async (t) => {
    await withPage(t, [1920, 1440], async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        const heights = await page.evaluate(() => {
            const h = (el) => Math.round(el.getBoundingClientRect().height);
            const visible = [...document.querySelectorAll('#tc-step-panel-1 .tc-in')].filter((e) => e.offsetParent);
            const ab = visible.filter((e) => e.classList.contains('is-addr')).map(h);
            const rest = visible.filter((e) => !e.classList.contains('is-addr')).map(h);
            return { ab, rest };
        });
        assert.ok(heights.ab.length >= 2, 'A/B fields found' + at);
        for (const v of heights.ab) assert.ok(Math.abs(v - heights.rest[0]) <= 1, 'A/B height ' + v + ' vs ' + heights.rest[0] + at);
        const empty = await page.evaluate(() => [...document.querySelectorAll('#tc-op .tc-f')].filter((c) => c.offsetParent && !c.classList.contains('tc-f-truck') && c.getBoundingClientRect().height > 0 && !c.querySelector('input:not([type="hidden"]), select, .tc-ac, [id$="-wrap"]')).map((c) => c.className));
        assert.deepEqual(empty, [], 'empty cells' + at);
        const map = await page.evaluate(() => { const r = document.querySelector('.tc-map-frame').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.innerHeight }; });
        assert.ok(map.bottom <= map.vh + 1, 'map bottom ' + map.bottom + ' > ' + map.vh + at);
        const cur = await page.evaluate(() => { const el = document.getElementById('contract-currency'); return el.clientWidth; });
        assert.ok(cur >= 76, 'currency width ' + cur + at);
    });
});

test('browser: sticky map after scroll 600 sits under the strip inside the window; «Детально →» is dark (1920 / 1440 / 1280)', async (t) => {
    await withPage(t, [1920, 1440, 1280], async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(150);
        const g = await page.evaluate(() => {
            const map = document.querySelector('.tc-map-frame').getBoundingClientRect();
            const bar = document.getElementById('tc-kpi-bar').getBoundingClientRect();
            const btn = getComputedStyle(document.getElementById('kb-detail'));
            const parse = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
            const lum = (c) => { const [r, g2, b] = parse(c); return 0.299 * r + 0.587 * g2 + 0.114 * b; };
            return { top: map.top, bottom: map.bottom, barBottom: bar.bottom, vh: window.innerHeight, btnBg: lum(btn.backgroundColor), btnFg: lum(btn.color), bgRaw: btn.backgroundColor };
        });
        assert.ok(g.top >= g.barBottom - 2 && g.top <= g.barBottom + 28, 'map top ' + g.top + ' vs strip bottom ' + g.barBottom + at);
        assert.ok(g.bottom <= g.vh + 1, 'map bottom ' + g.bottom + ' > ' + g.vh + at);
        assert.ok(Math.abs(g.btnBg - g.btnFg) > 100, 'button contrast ' + g.bgRaw + at);
        if (theme === 'light') assert.ok(g.btnBg < 90, 'button is not dark: ' + g.bgRaw + at);
    });
});

test('polish: one address mode, dynamic trailer fields, KPI strip alignment, AdBlue switch with 2.85, uncut extras', () => {
    // 1. Демо — лише OSM-пара, повний доступ — лише Google-пара; ID-селектор .form-row більше не перебиває .demo-only.
    assert.ok(css.includes('#tc-op .demo-only { display: none; }'));
    assert.ok(css.includes('body.demo-mode #tc-op .demo-only { display: grid; }'));
    assert.ok(css.includes('body.demo-mode #tc-op .full-only { display: none !important; }'));
    assert.match(build, /\[fromFull, toFull\]\.forEach\(function \(row\) \{ if \(row\) row\.classList\.add\('full-only'\); \}\)/);
    assert.match(build, /\[fromDemo, toDemo\]\.forEach\(function \(row\) \{ if \(row\) row\.classList\.add\('demo-only'\); \}\)/);
    assert.equal((html.match(/id="podacha-dist"/g) || []).length, 1);
    assert.equal((html.match(/id="osm-demo-from"/g) || []).length, 1);
    assert.equal((html.match(/id="osm-from-wrap"/g) || []).length, 1);
    // 2. Смуга: відступи по вертикалі більші за вихід підпису, рядки по центру.
    assert.ok(css.includes('.tc-kpi-bar { padding-block: 20px; align-items: center; }'));
    assert.ok(css.includes('.tc-kpi-bar::before { inset: 10px var(--tc-pad); }'));
    // 3. Поля реф/промивка видно лише для свого типу причепа.
    assert.ok(css.includes('#tc-op .form-row.dynamic-field:not(.active) { display: none; }'));
    const sync = sliceBetween(html, 'function syncTrailerExtras()', 'function onTrailerChange()');
    assert.match(sync, /trailer === 'рефрижератор'/);
    assert.match(sync, /trailer === 'цистерна'/);
    // 4. AdBlue: перемикач + поле витрати 2.85 (value), заголовок із л/100км.
    assert.match(html, /<input type="number" id="adblue-consumption" step="0\.05" value="2\.85"/);
    assert.match(build, /sw\.setAttribute\('role', 'switch'\)/);
    assert.match(build, /adblueSel\.value = adblueSel\.value === 'on' \? 'off' : 'on';\n\s+onAdblueToggle\(\);/);
    assert.match(onepage, /adRateRow\.hidden = !adOn/);
    assert.match(html, /<option value="on" selected>Увімкнено<\/option>\s*<option value="off">Вимкнено<\/option>/);
    // 5. Підписи в «Додаткових параметрах» переносяться, select не ріже значення.
    assert.ok(css.includes('#tc-op .tc-op-sub .form-row > label { white-space: normal;'));
    assert.ok(css.includes('#tc-op .tc-op-sub .form-row:has(#calc-type) { grid-column: 1 / -1; }'));
});

test('browser: one A/B pair and one «Подача» in each mode; KPI labels inside the strip; trailer fields; AdBlue; uncut extras', async (t) => {
    await withPage(t, [1440, 1024], async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        // Режими: preview = демо (body.demo-mode); повний доступ — те саме без класу.
        for (const demo of [true, false]) {
            await page.evaluate((on) => document.body.classList.toggle('demo-mode', on), demo);
            await page.waitForTimeout(80);
            const seen = await page.evaluate(() => {
                const vis = (sel) => [...document.querySelectorAll('#tc-op ' + sel)].filter((e) => e.offsetParent !== null).length;
                return { from: vis('#osm-from-wrap, #osm-demo-from'), to: vis('#osm-to-wrap, #osm-demo-to'), base: vis('#osm-base-wrap, #osm-demo-base'), podacha: vis('#podacha-dist') };
            });
            assert.equal(seen.from, 1, 'A pair (demo=' + demo + ')' + at);
            assert.equal(seen.to, 1, 'B pair (demo=' + demo + ')' + at);
            assert.ok(seen.base <= 1, 'base (demo=' + demo + ')' + at);
            assert.equal(seen.podacha, 1, 'podacha (demo=' + demo + ')' + at);
        }
        const labels = await page.evaluate(() => {
            const bar = document.getElementById('tc-kpi-bar').getBoundingClientRect();
            return [...document.querySelectorAll('#tc-kpi-bar .tc-kb-m, #tc-kpi-bar .tc-kb-detail')].map((el) => {
                const r = el.getBoundingClientRect();
                return r.top >= bar.top + 8 && r.bottom <= bar.bottom - 8;
            });
        });
        assert.ok(labels.every(Boolean), 'KPI cells outside the strip' + at);
        await page.evaluate(() => document.getElementById('tc-acc-extras').querySelector('.tc-acc-head').click());
        for (const [type, ref, wash] of [['зерновоз', false, false], ['рефрижератор', true, false], ['тент', false, false], ['цистерна', false, true]]) {
            await page.evaluate((v) => { const el = document.getElementById('trailer-type'); el.value = v; syncTrailerExtras(); }, type);
            const vis = await page.evaluate(() => ['field-ref-consumption', 'field-ref-hours', 'field-wash-cost', 'field-wash-freq'].map((id) => document.getElementById(id).offsetParent !== null));
            assert.deepEqual(vis, [ref, ref, wash, wash], 'trailer ' + type + at);
        }
        const ad = await page.evaluate(() => {
            document.querySelector('#tc-acc-fuel .tc-acc-head').click();
            const rate = document.getElementById('adblue-consumption');
            const sw = document.getElementById('tc-adblue-switch');
            const on = { value: rate.value, shown: document.getElementById('tc-adblue-rate-row').offsetParent !== null, checked: sw.getAttribute('aria-checked') };
            sw.click();
            const off = { shown: document.getElementById('tc-adblue-rate-row').offsetParent !== null, sel: document.getElementById('adblue-enable').value };
            document.querySelector('#tc-acc-fuel .tc-acc-head').click();
            return { on, off, sum: document.getElementById('tc-acc-sum-fuel').textContent };
        });
        assert.equal(ad.on.value, '2.85');
        assert.equal(ad.on.shown, true);
        assert.equal(ad.on.checked, 'true');
        assert.equal(ad.off.shown, false);
        assert.equal(ad.off.sel, 'off');
        assert.match(ad.sum, /без AdBlue/);
        const clipped = await page.evaluate(() => [...document.querySelectorAll('#tc-acc-extras .tc-op-sub label, #tc-acc-extras .tc-in > select')]
            .filter((e) => e.offsetParent !== null && e.scrollWidth > e.clientWidth + 1).map((e) => e.id || e.textContent.slice(0, 20)));
        assert.deepEqual(clipped, [], 'clipped extras' + at);
    });
});

// ----- jsdom (якщо встановлено; інакше пропускається): справжнє завантаження сторінки без Chrome -----
async function bootDom() {
    let JSDOM;
    try { ({ JSDOM } = await import('jsdom')); } catch {
        try {
            const { createRequire } = await import('node:module');
            ({ JSDOM } = createRequire(process.env.JSDOM_PATH || import.meta.url)('jsdom'));
        } catch { return null; }
    }
    const dom = new JSDOM(html, {
        url: 'http://localhost/index.html?preview=1',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
            const deep = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : deep()), apply: () => deep() });
            w.supabase = { createClient: () => deep() };
            w.ResizeObserver = class { observe() {} };
            w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
            w.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return dom;
}

test('jsdom: #dist and #podacha-dist are in the panel once, trailer type updates fields without and with a session', async (t) => {
    const dom = await bootDom();
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const w = dom.window;
        const d = w.document;
        for (const id of ['dist', 'podacha-dist', 'volume', 'rate', 'return-mode']) {
            const matches = d.querySelectorAll('#' + id);
            assert.equal(matches.length, 1, id);
            assert.ok(matches[0].closest('#tc-op .tc-f'), id + ' sits in a grid cell');
        }
        const unit = d.getElementById('podacha-dist').parentElement.querySelector('.unit');
        assert.equal(unit && unit.textContent, 'км');
        assert.ok(d.getElementById('podacha-dist').closest('.tc-f-podacha'));
        assert.ok(d.getElementById('dist').closest('.tc-f-dist'));
        const trailer = d.getElementById('trailer-type');
        const ids = ['field-ref-consumption', 'field-ref-hours', 'field-wash-cost', 'field-wash-freq'];
        const run = (label) => {
            for (const [type, ref, wash] of [['зерновоз', false, false], ['рефрижератор', true, false], ['тент', false, false], ['цистерна', false, true]]) {
                trailer.value = type;
                w.onTrailerChange();
                assert.deepEqual(ids.map((id) => d.getElementById(id).classList.contains('active')), [ref, ref, wash, wash], label + ' ' + type);
            }
        };
        run('no session');
        w.eval('currentSessionToken = "fake-token"');
        run('with session');
    } finally {
        dom.window.close();
    }
});

test('jsdom: extras grid has no empty info slot; trip-volume-info collapses when empty', async (t) => {
    const dom = await bootDom();
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const d = dom.window.document;
        const info = d.getElementById('trip-volume-info');
        assert.ok(info && info.closest('.tc-op-sub'));
        assert.equal(info.textContent.trim(), '');
        assert.ok(css.includes('#tc-op #trip-volume-info:empty, #tc-op #contract-fx-note:empty { display: none; }') || html.includes('#tc-op #trip-volume-info:empty, #tc-op #contract-fx-note:empty { display: none; }'));
    } finally {
        dom.window.close();
    }
});

test('static: onTrailerChange syncs fields before the session guard; rows are captured before panel1 is cleared', () => {
    const fn = sliceBetween(html, 'function onTrailerChange()', 'let vehicleNormBaseline');
    assert.equal(fn.includes('currentSessionToken'), false, 'no early exit before the fields sync');
    assert.match(fn, /syncTrailerExtras\(\);\s+calculate\(\);/);
    assert.match(sliceBetween(html, 'async function calculate()', 'Обов'), /if \(!currentSessionToken\) return;/);
    assert.ok(build.indexOf('const distRow = opRowOf') < build.indexOf("panel1.textContent = ''"));
    assert.ok(build.indexOf('const podachaRow = opRowOf') < build.indexOf("panel1.textContent = ''"));
    assert.match(build, /opCell\('tc-f-podacha', 'Подача авто', \[podachaRow, podachaInfo\]\)/);
});

test('browser: #podacha-dist visible exactly once with its km unit in every mode; no zero-height grid items in extras (1920 / 1440 / 1280 / 1024 / 390)', async (t) => {
    await withPage(t, WIDTHS, async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        for (const demo of [true, false]) {
            await page.evaluate((on) => document.body.classList.toggle('demo-mode', on), demo);
            await page.waitForTimeout(60);
            const seen = await page.evaluate(() => {
                const all = [...document.querySelectorAll('#podacha-dist')].filter((e) => e.offsetParent !== null);
                const unit = all[0] && all[0].parentElement.querySelector('.unit');
                const base = [...document.querySelectorAll('#osm-base-wrap, #osm-demo-base')].filter((e) => e.offsetParent !== null).length;
                return { km: all.length, unit: unit ? unit.textContent : null, base };
            });
            assert.equal(seen.km, 1, 'podacha-dist visible (demo=' + demo + ')' + at);
            assert.equal(seen.unit, 'км');
            assert.ok(seen.base <= 1, 'parking address field (demo=' + demo + ')' + at);
        }
        await page.evaluate(() => document.querySelector('#tc-acc-extras .tc-acc-head').click());
        const flat = await page.evaluate(() => [...document.querySelectorAll('#tc-acc-extras .tc-op-sub > *')].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height === 0).map((e) => e.id || e.className));
        assert.deepEqual(flat, [], 'zero-height items in extras' + at);
        for (const type of ['зерновоз', 'рефрижератор', 'тент', 'цистерна']) {
            await page.selectOption('#trailer-type', type);
            const vis = await page.evaluate(() => ['field-ref-consumption', 'field-ref-hours', 'field-wash-cost', 'field-wash-freq'].map((id) => document.getElementById(id).offsetParent !== null));
            const ref = type === 'рефрижератор';
            const wash = type === 'цистерна';
            assert.deepEqual(vis, [ref, ref, wash, wash], 'trailer ' + type + at);
        }
    });
});
