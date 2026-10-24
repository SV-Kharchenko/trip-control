import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261021090000_security_grants.sql');
const code = sql.replace(/^\s*--.*$/gm, '');

test('migration: the guard runs before any change and stops on a policy / view / invoker function using a closed helper', () => {
    const guard = code.indexOf("FOREACH v_fn IN ARRAY ARRAY['current_org_role', 'current_is_approved', 'is_admin', 'my_org_id'] LOOP");
    assert.ok(guard > 0);
    for (const change of ['REVOKE', 'GRANT', 'CREATE OR REPLACE FUNCTION', 'ALTER FUNCTION']) {
        const first = code.indexOf(change);
        assert.ok(first > guard, change + ' comes after the guard');
    }
    const block = code.slice(guard, code.indexOf('END;', guard));
    for (const source of ['pg_catalog.pg_policies', 'pg_catalog.pg_views', 'NOT f.prosecdef']) assert.ok(block.includes(source), source);
    assert.match(block, /RAISE EXCEPTION 'public\.%\(\) is still used by: % — not closing it for authenticated'/);
});

test('migration: a) trigger functions, b) helpers kept / closed, c) touch_route_template, d) search_path', () => {
    assert.match(code, /'public\.audit_org_company_profiles\(\)',\n\s+'public\.calculations_enforce_owner_and_demo_limit\(\)',\n\s+'public\.enforce_demo_save_limit\(\)'\n\s+\] LOOP\n[\s\S]*?REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
    assert.match(code, /'public\.current_org_id\(\)',\n\s+'public\.is_org_owner\(\)',\n\s+'public\.is_platform_admin\(\)',\n\s+'public\.is_user_blocked\(\)',\n\s+'public\.org_logists_see_all\(\)'\n\s+\] LOOP\n[\s\S]*?REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_fn\);\n\s+EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn\);/);
    assert.match(code, /'public\.current_org_role\(\)',\n\s+'public\.current_is_approved\(\)',\n\s+'public\.is_admin\(\)',\n\s+'public\.my_org_id\(\)'\n\s+\] LOOP\n[\s\S]*?REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn\);\n\s+EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn\);/);
    // Production-only functions are skipped where they do not exist.
    assert.match(code, /IF pg_catalog\.to_regprocedure\(v_fn\) IS NOT NULL THEN/);

    const touch = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.touch_route_template(p_id uuid)'), code.indexOf('REVOKE ALL ON FUNCTION public.touch_route_template'));
    assert.match(touch, /SECURITY DEFINER\nSET search_path = ''/);
    assert.match(touch, /v_org := public\.current_org_id\(\);/);
    assert.match(touch, /WHERE id = p_id\n\s+AND org_id = v_org\n\s+AND \(scope = 'company' OR owner_user_id = auth\.uid\(\)\)/);
    assert.match(code, /GRANT EXECUTE ON FUNCTION public\.touch_route_template\(uuid\) TO authenticated;/);

    for (const fn of ['is_service_role()', 'tc_num(p jsonb, k text)']) {
        const body = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.' + fn));
        assert.match(body.slice(0, 300), /SET search_path = ''/, fn);
    }
    assert.match(code, /EXECUTE format\('ALTER FUNCTION %s SET search_path = %L', v_fn\.sig, ''\);/);
    // Signatures built as schema.name(arguments), not oid::regprocedure.
    assert.equal(/::(pg_catalog\.)?regprocedure/.test(code), false);
    assert.equal((code.match(/format\('%I\.%I\(%s\)', n\.nspname, f\.proname, pg_catalog\.pg_get_function_identity_arguments\(f\.oid\)\)/g) || []).length, 2);
    assert.match(code, /EXECUTE 'SELECT public\.ua_today\(\)::date' INTO v_check;/);
});

test('earlier migrations are not edited by this change', () => {
    let changed = '';
    try {
        // New migration files are fine; edited, renamed or deleted earlier ones are not.
        changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=a', 'origin/main', '--', 'supabase/migrations'], { cwd: root, encoding: 'utf8' });
    } catch (e) {
        return; // no git / no origin in this checkout
    }
    // Єдині дозволені винятки: міграцію перейменовано на версію, під якою її записано на проді, з тим самим вмістом
    // (той самий git blob, що й у origin/main під старою назвою).
    const RENAMES = [
        ['supabase/migrations/20261023090000_trip_fact_v2.sql', 'supabase/migrations/20261023091124_trip_fact_v2.sql'],
        ['supabase/migrations/20261024090000_gps_integrations.sql', 'supabase/migrations/20261024111415_gps_integrations.sql'],
    ];
    const sameBlob = (from, to) => {
        try {
            return execFileSync('git', ['rev-parse', 'origin/main:' + from], { cwd: root, encoding: 'utf8' }).trim()
                === execFileSync('git', ['hash-object', to], { cwd: root, encoding: 'utf8' }).trim();
        } catch (e) {
            return false;
        }
    };
    const edited = changed.split('\n').filter(Boolean).filter((f) => !f.endsWith('20261021090000_security_grants.sql'))
        .filter((f) => !RENAMES.some(([from, to]) => (f === from || f === to) && sameBlob(from, to)));
    assert.deepEqual(edited, []);
});

