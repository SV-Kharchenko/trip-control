// «Власний парк», етап 1: поза apps/kontrol-plus/ додано дозвіл лише на міграції, їхні pgTAP-тести й один корінний тест; сайт цією гілкою не чіпається.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_ALLOWLIST, isAllowedOutside } from '../scripts/check-scope.mjs';

test('check-scope allowlist: «Власний парк» — міграція + виправлення, їхні pgTAP і один корінний тест (рекурсивний обхід views/), сусіди закриті', () => {
    assert.equal(String(SCOPE_ALLOWLIST.at(-3)), String(/^tests\/idle-label\.test\.mjs$/));
    assert.equal(isAllowedOutside('tests/idle-label.test.mjs'), true);
    assert.equal(isAllowedOutside('tests/idle-label.test.mjs.bak'), false);
    assert.deepEqual(SCOPE_ALLOWLIST.slice(-2).map(String), [
        String(/^supabase\/migrations\/\d{14}_own_fleet(_fixes)?\.sql$/),
        String(/^supabase\/tests\/own_fleet(_fixes)?\.sql$/),
    ]);
    for (const ok of [
        'supabase/migrations/20261120090000_own_fleet.sql', 'supabase/migrations/20261121090000_own_fleet_fixes.sql',
        'supabase/tests/own_fleet.sql', 'supabase/tests/own_fleet_fixes.sql',
    ]) assert.equal(isAllowedOutside(ok), true, ok);
    for (const bad of [
        'supabase/migrations/own_fleet.sql',
        'supabase/migrations/20261120090000_own_fleet_extra.sql',
        'supabase/migrations/20261121090000_own_fleet_fixes_extra.sql',
        'supabase/migrations/20261120090000_own_fleet.sql.bak',
        'supabase/migrations/x/20261120090000_own_fleet.sql',
        'supabase/tests/own_fleet.sql.orig',
        'supabase/tests/own_fleet_other.sql',
        'docs/SECRETS.md',
        'api/team.js',
        'tests/own-fleet.test.mjs',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});
