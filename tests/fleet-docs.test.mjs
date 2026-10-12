import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(
    new URL('../supabase/migrations/20261012240000_fleet_vehicles.sql', import.meta.url),
    'utf8'
);

function grab(name) {
    const match = html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n    \\}'));
    assert.ok(match, name + ' is missing from index.html');
    const args = match[0].slice(match[0].indexOf('(') + 1, match[0].indexOf(')'));
    return new Function(...args.split(',').map((part) => part.trim()).filter(Boolean), match[1]);
}

const kyivTodayYmd = grab('kyivTodayYmd');
const fleetDaysLeft = grab('fleetDaysLeft');
const fleetWarnDays = grab('fleetWarnDays');
globalThis.fleetDaysLeft = fleetDaysLeft;
globalThis.fleetWarnDays = fleetWarnDays;
const fleetDocState = grab('fleetDocState');

test('document dates are counted in Kyiv calendar days', () => {
    assert.equal(kyivTodayYmd(new Date('2026-10-11T22:30:00Z')), '2026-10-12');
    assert.equal(fleetDaysLeft('2026-10-20', '2026-10-12'), 8);
    assert.equal(fleetDaysLeft('2026-09-01', '2026-10-12'), -41);
    assert.equal(fleetDaysLeft('2026-10-12', '2026-10-12'), 0);
    assert.equal(fleetDaysLeft('', '2026-10-12'), null);
    assert.equal(fleetDaysLeft('20.10.2026', '2026-10-12'), null);
});

test('a missing date is empty, today and the warn window are soon, later is ok', () => {
    assert.equal(fleetWarnDays(undefined), 30);
    assert.equal(fleetWarnDays(0), 30);
    assert.equal(fleetWarnDays(14), 14);
    assert.equal(fleetDocState('', '2026-10-12', 30), 'empty');
    assert.equal(fleetDocState('2026-09-01', '2026-10-12', 30), 'overdue');
    assert.equal(fleetDocState('2026-10-12', '2026-10-12', 30), 'soon');
    assert.equal(fleetDocState('2026-10-20', '2026-10-12', 30), 'soon');
    assert.equal(fleetDocState('2026-11-15', '2026-10-12', 30), 'ok');
    assert.equal(fleetDocState('2026-10-20', '2026-10-12', 7), 'ok');
});

test('fleet documents are an optional cabinet tab and do not touch the calculator', () => {
    assert.match(html, /data-panel="docs"/);
    assert.match(html, /ОСЦПВ/);
    assert.match(html, /Зелена карта/);
    assert.match(html, /Тахограф/);
    const hint = html.match(/id="auth-email-hint">([^<]*)</);
    assert.equal(hint && hint[1], 'Сюди надсилатимемо службові листи.');
    const auth = html.slice(html.indexOf('id="auth-form"'), html.indexOf('id="auth-recovery-form"'));
    assert.equal(auth.includes('ОСЦПВ'), false);
    const body = html.slice(html.indexOf('async function addFleetVehicle'), html.indexOf('function showWeeklyReportText'));
    assert.ok(body.length > 200);
    assert.equal(body.includes('calculate('), false);
    assert.equal(body.includes('/api/calculate'), false);
    assert.match(migration, /FLEET_FORBIDDEN/);
    assert.match(migration, /FLEET_LIMIT/);
    assert.match(migration, /v_count >= 100/);
    assert.match(migration, /is_org_owner\(\)/);
    assert.match(migration, /REVOKE ALL ON TABLE public\.fleet_vehicles FROM PUBLIC, anon, authenticated/);
    assert.equal(migration.includes('calculations'), false);
    assert.equal(migration.includes('overheadTotal'), false);
});
