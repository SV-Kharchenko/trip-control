// Видача SSO-токена для AGRO (api/agro/sso.js + lib/agro/sso.js): підпис і claims, статуси, ліміт, логи, origin. Без мережі й бази.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { ISSUER, TOKEN_TTL_SECONDS, agroBaseUrl, buildClaims, configProblem, createAgroSsoHandler, signJwt, ssoConfig } from '../lib/agro/sso.js';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const SECRET = 'test-secret-test-secret-test-secret-123';
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value', AGRO_SSO_SECRET: SECRET };
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'Owner@Example.COM' };
const NOW = Date.UTC(2026, 10, 27, 10, 0, 0);

function call(handler, { method = 'POST', headers = { authorization: 'Bearer user-jwt' } } = {}) {
    return new Promise((resolve) => {
        const res = {
            headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            status(code) { this.code = code; return this; },
            json(body) { resolve({ code: this.code, body, headers: this.headers }); return this; },
        };
        handler({ method, headers, body: {} }, res);
    });
}

function makeStore(over = {}) {
    const calls = [];
    const store = {
        calls,
        async getUser(jwt) { calls.push(['getUser', jwt]); return USER; },
        async access(id) { calls.push(['access', id]); return { allowed: true, reason: 'org' }; },
        async membership() { return { org_id: '22222222-2222-4222-8222-222222222222', org_name: 'Агро Північ', org_role: 'owner' }; },
        ...over,
    };
    return store;
}

function makeLog() {
    const lines = [];
    return { lines, info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
}

const handlerWith = (over = {}, extra = {}) => createAgroSsoHandler({ store: makeStore(over), env: ENV, now: () => NOW, jti: () => 'jti-fixed', log: makeLog(), ...extra });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('токен: HS256 JWT, підпис перевіряється секретом, claims за специфікацією, exp = iat + 60 с', async () => {
    const out = await call(handlerWith());
    assert.equal(out.code, 200);
    assert.equal(out.body.ok, true);
    assert.ok(out.body.url.startsWith('https://agro.trip-control.com/#sso='));
    const token = out.body.url.split('#sso=')[1];
    const [head, body, sig] = token.split('.');
    assert.deepEqual(decode(head), { alg: 'HS256', typ: 'JWT' });
    assert.equal(sig, createHmac('sha256', SECRET).update(head + '.' + body).digest('base64url'));
    assert.notEqual(sig, createHmac('sha256', 'other-secret-other-secret-other-secret').update(head + '.' + body).digest('base64url'));
    const claims = decode(body);
    const iat = Math.floor(NOW / 1000);
    assert.deepEqual(claims, {
        iss: 'trip-control', aud: 'agro', sub: USER.id, email: 'owner@example.com', org_id: '22222222-2222-4222-8222-222222222222',
        org_name: 'Агро Північ', org_role: 'owner', provision: true, iat, nbf: iat, exp: iat + 60, jti: 'jti-fixed',
    });
    assert.equal(TOKEN_TTL_SECONDS, 60);
    assert.equal(ISSUER, 'trip-control');
    assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('jti унікальний за замовчуванням; provision лише для owner', async () => {
    const handler = createAgroSsoHandler({
        store: makeStore({ async membership() { return { org_id: 'o', org_name: 'N', org_role: 'logist' }; } }), env: ENV, now: () => NOW, log: makeLog(),
    });
    const a = decode((await call(handler)).body.url.split('#sso=')[1].split('.')[1]);
    const b = decode((await call(handler)).body.url.split('#sso=')[1].split('.')[1]);
    assert.notEqual(a.jti, b.jti);
    assert.match(a.jti, /^[0-9a-f-]{36}$/);
    assert.equal(a.provision, false);
    assert.equal(buildClaims({ user: USER, membership: { org_id: 'o', org_role: 'owner' }, now: NOW, jti: 'j' }).provision, true);
    assert.equal(signJwt({ a: 1 }, SECRET).split('.').length, 3);
});

test('401: без Bearer — до перевірки env (навіть без конфігурації); сесія без користувача — 401', async () => {
    const bare = createAgroSsoHandler({ store: makeStore(), env: {}, now: () => NOW, log: makeLog() });
    assert.equal((await call(bare, { headers: {} })).code, 401);
    assert.equal((await call(bare, { headers: { authorization: 'Bearer ' } })).code, 401);
    assert.equal((await call(bare, { headers: { authorization: 'Basic abc' } })).code, 401);
    const bad = await call(handlerWith({ async getUser() { return null; } }));
    assert.equal(bad.code, 401);
    assert.equal(bad.body.code, 'BAD_TOKEN');
});

test('405: лише POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
        const out = await call(handlerWith(), { method });
        assert.equal(out.code, 405, method);
        assert.equal(out.headers.Allow, 'POST');
    }
});

test('503 NOT_CONFIGURED: немає SUPABASE_URL / SERVICE_ROLE_KEY / AGRO_SSO_SECRET або секрет коротший за 32; погана AGRO_APP_URL', async () => {
    for (const env of [
        { ...ENV, SUPABASE_URL: '' }, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined }, { ...ENV, AGRO_SSO_SECRET: undefined },
        { ...ENV, AGRO_SSO_SECRET: 'short-secret' }, { ...ENV, AGRO_SSO_SECRET: 'x'.repeat(31) },
    ]) {
        const store = makeStore();
        const out = await call(createAgroSsoHandler({ store, env, now: () => NOW, log: makeLog() }));
        assert.equal(out.code, 503, JSON.stringify(env));
        assert.equal(out.body.code, 'NOT_CONFIGURED');
        assert.equal(store.calls.length, 0, 'до бази не звертались');
    }
    assert.ok(ssoConfig({ ...ENV, AGRO_SSO_SECRET: 'x'.repeat(32) }));
    // Погана AGRO_APP_URL (не https / не URL) — окремий код SSO_NOT_CONFIGURED, до бази не звертаємось.
    for (const AGRO_APP_URL of ['http://agro.example.com', 'javascript:alert(1)', 'not a url']) {
        const store = makeStore();
        const out = await call(createAgroSsoHandler({ store, env: { ...ENV, AGRO_APP_URL }, now: () => NOW, log: makeLog() }));
        assert.equal(out.code, 503, AGRO_APP_URL);
        assert.equal(out.body.code, 'SSO_NOT_CONFIGURED');
        assert.equal(store.calls.length, 0);
    }
    assert.equal(configProblem(ENV), null);
    assert.equal(configProblem({ ...ENV, AGRO_SSO_SECRET: undefined }), 'NOT_CONFIGURED');
});

