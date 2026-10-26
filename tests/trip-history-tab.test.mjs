import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function fnBody(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start > 0, name);
    const next = html.indexOf('\n    function ', start + 10);
    return html.slice(start, next > 0 ? next : start + 3000);
}

test('history tab button follows Overview', () => {
    const over = html.indexOf('id="studio-nav-overview"');
    const hist = html.indexOf('id="studio-nav-history"');
    assert.ok(over > 0 && hist > over);
    assert.match(html, /id="studio-nav-history" onclick="setStudioView\('history'\)">Історія рейсів<\/button>/);
});

test('setStudioView supports the history view and toggles the tab', () => {
    const body = fnBody('setStudioView');
    assert.match(body, /'history'/);
    assert.match(body, /data-studio-view', overview \? 'overview' : history \? 'history' : 'calc'/);
    assert.match(body, /histBtn\.classList\.toggle\('on', history\)/);
    assert.match(body, /setHistoryOpen\(true\)/);
});

test('CSS hides #saved-section outside history and keeps it in history', () => {
    assert.match(html, /body\.layout-studio:not\(\[data-studio-view="history"\]\) #saved-section \{ display: none !important; \}/);
    assert.match(html, /body\.layout-studio\[data-studio-view="history"\] #studio-columns/);
    assert.doesNotMatch(html, /\[data-studio-view="history"\] #saved-section[^{}]*display:\s*none/);
});

test('menuGo(history) and openSaved switch views', () => {
    const go = fnBody('menuGo');
    assert.match(go, /setStudioView\('history'\)/);
    assert.doesNotMatch(go, /setStudioView\('calc'\);\s*setHistoryOpen/);
    assert.match(fnBody('openSaved'), /setStudioView\('calc'\)/);
});

test('history controls and renderer are intact; logist keeps the tab', () => {
    for (const id of ['history-search', 'history-from', 'history-to', 'history-status', 'history-plate', 'history-sort',
        'history-cards', 'history-pager', 'history-count', 'history-toggle', 'saved-section']) {
        assert.match(html, new RegExp('id="' + id + '"'), id);
    }
    assert.match(html, /function renderSavedTable\(/);
    assert.doesNotMatch(html, /view-logist #studio-nav-history/);
});

test('history view keeps #studio-columns / #studio-right (where #saved-section lives) and hides the rest', () => {
    assert.match(html, /\[data-studio-view="history"\] #studio-left,\s*body\.layout-studio\[data-studio-view="history"\] #studio-right > :not\(#saved-section\) \{ display: none !important; \}/);
    assert.match(html, /\[data-studio-view="history"\] #studio-columns,\s*body\.layout-studio\[data-studio-view="history"\] #studio-right \{\s*display: block !important;/);
    assert.doesNotMatch(html, /\[data-studio-view="history"\] #studio-columns[,\s]*\{?\s*display: none/);
});

test('history toggle is inert in the history view', () => {
    assert.match(html, /histToggle\.tabIndex = history \? -1 : 0/);
    assert.match(html, /setAttribute\('aria-disabled', 'true'\)/);
    assert.match(fnBody('toggleHistory'), /data-studio-view'\) === 'history'\) return/);
});

// Реальний браузер: потрібні playwright-core і Chrome (PLAYWRIGHT_CHROME або стандартний шлях); інакше тест пропускається.
test('browser: #saved-section is sized and usable in history, hidden in calc/overview', async (t) => {
    let chromium;
    try { ({ chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')); } catch { t.skip('playwright-core is not installed'); return; }
    const exe = process.env.PLAYWRIGHT_CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
    if (!exe) { t.skip('no Chrome'); return; }
    const http = await import('node:http');
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ executablePath: exe });
    try {
        for (const width of [1280, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 800 } });
            await page.goto('http://localhost:' + server.address().port + '/?preview=1', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('layout-studio') && document.getElementById('saved-section'));
            await page.waitForTimeout(2500);
            const probe = (view) => page.evaluate((v) => {
                setStudioView(v);
                const box = document.getElementById('saved-section').getBoundingClientRect();
                const search = document.getElementById('history-search').getBoundingClientRect();
                return { w: box.width, h: box.height, search: search.width * search.height, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
            }, view);
            for (const view of ['calc', 'overview']) assert.equal((await probe(view)).h, 0, view + '@' + width);
            const h = await probe('history');
            assert.ok(h.w > 0 && h.h > 0 && h.search > 0, 'history visible @' + width);
            assert.equal(h.overflow, false, 'no horizontal scroll @' + width);
            await page.close();
        }
    } finally { await browser.close(); server.close(); }
});
