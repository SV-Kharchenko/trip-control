// Публічна конфігурація з env (staging / прод): без env — явна помилка (ніколи прод), прод-значення дають ті самі URL і ключ сесії,
// service role не віддається, бейдж STAGING лише поза продом, вимкнені модулі, іконки сторінки без зашитих ключів.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
    appEnvironment, buildPublicConfig, createConfigHandler, disabledFeatures, isFeatureDisabled, renderConfigScript, sessionStorageKey,
} from '../lib/public-config.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// Продовий ref публічний (він і зараз у ключі сесії localStorage); ключ у тестах — вигаданий.
const PROD_URL = 'https://qkfqjorzsxcajcneohoy.supabase.co';
const ANON = 'sb_publishable_TestOnlyFakeKey0123456789';
const ENV = { SUPABASE_URL: PROD_URL, SUPABASE_ANON_KEY: ANON, VERCEL_ENV: 'production' };
const fakeJwt = (role) => 'h.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.sig';

test('конфіг: без env — явна помилка, а не тихий прод; нічого не підставляється', () => {
    for (const env of [{}, { SUPABASE_URL: PROD_URL }, { SUPABASE_ANON_KEY: ANON }, { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }, null, undefined]) {
        const out = buildPublicConfig(env);
        assert.equal(out.ok, false);
        assert.ok(out.problems.length >= 1);
        assert.equal('config' in out, false, 'жодного запасного конфігу');
        assert.equal(JSON.stringify(out).includes('qkfqjorzsxcajcneohoy'), false, 'прод-адреса не підставляється як fallback');
    }
    assert.deepEqual(buildPublicConfig({}).problems, ['SUPABASE_URL is not set', 'SUPABASE_ANON_KEY is not set']);
});

test('конфіг: адреса — лише https://<ref>.supabase.co; ключ — лише публічний (service role / secret відхиляються)', () => {
    for (const url of ['http://abcdefghij.supabase.co', 'https://example.com', 'https://abcdefghij.supabase.co:8443', 'https://u:p@abcdefghij.supabase.co', 'https://abcdefghij.supabase.co/rest/v1', 'not a url']) {
        assert.equal(buildPublicConfig({ SUPABASE_URL: url, SUPABASE_ANON_KEY: ANON }).ok, false, url);
    }
    assert.equal(buildPublicConfig({ SUPABASE_URL: 'https://abcdefghij.supabase.co/', SUPABASE_ANON_KEY: ANON }).config.supabaseUrl, 'https://abcdefghij.supabase.co', 'кінцевий слеш прибирається');
    for (const key of ['sb_secret_abcdefghijklmnopqrstuvwx', fakeJwt('service_role'), 'short', 'has space in it 0123456789', 'x'.repeat(500)]) {
        const out = buildPublicConfig({ SUPABASE_URL: PROD_URL, SUPABASE_ANON_KEY: key });
        assert.equal(out.ok, false, key.slice(0, 12));
        assert.equal(JSON.stringify(out).includes(key), false, 'значення ключа не потрапляє в помилку');
    }
    assert.equal(buildPublicConfig({ SUPABASE_URL: PROD_URL, SUPABASE_ANON_KEY: fakeJwt('anon') }).ok, true, 'класичний anon JWT дозволено');
});

test('регрес: прод-конфіг дає ті самі URL і ключ сесії, що були зашиті (прод-користувачів не розлогінить)', () => {
    const out = buildPublicConfig(ENV);
    assert.equal(out.ok, true);
    assert.equal(out.config.supabaseUrl, PROD_URL);
    assert.equal(out.config.supabaseAnonKey, ANON);
    assert.equal(out.config.env, 'production');
    assert.equal(sessionStorageKey(out.config.supabaseUrl), 'sb-qkfqjorzsxcajcneohoy-auth-token', 'той самий ключ localStorage, що й до зміни');
    assert.equal(sessionStorageKey('https://abcdefghij.supabase.co'), 'sb-abcdefghij-auth-token', 'на staging ключ свій — сесії не змішуються з продовими');
    // supabase-js рахує ключ так само: sb-<перша частина хоста>-auth-token.
    const src = read('index.html');
    assert.match(src, /'sb-' \+ new URL\(cfg\.supabaseUrl\)\.hostname\.split\('\.'\)\[0\] \+ '-auth-token'/);
});

