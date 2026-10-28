// Контроль+ (Етап 1): перевірка міграцій на справжньому Postgres (PGlite, у пам'яті). Supabase не чіпає.
// Усі міграції репозиторію по черзі на заглушці базової схеми прод (таблиці до репо, ролі й default privileges
// Supabase), потім 20261022090000 / 20261022091000 (двічі — ідемпотентність), пізніші міграції і GPS-міграція
// етапу 2a (двічі, на заглушці схеми vault — лише в цьому тесті) і сценарії від імені authenticated / service_role.
//
//   npm i --no-save @electric-sql/pglite@0.2.17   (у корені репозиторію)
//   node apps/kontrol-plus/db/check-db.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const OURS = ['20261022090000_kontrol_plus_access.sql', '20261022091000_kontrol_plus_clients_reports.sql'];
const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const before = all.filter((f) => f < OURS[0]);
const GPS = all.find((f) => /^\d{14}_gps_integrations\.sql$/.test(f));
const later = all.filter((f) => f > OURS[1] && f !== GPS);
if (!GPS) throw new Error('немає міграції *_gps_integrations.sql');
const db = new PGlite();

await db.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb, banned_until timestamptz, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
  status text NOT NULL DEFAULT 'active', default_tax_mode text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.profiles (id uuid PRIMARY KEY, org_id uuid REFERENCES public.organizations (id), email text,
  role text NOT NULL DEFAULT 'user', is_approved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.company_settings (org_id uuid PRIMARY KEY REFERENCES public.organizations (id), settings jsonb,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.calculations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, org_id uuid, name text,
  inputs jsonb, results jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.usage_counters (org_id uuid NOT NULL, day date NOT NULL, calc_count integer NOT NULL DEFAULT 0);
CREATE TABLE public.trailer_presets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, name text);
CREATE FUNCTION public.my_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT org_id FROM public.profiles WHERE id = auth.uid() $$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT coalesce((SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()), false) $$;
CREATE FUNCTION public.enforce_demo_save_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS
  $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.ua_today() RETURNS date LANGUAGE sql STABLE AS
  $$ SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date $$;
`);

let failed = 0;
function check(ok, label, extra) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !extra ? '' : ' — ' + extra));
    if (!ok) failed += 1;
}
for (const file of before) await db.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
for (const file of OURS) {
    const sql = fs.readFileSync(new URL(file, DIR), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
}
check(true, 'all ' + before.length + ' earlier migrations + both Контроль+ migrations (twice) applied');
// Заглушка схеми Supabase Storage (лише в цьому тесті; на проді storage.buckets / storage.objects уже є, RLS на objects
// увімкнено, а anon / authenticated мають гранти — доступ вирішують політики). Потрібна міграції документів (етап 4a).
await db.exec(`
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, owner uuid, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets (id),
  name text NOT NULL, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (bucket_id, name));
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
`);
for (const file of later) await db.exec(fs.readFileSync(new URL(file, DIR), 'utf8'));
// Ремонти і склад (етап 3a): другий прогін — ідемпотентність.
const REPAIRS = all.find((f) => /^\d{14}_repairs_stock\.sql$/.test(f));
if (!REPAIRS) throw new Error('немає міграції *_repairs_stock.sql');
const repairsSql = fs.readFileSync(new URL(REPAIRS, DIR), 'utf8');
await db.exec(repairsSql);
check(/^-- Apply manually after review\. This file is not applied to production by the agent\./.test(repairsSql)
    && !repairsSql.split('\n').some((line) => !/^\s*--/.test(line) && /CREATE EXTENSION/i.test(line)),
'repairs: ' + REPAIRS + ' applied twice (idempotent), manual-apply header, no CREATE EXTENSION');
// ТО і вартість на км (етап 3b): після повторного 3a (він повертає старі kp_repair_invite_reserve / kp_user_has_own_kp) —
// ще двічі поспіль: ідемпотентність і остаточні версії хвостів 3a.
const MAINT = all.find((f) => /^\d{14}_repairs_maintenance\.sql$/.test(f));
if (!MAINT) throw new Error('немає міграції *_repairs_maintenance.sql');
const maintSql = fs.readFileSync(new URL(MAINT, DIR), 'utf8');
await db.exec(maintSql);
await db.exec(maintSql);
check(MAINT > REPAIRS && /^-- Apply manually after review\. This file is not applied to production by the agent\./.test(maintSql)
    && !maintSql.split('\n').some((line) => !/^\s*--/.test(line) && /CREATE EXTENSION/i.test(line)),
'maintenance: ' + MAINT + ' (after ' + REPAIRS + ') applied twice in a row (idempotent), manual-apply header, no CREATE EXTENSION');
// Документи (етап 4a): уже застосовано в later; ще двічі поспіль — ідемпотентність (бакет і політики Storage теж).
const DOCS = all.find((f) => /^\d{14}_kp_documents\.sql$/.test(f));
if (!DOCS) throw new Error('немає міграції *_kp_documents.sql');
const docsSql = fs.readFileSync(new URL(DOCS, DIR), 'utf8');
await db.exec(docsSql);
await db.exec(docsSql);
check(DOCS > MAINT && /^-- Apply manually after review\. This file is not applied to production by the agent\./.test(docsSql)
    && !docsSql.split('\n').some((line) => !/^\s*--/.test(line) && /CREATE EXTENSION/i.test(line)),
'documents: ' + DOCS + ' (after ' + MAINT + ') applied three times (idempotent), manual-apply header, no CREATE EXTENSION');
const bucket = await one(`SELECT public, file_size_limit, allowed_mime_types::text AS mimes, (SELECT count(*)::int FROM storage.buckets) AS n FROM storage.buckets WHERE id = 'kp-doc-assets'`);
check(bucket && bucket.public === false && Number(bucket.file_size_limit) === 524288 && bucket.mimes === '{image/png,image/jpeg}' && bucket.n === 1,
    'documents: private bucket kp-doc-assets (512 KB, PNG / JPEG) created once', JSON.stringify(bucket));
const storagePolicies = (await db.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'storage' ORDER BY 1`)).rows.map((r) => r.policyname);
check(storagePolicies.join(',') === 'kp_doc_assets_delete,kp_doc_assets_insert,kp_doc_assets_select,kp_doc_assets_update',
    'documents: exactly four own storage.objects policies', storagePolicies.join(','));
// Нумерація: рядок лічильника блокується до кінця транзакції (INSERT … ON CONFLICT DO UPDATE … RETURNING) — у PGlite
// одне зʼєднання, тож паралельність перевіряємо за кодом функції; послідовні виклики — у pgTAP.
const allocDef = (await one(`SELECT pg_get_functiondef('public.kp_doc_alloc_number(uuid, text, integer, integer)'::regprocedure) AS d`)).d;
check(/ON CONFLICT \(org_id, kind, year\) DO UPDATE SET next_no = c\.next_no \+ 1/.test(allocDef) && /RETURNING c\.next_no - 1/.test(allocDef),
    'documents: numbering takes the counter row lock (ON CONFLICT DO UPDATE … RETURNING)');
// ТТН (етап 4b): уже застосовано в later; ще двічі поспіль — ідемпотентність. Функції й таблиці 4a — без змін.
const TTN = all.find((f) => /^\d{14}_kp_docs_ttn\.sql$/.test(f));
if (!TTN) throw new Error('немає міграції *_kp_docs_ttn.sql');
const ttnSql = fs.readFileSync(new URL(TTN, DIR), 'utf8');
const fnDefs = async (names) => (await db.query(`SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS h FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY 1`, [names])).rows.map((r) => r.f + ':' + r.h).join(',');
const DOCS_FNS = ['kp_doc_create', 'kp_doc_cancel', 'kp_doc_list', 'kp_doc_get', 'kp_doc_alloc_number', 'kp_docs_org', 'kp_doc_next_number',
    'kp_org_id', 'kp_role', 'kp_can_write', 'kp_context', 'kp_trips'];
await db.exec(docsSql);
const docsFnsBefore = await fnDefs(DOCS_FNS);
await db.exec(ttnSql);
await db.exec(ttnSql);
check(TTN > DOCS && /^-- Apply manually after review\. This file is not applied to production by the agent\./.test(ttnSql)
    && !ttnSql.split('\n').some((line) => !/^\s*--/.test(line) && /CREATE EXTENSION/i.test(line)),
'waybills: ' + TTN + ' (after ' + DOCS + ') applied three times (idempotent), manual-apply header, no CREATE EXTENSION');
check(docsFnsBefore.length > 0 && docsFnsBefore === await fnDefs(DOCS_FNS),
    'waybills: functions of 4a and kp_* access helpers are not redefined by the migration');
const ttnCode = ttnSql.replace(/^\s*--.*$/gm, '');
check(!/CREATE OR REPLACE FUNCTION public\.(kp_doc_(create|cancel|list|get|alloc_number|next_number|pay_status|paid|trips_for_client|assets_source)\b|kp_docs_org|kp_org_id|kp_role|kp_can_write|kp_context|kp_trips)\b/.test(ttnSql)
    && !/ALTER TABLE public\.(kp_documents|kp_document_lines|calculations|trip_actuals|org_company_profiles)\b/.test(ttnSql)
    && !/(DROP|ALTER|CREATE) POLICY[^;]*fleet_vehicles/i.test(ttnCode)
    && !/(DROP|ALTER|CREATE) TRIGGER trg_fleet_vehicles_guard ON/i.test(ttnCode)
    && (ttnCode.match(/(DROP|CREATE) TRIGGER[^;]*\bON public\.fleet_vehicles\b/gi) || []).every((s) => /trg_fleet_vehicles_guard_driver/.test(s)),
'waybills: no 4a functions / tables, calculations or fleet_vehicles policies touched; on fleet_vehicles only the new driver trigger');
// fleet_vehicles_guard: гілки service_role і власника — дослівно з міграції сайту; новий лише випадок логіста (ТТН-колонки).
const siteGuard = fs.readFileSync(new URL('20261012240000_fleet_vehicles.sql', DIR), 'utf8').split('AS $$')[1].split('$$;')[0];
const [guardHead, guardTail] = siteGuard.split("  IF NOT public.is_org_owner() THEN\n    RAISE EXCEPTION 'FLEET_FORBIDDEN' USING ERRCODE = '42501';\n  END IF;\n");
const ttnGuard = ttnSql.split('CREATE OR REPLACE FUNCTION public.fleet_vehicles_guard()')[1].split('$$;')[0];
check(Boolean(guardTail) && ttnGuard.includes(guardHead.split('BEGIN\n')[1]) && ttnGuard.includes(guardTail)
    && /IF NOT public\.is_org_owner\(\) THEN\n    -- Логіст[\s\S]*?public\.kp_can_write\(\)[\s\S]*?\(to_jsonb\(NEW\) - v_ttn\) = \(to_jsonb\(OLD\) - v_ttn\)[\s\S]*?RAISE EXCEPTION 'FLEET_FORBIDDEN'/.test(ttnGuard),
'waybills: fleet_vehicles_guard keeps the service_role and owner branches verbatim; non-owners only for the TTN columns');
const ttnAlloc = (await one(`SELECT pg_get_functiondef('public.kp_ttn_alloc_number(uuid, integer, integer)'::regprocedure) AS d`)).d;
check(/ON CONFLICT \(org_id, kind, year\) DO UPDATE SET next_no = c\.next_no \+ 1/.test(ttnAlloc) && /VALUES \(p_org, 'ttn', p_year, 2\)/.test(ttnAlloc),
    'waybills: numbering uses the existing kp_doc_counters row (kind ttn) with the same row lock');

// Заглушка Supabase Vault (лише для PGlite; на проді supabase_vault уже встановлено і шифрує секрети).
await db.exec(`
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, description text NOT NULL DEFAULT '',
  secret text NOT NULL, key_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE VIEW vault.decrypted_secrets AS
  SELECT id, name, description, secret, secret AS decrypted_secret, key_id, created_at, updated_at FROM vault.secrets;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE sql AS
  $$ INSERT INTO vault.secrets (secret, name, description, key_id) VALUES (new_secret, new_name, coalesce(new_description, ''), new_key_id) RETURNING id $$;
CREATE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL,
  new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL) RETURNS void LANGUAGE sql AS
  $$ UPDATE vault.secrets SET secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
       description = coalesce(new_description, description), updated_at = now() WHERE id = secret_id $$;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM PUBLIC, anon, authenticated, service_role;
`);
const gpsSql = fs.readFileSync(new URL(GPS, DIR), 'utf8');
await db.exec(gpsSql);
await db.exec(gpsSql);
check(/^-- Apply manually after review\. This file is not applied to production by the agent\./.test(gpsSql)
    // Рядки верхнього рівня (не коментарі й не тіла функцій з відступом): без CREATE EXTENSION і без vault.*.
    && !gpsSql.split('\n').some((line) => !/^\s*--/.test(line) && !/^\s/.test(line) && /CREATE EXTENSION|vault\./i.test(line)),
    'gps: migration header, no CREATE EXTENSION and no vault.* in top-level DDL');
check(true, 'gps: ' + later.length + ' later migration(s) + ' + GPS + ' (twice) applied');

async function one(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}
async function as(role, user, sql, params = []) {
    await db.exec('RESET ROLE');
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify(user ? { sub: user, role } : { role })]);
    await db.exec('SET ROLE ' + role);
    try {
        const { rows } = await db.query(sql, params);
        return { ok: true, rows };
    } catch (error) {
        return { ok: false, rows: [], code: error.code, message: String(error.message || error) };
    } finally {
        await db.exec('RESET ROLE');
        await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
}
const user = (id) => (sql, params) => as('authenticated', id, sql, params);
const service = (sql, params) => as('service_role', null, sql, params);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const A = '10000000-0000-4000-8000-00000000000a';   // control_plus
const B = '10000000-0000-4000-8000-00000000000b';   // company (без Контроль+)
const C = '10000000-0000-4000-8000-00000000000c';   // control_plus, чужа
const D = '10000000-0000-4000-8000-00000000000d';   // власна org директора (company)
const OA = '00000000-0000-4000-8000-0000000000a1', LA = '00000000-0000-4000-8000-0000000000a2', LA2 = '00000000-0000-4000-8000-0000000000a3';
const OB = '00000000-0000-4000-8000-0000000000b1', OC = '00000000-0000-4000-8000-0000000000c1';
const DIR1 = '00000000-0000-4000-8000-0000000000d1', DIR2 = '00000000-0000-4000-8000-0000000000d2', DIR3 = '00000000-0000-4000-8000-0000000000d3';
await db.exec(`
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO auth.users (id, email) VALUES ('${OA}', 'owner@a.ua'), ('${LA}', 'logist@a.ua'), ('${LA2}', 'logist2@a.ua'),
  ('${OB}', 'owner@b.ua'), ('${OC}', 'owner@c.ua'), ('${DIR1}', 'dir1@x.ua'), ('${DIR2}', 'dir2@x.ua'), ('${DIR3}', 'dir3@x.ua');
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_tripcontrol;
INSERT INTO public.organizations (id, name, work_mode) VALUES ('${A}', 'Агро А', 'team'), ('${B}', 'Компанія Б', 'solo'),
  ('${C}', 'Чужа В', 'solo'), ('${D}', 'Директорська', 'solo');
INSERT INTO public.profiles (id, org_id, email, org_role, member_status, is_approved) VALUES
  ('${OA}', '${A}', 'owner@a.ua', 'owner', 'active', true), ('${LA}', '${A}', 'logist@a.ua', 'logist', 'active', true),
  ('${LA2}', '${A}', 'logist2@a.ua', 'logist', 'active', true),
  ('${OB}', '${B}', 'owner@b.ua', 'owner', 'active', true), ('${OC}', '${C}', 'owner@c.ua', 'owner', 'active', true),
  ('${DIR1}', '${D}', 'dir1@x.ua', 'owner', 'active', true), ('${DIR2}', null, 'dir2@x.ua', 'owner', 'active', false),
  ('${DIR3}', null, 'dir3@x.ua', 'owner', 'active', false);
INSERT INTO public.company_settings (org_id, settings) VALUES ('${A}', '{"logists_see_all": false}');
`);

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
check((await one(`SELECT plan FROM public.organizations WHERE id = $1`, [A])).plan === 'company', 'plan: existing organizations default to company');
const ownerSetsPlan = await user(OA)(`UPDATE public.organizations SET plan = 'control_plus' WHERE id = $1 RETURNING id`, [A]);
check(!ownerSetsPlan.ok && /PLAN_SERVICE_ROLE_ONLY/.test(ownerSetsPlan.message), 'plan: owner cannot switch own org to control_plus', ownerSetsPlan.message);
const rename = await user(OA)(`UPDATE public.organizations SET name = 'Агро А+' WHERE id = $1 RETURNING name`, [A]);
check(rename.ok && rename.rows[0].name === 'Агро А+', 'plan: owner still renames own org (site unchanged)', rename.message);
const rpcByUser = await user(OA)(`SELECT public.set_org_plan($1, 'control_plus')`, [A]);
check(!rpcByUser.ok && rpcByUser.code === '42501', 'plan: set_org_plan not callable by authenticated');
for (const org of [A, C]) check((await service(`SELECT public.set_org_plan($1, 'control_plus') AS p`, [org])).rows[0].p === 'control_plus', 'plan: service_role enables control_plus for ' + org.slice(-1));
const badPlan = await service(`SELECT public.set_org_plan($1, 'gold')`, [B]);
check(!badPlan.ok && /BAD_PLAN/.test(badPlan.message), 'plan: unknown plan refused');
await db.exec(`UPDATE public.organizations SET plan = 'company' WHERE id = '${D}'`);
check(true, 'plan: direct SQL (SQL Editor, no client role) can set the plan');
const signup = '00000000-0000-4000-8000-0000000000e1';
await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${signup}', 'new@x.ua', '{"company_name":"Нова"}')`);
const newOrg = await one(`SELECT o.plan FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id WHERE p.id = $1`, [signup]);
check(newOrg && newOrg.plan === 'company', 'plan: site signup still creates an org on company');

