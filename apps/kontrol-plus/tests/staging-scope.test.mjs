// Staging і глобальний вимикач: поза apps/kontrol-plus/ дозволені лише названі файли (конфіг середовища, засів, документація, міграція й тести).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_ALLOWLIST, isAllowedOutside } from '../scripts/check-scope.mjs';

test('check-scope allowlist: рівно дев’ять шаблонів для staging / вимикача, сусіди закриті', () => {
    assert.equal(SCOPE_ALLOWLIST.slice(-12, -3).map(String).length, 9, 'дев’ять шаблонів стоять перед хвостом #128 (idle-label, own_fleet)');
    for (const ok of [
        'api/config.js', 'lib/public-config.js', 'docs/STAGING.md', 'scripts/staging-seed/seed.mjs', 'scripts/staging-seed/index.mjs',
        'tests/public-config.test.mjs', 'tests/staging-seed.test.mjs', 'tests/security-grants.test.mjs', 'tests/osm-geo.test.mjs',
        'supabase/migrations/20261122090000_app_settings_kill_switch.sql', 'supabase/tests/app_settings.sql',
    ]) assert.equal(isAllowedOutside(ok), true, ok);
    for (const bad of [
        'api/config.mjs', 'api/config.js.bak', 'api/admin.js', 'lib/public-config.mjs', 'lib/rate-limit.js', 'docs/STAGING.md.bak', 'docs/SECRETS.md',
        'scripts/staging-seed/other.mjs', 'scripts/staging-seed/x/seed.mjs', 'tests/public-config.test.mjs.bak', 'tests/calc-golden.test.mjs',
        'supabase/migrations/20261122090000_app_settings_kill_switch_extra.sql', 'supabase/migrations/app_settings_kill_switch.sql', 'supabase/tests/app_settings.sql.orig',
        'vercel.json', 'sw.js', '.env', '.env.preview',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});
