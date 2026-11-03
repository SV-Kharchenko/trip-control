// Директори Контроль+ (org_directors) бачать реєстр і заявки компанії: міграція 20261114090000, параметр org_id у filters, міст КП.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const migration = read('supabase/migrations/20261114090000_registry_directors.sql');

function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}
const ORG = '70000000-0000-4000-8000-00000000000a';
const world = (extra = {}) => {
    const ctx = vm.createContext({ currentWorkMode: 'team', isKP: () => true, window: { tcKpRole: 'director', tcKpOrgId: ORG }, ...extra });
    vm.runInContext('const REGISTRY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;\n' + fnSource('kpDirectorActive') + '\n' + fnSource('registryFiltersToJson'), ctx);
    return ctx;
};
const json = (ctx, filters) => JSON.parse(vm.runInContext('JSON.stringify(registryFiltersToJson(' + JSON.stringify(filters) + '))', ctx));
const F = { from: '2026-11-01', to: '2026-11-30', status: '', user: '', vehicle: '', client: '', q: '' };

test('org_id у filters: директор КП шле компанію з kp_context(); власник, логіст, сайт і директор без org — без org_id', () => {
    assert.deepEqual(json(world(), F), { from: '2026-11-01', to: '2026-11-30', org_id: ORG });
    assert.equal('org_id' in json(world({ window: { tcKpRole: 'owner', tcKpOrgId: ORG } }), F), false, 'власник: за замовчуванням current_org_id()');
    assert.equal('org_id' in json(world({ window: { tcKpRole: 'logist', tcKpOrgId: ORG } }), F), false);
    assert.equal('org_id' in json(world({ isKP: () => false }), F), false, 'сайт: директорів немає');
    assert.equal('org_id' in json(world({ window: { tcKpRole: 'director', tcKpOrgId: null } }), F), false, 'контекст ще не завантажено');
    assert.equal('org_id' in json(world({ window: { tcKpRole: 'director', tcKpOrgId: 'not-a-uuid' } }), F), false, 'лише uuid');
});

test('міст Контроль+ передає роль і компанію з kp_context() на сторінку сайту та скидає їх при виході', () => {
    const bridge = read('apps/kontrol-plus/src/bridge.js');
    assert.ok(bridge.includes('window.tcKpOrgId = state.context.org_id || null;'));
    assert.ok(bridge.includes('window.tcKpRole = state.context.role || null;'));
    assert.equal((bridge.match(/window\.tcKpOrgId = null;/g) || []).length, 3, 'скидається там само, де state.context = null');
});

test('міграція: can_view_org, org_id у filters, SELECT-політики директора, INVOKER, відкат у правильному порядку', () => {
    assert.ok(migration.startsWith('-- Apply manually after review. This file is not applied to production by the agent.'));
    const helper = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.can_view_org'), migration.indexOf('-- SELECT для директора'));
    for (const part of ['SECURITY DEFINER', 'SET search_path = public', 'p_org = public.current_org_id() OR public.kp_is_org_director(p_org)',
        'REVOKE ALL ON FUNCTION public.can_view_org(uuid) FROM PUBLIC, anon, authenticated, service_role;', 'GRANT EXECUTE ON FUNCTION public.can_view_org(uuid) TO authenticated, service_role;']) assert.ok(helper.includes(part), part);
    for (const policy of ['calculations_select_director', 'trip_actuals_select_director', 'calc_vehicles_select_director', 'calculation_clients_select_director',
        'clients_select_director', 'fleet_vehicles_select_director']) {
        assert.ok(migration.includes('CREATE POLICY ' + policy), policy);
    }
    // Чернетки й відхилені логістів директору не видно; лише читання; клієнти й авто — через kp_is_org_director.
    assert.ok(migration.includes("USING (public.kp_is_org_director(org_id) AND status IN ('pending', 'accepted', 'done', 'cancelled'));"));
    for (const table of ['clients', 'fleet_vehicles']) {
        const policy = migration.slice(migration.indexOf('CREATE POLICY ' + table + '_select_director ON public.' + table));
        assert.ok(policy.startsWith('CREATE POLICY'), table);
        assert.match(policy.split(';')[0].replace(/\s+/g, ' '), /FOR SELECT TO authenticated USING \(public\.kp_is_org_director\(org_id\)\)$/, table);
    }
    assert.equal(/CREATE POLICY[^;]*FOR (UPDATE|INSERT|DELETE|ALL)/.test(migration), false, 'UPDATE / INSERT / DELETE не розширюються');
    assert.equal(/DROP POLICY IF EXISTS (calculations_select_role|trip_actuals_select|calc_vehicles_select_role|calculation_clients_select) /.test(migration.slice(migration.indexOf('\nBEGIN;\n'))), false, 'наявні політики не чіпаємо');
    assert.equal((migration.match(/v_org := nullif\(f ->> 'org_id', ''\)::uuid;/g) || []).length, 2, 'registry_list і registry_totals');
    assert.equal((migration.match(/WHERE c\.org_id = v_org/g) || []).length, 2);
    assert.equal((migration.match(/NOT public\.can_view_org\(v_org\)/g) || []).length, 2);
    assert.equal(/SECURITY DEFINER[\s\S]{0,200}registry_(list|totals)/.test(migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.registry_list'))), false);
    assert.ok(migration.includes('SECURITY INVOKER'));
    // «РУЧНИЙ ВІДКАТ»: спершу політики, потім функції (одна транзакція).
    const head = migration.slice(migration.indexOf('-- РУЧНИЙ ВІДКАТ'), migration.indexOf('\nBEGIN;\n'));
    const at = (text) => { const i = head.indexOf(text); assert.ok(i >= 0, text); return i; };
    const policies = ['DROP POLICY IF EXISTS fleet_vehicles_select_director', 'DROP POLICY IF EXISTS clients_select_director', 'DROP POLICY IF EXISTS calculation_clients_select_director', 'DROP POLICY IF EXISTS calc_vehicles_select_director',
        'DROP POLICY IF EXISTS trip_actuals_select_director', 'DROP POLICY IF EXISTS calculations_select_director'].map(at);
    const functions = [at('registry_list(jsonb, integer, integer) і registry_totals(jsonb) назад'), at('DROP FUNCTION IF EXISTS public.can_view_org(uuid);')];
    for (const p of policies) for (const fn of functions) assert.ok(p < fn, 'політики раніше функцій');
    assert.ok(at('BEGIN;') < policies[0] && at('COMMIT;') > functions[1]);
    assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.registry_list(jsonb, integer, integer) TO authenticated, service_role;'), 'гранти RPC як були');
});

test('pgTAP директорів: 26 перевірок (власна компанія, статуси, clients / fleet_vehicles лише читання, чужа, company-тариф, UPDATE, логіст і власник без змін, зниження тарифу)', () => {
    const tap = read('supabase/tests/registry_directors.sql');
    assert.match(tap, /SELECT plan\(26\)/);
    assert.equal(tap.split('\n').filter((line) => /^SELECT (is|ok|results_eq|throws_ok)\(/.test(line)).length, 26);
    for (const part of ['registry_totals', "'42501'", 'can_view_org', 'set_org_plan', 'control_plus', 'org_directors']) assert.ok(tap.includes(part), part);
});
