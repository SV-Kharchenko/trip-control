// Картка авто (Кабінет → Автопарк): поля ТЗ для ТТН Контроль+ (етап 4b) і згорнутий блок «ТО і Страхування».
// Рішення Свята від 26.10: index.html змінюється лише в картці авто / автопарку; формули й теми — без змін.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.equal(from >= 0, true, start);
    assert.equal(to > from, true, end);
    return source.slice(from, to);
}

function fnSource(name) {
    const match = html.match(new RegExp('\\n    (async )?function ' + name + '\\([^)]*\\) \\{\\n[\\s\\S]*?\\n    \\}\\n'));
    assert.ok(match, name + ' is missing from index.html');
    return match[0];
}

const constants = sliceBetween(html, '    const FLEET_TTN_COLUMNS', '    function kyivTodayYmd(');
const context = vm.createContext({ uiPreview: false, fleetTtnReady: true, teamEsc: (v) => String(v) });
vm.runInContext(constants.replace(/\bconst /g, 'var ') + fnSource('readFleetTtn') + fnSource('fleetDocsBadge') + fnSource('fleetTtnMarkup'), context);

function card(values) {
    return { querySelector: (sel) => { const key = /data-norm="([^"]+)"/.exec(sel)[1]; return key in values ? { value: values[key] } : null; } };
}

test('the new vehicle fields are in the card form and in the select (with a fallback for a database without them)', () => {
    assert.equal(context.FLEET_TTN_COLUMNS, 'vehicle_type, trailer_make_model, length_m, width_m, height_m, tare_t, max_mass_t');
    const markup = context.fleetTtnMarkup({ vehicle_type: 'Тягач сідловий', length_m: 16.5 }, true);
    for (const key of ['vehicle_type', 'trailer_make_model', 'length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t']) {
        assert.match(markup, new RegExp('data-norm="' + key + '"'), key);
    }
    assert.match(markup, /Дані для ТТН/);
    assert.match(markup, /data-norm="length_m" min="0\.01" max="30"/);
    assert.match(markup, /data-norm="tare_t" min="0\.001" max="100"/);
    assert.doesNotMatch(context.fleetTtnMarkup({}, true), / disabled/);
    assert.match(context.fleetTtnMarkup({}, false), / disabled/, 'read-only for everyone but the owner (director included)');
    context.fleetTtnReady = false;
    assert.equal(context.fleetTtnMarkup({}, true), '', 'no fields until the database has the columns');
    context.fleetTtnReady = true;
    assert.match(fnSource('fleetNormMarkup'), /\+ fleetTtnMarkup\(vehicle, owner\);/);
    const load = fnSource('loadFleetVehicles');
    assert.match(load, /\.select\(FLEET_COLUMNS \+ ', ' \+ FLEET_TTN_COLUMNS\)/);
    assert.match(load, /fleetTtnReady = !error;/);
    assert.match(load, /select\(FLEET_COLUMNS\)\.order\('label'\)/, 'fallback without the new columns');
    assert.match(load, /select\(FLEET_DOC_COLUMNS\)/, 'the old fallback stays');
    assert.match(fnSource('saveFleetVehicle'), /\.select\(fleetTtnReady \? FLEET_COLUMNS \+ ', ' \+ FLEET_TTN_COLUMNS : FLEET_COLUMNS\)/);
    assert.match(fnSource('readFleetNorms'), /const ttn = readFleetTtn\(card\);/);
});

test('vehicle fields: empty → null, > 0 and within the database limits, tare below the maximum mass', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(context.readFleetTtn(card({ vehicle_type: ' Тягач ', trailer_make_model: '', length_m: '16.5', width_m: '2,55', height_m: '', tare_t: '15.75', max_mass_t: '40' })))),
        { ok: true, values: { vehicle_type: 'Тягач', trailer_make_model: null, length_m: 16.5, width_m: 2.55, height_m: null, tare_t: 15.75, max_mass_t: 40 } });
    for (const [values, re] of [
        [{ length_m: '0' }, /Довжина/], [{ width_m: '-1' }, /Ширина/], [{ height_m: '31' }, /Висота/], [{ tare_t: '101' }, /Тара/],
        [{ max_mass_t: '0' }, /Макс/], [{ tare_t: '40', max_mass_t: '40' }, /меншою/], [{ vehicle_type: 'т'.repeat(101) }, /Тип ТЗ/], [{ length_m: 'abc' }, /Довжина/],
    ]) {
        const out = context.readFleetTtn(card(values));
        assert.equal(out.ok, false, JSON.stringify(values));
        assert.match(out.error, re);
    }
    assert.match(fnSource('fleetWriteError'), /fleet_vehicles_dimensions/, 'database CHECK errors explained');
});

