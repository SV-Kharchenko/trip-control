import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start + ' … ' + end);
    return source.slice(from, to);
}

const cabinet = sliceBetween(html, 'function buildCabinet()', 'const FLEET_DOCS = [');

test('the company tab follows the mockup field order and keeps the field ids', () => {
    const company = sliceBetween(cabinet, 'data-panel="company"', 'const costCards = [');
    assert.equal(company.includes('#1aa56e'), false);
    assert.equal(company.includes('Зміни зберігаються кнопкою нижче'), false);
    assert.match(company, /class="cab-company-sub">Обов’язкові поля/);
    const order = ['id="cab-name"', 'byKey.coEdrpou', 'byKey.coCountry', 'byKey.coCity', 'byKey.coAddress',
        'byKey.coPhone', 'byKey.coWebsite', 'byKey.coReportEmail', 'id="cab-tax"', 'byKey.coOwnership',
        'byKey.coZip', 'byKey.coTimezone', 'byKey.coLang'];
    const positions = order.map(function (mark) { return company.indexOf(mark); });
    positions.forEach(function (pos, i) { assert.ok(pos > 0, order[i]); });
    assert.deepEqual(positions.slice().sort(function (a, b) { return a - b; }), positions);
    assert.match(company, /<div class="cab-card tc-mode-box">[^]*onclick="saveWorkMode\(\)"/);
    assert.match(company, /id="weekly-report-box" class="cab-card tc-report-box"/);
    assert.match(company, /onclick="previewWeeklyReport\(\)"/);
    assert.match(company, /onclick="sendWeeklyReport\(\)"/);
    assert.match(html, /@media \(max-width: 900px\) \{\n\s+#cabinet-screen \.cab-grid\.cab-company-grid \{ grid-template-columns: 1fr; \}/);
});

test('the team tab uses token classes instead of inline styles', () => {
    const team = sliceBetween(cabinet, 'data-panel="team"', 'box.innerHTML = html;');
    assert.equal(/style="/.test(team), false);
    assert.match(team, /id="team-seat-badge"/);
    assert.match(team, /onclick="inviteTeamMember\(\)"/);
    assert.match(team, /onchange="saveTeamVisibility\(\)"/);
    const render = sliceBetween(html, 'function renderTeamPanel()', 'function inviteTimeLeft(');
    assert.equal(/style="/.test(render), false);
    assert.match(render, /tc-role-badge is-/);
    assert.match(render, /tc-state-chip/);
    assert.match(render, /seatBadge\.textContent = seats\.used \+ '\/' \+ seats\.limit/);
    assert.match(render, /disableTeamMember\(/);
    assert.match(render, /revokeTeamInvite\(/);
});

test('history tools and the migrate box are styled by classes', () => {
    const panel = sliceBetween(html, '<div id="history-panel" hidden>', '<div id="fact-editor" hidden>');
    assert.equal(panel.includes('rgba(59,130,246'), false);
    assert.match(panel, /id="migrate-box" class="tc-migrate-box"/);
    assert.match(panel, /<h3 class="tc-template-title">Шаблони маршрутів<\/h3>/);
    assert.match(html, /\.tc-history-tools \{\n\s+display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    assert.match(html, /\.tc-history-num\.is-neg \{ color: var\(--negative\);/);
});

test('deficit badge, cascade per-ton note and history sums show the typographic minus', () => {
    assert.match(html, /beGapEl\.innerText = displayMinus\(`Дефіцит \$\{beShown\(gap\)\} \$\{beUnit\}`\);/);
    assert.match(html, /tc-cascade-note">на 1 т: ' \+ displayMinus\(numPlain\(row\.perTon\)\)/);
    const table = sliceBetween(html, 'const profitHtml = function (row, fields) {', 'function shiftHistoryPage(');
    assert.match(table, /'—' : displayMinus\(formatMoney\(fields\.profit\)\)\)/);
    assert.match(table, /факт ' \+ displayMinus\(formatMoney\(actual\.profit\)\)/);
    assert.match(table, /Прибуток ' \+ \(fields\.profit == null \? '—' : displayMinus\(formatMoney\(fields\.profit\)\)\)/);
    const fact = sliceBetween(html, 'function factCell(row, fields)', 'function syncFactAlertControl()');
    assert.match(fact, /displayMinus\(formatMoney\(actual\.profit\)\)/);
    // форматери й експорт лишаються з ASCII-дефісом
    assert.equal(sliceBetween(html, 'function formatHistoryNum(value, digits)', 'function formatHistoryDate(').includes('displayMinus'), false);
    assert.equal(sliceBetween(html, 'async function exportExcel()', 'function ').includes('displayMinus'), false);
});
