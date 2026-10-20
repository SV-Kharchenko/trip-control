// Checks supabase/migrations/20261018100000_legal_consents.sql on a real Postgres
// (PGlite, in memory). The auth schema is a stub; on_auth_user_created_tripcontrol
// stands in for handle_new_tripcontrol_user (creates the profile and company).
// Nothing touches Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/check-legal-consents.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const migration = fs.readFileSync(process.argv[2] || new URL('../supabase/migrations/20261018100000_legal_consents.sql', import.meta.url), 'utf8');
const db = new PGlite();
const VERSION = '2026-10-18';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, org_id uuid REFERENCES public.organizations(id));

-- Stand-in for handle_new_tripcontrol_user (20261012114133_org_roles.sql).
CREATE FUNCTION public.handle_new_tripcontrol_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_org uuid;
BEGIN
  INSERT INTO public.organizations (name) VALUES (coalesce(NEW.raw_user_meta_data ->> 'company_name', 'Компанія')) RETURNING id INTO v_org;
  INSERT INTO public.profiles (id, email, org_id) VALUES (NEW.id, NEW.email, v_org);
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created_tripcontrol AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_tripcontrol_user();
`);

// Twice: the migration must be idempotent.
await db.exec(migration);
await db.exec(migration);

let failed = 0;
function check(ok, label) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed += 1;
}

let n = 0;
async function signup(meta) {
    n += 1;
    const id = '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
    try {
        await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [id, 'u' + n + '@example.com', JSON.stringify(meta)]);
        return { id, ok: true };
    } catch (error) {
        return { id, ok: false, message: String(error.message || error) };
    }
}
async function consentsOf(id) {
    const { rows } = await db.query('SELECT * FROM public.legal_consents WHERE user_id = $1', [id]);
    return rows;
}
async function as(role, user, sql, params = []) {
    await db.exec('RESET ROLE');
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify(user ? { sub: user, role } : { role })]);
    await db.exec('SET ROLE ' + role);
    try {
        const { rows } = await db.query(sql, params);
        return { ok: true, rows };
    } catch (error) {
        return { ok: false, rows: [], message: String(error.message || error), code: error.code };
    } finally {
        await db.exec('RESET ROLE');
    }
}

const consent = { consent_offer_version: VERSION, consent_privacy_version: VERSION };

// 1. Owner signup with both versions: one 'signup' row with the company.
const owner = await signup({ company_name: 'ФОП Тест', work_mode: 'solo', ...consent });
{
    const rows = await consentsOf(owner.id);
    const profile = (await db.query('SELECT org_id FROM public.profiles WHERE id = $1', [owner.id])).rows[0];
    check(owner.ok && rows.length === 1 && rows[0].kind === 'signup' && rows[0].offer_version === VERSION
        && rows[0].privacy_version === VERSION && rows[0].org_id === profile.org_id && rows[0].accepted_at instanceof Date
        && rows[0].user_agent === null && rows[0].payment_id === null,
    'signup with consent versions: one signup row, server time, company from the profile');
}

// 2. Invite signup (invite_id + versions) is recorded the same way.
const logist = await signup({ invite_id: '70000000-0000-0000-0000-000000000001', ...consent });
check(logist.ok && (await consentsOf(logist.id)).length === 1, 'invite signup with consent versions: row written');

// 3. Without versions / with an unknown version: no row, signup still succeeds.
const bare = await signup({ company_name: 'Без згоди' });
check(bare.ok && (await consentsOf(bare.id)).length === 0, 'signup without versions: no row, insert does not fail');
const stale = await signup({ consent_offer_version: '2020-01-01', consent_privacy_version: VERSION });
check(stale.ok && (await consentsOf(stale.id)).length === 0, 'unknown offer version: no row, insert does not fail');
const half = await signup({ consent_offer_version: VERSION });
check(half.ok && (await consentsOf(half.id)).length === 0, 'only one version: no row, insert does not fail');

// 4. A failing consent insert never breaks the signup.
await db.exec(`
CREATE FUNCTION public.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
CREATE TRIGGER boom BEFORE INSERT ON public.legal_consents FOR EACH ROW EXECUTE FUNCTION public.boom();
`);
const broken = await signup(consent);
const brokenProfile = (await db.query('SELECT count(*)::int AS c FROM public.profiles WHERE id = $1', [broken.id])).rows[0];
check(broken.ok && brokenProfile.c === 1 && (await consentsOf(broken.id)).length === 0, 'consent insert error: signup and profile still created');
await db.exec('DROP TRIGGER boom ON public.legal_consents; DROP FUNCTION public.boom();');

// 5. Users read only their own rows and cannot write.
{
    const own = await as('authenticated', owner.id, 'SELECT user_id FROM public.legal_consents');
    check(own.ok && own.rows.length === 1 && own.rows.every((r) => r.user_id === owner.id), 'authenticated sees only own consent rows');
}
{
    const ins = await as('authenticated', owner.id,
        `INSERT INTO public.legal_consents (user_id, kind, offer_version, privacy_version) VALUES ($1, 'payment', $2, $2)`, [owner.id, VERSION]);
    const upd = await as('authenticated', owner.id, `UPDATE public.legal_consents SET offer_version = 'x' WHERE user_id = $1`, [owner.id]);
    const del = await as('authenticated', owner.id, 'DELETE FROM public.legal_consents WHERE user_id = $1', [owner.id]);
    check(!ins.ok && ins.code === '42501' && !upd.ok && upd.code === '42501' && !del.ok && del.code === '42501',
        'authenticated cannot insert / update / delete (42501)');
    check((await consentsOf(owner.id)).length === 1 && (await consentsOf(owner.id))[0].offer_version === VERSION, 'own row unchanged');
}
{
    const anonRead = await as('anon', null, 'SELECT 1 FROM public.legal_consents');
    const anonIns = await as('anon', null,
        `INSERT INTO public.legal_consents (user_id, kind, offer_version, privacy_version) VALUES ($1, 'signup', $2, $2)`, [owner.id, VERSION]);
    check(!anonRead.ok && anonRead.code === '42501' && !anonIns.ok && anonIns.code === '42501', 'anon cannot read or write');
}
{
    const call = await as('authenticated', owner.id, 'SELECT public.record_signup_consent()');
    check(!call.ok, 'record_signup_consent() is not callable by users');
}

// 6. Kind is limited; the user row cascades.
{
    const bad = await db.query(`INSERT INTO public.legal_consents (user_id, kind, offer_version, privacy_version) VALUES ($1, 'other', 'a', 'b')`, [owner.id])
        .then(() => true, () => false);
    check(!bad, "kind other than 'signup' / 'payment' is rejected");
    await db.query('DELETE FROM public.profiles WHERE id = $1', [logist.id]);
    await db.query('DELETE FROM auth.users WHERE id = $1', [logist.id]);
    check((await consentsOf(logist.id)).length === 0, 'deleting the auth user deletes its consent rows');
}
{
    const { rows } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'legal_consents' AND column_name ILIKE '%ip%'`);
    check(rows.length === 0, 'no IP column');
}