test('no service_role key, secret key or JWT secret in anything the browser gets', () => {
    let files = [];
    try {
        files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (e) {
        files = ['index.html', '404.html', 'legal/offer.html', 'legal/privacy.html', 'legal/payment-refund.html'];
    }
    // Served as static files: everything outside the server code, tests, scripts, SQL and docs.
    // apps/ is a separate Vercel project (.vercelignore keeps it off the site) with its own secrets test.
    const client = files.filter((f) => !/^(api|lib|tests|scripts|supabase|docs|apps|node_modules)\//.test(f)
        && /\.(html|js|mjs|css|json|webmanifest|txt|xml|svg)$/.test(f) && f !== 'package.json' && f !== 'package-lock.json' && f !== 'vercel.json');
    assert.ok(client.includes('index.html') && client.some((f) => f.startsWith('assets/')));
    for (const file of client) {
        const text = read(file);
        assert.equal(/service_role|SERVICE_ROLE|sb_secret_|JWT_SECRET|jwt_secret/.test(text), false, file);
        for (const token of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g) || []) {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
            assert.notEqual(payload.role, 'service_role', file);
        }
    }
    // The browser gets the publishable key only.
    assert.match(read('index.html'), /const SUPABASE_ANON_KEY = 'sb_publishable_[A-Za-z0-9_-]+';/);
    // Server code never puts env values into a response.
    for (const file of files.filter((f) => /^(api|lib)\/.*\.js$/.test(f))) {
        assert.equal(/\.(json|send)\([^)]*process\.env/.test(read(file)), false, file);
    }
});

test('security grants on Postgres (PGlite): all migrations replayed, scenarios after the change', (t) => {
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-security-grants.mjs', import.meta.url))], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const line of [
        'guard: a policy still using current_is_approved() stops the migration',
        'demo: the 4th save is refused by the demo limit (not a permission error)',
        'demo: 5 calculations a day, the 6th refused',
        'team: logist sees all with logists_see_all (org_logists_see_all in RLS)',
        'c) templates: another company cannot touch it (TEMPLATE_NOT_FOUND)',
        'company profile: audit trigger still writes security_audit_log',
        'payments: owner sees the payment',
        'b) authenticated cannot call current_is_approved() (42501)'
    ]) assert.ok(run.stdout.includes('PASS ' + line), line);
});

test('404 at 360–430px: the same horizontal logo and spacing as the sign-in card; other widths unchanged', () => {
    const html = read('404.html');
    const media = html.slice(html.indexOf('@media (min-width: 360px) and (max-width: 430px) {'), html.indexOf('</style>'));
    assert.match(media, /body \{ padding: 24px 20px; \}/);
    assert.match(media, /main \{ padding: 28px; \}/);
    assert.match(media, /main img, p\.brand \{ display: none; \}/);
    assert.match(media, /\.brand-lockup \{ display: block; height: 52px; width: auto; max-width: 100%; margin: 0 auto 14px; \}/);
    assert.match(html, /\.brand-lockup \{ display: none; \}/);
    // Same lockup as the sign-in card (index.html .tc-lockup--auth), dark colours as on the dark theme.
    assert.match(html, /<svg class="brand-lockup" viewBox="0 0 330 64" role="img" aria-label="TRIP-CONTROL">/);
    assert.match(html, /<tspan fill="#f2ede4">TRIP<\/tspan><tspan fill="#d8c3a0">CONTROL<\/tspan>/);
    assert.match(read('index.html'), /\.tc-lockup--auth \.tc-logo-svg \{ height: 52px; margin: 0 auto; \}/);
    assert.match(read('index.html'), /\.tc-lockup--auth \{\n\s+display: flex; justify-content: center; width: 100%;\n\s+margin: 0 auto 14px; gap: 10px;/);
    // Rules outside the media query are as before.
    assert.match(html, /border-radius: 18px; padding: 32px 28px 26px;/);
    assert.match(html, /padding: 24px; font-family: 'IBM Plex Sans', sans-serif;/);
    assert.match(html, /main img \{ display: block; width: 56px; height: 56px; margin: 0 auto; \}/);
    assert.match(html, /family=Manrope:wght@600/);
});

test('privacy: Google Fonts sees the visitor IP', () => {
    const privacy = read('legal/privacy.html');
    assert.match(privacy, /<td>Google LLC \(Google Fonts\)<\/td>\n<td>шрифти сторінок сайту<\/td>\n<td>IP-адреса й технічні дані браузера \(запит до fonts\.googleapis\.com і fonts\.gstatic\.com під час відкриття сторінки\)<\/td>/);
    assert.match(privacy, /Шрифти сторінок завантажуються з Google Fonts \(fonts\.googleapis\.com, fonts\.gstatic\.com\), тому під час відкриття сторінки Google отримує IP-адресу вашого пристрою та технічні дані браузера\./);
    // Rows of the recipients table alternate odd / even.
    const table = privacy.slice(privacy.indexOf('<td>Supabase Inc.</td>') - 40, privacy.indexOf('</tbody>', privacy.indexOf('<td>Supabase Inc.</td>')));
    const classes = table.match(/<tr class="(odd|even)">/g).map((tr) => tr.slice(11, -2));
    assert.ok(classes.length >= 9);
    classes.forEach((c, i) => assert.equal(c, i % 2 ? 'even' : 'odd', 'row ' + (i + 1)));
});