// ---------------------------------------------------------------------------
// Directors
// ---------------------------------------------------------------------------
const selfDirector = await user(OA)(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2)`, [A, DIR1]);
check(!selfDirector.ok && selfDirector.code === '42501', 'directors: owner cannot add a director (service_role only)');
check((await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2) RETURNING user_id`, [A, DIR1])).ok, 'directors: service_role adds director 1');
check((await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2) RETURNING user_id`, [A, DIR2])).ok, 'directors: service_role adds director 2');
const third = await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2)`, [A, DIR3]);
check(!third.ok && /DIRECTOR_LIMIT/.test(third.message), 'directors: a 3rd director is refused (limit 2)', third.message);
const member = await service(`INSERT INTO public.org_directors (org_id, user_id) VALUES ($1, $2)`, [C, OC]);
check(!member.ok && /DIRECTOR_IS_MEMBER/.test(member.message), 'directors: an active member of the org cannot be its director');
const seats = await one(`SELECT count(*)::int AS n FROM public.profiles WHERE org_id = $1 AND org_role = 'logist' AND member_status = 'active'`, [A]);
check(seats.n === 2, 'directors: do not take logist seats (profiles unchanged)');
const dirSees = await user(DIR1)(`SELECT org_id FROM public.org_directors`);
const logistSeesDirs = await user(LA)(`SELECT org_id FROM public.org_directors`);
const ownerSeesDirs = await user(OA)(`SELECT user_id FROM public.org_directors`);
check(dirSees.ok && dirSees.rows.length === 1 && logistSeesDirs.rows.length === 0 && ownerSeesDirs.rows.length === 2, 'directors: visible to the owner and to the director only');

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const ctx = async (id) => (await user(id)(`SELECT * FROM public.kp_context()`)).rows[0];
const cOA = await ctx(OA), cLA = await ctx(LA), cDIR = await ctx(DIR1), cOB = await ctx(OB), cOC = await ctx(OC);
check(cOA.control_plus && cOA.role === 'owner' && cOA.org_id === A, 'context: owner of a control_plus org');
check(cLA.control_plus && cLA.role === 'logist' && cLA.org_id === A, 'context: logist');
check(cDIR.control_plus && cDIR.role === 'director' && cDIR.org_id === A && cDIR.own_org_plan === 'company', 'context: director works in org A (own org on company)');
check(!cOB.control_plus && cOB.role === null && cOB.own_org_plan === 'company', 'context: org without the plan — no access');
check(cOC.control_plus && cOC.org_id === C, 'context: other control_plus org sees its own');

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const insertClient = (id, org, fields) => user(id)(`INSERT INTO public.clients (org_id, name, legal_form, edrpou, ipn, iban, email, vat_payer, vat_number)
  VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, false), $9) RETURNING id, iban, email, created_by`,
  [org, fields.name, fields.legal_form || null, fields.edrpou || null, fields.ipn || null, fields.iban || null, fields.email || null, fields.vat_payer || null, fields.vat_number || null]);
const tov = await insertClient(OA, A, { name: 'Зерно ТОВ', legal_form: 'tov', edrpou: '12345678', iban: 'ua21 3223 1300 0002 6007 2335 6600 1', email: ' Buh@Zerno.UA ', vat_payer: true, vat_number: '123456789012' });
check(tov.ok && tov.rows[0].iban === 'UA213223130000026007233566001' && tov.rows[0].email === 'buh@zerno.ua' && tov.rows[0].created_by === OA,
    'clients: owner adds a ТОВ; IBAN / email normalized, author from the server', tov.message);
const fop = await insertClient(LA, A, { name: 'ФОП Петренко', legal_form: 'fop', ipn: '1234567890' });
check(fop.ok, 'clients: logist adds a ФОП', fop.message);
const quick = await insertClient(LA, A, { name: 'Швидкий без реквізитів' });
check(quick.ok, 'clients: quick add with the name only (all requisites may be empty)', quick.message);
for (const [label, fields] of [['ЄДРПОУ 7 digits', { edrpou: '1234567' }], ['ІПН 9 digits', { ipn: '123456789' }],
    ['IBAN not UA', { iban: 'DE89370400440532013000' }], ['IBAN short', { iban: 'UA2132231300' }], ['bad email', { email: 'not-an-email' }],
    ['legal form', { legal_form: 'pp' }], ['VAT number 11 digits', { vat_number: '12345678901' }]]) {
    const res = await insertClient(OA, A, Object.assign({ name: 'Bad ' + label }, fields));
    check(!res.ok && res.code === '23514', 'clients: format check — ' + label, res.message);
}
const dup = await insertClient(OA, A, { name: 'Дубль', edrpou: '12345678' });
check(!dup.ok && dup.code === '23505', 'clients: one active client per ЄДРПОУ in the org');
const tovId = tov.rows[0].id, fopId = fop.rows[0].id;
const otherOrgSameEdrpou = await insertClient(OC, C, { name: 'Інший', edrpou: '12345678' });
check(otherOrgSameEdrpou.ok, 'clients: the same ЄДРПОУ is fine in another org');

const bClients = await user(OB)(`SELECT id FROM public.clients`);
const bInsert = await insertClient(OB, B, { name: 'Б-клієнт' });
check(bClients.ok && bClients.rows.length === 0, 'gating: org without the plan sees no clients');
check(!bInsert.ok && bInsert.code === '42501', 'gating: org without the plan cannot add clients (RLS)', bInsert.message);
const cSees = await user(OC)(`SELECT name FROM public.clients`);
check(cSees.ok && cSees.rows.length === 1 && cSees.rows[0].name === 'Інший', 'isolation: another control_plus org sees only its own clients');
const crossInsert = await insertClient(OC, A, { name: 'Чужий у А' });
check(!crossInsert.ok, 'isolation: cannot add a client into another org');
const anonSees = await as('anon', null, `SELECT id FROM public.clients`);
check(!anonSees.ok && anonSees.code === '42501', 'isolation: anon has no access');

const dirClients = await user(DIR1)(`SELECT name FROM public.clients ORDER BY name`);
check(dirClients.ok && dirClients.rows.length === 3, 'director: reads the org clients');
const dirInsert = await insertClient(DIR1, A, { name: 'Від директора' });
const dirUpdate = await user(DIR1)(`UPDATE public.clients SET notes = 'x' WHERE id = $1 RETURNING id`, [tovId]);
const dirDelete = await user(DIR1)(`DELETE FROM public.clients WHERE id = $1 RETURNING id`, [tovId]);
check(!dirInsert.ok && dirUpdate.ok && dirUpdate.rows.length === 0 && dirDelete.ok && dirDelete.rows.length === 0,
    'director: cannot insert, update or delete clients', [dirInsert.message, dirUpdate.message, dirDelete.message].join(' | '));
const logistUpdate = await user(LA)(`UPDATE public.clients SET phone = '+380 50 000 00 00' WHERE id = $1 RETURNING phone`, [tovId]);
check(logistUpdate.ok && logistUpdate.rows.length === 1, 'clients: logist edits a client');
const logistDelete = await user(LA)(`DELETE FROM public.clients WHERE id = $1 RETURNING id`, [quick.rows[0].id]);
check(logistDelete.ok && logistDelete.rows.length === 0, 'clients: logist cannot delete (archive instead)');
const archive = await user(LA)(`UPDATE public.clients SET archived_at = now() WHERE id = $1 RETURNING archived_at`, [quick.rows[0].id]);
check(archive.ok && archive.rows[0].archived_at, 'clients: logist archives');
const moveOrg = await user(OA)(`UPDATE public.clients SET org_id = $2 WHERE id = $1`, [tovId, C]);
check(!moveOrg.ok, 'clients: org cannot be changed');
await db.exec(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '${LA2}'`);
const blocked = await insertClient(LA2, A, { name: 'Від заблокованого' });
check(!blocked.ok, 'clients: a blocked user cannot write');
await db.exec(`UPDATE auth.users SET banned_until = null WHERE id = '${LA2}'`);

// ---------------------------------------------------------------------------
// Trips, links, history
// ---------------------------------------------------------------------------
async function trip(author, name, revenue, profit, overhead, status = 'accepted', date = '2026-10-10') {
    const res = await service(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results, status, trip_date)
      VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, $5, $6) RETURNING id`,
    [author, (await one(`SELECT org_id FROM public.profiles WHERE id = $1`, [author])).org_id, name,
        JSON.stringify({ grossIncome: String(revenue), netProfit: String(profit), overheadTotal: String(overhead) }), status, date]);
    if (!res.ok) throw new Error(res.message);
    return res.rows[0].id;
}
const t1 = await trip(OA, 'Київ — Одеса', 100000, 20000, 5000);
const t2 = await trip(LA, 'Київ — Одеса (копія)', 80000, 10000, 4000);
const t3 = await trip(LA2, 'Львів — Дніпро', 50000, 5000, 2000);
const t4 = await trip(OA, 'Чернетка', 999, 1, 0, 'draft');
const t5 = await trip(OA, 'Поза періодом', 70000, 7000, 1000, 'done', '2026-09-01');
const tC = await trip(OC, 'Чужий рейс', 10000, 1000, 0);
// Факт: t1 і t2.
await service(`INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by) VALUES ($1, 95000, 72000, 0, 0, $2)`, [t1, OA]);
await service(`INSERT INTO public.trip_actuals (calculation_id, revenue, costs, planned_overhead, profit, entered_by) VALUES ($1, 80000, 70000, 0, 0, $2)`, [t2, LA]);
const facts = await db.query(`SELECT calculation_id, profit FROM public.trip_actuals`);
const factProfit = Object.fromEntries(facts.rows.map((r) => [r.calculation_id, Number(r.profit)]));
check(factProfit[t1] === 18000 && factProfit[t2] === 6000, 'fixture: fact profit = revenue − costs − planned overhead (18 000 / 6 000)');
// Авто: t1 — два авто (тоннаж 30 / 10), t2 — одне, t3 — без авто.
const fleet = await service(`INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('20000000-0000-4000-8000-000000000001', $1, 'AA1111AA'), ('20000000-0000-4000-8000-000000000002', $1, 'BB2222BB')`, [A]);
if (!fleet.ok) throw new Error(fleet.message);
await service(`INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage) VALUES ($1, '20000000-0000-4000-8000-000000000001', 30), ($1, '20000000-0000-4000-8000-000000000002', 10), ($2, '20000000-0000-4000-8000-000000000001', 25)`, [t1, t2]);
await service(`INSERT INTO public.route_templates (org_id, owner_user_id, scope, name, params) VALUES ($1, $2, 'company', 'Київ — Одеса', '{}'::jsonb)`, [A, OA]);

const link = (id, calc, client) => user(id)(`INSERT INTO public.calculation_clients (calculation_id, client_id) VALUES ($1, $2) RETURNING org_id, linked_by`, [calc, client]);
const l1 = await link(OA, t2, tovId);
check(l1.ok && l1.rows[0].org_id === A && l1.rows[0].linked_by === OA, 'links: owner links a logist\'s trip to a client', l1.message);
const l2 = await link(LA, t1, fopId);
check(!l2.ok && /CLIENT_LINK_FORBIDDEN|row-level security/.test(l2.message), 'links: logist cannot link the owner\'s trip', l2.message);
const l3 = await link(LA2, t3, fopId);
check(l3.ok, 'links: logist links own trip', l3.message);
const l4 = await link(OA, t1, tovId);
check(l4.ok, 'links: owner links own trip');
const lCross = await link(OC, tC, tovId);
check(!lCross.ok, 'links: a client of another org cannot be linked');
const lDir = await link(DIR1, t5, tovId);
check(!lDir.ok, 'links: director cannot link');
const lB = await user(OB)(`SELECT * FROM public.calculation_clients`);
check(lB.ok && lB.rows.length === 0, 'links: org without the plan sees no links');

const history = await user(OA)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(history.ok && history.rows.length === 2 && history.rows.some((r) => r.calculation_id === t1 && Number(r.fact_profit) === 18000 && Number(r.plan_costs) === 80000),
    'history: owner sees the client\'s trips with plan, rate and fact', history.message);
const historyLogist = await user(LA2)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(historyLogist.ok && historyLogist.rows.length === 0, 'history: logist (see-all off) sees only own trips of the client');
const historyDir = await user(DIR1)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(historyDir.ok && historyDir.rows.length === 2, 'history: director sees all trips of the client');
const historyC = await user(OC)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(!historyC.ok && /CLIENT_NOT_FOUND/.test(historyC.message), 'history: another org gets CLIENT_NOT_FOUND');
const historyB = await user(OB)(`SELECT * FROM public.client_history($1)`, [tovId]);
check(!historyB.ok && /CONTROL_PLUS_REQUIRED/.test(historyB.message), 'history: org without the plan — CONTROL_PLUS_REQUIRED');
const kpTrips = await user(OA)(`SELECT calculation_id, can_link, client_name FROM public.kp_trips('2026-10-01', '2026-10-31', false)`);
check(kpTrips.ok && kpTrips.rows.length === 4 && kpTrips.rows.every((r) => r.can_link === true), 'trips: owner — all trips of the period, can link');
const kpUnlinked = await user(LA2)(`SELECT calculation_id, can_link FROM public.kp_trips('2026-10-01', '2026-10-31', true)`);
check(kpUnlinked.ok && kpUnlinked.rows.length === 0, 'trips: logist — own trips only (t3 already linked)');
const kpDir = await user(DIR1)(`SELECT can_link FROM public.kp_trips('2026-10-01', '2026-10-31', false)`);
check(kpDir.ok && kpDir.rows.length === 4 && kpDir.rows.every((r) => r.can_link === false), 'trips: director sees all, cannot link');

// ---------------------------------------------------------------------------
// Plan / fact report
// ---------------------------------------------------------------------------
const report = async (id, group) => user(id)(`SELECT * FROM public.report_plan_fact('2026-10-01', '2026-10-31', $1)`, [group]);
const num = (v) => (v === null ? null : Number(v));
const byLabel = (rows) => Object.fromEntries(rows.map((r) => [r.group_label, r]));

