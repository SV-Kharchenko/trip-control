import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { injectSite } from '../scripts/site-html.mjs';

const APP = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, APP), 'utf8');

function pngSize(path) {
    const buf = fs.readFileSync(new URL(path, APP));
    assert.equal(buf.toString('ascii', 1, 4), 'PNG', path);
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('manifest is ready for install and PWABuilder', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    assert.equal(m.id, '/');
    assert.equal(m.start_url, '/?source=pwa');
    assert.equal(m.scope, '/');
    assert.equal(m.display, 'standalone');
    assert.equal(m.lang, 'uk');
    assert.ok(m.name && m.short_name && m.short_name.length <= 12 && m.description);
    assert.equal(m.background_color, '#F4EFE4');
    for (const icon of m.icons) {
        const [w, h] = pngSize('public' + icon.src);
        assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
    for (const shot of m.screenshots) {
        const [w, h] = pngSize('public' + shot.src);
        assert.equal(`${w}x${h}`, shot.sizes, shot.src);
    }
    assert.ok(m.screenshots.some((s) => s.form_factor === 'wide') && m.screenshots.some((s) => s.form_factor === 'narrow'));
    assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
    assert.ok(m.icons.some((i) => i.purpose === 'any' && i.sizes === '512x512'));
    // Сторінка застосунку — копія index.html сайту з маніфестом Контроль+ замість /site.webmanifest.
    const html = injectSite(fs.readFileSync(new URL('../../index.html', APP), 'utf8'), { js: '/kp-assets/x.js' });
    assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
    assert.match(html, /<html lang="uk">/);
});

function loadSw() {
    const listeners = {};
    const context = {
        URL,
        self: { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: 'https://app.trip-control.com' }, clients: { claim() {} } },
        caches: {},
        fetch: () => { throw new Error('no network in tests'); },
    };
    vm.runInNewContext(read('public/sw.js') + '\n;globalThis.kpRoute = kpRoute; globalThis.PRECACHE = PRECACHE;', context);
    return { route: (url, method = 'GET', mode = 'cors') => context.kpRoute(new URL(url, 'https://app.trip-control.com'), method, mode, 'https://app.trip-control.com'), listeners, context };
}

test('service worker never touches data: Supabase, other origins, non-GET', () => {
    const { route, listeners } = loadSw();
    assert.equal(route('https://abc.supabase.co/rest/v1/clients?select=*'), 'bypass');
    assert.equal(route('https://abc.supabase.co/auth/v1/token?grant_type=password', 'POST'), 'bypass');
    assert.equal(route('https://abc.supabase.co/rest/v1/rpc/report_plan_fact', 'POST'), 'bypass');
    assert.equal(route('https://trip-control.com/'), 'bypass');
    assert.equal(route('/api/calculate', 'POST'), 'bypass');
    assert.equal(route('/api/team'), 'bypass');
    assert.equal(route('/api/team', 'GET', 'navigate'), 'bypass');
    assert.equal(route('/api'), 'bypass');
    assert.equal(route('/kp-assets/site-bridge-abc.js', 'POST'), 'bypass');
    assert.equal(route('/kp-assets/site-bridge-abc.js?x=1'), 'bypass');
    assert.equal(route('/assets/landing.js?v=2026-10-20'), 'bypass');
    assert.equal(route('/assets/brand/icon-192.png'), 'bypass', 'site files: HTTP cache only, like trip-control.com');
    assert.equal(route('/manifest.webmanifest'), 'bypass');
    assert.equal(route('/sw.js'), 'bypass');
    assert.equal(route('/'), 'bypass');
    assert.equal(route('/', 'GET', 'navigate'), 'page');
    assert.equal(route('/kp-assets/site-bridge-abc.js'), 'static');
    assert.equal(route('/icons/icon-192.png'), 'static');
    assert.equal(route('/offline.html'), 'static');
    assert.ok(listeners.install && listeners.activate && listeners.fetch && listeners.message);
});

