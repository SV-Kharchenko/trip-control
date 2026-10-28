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

const css = sliceBetween(html, '/* ===== v3: сторінка результату', '</style>');
const history = sliceBetween(html, 'function renderSavedTable()', 'function shiftHistoryPage(');

// ---------- статичні перевірки ----------

test('«Дублювати» is gone everywhere (code, buttons, tests)', () => {
    assert.equal(html.includes('Дублювати'), false);
    assert.equal(html.includes('duplicateSaved'), false);
    for (const file of ['tests/calc-onepage.test.mjs', 'tests/history-followups.test.mjs', 'tests/history-status-plate.test.mjs', 'tests/trip-history-tab.test.mjs']) {
        assert.equal(readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes('duplicateSaved'), false, file);
    }
});

test('result page: one grid, row 1 and row 2 stretch to equal height, single column under 1180px', () => {
    assert.match(css, /#studio-right \{\n\s+display: grid !important; grid-template-columns: minmax\(0, 1\.55fr\) minmax\(360px, 1fr\); gap: var\(--tc-gap\); align-items: stretch;/);
    assert.match(css, /\.tc-map-frame \{\n\s+grid-column: 1 !important; grid-row: 2 !important;[^}]*height: auto !important; min-height: 360px !important; align-self: stretch;/);
    assert.match(css, /#tc-det-side \{\n\s+grid-column: 2 !important; grid-row: 2 !important; align-self: stretch;/);
    assert.match(css, /\.tc-costs-visual \{\n\s+grid-column: 1 \/ -1 !important; grid-row: 3 !important; display: grid !important; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*align-items: stretch;/);
    assert.match(css, /\.tc-costs-visual > \.card \{ display: flex; flex-direction: column;/);
    assert.match(css, /@media \(max-width: 1180px\) \{\n\s+body\.layout-studio\[data-studio-view="calc"\]\[data-calc-detail="1"\] #studio-right \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    // Кнопки сіткою 2 колонки; «Відправити на погодження» першою, лише для логіста.
    assert.match(css, /#tc-det-side > \.actions-bar \{ margin-top: auto; display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 10px; \}/);
    const actions = sliceBetween(html, 'id="tc-result-actions"', '</div>');
    assert.ok(actions.indexOf('tc-send-approval') < actions.indexOf('saveCalculation()'));
    assert.match(actions, /id="tc-send-approval" onclick="sendCurrentForApproval\(\)" hidden>Відправити на погодження<\/button>/);
    const order = ['saveCalculation()', 'window.print()', 'exportExcel()', 'shareOffer()', 'shareTelegram()'].map((s) => actions.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('numeric fields: one inline row «label ↔ 120–160px field with the unit inside»; A/B is a separate badge', () => {
    assert.match(css, /#tc-op \.form-row:has\(> \.tc-in > input\[type="number"\]\) \{ display: flex; align-items: center; justify-content: space-between;/);
    assert.match(css, /> \.tc-in \{ flex: 0 0 auto; width: clamp\(120px, 9vw, 160px\); \}/);
    assert.match(css, /\.tc-f-rate \.form-row > \.tc-in \{ width: clamp\(160px, 10\.5vw, 170px\); \}/);
    assert.match(css, /\.tc-badge \{ flex: 0 0 var\(--tc-h\); width: var\(--tc-h\);/);
    assert.match(css, /\.tc-addr \{ display: flex; align-items: center; gap: 8px; min-width: 0; \}/);
    const build = sliceBetween(html, 'function buildOnePage()', 'function focusMissingField(');
    assert.match(build, /wrap\.className = 'tc-addr'/);
    assert.match(build, /mark\.className = 'tc-badge'/);
    assert.ok(build.indexOf('wrap.appendChild(mark)') < build.indexOf('wrap.appendChild(box)'), 'badge sits left of the input');
    assert.ok(css.includes('.tc-in > select.cur { min-width: 84px; }'));
});

test('history: 6 columns, fixed layout without horizontal scroll, status chips, custom modal instead of confirm/alert', () => {
    const heads = [...sliceBetween(html, '<table id="saved-table">', '</thead>').matchAll(/<th class="c-[a-z]">([^<]+)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, ['Дата', 'Назва / маршрут', 'Логіст', 'Прибуток', 'Статус', 'Дії']);
    assert.match(css, /#saved-table \{ table-layout: fixed; width: 100%;/);
    assert.match(css, /#saved-section \.comparison-table \{ overflow-x: visible; \}/);
    assert.equal(html.includes('Історія рейсів'), false);
    assert.match(html, /<span>Заявки<\/span>/);
    assert.match(html, /<option value="pending">На погодженні<\/option>/);
    for (const label of ['На погодженні', 'Прийнята', 'Відхилена', 'Чернетка']) assert.ok(html.includes("'" + label + "'"), label);
    assert.equal(/\bconfirm\(|\balert\(/.test(history + sliceBetween(html, 'async function removeSaved(id)', '// Кнопка одноразового переносу')), false);
    assert.match(html, /function tcModal\(options\)/);
    const reject = sliceBetween(html, 'async function rejectRequest(id)', '// Кнопка на сторінці результату');
    assert.match(reject, /tcModal\(\{/);
    assert.match(reject, /action: 'calc_decide'|'calc_decide'/);
});

test('migration file is new, idempotent and untouched by deploy scripts', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20261027140559_calc_approvals.sql', import.meta.url), 'utf8');
    assert.match(sql, /НЕ застосовувати на прод/);
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS') && sql.includes('DROP POLICY IF EXISTS') && sql.includes('DROP TRIGGER IF EXISTS'));
});

// ---------- jsdom (за наявності): ролі й кнопки без Chrome ----------

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

const rowFor = (status, userId) => ({
    id: 'r-' + status + '-' + userId, name: 'Луцьк → Харків', routeName: 'Луцьк → Харків', userId, status,
    createdAt: '2026-10-27T10:00:00Z', profit: 44648, results: {}, inputs: {}
});

test('jsdom: actions per role — logist cannot decide or delete accepted, director decides pending', async (t) => {
    const dom = await bootDom();
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const w = dom.window;
        const actions = (role, uiView, status, author) => {
            w.eval('currentOrgRole = ' + JSON.stringify(role) + '; uiView = ' + JSON.stringify(uiView) + '; currentUserId = "me"; currentWorkMode = "team";');
            return w.historyActions(rowFor(status, author));
        };
        // Логіст, власна заявка.
        const logistDraft = actions('logist', 'director', 'draft', 'me');
        assert.match(logistDraft, /submitForApproval/);
        assert.match(logistDraft, /removeSaved/);
        assert.equal(/approveRequest|rejectRequest/.test(logistDraft), false);
        const logistPending = actions('logist', 'director', 'pending', 'me');
        assert.equal(/approveRequest|rejectRequest|submitForApproval/.test(logistPending), false);
        const logistAccepted = actions('logist', 'director', 'accepted', 'me');
        assert.equal(/removeSaved/.test(logistAccepted), false, 'accepted cannot be deleted');
        assert.equal(/approveRequest|rejectRequest/.test(logistAccepted), false);
        // Логіст не бачить чужих рядків для дій.
        assert.match(actions('logist', 'director', 'pending', 'someone-else'), /лише перегляд/);
        // Директор.
        const dirPending = actions('owner', 'director', 'pending', 'logist-1');
        assert.match(dirPending, /approveRequest/);
        assert.match(dirPending, /rejectRequest/);
        assert.equal(/removeSaved/.test(actions('owner', 'director', 'accepted', 'logist-1')), false);
        assert.equal(/approveRequest/.test(actions('owner', 'director', 'draft', 'logist-1')), false, 'only pending is decided');
        // Кнопка «Відправити на погодження» на сторінці результату.
        const send = () => { w.syncApprovalUi(); return w.document.getElementById('tc-send-approval').hidden; };
        w.eval('currentOrgRole = "logist"; uiView = "director";');
        assert.equal(send(), false, 'visible for a logist');
        w.eval('currentOrgRole = "owner"; uiView = "director";');
        assert.equal(send(), true, 'hidden for the director');
        w.eval('currentOrgRole = "owner"; uiView = "logist";');
        assert.equal(send(), false, 'owner in the logist view sees what a logist sees');
        assert.equal(w.document.body.innerHTML.includes('Дублювати'), false);
    } finally {
        dom.window.close();
    }
});

test('jsdom: history table renders 6 cells per row with a status chip and the reject reason', async (t) => {
    const dom = await bootDom();
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const w = dom.window;
        const d = w.document;
        w.eval('currentOrgRole = "owner"; uiView = "director"; currentUserId = "boss"; currentWorkMode = "team";');
        const rows = [rowFor('pending', 'logist-1'), { ...rowFor('rejected', 'logist-1'), rejectReason: 'Дорого' }, rowFor('accepted', 'logist-1'), rowFor('draft', 'logist-1')];
        w.eval('savedCalculations = ' + JSON.stringify(rows) + ';');
        w.renderSavedTable();
        const cells = [...d.querySelectorAll('#saved-tbody tr')].map((tr) => tr.children.length);
        assert.deepEqual(cells, [6, 6, 6, 6]);
        const chips = [...d.querySelectorAll('#saved-tbody .tc-status')].map((el) => el.textContent);
        assert.deepEqual(chips, ['На погодженні', 'Відхилена', 'Прийнята', 'Чернетка']);
        assert.match(d.querySelector('#saved-tbody').textContent, /Дорого/);
        assert.equal(d.querySelectorAll('#saved-table th').length, 6);
    } finally {
        dom.window.close();
    }
});

// ---------- браузер (скіп без playwright-core/Chrome) ----------

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

test('browser: result page rows are equal in height, edges line up, no horizontal scroll (1280 / 1440 / 1920)', async (t) => {
    await withPage(t, [1280, 1440, 1920], async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        await page.click('#kb-detail');
        await page.waitForTimeout(150);
        const g = await page.evaluate(() => {
            const r = (el) => el.getBoundingClientRect();
            const map = r(document.querySelector('.tc-map-frame'));
            const side = r(document.getElementById('tc-det-side'));
            const cards = [...document.querySelectorAll('.tc-costs-visual > .card')].map(r);
            return { map, side, cards, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        assert.ok(Math.abs(g.map.height - g.side.height) <= 2, 'row 1 heights ' + g.map.height + ' vs ' + g.side.height + at);
        assert.ok(Math.abs(g.map.top - g.side.top) <= 2 && Math.abs(g.map.bottom - g.side.bottom) <= 2, 'row 1 edges' + at);
        assert.equal(g.cards.length, 2);
        assert.ok(Math.abs(g.cards[0].height - g.cards[1].height) <= 2, 'row 2 heights' + at);
        assert.ok(Math.abs(g.cards[0].top - g.cards[1].top) <= 2, 'row 2 tops' + at);
        assert.ok(Math.abs(g.cards[0].left - g.map.left) <= 2 && Math.abs(g.cards[1].right - g.side.right) <= 2, 'row 2 aligns with row 1' + at);
        assert.ok(g.scroll <= 0, 'horizontal scroll' + at);
    });
});

test('browser: numeric fields ≤180px, uncut, A/B badge never overlaps the input (1024 … 1920)', async (t) => {
    await withPage(t, [1024, 1280, 1440, 1920], async (page, width, theme) => {
        const at = ' at ' + width + ' ' + theme;
        const bad = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('#tc-op input[type="number"]').forEach((el) => {
                if (el.offsetParent === null) return;
                const box = el.closest('.tc-in');
                if (box && box.getBoundingClientRect().width > 180) out.push(el.id + ' wide ' + Math.round(box.getBoundingClientRect().width));
                if (el.scrollWidth > el.clientWidth + 1) out.push(el.id + ' cut');
            });
            document.querySelectorAll('#tc-op .tc-addr').forEach((wrap) => {
                if (wrap.offsetParent === null) return;
                const badge = wrap.querySelector('.tc-badge').getBoundingClientRect();
                const box = wrap.querySelector('.tc-in').getBoundingClientRect();
                if (badge.right > box.left + 1) out.push('badge overlaps ' + wrap.querySelector('.tc-badge').textContent);
            });
            return out;
        });
        assert.deepEqual(bad, [], 'numeric fields' + at);
        const currency = await page.evaluate(() => document.getElementById('contract-currency').clientWidth);
        assert.ok(currency >= 76, 'currency width ' + currency + at);
    });
});

test('browser: «Заявки» has no horizontal scroll at 1024 … 1920', async (t) => {
    await withPage(t, [1024, 1280, 1920], async (page, width, theme) => {
        await page.evaluate(() => setStudioView('history'));
        await page.waitForTimeout(150);
        const over = await page.evaluate(() => {
            const wrap = document.querySelector('#saved-section .comparison-table');
            return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, table: wrap ? wrap.scrollWidth - wrap.clientWidth : 0 };
        });
        assert.ok(over.page <= 0 && over.table <= 0, 'history overflow ' + JSON.stringify(over) + ' at ' + width + ' ' + theme);
    });
});

test('dynamic trailer fields stay hidden unless active; visible ones keep the «label + narrow field» look', () => {
    assert.ok(css.includes('#tc-op .form-row.dynamic-field:not(.active) { display: none !important; }'));
    assert.ok(css.indexOf('.form-row.dynamic-field:not(.active) { display: none !important; }') > css.indexOf('.form-row:has(> .tc-in > input[type="number"]) { display: flex;'));
    assert.equal(html.includes('lp-is-proposed">Запропоновано'), false);
    assert.ok(html.includes('lp-is-proposed">На погодженні'));
});

test('jsdom: approval button after calculate() — logist sees «Відправити», team owner sees nothing, solo owner sees «Прийняти заявку»', async (t) => {
    const dom = await bootDom();
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const w = dom.window;
        const d = w.document;
        const visible = (id) => {
            const el = d.getElementById(id);
            return !el.hidden && w.getComputedStyle(el).display !== 'none';
        };
        const scenario = async (role, view, mode) => {
            w.eval('currentOrgRole = ' + JSON.stringify(role) + '; uiView = ' + JSON.stringify(view) + '; currentWorkMode = ' + JSON.stringify(mode) + '; currentSessionToken = "fake";');
            await w.calculate();
            return { send: visible('tc-send-approval'), accept: visible('tc-accept-own') };
        };
        assert.deepEqual(await scenario('logist', 'director', 'team'), { send: true, accept: false }, 'logist');
        assert.deepEqual(await scenario('owner', 'director', 'team'), { send: false, accept: false }, 'owner with logists');
        assert.deepEqual(await scenario('owner', 'director', 'solo'), { send: false, accept: true }, 'owner, mode «Сам»');
        assert.equal(d.getElementById('tc-accept-own').textContent, 'Прийняти заявку');
        assert.equal(d.getElementById('tc-send-approval').textContent, 'Відправити на погодження');
        // Кнопки лежать у картці результату поруч із «Зберегти розрахунок».
        const bar = d.getElementById('tc-result-actions');
        assert.ok(bar.contains(d.getElementById('tc-send-approval')) && bar.contains(d.getElementById('tc-accept-own')));
    } finally {
        dom.window.close();
    }
});

test('jsdom: ref / wash fields follow the trailer type and the visible ones are not hidden by the new row rule', async (t) => {
    const dom = await bootDom();
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const w = dom.window;
        const d = w.document;
        const ids = ['field-ref-consumption', 'field-ref-hours', 'field-wash-cost', 'field-wash-freq'];
        for (const [type, ref, wash] of [['зерновоз', false, false], ['рефрижератор', true, false], ['тент', false, false], ['цистерна', false, true]]) {
            d.getElementById('trailer-type').value = type;
            w.onTrailerChange();
            assert.deepEqual(ids.map((id) => d.getElementById(id).classList.contains('active')), [ref, ref, wash, wash], type);
        }
    } finally {
        dom.window.close();
    }
});
