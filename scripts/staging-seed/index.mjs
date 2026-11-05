// node scripts/staging-seed/index.mjs — засів STAGING-бази Supabase (див. docs/STAGING.md).
// Env (лише staging!): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STAGING_SEED_PASSWORD (≥12 символів, спільний для тестових акаунтів),
// STAGING_SEED_CONFIRM=yes; необовʼязково STAGING_SEED_DOMAIN (за замовчуванням staging.example.com).
// Проти продового проєкту скрипт відмовляється працювати. Паролі й ключі не друкуються.
import { createClient } from '@supabase/supabase-js';
import { SeedError, assertStaging, runSeed } from './seed.mjs';

async function main() {
    const { url } = assertStaging(process.env);
    const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const result = await runSeed({ client, env: process.env, log: (line) => console.log(line) });
    console.log('\nГотово. Демо-організація: ' + result.orgId);
    console.log('Тестові акаунти (пароль — STAGING_SEED_PASSWORD):');
    for (const u of result.users) console.log('  ' + u.label.padEnd(26) + u.email);
}

main().catch((error) => {
    console.error(error instanceof SeedError ? 'staging-seed: ' + error.message : 'staging-seed: unexpected error');
    process.exit(1);
});
