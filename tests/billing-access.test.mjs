import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addDaysYmd, hasPaidAccess, isDemoAccess, kyivYmd, loadPaidUntil } from '../lib/billing/access.js';
import { addMonthsUtc, extendPaidUntil, PLANS, planFor } from '../lib/billing/plans.js';
import { usersPage, userCardById } from '../lib/telegram-admin.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const NOW = Date.parse('2026-10-18T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('plans: amounts live on the server only', () => {
    assert.deepEqual([PLANS.month.uah, PLANS.month.minor, PLANS.year.uah, PLANS.year.minor], [250, 25000, 2500, 250000]);
    assert.equal(planFor('week'), null);
    assert.equal(planFor('__proto__'), null);
    assert.equal(Object.isFrozen(PLANS.month), true);
});

test('paid_until = max(now, paid_until) + 1 month / 1 year (end of month like Postgres)', () => {
    assert.equal(extendPaidUntil(null, 'month', NOW).to.toISOString(), '2026-11-18T09:00:00.000Z');
    assert.equal(extendPaidUntil('2026-10-01T00:00:00Z', 'month', NOW).to.toISOString(), '2026-11-18T09:00:00.000Z', 'past → from now');
    assert.equal(extendPaidUntil('2026-12-05T10:00:00Z', 'month', NOW).to.toISOString(), '2027-01-05T10:00:00.000Z', 'future → from paid_until');
    assert.equal(extendPaidUntil('2026-12-05T10:00:00Z', 'year', NOW).to.toISOString(), '2027-12-05T10:00:00.000Z');
    assert.equal(extendPaidUntil('2026-12-05T10:00:00Z', 'year', NOW).from.toISOString(), '2026-12-05T10:00:00.000Z');
    assert.equal(addMonthsUtc('2027-01-31T12:00:00Z', 1).toISOString(), '2027-02-28T12:00:00.000Z');
    assert.equal(addMonthsUtc('2028-01-31T12:00:00Z', 1).toISOString(), '2028-02-29T12:00:00.000Z');
    assert.equal(addMonthsUtc('2028-02-29T12:00:00Z', 12).toISOString(), '2029-02-28T12:00:00.000Z');
    assert.throws(() => extendPaidUntil(null, 'week', NOW));
});

test('demo fallback: after paid_until the company is demo again; manual approval is permanent', () => {
    const until = new Date(NOW + 10 * DAY).toISOString();
    assert.equal(isDemoAccess({ is_approved: false }, until, NOW), false);
    assert.equal(isDemoAccess({ is_approved: false }, until, NOW + 11 * DAY), true);
    assert.equal(isDemoAccess({ is_approved: false }, null, NOW), true);
    assert.equal(isDemoAccess({ is_approved: true }, null, NOW), false);
    assert.equal(isDemoAccess({ is_approved: true }, '2020-01-01T00:00:00Z', NOW), false);
    assert.equal(hasPaidAccess('garbage', NOW), false);
    assert.equal(kyivYmd('2026-10-18T21:30:00Z'), '2026-10-19');
    assert.equal(addDaysYmd('2026-12-30', 3), '2027-01-02');
});

test('api/calculate.js: only the demo check changes; 5 per day limit and formulas stay', async () => {
    const calc = read('api/calculate.js');
    assert.match(calc, /const DEMO_DAILY_LIMIT = 5;/);
    assert.match(calc, /const isDemo = isDemoAccess\(profile, profile\.is_approved \? null : await loadPaidUntil\(supabase, profile\.org_id\)\);/);
    assert.match(calc, /supabase\.rpc\('bump_calc_usage'/);
    assert.equal(calc.includes('!profile.is_approved'), false);
    // loadPaidUntil tolerates a missing table (migration not applied): demo as before.
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42P01' } }) }) }) }) };
    assert.equal(await loadPaidUntil(broken, 'org'), null);
    const throwing = { from: () => { throw new Error('boom'); } };
    assert.equal(await loadPaidUntil(throwing, 'org'), null);
    const ok = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { paid_until: '2027-01-01T00:00:00Z' }, error: null }) }) }) }) };
    assert.equal(await loadPaidUntil(ok, 'org'), '2027-01-01T00:00:00Z');
    process.env.SUPABASE_URL ||= 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
    const { calculateTrip } = await import('../api/calculate.js');
    const s0 = calculateTrip(JSON.parse(read('tests/fixtures/s0-fop.json')));
    assert.equal(s0.netProfit, 6687);
    assert.equal(s0.taxesTotal, 5400);
});

