import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_ALLOWLIST, isAllowedOutside, outsideScope } from '../scripts/check-scope.mjs';

test('check-scope allowlist: exactly the GPS migration and its pgTAP file', () => {
    assert.equal(SCOPE_ALLOWLIST.length, 2);
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
