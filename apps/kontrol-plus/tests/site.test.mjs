import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, SITE_FILES, SITE_DIRS, sha256, siteFileList, syncSite } from '../scripts/sync-site.mjs';
import { injectSite, stripInjected, KP_MANIFEST, SITE_MANIFEST } from '../scripts/site-html.mjs';
import { parseCrmHash, tabOf } from '../src/lib/route.js';
import { crmAccess, crmPermissions } from '../src/lib/gate.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const ROOT_INDEX = path.join(REPO_ROOT, 'index.html');

test('sync-site copies the site byte for byte and leaves the repo root untouched', () => {
    const before = sha256(ROOT_INDEX);
    const to = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-site-'));
    try {
        const copied = syncSite({ to });
        const paths = copied.map((f) => f.path);
        for (const must of [...SITE_FILES, 'assets/landing.js', 'assets/landing.css', 'assets/osm-geo.js', 'legal/offer.html']) {
            assert.ok(paths.includes(must), must);
        }
        assert.deepEqual(paths, siteFileList());
        for (const file of copied) {
            assert.equal(file.sha256, sha256(path.join(REPO_ROOT, file.path)), file.path);
            assert.equal(sha256(path.join(to, file.path)), file.sha256, file.path);
        }
        assert.ok(!paths.some((p) => /^(api|lib|supabase|apps|sw\.js|vercel\.json|\.vercelignore)/.test(p)), 'only the static site');
        assert.equal(sha256(ROOT_INDEX), before, 'root index.html unchanged');
    } finally {
        fs.rmSync(to, { recursive: true, force: true });
    }
});

test('sync-site fails loudly when the site is not next to the app (Vercel root directory blocker)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-empty-'));
    try {
        assert.throws(() => siteFileList(empty), /Include files outside the root directory/);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
    assert.deepEqual(SITE_DIRS, ['assets', 'legal']);
});

test('injection only inserts Контроль+ blocks; stripping them gives the original site', () => {
    const original = fs.readFileSync(ROOT_INDEX, 'utf8');
    const out = injectSite(original, { js: '/kp-assets/site-bridge-x.js', css: ['/kp-assets/site-bridge-x.css'] });
    assert.equal(stripInjected(out), original);
    assert.ok(out.includes(KP_MANIFEST) && !out.includes(SITE_MANIFEST));
    const head = out.slice(0, out.indexOf('</head>'));
    assert.match(head, /<meta name="robots" content="noindex">/);
    assert.match(head, /<link rel="stylesheet" href="\/kp-assets\/site-bridge-x\.css">/);
    assert.match(head, /<script src="\/kp-entry\.js"><\/script>/);
    const tail = out.slice(out.lastIndexOf('<script'));
    assert.match(tail, /^<script type="module" src="\/kp-assets\/site-bridge-x\.js"><\/script>\n<!--kp:end-->\n<\/body>/);
    assert.match(out, /<html lang="uk">/);
    assert.throws(() => injectSite('<html><head></head><body></body></html>', { js: '/x.js' }), /site\.webmanifest/);
    assert.throws(() => injectSite(SITE_MANIFEST + '</head></head></body>', { js: '/x.js' }), /<\/head>/);
});

test('built dist/: site files identical to the repo, index.html = original + injection', { skip: !fs.existsSync(path.join(APP, 'dist/index.html')) && 'run npm run build first' }, () => {
    const html = read('dist/index.html');
    assert.equal(stripInjected(html), fs.readFileSync(ROOT_INDEX, 'utf8'));
    const js = html.match(/<script type="module" src="(\/kp-assets\/site-bridge-[\w-]+\.js)">/);
    assert.ok(js && fs.existsSync(path.join(APP, 'dist', js[1])), 'bridge bundle exists');
    for (const rel of siteFileList()) {
        if (rel === 'index.html') continue;
        assert.equal(sha256(path.join(APP, 'dist', rel)), sha256(path.join(REPO_ROOT, rel)), rel);
    }
    assert.match(read('dist/sw.js'), /kp-static-/, 'the app service worker, not the site one');
    assert.ok(!fs.existsSync(path.join(APP, 'dist/site.webmanifest')));
});