test('client: «Тариф і оплата» screen, owner / logist, consent, no amount sent, polling, banner, footer', () => {
    assert.match(html, /onclick="menuGo\('billing'\)">Тариф і оплата<\/button>/);
    assert.match(html, /else if \(action === 'billing'\) openBillingModal\(\);/);
    const modal = html.slice(html.indexOf('<div id="tc-billing-modal"'), html.indexOf('<div id="tc-toast"'));
    assert.match(modal, /value="month" checked/);
    assert.match(modal, /value="year"/);
    assert.match(modal, /<b>plata by mono<\/b>/);
    assert.match(modal, /<b>WayForPay<\/b>/);
    assert.match(modal, /Apple Pay \/ Google Pay — на сторінці оплати/);
    assert.match(modal, /<input type="checkbox" id="billing-consent">/);
    assert.equal(/billing-consent"[^>]*checked/.test(modal), false);
    const consent = modal.slice(modal.indexOf('<label class="tc-billing-consent">'), modal.indexOf('</label>', modal.indexOf('<label class="tc-billing-consent">')));
    assert.equal(consent.replace(/<[^>]+>/g, '').trim(), 'Погоджуюсь з Публічною офертою та Політикою конфіденційності');
    assert.match(consent, /href="\/offer" target="_blank"/);
    assert.match(consent, /href="\/privacy" target="_blank"/);
    assert.match(modal, /Оплату здійснює власник компанії\./);
    assert.match(modal, /href="\/payment-refund"/);
    assert.match(modal, /id="billing-footer-slot"/);
    // The same legal footer: cloned from the page, not a second copy in the HTML.
    assert.match(html, /const source = document\.querySelector\('#main-app > \.tc-legal-footer'\);\n\s+if \(source\) slot\.appendChild\(source\.cloneNode\(true\)\);/);
    // Only plan / provider / consent go to the server; never a price.
    assert.match(html, /JSON\.stringify\(\{ plan: selectedBillingPlan\(\), provider: providerEl\.value, consent: true, legal_version: LEGAL_VERSION \}\)/);
    assert.match(html, /if \(!consent \|\| !consent\.checked\) \{\n\s+setBillingMessage\('Потрібна згода з Публічною офертою та Політикою конфіденційності\.', 'error'\);/);
    assert.match(html, /location\.href = res\.url;/);
    // isDemo for the UI.
    assert.match(html, /isDemo = !\(profile\.is_approved \|\| billingPaidActive\(billingPaidUntil\)\);/);
    // Return: poll /status every 3 s up to 60 s; ?billing=pay opens the screen.
    assert.match(html, /while \(Date\.now\(\) - started <= 60000\)/);
    assert.match(html, /setTimeout\(resolve, 3000\)/);
    assert.match(html, /billingFetch\('status\?pid=' \+ encodeURIComponent\(pid\)\)/);
    assert.match(html, /if \(mode === 'pay'\) openBillingModal\(\);/);
    // Banner ≤ 3 days before the end.
    assert.match(html, /<div id="billing-banner" class="tc-billing-banner" role="status" hidden>/);
    assert.match(html, /left > 0 && left <= 3 \* 24 \* 3600 \* 1000/);
    // Themes untouched.
    assert.match(html, /const THEME_ORDER = \['light', 'dark'\];/);
});

function telegramFake(paidUntil) {
    const auth = [{ id: 'u1', email: 'owner@agro.ua', created_at: '2026-10-01T08:00:00Z', banned_until: null }];
    const tables = {
        profiles: [{ id: 'u1', org_id: 'o1', role: 'user', is_approved: false, organizations: { org_subscriptions: paidUntil ? { paid_until: paidUntil } : null } }],
        organizations: [{ id: 'o1', name: 'ТОВ Агро', org_subscriptions: paidUntil ? [{ paid_until: paidUntil }] : [] }],
        calculations: []
    };
    const from = (table) => {
        const eq = {};
        const rows = () => (tables[table] || []).filter((r) => Object.entries(eq).every(([k, v]) => r[k] === v));
        const b = {
            select() { return b; }, order() { return b; }, eq(k, v) { eq[k] = v; return b; }, in() { return b; },
            range() { return Promise.resolve({ data: rows(), error: null }); },
            maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
            then(res, rej) { return Promise.resolve({ data: rows(), count: rows().length, error: null }).then(res, rej); }
        };
        return b;
    };
    return { from, auth: { admin: { async listUsers() { return { data: { users: auth }, error: null }; }, async getUserById() { return { data: { user: auth[0] }, error: null }; } } } };
}

test('Telegram /user and /users: a paid company shows «Повний доступ · оплачено до …»; buttons unchanged', async () => {
    const until = new Date(Date.now() + 30 * DAY).toISOString();
    const card = await userCardById(telegramFake(until), 'u1');
    assert.match(card.text, /\nСтатус: Повний доступ · оплачено до \d{2}\.\d{2}\.\d{4}$/);
    assert.deepEqual(card.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data.split(':')[1]), ['full', 'demo', 'blocked']);
    const list = await usersPage(telegramFake(until), 'all', 1, Date.now());
    assert.match(list.text, /1\. owner@agro\.ua · Повний доступ · оплачено до \d{2}\.\d{2}\.\d{4} · розрахунків 0/);
    // Filters still follow the manual status.
    assert.match((await usersPage(telegramFake(until), 'demo', 1, Date.now())).text, /Фільтр: demo · знайдено 1/);
    const unpaid = await userCardById(telegramFake(null), 'u1');
    assert.match(unpaid.text, /\nСтатус: Демо$/);
    const expired = await usersPage(telegramFake(new Date(Date.now() - DAY).toISOString()), 'all', 1, Date.now());
    assert.equal(/оплачено/i.test(expired.text), false);
    assert.match(expired.text, /owner@agro\.ua · Демо · /);
});

test('migration: new file after legal_consents (prod 20261018182708), RLS, functions, no backfill', () => {
    const files = readdirSync(join(root, 'supabase/migrations'));
    assert.ok(files.includes('20261018190000_payments.sql'));
    assert.ok('20261018190000' > '20261018182708');
    const sql = read('supabase/migrations/20261018190000_payments.sql');
    for (const table of ['org_subscriptions', 'payments', 'payment_events']) {
        assert.match(sql, new RegExp('ALTER TABLE public\\.' + table + ' ENABLE ROW LEVEL SECURITY;'));
        assert.match(sql, new RegExp('REVOKE ALL ON public\\.' + table + ' FROM PUBLIC, anon, authenticated;'));
    }
    assert.match(sql, /UNIQUE INDEX IF NOT EXISTS payments_provider_order_uidx\n\s+ON public\.payments \(provider, provider_order_id\);/);
    assert.match(sql, /ON public\.payments \(provider, provider_invoice_id\)\n\s+WHERE provider_invoice_id IS NOT NULL;/);
    assert.match(sql, /USING \(org_id = public\.current_org_id\(\) AND public\.is_org_owner\(\)\)/);
    assert.match(sql, /source text NOT NULL CHECK \(source IN \('webhook', 'status_check', 'manual'\)\)/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.apply_payment_success\(uuid, timestamptz\) TO service_role;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.apply_payment_success\(uuid, timestamptz\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /SELECT p\.is_approved OR coalesce\(public\.org_has_paid_access\(public\.current_org_id\(\)\), false\)/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.org_has_paid_access\(uuid\) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public\.org_has_paid_access\(uuid\) TO service_role;/);
    // org_has_user_data: payments and org_subscriptions count as data; the starter template copy matches index.html.
    const userData = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.org_has_user_data'));
    assert.match(userData, /'fleet_vehicles', 'trailer_presets', 'weekly_reports',\n[^\n]*\n\s+'payments', 'org_subscriptions'/);
    const pairsOf = (text) => Object.fromEntries([...text.matchAll(/'(\w+)',\s*('[^']*'|[\d.]+)/g)]
        .map(([, key, value]) => [key, value.startsWith("'") ? value.slice(1, -1) : Number(value)]));
    const starter = Function('return ' + html.match(/const STARTER_SETTINGS = (\{[\s\S]*?\});/)[1])();
    assert.deepEqual(pairsOf(userData.match(/v_starter_current constant jsonb := jsonb_build_object\(([\s\S]*?)\);/)[1]), starter);
    assert.equal(/UPDATE public\.profiles/.test(sql), false, 'no backfill of is_approved');
    assert.equal(/ALTER TABLE public\.organizations/.test(sql), false, 'paid_until is not on organizations');
});

test('one billing function, daily cron, old shared-secret webhook gone, docs updated', () => {
    assert.ok(existsSync(join(root, 'api/billing/[route].js')));
    const oldHook = ['billing', 'webhook'].join('-');
    assert.equal(existsSync(join(root, 'api/' + oldHook + '.js')), false);
    assert.equal(existsSync(join(root, 'docs/' + oldHook.toUpperCase() + '.md')), false);
    assert.ok(existsSync(join(root, 'docs/PAYMENTS.md')));
    const config = JSON.parse(read('vercel.json'));
    assert.deepEqual(config.crons, [
        { path: '/api/weekly-report', schedule: '0 6 * * 1' },
        { path: '/api/billing/cron', schedule: '0 7 * * *' }
    ]);
    assert.match(config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value, /form-action 'self'$/);
    const secrets = read('docs/SECRETS.md');
    for (const name of ['MONO_TOKEN', 'WAYFORPAY_MERCHANT_ACCOUNT', 'WAYFORPAY_SECRET_KEY', 'WAYFORPAY_MERCHANT_DOMAIN', 'PUBLIC_BASE_URL', 'PAYMENTS_ENABLED', 'MONO_PUBKEY']) {
        assert.match(secrets, new RegExp('`' + name + '`'), name);
    }
    const old = ['BILLING', 'WEBHOOK', 'SECRET'].join('_');
    const hits = [];
    const banned = new RegExp(['liq', 'pay'].join('') + '|' + old + '|' + oldHook, 'i');
    (function walk(dir) {
        for (const name of readdirSync(dir)) {
            if (['node_modules', '.git', '.vercel'].includes(name)) continue;
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(html|js|mjs|json|md|sql|txt|xml|css)$/i.test(name) && banned.test(readFileSync(path, 'utf8'))) hits.push(path.slice(root.length));
        }
    })(root);
    assert.deepEqual(hits, []);
});

test('payments on Postgres (PGlite)', (t) => {
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const run = spawnSync(process.execPath, [join(root, 'scripts/check-payments-rls.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const line of [
        'owner sees own company payments only',
        'logist does not see payments',
        'authenticated cannot update org_subscriptions (42501)',
        'apply_payment_success twice: one extension',
        '31.01 + 1 month = 28.02 (end of month)',
        'current_is_approved: false after paid_until',
        'current_is_approved: true for manual is_approved without payment',
        'after paid_until: demo limit is back, all 5 calculations are kept'
    ]) {
        assert.ok(run.stdout.includes('PASS ' + line), line);
    }
});