const rl = await report(OA, 'logist');
const L = byLabel(rl.rows);
check(rl.ok && rl.rows.length === 3, 'report logist: 3 authors (draft and out-of-period excluded)', rl.message);
check(L['owner@a.ua'] && L['owner@a.ua'].trips === 1 && num(L['owner@a.ua'].plan_revenue) === 100000 && num(L['owner@a.ua'].plan_costs) === 80000
    && num(L['owner@a.ua'].plan_profit) === 20000 && num(L['owner@a.ua'].fact_revenue) === 95000 && num(L['owner@a.ua'].fact_costs) === 77000
    && num(L['owner@a.ua'].fact_profit) === 18000 && num(L['owner@a.ua'].deviation_profit) === -2000 && num(L['owner@a.ua'].deviation_pct) === -10,
'report logist: owner row — plan 100 000 / 80 000 / 20 000, fact 95 000 / 77 000 / 18 000, −2 000 (−10%)', JSON.stringify(L['owner@a.ua']));
check(L['logist2@a.ua'] && L['logist2@a.ua'].trips_with_fact === 0 && num(L['logist2@a.ua'].deviation_profit) === 0 && L['logist2@a.ua'].deviation_pct === null,
    'report logist: a trip without fact — no deviation');

const rv = byLabel((await report(OA, 'vehicle')).rows);
check(num(rv.AA1111AA.plan_revenue) === 155000 && num(rv.BB2222BB.plan_revenue) === 25000 && rv.AA1111AA.trips === 2 && rv.BB2222BB.trips === 1,
    'report vehicle: two vehicles on one trip split by tonnage (75% / 25%)', JSON.stringify([rv.AA1111AA, rv.BB2222BB].map((r) => r && r.plan_revenue)));
check(rv['Без авто'] && rv['Без авто'].trips === 1 && num(rv['Без авто'].plan_revenue) === 50000, 'report vehicle: trips without a vehicle — «Без авто»');
const vehicleTotal = Object.values(rv).reduce((s, r) => s + num(r.plan_revenue), 0);
check(vehicleTotal === 230000, 'report vehicle: totals equal the trips (no double counting)', String(vehicleTotal));

const rc = byLabel((await report(OA, 'client')).rows);
check(rc['Зерно ТОВ'] && rc['Зерно ТОВ'].trips === 2 && rc['ФОП Петренко'].trips === 1 && !rc['Без клієнта'], 'report client: by linked client');
const rd = byLabel((await report(OA, 'direction')).rows);
check(rd['Київ — Одеса'] && rd['Київ — Одеса'].trips === 2 && rd['Без шаблону'] && rd['Без шаблону'].trips === 1,
    'report direction: by route template name (« (копія)» too), others «Без шаблону»', JSON.stringify(Object.keys(rd)));
check((await report(OA, 'direction')).rows.at(-1).group_label === 'Без шаблону', 'report: «Без …» group last');

const rLogist = await report(LA, 'logist');
check(rLogist.ok && rLogist.rows.length === 1 && rLogist.rows[0].group_label === 'logist@a.ua', 'report: logist (see-all off) sees only own trips');
await db.exec(`UPDATE public.company_settings SET settings = '{"logists_see_all": true}' WHERE org_id = '${A}'`);
check((await report(LA, 'logist')).rows.length === 3, 'report: logist sees all with «логісти бачать усе»');
check((await report(DIR1, 'logist')).rows.length === 3, 'report: director sees all trips');
const rC = await report(OC, 'logist');
check(rC.ok && rC.rows.length === 1 && rC.rows[0].group_label === 'owner@c.ua', 'report: another org sees only its trips');
const rB = await report(OB, 'logist');
check(!rB.ok && /CONTROL_PLUS_REQUIRED/.test(rB.message), 'report: org without the plan — CONTROL_PLUS_REQUIRED');
const badGroup = await user(OA)(`SELECT * FROM public.report_plan_fact('2026-10-01', '2026-10-31', 'colour')`);
const badPeriod = await user(OA)(`SELECT * FROM public.report_plan_fact('2026-10-31', '2026-10-01', 'logist')`);
check(!badGroup.ok && /BAD_GROUP/.test(badGroup.message) && !badPeriod.ok && /BAD_PERIOD/.test(badPeriod.message), 'report: bad group / period refused');
const anonReport = await as('anon', null, `SELECT * FROM public.report_plan_fact('2026-10-01', '2026-10-31', 'logist')`);
check(!anonReport.ok && anonReport.code === '42501', 'report: anon cannot call');

// Авто без тоннажу. Зараз calc_vehicles.tonnage NOT NULL і > 0, тож цей випадок захисний: обмеження знімаємо лише
// в цій одноразовій БД, щоб перевірити, що рейс тоді ділиться порівну, а не випадає зі звіту.
await db.exec(`ALTER TABLE public.calc_vehicles ALTER COLUMN tonnage DROP NOT NULL, DROP CONSTRAINT calc_vehicles_tonnage_positive`);
const V1 = '20000000-0000-4000-8000-000000000001', V2 = '20000000-0000-4000-8000-000000000002';
const tNull = await trip(OA, 'Без тоннажу', 60000, 9000, 0, 'accepted', '2026-11-02');
const tZero = await trip(OA, 'Нульовий тоннаж', 30000, 3000, 0, 'accepted', '2026-11-03');
const tMixed = await trip(OA, 'Частковий тоннаж', 40000, 4000, 0, 'accepted', '2026-11-04');
const noTonnage = await service(`INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage) VALUES ($1, $3, NULL), ($1, $4, NULL),
  ($2, $3, 0), ($2, $4, 0), ($5, $3, 20), ($5, $4, NULL)`, [tNull, tZero, V1, V2, tMixed]);
if (!noTonnage.ok) throw new Error(noTonnage.message);
const vehicleDay = async (day) => byLabel((await user(OA)(`SELECT * FROM public.report_plan_fact($1, $1, 'vehicle')`, [day])).rows);
const vNull = await vehicleDay('2026-11-02');
check(num(vNull.AA1111AA.plan_revenue) === 30000 && num(vNull.BB2222BB.plan_revenue) === 30000
    && num(vNull.AA1111AA.plan_profit) === 4500 && vNull.AA1111AA.trips === 1 && vNull.BB2222BB.trips === 1,
'report vehicle: tonnage NULL on every vehicle — split equally', JSON.stringify(vNull));
const vZero = await vehicleDay('2026-11-03');
check(num(vZero.AA1111AA.plan_revenue) === 15000 && num(vZero.BB2222BB.plan_revenue) === 15000, 'report vehicle: tonnage 0 — split equally');
const vMixed = await vehicleDay('2026-11-04');
const mixedTotal = Object.values(vMixed).reduce((s, r) => s + num(r.plan_revenue), 0);
check(num(vMixed.AA1111AA.plan_revenue) === 40000 && mixedTotal === 40000, 'report vehicle: partly missing tonnage — by known tonnage, total kept');
await db.query(`DELETE FROM public.calculations WHERE id = ANY($1)`, [[tNull, tZero, tMixed]]);

// ---------------------------------------------------------------------------
// GPS (етап 2a): підключення, Vault, видимість, мапінг, чистка
// ---------------------------------------------------------------------------
const FAKE_TOKEN = 'FAKEtoken0000000000000000000000000000000000000000000000000000000000beef';
const intOf = async (org, host = 'hst-api.wialon.com') => (await service(`INSERT INTO public.gps_integrations (org_id, provider, host_kind, api_host, status)
  VALUES ($1, 'wialon', 'hosting', $2, 'active') RETURNING id`, [org, host])).rows[0].id;
const iA = await intOf(A);
const iB = await intOf(B);
const iC = await intOf(C);
const hint = await service(`SELECT public.gps_store_token($1, $2) AS hint`, [iA, FAKE_TOKEN]);
check(hint.ok && hint.rows[0].hint === '…beef', 'gps vault: store_token returns only the mask', hint.message);
const rowA = await one(`SELECT row_to_json(gi)::text AS j, token_secret_id FROM public.gps_integrations AS gi WHERE id = $1`, [iA]);
check(rowA.token_secret_id && !rowA.j.includes(FAKE_TOKEN) && !rowA.j.includes('FAKEtoken'), 'gps vault: no token in any gps_integrations column');
const secretRow = await one(`SELECT name, secret FROM vault.secrets WHERE id = $1`, [rowA.token_secret_id]);
check(secretRow && secretRow.name === 'gps:' + iA && secretRow.secret === FAKE_TOKEN, 'gps vault: secret gps:<integration_id> in Vault');
const readBack = await service(`SELECT public.gps_read_token($1) AS t`, [iA]);
check(readBack.ok && readBack.rows[0].t === FAKE_TOKEN, 'gps vault: service_role reads the token');
const rotated = await service(`SELECT public.gps_store_token($1, $2) AS hint`, [iA, FAKE_TOKEN.replace('beef', 'cafe')]);
const secretsAfter = await one(`SELECT count(*)::int AS n FROM vault.secrets WHERE name = $1`, ['gps:' + iA]);
check(rotated.ok && rotated.rows[0].hint === '…cafe' && secretsAfter.n === 1, 'gps vault: a new token updates the same secret');
await service(`SELECT public.gps_store_token($1, $2)`, [iA, FAKE_TOKEN]);
const badToken = await service(`SELECT public.gps_store_token($1, 'short')`, [iA]);
check(!badToken.ok && /GPS_BAD_TOKEN/.test(badToken.message) && !badToken.message.includes('short'), 'gps vault: bad token refused without echo');

// gps_connect: поля підключення й секрет в одній транзакції.
const TOKEN_C = 'FAKEtokenOrgC000000000000000000000000000000000000000000000000000000c0c0';
const gpsConnect = (org, kind, host, token, who) => service(`SELECT * FROM public.gps_connect($1, 'wialon', $2, $3, 'viewer', 5, $4, $5)`, [org, kind, host, token, who]);
const conC = await gpsConnect(C, 'local', 'gps.c-fleet.com', TOKEN_C, OC);
const conRow = conC.rows[0] || {};
check(conC.ok && conRow.id === iC && conRow.status === 'active' && conRow.api_host === 'gps.c-fleet.com' && conRow.host_kind === 'local'
    && conRow.token_hint === '…c0c0' && !JSON.stringify(conRow).includes(TOKEN_C), 'gps_connect: existing row updated, mask only in the result', conC.message);
check((await service(`SELECT public.gps_read_token($1) AS t`, [iC])).rows[0].t === TOKEN_C, 'gps_connect: token in Vault');
const conFail = await gpsConnect(C, 'hosting', 'hst-api.wialon.eu', 'short', OC);
const afterFail = await one(`SELECT api_host, host_kind, status, token_hint FROM public.gps_integrations WHERE id = $1`, [iC]);
check(!conFail.ok && /GPS_BAD_TOKEN/.test(conFail.message) && afterFail.api_host === 'gps.c-fleet.com' && afterFail.host_kind === 'local'
    && afterFail.token_hint === '…c0c0' && (await service(`SELECT public.gps_read_token($1) AS t`, [iC])).rows[0].t === TOKEN_C,
'gps_connect: a Vault error rolls back everything — old host and old token stay together');
const conNew = await gpsConnect(D, 'hosting', 'hst-api.wialon.com', 'short', DIR1);
check(!conNew.ok && (await one(`SELECT count(*)::int AS n FROM public.gps_integrations WHERE org_id = $1`, [D])).n === 0,
    'gps_connect: a failed first connect leaves no row');

for (const [name, sql] of [
    ['vault.secrets', 'SELECT * FROM vault.secrets'],
    ['vault.decrypted_secrets', 'SELECT * FROM vault.decrypted_secrets'],
    ['gps_read_token', `SELECT public.gps_read_token('${iA}')`],
    ['gps_store_token', `SELECT public.gps_store_token('${iA}', 'x1234567890')`],
    ['gps_delete_token', `SELECT public.gps_delete_token('${iA}')`],
    ['gps_purge_old', 'SELECT public.gps_purge_old(14, 5000)'],
    ['gps_connect', `SELECT * FROM public.gps_connect('${A}', 'wialon', 'hosting', 'hst-api.wialon.com', 'x', 1, 'x1234567890', '${OA}')`],
    ['token_secret_id column', 'SELECT token_secret_id FROM public.gps_integrations'],
    ['insert gps_integrations', `INSERT INTO public.gps_integrations (org_id, provider, api_host) VALUES ('${A}', 'wialon', 'x')`],
    ['update gps_integrations', "UPDATE public.gps_integrations SET status = 'active'"],
    ['delete gps_integrations', 'DELETE FROM public.gps_integrations'],
    ['insert gps_vehicles', `INSERT INTO public.gps_vehicles (org_id, integration_id, external_id, name) VALUES ('${A}', '${iA}', '9', 'x')`],
    ['update gps_vehicles', 'UPDATE public.gps_vehicles SET vehicle_id = NULL'],
    ['delete gps_positions', 'DELETE FROM public.gps_positions'],
]) {
    const res = await user(OA)(sql);
    check(!res.ok && res.code === '42501', 'gps: owner (authenticated) cannot ' + name, res.message);
}
const anonGps = await as('anon', null, 'SELECT * FROM public.gps_integrations');
check(!anonGps.ok && anonGps.code === '42501', 'gps: anon cannot read gps_integrations');
const anonUnits = await as('anon', null, 'SELECT * FROM public.gps_vehicles');
check(!anonUnits.ok && anonUnits.code === '42501', 'gps: anon cannot read gps_vehicles');

const INT_COLS = 'id, org_id, status, token_hint, api_host';
const seesInt = async (id) => (await user(id)(`SELECT ${INT_COLS} FROM public.gps_integrations`)).rows;
check((await seesInt(OA)).map((r) => r.id).join() === iA, 'gps: owner sees own integration (with mask)');
check((await seesInt(OA))[0].token_hint === '…beef', 'gps: owner sees only the token mask');
check((await seesInt(DIR1)).map((r) => r.id).join() === iA, 'gps: director sees the integration');
check((await seesInt(LA)).length === 0, 'gps: logist does not see gps_integrations');
check((await seesInt(OC)).map((r) => r.id).join() === iC, 'gps: another org sees only its own');
check((await seesInt(OB)).length === 0, 'gps: company plan sees nothing (own integration row exists)');

const unit = async (integration, ext, name, vehicle = null) => (await service(`INSERT INTO public.gps_vehicles (org_id, integration_id, external_id, name, vehicle_id)
  VALUES ($1, $2, $3, $4, $5) RETURNING id, org_id`, [A, integration, ext, name, vehicle]));
const u1 = (await unit(iA, '101', 'AA1111AA')).rows[0].id;
const u2 = (await unit(iA, '102', 'BB2222BB')).rows[0].id;
const u3 = (await unit(iA, '103', 'Тягач без авто')).rows[0].id;
const uC = await unit(iC, '201', 'C unit');
check(uC.ok && uC.rows[0].org_id === C, 'gps: unit org is taken from its integration (not from the input)');
const uB = (await unit(iB, '301', 'B unit')).rows[0].id;
const vC = (await service(`INSERT INTO public.fleet_vehicles (org_id, label) VALUES ($1, 'CC0000CC') RETURNING id`, [C])).rows[0].id;
const crossVehicle = await unit(iA, '104', 'cross', vC);
check(!crossVehicle.ok && /GPS_VEHICLE_ORG_MISMATCH/.test(crossVehicle.message), 'gps: a vehicle of another org cannot be attached (trigger)');
const pos = (u, days) => service(`INSERT INTO public.gps_positions (org_id, gps_vehicle_id, recorded_at, lat, lon, speed)
  VALUES ($1, $2, now() - make_interval(days => $3), 50.45, 30.52, 60) RETURNING id`, [A, u, days]);
for (const [u, d] of [[u1, 20], [u1, 15], [u1, 1], [u2, 0], [uC.rows[0].id, 30], [uB, 2]]) {
    const r = await pos(u, d);
    if (!r.ok) throw new Error(r.message);
}
const unitsOf = async (id) => (await user(id)('SELECT id FROM public.gps_vehicles')).rows.length;
const posOf = async (id) => (await user(id)('SELECT id FROM public.gps_positions')).rows.length;
check(await unitsOf(OA) === 3 && await posOf(OA) === 4, 'gps: owner sees all units and positions of the org');
check(await unitsOf(LA) === 3 && await posOf(LA) === 4, 'gps: logist sees ALL units / positions of the org (no trip filter, see-all off)');
check(await unitsOf(LA2) === 3, 'gps: another logist of the org too');
check(await unitsOf(DIR1) === 3 && await posOf(DIR1) === 4, 'gps: director sees all units / positions');
check(await unitsOf(OC) === 1 && await posOf(OC) === 1, 'gps: another org sees only its own units / positions');
check(await unitsOf(OB) === 0 && await posOf(OB) === 0, 'gps: company plan sees no units / positions');

