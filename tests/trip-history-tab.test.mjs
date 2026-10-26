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
