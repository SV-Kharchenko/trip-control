import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const migration = readFileSync(new URL('../supabase/migrations/20261016130000_user_block_rls.sql', import.meta.url), 'utf8');
const pgtap = readFileSync(new URL('../supabase/tests/user_block.sql', import.meta.url), 'utf8');

test('is_user_blocked() is a stable security definer with a fixed search_path', () => {
    const fn = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.is_user_blocked()'), migration.indexOf('COMMENT ON FUNCTION public.is_user_blocked()'));
    assert.match(fn, /STABLE/);
    assert.match(fn, /SECURITY DEFINER/);
    assert.match(fn, /SET search_path = ''/);
    assert.match(fn, /auth\.users/);
    assert.match(fn, /banned_until > now\(\)/);
    assert.match(fn, /auth\.uid\(\)/);
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.is_user_blocked\(\) FROM PUBLIC, anon;/);
});

test('every user-written table gets restrictive insert, update and delete policies', () => {
    for (const table of ['calculations', 'calc_vehicles', 'route_templates', 'trip_actuals', 'fleet_vehicles', 'trailer_presets',
        'company_settings', 'org_company_profiles', 'org_invites', 'weekly_reports', 'usage_counters', 'organizations', 'profiles']) {
        assert.match(migration, new RegExp("'" + table + "'"), table);
    }
    assert.match(migration, /FROM pg_policies AS p/);
    for (const cmd of ['insert', 'update', 'delete']) {
        assert.match(migration, new RegExp("DROP POLICY IF EXISTS %I ON public\.%I', tbl \|\| '_not_blocked_" + cmd + "'"));
        assert.match(migration, new RegExp('AS RESTRICTIVE FOR ' + cmd.toUpperCase() + ' TO authenticated'));
    }
    assert.match(migration, /NOT \(SELECT public\.is_user_blocked\(\)\)/);
    assert.equal(/FOR SELECT/.test(migration), false);
    assert.match(migration, /RAISE EXCEPTION 'USER_BLOCKED'/);
    assert.match(migration, /trg_protect_profile_privileges/);
});

test('pgTAP covers blocked and active inserts into calculations', () => {
    assert.match(pgtap, /'blocked user cannot insert into calculations'/);
    assert.match(pgtap, /'active user inserts into calculations'/);
    assert.match(pgtap, /'user cannot change own role'/);
    assert.match(pgtap, /'user cannot change own is_approved'/);
});

test('blocked user gets an error on insert into calculations, active user does not (PGlite)', (t) => {
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const script = fileURLToPath(new URL('../scripts/check-user-block-rls.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS blocked: INSERT calculations fails \(42501\)/);
    assert.match(run.stdout, /PASS active: INSERT calculations succeeds/);
});

test('Telegram reads exactly TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID', async () => {
    const notify = await import('../lib/signup-notify.js');
    assert.deepEqual(notify.telegramConfig({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '42' }), { token: '1:a', chatId: '42' });
    assert.equal(notify.telegramConfig({ TG_BOT_TOKEN: '1:a', TG_CHAT_ID: '42' }), null);
    assert.equal(notify.telegramConfig({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_OWNER_CHAT_ID: '42' }), null);
});
