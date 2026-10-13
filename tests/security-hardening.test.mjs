import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const migration = readFileSync(
    new URL('../supabase/migrations/20261013080000_security_hardening.sql', import.meta.url),
    'utf8'
);
const { inviteActionRateLimited, secondActiveOwnerBlocked, INVITE_RATE_LIMIT } = await import('../api/team.js');
const { poiPointsWithinLimit, POI_POINTS_LIMIT } = await import('../api/poi.js');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = end ? source.indexOf(end, from) : source.length;
    assert.equal(from >= 0, true, start);
    return source.slice(from, to === -1 ? source.length : to);
}

test('anon cannot execute the audit writer or the other definer helpers', () => {
    const audit = sliceBetween(migration, 'REVOKE ALL ON FUNCTION public.write_security_audit', 'Remaining SECURITY DEFINER');
    assert.match(audit, /FROM PUBLIC, anon, authenticated/);
    assert.match(audit, /GRANT EXECUTE ON FUNCTION public\.write_security_audit\(text, text, text, uuid, jsonb\)\s+TO service_role/);
    assert.equal(audit.includes('TO authenticated'), false);
    assert.equal(audit.includes('TO anon'), false);

    for (const name of [
        'is_platform_admin()',
        'current_is_approved()',
        'calculations_enforce_owner_and_demo_limit()',
        'audit_org_company_profiles()',
        'public.my_org_id()',
        'public.is_admin()',
        'public.enforce_demo_save_limit()'
    ]) {
        assert.match(migration, new RegExp(name.replace(/[().]/g, '\\$&')));
        assert.match(migration, /FROM PUBLIC, anon/);
    }
    assert.match(migration, /DROP FUNCTION IF EXISTS public\.handle_new_user\(\)/);
    assert.match(migration, /SET search_path = public/);
    assert.match(migration, /p\.prosecdef/);
});

test('trailer and usage policies use current_org_id and anon loses the four tables', () => {
    assert.match(migration, /DROP POLICY IF EXISTS usage_counters_select ON public\.usage_counters/);
    const policies = sliceBetween(migration, 'Policies: one org check', 'One active owner');
    assert.match(policies, /CREATE POLICY trailer_presets_all ON public\.trailer_presets/);
    assert.match(policies, /org_id = public\.current_org_id\(\)/);
    assert.equal(policies.includes('my_org_id()'), false);
    assert.equal(policies.includes('is_admin()'), false);
    for (const table of ['org_company_profiles', 'org_invites', 'route_templates', 'security_audit_log']) {
        assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon`));
    }
});

test('a second active owner is rejected in the trigger and the team API', () => {
    const guard = sliceBetween(migration, 'CREATE OR REPLACE FUNCTION public.enforce_single_active_owner', 'anon must not touch');
    assert.match(guard, /SECOND_ACTIVE_OWNER/);
    assert.match(guard, /BEFORE INSERT OR UPDATE OF org_role, member_status, org_id/);
    assert.equal(guard.includes('is_service_role'), false);
    assert.equal(secondActiveOwnerBlocked(1), true);
    assert.equal(secondActiveOwnerBlocked(0), false);
    assert.equal(secondActiveOwnerBlocked('2'), true);
});

test('poi rejects more than 25 points and invites share an hourly cap', () => {
    assert.equal(POI_POINTS_LIMIT, 25);
    assert.equal(poiPointsWithinLimit(1), true);
    assert.equal(poiPointsWithinLimit(25), true);
    assert.equal(poiPointsWithinLimit(26), false);
    assert.equal(poiPointsWithinLimit(0), false);
    assert.equal(poiPointsWithinLimit(1.5), false);
    assert.equal(INVITE_RATE_LIMIT, 10);
    assert.equal(inviteActionRateLimited(9), false);
    assert.equal(inviteActionRateLimited(10), true);
    assert.equal(inviteActionRateLimited(11), true);
});