test('403 AGRO_ACCESS_DENIED: людський текст і код причини для кожного reason', async () => {
    for (const reason of ['global_off', 'user_blocked', 'email_unconfirmed', 'no_org', 'org_blocked', 'user_override', 'org']) {
        const out = await call(handlerWith({ async access() { return { allowed: false, reason }; } }));
        assert.equal(out.code, 403, reason);
        assert.equal(out.body.code, 'AGRO_ACCESS_DENIED');
        assert.equal(out.body.reason, reason);
        assert.match(out.body.error, /[а-яіїє]/i);
        assert.equal(out.body.url, undefined);
    }
    const unknown = await call(handlerWith({ async access() { return null; } }));
    assert.equal(unknown.code, 403);
    const noOrg = await call(handlerWith({ async membership() { return null; } }));
    assert.equal(noOrg.code, 403);
    assert.equal(noOrg.body.reason, 'no_org');
});

test('429: 10 видач на користувача за хвилину; інший користувач і наступна хвилина — окремо', async () => {
    let t = NOW;
    const store = makeStore();
    const handler = createAgroSsoHandler({ store, env: ENV, now: () => t, log: makeLog() });
    for (let i = 0; i < 10; i += 1) assert.equal((await call(handler)).code, 200, 'виклик ' + i);
    const limited = await call(handler);
    assert.equal(limited.code, 429);
    assert.equal(limited.body.code, 'AGRO_RATE_LIMIT');
    store.getUser = async () => ({ id: '33333333-3333-4333-8333-333333333333', email: 'b@example.com' });
    assert.equal((await call(handler)).code, 200, 'інший користувач');
    store.getUser = async () => USER;
    t += 61000;
    assert.equal((await call(handler)).code, 200, 'за хвилину ліміт скинувся');
});

test('логи: лише коди дій — без пошти, JWT, токена, секрету й тексту помилки бази', async () => {
    const log = makeLog();
    const ok = createAgroSsoHandler({ store: makeStore(), env: ENV, now: () => NOW, log });
    const res = await call(ok);
    const token = res.body.url.split('#sso=')[1];
    const denied = createAgroSsoHandler({ store: makeStore({ async access() { return { allowed: false, reason: 'org' }; } }), env: ENV, now: () => NOW, log });
    await call(denied);
    const broken = createAgroSsoHandler({ store: makeStore({ async access() { throw new Error('db down for owner@example.com secret ' + SECRET); } }), env: ENV, now: () => NOW, log });
    const failed = await call(broken);
    assert.equal(failed.code, 500);
    assert.equal(failed.body.code, 'INTERNAL');
    const all = log.lines.join('\n');
    assert.ok(log.lines.length >= 3);
    for (const secret of [token, token.split('.')[1], 'user-jwt', 'owner@example.com', 'Owner@Example.COM', SECRET, ENV.SUPABASE_SERVICE_ROLE_KEY, USER.id]) {
        assert.equal(all.includes(secret), false, 'у логах немає ' + secret.slice(0, 12));
    }
    assert.equal(JSON.stringify(failed.body).includes('owner@example.com'), false);
    assert.equal(JSON.stringify(failed.body).includes(SECRET), false);
});

