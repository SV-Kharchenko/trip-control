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

test('the stepper UI is gone: strip, head and Back/Next are removed, panels stay visible', () => {
    const build = sliceBetween(onepage, 'function buildOnePage()', 'function opFuelMissing()');
    assert.match(build, /opById\('tc-step-strip'\)/);
    assert.match(build, /strip\.remove\(\)/);
    assert.match(build, /\.tc-step-head, #tc-step-nav'\)\.forEach\(function \(el\) \{ el\.remove\(\); \}\)/);
    assert.match(build, /el\.hidden = false/);
    assert.match(html, /const on = CALC_ONEPAGE \|\| i === calcStep;/);
    // Старий лендінговий степер не чіпали.
    assert.match(html, /lp-t-tab/);
    // Режиму «Майстер» немає.
    assert.equal(/wizard|майстер/i.test(onepage), false);
});

test('KPI bar: sticky, profit / грн/км / break-even / margin, details button, red hint without fuel', () => {
    const build = sliceBetween(onepage, 'function buildOnePage()', 'function opFuelMissing()');
    assert.match(build, /bar\.id = 'tc-kpi-bar'/);
    for (const id of ['kb-profit', 'kb-km', 'kb-be', 'kb-margin', 'kb-detail']) assert.ok(build.includes('id="' + id + '"'), id);
    assert.match(build, /Чистий прибуток/);
    assert.match(build, /грн\/км/);
    assert.match(build, /Беззбитковість, грн\/т/);
    assert.match(build, /Маржа/);
    assert.match(build, /Детально →/);
    const paint = sliceBetween(onepage, 'function paintKpiBar(', '// «Детально»');
    assert.match(paint, /Чистий прибуток · вкажіть витрату пального/);
    assert.match(paint, /is-down/);
    assert.match(paint, /breakevenFullPerTon/);
    assert.match(html, /\.tc-kpi-bar \{\n\s+position: sticky; top: calc\(var\(--tc-sticky-h, 0px\) \+ 6px\); z-index: 30;/);
    // Нижче меню (#sticky-top, z-index 40).
    assert.match(html, /#sticky-top \{ position: sticky; top: 0; z-index: 40;/);
    assert.match(html, /\.tc-kpi-bar > \.tc-kb-detail \{ display: none; \}/);
    assert.match(html, /\.tc-kb-main \{ grid-column: 1 \/ -1; \}/);
});

test('8 fields in the agreed order, fed by the existing nodes', () => {
    const build = sliceBetween(onepage, 'function buildOnePage()', 'function opFuelMissing()');
    const labels = [...build.matchAll(/opCell\('tc-op-[a-z]+', '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['Звідки (A)', 'Куди (B)', 'Відстань (км)', 'Подача авто (км)', 'Вага вантажу (т)', 'Тариф', 'Повернення', 'Фура']);
    for (const id of ['dist', 'podacha-dist', 'volume', 'rate', 'contract-currency', 'return-mode']) assert.ok(build.includes("opRowOf('" + id + "')"), id);
    assert.match(build, /opById\('vehicle-norm-row'\)/);
    assert.match(build, /opById\('osm-from-wrap'\)|rowIn\('osm-from-wrap'\)/);
    // Решта кроку 2 не зникла.
    for (const id of ['trailer-type', 'norm-weight', 'cars-count', 'days-per-trip']) assert.ok(build.includes("opRowOf('" + id + "')"), id);
    assert.match(html, /\.tc-op-grid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    assert.match(html, /\.tc-op-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    // Усі id полів формули лишились в одному екземплярі.
    for (const id of ['dist', 'volume', 'rate', 'podacha-dist', 'return-mode', 'contract-currency', 'fuel-load', 'fuel-empty', 'fuel-price', 'calc-type']) {
        assert.equal((html.match(new RegExp('<(?:input|select)[^>]* id="' + id + '"', 'g')) || []).length, 1, id);
    }
});

test('accordion: fuel, extras and taxes rows with summaries and amounts', () => {
    const build = sliceBetween(onepage, 'function buildOnePage()', 'function opFuelMissing()');
    assert.match(build, /opAccRow\('fuel', '⛽', 'Пальне', fuelPanel\)/);
    assert.match(build, /opAccRow\('extras', '➕', 'Додатково', extrasPanel\)/);
    assert.match(build, /opAccRow\('tax', '🧾', 'Податки і накладні', taxBody\)/);
    const row = sliceBetween(onepage, 'function opAccRow(', 'function setAccOpen(');
    for (const id of ['tc-acc-sum-', 'tc-acc-amt-', 'tc-acc-chev']) assert.ok(row.includes(id), id);
    assert.match(row, /aria-expanded/);
    const upd = sliceBetween(onepage, 'function updateOnePage(', 'function paintKpiBar(');
    assert.match(upd, /result\.fuelAndAdblueTotal/);
    assert.match(upd, /result\.extrasTotal/);
    assert.match(upd, /result\.taxesTotal/);
    assert.match(upd, /нічого не додано/);
    assert.match(upd, /AdBlue/);
    assert.match(upd, /'Немає витрати пального для '/);
    assert.match(build, /Вкажіть витрату — без неї пальне не рахується/);
    assert.match(build, /Або заповніть у картці авто/);
    assert.match(upd, /показано|badge\.textContent = fuelOff \? 'немає в картці' : 'з автопарку'/);
    assert.match(html, /\.tc-op input\.miss, \.tc-op select\.miss, \.tc-op \[aria-invalid="true"\]/);
    assert.match(html, /\.tc-acc-row\.is-miss \{ background: linear-gradient\(180deg, color-mix\(in srgb, var\(--negative\)/);
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
    // Авто без норми й порожні поля компанії → бракує.
    assert.deepEqual(make({ 'fuel-load': '', 'fuel-empty': '' }, [{ label: 'AA1' }], true)(), ['AA1']);
    // Норма в картці авто → усе гаразд.
    assert.deepEqual(make({ 'fuel-load': '', 'fuel-empty': '' }, [{ label: 'AA1', fuel_load: 30, fuel_empty: 25 }], true)(), []);
    // Норма компанії покриває авто без власної.
    assert.deepEqual(make({ 'fuel-load': '32', 'fuel-empty': '27' }, [{ label: 'AA1' }], true)(), []);
    // Без вибору авто підказка не показується (порожні поля ловить REQUIRED_FIELDS).
    assert.deepEqual(make({ 'fuel-load': '', 'fuel-empty': '' }, [], false)(), []);
    const upd = sliceBetween(onepage, 'function updateOnePage(', 'function paintKpiBar(');
    assert.match(upd, /if \(fuelOff && !opFuelWasMissing\) setAccOpen\('fuel', true\)/);
    assert.match(upd, /el\.classList\.toggle\('miss', fuelOff && !\(parseFloat\(el\.value\) > 0\)\)/);
    // Невалідне поле розгортає свій рядок.
    const invalid = sliceBetween(html, 'function markInvalidFields(missing)', 'function revealInvalidStep()');
    assert.match(invalid, /openAccFor\(input\)/);
    const reveal = sliceBetween(html, 'function revealInvalidStep()', 'function missingHintHtml(');
    assert.match(reveal, /openAccFor\(bad\)/);
    assert.match(sliceBetween(html, 'function showCalcStep(n, focusTab)', 'function stepFieldText(id)'), /if \(next === 3\) setAccOpen\('fuel', true\)/);
});

test('«Детально» and «← До розрахунку» switch body[data-calc-detail]', () => {
    const fn = sliceBetween(onepage, 'function setCalcDetail(on)', '// Мапа живе');
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
    assert.deepEqual(attrs.dock, ['is-open', true]);
    run(false);
    assert.equal(attrs['data-calc-detail'], '0');
    assert.equal(placed, 2);
    assert.match(onepage, /back\.textContent = '← До розрахунку'/);
    assert.match(onepage, /onclick="setCalcDetail\(true\)">Детально →<\/button>'/);
    // Та сама мапа переноситься, друга копія не створюється.
    const place = sliceBetween(onepage, 'function opPlace()', 'function opSyncStickyTop()');
    assert.match(place, /querySelector\('\.tc-map-frame'\)/);
    assert.match(place, /trigger\(map, 'resize'\)/);
    assert.equal((html.match(/id="map"/g) || []).length, 1);
    // Детально: мапа 440 / 320, два ряди, каскад і таблиця статей.
    assert.match(html, /grid-template-columns: minmax\(0, 1\.7fr\) minmax\(0, 1fr\);/);
    assert.match(html, /\.tc-map-frame \{ grid-column: 1; grid-row: 2; height: 440px !important;/);
    assert.match(html, /\.tc-map-frame\s*,\s*[^{]*#map,[^{]*\{ height: 320px !important; \}|height: 320px !important;/);
    assert.match(html, /#tc-op \{ display: none; \}/);
});

test('Save / PDF / Excel keep calling the same functions', () => {
    const actions = sliceBetween(html, 'id="tc-result-actions"', '</div>');
    assert.match(actions, /saveCalculation\(\)/);
    assert.match(actions, /window\.print\(\)/);
    assert.match(actions, /exportExcel\(\)/);
    assert.match(onepage, /side\.appendChild\(actions\)/);
    // Дії переїжджають вузлом, а не копіюються.
    assert.equal((html.match(/id="tc-result-actions"/g) || []).length, 1);
});

test('formulas, calculate() and the API are untouched by the layout', () => {
    const calc = sliceBetween(html, 'async function calculate()', 'function clearCalcVisuals()');
    assert.equal(calc.includes('buildOnePage'), false);
    assert.equal(calc.includes('setCalcDetail'), false);
    assert.equal(onepage.includes('supabaseClient'), false);
    assert.equal(onepage.includes('fetch('), false);
    // Лише токени тем сайту: жодного нового hex у блоці однієї сторінки.
    const css = sliceBetween(html, '/* ===== Калькулятор на одній сторінці', '</style>');
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/rgba?\([^)]*\)/g, '')), false);
    assert.match(css, /var\(--positive\)/);
    assert.match(css, /var\(--negative\)/);
    assert.match(css, /var\(--font-mono\)/);
});

test('sticky offset follows #sticky-top through a ResizeObserver', () => {
    const fn = sliceBetween(onepage, 'function opSyncStickyTop()', '\n    }\n') + '}';
    assert.match(fn, /--tc-sticky-h/);
    assert.match(fn, /new ResizeObserver\(opSyncStickyTop\)\.observe\(sticky\)/);
    assert.match(html, /buildOnePage\(\);\n\s+opSyncStickyTop\(\);/);
});

// ----- Браузерна перевірка (мок-дані ?preview=1). Без playwright-core або Chrome тест пропускається. -----
async function loadBrowser() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
    for (const executablePath of candidates) {
        try { return await pw.chromium.launch({ executablePath, headless: true }); } catch { /* наступний */ }
    }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}

test('browser: no horizontal scroll, KPI bar below the header, fuel row opens (1280 / 1024 / 390)', async (t) => {
    const browser = await loadBrowser();
    if (!browser) { t.skip('no playwright-core / Chrome'); return; }
    const server = createServer((req, res) => {
        if (req.url.split('?')[0] === '/' || req.url.startsWith('/index.html')) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
        } else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://localhost:' + server.address().port + '/index.html?preview=1';
    try {
        for (const [width, height] of [[1280, 900], [1024, 800], [390, 844]]) {
            for (const theme of ['dark', 'light']) {
                const page = await browser.newPage({ viewport: { width, height } });
                await page.goto(url + '&theme=' + theme, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('#tc-kpi-bar', { timeout: 15000 });
                const stepper = await page.evaluate(() => !!document.getElementById('tc-step-strip'));
                assert.equal(stepper, false, 'no step strip at ' + width);
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                assert.ok(overflow <= 0, 'horizontal scroll ' + overflow + 'px at ' + width + ' ' + theme);
                await page.evaluate(() => window.scrollTo(0, 400));
                const overlap = await page.evaluate(() => {
                    const bar = document.getElementById('tc-kpi-bar').getBoundingClientRect();
                    const head = document.getElementById('sticky-top').getBoundingClientRect();
                    return head.bottom > 0 && bar.top < head.bottom - 1;
                });
                assert.equal(overlap, false, 'KPI bar overlaps the header at ' + width);
                await page.close();
            }
        }
    } finally {
        await browser.close();
        server.close();
    }
});

test('layout fix: default view, single column, visible overflow, sticky only when the header is sticky', () => {
    const build = sliceBetween(onepage, 'function buildOnePage()', 'function focusMissingField(');
    assert.match(build, /setAttribute\('data-studio-view', 'calc'\)/);
    assert.match(build, /setStudioView\(document\.body\.getAttribute\('data-studio-view'\)\)/);
    assert.match(html, /\[data-studio-view="calc"\]:not\(\[data-calc-detail="1"\]\) #studio-columns \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(html, /#tc-op \{ max-width: 1100px; margin-inline: auto;/);
    assert.match(html, /\.tc-work > \.card \{[^}]*overflow: visible; \}/);
    assert.match(onepage, /getComputedStyle\(sticky\)\.position === 'sticky'/);
    assert.match(html, /#studio-right > #tc-det-side \{ grid-column: 2 !important; grid-row: 2 !important; \}/);
    assert.match(html, /#tc-det-back \{ display: inline-flex; grid-column: 1 \/ -1 !important; grid-row: 1 !important; justify-self: start;/);
    // Посилання «не заповнено» веде до поля, а не лише до кроку.
    const hint = sliceBetween(html, 'function missingHintHtml(missing)', 'function showToast(');
    assert.match(hint, /data-field=/);
    assert.match(onepage, /function focusMissingField\(id\)/);
    // Підсумок пального: літри й % AdBlue; червоний лейбл лише при вибраному авто; preview заповнює смугу.
    const upd = sliceBetween(onepage, 'function updateOnePage(', 'function paintKpiBar(');
    assert.match(upd, /' л'/);
    assert.match(upd, /'AdBlue ' \+ opNum\(rate \/ loadRaw \* 100\) \+ '%'/);
    assert.match(upd, /paintKpiBar\(result, fuelOff, !\(loadRaw > 0 && emptyRaw > 0\)\)/);
    assert.match(html, /routeName: 'preview', result: \{ grossIncome: 184250/);
});

test('browser: wide form, uncut fields, sticky bar, «Детально» layout and back button (1280 / 1024)', async (t) => {
    const browser = await loadBrowser();
    if (!browser) { t.skip('no playwright-core / Chrome'); return; }
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://localhost:' + server.address().port + '/index.html?preview=1';
    try {
        for (const width of [1280, 1024]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#tc-kpi-bar', { timeout: 15000 });
            const wide = await page.evaluate(() => document.getElementById('tc-op').getBoundingClientRect().width);
            assert.ok(wide > 900, '#tc-op width ' + wide + ' at ' + width);
            const cut = await page.evaluate(() => [...document.querySelectorAll('#tc-op-grid input:not([type="hidden"]), #tc-op-grid select')]
                .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0 && el.scrollWidth > el.clientWidth + 1 && el.tagName === 'INPUT' && el.type !== 'number')
                .map((el) => el.id));
            assert.deepEqual(cut, [], 'cut fields at ' + width);
            await page.evaluate(() => window.scrollTo(0, 600));
            const geometry = await page.evaluate(() => {
                const bar = document.getElementById('tc-kpi-bar').getBoundingClientRect();
                const head = document.getElementById('sticky-top').getBoundingClientRect();
                return { top: bar.top, overlap: head.bottom > 0 && bar.top < head.bottom - 1 };
            });
            assert.ok(geometry.top >= 0, 'bar top ' + geometry.top);
            assert.equal(geometry.overlap, false);
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
            await page.close();
        }
    } finally {
        await browser.close();
        server.close();
    }
});

test('selects and numbers keep room for their text', () => {
    assert.ok(html.includes('.tc-op-return { grid-column: span 2; }'));
    assert.ok(html.includes('.tc-op-cell select#contract-currency { width: 100%; min-width: 130px; }'));
    assert.ok(html.includes('.tc-op-cell input[type="number"] { min-width: 92px; }'));
});

test('browser: no clipped selects or numbers (1280 / 1024 / 390)', async (t) => {
    const browser = await loadBrowser();
    if (!browser) { t.skip('no playwright-core / Chrome'); return; }
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://localhost:' + server.address().port + '/index.html?preview=1';
    try {
        for (const width of [1280, 1024, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#tc-kpi-bar', { timeout: 15000 });
            const clipped = await page.evaluate(() => ['contract-currency', 'return-mode', 'dist', 'podacha-dist', 'volume', 'rate']
                .map((id) => document.getElementById(id))
                .filter((el) => el && (el.scrollWidth > el.clientWidth + 1 || (el.type === 'number' && el.offsetWidth < 92)))
                .map((el) => el.id + ':' + el.clientWidth + '/' + el.scrollWidth));
            assert.deepEqual(clipped, [], 'clipped at ' + width);
            // Текст найдовшої опції проти ширини селекта (мінус стрілка й відступи).
            const narrow = await page.evaluate(() => ['contract-currency', 'return-mode'].map((id) => {
                const el = document.getElementById(id);
                const ctx = document.createElement('canvas').getContext('2d');
                const cs = getComputedStyle(el);
                ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
                const need = Math.max(...[...el.options].map((o) => ctx.measureText(o.text).width));
                return { id, need: Math.ceil(need), have: el.clientWidth - 28 };
            }).filter((r) => r.need > r.have).map((r) => r.id + ':' + r.need + '>' + r.have));
            assert.deepEqual(narrow, [], 'option text wider than the select at ' + width);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.ok(overflow <= 0, 'horizontal scroll at ' + width);
            await page.close();
        }
    } finally {
        await browser.close();
        server.close();
    }
});

test('calculator selects use short option labels with the full text in title', () => {
    const sel = (id) => sliceBetween(html, '<select id="' + id + '"', '</select>');
    const currency = sel('contract-currency');
    assert.match(currency, />грн<\/option>/);
    assert.match(currency, />\$<\/option>/);
    assert.match(currency, />€<\/option>/);
    assert.match(currency, /title="Валюта ставки/);
    const ret = sel('return-mode');
    assert.match(ret, /<option value="циклічний">🟢 Циклічний вивіз<\/option>/);
    assert.match(ret, /<option value="разовий" selected>⚪ Разовий, без повернення<\/option>/);
    assert.match(ret, /title="Циклічний вивіз: весь обсяг/);
    assert.ok(html.includes('select#return-mode { width: 100% !important; min-width: 0; }'));
});
