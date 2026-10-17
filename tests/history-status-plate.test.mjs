import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const migration = read('supabase/migrations/20261017120000_calculations_status_grant.sql');

// Source of a top-level `function name(...) { ... }` in the page script.
function source(name) {
    const match = new RegExp('\\n    (async )?function ' + name + '\\(').exec(html);
    assert.ok(match, name + ' is missing from index.html');
    const start = match.index;
    const end = html.indexOf('\n    }\n', start);
    return html.slice(start, end + 6);
}
function page(names, expose, prelude = '') {
    const body = prelude + names.map(source).join('\n') + '\nreturn { ' + expose.join(', ') + ' };';
    return new Function(body)();
}

const plates = page(
    ['historyPlateKey', 'historyTripVehicles', 'historyPlateIndex', 'historyPlateMatches'],
    ['historyPlateKey', 'historyPlateIndex', 'historyPlateMatches'],
    "const HISTORY_NO_VEHICLE = '__none__';\n"
);
const errors = page(['dbErrorText', 'tripStatusErrorText'], ['tripStatusErrorText']);

const FLEET = [
    { id: 'f1', label: 'AA 0001 KA' },
    { id: 'f2', label: 'AA0002KA' }
];
const trip = (id, createdAt, vehicles) => ({ id, createdAt, inputs: vehicles === undefined ? { carsCount: '1' } : { vehicles } });
const ROWS = [
    trip('one', '2026-10-09', [{ id: 'f1', label: 'AA0001KA', tonnage: 22 }]),
    trip('many', '2026-10-08', [{ id: 'f1', label: 'AA0001KA' }, { id: 'f2', label: 'AA0002KA' }]),
    trip('none', '2026-10-07', []),
    trip('legacy-none', '2026-10-06'),
    trip('renamed', '2026-10-05', [{ id: 'f2', label: 'OLD 123' }]),
    trip('gone-new', '2026-10-04', [{ id: 'gone', label: 'BC 7777 AX' }]),
    trip('gone-old', '2026-09-01', [{ label: 'bc-7777-ax' }]),
    trip('legacy-fleet', '2026-08-01', [{ label: 'aa-0001-ka' }]),
    trip('legacy-gone', '2026-07-01', [{ label: 'KA 12 34' }])
];
const index = plates.historyPlateIndex(ROWS, FLEET);
const found = (value) => ROWS.filter((row) => plates.historyPlateMatches(index, row, value)).map((row) => row.id);

test('plate key: upper case, no spaces or hyphens (incl. dashes)', () => {
    assert.equal(plates.historyPlateKey(' aa 0001-ka '), 'AA0001KA');
    assert.equal(plates.historyPlateKey('AI–4545—KB'), 'AI4545KB');
    assert.equal(plates.historyPlateKey(null), '');
});

test('options: fleet plates + plates only left in trips, no duplicates, sorted by plate', () => {
    assert.deepEqual(index.options, [
        { value: 'f1', label: 'AA 0001 KA' },
        { value: 'f2', label: 'AA0002KA' },
        { value: 'gone', label: 'BC 7777 AX' },
        { value: 'KA1234', label: 'KA 12 34' }
    ]);
});

test('one / several / no vehicles: a multi-vehicle trip is found by any of them, «Без авто» finds 0', () => {
    assert.deepEqual(found(''), ROWS.map((row) => row.id));
    assert.deepEqual(found('f1'), ['one', 'many', 'legacy-fleet']);
    assert.deepEqual(found('f2'), ['many', 'renamed']);
    assert.deepEqual(found('__none__'), ['none', 'legacy-none']);
});

test('renamed vehicle matches by vehicle_id; deleted one by vehicle_id, else by snapshot plate', () => {
    assert.deepEqual(index.keysOf(ROWS.find((row) => row.id === 'renamed')), ['f2']);
    // Both trips of the deleted BC 7777 AX: one linked by id, the old one only by its plate.
    assert.deepEqual(found('gone'), ['gone-new', 'gone-old']);
    assert.deepEqual(found('KA1234'), ['legacy-gone']);
});

test('old trips: plates straight from inputs.vehicles, matched to the fleet by plate', () => {
    assert.deepEqual(index.keysOf(ROWS.find((row) => row.id === 'legacy-fleet')), ['f1']);
    // The same plate written two ways is one search entry.
    assert.deepEqual(index.platesOf(ROWS.find((row) => row.id === 'legacy-fleet')), ['aa-0001-ka']);
});

test('search text gets the trip plates and the current fleet plate', () => {
    assert.deepEqual(index.platesOf(ROWS.find((row) => row.id === 'renamed')), ['OLD 123', 'AA0002KA']);
    assert.deepEqual(index.platesOf(ROWS.find((row) => row.id === 'many')), ['AA0001KA', 'AA0002KA']);
    const filter = source('filteredHistory');
    assert.match(filter, /\.concat\(rowPlates\)/);
    assert.match(filter, /historyPlateKey\(needle\)/);
    assert.match(filter, /fields\.trailer, savedAuthorLabel/);
    assert.doesNotMatch(filter, /history-trailer|fields\.trailer !== trailer/);
});