test('url: лише дозволений origin з env (https; localhost для розробки), без параметрів із запиту', async () => {
    assert.equal(agroBaseUrl({}), 'https://agro.trip-control.com');
    assert.equal(agroBaseUrl({ AGRO_APP_URL: 'https://agro.example.com/some/path?x=1#y' }), 'https://agro.example.com');
    assert.equal(agroBaseUrl({ AGRO_APP_URL: 'http://localhost:5173' }), 'http://localhost:5173');
    assert.equal(agroBaseUrl({ AGRO_APP_URL: 'http://localhost:5173', VERCEL_ENV: 'preview' }), 'http://localhost:5173');
    assert.equal(agroBaseUrl({ AGRO_APP_URL: 'http://127.0.0.1:5173', VERCEL_ENV: 'development' }), 'http://127.0.0.1:5173');
    assert.equal(agroBaseUrl({ AGRO_APP_URL: 'http://agro.example.com' }), null);
    assert.equal(agroBaseUrl({ AGRO_APP_URL: 'not a url' }), null);
    const out = await new Promise((resolve) => {
        const res = { headers: {}, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); return this; } };
        // Усе, що надішле клієнт (query, body, заголовки), на адресу не впливає.
        createAgroSsoHandler({ store: makeStore(), env: ENV, now: () => NOW, log: makeLog() })({
            method: 'POST', headers: { authorization: 'Bearer user-jwt', host: 'evil.example' }, query: { redirect: 'https://evil.example' },
            body: { redirect: 'https://evil.example', url: 'https://evil.example', next: '//evil.example' },
        }, res);
    });
    assert.equal(out.code, 200);
    assert.ok(out.body.url.startsWith('https://agro.trip-control.com/#sso='));
    assert.equal(out.body.url.includes('evil'), false);
    assert.equal(new URL(out.body.url).origin, 'https://agro.trip-control.com');
    const custom = createAgroSsoHandler({ store: makeStore(), env: { ...ENV, AGRO_APP_URL: 'https://agro-staging.example.com/' }, now: () => NOW, log: makeLog() });
    assert.ok((await call(custom)).body.url.startsWith('https://agro-staging.example.com/#sso='));
});

test('vercel / api: окремий статичний файл у api/agro/ із maxDuration 10; 401 і 405 до env; lib не імпортується з src/', async () => {
    const cfg = JSON.parse(read('vercel.json'));
    assert.deepEqual(cfg.functions['api/agro/*.js'], { maxDuration: 10 });
    const api = read('api/agro/sso.js');
    assert.ok(api.indexOf("res.status(405)") < api.indexOf('process.env.SUPABASE_URL'));
    assert.ok(api.indexOf("'AUTH_REQUIRED'") < api.indexOf('configProblem(process.env)'));
    assert.match(api, /Cache-Control', 'no-store'/);
    const walk = (dir) => fs.readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name]));
    for (const file of walk('src').filter((f) => f.endsWith('.js'))) assert.equal(/lib\/agro\//.test(read(file)), false, file);
    // Нових залежностей немає: лише node:crypto.
    assert.equal(/from '(?!node:|\.\.?\/)/.test(read('lib/agro/sso.js')), false);
    // Секретів у репозиторії немає.
    assert.equal(/AGRO_SSO_SECRET\s*=\s*\S{8,}/.test(read('README.md')), false);
});

test('production (VERCEL_ENV=production): http://localhost не приймається, лише https-origin; 503 SSO_NOT_CONFIGURED; поза production localhost дозволено', async () => {
    const prod = { ...ENV, VERCEL_ENV: 'production' };
    for (const AGRO_APP_URL of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://agro.trip-control.com']) {
        assert.equal(agroBaseUrl({ ...prod, AGRO_APP_URL }), null, AGRO_APP_URL);
        const store = makeStore();
        const out = await call(createAgroSsoHandler({ store, env: { ...prod, AGRO_APP_URL }, now: () => NOW, log: makeLog() }));
        assert.equal(out.code, 503, AGRO_APP_URL);
        assert.equal(out.body.code, 'SSO_NOT_CONFIGURED');
        assert.equal(store.calls.length, 0);
    }
    assert.equal(agroBaseUrl({ ...prod, AGRO_APP_URL: 'https://agro.example.com/x' }), 'https://agro.example.com');
    assert.equal(agroBaseUrl(prod), 'https://agro.trip-control.com');
    const ok = await call(createAgroSsoHandler({ store: makeStore(), env: prod, now: () => NOW, log: makeLog() }));
    assert.equal(ok.code, 200);
    // Поза production (preview / development / без змінної) localhost працює й видає url.
    for (const VERCEL_ENV of ['preview', 'development', undefined]) {
        const out = await call(createAgroSsoHandler({ store: makeStore(), env: { ...ENV, VERCEL_ENV, AGRO_APP_URL: 'http://localhost:5173' }, now: () => NOW, log: makeLog() }));
        assert.equal(out.code, 200, String(VERCEL_ENV));
        assert.ok(out.body.url.startsWith('http://localhost:5173/#sso='));
    }
    // Тонка обгортка віддає той самий код.
    assert.match(read('api/agro/sso.js'), /configProblem\(process\.env\)[\s\S]*code: problem/);
});