const map = (id, u, v) => user(id)(`SELECT * FROM public.gps_map_vehicle($1, $2)`, [u, v]);
const V1g = '20000000-0000-4000-8000-000000000001', V2g = '20000000-0000-4000-8000-000000000002';
const m1 = await map(OA, u1, V1g);
check(m1.ok && m1.rows[0].vehicle_id === V1g, 'gps map: owner maps a unit to a vehicle', m1.message);
const mDup = await map(OA, u2, V1g);
check(!mDup.ok && /GPS_VEHICLE_TAKEN/.test(mDup.message), 'gps map: the same vehicle on a second unit — GPS_VEHICLE_TAKEN');
const mLogist = await map(LA, u2, V2g);
check(!mLogist.ok && /GPS_MAP_FORBIDDEN/.test(mLogist.message), 'gps map: logist cannot map');
const mDir = await map(DIR1, u2, V2g);
check(!mDir.ok && /GPS_MAP_FORBIDDEN/.test(mDir.message), 'gps map: director cannot map');
const mForeign = await map(OC, u2, null);
check(!mForeign.ok && /GPS_UNIT_NOT_FOUND/.test(mForeign.message), 'gps map: another org cannot touch the unit');
const mForeignVehicle = await map(OA, u2, vC);
check(!mForeignVehicle.ok && /GPS_VEHICLE_NOT_FOUND/.test(mForeignVehicle.message), 'gps map: a vehicle of another org — GPS_VEHICLE_NOT_FOUND');
const mB = await map(OB, uB, null);
check(!mB.ok && /GPS_MAP_FORBIDDEN/.test(mB.message), 'gps map: company plan cannot map');
const unmap = await map(OA, u1, null);
check(unmap.ok && (await one(`SELECT vehicle_id FROM public.gps_vehicles WHERE id = $1`, [u1])).vehicle_id === null, 'gps map: null removes the mapping');
await map(OA, u1, V1g);
const anonMap = await as('anon', null, `SELECT * FROM public.gps_map_vehicle('${u1}', NULL)`);
check(!anonMap.ok && anonMap.code === '42501', 'gps map: anon cannot call');
const unitsDir = await user(DIR1)('SELECT name, vehicle_label FROM public.gps_units()');
check(unitsDir.ok && unitsDir.rows.length === 3 && unitsDir.rows.some((r) => r.vehicle_label === 'AA1111AA'),
    'gps_units: director sees unit names with vehicle labels', unitsDir.message);
const unitsB = await user(OB)('SELECT * FROM public.gps_units()');
check(!unitsB.ok && /CONTROL_PLUS_REQUIRED/.test(unitsB.message), 'gps_units: company plan — CONTROL_PLUS_REQUIRED');

const purge = await service('SELECT public.gps_purge_old(14, 1) AS n');
const left = await one('SELECT count(*)::int AS n, min(recorded_at) > now() - interval \'14 days\' AS fresh FROM public.gps_positions');
check(purge.ok && Number(purge.rows[0].n) === 3 && left.n === 3 && left.fresh, 'gps_purge_old: removes points older than 14 days in batches, keeps fresh ones', purge.message);

// Втрата плану — доступ до GPS зникає.
await service(`SELECT public.set_org_plan($1, 'company')`, [A]);
check(await unitsOf(LA) === 0 && (await seesInt(OA)).length === 0 && await posOf(DIR1) === 0, 'gps: plan back to company — nothing visible');
await service(`SELECT public.set_org_plan($1, 'control_plus')`, [A]);

const del = await service(`SELECT public.gps_delete_token($1) AS ok`, [iA]);
const afterDel = await one(`SELECT token_secret_id, token_hint FROM public.gps_integrations WHERE id = $1`, [iA]);
const vaultLeft = await one(`SELECT count(*)::int AS n FROM vault.secrets WHERE name = $1`, ['gps:' + iA]);
check(del.ok && afterDel.token_secret_id === null && afterDel.token_hint === null && vaultLeft.n === 0
    && (await service(`SELECT public.gps_read_token($1) AS t`, [iA])).rows[0].t === null, 'gps vault: delete_token removes the secret and the mask');
await db.exec(gpsSql);
check((await one('SELECT count(*)::int AS n FROM public.gps_vehicles')).n === 5, 'gps: the migration re-applied over data keeps the data');

// Відключення плану — доступ зникає одразу.
await service(`SELECT public.set_org_plan($1, 'company')`, [A]);
check((await user(DIR1)(`SELECT id FROM public.clients`)).rows.length === 0 && !(await ctx(OA)).control_plus, 'gating: plan back to company — clients hidden, no context');
await service(`SELECT public.set_org_plan($1, 'control_plus')`, [A]);
await service(`UPDATE public.organizations SET status = 'blocked' WHERE id = $1`, [A]);
check((await user(OA)(`SELECT id FROM public.clients`)).rows.length === 0, 'gating: blocked org — no access');
await service(`UPDATE public.organizations SET status = 'active' WHERE id = $1`, [A]);

// Сайт: збереження рейсу (тригери calculations) і факт працюють як раніше.
const siteCalc = await user(OA)(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results) VALUES ($1, $2, 'Сайт', '{"dist":"100"}'::jsonb, '{}'::jsonb) RETURNING distance_km`, [OA, A]);
check(siteCalc.ok && Number(siteCalc.rows[0].distance_km) === 100, 'site: saving a calculation works as before', siteCalc.message);
const delOrg = await attemptDeleteOrg(A);
check(!delOrg.ok && delOrg.code === '23503', 'safety: an org with clients cannot be deleted by cascade (ON DELETE RESTRICT)');
async function attemptDeleteOrg(org) {
    try {
        await db.query(`DELETE FROM public.organizations WHERE id = $1`, [org]);
        return { ok: true };
    } catch (error) {
        return { ok: false, code: error.code };
    }
}

// ---------------------------------------------------------------------------
// supabase/tests/kontrol_plus.sql — через мінімальний shim pgTAP (у PGlite немає розширення pgtap).
// ---------------------------------------------------------------------------
await db.exec(`
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS instance_id uuid, ADD COLUMN IF NOT EXISTS aud text,
  ADD COLUMN IF NOT EXISTS role text, ADD COLUMN IF NOT EXISTS encrypted_password text,
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE TABLE extensions.tap (n serial, ok boolean, label text);
GRANT ALL ON extensions.tap TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE extensions.tap_n_seq TO anon, authenticated, service_role;
CREATE FUNCTION extensions.plan(integer) RETURNS text LANGUAGE sql AS $$ SELECT '1..' || $1 $$;
CREATE FUNCTION extensions.ok(boolean, text) RETURNS text LANGUAGE sql AS
  $$ INSERT INTO extensions.tap (ok, label) VALUES (coalesce($1, false), $2) RETURNING label $$;
CREATE FUNCTION extensions.is(anyelement, anyelement, text) RETURNS text LANGUAGE sql AS
  $$ SELECT extensions.ok($1 IS NOT DISTINCT FROM $2, $3 || ' (got ' || coalesce($1::text, 'NULL') || ')') $$;