// Vercel source (path-to-regexp) → RegExp для шаблонів, що є у vercel.json: групи (…) — regex, решта — літерали.
function sourceRegex(source) {
    let out = '';
    let depth = 0;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '\\') { out += ch + source[++i]; continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        out += depth === 0 && ch === '.' ? '\\.' : ch;
    }
    return new RegExp('^' + out.replace(/:(\w+)\*/g, '(.*)') + '$');
}

const cfg = JSON.parse(read('vercel.json'));
const headersFor = (pathname, key) => cfg.headers
    .filter((block) => sourceRegex(block.source).test(pathname))
    .flatMap((block) => block.headers.filter((h) => h.key === key).map((h) => h.value));
const SITE_PAGES = ['/', '/index.html', '/offer', '/privacy', '/payment-refund', '/legal/offer.html', '/legal/privacy.html'];
const APP_FILES = ['/sw.js', '/offline.html', '/manifest.webmanifest', '/kp-entry.js', '/kp-assets/site-bridge-x.js', '/assets/landing.js', '/icons/icon-192.png'];

test('vercel.json: /api is a server-side proxy to trip-control.com; legal rewrites match the site', () => {
    const api = cfg.rewrites.find((r) => r.source === '/api/:path*');
    assert.equal(api && api.destination, 'https://trip-control.com/api/:path*');
    const site = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
    for (const rule of site.rewrites) assert.ok(cfg.rewrites.some((r) => r.source === rule.source && r.destination === rule.destination), rule.source);
    // Власні функції — лише GPS (етап 2a), і лише статичні файли: реальний файл у api/ має пріоритет над rewrite
    // /api/:path* (для динамічних [param] це не гарантовано). Решта /api/* — проксі на сайт.
    const own = fs.readdirSync(path.join(APP, 'api'), { recursive: true }).map(String).filter((f) => f.endsWith('.js'))
        .map((f) => f.replace(/\\/g, '/')).sort();
    assert.deepEqual(own, ['docs/assets.js', 'docs/rate.js', 'gps/connect.js', 'gps/disconnect.js', 'gps/positions.js', 'gps/sync-units.js', 'gps/test.js', 'repairs/invites.js'],
        'only the static GPS, repairs and documents functions');
    assert.equal(own.some((f) => /\[|\]/.test(f)), false, 'no dynamic [param] routes');
    for (const file of own.filter((f) => f.startsWith('gps/'))) {
        const route = file.replace(/^gps\/|\.js$/g, '');
        assert.match(fs.readFileSync(path.join(APP, 'api', file), 'utf8'), new RegExp("gpsVercelRoute\\('" + route + "'\\)"), file);
    }
    assert.match(fs.readFileSync(path.join(APP, 'api/repairs/invites.js'), 'utf8'), /createRepairInvitesHandler/);
    for (const file of own) {
        assert.ok(sourceRegex(api.source).test('/api/' + file.replace(/\.js$/, '')), 'the proxy rule would match /api/' + file + ' — the real file wins');
    }
    assert.match(fs.readFileSync(path.join(APP, 'api/docs/rate.js'), 'utf8'), /createRateHandler/);
    assert.match(fs.readFileSync(path.join(APP, 'api/docs/assets.js'), 'utf8'), /createAssetsHandler/);
    assert.deepEqual(cfg.functions, { 'api/gps/*.js': { maxDuration: 30 }, 'api/repairs/*.js': { maxDuration: 15 }, 'api/docs/*.js': { maxDuration: 10 } });
    assert.equal(cfg.rewrites.filter((r) => r.source.startsWith('/api')).length, 1, 'one proxy rule, unchanged');
});