test('service worker caches only public static files, never HTML pages', () => {
    const sw = read('public/sw.js');
    const { context } = loadSw();
    for (const path of context.PRECACHE) {
        assert.ok(fs.existsSync(new URL('public' + path, APP)), path);
        assert.ok(!/\.html$/.test(path) || path === '/offline.html', path);
    }
    assert.match(sw, /fetch\(request\)\.catch\(\(\) => caches\.match\(OFFLINE_URL\)\)/);
    assert.match(sw, /!response\.headers\.has\('Set-Cookie'\)/);
    assert.deepEqual(sw.split('\n').filter((line) => line.includes('skipWaiting')),
        ["    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();"], 'skipWaiting only on the «Оновити» message');
});

// CSP по шляхах (сайт / застосунок) і rewrites — у site.test.mjs.
test('vercel.json: sw and manifest headers', () => {
    const cfg = JSON.parse(read('vercel.json'));
    assert.equal(cfg.outputDirectory, 'dist');
    const header = (source, key) => {
        const block = cfg.headers.find((b) => b.source === source);
        const found = block && block.headers.find((h) => h.key === key);
        return found && found.value;
    };
    assert.equal(header('/sw.js', 'Cache-Control'), 'no-cache');
    assert.equal(header('/manifest.webmanifest', 'Content-Type'), 'application/manifest+json');
    assert.equal(header('/(.*)', 'X-Content-Type-Options'), 'nosniff');
});

test('no innerHTML with data in the CRM tabs', () => {
    for (const file of ['src/site-bridge.js', 'public/kp-entry.js']) {
        assert.doesNotMatch(read(file), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    }
    for (const file of fs.readdirSync(new URL('src/views/', APP))) {
        const code = read('src/views/' + file);
        assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
        assert.doesNotMatch(code, /window\.(alert|confirm|prompt)\(|\balert\(/, file);
    }
    assert.doesNotMatch(read('src/ui.js').replace(/^\s*\/\/.*$/gm, ''), /innerHTML/);
});

test('root .vercelignore hides repo internals from trip-control.com but keeps the site', () => {
    const lines = fs.readFileSync(new URL('../../.vercelignore', APP), 'utf8').split('\n')
        .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(lines.sort(), ['/SECURITY-FIX-PLAN.md', '/apps/', '/docs/', '/scripts/', '/supabase/', '/tests/']);
    const site = ['api', 'lib', 'assets', 'legal', 'index.html', '404.html', 'offline.html', 'sw.js', 'site.webmanifest',
        'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'robots.txt', 'sitemap.xml', 'package.json', 'vercel.json'];
    for (const path of site) {
        assert.ok(fs.existsSync(new URL('../../' + path, APP)), path + ' exists');
        assert.ok(!lines.some((rule) => ('/' + path + '/').startsWith(rule.replace(/\/?$/, '/'))), path + ' is not ignored');
    }
});

test('no secrets: keys only from env, .env files ignored', () => {
    const ignore = read('.gitignore');
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /^\.env\.\*$/m);
    assert.match(ignore, /^!\.env\.example$/m);
    assert.match(ignore, /^\.site\/$/m, 'the site copy is a build artifact');
    let files;
    try {
        files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.'], { cwd: APP, encoding: 'utf8' })
            .split('\n').filter(Boolean);
    } catch {
        return;
    }
    const jwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
    const named = /(service_role|SUPABASE_SERVICE|sb_secret_|WAYFORPAY_SECRET)[^\n]{0,20}[=:]\s*['"]?[A-Za-z0-9_.-]{20,}/;
    for (const file of files) {
        if (/\.(png|svg|ico)$/.test(file) || file === 'package-lock.json' || file.startsWith('tests/')) continue;
        const text = fs.readFileSync(new URL(file, APP), 'utf8');
        assert.doesNotMatch(text, jwt, file);
        assert.doesNotMatch(text, named, file);
        assert.ok(!/^\.env(\.|$)/.test(file) || file === '.env.example', file + ' must not be committed');
    }
});