test('select: «Усі авто» + plates + «Без авто»; the chosen value is kept while it exists', () => {
    const select = {
        value: '', children: [],
        set textContent(v) { this.children = []; },
        appendChild(el) { this.children.push(el); }
    };
    const state = { savedCalculations: ROWS, fleetVehicles: FLEET };
    const refresh = new Function('document', 'state', "const HISTORY_NO_VEHICLE = '__none__';\n" +
        ['historyPlateKey', 'historyTripVehicles', 'historyPlateIndex', 'refreshHistoryPlateOptions'].map(source).join('\n')
            .replace(/savedCalculations, fleetVehicles/g, 'state.savedCalculations, state.fleetVehicles') +
        '\nreturn refreshHistoryPlateOptions;')({
        getElementById: (id) => (id === 'history-plate' ? select : null),
        createElement: () => ({})
    }, state);
    assert.equal(refresh(), false);
    assert.deepEqual(select.children.map((o) => o.textContent), ['Усі авто', 'AA 0001 KA', 'AA0002KA', 'BC 7777 AX', 'KA 12 34', 'Без авто']);
    select.value = 'f2';
    assert.equal(refresh(), false);
    assert.equal(select.value, 'f2');
    state.fleetVehicles = [FLEET[0]];
    state.savedCalculations = ROWS.filter((row) => row.id === 'one');
    assert.equal(refresh(), true, 'f2 left the fleet and no trip has it: reset to «Усі авто»');
    assert.equal(select.value, '');
});

test('markup and wiring: #history-plate replaces #history-trailer; refreshed after load and fleet changes', () => {
    assert.doesNotMatch(html, /history-trailer|Усі причепи/);
    assert.match(html, /<select id="history-plate" aria-label="Авто" onchange="historyPage=0;renderSavedTable\(\)">\n\s+<option value="">Усі авто<\/option>\n\s+<\/select>/);
    assert.match(source('loadSavedCalculations'), /await loadTripActuals\(\);\n\s+refreshHistoryPlateOptions\(\);\n\s+renderSavedTable\(\);/);
    assert.match(source('renderFleetDocs'), /^\n    function renderFleetDocs\(\) \{\n        if \(refreshHistoryPlateOptions\(\)\) renderSavedTable\(\);/);
    // Trailer type stays in CSV.
    assert.match(source('historyExportHeaders'), /'Причіп'/);
});

test('status error text: 42501 / 403 → no rights; otherwise the database message', () => {
    const NO_RIGHTS = 'Немає прав змінювати статус цього рейсу';
    assert.equal(errors.tripStatusErrorText({ code: '42501', message: 'permission denied for table calculations' }), NO_RIGHTS);
    assert.equal(errors.tripStatusErrorText({ httpStatus: 403, message: 'Forbidden' }), NO_RIGHTS);
    assert.equal(errors.tripStatusErrorText({ code: '23514', message: 'new row violates check constraint', details: 'calculations_status_check' }),
        'new row violates check constraint calculations_status_check');
    assert.equal(errors.tripStatusErrorText(new Error('Failed to fetch')), 'Failed to fetch');
});

test('setTripStatus: no «міграція історії» text, 0 rows = no rights, success toast, UI rollback kept', () => {
    const fn = source('setTripStatus');
    assert.doesNotMatch(html, /міграція історії/);
    assert.match(fn, /\.update\(\{ status: status \}\)\.eq\('id', id\)\.select\('id'\)/);
    assert.match(fn, /if \(!data \|\| !data\.length\) throw \{ code: '42501', httpStatus: 403 \};/);
    assert.match(fn, /showToast\('✓ Статус: ' \+ statusLabel\(status\), 2200, 'ok'\);/);
    assert.match(fn, /row\.status = previous;\n\s+renderSavedTable\(\);\n\s+showToast\(tripStatusErrorText\(e\), 4200, 'error'\);/);
    assert.match(source('canEditSaved'), /return currentOrgRole === 'owner' \|\| row\.userId === currentUserId;/);
});

test('migration: only GRANT UPDATE (status), no RLS changes', () => {
    assert.match(migration, /^GRANT UPDATE \(status\) ON public\.calculations TO authenticated;$/m);
    assert.match(migration, /лише права на name|for\s+the name column only/);
    assert.doesNotMatch(migration.replace(/^--.*$/gm, ''), /POLICY|GRANT UPDATE ON|GRANT ALL|REVOKE|ALTER TABLE/i);
});

test('status grant on Postgres with production grants (PGlite)', (t) => {
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const script = fileURLToPath(new URL('../scripts/check-calculations-status-grant.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const line of [
        'before migration: owner status PATCH is 42501 permission denied for table calculations',
        'owner changes the status of a logist trip',
        'logist changes the status of an own trip',
        'logist cannot change another logist trip (0 rows)',
        'logists_see_all: logist sees another trip but still cannot change it (0 rows)',
        'blocked user cannot change an own trip (0 rows)',
        'org_id / user_id still cannot be changed (42501)',
        'table not opened: results still denied, name still allowed'
    ]) {
        assert.ok(run.stdout.includes('PASS ' + line), line);
    }
});