test('built dist/: Leaflet from npm in /kp-assets/ as a lazy chunk, no CDN', { skip: !fs.existsSync(path.join(APP, 'dist/index.html')) && 'run npm run build first' }, () => {
    const assets = fs.readdirSync(path.join(APP, 'dist/kp-assets'));
    const leafletJs = assets.filter((f) => /^leaflet.*\.js$/.test(f));
    const leafletCss = assets.filter((f) => /^leaflet.*\.css$/.test(f));
    assert.equal(leafletJs.length, 1, 'one Leaflet chunk');
    assert.equal(leafletCss.length, 1, 'Leaflet CSS in /kp-assets/');
    assert.match(fs.readFileSync(path.join(APP, 'dist/kp-assets', leafletCss[0]), 'utf8'), /\.leaflet-container/);
    const bridge = assets.find((f) => /^site-bridge-.*\.js$/.test(f));
    const bridgeJs = fs.readFileSync(path.join(APP, 'dist/kp-assets', bridge), 'utf8');
    assert.doesNotMatch(bridgeJs, /L\.Map|leaflet-container/, 'Leaflet is not in the main bundle (dynamic import only)');
    assert.ok(bridgeJs.includes(leafletJs[0]), 'the bridge loads the Leaflet chunk lazily');
    const all = fs.readdirSync(path.join(APP, 'dist'), { recursive: true }).map(String)
        .filter((f) => /\.(js|css|html)$/.test(f) && !f.startsWith('assets') && !f.startsWith('legal') && f !== 'index.html');
    for (const file of all) {
        const text = fs.readFileSync(path.join(APP, 'dist', file), 'utf8');
        assert.doesNotMatch(text, /(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)[^"'\s]*leaflet/i, file);
    }
    assert.doesNotMatch(read('dist/index.html').replace(/<!--kp:start-->[\s\S]*?<!--kp:end-->/g, ''), /leaflet/i, 'no Leaflet tags in the page');
    assert.doesNotMatch(read('dist/index.html').match(/<!--kp:start-->[\s\S]*?<!--kp:end-->/)[0], /leaflet/i);
});

test('vercel.json: site CSP only on site pages, strict CSP everywhere else, one CSP per path', () => {
    for (const pathname of [...SITE_PAGES, ...APP_FILES]) assert.equal(headersFor(pathname, 'Content-Security-Policy').length, 1, pathname);
    for (const pathname of SITE_PAGES) {
        const csp = headersFor(pathname, 'Content-Security-Policy')[0];
        for (const need of ["script-src 'self' 'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com',
            'https://maps.googleapis.com', 'https://maps.gstatic.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com',
            'https://bank.gov.ua', 'https://script.google.com', 'https://script.googleusercontent.com', 'wss://*.supabase.co',
            "connect-src 'self' https://*.supabase.co", "frame-ancestors 'none'", "object-src 'none'"]) {
            assert.ok(csp.includes(need), `${pathname}: ${need}`);
        }
    }
    for (const pathname of APP_FILES) {
        const csp = headersFor(pathname, 'Content-Security-Policy')[0];
        assert.match(csp, /script-src 'self';/, pathname);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, pathname);
    }
    // Карта GPS (2c) рендериться всередині сторінки сайту (/): тайли OSM — лише в img-src правила сторінок сайту.
    for (const pathname of SITE_PAGES) {
        const csp = headersFor(pathname, 'Content-Security-Policy')[0];
        assert.match(csp, /img-src 'self' data: blob: https:\/\/\*\.googleapis\.com https:\/\/\*\.gstatic\.com https:\/\/\*\.google\.com https:\/\/tile\.openstreetmap\.org;/, pathname);
        assert.equal((csp.match(/tile\.openstreetmap\.org/g) || []).length, 1, pathname + ': OSM only in img-src');
        assert.doesNotMatch(csp.match(/connect-src [^;]*/)[0], /openstreetmap/, 'tiles are <img>, no connect-src');
    }
    // Строгий CSP решти шляхів — рівно як був.
    const STRICT = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://*.supabase.co; "
        + "manifest-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
    for (const pathname of APP_FILES) assert.equal(headersFor(pathname, 'Content-Security-Policy')[0], STRICT, pathname);
    assert.deepEqual(headersFor('/kp-assets/a.js', 'Cache-Control'), ['public, max-age=31536000, immutable']);
    assert.deepEqual(headersFor('/assets/landing.js', 'Cache-Control'), ['public, max-age=604800, stale-while-revalidate=86400']);
    assert.deepEqual(headersFor('/', 'Cache-Control'), ['no-cache']);
    assert.deepEqual(headersFor('/', 'X-Frame-Options'), ['DENY']);
});

test('site API needs no Origin/Host checks for the proxy; requests carry Authorization: Bearer', () => {
    const apiDir = path.join(REPO_ROOT, 'api');
    const files = fs.readdirSync(apiDir, { recursive: true }).filter((f) => f.endsWith('.js'));
    for (const file of files) {
        const code = fs.readFileSync(path.join(apiDir, file), 'utf8');
        assert.doesNotMatch(code, /headers(\.|\[')(origin|host|referer)\b/i, file);
        assert.doesNotMatch(code, /req\.method === 'OPTIONS'/, file);
    }
    const site = fs.readFileSync(ROOT_INDEX, 'utf8');
    for (const url of ["'/api/calculate'", "'/api/team'", "'/api/billing/'", "'/api/poi'", "'/api/admin'", "'/api/weekly-report'", "'/api/signup-notify'"]) {
        assert.ok(site.includes('fetch(' + url), url + ' is same-origin');
    }
    assert.match(site, /'Authorization': 'Bearer ' \+|Authorization: 'Bearer ' \+|Authorization', 'Bearer ' \+/);
});

test('CRM tabs reuse the site Supabase client and never register a service worker', () => {
    const sources = ['src/site-bridge.js', 'src/bridge.js', 'src/ui.js', ...fs.readdirSync(path.join(APP, 'src/views')).map((f) => 'src/views/' + f),
        ...fs.readdirSync(path.join(APP, 'src/lib')).map((f) => 'src/lib/' + f)];
    for (const file of sources) {
        const code = read(file);
        assert.doesNotMatch(code, /createClient|@supabase\/supabase-js|serviceWorker\.register/, file);
    }
    assert.match(read('src/bridge.js'), /return supabaseClient;/);
    assert.match(fs.readFileSync(ROOT_INDEX, 'utf8'), /const supabaseClient = window\.supabase\.createClient\(/, 'site still exposes supabaseClient');
    assert.match(fs.readFileSync(ROOT_INDEX, 'utf8'), /navigator\.serviceWorker\.register\('\/sw\.js'/, 'site registers /sw.js = the app SW here');
    assert.match(read('public/kp-entry.js'), /setAttribute\('data-entry', 'app'\)/);
});

test('CRM routes live in the hash and never collide with site hashes', () => {
    assert.deepEqual(parseCrmHash('#/clients'), { view: 'clients' });
    assert.deepEqual(parseCrmHash('#/clients/new'), { view: 'client-new' });
    assert.deepEqual(parseCrmHash('#/clients/9b2f'), { view: 'client', id: '9b2f' });
    assert.deepEqual(parseCrmHash('#/clients/9b2f/edit'), { view: 'client-edit', id: '9b2f' });
    assert.deepEqual(parseCrmHash('#/report'), { view: 'report' });
    for (const hash of ['', '#', '#calculator', '#access_token=x&type=recovery', '#/clients/a/b/c', '#/reports', '#/report/x']) {
        assert.equal(parseCrmHash(hash), null, hash);
    }
    assert.equal(tabOf({ view: 'client-edit', id: '1' }), 'clients');
    assert.equal(tabOf({ view: 'report' }), 'report');
    assert.equal(tabOf(null), null);
});

test("plan gate: CRM tabs open only for plan = 'control_plus'", () => {
    assert.equal(crmAccess(null), 'paywall');
    assert.equal(crmAccess({ control_plus: false, role: 'owner' }), 'paywall');
    assert.equal(crmAccess({ control_plus: 'true', role: 'owner' }), 'paywall');
    assert.equal(crmAccess({ control_plus: true, role: 'logist' }), 'open');
    assert.deepEqual(crmPermissions({ control_plus: true, role: 'owner' }), { canWrite: true, canDelete: true });
    assert.deepEqual(crmPermissions({ control_plus: true, role: 'logist' }), { canWrite: true, canDelete: false });
    assert.deepEqual(crmPermissions({ control_plus: true, role: 'director' }), { canWrite: false, canDelete: false });
    assert.deepEqual(crmPermissions({ control_plus: false, role: 'owner' }), { canWrite: false, canDelete: false });
    assert.deepEqual(crmPermissions(null), { canWrite: false, canDelete: false });
});

// Те саме, що README → «Залежності моста від сайту». Якщо сайт перейменує щось — тест покаже, що міст треба оновити.
test('the site still has every id / class / global the bridge depends on', () => {
    const site = fs.readFileSync(ROOT_INDEX, 'utf8');
    for (const id of ['tc-nav-panel', 'main-app', 'sticky-top', 'studio-overview', 'studio-nav-calc', 'studio-nav-overview', 'studio-nav-history',
        'missing-hint', 'onboard-banner', 'cab-warning']) {
        assert.match(site, new RegExp(`id="${id}"`), '#' + id);
    }
    assert.match(site, /<div class="tc-nav-panel" id="tc-nav-panel">\s*<nav class="tc-studio-nav"/, '#tc-nav-panel .tc-studio-nav');
    assert.match(site, /<footer class="tc-legal-footer">/, '.tc-legal-footer in #main-app');
    assert.match(site, /document\.body\.setAttribute\('data-studio-view'/, 'body[data-studio-view]');
    assert.match(site, /body\.setAttribute\('data-theme', next\)/, 'body[data-theme]');
    assert.match(site, /classList\.toggle\('on', !overview && !history\)/, '.on marks the active nav button');
    assert.match(site, /const supabaseClient = window\.supabase\.createClient\(/, 'global supabaseClient');
    assert.match(site, /document\.documentElement\.setAttribute\('data-entry', entry\)/, 'html[data-entry] for kp-entry.js');
});

test('site: history tab sits right after Overview and the bridge un-highlights it', () => {
    const site = fs.readFileSync(ROOT_INDEX, 'utf8');
    assert.match(site, /id="studio-nav-overview"[^>]*>Огляд<\/button>\s*<button[^>]*id="studio-nav-history"[^>]*>Історія рейсів<\/button>/);
    const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    assert.match(bridge, /'studio-nav-calc', 'studio-nav-overview', 'studio-nav-history'/);
});

test('one-page calculator: built copy carries the new layout and the fleet falls back to kp_vehicles_list', async () => {
    const site = fs.readFileSync(ROOT_INDEX, 'utf8');
    assert.match(site, /stepper.id = 'tc-stepper'/);
    assert.match(site, /function buildOnePage\(\)/);
    assert.match(site, /id = 'tc-kpi-bar'/);
    const { kpVehiclesToSite, needsKpFleet } = await import('../src/lib/site-fleet.js');
    const rows = kpVehiclesToSite([{ id: 'v1', label: 'AA1111AA', payload_t: 22, trailer_type: 'тент', service_on: '2026-12-01' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'AA1111AA');
    assert.equal(rows[0].fuel_load, null);
    assert.equal(rows[0].payload_t, 22);
    assert.equal(needsKpFleet([], { control_plus: true, role: 'director' }), true);
    assert.equal(needsKpFleet([{ id: 'x' }], { control_plus: true, role: 'director' }), false);
    assert.equal(needsKpFleet([], { control_plus: false }), false);
    assert.equal(needsKpFleet([], null), false);
    const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    assert.match(bridge, /rpc\('kp_vehicles_list'\)/);
    assert.match(bridge, /window\.loadFleetVehicles = patched/);
    const css = fs.readFileSync(new URL('../src/crm.css', import.meta.url), 'utf8');
    assert.match(css, /body\[data-kp-view\] #tc-kpi-bar/);
});