// 7. Edition 2026-10-20 (20261020190000_legal_version_2026_10_20.sql, twice): both editions accepted.
{
    const next = fs.readFileSync(new URL('../supabase/migrations/20261020190000_legal_version_2026_10_20.sql', import.meta.url), 'utf8');
    const beforeNext = await signup({ company_name: 'До нової', consent_offer_version: '2026-10-20', consent_privacy_version: '2026-10-20' });
    check(beforeNext.ok && (await consentsOf(beforeNext.id)).length === 0, 'before the edition migration: 2026-10-20 is not recorded');
    await db.exec(next);
    await db.exec(next);
    const fresh = await signup({ company_name: 'Нова', consent_offer_version: '2026-10-20', consent_privacy_version: '2026-10-20' });
    const freshRows = await consentsOf(fresh.id);
    check(fresh.ok && freshRows.length === 1 && freshRows[0].offer_version === '2026-10-20' && freshRows[0].privacy_version === '2026-10-20',
        'edition 2026-10-20: signup consent recorded');
    const old = await signup({ company_name: 'Стара сторінка', ...consent });
    check(old.ok && (await consentsOf(old.id)).length === 1, 'edition 2026-10-18 still accepted during the switch');
    const unknown = await signup({ consent_offer_version: '2026-10-19', consent_privacy_version: '2026-10-19' });
    check(unknown.ok && (await consentsOf(unknown.id)).length === 0, 'edition 2026-10-19: no row, insert does not fail');
}

if (failed) {
    console.log(failed + ' check(s) failed');
    process.exit(1);
}
console.log('all legal consent checks passed');
