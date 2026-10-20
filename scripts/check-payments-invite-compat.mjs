// Runs every check of scripts/check-invite-flow.mjs (accept_org_invite, starter template,
// old template, seats) with org_has_user_data as redefined by
// supabase/migrations/20261018190000_payments.sql: the starter migration, then the payments
// migration on top (both twice, as the invite check does). PGlite, in memory; nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-payments-invite-compat.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (name) => fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const inviteMigration = new URL('../supabase/migrations/20261017090000_invite_flow.sql', import.meta.url);

// Helpers the payments migration needs that the invite stub schema does not have (as in production).
const stubs = `
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.org_id FROM public.profiles AS p JOIN public.organizations AS o ON o.id = p.org_id
  WHERE p.id = auth.uid() AND p.member_status = 'active' AND o.status <> 'blocked' LIMIT 1 $$;
CREATE OR REPLACE FUNCTION public.is_org_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = auth.uid() AND p.org_role = 'owner') $$;
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pay-compat-'));
const combined = path.join(dir, 'starter-then-payments.sql');
fs.writeFileSync(combined, read('20261017130000_starter_defaults_user_data.sql') + '\n' + stubs + '\n' + read('20261018190000_payments.sql'));

const script = new URL('./check-invite-flow.mjs', import.meta.url);
const run = spawnSync(process.execPath, [fileURLToPath(script), fileURLToPath(inviteMigration), combined], {
    encoding: 'utf8'
});
fs.rmSync(dir, { recursive: true, force: true });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');

const fails = (run.stdout.match(/^FAIL /gm) || []).length;
const passes = (run.stdout.match(/^PASS /gm) || []).length;
if (run.status !== 0 || fails || !passes) {
    console.log('payments + invite-flow: FAILED (exit ' + run.status + ', ' + fails + ' failed)');
    process.exit(1);
}
console.log('payments + invite-flow: all ' + passes + ' invite-flow checks passed with the payments org_has_user_data');
