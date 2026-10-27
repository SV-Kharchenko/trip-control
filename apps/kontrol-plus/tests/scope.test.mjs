import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_ALLOWLIST, isAllowedOutside, outsideScope } from '../scripts/check-scope.mjs';

test('check-scope allowlist: exactly the GPS migration and its pgTAP file', () => {
    assert.equal(SCOPE_ALLOWLIST.length, 15);
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
        '404.html',
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
    assert.deepEqual(SCOPE_ALLOWLIST.slice(4, 6).map(String), [
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
        '404.html',
        'supabase/migrations/20261012240000_fleet_vehicles.sql',
        'apps/kontrol-plus-evil/x.js',
    ]), ['404.html', 'supabase/migrations/20261012240000_fleet_vehicles.sql', 'apps/kontrol-plus-evil/x.js']);
});

test('check-scope allowlist: exactly two more patterns for documents (4a), neighbours refused', () => {
    assert.deepEqual(SCOPE_ALLOWLIST.slice(6, 8).map(String), [
        String(/^supabase\/migrations\/\d{14}_kp_documents\.sql$/),
        String(/^supabase\/tests\/kp_documents\.sql$/),
    ]);
    for (const ok of ['supabase/migrations/20261026072759_kp_documents.sql', 'supabase/tests/kp_documents.sql']) {
        assert.equal(isAllowedOutside(ok), true, ok);
    }
    for (const bad of [
        'supabase/migrations/kp_documents.sql',
        'supabase/migrations/2026102607275_kp_documents.sql',
        'supabase/migrations/20261026072759_kp_documents.sql.bak',
        'supabase/migrations/20261026072759_kp_documents_v2.sql',
        'supabase/migrations/20261026072759_documents.sql',
        'supabase/migrations/x/20261026072759_kp_documents.sql',
        'supabase/tests/kp_documents.sql.orig',
        'supabase/tests/documents.sql',
        'supabase/tests/x/kp_documents.sql',
        'supabase/migrations/20261008_week2_admin_auth_audit.sql',
        'supabase/migrations/20261022091000_kontrol_plus_clients_reports.sql',
        'api/calculate.js',
        'vercel.json',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
    assert.deepEqual(outsideScope(['apps/kontrol-plus/api/docs/rate.js', 'supabase/tests/kp_documents.sql', 'lib/trip-fact.js']), ['lib/trip-fact.js']);
});

// Етап 4b: міграція й pgTAP ТТН; index.html — лише картка авто / автопарк (рішення Свята 26.10: поля ТЗ і згортуваний
// блок ТО / страхування), плюс один корінний тест цієї картки. Інші файли сайту — як і раніше, поза дозволом.
test('check-scope allowlist: exactly four more patterns for waybills (4b), neighbours refused', () => {
    assert.deepEqual(SCOPE_ALLOWLIST.slice(8, 12).map(String), [
        String(/^supabase\/migrations\/\d{14}_kp_docs_ttn\.sql$/),
        String(/^supabase\/tests\/kp_docs_ttn\.sql$/),
        String(/^index\.html$/),
        String(/^tests\/fleet-ttn-fields\.test\.mjs$/),
    ]);
    for (const ok of ['supabase/migrations/20261026130623_kp_docs_ttn.sql', 'supabase/tests/kp_docs_ttn.sql', 'index.html', 'tests/fleet-ttn-fields.test.mjs']) {
        assert.equal(isAllowedOutside(ok), true, ok);
    }
    for (const bad of [
        'index.htm',
        'x/index.html',
        'index.html.bak',
        'Index.html',
        'legal/index.html',
        'apps/other/index.html',
        'assets/bg-network.jpg',
        'assets/brand/logo-dark.svg',
        'tests/fleet-docs.test.mjs',
        'tests/fleet-ttn-fields.test.mjs.bak',
        'tests/x/fleet-ttn-fields.test.mjs',
        'tests/calc-golden.test.mjs',
        'supabase/migrations/kp_docs_ttn.sql',
        'supabase/migrations/2026102612000_kp_docs_ttn.sql',
        'supabase/migrations/20261026130623_kp_docs_ttn_v2.sql',
        'supabase/migrations/20261026130623_docs_ttn.sql',
        'supabase/tests/kp_docs_ttn.sql.orig',
        'supabase/migrations/20261012240000_fleet_vehicles.sql',
        'api/calculate.js',
        'lib/trip-fact.js',
        'vercel.json',
        '404.html',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
    assert.deepEqual(outsideScope(['index.html', 'tests/fleet-ttn-fields.test.mjs', 'tests/fleet-docs.test.mjs', 'assets/x.png']), ['tests/fleet-docs.test.mjs', 'assets/x.png']);
});

test('check-scope allowlist: trip-history tab (index.html + its root test), neighbours refused', () => {
    assert.equal(isAllowedOutside('index.html'), true);
    assert.equal(isAllowedOutside('tests/trip-history-tab.test.mjs'), true);
    assert.equal(isAllowedOutside('tests/header-menu.test.mjs'), true);
    for (const bad of [
        'index.htm',
        'x/index.html',
        'index.html.bak',
        'assets/bg-network.jpg',
        'tests/trip-history-tab.test.mjs.bak',
        'tests/x/trip-history-tab.test.mjs',
        'tests/trip-history-tab.test.js',
        'tests/trip-history.test.mjs',
        'tests/calc-golden.test.mjs',
        'tests/header-menu.test.mjs.bak',
        'tests/x/header-menu.test.mjs',
        'api/calculate.js',
        'vercel.json',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});

test('check-scope allowlist: one-page calculator (index.html + its root test), neighbours refused', () => {
    assert.equal(isAllowedOutside('index.html'), true);
    assert.equal(isAllowedOutside('tests/calc-onepage.test.mjs'), true);
    for (const bad of [
        'tests/calc-onepage.test.mjs.bak',
        'tests/x/calc-onepage.test.mjs',
        'tests/calc-onepage.test.js',
        'tests/calc-onepage-extra.test.mjs',
        'tests/calc-stepper.test.mjs',
        'tests/calc-golden.test.mjs',
        'api/calculate.js',
    ]) assert.equal(isAllowedOutside(bad), false, bad);
});