CREATE FUNCTION extensions.lives_ok(text, text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE $1; EXCEPTION WHEN OTHERS THEN RETURN extensions.ok(false, $2 || ' (' || SQLERRM || ')'); END;
  RETURN extensions.ok(true, $2);
END $$;
CREATE FUNCTION extensions.throws_ok(text, text, text, text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE $1; EXCEPTION WHEN OTHERS THEN RETURN extensions.ok(SQLSTATE = $2, $4 || ' (' || SQLSTATE || ' ' || SQLERRM || ')'); END;
  RETURN extensions.ok(false, $4 || ' (no error)');
END $$;
CREATE FUNCTION extensions.finish() RETURNS SETOF text LANGUAGE sql AS $$ SELECT 'done' $$;
`);
const tapSql = fs.readFileSync(new URL('../../../supabase/tests/kontrol_plus.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const planned = Number((tapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
await db.exec(tapSql);
const tap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows;
for (const row of tap) check(row.ok, 'pgTAP kontrol_plus.sql: ' + row.label);
check(tap.length === planned, `pgTAP kontrol_plus.sql: ran ${tap.length} of plan(${planned})`);

// supabase/tests/gps_integrations.sql — той самий shim pgTAP і заглушка Vault.
const gpsTapSql = fs.readFileSync(new URL('../../../supabase/tests/gps_integrations.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const gpsPlanned = Number((gpsTapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
const tapBefore = tap.length;
await db.exec(gpsTapSql);
const gpsTap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows.slice(tapBefore);
for (const row of gpsTap) check(row.ok, 'pgTAP gps_integrations.sql: ' + row.label);
check(gpsTap.length === gpsPlanned, `pgTAP gps_integrations.sql: ran ${gpsTap.length} of plan(${gpsPlanned})`);

// supabase/tests/repairs_stock.sql — той самий shim pgTAP.
const repTapSql = fs.readFileSync(new URL('../../../supabase/tests/repairs_stock.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const repPlanned = Number((repTapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
const repBefore = (await db.query(`SELECT count(*)::int AS n FROM extensions.tap`)).rows[0].n;
await db.exec(repTapSql);
const repTap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows.slice(repBefore);
for (const row of repTap) check(row.ok, 'pgTAP repairs_stock.sql: ' + row.label);
check(repTap.length === repPlanned, `pgTAP repairs_stock.sql: ran ${repTap.length} of plan(${repPlanned})`);

// supabase/tests/repairs_maintenance.sql — той самий shim pgTAP.
const mTapSql = fs.readFileSync(new URL('../../../supabase/tests/repairs_maintenance.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const mPlanned = Number((mTapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
const mBefore = (await db.query(`SELECT count(*)::int AS n FROM extensions.tap`)).rows[0].n;
await db.exec(mTapSql);
const mTap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows.slice(mBefore);
for (const row of mTap) check(row.ok, 'pgTAP repairs_maintenance.sql: ' + row.label);
check(mTap.length === mPlanned, `pgTAP repairs_maintenance.sql: ran ${mTap.length} of plan(${mPlanned})`);

// supabase/tests/kp_documents.sql — той самий shim pgTAP і заглушка Storage.
const dTapSql = fs.readFileSync(new URL('../../../supabase/tests/kp_documents.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const dPlanned = Number((dTapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
const dBefore = (await db.query(`SELECT count(*)::int AS n FROM extensions.tap`)).rows[0].n;
await db.exec(dTapSql);
const dTap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows.slice(dBefore);
for (const row of dTap) check(row.ok, 'pgTAP kp_documents.sql: ' + row.label);
check(dTap.length === dPlanned, `pgTAP kp_documents.sql: ran ${dTap.length} of plan(${dPlanned})`);
// Міграція поверх даних документів: дані на місці.
const docsBefore = (await one(`SELECT count(*)::int AS n FROM public.kp_documents`)).n;
await db.exec(docsSql);
check(docsBefore > 0 && (await one(`SELECT count(*)::int AS n FROM public.kp_documents`)).n === docsBefore,
    'documents: the migration re-applied over data keeps the documents');

// supabase/tests/kp_docs_ttn.sql — той самий shim pgTAP і заглушка Storage.
const tTapSql = fs.readFileSync(new URL('../../../supabase/tests/kp_docs_ttn.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION.*$/m, '').replace(/^ROLLBACK;\s*$/m, 'COMMIT;');
const tPlanned = Number((tTapSql.match(/SELECT plan\((\d+)\)/) || [])[1]);
const tBefore = (await db.query(`SELECT count(*)::int AS n FROM extensions.tap`)).rows[0].n;
await db.exec(tTapSql);
const tTap = (await db.query(`SELECT ok, label FROM extensions.tap ORDER BY n`)).rows.slice(tBefore);
for (const row of tTap) check(row.ok, 'pgTAP kp_docs_ttn.sql: ' + row.label);
check(tTap.length === tPlanned, `pgTAP kp_docs_ttn.sql: ran ${tTap.length} of plan(${tPlanned})`);
// Міграція поверх даних ТТН: дані на місці, нові колонки авто не скидаються.
const ttnBefore = (await one(`SELECT count(*)::int AS n, (SELECT count(*)::int FROM public.fleet_vehicles WHERE tare_t IS NOT NULL) AS v FROM public.kp_doc_ttn`));
await db.exec(ttnSql);
const ttnAfter = (await one(`SELECT count(*)::int AS n, (SELECT count(*)::int FROM public.fleet_vehicles WHERE tare_t IS NOT NULL) AS v FROM public.kp_doc_ttn`));
check(ttnBefore.n > 0 && ttnBefore.v > 0 && ttnAfter.n === ttnBefore.n && ttnAfter.v === ttnBefore.v,
    'waybills: the migration re-applied over data keeps waybills and vehicle fields');

// Пакет 28.10: деталі водія (персональні дані) і підпис акта. Усі дані вигадані.
{
    const detailsSql = fs.readFileSync(new URL('20261028100100_kp_driver_details.sql', DIR), 'utf8');
    const signSql = fs.readFileSync(new URL('20261028100000_kp_act_signatures.sql', DIR), 'utf8');
    await db.exec(detailsSql);
    await db.exec(signSql);
    check(true, 'batch: both migrations re-applied (idempotent)');
    const driver = (await user(OA)(`SELECT public.kp_driver_save(NULL, 'Іваненко Іван Петрович', 'AB123456', true) AS id`));
    check(driver.ok, 'drivers: owner adds a driver', driver.message);
    const did = driver.rows[0].id;
    const save = (who, ipn, passport = 'AB123456', phone = '+380 67 123-45-67', address = 'м. Луцьк') =>
        user(who)(`SELECT public.kp_driver_details_save($1, $2, $3, $4, $5) AS ok`, [did, phone, passport, ipn, address]);
    const ok = await save(OA, '1234567890');
    check(ok.ok && ok.rows[0].ok === true, 'driver details: owner saves phone, passport, IPN, address', ok.message);
    const stored = await one(`SELECT phone, passport, ipn, address FROM public.kp_driver_details WHERE driver_id = $1`, [did]);
    check(stored.phone === '+380671234567' && stored.passport === 'AB123456' && stored.ipn === '1234567890', 'driver details: values are normalised (phone without spaces, passport upper case)', JSON.stringify(stored));
    for (const [label, args, code] of [
        ['IPN of 9 digits', ['123456789'], /DRIVER_BAD_IPN/],
        ['IPN of 11 digits', ['12345678901'], /DRIVER_BAD_IPN/],
        ['IPN with letters', ['12345a7890'], /DRIVER_BAD_IPN/],
        ['bad passport', ['1234567890', 'A1'], /DRIVER_BAD_PASSPORT/],
        ['bad phone', ['1234567890', 'AB123456', '12-34'], /DRIVER_BAD_PHONE/],
    ]) {
        const bad = await save(OA, ...args);
        check(!bad.ok && code.test(bad.message), 'driver details: ' + label + ' is refused', bad.message);
    }
    const emptyOk = await save(OA, '', '', '', '');
    check(emptyOk.ok, 'driver details: empty values clear the fields', emptyOk.message);
    await save(OA, '1234567890');
    const logistWrite = await save(LA, '1234567890');
    check(!logistWrite.ok && logistWrite.code === '42501', 'driver details: a logist cannot edit (owner only)', logistWrite.message);
    const dirWrite = await save(DIR1, '1234567890');
    check(!dirWrite.ok && dirWrite.code === '42501', 'driver details: a director cannot edit', dirWrite.message);
    for (const [who, label] of [[OA, 'owner'], [LA, 'logist'], [DIR1, 'director']]) {
        const read = await user(who)(`SELECT * FROM public.kp_driver_details_get($1)`, [did]);
        check(read.ok && read.rows.length === 1 && read.rows[0].ipn === '1234567890', 'driver details: ' + label + ' of the organisation reads', read.message);
    }
    const foreign = await user(OC)(`SELECT * FROM public.kp_driver_details_get($1)`, [did]);
    check(!foreign.ok && /DRIVER_NOT_FOUND/.test(foreign.message), 'driver details: another organisation cannot read through the RPC', foreign.message);
    const noPlan = await user(OB)(`SELECT * FROM public.kp_driver_details_get($1)`, [did]);
    check(!noPlan.ok && noPlan.code === '42501', 'driver details: an organisation without Контроль+ is refused', noPlan.message);
    // RLS на самій таблиці: свої бачать, чужі — ні, пряма зміна заборонена всім клієнтам.
    check((await user(LA)(`SELECT count(*)::int AS n FROM public.kp_driver_details`)).rows[0].n === 1, 'driver details RLS: a member sees the rows of its own organisation');
    check((await user(OC)(`SELECT count(*)::int AS n FROM public.kp_driver_details`)).rows[0].n === 0, 'driver details RLS: a foreign organisation sees nothing');
    for (const [label, sql] of [
        ['INSERT', `INSERT INTO public.kp_driver_details (driver_id, org_id, ipn) VALUES ('${did}', '${A}', '1234567890')`],
        ['UPDATE', `UPDATE public.kp_driver_details SET ipn = '0000000000'`],
        ['DELETE', `DELETE FROM public.kp_driver_details`],
    ]) {
        for (const [who, name] of [[OA, 'owner'], [LA, 'logist']]) {
            const direct = await user(who)(sql);
            check(!direct.ok && direct.code === '42501', 'driver details RLS: direct ' + label + ' by ' + name + ' is refused', direct.message);
        }
    }
    // У ТТН потрапляють лише ПІБ і посвідчення.
    const listed = await user(OA)(`SELECT to_jsonb(d) AS j FROM public.kp_driver_list(false) AS d`);
    check(listed.ok && listed.rows.length >= 1 && listed.rows.every((r) => !('phone' in r.j) && !('ipn' in r.j) && !('passport' in r.j) && !('address' in r.j)),
        'driver details: kp_driver_list (the waybill source) exposes no personal fields', listed.message);
    // Підпис акта: лише власник; чужі й тарифи без Контроль+ — ні.
    const ghost = '77777777-7777-4777-8777-777777777777';
    const logistSign = await user(LA)(`SELECT public.kp_doc_sign($1, true)`, [ghost]);
    check(!logistSign.ok && logistSign.code === '42501', 'act signature: a logist cannot sign', logistSign.message);
    const ownerSign = await user(OA)(`SELECT public.kp_doc_sign($1, true)`, [ghost]);
    check(!ownerSign.ok && /DOC_NOT_FOUND/.test(ownerSign.message), 'act signature: the owner passes the role gate (unknown document)', ownerSign.message);
    const signedList = await user(LA)(`SELECT * FROM public.kp_doc_signed(ARRAY[$1::uuid])`, [ghost]);
    check(signedList.ok && signedList.rows.length === 0, 'act signature: members read the signed list', signedList.message);
    const signedDirect = await user(OA)(`SELECT * FROM public.kp_document_signatures`);
    check(!signedDirect.ok && signedDirect.code === '42501', 'act signature: no direct table access for clients', signedDirect.message);
}

// Пакет 28.10 (правка E): причепи — окрема таблиця fleet_trailers. Усі дані вигадані.
{
    const trailersSql = fs.readFileSync(new URL('20261028110000_kp_fleet_trailers.sql', DIR), 'utf8');
    const T1 = '20000000-0000-4000-8000-0000000000e1', T2 = '20000000-0000-4000-8000-0000000000e2', T3 = '20000000-0000-4000-8000-0000000000e3';
    // «Старі» дані: тягачі з причепом у колонках trailer_* без зв'язку (тригер дзеркала вимкнено, як було до міграції).
    await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await db.exec('ALTER TABLE public.fleet_vehicles DISABLE TRIGGER trg_fleet_vehicles_trailer_sync');
    await db.exec(`INSERT INTO public.fleet_vehicles (id, org_id, label, trailer_plate, trailer_type, trailer_make_model) VALUES ('${T1}', '${A}', 'TR-1', 'АА 1234 ХХ', 'тент', 'Schmitz'), ('${T2}', '${A}', 'TR-2', 'AA1234XX', 'тент', 'Schmitz'), ('${T3}', '${A}', 'TR-3', NULL, 'зерновоз', NULL)`);
    await db.exec('ALTER TABLE public.fleet_vehicles ENABLE TRIGGER trg_fleet_vehicles_trailer_sync');
    await db.exec(trailersSql);
    await db.exec(trailersSql);
    check(true, 'trailers: migration re-applied (idempotent)');
    const moved = (await service(`SELECT count(*)::int AS n FROM public.fleet_trailers WHERE org_id = $1 AND plate_norm = 'AA1234XX'`, [A])).rows[0].n;
    check(moved === 1, 'trailers: the same trailer written in two spellings is moved once', String(moved));
    const links = (await service(`SELECT count(*)::int AS n FROM public.fleet_vehicles WHERE id IN ('${T1}', '${T2}') AND default_trailer_id IS NOT NULL`)).rows[0].n;
    check(links === 2, 'trailers: both tractors keep the link to the moved trailer', String(links));
    const bare = (await service(`SELECT default_trailer_id FROM public.fleet_vehicles WHERE id = '${T3}'`)).rows[0].default_trailer_id;
    check(bare === null, 'trailers: a tractor without a trailer gets no link');
    const mirror = await one(`SELECT trailer_plate, trailer_type, trailer_make_model FROM public.fleet_vehicles WHERE id = $1`, [T1]);
    check(mirror.trailer_plate === 'АА 1234 ХХ' && mirror.trailer_make_model === 'Schmitz', 'trailers: legacy columns are kept (nothing is lost)', JSON.stringify(mirror));
    const tid = (await service(`SELECT default_trailer_id AS id FROM public.fleet_vehicles WHERE id = '${T1}'`)).rows[0].id;

    // RLS: свої читають, чужі — ні, пише лише власник.
    check((await user(LA)(`SELECT count(*)::int AS n FROM public.fleet_trailers`)).rows[0].n >= 1, 'trailers RLS: a member of the organisation reads');
    check((await user(OC)(`SELECT count(*)::int AS n FROM public.fleet_trailers`)).rows[0].n === 0, 'trailers RLS: a foreign organisation sees nothing');
    const logistInsert = await user(LA)(`INSERT INTO public.fleet_trailers (org_id, plate) VALUES ('${A}', 'LL0001')`);
    check(!logistInsert.ok, 'trailers RLS: a logist cannot add a trailer', logistInsert.message);
    const logistPlate = await user(LA)(`UPDATE public.fleet_trailers SET plate = 'ZZ9999' WHERE id = $1`, [tid]);
    check(!logistPlate.ok, 'trailers RLS: a logist cannot change the plate', logistPlate.message);
    const logistMake = await user(LA)(`SELECT public.kp_trailer_save($1, '{"make_model":"Krone","capacity_t":"28"}'::jsonb) AS ok`, [tid]);
    check(logistMake.ok && logistMake.rows[0].ok === true, 'trailers: a logist edits the waybill fields (make, capacity)', logistMake.message);
    const foreignSave = await user(OC)(`SELECT public.kp_trailer_save($1, '{"make_model":"X"}'::jsonb)`, [tid]);
    check(!foreignSave.ok, 'trailers: another organisation cannot save', foreignSave.message);
    const ownerInsert = await user(OA)(`INSERT INTO public.fleet_trailers (org_id, plate, type) VALUES ('${A}', 'BB 0007 BB', 'цистерна') RETURNING id`);
    check(ownerInsert.ok, 'trailers RLS: the owner adds a trailer', ownerInsert.message);
    const dup = await user(OA)(`INSERT INTO public.fleet_trailers (org_id, plate) VALUES ('${A}', 'ВВ0007ВВ')`);
    check(!dup.ok, 'trailers: a duplicate plate (normalised) is refused', dup.message);

    // Вибір причепа в тягача (калькулятор / ТТН беруть його з нової таблиці) і «Відчепити».
    const listed = await user(OA)(`SELECT * FROM public.kp_vehicles_list() WHERE id = $1`, [T1]);
    check(listed.ok && listed.rows[0].trailer_make_model === 'Krone', 'trailers: kp_vehicles_list (the waybill source) shows the trailer from fleet_trailers', listed.message || JSON.stringify(listed.rows[0]));
    const viaSite = await one(`SELECT trailer_make_model FROM public.fleet_vehicles WHERE id = $1`, [T2]);
    check(viaSite.trailer_make_model === 'Krone', 'trailers: a change of the trailer reaches every tractor mirror (site calculator, prefill)', JSON.stringify(viaSite));
    const tl = await user(OA)(`SELECT * FROM public.kp_trailers_list() WHERE id = $1`, [tid]);
    check(tl.ok && tl.rows[0].vehicle_ids.length === 2 && tl.rows[0].capacity_t == 28, 'trailers: kp_trailers_list returns the trailer with its tractors', tl.message);
    const detach = await user(OA)(`UPDATE public.fleet_vehicles SET default_trailer_id = NULL WHERE id = $1`, [T1]);
    const detached = await one(`SELECT default_trailer_id, trailer_plate FROM public.fleet_vehicles WHERE id = $1`, [T1]);
    check(detach.ok && detached.default_trailer_id === null && detached.trailer_plate === null, 'trailers: «Відчепити» clears the link and the mirror', detach.message);
    const attach = await user(OA)(`UPDATE public.fleet_vehicles SET default_trailer_id = $2 WHERE id = $1`, [T1, tid]);
    const attached = await one(`SELECT trailer_plate, trailer_make_model FROM public.fleet_vehicles WHERE id = $1`, [T1]);
    check(attach.ok && attached.trailer_plate === 'АА 1234 ХХ' && attached.trailer_make_model === 'Krone', 'trailers: choosing a trailer fills the tractor mirror', attach.message);
    const foreignAttach = await user(OA)(`UPDATE public.fleet_vehicles SET default_trailer_id = '20000000-0000-4000-8000-0000000000ff' WHERE id = $1`, [T1]);
    check(!foreignAttach.ok && /TRAILER_NOT_FOUND|violates foreign key/i.test(foreignAttach.message), 'trailers: an unknown / foreign trailer cannot be attached', foreignAttach.message);
    // Запис через стару картку авто на сайті потрапляє в нову таблицю.
    const oldCard = await user(OA)(`UPDATE public.fleet_vehicles SET trailer_plate = 'CC 5555 CC', trailer_type = 'рефрижератор' WHERE id = $1`, [T3]);
    const created = await one(`SELECT ft.type FROM public.fleet_vehicles fv JOIN public.fleet_trailers ft ON ft.id = fv.default_trailer_id WHERE fv.id = $1`, [T3]);
    check(oldCard.ok && created && created.type === 'рефрижератор', 'trailers: the old vehicle card writes through to fleet_trailers', oldCard.message);

    // Деактивація справді вимикає причіп.
    const off = await user(OA)(`UPDATE public.fleet_trailers SET active = false WHERE id = $1`, [tid]);
    const left = (await one(`SELECT count(*)::int AS n FROM public.fleet_vehicles WHERE default_trailer_id = $1 OR trailer_plate = 'АА 1234 ХХ'`, [tid])).n;
    check(off.ok && left === 0, 'trailers: deactivation detaches the trailer from every tractor', off.message || String(left));
    const reattach = await user(OA)(`UPDATE public.fleet_vehicles SET default_trailer_id = $2 WHERE id = $1`, [T1, tid]);
    check(!reattach.ok && /TRAILER_NOT_FOUND/.test(reattach.message), 'trailers: an inactive trailer cannot be chosen', reattach.message);

    // Старий шлях (колонки trailer_*): два тягачі з одним причепом оновлюються разом, номер — в одному написанні.
    const V5 = '20000000-0000-4000-8000-0000000000e5', V6 = '20000000-0000-4000-8000-0000000000e6';
    await service(`INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('${V5}', '${A}', 'TR-5'), ('${V6}', '${A}', 'TR-6')`);
    const twin = (await user(OA)(`INSERT INTO public.fleet_trailers (org_id, plate, type, make_model) VALUES ('${A}', 'KK 1000 KK', 'тент', 'Old') RETURNING id`)).rows[0].id;
    await user(OA)(`UPDATE public.fleet_vehicles SET default_trailer_id = $1 WHERE id IN ('${V5}', '${V6}')`, [twin]);
    const mirrorOf = async (id) => one(`SELECT trailer_plate, trailer_type, trailer_make_model FROM public.fleet_vehicles WHERE id = $1`, [id]);
    const renameCard = await user(OA)(`UPDATE public.fleet_vehicles SET trailer_make_model = 'NewMake', trailer_plate = 'KK 2000 KK' WHERE id = $1`, [V5]);
    const m6 = await mirrorOf(V6);
    const tr = await one(`SELECT plate, make_model FROM public.fleet_trailers WHERE id = $1`, [twin]);
    check(renameCard.ok && tr.plate === 'KK 2000 KK' && tr.make_model === 'NewMake', 'trailers sync: a change of make and plate on the old card renames the trailer', renameCard.message || JSON.stringify(tr));
    check(m6.trailer_plate === 'KK 2000 KK' && m6.trailer_make_model === 'NewMake', 'trailers sync: the second tractor with the same trailer gets the new plate and make', JSON.stringify(m6));
    await user(OA)(`UPDATE public.fleet_vehicles SET trailer_plate = 'кк-2000-кк' WHERE id = $1`, [V5]);
    const same = [await mirrorOf(V5), await mirrorOf(V6)];
    check(same.every((m) => m.trailer_plate === 'KK 2000 KK'), 'trailers sync: every tractor keeps the one stored spelling of the plate', JSON.stringify(same));
    const logistOld = await user(LA)(`SELECT public.kp_vehicle_save($1, '{"trailer_make_model":"LogistMake"}'::jsonb) AS ok`, [V5]);
    const afterLogist = [await mirrorOf(V6), await one(`SELECT make_model FROM public.fleet_trailers WHERE id = $1`, [twin])];
    check(logistOld.ok && afterLogist[0].trailer_make_model === 'LogistMake' && afterLogist[1].make_model === 'LogistMake', 'trailers sync: a logist changing the make (kp_vehicle_save) reaches the trailer and the other tractor', logistOld.message);
    const logistPlateOld = await user(LA)(`UPDATE public.fleet_vehicles SET trailer_plate = 'ZZ 0000 ZZ' WHERE id = $1 RETURNING id`, [V5]);
    check(!logistPlateOld.ok || logistPlateOld.rows.length === 0, 'trailers sync: a logist cannot change the plate on the old card (RLS of the site: owner only, no row is changed)', logistPlateOld.message);
    const stillOld = await one(`SELECT plate FROM public.fleet_trailers WHERE id = $1`, [twin]);
    check(stillOld.plate === 'KK 2000 KK', 'trailers sync: the refused change left the trailer untouched');

    // Перенос: різна марка в тягачів з одним номером — береться найсвіжіша, вирівнюються всі.
    const V7 = '20000000-0000-4000-8000-0000000000e7', V8 = '20000000-0000-4000-8000-0000000000e8';
    await db.exec('ALTER TABLE public.fleet_vehicles DISABLE TRIGGER USER');
    await service(`INSERT INTO public.fleet_vehicles (id, org_id, label, trailer_plate, trailer_type, trailer_make_model, updated_at) VALUES ('${V7}', '${A}', 'TR-7', 'MM 3000 MM', 'тент', 'Stale', '2026-01-01'), ('${V8}', '${A}', 'TR-8', 'MM3000MM', 'цистерна', 'Fresh', '2026-10-01')`);
    await db.exec('ALTER TABLE public.fleet_vehicles ENABLE TRIGGER USER');
    await db.exec(trailersSql);
    const aligned = [await mirrorOf(V7), await mirrorOf(V8)];
    check(aligned.every((m) => m.trailer_make_model === 'Fresh' && m.trailer_type === 'цистерна' && m.trailer_plate === 'MM3000MM'),
        'trailers migration: different makes for one number → the freshest wins and all tractors are aligned', JSON.stringify(aligned));

    // Відкат із шапки міграції: прибирає таблицю, колонку, тригери й усі функції; дані в trailer_* лишаються.
    const rbLines = trailersSql.split(String.fromCharCode(10));
    const rbFrom = rbLines.findIndex((l) => l === '--   BEGIN;');
    const rbTo = rbLines.findIndex((l) => l === '--   COMMIT;');
    const rollback = rbLines.slice(rbFrom, rbTo + 1).map((l) => l.slice(5)).join(String.fromCharCode(10));
    check(/BEGIN;/.test(rollback) && /COMMIT;/.test(rollback) && /kp_plate_norm/.test(rollback) && /fleet_trailers_guard/.test(rollback) && /fleet_vehicles_trailer_sync/.test(rollback) && /fleet_trailers_after/.test(rollback),
        'trailers rollback: the header block removes the helper functions too');
    const keep = (await one(`SELECT count(*)::int AS n FROM public.fleet_vehicles WHERE trailer_plate IS NOT NULL`)).n;
    await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    // Подорожній лист (20261029100000) посилається на fleet_trailers: відкат причепів — після відкату листів.
    await db.exec('DROP TABLE IF EXISTS public.kp_doc_trip_sheet');
    await db.exec(rollback);
    const gone = await one(`SELECT (SELECT count(*)::int FROM pg_proc WHERE proname IN ('kp_plate_norm', 'fleet_trailers_guard', 'fleet_vehicles_trailer_sync', 'fleet_trailers_after', 'kp_trailers_list', 'kp_trailer_save')) AS fns, to_regclass('public.fleet_trailers') AS tbl, (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'fleet_vehicles' AND column_name = 'default_trailer_id') AS col`);
    check(gone.fns === 0 && gone.tbl === null && gone.col === 0, 'trailers rollback: table, column, triggers and functions are gone', JSON.stringify(gone));
    check((await one(`SELECT count(*)::int AS n FROM public.fleet_vehicles WHERE trailer_plate IS NOT NULL`)).n === keep, 'trailers rollback: the trailer data stays in the tractor columns');
    await db.exec(trailersSql);
    await db.exec(fs.readFileSync(new URL('20261029100000_kp_trip_sheets.sql', DIR), 'utf8'));
    await db.exec(fs.readFileSync(new URL('20261030091000_kp_trip_sheet_followups.sql', DIR), 'utf8'));
    const back = (await one(`SELECT count(*)::int AS n FROM public.fleet_trailers WHERE org_id = $1`, [A])).n;
    check(back >= 3, 'trailers rollback: re-applying the migration rebuilds fleet_trailers from the kept columns', String(back));
}

// Подорожній лист (kp_doc_trip_sheet, 20261029100000). Усі дані вигадані.
{
    const tsSql = fs.readFileSync(new URL('20261029100000_kp_trip_sheets.sql', DIR), 'utf8');
    await db.exec(tsSql);
    check(true, 'trip sheet: migration re-applied (idempotent)');
    await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await db.exec(`INSERT INTO public.kp_org_requisites (org_id, legal_name, edrpou) VALUES ('${A}', 'ТОВ Перевізник', '12345678') ON CONFLICT (org_id) DO NOTHING`);
    const TSV = '20000000-0000-4000-8000-0000000000c1';
    await service(`INSERT INTO public.fleet_vehicles (id, org_id, label, make_model, fuel_load, fuel_empty) VALUES ('${TSV}', '${A}', 'TS 0001 TS', 'DAF XF', 30, 20)`);
    const trl = (await user(OA)(`INSERT INTO public.fleet_trailers (org_id, plate, make_model) VALUES ('${A}', 'TS 0002 TS', 'Schmitz') RETURNING id`)).rows[0].id;
    const drv = (await user(OA)(`SELECT public.kp_driver_save(NULL, 'Петренко Петро Петрович', 'BB654321', true) AS id`)).rows[0].id;
    await user(OA)(`SELECT public.kp_driver_details_save($1, '+380671112233', 'AB123456', '1234567890', 'м. Київ')`, [drv]);
    const calcOk = '30000000-0000-4000-8000-0000000000c1', calcDraft = '30000000-0000-4000-8000-0000000000c2';
    await service(`INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status, trip_date) VALUES ('${calcOk}', '${A}', '${OA}', 'Луцьк — Одеса', '{"origin":"Луцьк","destination":"Одеса","base":"Рівне","dist":500,"podachaDist":40,"rate":900,"fuelLoad":30,"fuelEmpty":20,"daysPerTrip":3,"routeVariant":{"index":1}}'::jsonb, '{}'::jsonb, 'accepted', '2026-10-28'), ('${calcDraft}', '${A}', '${OA}', 'Чернетка', '{"origin":"A","destination":"B"}'::jsonb, '{}'::jsonb, 'draft', '2026-10-28')`);
    await service(`INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage) VALUES ('${calcOk}', '${TSV}', 22)`);
    await service(`UPDATE public.fleet_vehicles SET default_trailer_id = $2, default_driver_id = $3 WHERE id = $1`, [TSV, trl, drv]);
    const body = (over = {}) => JSON.stringify({
        series: 'ПЛ-', valid_from: '2026-10-28', valid_to: '2026-10-30', driver: { id: drv, phone: '+380000000000', passport: 'ZZ999999', ipn: '0000000000', address: 'hack' },
        vehicle_id: TSV, trailer_id: trl, vehicle: { fuel_load: 30, fuel_empty: 20 },
        task: { customer: 'Агро', route_from: 'Луцьк', route_to: 'Одеса', via: ['Рівне'], cargo: 'Пшениця', tonnage: 22, loaded_km: 300 },
        depart: { at: '2026-10-28T06:00:00+03:00', odometer: 100000, fuel_left: 80, fuel_issued: 200, fuel_kind: 'ДП' },
        medical: { by: 'Мед. пункт', at: '2026-10-28T05:30:00+03:00' }, tech: { by: 'Механік Іваненко', at: '2026-10-28T05:40:00+03:00', ok: true }, ...over,
    });
    const create = (who, over, calc = null, date = '2026-10-28') => user(who)(`SELECT public.kp_trip_sheet_create($1::date, NULL, $2::jsonb, $3::uuid) AS id`, [date, body(over), calc]);

    const c1 = await create(OA);
    check(c1.ok, 'trip sheet: the owner issues', c1.message);
    const c2 = await create(LA);
    check(c2.ok, 'trip sheet: the logist issues', c2.message);
    const nums = (await service(`SELECT number FROM public.kp_doc_trip_sheet WHERE org_id = $1 ORDER BY number`, [A])).rows.map((r) => r.number);
    check(nums.join() === '1,2', 'trip sheet: own numbering 1, 2 (separate from invoices / acts / TTN)', nums.join());
    check((await service(`SELECT count(*)::int AS n FROM public.kp_doc_counters WHERE org_id = $1 AND kind = 'trip_sheet'`, [A])).rows[0].n === 1, 'trip sheet: its own counter kind');
    const dirNo = await create(DIR1);
    check(!dirNo.ok && dirNo.code === '42501', 'trip sheet: a director cannot issue', dirNo.message);
    check((await service(`SELECT count(*)::int AS n FROM public.kp_doc_trip_sheet WHERE org_id = $1`, [A])).rows[0].n === 2, 'trip sheet: a refused issue leaves no row and does not shift the counter');
    const sheet = (await user(DIR1)(`SELECT public.kp_trip_sheet_get($1) AS d`, [c1.rows[0].id])).rows[0].d;
    check(sheet && sheet.number_text === 'ПЛ-1' && sheet.status === 'issued', 'trip sheet: a director reads', JSON.stringify(sheet && sheet.number_text));
    check(JSON.stringify(Object.keys(sheet.driver).sort()) === '["full_name","license_no"]' && !/380|AB123456|1234567890|hack|ZZ999999/.test(JSON.stringify(sheet)),
        'trip sheet: no phone / passport / IPN / address in the snapshot', JSON.stringify(sheet.driver));
    check(sheet.vehicle.trailer_reg_number === 'TS 0002 TS' && sheet.vehicle.trailer_make_model === 'Schmitz', 'trip sheet: the trailer comes from fleet_trailers');
    const foreign = await user(OC)(`SELECT public.kp_trip_sheet_get($1)`, [c1.rows[0].id]);
    check(!foreign.ok && /DOC_NOT_FOUND/.test(foreign.message), 'trip sheet: another organisation cannot read', foreign.message);
    check((await user(OC)(`SELECT count(*)::int AS n FROM public.kp_trip_sheet_list('2026-10-01', '2026-10-31')`)).rows[0].n === 0, 'trip sheet: another organisation sees an empty list');
    const direct = await user(OA)(`SELECT * FROM public.kp_doc_trip_sheet`);
    check(!direct.ok && direct.code === '42501', 'trip sheet: no direct table access for clients', direct.message);

    // Незмінність знімка: шапка, ТЗ, водій, завдання; DELETE заборонено (навіть сервісній ролі).
    for (const [label, sql] of [
        ['driver', `UPDATE public.kp_doc_trip_sheet SET driver = '{"full_name":"X","license_no":"Y"}'::jsonb WHERE id = $1`],
        ['vehicle', `UPDATE public.kp_doc_trip_sheet SET vehicle = '{"make_model":"X","reg_number":"Y"}'::jsonb WHERE id = $1`],
        ['task', `UPDATE public.kp_doc_trip_sheet SET task = '{"route_from":"X","route_to":"Y"}'::jsonb WHERE id = $1`],
        ['header', `UPDATE public.kp_doc_trip_sheet SET valid_to = valid_to + 1 WHERE id = $1`],
        ['departure', `UPDATE public.kp_doc_trip_sheet SET depart_odometer = 1 WHERE id = $1`],
        ['delete', `DELETE FROM public.kp_doc_trip_sheet WHERE id = $1`],
    ]) {
        const r = await service(sql, [c1.rows[0].id]);
        check(!r.ok && /DOC_IMMUTABLE|DOC_DELETE_FORBIDDEN/.test(r.message), 'trip sheet: ' + label + ' is frozen after issue', r.message);
    }

    // Закриття: пробіг, фактична й нормативна витрата.
    const close = (who, data, id = c1.rows[0].id) => user(who)(`SELECT public.kp_trip_sheet_close($1, $2::jsonb) AS r`, [id, JSON.stringify(data)]);
    const back = { return_at: '2026-10-30T20:00:00+03:00', return_odometer: 100500, return_fuel_left: 70 };
    check(/TS_ODOMETER_DECREASE/.test((await close(OA, { ...back, return_odometer: 99999 })).message), 'trip sheet: the return odometer cannot be below the departure one');
    check(/TS_RETURN_BEFORE_DEPART/.test((await close(OA, { ...back, return_at: '2026-10-28T05:00:00+03:00' })).message), 'trip sheet: the return cannot be before the departure');
    check(/TS_FIELD_REQUIRED:return_fuel_left/.test((await close(OA, { return_at: back.return_at, return_odometer: 100500 })).message), 'trip sheet: the fuel balance on return is required');
    check(!(await close(DIR1, back)).ok, 'trip sheet: a director cannot close');
    const closed = await close(LA, back);
    const cr = closed.ok ? closed.rows[0].r : null;
    check(closed.ok && cr.distance_km === 500 && Number(cr.fuel_actual) === 210 && Number(cr.fuel_norm) === 130 && Number(cr.fuel_diff) === 80,
        'trip sheet: mileage 500, actual 80 + 200 − 70 = 210, norm 300 × 30% + 200 × 20% = 130, overrun 80', closed.message || JSON.stringify(cr));
    check(/TS_NOT_ISSUED/.test((await close(OA, back)).message), 'trip sheet: a closed sheet cannot be closed again');
    const afterClose = await service(`UPDATE public.kp_doc_trip_sheet SET return_odometer = 100600 WHERE id = $1`, [c1.rows[0].id]);
    check(!afterClose.ok && /DOC_IMMUTABLE/.test(afterClose.message), 'trip sheet: a closed sheet is frozen', afterClose.message);
    check(/TS_CLOSED_IMMUTABLE/.test((await user(OA)(`SELECT public.kp_trip_sheet_cancel($1, 'помилка')`, [c1.rows[0].id])).message), 'trip sheet: a closed sheet cannot be cancelled');

    // Анулювання: лише власник, з причиною; номер лишається.
    check(!(await user(LA)(`SELECT public.kp_trip_sheet_cancel($1, 'тест')`, [c2.rows[0].id])).ok, 'trip sheet: a logist cannot cancel');
    check(/DOC_CANCEL_REASON/.test((await user(OA)(`SELECT public.kp_trip_sheet_cancel($1, '  ')`, [c2.rows[0].id])).message), 'trip sheet: the cancel reason is required');
    check((await user(OA)(`SELECT public.kp_trip_sheet_cancel($1, 'Помилкова видача')`, [c2.rows[0].id])).ok, 'trip sheet: the owner cancels with a reason');
    check(/TS_NOT_ISSUED/.test((await close(OA, back, c2.rows[0].id)).message), 'trip sheet: a cancelled sheet cannot be closed');
    const c3 = await create(OA);
    const n3 = (await service(`SELECT number FROM public.kp_doc_trip_sheet WHERE id = $1`, [c3.rows[0].id])).rows[0].number;
    check(n3 === 3, 'trip sheet: the number of a cancelled sheet is not reused', String(n3));
    const lst = await user(DIR1)(`SELECT status, count(*)::int AS n FROM public.kp_trip_sheet_list('2026-10-01', '2026-10-31') GROUP BY status ORDER BY status`);
    check(lst.ok && lst.rows.map((r) => r.status + ':' + r.n).join() === 'cancelled:1,closed:1,issued:1', 'trip sheet: the list shows all statuses', lst.message);
    check((await user(DIR1)(`SELECT count(*)::int AS n FROM public.kp_trip_sheet_list('2026-10-01', '2026-10-31', 'closed')`)).rows[0].n === 1, 'trip sheet: the status filter works');

    // Доробки 20261030091000: поля повернення зберігаються до закриття, норма без пробігу з вантажем, kp_calc_is_accepted по організації.
    {
        const followSql = fs.readFileSync(new URL('20261030091000_kp_trip_sheet_followups.sql', DIR), 'utf8');
        await db.exec(followSql);
        check(true, 'trip sheet follow-ups: migration re-applied (idempotent)');
        const retId = (await create(OA)).rows[0].id;
        const save = (who, data, id = retId) => user(who)(`SELECT public.kp_trip_sheet_return_save($1, $2::jsonb) AS r`, [id, JSON.stringify(data)]);
        const row = async () => (await service(`SELECT status, return_at, return_odometer, return_fuel_left, distance_km, fuel_norm FROM public.kp_doc_trip_sheet WHERE id = $1`, [retId])).rows[0];
        const part = await save(LA, { return_odometer: 100300 });
        check(part.ok, 'return fields: a logist saves a part of them before closing', part.message);
        let r = await row();
        check(r.status === 'issued' && r.return_odometer === 100300 && r.return_at === null && r.distance_km === null, 'return fields: the sheet stays issued, no mileage is counted yet', JSON.stringify(r));
        const more = await save(OA, { return_at: '2026-10-30T18:00:00+03:00', return_odometer: 100400, return_fuel_left: 90 });
        check(more.ok && (await row()).return_odometer === 100400, 'return fields: they can be edited again while the sheet is issued', more.message);
        check(/TS_ODOMETER_DECREASE/.test((await save(OA, { return_odometer: 99999 })).message), 'return fields: the odometer cannot be below the departure one');
        check(/TS_RETURN_BEFORE_DEPART/.test((await save(OA, { return_at: '2026-10-28T05:00:00+03:00' })).message), 'return fields: the return cannot be before the departure');
        check(/TS_FUEL_NEGATIVE/.test((await save(OA, { return_fuel_left: 4000 })).message), 'return fields: the balance cannot exceed the fuel there was');
        check(!(await save(DIR1, { return_odometer: 100500 })).ok, 'return fields: a director cannot save them');
        const direct = await service(`UPDATE public.kp_doc_trip_sheet SET depart_odometer = 5 WHERE id = $1`, [retId]);
        check(!direct.ok && /DOC_IMMUTABLE/.test(direct.message), 'return fields: other fields of an issued sheet stay frozen', direct.message);
        // Закриття без тіла бере збережене; у листа немає пробігу з вантажем у завданні → норма NULL, а не весь пробіг за нормою з вантажем.
        const noLoaded = await create(OA, { task: { customer: 'Агро', route_from: 'Луцьк', route_to: 'Одеса', cargo: 'Пшениця', tonnage: 22 } });
        const nlId = noLoaded.rows[0].id;
        const closeNl = await user(OA)(`SELECT public.kp_trip_sheet_close($1, $2::jsonb) AS r`, [nlId, JSON.stringify({ return_at: '2026-10-30T20:00:00+03:00', return_odometer: 100500, return_fuel_left: 70 })]);
        check(closeNl.ok && closeNl.rows[0].r.fuel_norm === null && closeNl.rows[0].r.fuel_diff === null && closeNl.rows[0].r.distance_km === 500,
            'fuel norm: without loaded km it is NULL (not the whole distance at the loaded rate)', closeNl.message || JSON.stringify(closeNl.rows[0] && closeNl.rows[0].r));
        const closeSaved = await user(OA)(`SELECT public.kp_trip_sheet_close($1, '{}'::jsonb) AS r`, [retId]);
        r = await row();
        check(closeSaved.ok && r.status === 'closed' && r.distance_km === 400 && Number(r.fuel_norm) === 110,
            'return fields: closing with an empty body uses the saved fields (400 km, 300 × 30% + 100 × 20% = 110)', closeSaved.message || JSON.stringify(r));
        check(/TS_NOT_ISSUED/.test((await save(OA, { return_odometer: 100450 })).message), 'return fields: a closed sheet cannot be changed');
        const frozen = await service(`UPDATE public.kp_doc_trip_sheet SET return_odometer = 100450 WHERE id = $1`, [retId]);
        check(!frozen.ok && /DOC_IMMUTABLE/.test(frozen.message), 'return fields: a closed sheet is frozen after Close', frozen.message);
        // kp_calc_is_accepted бачить лише свою організацію.
        const mine = await user(OA)(`SELECT public.kp_calc_is_accepted($1) AS a`, [calcOk]);
        const foreignOrg = await user(OC)(`SELECT public.kp_calc_is_accepted($1) AS a`, [calcOk]);
        const svc = await service(`SELECT public.kp_calc_is_accepted($1) AS a`, [calcOk]);
        check(mine.ok && mine.rows[0].a === true && foreignOrg.ok && foreignOrg.rows[0].a === false && svc.rows[0].a === true,
            'kp_calc_is_accepted: true in its own organisation, false for another organisation, service role unchanged', JSON.stringify([mine.rows[0], foreignOrg.rows[0], svc.rows[0]]));
        const foreignCreate = await user(OC)(`SELECT public.kp_trip_sheet_create('2026-10-28'::date, NULL, $1::jsonb, $2::uuid) AS id`, [body(), calcOk]);
        check(!foreignCreate.ok, 'kp_calc_is_accepted: another organisation cannot use the request as a source', foreignCreate.message);
    }

    // Заявка: лише прийнята; звʼязок з рейсом, список за рейсом, видалення рейсу не видаляє лист.
    const draftTry = await create(OA, {}, calcDraft);
    check(!draftTry.ok && /CALC_NOT_ACCEPTED/.test(draftTry.message), 'trip sheet: a draft request cannot be the source', draftTry.message);
    const draftPre = await user(OA)(`SELECT public.kp_calc_doc_prefill($1)`, [calcDraft]);
    check(!draftPre.ok && /CALC_NOT_ACCEPTED/.test(draftPre.message), 'prefill: refused for a request that is not accepted', draftPre.message);
    const pre = await user(LA)(`SELECT public.kp_calc_doc_prefill($1) AS p`, [calcOk]);
    const p = pre.ok ? pre.rows[0].p : null;
    check(pre.ok && p.route.from === 'Луцьк' && p.route.to === 'Одеса' && p.route.base === 'Рівне' && p.route.dist_km === 500 && p.route.feed_km === 40 && p.route.variant.index === 1
        && p.vehicle.reg_number === 'TS 0001 TS' && p.trailer.plate === 'TS 0002 TS' && p.driver.full_name === 'Петренко Петро Петрович'
        && p.cargo.tonnage === 22 && p.cargo.rate === 900 && p.dates.trip_date === '2026-10-28' && p.dates.days === 3 && p.plan_fuel_l === 258,
        'prefill: route, feed, variant, vehicle, trailer, driver, cargo, tariff, dates and the fuel plan come from the accepted request', pre.message || JSON.stringify(p));
    check(!('phone' in p.driver) && !/380|AB123456|1234567890/.test(JSON.stringify(p)), 'prefill: no personal driver data');
    check(!(await user(DIR1)(`SELECT public.kp_calc_doc_prefill($1)`, [calcOk])).ok, 'prefill: a director cannot (read-only role)');
    check(!(await user(OC)(`SELECT public.kp_calc_doc_prefill($1)`, [calcOk])).ok, 'prefill: another organisation cannot');
    const linked = await create(OA, {}, calcOk);
    check(linked.ok, 'trip sheet: issued from an accepted request', linked.message);
    const byCalc = await user(LA)(`SELECT count(*)::int AS n FROM public.kp_trip_sheet_list('2026-10-01', '2026-10-31', NULL, $1)`, [calcOk]);
    check(byCalc.rows[0].n === 1, 'trip sheet: the request card lists its trip sheets', byCalc.message);
    const snap = (await service(`SELECT task FROM public.kp_doc_trip_sheet WHERE id = $1`, [linked.rows[0].id])).rows[0].task;
    await service(`UPDATE public.calculations SET inputs = jsonb_set(inputs, '{destination}', '"Київ"') WHERE id = $1`, [calcOk]);
    const snap2 = (await service(`SELECT task FROM public.kp_doc_trip_sheet WHERE id = $1`, [linked.rows[0].id])).rows[0].task;
    check(JSON.stringify(snap) === JSON.stringify(snap2), 'trip sheet: later changes of the request do not touch the issued sheet');
    await service(`DELETE FROM public.calc_vehicles WHERE calc_id = $1`, [calcOk]);
    await service(`DELETE FROM public.calculation_clients WHERE calculation_id = $1`, [calcOk]);
    await service(`DELETE FROM public.calculations WHERE id = $1`, [calcOk]);
    const kept = await one(`SELECT id, calculation_id FROM public.kp_doc_trip_sheet WHERE id = $1`, [linked.rows[0].id]);
    check(kept && kept.calculation_id === null, 'trip sheet: deleting the request keeps the sheet, the link becomes empty');

    // ТТН з рейсу — лише з прийнятої заявки (тригер на kp_doc_ttn).
    const cl = (await service(`INSERT INTO public.clients (org_id, name) VALUES ('${A}', 'Агро ТТН') RETURNING id`)).rows[0].id;
    const ttnRow = (calc) => `INSERT INTO public.kp_doc_ttn (org_id, number, doc_year, doc_date, client_id, calculation_id, place_of_issue, shipper, carrier, consignee, driver, vehicle, load_point, unload_point, cargo_gross_t, tare_t, total_mass_t) VALUES ('${A}', ${calc ? 9001 : 9002}, 2026, '2026-10-28', '${cl}', ${calc ? "'" + calc + "'" : 'NULL'}, 'Київ', '{}', '{}', '{}', '{}', '{}', 'A', 'B', 10, 5, 15)`;
    const dr2 = '30000000-0000-4000-8000-0000000000c3';
    await service(`INSERT INTO public.calculations (id, org_id, user_id, name, inputs, results, status) VALUES ('${dr2}', '${A}', '${OA}', 'ТТН чернетка', '{}'::jsonb, '{}'::jsonb, 'draft')`);
    const ttnDraft = await service(ttnRow(dr2));
    check(!ttnDraft.ok && /CALC_NOT_ACCEPTED/.test(ttnDraft.message), 'waybill (TTN): a request that is not accepted cannot be the source (server check)', ttnDraft.message);
    await service(`UPDATE public.calculations SET status = 'accepted' WHERE id = '${dr2}'`);
    check((await service(ttnRow(dr2))).ok, 'waybill (TTN): an accepted request is fine');
    check((await service(ttnRow(null))).ok, 'waybill (TTN): without a request nothing changes');

    // Відкат із шапки міграції.
    const tl = tsSql.split(String.fromCharCode(10));
    const rbFrom = tl.findIndex((l) => l === '--   BEGIN;');
    const rbTo = tl.findIndex((l) => l === '--   COMMIT;');
    const rollback = tl.slice(rbFrom, rbTo + 1).map((l) => l.slice(5)).join(String.fromCharCode(10));
    // Спершу блок «Повний відкат» з доробок 20261030091000, потім відкат із шапки 20261029100000.
    const followText = fs.readFileSync(new URL('20261030091000_kp_trip_sheet_followups.sql', DIR), 'utf8');
    const fl = followText.split(String.fromCharCode(10));
    const frFrom = fl.findIndex((l) => l === '--   BEGIN;');
    const frTo = fl.findIndex((l) => l === '--   COMMIT;');
    const followRollback = fl.slice(frFrom, frTo + 1).map((l) => l.slice(5)).join(String.fromCharCode(10));
    await db.exec(followRollback);
    await db.exec(rollback);
    const gone = await one(`SELECT to_regclass('public.kp_doc_trip_sheet') AS tbl, (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'kp_trip_sheet%' OR proname IN ('kp_calc_doc_prefill', 'kp_doc_ttn_calc_accepted', 'kp_calc_is_accepted')) AS fns`);
    check(gone.tbl === null && gone.fns === 0, 'trip sheet rollback: table and functions (kp_calc_is_accepted too) are gone', JSON.stringify(gone));
    await db.exec(tsSql);
    await db.exec(followText);
    check(true, 'trip sheet rollback: both migrations apply again');
}

// Плановий пробіг у SQL (kp_trip_plan_km + розподіл у kp_vehicle_trip_km) = план редактора факту сайту
// (tripFactBasis з api/calculate.js: loadedKm + emptyKm + podachaKm по всіх авто заявки). Сайт лише читаємо.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'check-db';
const { tripFactBasis } = await import('../../../api/calculate.js');
const golden = JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/calc-golden.json', import.meta.url), 'utf8'))[0].payload;
const PV = ['20000000-0000-4000-8000-0000000000f1', '20000000-0000-4000-8000-0000000000f2', '20000000-0000-4000-8000-0000000000f3'];
await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
await db.exec(`INSERT INTO public.fleet_vehicles (id, org_id, label) VALUES ('${PV[0]}', '${A}', 'PV-1'), ('${PV[1]}', '${A}', 'PV-2'), ('${PV[2]}', '${A}', 'PV-3')`);
const planCases = [
    ['cyclic, two vehicles, own payloads, feed 35 km', { podachaDist: 35, vehicles: [{ id: PV[0], tonnage: 70, payloadTons: 25 }, { id: PV[1], tonnage: 56, payloadTons: 21 }] }],
    ['cyclic, payload missing → calculator norm', { vehicles: [{ id: PV[0], tonnage: 40 }, { id: PV[1], tonnage: 86, payloadTons: 30 }] }],
    ['one-off, three vehicles, feed 18.5 km', { returnMode: 'разовий', podachaDist: 18.5, vehicles: [{ id: PV[0], tonnage: 20 }, { id: PV[1], tonnage: 22 }, { id: PV[2], tonnage: 25 }] }],
    ['cyclic round trip, cargo split greedily, feed 60 km', { podachaDist: 60, isRoundTrip: true, rtTransferDist: 40, rtBackhaulDist: 300, rtReturnDist: 60, rtTotalVolume: 90, rtRate: 500,
        vehicles: [{ id: PV[0], tonnage: 42, payloadTons: 21 }, { id: PV[1], tonnage: 63, payloadTons: 21 }, { id: PV[2], tonnage: 21, payloadTons: 21 }] }],
    ['one-off round trip', { returnMode: 'разовий', isRoundTrip: true, rtTransferDist: 0, rtBackhaulDist: 250, rtReturnDist: 30, rtTotalVolume: 30, rtRate: 400,
        vehicles: [{ id: PV[1], tonnage: 22 }, { id: PV[0], tonnage: 24 }] }],
];
for (const [index, [name, extra]] of planCases.entries()) {
    const body = { ...golden, ...extra };
    const basis = tripFactBasis(body);
    const day = `2027-01-${String(index * 2 + 2).padStart(2, '0')}`;
    const calc = (await db.query(`INSERT INTO public.calculations (org_id, user_id, name, inputs, results, status, trip_date)
        VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, 'accepted', $5::date) RETURNING id`, [A, OA, 'Plan ' + name, JSON.stringify(body), day])).rows[0].id;
    for (const v of body.vehicles) {
        await db.query(`INSERT INTO public.calc_vehicles (calc_id, vehicle_id, tonnage, snapshot) VALUES ($1, $2, $3, $4::jsonb)`,
            [calc, v.id, v.tonnage, JSON.stringify(v.payloadTons ? { resolved: { payloadTons: v.payloadTons } } : {})]);
    }
    const sql = (await db.query(`SELECT sum(public.kp_vehicle_trip_km($1, v, $2::date - 1, $2::date))::float AS km FROM unnest($3::uuid[]) AS v`,
        [A, day, body.vehicles.map((v) => v.id)])).rows[0].km;
    const js = basis.loadedKm + basis.emptyKm + basis.podachaKm;
    check(!basis.status && Math.abs(sql - js) < 0.2 * body.vehicles.length, `trip km: SQL plan = tripFactBasis (${name}): ${sql} vs ${js}`);
    // Подача — один раз на авто заявки (computeTrip у зрізі: podachaDist × carsCount, carsCount = 1).
    check(basis.podachaKm === (Number(body.podachaDist) || 0) * body.vehicles.length, `trip km: feed = podachaDist × vehicles (${name}): ${basis.podachaKm}`);
}
// Погоджений варіант маршруту (20261030090000): пише лише сервіс, клієнт ні вставити, ні змінити не може.
{
    const variantSql = fs.readFileSync(new URL('20261030090000_calc_approved_variant.sql', DIR), 'utf8');
    await db.exec(variantSql);
    check(true, 'approved variant: migration re-applied (idempotent)');
    const forged = await user(OA)(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results, approved_variant)
        VALUES ($1, $2, 'Підробка', '{}'::jsonb, '{}'::jsonb, '{"index":1,"km":1}'::jsonb) RETURNING id, approved_variant`, [OA, A]);
    check(forged.ok && forged.rows[0].approved_variant === null, 'approved variant: an INSERT by the client cannot set it', forged.message);
    const variantCalc = forged.rows[0].id;
    const clientUpdate = await user(OA)(`UPDATE public.calculations SET approved_variant = '{"index":0}'::jsonb WHERE id = $1`, [variantCalc]);
    check(!clientUpdate.ok && clientUpdate.code === '42501', 'approved variant: the client cannot update it (no column grant)', clientUpdate.message);
    const svc = await service(`UPDATE public.calculations SET approved_variant = '{"index":1,"km":844,"logistIndex":0}'::jsonb WHERE id = $1 RETURNING approved_variant`, [variantCalc]);
    check(svc.ok && svc.rows[0].approved_variant.index === 1, 'approved variant: the service writes it', svc.message);
    const badShape = await service(`UPDATE public.calculations SET approved_variant = '[1]'::jsonb WHERE id = $1`, [variantCalc]);
    check(!badShape.ok, 'approved variant: only a JSON object is accepted', badShape.message);
    const tooBig = await service(`UPDATE public.calculations SET approved_variant = jsonb_build_object('x', repeat('a', 5000)) WHERE id = $1`, [variantCalc]);
    check(!tooBig.ok, 'approved variant: a huge value is refused', tooBig.message);
    // Зміна inputs / results сервісом (інший вибір директора) перераховує distance_km і profit у тригері історії.
    const recalc = await service(`UPDATE public.calculations SET inputs = '{"dist":844,"podachaDist":40}'::jsonb, results = '{"netProfit":4400}'::jsonb WHERE id = $1 RETURNING distance_km, profit`, [variantCalc]);
    check(recalc.ok && Number(recalc.rows[0].distance_km) === 884 && Number(recalc.rows[0].profit) === 4400, 'approved variant: km and profit follow the approved variant', recalc.message || JSON.stringify(recalc.rows));
    await service(`DELETE FROM public.calculations WHERE id = $1`, [variantCalc]);
}
// Кабінет директора (20261031090000): права учасників на сервері і сповіщення директору.
{
    const cabinetSql = fs.readFileSync(new URL('20261031090000_director_cabinet.sql', DIR), 'utf8');
    // Попередні блоки перевиконували 4a / 4b: наша міграція йде останньою, як і на проді (двічі — ідемпотентність).
    await db.exec(cabinetSql);
    await db.exec(cabinetSql);
    check(/^-- Apply manually after review\. This file is not applied to production by the agent\./.test(cabinetSql)
        && /РУЧНИЙ ВІДКАТ/.test(cabinetSql), 'director cabinet: migration re-applied (idempotent), manual-apply header and manual rollback');
    const denied = (r) => !r.ok && r.code === '42501' && /MEMBER_PERMISSION_DENIED/.test(r.message);
    const setPerm = (who, patch) => service(
        `INSERT INTO public.org_member_permissions (org_id, user_id, can_acts, can_sign, can_fleet, can_clients, can_contracts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, user_id) DO UPDATE SET can_acts = $3, can_sign = $4, can_fleet = $5, can_clients = $6, can_contracts = $7`,
        [A, who, patch.acts ?? true, patch.sign ?? false, patch.fleet ?? true, patch.clients ?? true, patch.contracts ?? true]);
    const can = async (who, perm) => (await user(who)(`SELECT public.member_can($1) AS ok`, [perm])).rows[0].ok;

    // Значення за замовчуванням: усе дозволено, крім підпису й печатки; власник завжди все.
    for (const perm of ['acts', 'fleet', 'clients', 'contracts']) check(await can(LA, perm) === true, 'director cabinet: a logist without a row can ' + perm);
    check(await can(LA, 'sign') === false, 'director cabinet: a logist without a row cannot use the signature and stamp by default');
    for (const perm of ['acts', 'sign', 'fleet', 'clients', 'contracts']) check(await can(OA, perm) === true, 'director cabinet: the owner can ' + perm);
    check((await user(LA)(`SELECT public.member_can('nonsense') AS ok`)).rows[0].ok === false, 'director cabinet: an unknown permission is refused');

    // Таблиця прав: свій рядок — логісту, всі рядки організації — директору, клієнт напряму не пише.
    await setPerm(LA, { sign: true });
    await setPerm(LA2, {});
    check((await user(LA)(`SELECT count(*)::int AS n FROM public.org_member_permissions`)).rows[0].n === 1, 'director cabinet RLS: a logist sees only its own permissions row');
    check((await user(OA)(`SELECT count(*)::int AS n FROM public.org_member_permissions`)).rows[0].n === 2, 'director cabinet RLS: the owner sees the rows of its organisation');
    check((await user(OC)(`SELECT count(*)::int AS n FROM public.org_member_permissions`)).rows[0].n === 0, 'director cabinet RLS: another organisation sees nothing');
    for (const [who, name] of [[OA, 'owner'], [LA, 'logist']]) {
        const w = await user(who)(`UPDATE public.org_member_permissions SET can_sign = true`);
        check(!w.ok && w.code === '42501', 'director cabinet RLS: direct UPDATE by the ' + name + ' is refused', w.message);
        const i = await user(who)(`INSERT INTO public.org_member_permissions (org_id, user_id) VALUES ($1, $2)`, [A, OA]);
        check(!i.ok && i.code === '42501', 'director cabinet RLS: direct INSERT by the ' + name + ' is refused', i.message);
    }

    // Клієнти і договори: перевірка в тригері, тож ховання в інтерфейсі нічого не вирішує.
    await setPerm(LA, { clients: false, sign: true });
    const noClient = await user(LA)(`INSERT INTO public.clients (org_id, name) VALUES ($1, 'Без права') RETURNING id`, [A]);
    check(denied(noClient), 'director cabinet: a logist without "add clients" gets 403 on INSERT', noClient.message);
    await setPerm(LA, { clients: true, contracts: false, sign: true });
    const plainClient = await user(LA)(`INSERT INTO public.clients (org_id, name) VALUES ($1, 'Клієнт логіста') RETURNING id`, [A]);
    check(plainClient.ok, 'director cabinet: with "add clients" a logist adds a client', plainClient.message);
    const contractClient = await user(LA)(`INSERT INTO public.clients (org_id, name, contract_no) VALUES ($1, 'З договором', 'Д-1') RETURNING id`, [A]);
    check(denied(contractClient), 'director cabinet: a logist without "contracts" cannot create a client with a contract', contractClient.message);
    const editContract = await user(LA)(`UPDATE public.clients SET contract_no = 'Д-2', payment_terms_days = 10 WHERE id = $1`, [plainClient.rows[0].id]);
    check(denied(editContract), 'director cabinet: a logist without "contracts" cannot change contract fields', editContract.message);
    const rename = await user(LA)(`UPDATE public.clients SET name = 'Перейменовано' WHERE id = $1 RETURNING name`, [plainClient.rows[0].id]);
    check(rename.ok && rename.rows.length === 1, 'director cabinet: other client fields stay editable without "contracts"', rename.message);
    const ownerContract = await user(OA)(`UPDATE public.clients SET contract_no = 'Д-3', contract_date = DATE '2026-10-01' WHERE id = $1 RETURNING contract_no`, [plainClient.rows[0].id]);
    check(ownerContract.ok && ownerContract.rows.length === 1, 'director cabinet: the owner always works with contracts', ownerContract.message);
    await setPerm(LA, { sign: true });
    const withContract = await user(LA)(`UPDATE public.clients SET payment_terms_days = 12 WHERE id = $1 RETURNING payment_terms_days`, [plainClient.rows[0].id]);
    check(withContract.ok && withContract.rows.length === 1, 'director cabinet: with "contracts" a logist changes the contract terms', withContract.message);
    const clientId = plainClient.rows[0].id;

    // Автопарк: kp_vehicle_save (логіст пише ТТН-колонки) і прямі зміни.
    const veh = await service(`INSERT INTO public.fleet_vehicles (org_id, label) VALUES ($1, 'AA1234BB') RETURNING id`, [A]);
    check(veh.ok, 'director cabinet: fixture vehicle created', veh.message);
    const vehId = veh.rows[0] && veh.rows[0].id;
    await setPerm(LA, { fleet: false, sign: true });
    const noFleet = await user(LA)(`SELECT public.kp_vehicle_save($1, '{"vehicle_type":"Тягач сідловий"}'::jsonb)`, [vehId]);
    check(denied(noFleet), 'director cabinet: a logist without "edit fleet" gets 403 from kp_vehicle_save', noFleet.message);
    await setPerm(LA, { fleet: true, sign: true });
    const okFleet = await user(LA)(`SELECT public.kp_vehicle_save($1, '{"vehicle_type":"Тягач сідловий"}'::jsonb)`, [vehId]);
    check(okFleet.ok, 'director cabinet: with "edit fleet" a logist saves the vehicle', okFleet.message);
    const ownerFleet = await user(OA)(`UPDATE public.fleet_vehicles SET label = 'AA1234BB' WHERE id = $1 RETURNING id`, [vehId]);
    check(ownerFleet.ok && ownerFleet.rows.length === 1, 'director cabinet: the owner edits the fleet', ownerFleet.message);

    // Реквізити з підписом і печаткою + документи.
    const REQ = JSON.stringify({ legal_name: 'ТОВ «Тест Перевезення»', legal_form: 'tov', edrpou: '12345678', vat_payer: false, iban: 'UA21 3223 1300 0002 6007 2335 6600 1',
        bank_name: 'АТ «Тест Банк»', legal_address: 'м. Київ, вул. Тестова, 1', signer_name: 'Петренко Петро', signer_position: 'Директор', doc_place: 'м. Київ',
        invoice_prefix: 'РФ-', act_prefix: 'АКТ-', default_currency: 'UAH', default_vat_mode: 'net',
        signature_path: A + '/signature.png', stamp_path: A + '/stamp.png' });
    await service(`INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', $1), ('kp-doc-assets', $2)`, [A + '/signature.png', A + '/stamp.png']);
    const saved = await user(OA)(`SELECT public.kp_requisites_save($1::jsonb)`, [REQ]);
    check(saved.ok, 'director cabinet: the owner saves the requisites with a signature and a stamp', saved.message);
    const lines = JSON.stringify([{ title: 'Послуга', qty: 1, price: 100 }]);
    const assetsFor = async (who) => (await user(who)(`SELECT signature_path AS s, stamp_path AS t FROM public.kp_doc_assets_source()`)).rows[0];
    check((await assetsFor(OA)).s === A + '/signature.png', 'director cabinet: the owner gets the signature file for a new document');

    await setPerm(LA, { acts: false, sign: true });
    const noAct = await user(LA)(`SELECT public.kp_doc_create('act', $1, DATE '2026-10-10', 'UAH', NULL, $2::jsonb)`, [clientId, lines]);
    check(denied(noAct), 'director cabinet: a logist without "create acts" gets 403 on an act', noAct.message);
    const invoiceOk = await user(LA)(`SELECT public.kp_doc_create('invoice', $1, DATE '2026-10-10', 'UAH', NULL, $2::jsonb, NULL, NULL, NULL, NULL, NULL, $3)`,
        [clientId, lines, '99000000-0000-4000-8000-000000000001']);
    check(!invoiceOk.ok && !/MEMBER_PERMISSION_DENIED/.test(invoiceOk.message), '"create acts" does not block invoices (the next error is only the missing file copy)', invoiceOk.message);

    // Без права на підпис: файли не віддаються, акт створюється без підпису й печатки, сповіщення немає.
    await setPerm(LA, { acts: true, sign: false });
    const src = await assetsFor(LA);
    check(src.s === null && src.t === null, 'director cabinet: without "signature" the assets source returns no files', JSON.stringify(src));
    const unsigned = await user(LA)(`SELECT public.kp_doc_create('act', $1, DATE '2026-10-10', 'UAH', NULL, $2::jsonb) AS id`, [clientId, lines]);
    check(unsigned.ok, 'director cabinet: without "signature" a logist still creates an act', unsigned.message);
    const unsignedSeller = (await service(`SELECT seller FROM public.kp_documents WHERE id = $1`, [unsigned.rows[0].id])).rows[0].seller;
    check(unsignedSeller.signature_path === null && unsignedSeller.stamp_path === null, 'director cabinet: the act carries neither signature nor stamp');
    check((await service(`SELECT count(*)::int AS n FROM public.org_notifications WHERE kind = 'signature_used'`)).rows[0].n === 0, 'director cabinet: no notification when the signature is not used');

    // З правом: копії знімків (їх кладе /api/docs/assets), документ із підписом, сповіщення директору.
    await setPerm(LA, { acts: true, sign: true });
    const docId = '99000000-0000-4000-8000-0000000000aa';
    await service(`INSERT INTO storage.objects (bucket_id, name) VALUES ('kp-doc-assets', $1), ('kp-doc-assets', $2)`,
        [A + '/docs/' + docId + '/signature.png', A + '/docs/' + docId + '/stamp.png']);
    const signed = await user(LA)(`SELECT public.kp_doc_create('act', $1, DATE '2026-10-11', 'UAH', NULL, $2::jsonb, NULL, NULL, NULL, NULL, NULL, $3) AS id`, [clientId, lines, docId]);
    check(signed.ok && signed.rows[0].id === docId, 'director cabinet: with "signature" a logist creates a signed act', signed.message);
    const sigNote = (await service(`SELECT kind, ref_kind, ref_id, actor_id, meta, read_at FROM public.org_notifications WHERE kind = 'signature_used'`)).rows;
    check(sigNote.length === 1 && sigNote[0].ref_kind === 'document' && sigNote[0].ref_id === docId && sigNote[0].actor_id === LA
        && sigNote[0].meta.doc_kind === 'act' && sigNote[0].read_at === null,
    'director cabinet: using the signature writes one notification (who, which document, unread)', JSON.stringify(sigNote));
    const ownerDoc = await user(OA)(`SELECT public.kp_doc_create('act', $1, DATE '2026-10-12', 'UAH', NULL, $2::jsonb) AS id`, [clientId, lines]);
    check(!ownerDoc.ok && /DOC_ASSETS_NOT_COPIED/.test(ownerDoc.message), 'director cabinet: the owner keeps the original asset-copy rule', ownerDoc.message);

    // Відправка заявки на погодження → сповіщення; вхід від директора — ні.
    const calc = await service(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results) VALUES ($1, $2, 'Київ — Львів', '{}'::jsonb, '{}'::jsonb) RETURNING id`, [LA, A]);
    const calcId = calc.rows[0].id;
    const submit = await user(LA)(`UPDATE public.calculations SET status = 'pending' WHERE id = $1 RETURNING status`, [calcId]);
    check(submit.ok && submit.rows[0].status === 'pending', 'director cabinet: the logist submits the request for approval', submit.message);
    const pend = (await service(`SELECT kind, ref_kind, ref_id, actor_id, meta FROM public.org_notifications WHERE kind = 'approval_pending'`)).rows;
    check(pend.length === 1 && pend[0].ref_kind === 'calculation' && pend[0].ref_id === calcId && pend[0].actor_id === LA && pend[0].meta.name === 'Київ — Львів',
        'director cabinet: submitting for approval writes a notification on the server', JSON.stringify(pend));
    const ownerCalc = await service(`INSERT INTO public.calculations (user_id, org_id, name, inputs, results) VALUES ($1, $2, 'Власна', '{}'::jsonb, '{}'::jsonb) RETURNING id`, [OA, A]);
    await user(OA)(`UPDATE public.calculations SET status = 'pending' WHERE id = $1`, [ownerCalc.rows[0].id]);
    check((await service(`SELECT count(*)::int AS n FROM public.org_notifications WHERE kind = 'approval_pending'`)).rows[0].n === 1, 'director cabinet: the owner submitting its own request does not notify itself');
    await service(`UPDATE public.calculations SET status = 'pending' WHERE id = $1`, [calcId]);
    check((await service(`SELECT count(*)::int AS n FROM public.org_notifications WHERE kind = 'approval_pending'`)).rows[0].n === 1, 'director cabinet: a repeated write of the same status does not duplicate the notification');

    // Читання сповіщень: лише директор своєї організації; клієнт нічого не пише.
    check((await user(OA)(`SELECT count(*)::int AS n FROM public.org_notifications`)).rows[0].n === 2, 'director cabinet RLS: the owner reads the notifications of its organisation');
    check((await user(LA)(`SELECT count(*)::int AS n FROM public.org_notifications`)).rows[0].n === 0, 'director cabinet RLS: a logist sees no notifications');
    check((await user(OC)(`SELECT count(*)::int AS n FROM public.org_notifications`)).rows[0].n === 0, 'director cabinet RLS: another organisation sees no notifications');
    for (const [label, sql] of [
        ['INSERT', `INSERT INTO public.org_notifications (org_id, kind) VALUES ('${A}', 'signature_used')`],
        ['UPDATE', `UPDATE public.org_notifications SET read_at = now()`],
        ['DELETE', `DELETE FROM public.org_notifications`],
    ]) {
        for (const [who, name] of [[OA, 'owner'], [LA, 'logist']]) {
            const direct = await user(who)(sql);
            check(!direct.ok && direct.code === '42501', 'director cabinet RLS: direct ' + label + ' by the ' + name + ' is refused', direct.message);
        }
    }
    const callNotify = await user(OA)(`SELECT public.org_notify($1, 'signature_used', NULL, NULL, NULL, '{}'::jsonb)`, [A]);
    check(!callNotify.ok && callNotify.code === '42501', 'director cabinet: org_notify is not callable from the client', callNotify.message);
    const badKind = await service(`INSERT INTO public.org_notifications (org_id, kind) VALUES ($1, 'nonsense')`, [A]);
    check(!badKind.ok, 'director cabinet: an unknown notification kind is refused', badKind.message);
    const marked = await service(`UPDATE public.org_notifications SET read_at = now(), read_by = $1 WHERE kind = 'approval_pending' RETURNING read_at`, [OA]);
    check(marked.ok && marked.rows[0].read_at, 'director cabinet: the service marks a notification as read', marked.message);
}
await db.query(`SELECT set_config('request.jwt.claims', '', false)`);

if (failed) {
    console.log(failed + ' Контроль+ DB check(s) failed');
    process.exit(1);
}
console.log('all Контроль+ DB checks passed');
