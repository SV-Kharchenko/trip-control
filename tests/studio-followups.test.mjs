import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('route choices sit on the map and the route summary row stays out of the studio column', () => {
    const mount = html.slice(html.indexOf('function mountStudioDom()'), html.indexOf('function formatMoney('));
    assert.equal(mount.includes('studioTake(nodes.alts)'), false);
    assert.equal(mount.includes('studioTake(nodes.route)'), false);
    assert.match(html, /body\.layout-studio \.tc-map-frame > \.tc-map-alts \{[\s\S]*position: absolute;/);
    assert.match(html, /@media \(max-width: 900px\) \{[\s\S]*body\.layout-studio \.tc-map-frame > \.tc-map-alts \{[\s\S]*flex-direction: row;/);
    assert.match(html, /body\.layout-studio \.tc-route-bar \{ display: none !important; \}/);
    assert.match(html, /onclick="selectRouteAlternative\(/);
});

test('trip history is collapsed by default and Excel sits under the table', () => {
    assert.match(html, /id="history-toggle"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /aria-controls="history-panel"/);
    assert.match(html, /const HISTORY_OPEN_KEY = 'tc_history_open'/);
    assert.match(html, /localStorage\.getItem\(HISTORY_OPEN_KEY\) === '1'/);
    const panel = html.slice(html.indexOf('id="history-panel"'), html.indexOf('id="tc-result-actions"'));
    const tableAt = panel.indexOf('id="saved-table"');
    const excelAt = panel.indexOf("exportHistory('xlsx')");
    assert.ok(tableAt !== -1 && excelAt > tableAt);
    assert.equal(panel.includes('Експорт CSV'), false);
    assert.match(html, /body\.layout-studio\[data-studio-view="overview"\] #tc-step-strip \{ display: none !important; \}/);
});

test('cabinet groups the same setting keys under new labels', () => {
    const sections = html.slice(html.indexOf('const CAB_SECTIONS = ['), html.indexOf('const LEGACY_SETTINGS_KEYS'));
    ['totalFleet', 'amort', 'admin', 'otherOperating', 'otherExpenses', 'repair', 'fin',
        'fuelLoad', 'fuelEmpty', 'driverPayMode', 'driverRateLoad', 'driverRateEmpty', 'driverPctVal', 'perDiem',
        'toCost', 'toPeriod', 'tireCost', 'tireCount', 'tireMileage'].forEach(function (key) {
        assert.match(sections, new RegExp('key: \'' + key + '\''));
    });
    // «Значення за замовчуванням» (вкладки «Витратна частина» і «Пальне») прибрано з кабінету.
    assert.doesNotMatch(html, /Витратна частина|data-panel="costs"|data-panel="fuel"/);
    assert.match(html, /data-panel="docs"/);
    assert.match(html, />Автопарк</);
    assert.match(html, /class="btn cab-cancel"/);
    assert.match(html, /id="cab-save-btn"/);
    assert.match(html, /#cabinet-screen input\[type="number"\] \{\s*font-family: 'JetBrains Mono'/);
    assert.equal(html.includes("title: 'Документи'"), false);
    assert.equal(html.includes("tab: 'Водій'"), true);
});
