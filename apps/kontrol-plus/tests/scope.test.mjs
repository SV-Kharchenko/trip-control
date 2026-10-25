import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_ALLOWLIST, isAllowedOutside, outsideScope } from '../scripts/check-scope.mjs';

test('check-scope allowlist: exactly the GPS migration and its pgTAP file', () => {
    assert.equal(SCOPE_ALLOWLIST.length, 6);
    for (const ok of ['supabase/migrations/20261024111415_gps_integrations.sql', 'supabase/tests/gps_integrations.sql']) {
        assert.equal(isAllowedOutside(ok), true, ok);
    }
    for (const bad of [
        'supabase/migrations/20261023091124_trip_fact_v2.sql',
        'supabase/migrations/gps_integrations.sql',
        'supabase/migrations/2026102409000_gps_integrations.sql',
        'supabase/migrations/20261024111415_gps_integrations.sql.bak',
        'supabase/migrations/20261024111415_gps_integrations_extra.sql',
        'supabase/migrations/x/20261024111415_gps_integrations.sql',
        'supabase/tests/kontrol_plus.sql',
        'supabase/tests/gps_integrations.sql.orig',
        'docs/SECRETS.md',
        'index.html',
        'api/calculate.js',
        'vercel.json',
        'package.json',
        'apps/other/x.js',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});

test('check-scope allowlist: exactly two more patterns for repairs (3a), neighbours refused', () => {
    assert.deepEqual(SCOPE_ALLOWLIST.slice(2, 4).map(String), [
        String(/^supabase\/migrations\/\d{14}_repairs_stock\.sql$/),
        String(/^supabase\/tests\/repairs_stock\.sql$/),
    ]);
    for (const ok of ['supabase/migrations/20261024150255_repairs_stock.sql', 'supabase/tests/repairs_stock.sql']) {
        assert.equal(isAllowedOutside(ok), true, ok);
    }
    for (const bad of [
        'supabase/migrations/repairs_stock.sql',
        'supabase/migrations/2026102509000_repairs_stock.sql',
        'supabase/migrations/20261025090000_repairs_stock.sql.bak',
        'supabase/migrations/20261025090000_repairs_stock_v2.sql',
        'supabase/migrations/20261025090000_repairs.sql',
        'supabase/migrations/x/20261025090000_repairs_stock.sql',
        'supabase/tests/repairs_stock.sql.orig',
        'supabase/tests/repairs.sql',
        'supabase/tests/x/repairs_stock.sql',
        'api/repairs/invites.js',
        'lib/invite-mail.js',
        'api/team.js',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});

test('check-scope allowlist: exactly two more patterns for maintenance (3b), neighbours refused', () => {
    assert.deepEqual(SCOPE_ALLOWLIST.slice(4).map(String), [
        String(/^supabase\/migrations\/\d{14}_repairs_maintenance\.sql$/),
        String(/^supabase\/tests\/repairs_maintenance\.sql$/),
    ]);
    for (const ok of ['supabase/migrations/20261024232246_repairs_maintenance.sql', 'supabase/tests/repairs_maintenance.sql']) {
        assert.equal(isAllowedOutside(ok), true, ok);
    }
    for (const bad of [
        'supabase/migrations/repairs_maintenance.sql',
        'supabase/migrations/2026102609000_repairs_maintenance.sql',
        'supabase/migrations/20261026090000_repairs_maintenance.sql.bak',
        'supabase/migrations/20261026090000_repairs_maintenance_v2.sql',
        'supabase/migrations/20261026090000_maintenance.sql',
        'supabase/migrations/x/20261026090000_repairs_maintenance.sql',
        'supabase/tests/repairs_maintenance.sql.orig',
        'supabase/tests/maintenance.sql',
        'supabase/tests/x/repairs_maintenance.sql',
        'supabase/migrations/20261013190000_calc_vehicles.sql',
        'supabase/migrations/20261023091124_trip_fact_v2.sql',
        'lib/trip-fact.js',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});

test('check-scope: everything outside apps/kontrol-plus/ and the allowlist is reported', () => {
    assert.deepEqual(outsideScope([
        'apps/kontrol-plus/src/views/gps.js',
        'supabase/migrations/20261024111415_gps_integrations.sql',
        'supabase/tests/gps_integrations.sql',
        'index.html',
        'supabase/migrations/20261012240000_fleet_vehicles.sql',
        'apps/kontrol-plus-evil/x.js',
    ]), ['index.html', 'supabase/migrations/20261012240000_fleet_vehicles.sql', 'apps/kontrol-plus-evil/x.js']);
});
