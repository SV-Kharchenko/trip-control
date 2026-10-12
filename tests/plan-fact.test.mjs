import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(
    new URL('../supabase/migrations/20261012220000_trip_actuals.sql', import.meta.url),
    'utf8'
);

function grab(name) {
    const match = html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n    \\}'));
    assert.ok(match, name + ' is missing from index.html');
    const args = match[0].slice(match[0].indexOf('(') + 1, match[0].indexOf(')'));
    return new Function(...args.split(',').map((part) => part.trim()).filter(Boolean), match[1]);
}

const actualTripProfit = grab('actualTripProfit');
const factDeltaPct = grab('factDeltaPct');
const factIsAlert = grab('factIsAlert');
const factWindowOpen = grab('factWindowOpen');

test('actual profit subtracts real costs and planned overhead only', () => {
    assert.equal(actualTripProfit(40000, 28900, 4100), 7000);
    assert.equal(actualTripProfit(1000, 2500, 400), -1900);
    assert.equal(actualTripProfit(-1, 10, 0), null);
    assert.equal(actualTripProfit('10', '4', '1'), 5);
});

test('fact delta highlights only past the company threshold', () => {
    assert.equal(factDeltaPct(7000, 8420), (7000 - 8420) / 8420 * 100);
    assert.equal(factDeltaPct(100, 0), null);
    assert.equal(factIsAlert(7000, 8420, 10), true);
    assert.equal(factIsAlert(9000, 8420, 10), false);
    assert.equal(factIsAlert(1, 0, 10), true);
    assert.equal(factIsAlert(0, 0, 10), false);
});

test('a logist can edit fact for 30 days, then only the owner', () => {
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    assert.equal(factWindowOpen(start, start + 10 * day, false), true);
    assert.equal(factWindowOpen(start, start + 30 * day, false), true);
    assert.equal(factWindowOpen(start, start + 30 * day + 1, false), false);
    assert.equal(factWindowOpen(start, start + 90 * day, true), true);
    assert.equal(factWindowOpen('not-a-date', start, false), false);
});

test('fact is stored apart from the plan and the calculator is not called', () => {
    assert.match(migration, /NEW\.profit := NEW\.revenue - NEW\.costs - NEW\.planned_overhead/);
    assert.match(migration, /status NOT IN \('accepted', 'done'\)/);
    assert.match(migration, /interval '30 days'/);
    assert.match(migration, /overheadTotal/);
    assert.match(html, /openFactEditor/);
    assert.match(html, />Факт</);
    const saveStart = html.indexOf('async function saveTripActual');
    const saveEnd = html.indexOf('async function saveFactAlertPct');
    const saveBody = html.slice(saveStart, saveEnd);
    assert.equal(saveBody.includes('calculate('), false);
    assert.equal(saveBody.includes('/api/calculate'), false);
});
