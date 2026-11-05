// scripts/staging-seed: захист від проду, ідемпотентність, ролі, «Власний парк» увімкнений, секрети не друкуються. Мережі немає: підроблений клієнт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROD_REF, SEED_USERS, SeedError, assertStaging, emailFor, projectRef, runSeed } from '../scripts/staging-seed/seed.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SECRET = 'fake-service-role-DO-NOT-LOG';
const PASSWORD = 'Seed-Password-123456';
const STAGING = { SUPABASE_URL: 'https://stagingstagingab.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SECRET, STAGING_SEED_PASSWORD: PASSWORD, STAGING_SEED_CONFIRM: 'yes' };

test('захист: без підтвердження, без пароля, без staging-адреси — відмова; проти проду — відмова за будь-яких умов', () => {
    assert.throws(() => assertStaging({}), SeedError);
    assert.throws(() => assertStaging({ ...STAGING, STAGING_SEED_CONFIRM: '' }), /STAGING_SEED_CONFIRM/);
    assert.throws(() => assertStaging({ ...STAGING, STAGING_SEED_PASSWORD: 'short' }), /STAGING_SEED_PASSWORD/);
    assert.throws(() => assertStaging({ ...STAGING, SUPABASE_SERVICE_ROLE_KEY: '' }), /SERVICE_ROLE/);
    assert.throws(() => assertStaging({ ...STAGING, SUPABASE_URL: 'https://' + PROD_REF + '.supabase.co' }), /PRODUCTION/);
    assert.throws(() => assertStaging({ ...STAGING, SUPABASE_URL: 'https://' + PROD_REF.toUpperCase() + '.supabase.co/' }), /PRODUCTION|not set/i);
    assert.throws(() => assertStaging({ ...STAGING, VERCEL_ENV: 'production' }), /VERCEL_ENV=production/);
    const ok = assertStaging(STAGING);
    assert.equal(ok.domain, 'staging.example.com');
    assert.equal(projectRef('https://abc.supabase.co'), 'abc');
    assert.equal(PROD_REF, 'qkfqjorzsxcajcneohoy');
});

// Підроблений supabase-js: зберігає таблиці в памʼяті; рахує виклики.
function fakeClient({ missing = [] } = {}) {
    const tables = {};
    const users = [];
    const calls = { createUser: 0, rpc: [] };
    const missingErr = (t) => (missing.includes(t) ? { error: { code: '42P01', message: 'relation does not exist ' + t } } : null);
    const rows = (t) => (tables[t] ||= []);
    const matches = (row, filters) => filters.every(([k, v]) => row[k] === v);
    const from = (t) => {
        const filters = [];
        let op = null;
        let payload = null;
        let opts = null;
        const q = {
            select() { op = 'select'; return q; },
            update(p) { op = 'update'; payload = p; return q; },
            insert(p) { op = 'insert'; payload = p; return q; },
            upsert(p, o) { op = 'upsert'; payload = p; opts = o; return q; },
            eq(k, v) { filters.push([k, v]); return q; },
            async maybeSingle() { return run(); },
            then(res, rej) { return run().then(res, rej); },
        };
        async function run() {
            const gone = missingErr(t);
            if (gone) return gone;
            if (op === 'select') return { data: rows(t).find((r) => matches(r, filters)) || null, error: null };
            if (op === 'update') { rows(t).filter((r) => matches(r, filters)).forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
            if (op === 'insert') { rows(t).push({ id: t + '-' + (rows(t).length + 1), ...payload }); return { data: null, error: null }; }
            const keys = String((opts && opts.onConflict) || 'id').split(',');
            const exists = rows(t).find((r) => keys.every((k) => r[k] === payload[k]));
            if (exists) { if (!(opts && opts.ignoreDuplicates)) Object.assign(exists, payload); } else rows(t).push({ ...payload });
            return { data: null, error: null };
        }
        return q;
    };
    const client = {
        tables, users, calls, from,
        rpc: async (name, args) => { calls.rpc.push([name, args]); return { data: null, error: null }; },
        auth: { admin: {
            listUsers: async () => ({ data: { users }, error: null }),
            createUser: async (u) => {
                calls.createUser += 1;
                const user = { id: 'user-' + (users.length + 1), email: u.email };
                users.push(user);
                // тригер реєстрації створює профіль і власну організацію
                rows('profiles').push({ id: user.id, org_id: 'org-of-' + user.id, org_role: 'owner' });
                rows('organizations').push({ id: 'org-of-' + user.id, name: (u.user_metadata && u.user_metadata.company_name) || 'trial' });
                return { data: { user }, error: null };
            },
        } },
    };
    return client;
}

test('засів: демо-організація control_plus, користувачі по всіх п’яти ролях, own_fleet увімкнений (прапорець організації + app_settings)', async () => {
    const client = fakeClient();
    const logs = [];
    const out = await runSeed({ client, env: STAGING, log: (l) => logs.push(l) });
    assert.deepEqual(out.users.map((u) => u.role), ['owner', 'director', 'logist', 'repair_manager', 'requester']);
    assert.deepEqual(out.users.map((u) => u.label), ['Директор', 'Менеджер', 'Логіст', 'Відповідальний за ремонти', 'Замовник підрозділу']);
    assert.ok(out.users.every((u) => u.email.endsWith('@staging.example.com')));
    assert.equal(client.users.length, 5);
    const org = client.tables.organizations.find((o) => o.id === out.orgId);
    assert.equal(org.name, 'Demo Agro (staging)');
    assert.deepEqual(org.features, { own_fleet: true });
    assert.deepEqual(client.calls.rpc, [['set_org_plan', { p_org: out.orgId, p_plan: 'control_plus' }]]);
    const logist = client.tables.profiles.find((p) => p.id === 'user-3');
    assert.deepEqual([logist.org_id, logist.org_role, logist.member_status], [out.orgId, 'logist', 'active']);
    assert.deepEqual(client.tables.org_directors, [{ org_id: out.orgId, user_id: 'user-2' }]);
    assert.deepEqual(client.tables.org_repair_handlers, [{ org_id: out.orgId, user_id: 'user-4', kind: 'repair_manager' }]);
    assert.deepEqual(client.tables.app_settings, [{ key: 'own_fleet', enabled: true }]);
    assert.equal(client.tables.org_units.length, 2);
    assert.equal(client.tables.org_points.length, 3);
    assert.deepEqual(client.tables.org_requesters, [{ org_id: out.orgId, user_id: 'user-5' }]);
    assert.equal(client.tables.org_unit_members.length, 1);
    assert.equal(logs.some((l) => /own_fleet: 2 units/.test(l)), true);
});

test('засів ідемпотентний: другий запуск не створює дублів і користувачів', async () => {
    const client = fakeClient();
    await runSeed({ client, env: STAGING });
    const snapshot = JSON.stringify(client.tables);
    const created = client.calls.createUser;
    await runSeed({ client, env: STAGING });
    assert.equal(client.calls.createUser, created, 'існуючих користувачів не створює вдруге');
    assert.equal(JSON.stringify(client.tables), snapshot, 'таблиці не змінилися');
});

test('засів: без міграцій «Власного парку» / вимикача — пропускає ці кроки з нотаткою, а не падає', async () => {
    const client = fakeClient({ missing: ['org_units', 'org_points', 'org_requesters', 'org_unit_members', 'app_settings'] });
    const logs = [];
    const out = await runSeed({ client, env: STAGING, log: (l) => logs.push(l) });
    assert.ok(out.orgId);
    assert.equal(logs.some((l) => /app_settings: table is missing/.test(l)), true);
    assert.equal(logs.some((l) => /own_fleet: tables are missing/.test(l)), true);
});

test('секрети: пароль і service role не потрапляють у журнал, результат і помилки; продових даних у скрипті немає', async () => {
    const client = fakeClient();
    const logs = [];
    const out = await runSeed({ client, env: STAGING, log: (l) => logs.push(l) });
    const everything = logs.join('\n') + JSON.stringify(out);
    for (const secret of [PASSWORD, SECRET]) assert.equal(everything.includes(secret), false);
    const failing = fakeClient();
    failing.auth.admin.createUser = async () => ({ data: null, error: { code: 'weak_password', message: 'Password ' + PASSWORD + ' is weak' } });
    await assert.rejects(runSeed({ client: failing, env: STAGING }), (error) => error instanceof SeedError && !error.message.includes(PASSWORD) && /weak_password/.test(error.message));
    const sources = read('scripts/staging-seed/seed.mjs') + read('scripts/staging-seed/index.mjs');
    assert.equal(/sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{20}/.test(sources), false, 'жодних ключів у коді');
    assert.equal(/console[.]\w+[(][^)]*process[.]env/.test(read('scripts/staging-seed/index.mjs')), false, 'index.mjs не друкує значення env');
    assert.deepEqual(SEED_USERS.map((u) => emailFor(u.key, 'x.test')), ['owner@x.test', 'director@x.test', 'logist@x.test', 'repair@x.test', 'requester@x.test']);
});