test('віддача: у скрипті лише чотири поля; service role й інші env не потрапляють; </script> не закриє тег', () => {
    const env = { ...ENV, SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value', RESEND_API_KEY: 'resend-secret', KP_DISABLED_FEATURES: 'own_fleet' };
    const built = buildPublicConfig(env);
    assert.deepEqual(Object.keys(built.config).sort(), ['disabledFeatures', 'env', 'supabaseAnonKey', 'supabaseUrl']);
    const js = renderConfigScript(built.config);
    for (const secret of ['service-role-secret-value', 'resend-secret']) assert.equal(js.includes(secret), false, secret);
    const evil = renderConfigScript({ ...built.config, supabaseUrl: 'https://x</script><b>' });
    assert.equal(evil.includes('</script>'), false);
    const ctx = { window: {} };
    vm.runInNewContext(js, ctx);
    assert.equal(ctx.window.TC_CONFIG.supabaseUrl, PROD_URL);
    assert.equal(Object.isFrozen(ctx.window.TC_CONFIG), true);
    assert.deepEqual([...ctx.window.TC_CONFIG.disabledFeatures], ['own_fleet']);
});

test('бейдж STAGING: лише поза продом, без бейджа на проді; кольори — CSS-змінні', () => {
    assert.equal(appEnvironment({ VERCEL_ENV: 'production' }), 'production');
    for (const env of [{ VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, {}, { VERCEL_ENV: 'production', APP_ENV: 'staging' }]) assert.equal(appEnvironment(env), 'staging', JSON.stringify(env));
    assert.equal(appEnvironment({ VERCEL_ENV: 'preview', APP_ENV: 'production' }), 'production', 'APP_ENV перекриває VERCEL_ENV');
    const prod = renderConfigScript(buildPublicConfig(ENV).config);
    assert.equal(/STAGING|tc-staging-badge/.test(prod), false, 'на проді бейджа немає');
    const staging = renderConfigScript(buildPublicConfig({ ...ENV, VERCEL_ENV: 'preview' }).config);
    assert.match(staging, /STAGING/);
    assert.match(staging, /--tc-staging-bg/);
    assert.match(staging, /data-env/);
    const elements = [];
    const doc = {
        documentElement: { setAttribute() {} }, head: { appendChild: (e) => elements.push(e) }, body: { appendChild: (e) => elements.push(e) },
        getElementById: () => null, addEventListener() {},
        createElement: () => ({ setAttribute() {}, set textContent(v) { this.text = v; }, get textContent() { return this.text; } }),
    };
    vm.runInNewContext(staging, { window: {}, document: doc });
    assert.deepEqual(elements.map((e) => e.id || 'style'), ['style', 'tc-staging-badge']);
    assert.equal(elements[1].textContent, 'STAGING');
});

test('вимкнені модулі: KP_DISABLED_FEATURES — список через кому, нормалізація, без сміття й дублів', () => {
    assert.deepEqual(disabledFeatures({ KP_DISABLED_FEATURES: ' own_fleet , GPS,own_fleet,,bad key,1x,x-y' }), ['own_fleet', 'gps']);
    assert.deepEqual(disabledFeatures({}), []);
    assert.deepEqual(disabledFeatures(null), []);
    assert.equal(isFeatureDisabled({ KP_DISABLED_FEATURES: 'own_fleet' }, 'own_fleet'), true);
    assert.equal(isFeatureDisabled({ KP_DISABLED_FEATURES: 'own_fleet' }, 'OWN_FLEET'), true);
    assert.equal(isFeatureDisabled({ KP_DISABLED_FEATURES: 'own_fleet' }, 'gps'), false);
    assert.equal(isFeatureDisabled({}, 'own_fleet'), false);
});

function call(handler, method = 'GET') {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
    handler({ method }, res);
    return res;
}

test('API /api/config: GET → 200 JS без кешу; HEAD ок; POST → 405; без env → 503 без скрипта й без значень у логу', () => {
    const logs = [];
    const ok = call(createConfigHandler(() => ENV, { error: (m) => logs.push(m) }));
    assert.equal(ok.code, 200);
    assert.match(ok.headers['Content-Type'], /javascript/);
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.equal(ok.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(ok.body, /^window\.TC_CONFIG = Object\.freeze\(/);
    assert.equal(call(createConfigHandler(() => ENV), 'HEAD').code, 200);
    const post = call(createConfigHandler(() => ENV), 'POST');
    assert.equal(post.code, 405);
    const bad = call(createConfigHandler(() => ({ SUPABASE_URL: PROD_URL, SUPABASE_ANON_KEY: 'sb_secret_abcdefghijklmnopqrstuvwx' }), { error: (m) => logs.push(m) }));
    assert.equal(bad.code, 503);
    assert.equal(bad.body.includes('TC_CONFIG'), false, 'у 503 немає скрипта конфігу');
    assert.equal(logs.join('\n').includes('sb_secret_'), false, 'значення ключа не логується');
    assert.match(logs.join('\n'), /SUPABASE_ANON_KEY/, 'лише назва змінної');
    const none = call(createConfigHandler(() => ({}), { error: () => {} }));
    assert.equal(none.code, 503);
    assert.equal(none.body.includes('qkfqjorzsxcajcneohoy'), false);
});

test('index.html: жодного зашитого URL / ключа бази; конфіг підключено до Supabase; помилка явна, fallback немає', () => {
    const html = read('index.html');
    assert.equal(html.includes('qkfqjorzsxcajcneohoy'), false, 'адреси продової бази в сторінці немає');
    assert.doesNotMatch(html, /sb_publishable_|sb_secret_|eyJhbGciOi/, 'ключів у сторінці немає');
    const config = html.indexOf('<script src="/api/config"></script>');
    const sdk = html.indexOf('cdn.jsdelivr.net/npm/@supabase/supabase-js');
    assert.ok(config > 0 && config < sdk, 'конфіг — блокувальний скрипт перед бібліотекою Supabase');
    assert.match(html, /const SUPABASE_URL = TC_CONFIG\.supabaseUrl;/);
    assert.match(html, /const supabaseClient = window\.supabase\.createClient\(SUPABASE_URL, SUPABASE_ANON_KEY\);/);
    assert.match(html, /if \(!TC_CONFIG \|\| !TC_CONFIG\.supabaseUrl \|\| !TC_CONFIG\.supabaseAnonKey\) \{[\s\S]*?throw new Error\('TC_CONFIG is missing/, 'без конфігу — явна помилка');
    assert.doesNotMatch(html, /TC_CONFIG\s*\|\|\s*\{/, 'жодного запасного конфігу');
    assert.equal(html.includes('SUPABASE_SERVICE_ROLE'), false);
});

test('api/config: статичний файл, /api/* не кешується service worker-ом; копія в Контроль+ ідентична', () => {
    assert.match(read('api/config.js'), /createConfigHandler\(\)/);
    assert.match(read('sw.js'), /path\.startsWith\('\/api\/'\)\) return 'network'/);
    assert.equal(read('apps/kontrol-plus/lib/public-config.js'), read('lib/public-config.js'), 'lib/public-config.js і його копія в apps/kontrol-plus/lib однакові');
    assert.match(read('apps/kontrol-plus/api/config.js'), /createConfigHandler\(\)/);
    assert.match(read('apps/kontrol-plus/public/sw.js'), /url\.pathname\.startsWith\('\/api\/'\)\) return 'bypass'/);
    const code = read('lib/public-config.js').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/SUPABASE_SERVICE_ROLE|env\.[A-Z_]*SERVICE/.test(code), false, 'модуль конфігу не читає змінну service role (рядок service_role лише в перевірці, що відхиляє такий ключ)');
});
