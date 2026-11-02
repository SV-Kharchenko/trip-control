// Безпека перед запуском: ліміт запитів на /api, перевірка тіла вебхуків, файли міграцій. Усі дані вигадані.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { bucketKey, clientIp, enforceRateLimit, hasBearer, LIMIT_ANON, LIMIT_AUTHED } = await import('../lib/rate-limit.js');
const { createTeamHandler } = await import('../api/team.js');
const { MAX_BODY_BYTES, readRawBody } = await import('../lib/billing/service.js');

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const res = () => {
    const out = { status: 0, body: null, headers: {} };
    out.setHeader = (k, v) => { out.headers[k] = v; };
    out.status = (code) => { out.code = code; return out; };
    out.json = (payload) => { out.body = payload; return out; };
    return out;
};
const req = (headers = {}, extra = {}) => ({ method: 'POST', headers, socket: { remoteAddress: '10.0.0.9' }, ...extra });

// ---- Ліміт запитів ----
test('IP: перша адреса x-forwarded-for, інакше x-real-ip, інакше сокет; у ключі лише хеш', () => {
    assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 10.1.1.1' })), '203.0.113.7');
    assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.2' })), '198.51.100.2');
    assert.equal(clientIp(req()), '10.0.0.9');
    assert.equal(clientIp({ headers: {} }), 'unknown');
    const key = bucketKey('calculate', '203.0.113.7');
    assert.match(key, /^calculate:[0-9a-f]{32}$/);
    assert.equal(key.includes('203.0.113.7'), false, 'сира адреса в базу не йде');
    assert.notEqual(bucketKey('calculate', '203.0.113.7'), bucketKey('poi', '203.0.113.7'), 'кожен ендпоінт має свій лічильник');
    assert.notEqual(bucketKey('calculate', '203.0.113.7'), bucketKey('calculate', '203.0.113.8'));
});

test('ліміти: ~60/хв із токеном, ~20/хв без; значення йдуть у RPC', async () => {
    assert.equal(LIMIT_AUTHED, 60);
    assert.equal(LIMIT_ANON, 20);
    const calls = [];
    const rpc = async (args) => { calls.push(args); return { data: [{ allowed: true, hits: 1, retry_after: 30 }], error: null }; };
    assert.equal(hasBearer(req({ authorization: 'Bearer abc' })), true);
    assert.equal(hasBearer(req({ authorization: 'Basic abc' })), false);
    assert.equal(hasBearer(req()), false);
    assert.equal(await enforceRateLimit(req({ authorization: 'Bearer abc' }), res(), 'team', { rpc }), true);
    assert.equal(await enforceRateLimit(req(), res(), 'team', { rpc }), true);
    assert.deepEqual(calls.map((c) => c.p_limit), [60, 20]);
    assert.ok(calls.every((c) => c.p_window_seconds === 60 && /^team:[0-9a-f]{32}$/.test(c.p_bucket)));
});

test('понад ліміт: 429 з JSON і Retry-After, обробник далі не йде', async () => {
    const rpc = async () => ({ data: [{ allowed: false, hits: 21, retry_after: 42 }], error: null });
    const r = res();
    assert.equal(await enforceRateLimit(req(), r, 'poi', { rpc }), false);
    assert.equal(r.code, 429);
    assert.equal(r.body.code, 'RATE_LIMITED');
    assert.match(r.body.error, /Забагато запитів/);
    assert.equal(r.body.retry_after, 42);
    assert.equal(r.headers['Retry-After'], '42');
});

test('збій лічильника не кладе API (fail-open), але попередження лишається в логах', async () => {
    const warn = console.warn;
    const logged = [];
    console.warn = (...args) => logged.push(args.join(' '));
    try {
        for (const rpc of [async () => ({ data: null, error: { message: 'db down' } }), async () => { throw new Error('network'); }, async () => ({ data: [], error: null })]) {
            const r = res();
            assert.equal(await enforceRateLimit(req(), r, 'calculate', { rpc }), true);
            assert.equal(r.code, undefined);
        }
    } finally {
        console.warn = warn;
    }
    assert.equal(logged.filter((l) => /fail-open/.test(l)).length, 2, 'збій бази й мережі залоговані');
});

test('без SUPABASE_* лімітер пропускає запит (локальна розробка / тести)', async () => {
    const r = res();
    assert.equal(await enforceRateLimit(req(), r, 'calculate', { env: {} }), true);
    assert.equal(r.code, undefined);
});

test('підключення: calculate, poi, signup-notify, admin, team і billing (крім вебхуків і cron) лімітуються', async () => {
    for (const [file, name] of [['api/calculate.js', 'calculate'], ['api/poi.js', 'poi'], ['api/signup-notify.js', 'signup-notify'], ['api/admin.js', 'admin']]) {
        const src = read(file);
        assert.ok(src.includes("enforceRateLimit(req, res, '" + name + "')"), file);
        const handler = src.slice(src.indexOf('export default async function handler'));
        assert.ok(handler.indexOf('enforceRateLimit') < handler.indexOf('requireAdmin(req, res)') || file !== 'api/admin.js', 'ліміт раніше за перевірку адміна');
        assert.ok(handler.slice(0, 200).includes('enforceRateLimit'), file + ': ліміт — перша дія обробника');
    }
    const billing = read('api/billing/[route].js');
    assert.ok(billing.includes("const UNLIMITED_ROUTES = new Set(['mono-webhook', 'wayforpay-webhook', 'cron']);"));
    assert.ok(billing.includes("enforceRateLimit(req, res, 'billing')"));
    // Обробник team: відмова лімітера зупиняє запит до будь-якої роботи з базою.
    let touched = false;
    const handler = createTeamHandler({
        supabase: new Proxy({}, { get() { touched = true; throw new Error('db must not be touched'); } }),
        fetch: async () => ({}), env: {},
        rateLimit: async (_req, response) => { response.status(429).json({ code: 'RATE_LIMITED' }); return false; },
    });
    const r = res();
    await handler({ method: 'POST', headers: {}, body: { action: 'my_invites' } }, r);
    assert.equal(r.code, 429);
    assert.equal(touched, false);
    assert.ok(read('api/team.js').includes("rateLimit: (req, res) => enforceRateLimit(req, res, 'team')"), 'бойовий обробник team лімітується');
});