test('TO and insurance: a collapsed block, opened by a click, with a badge when a date is yellow / red', () => {
    assert.equal(context.fleetDocsBadge(0, 0), null);
    assert.deepEqual(JSON.parse(JSON.stringify(context.fleetDocsBadge(0, 2))), { count: 2, tone: 'soon' });
    assert.deepEqual(JSON.parse(JSON.stringify(context.fleetDocsBadge(1, 2))), { count: 3, tone: 'overdue' });
    const render = sliceBetween(html, '    function renderFleetDocs()', '    async function loadFleetVehicles()');
    assert.match(render, /Додаткова інформація про ТО і Страхування/);
    assert.match(render, /const docsOpen = fleetDocsOpenIds\[vehicle\.id\] === true;/, 'collapsed by default');
    assert.match(render, /aria-expanded="' \+ \(docsOpen \? 'true' : 'false'\)/);
    assert.match(render, /\(docsOpen \? '' : ' hidden'\) \+ '>' \+ fields \+ '<\/div>/, 'the dates (same highlight logic) live inside the block');
    assert.match(render, /tc-fleet-docs-badge is-' \+ docsBadge\.tone/);
    assert.match(render, /fleetDocsBadge\(cardOverdue, cardSoon\)/, 'the same counters as the card status');
    const toggle = fnSource('toggleFleetDocsBlock');
    assert.equal(toggle.includes('renderFleetDocs'), false, 'a click only toggles');
    assert.match(toggle, /block\.hidden = !open;/);
    assert.match(html, /#cabinet-screen \.tc-fleet-docs-badge\.is-overdue \{ color: var\(--danger\)/);
    assert.match(html, /#cabinet-screen \.tc-fleet-docs-badge\.is-soon \{ color: var\(--warning-text\)/);
    assert.match(html, /#cabinet-screen \.tc-fleet-docs\[hidden\] \{ display: none; \}/);
});

test('preview fleet data has invented vehicle fields', () => {
    const preview = sliceBetween(html, "{ id: 'preview-fleet-1', label: 'AA0001KA', make_model", "renderVehicleNormSelect();");
    assert.match(preview, /vehicle_type: 'Тягач сідловий', trailer_make_model: 'Krone SD', length_m: 16\.5, width_m: 2\.55, height_m: 4, tare_t: 15\.75, max_mass_t: 40/);
    assert.match(preview, /id: 'preview-fleet-2'[^\n]*tare_t: 7\.2, max_mass_t: 18/);
});

// Diff index.html відносно main — лише в межах картки авто / автопарку (код, CSS, прев'ю-дані).
test('index.html changes stay inside the vehicle card (formulas, themes and other screens untouched)', (t) => {
    let diff;
    try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: new URL('..', import.meta.url) });
        diff = execFileSync('git', ['diff', '-U0', 'origin/main', '--', 'index.html'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch {
        t.skip('no origin/main');
        return;
    }
    if (!diff.trim()) {
        t.skip('index.html changes already in main');
        return;
    }
    const lines = html.split('\n');
    const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;
    const fleetCode = [lineOf('    let fleetVehicles = [];'), lineOf('    let fleetVehicles = [];') + 4];
    const fleetFns = [lineOf('    const FLEET_DOCS = ['), lineOf('    function showWeeklyReportText(')];
    const css = [lineOf('#cabinet-screen .tc-fleet-note {'), lineOf('#cabinet-screen .tc-fleet-actions button.is-danger') + 14];
    const preview = [lineOf("{ id: 'preview-fleet-1', label: 'AA0001KA', make_model"), lineOf("{ id: 'preview-fleet-2', label: 'AA0002KA', make_model")];
    const inside = (n) => [fleetCode, fleetFns, css, preview].some(([a, b]) => n >= a && n <= b);
    const hunks = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])]);
    if (diff.includes('studio-nav-history') || diff.includes('tc-kpi-bar') || diff.includes("menuGo('fleet')") || diff.includes('calcDocButtons') || diff.includes('routeVariantLabel') || diff.includes('CABINET_REDIRECTS') || diff.includes('doc_emailed') || diff.includes('Відкрити контрагента')) {
        // Інша зміна index.html (вкладка «Історія рейсів» — tests/trip-history-tab.test.mjs; калькулятор на одній сторінці — tests/calc-onepage.test.mjs; перемикачі варіантів маршруту — tests/route-switchers.test.mjs; єдиний «Особистий кабінет» — tests/director-cabinet-ui.test.mjs): картки авто вона торкатися не має.
        for (const [start, count] of hunks) {
            for (let n = start; n < start + count; n += 1) assert.ok(!inside(n), 'history-tab change touches the vehicle card at line ' + n + ': ' + lines[n - 1]);
        }
        return;
    }
    assert.ok(hunks.length > 0, 'index.html is changed');
    for (const [start, count] of hunks) {
        for (let n = start; n < start + Math.max(count, 1); n += 1) assert.ok(inside(n), 'changed line ' + n + ' is outside the vehicle card: ' + lines[n - 1]);
    }
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    for (const line of removed) {
        assert.match(line, /fleet|FLEET|tc-fleet|preview-fleet|fields \+|\.select\(FLEET_COLUMNS\)|<\/select><\/label>|'<\/div>';|let \{ data, error \}|\.select\(|\.order\('label'\)|if \(error && \/make_model/, 'removed line belongs to the vehicle card: ' + line);
    }
    for (const marker of ['function calculate(', 'data-theme', 'computeTrip', 'renderChart(']) {
        assert.equal(diff.includes(marker), false, marker + ' untouched');
    }
});
