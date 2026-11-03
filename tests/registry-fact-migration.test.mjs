// registry_totals: прибуток факт = факт, інакше план; fact_count (міграція 20261115090000_registry_fact_fallback.sql).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20261115090000_registry_fact_fallback.sql');

test('міграція: coalesce(факт, план) без скасованих, fact_count, перевірки доступу й INVOKER збережені, відкат повертає попередню версію', () => {
    assert.ok(migration.startsWith('-- Apply manually after review. This file is not applied to production by the agent.'));
    for (const part of [
        "coalesce(sum(coalesce(ta.profit, c.profit)) FILTER (WHERE c.status <> 'cancelled'), 0)::numeric",
        "(count(ta.id) FILTER (WHERE c.status <> 'cancelled'))::bigint", 'fact_count bigint',
        'DROP FUNCTION IF EXISTS public.registry_totals(jsonb);', 'CREATE FUNCTION public.registry_totals',
        'SECURITY INVOKER', "RAISE EXCEPTION 'REGISTRY_FORBIDDEN' USING ERRCODE = '42501';", 'NOT public.can_view_org(v_org)', "v_org := nullif(f ->> 'org_id', '')::uuid;",
        'GRANT EXECUTE ON FUNCTION public.registry_totals(jsonb) TO authenticated, service_role;']) assert.ok(migration.includes(part), part);
    assert.equal(/SECURITY DEFINER/.test(migration.slice(migration.indexOf('CREATE FUNCTION'))), false);
    const head = migration.slice(migration.indexOf('-- РУЧНИЙ ВІДКАТ'), migration.indexOf('\nBEGIN;\n'));
    assert.ok(head.includes('DROP FUNCTION IF EXISTS public.registry_totals(jsonb);'));
    assert.ok(head.includes('20261114090000_registry_directors.sql'));
    assert.ok(head.indexOf('DROP FUNCTION') < head.indexOf('GRANT EXECUTE'));
});

test('pgTAP registry_totals: немає факту, частковий, повний, скасовані не входять (8 перевірок)', () => {
    const tap = read('supabase/tests/registry_totals_fact.sql');
    assert.match(tap, /SELECT plan\(8\)/);
    assert.equal(tap.split('\n').filter((line) => /^SELECT is\(/.test(line)).length, 8);
    for (const expected of ["'2/0/300/300/0'", "'2/0/400/380/1'", "'2/0/300/340/2'", "'2/1/100/70/1'", "'1100/1090/4'", "'42501'"]) assert.ok(tap.includes(expected), expected);
});