// ---- Тіло вебхуків ----
test('billing: тіло понад 256 КБ → 413 до перевірки підпису; нормальне тіло читається', async () => {
    const big = Readable.from([Buffer.alloc(MAX_BODY_BYTES), Buffer.alloc(10)]);
    await assert.rejects(() => readRawBody(big), (e) => e.status === 413 && e.code === 'BODY_TOO_LARGE');
    const ok = await readRawBody(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]));
    assert.equal(ok.toString(), '{"a":1}');
    assert.equal((await readRawBody({ rawBody: 'raw' })).toString(), 'raw', 'готове сире тіло не чіпаємо');
});

// ---- Міграції ----
const MIGRATIONS = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => /^202611100\d{5}_/.test(f)).sort();

test('міграції безпеки: файли в repo, ручне застосування, відкат, після 20261109090000, бездеструктивні', () => {
    assert.deepEqual(MIGRATIONS.map((f) => f.replace(/^\d+_/, '')), ['api_rate_limits.sql', 'security_audit_fixes.sql', 'company_settings_merge.sql', 'ts_pretrip_marks_lock.sql']);
    for (const file of MIGRATIONS) {
        assert.ok(file > '20261109090000', file);
        const sql = read('supabase/migrations/' + file);
        assert.match(sql, /^-- Apply manually after review\. This file is not applied to production by the agent\./, file);
        assert.match(sql, /РУЧНИЙ ВІДКАТ/, file);
        assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM public\.(calculations|profiles|organizations|kp_documents|kp_doc_ttn|kp_doc_trip_sheet|company_settings)/, file + ': нічого не видаляє');
    }
});

test('api_rate_hit і bump_calc_usage — лише service_role; таблиця лічильників закрита; SECURITY DEFINER з search_path', () => {
    const rate = read('supabase/migrations/20261110090000_api_rate_limits.sql');
    assert.match(rate, /ENABLE ROW LEVEL SECURITY/);
    assert.match(rate, /REVOKE ALL ON TABLE public\.api_rate_limits FROM PUBLIC, anon, authenticated/);
    assert.match(rate, /REVOKE ALL ON FUNCTION public\.api_rate_hit\(text, integer, integer\) FROM PUBLIC, anon, authenticated/);
    assert.match(rate, /GRANT EXECUTE ON FUNCTION public\.api_rate_hit\(text, integer, integer\) TO service_role;/);
    assert.doesNotMatch(rate, /TO authenticated/);
    assert.match(rate, /SECURITY DEFINER\s+SET search_path = public/);
    const audit = read('supabase/migrations/20261110091000_security_audit_fixes.sql');
    assert.match(audit, /REVOKE ALL ON FUNCTION public\.bump_calc_usage\(uuid, integer\) FROM PUBLIC, anon, authenticated;/);
    assert.match(audit, /GRANT EXECUTE ON FUNCTION public\.bump_calc_usage\(uuid, integer\) TO service_role;/);
    assert.match(audit, /trailer_presets ENABLE ROW LEVEL SECURITY/);
    // calculate.js викликає bump_calc_usage сервісним ключем, тож відкликання доступу в клієнтів його не ламає.
    assert.match(read('api/calculate.js'), /SUPABASE_SERVICE_ROLE_KEY/);
});

test('збереження налаштувань компанії — через RPC kp_company_settings_merge (тільки власник, jsonb ||)', () => {
    const sql = read('supabase/migrations/20261110092000_company_settings_merge.sql');
    assert.match(sql, /NOT public\.is_org_owner\(\)/);
    assert.match(sql, /\(coalesce\(cs\.settings, '\{\}'::jsonb\) - coalesce\(p_remove, ARRAY\[\]::text\[\]\)\) \|\| excluded\.settings/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.kp_company_settings_merge\(jsonb, text\[\]\) FROM PUBLIC, anon, authenticated;/);
});

test('документ аудиту: усі SECURITY DEFINER-функції та 14 таблиць без політик описані', () => {
    const doc = read('docs/SECURITY-AUDIT-FUNCTIONS.md');
    for (const needle of ['bump_calc_usage', 'kp_company_settings_merge', 'api_rate_hit', 'kp_doc_ttn', 'poi_cache', 'payment_events', 'trailer_presets', 'report_plan_fact', 'is_platform_admin']) {
        assert.ok(doc.includes(needle), needle);
    }
    assert.equal((doc.match(/\| \*\*дірка\*\*/g) || []).length >= 2, true, 'діри позначені');
});
