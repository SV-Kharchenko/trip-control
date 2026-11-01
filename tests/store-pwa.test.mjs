// Microsoft Store через PWABuilder: маніфести обох доменів, /support, SW не чіпає API/auth/billing.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(root + path, 'utf8').replace(/\r\n/g, '\n');
const png = (path) => { const b = readFileSync(root + path); return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); };

const MANIFESTS = [
    { file: 'site.webmanifest', icons: (src) => src.slice(1), names: ['Trip Control', 'TripControl'], need1024: true },
    { file: 'apps/kontrol-plus/public/manifest.webmanifest', icons: (src) => 'apps/kontrol-plus/public' + src, names: ['Контроль+ — Trip Control', 'Контроль+'], need1024: true }
];

for (const { file, icons, names, need1024 } of MANIFESTS) {
    test('manifest ' + file + ': parses, icons 192/512/1024, handle_links + launch_handler, names unchanged', () => {
        const m = JSON.parse(read(file));
        assert.deepEqual([m.name, m.short_name], names);
        assert.equal(m.handle_links, 'preferred');
        assert.deepEqual(m.launch_handler, { client_mode: 'navigate-existing' });
        const any = (size) => m.icons.find((i) => i.purpose === 'any' && i.sizes === size);
        assert.ok(any('192x192') && any('512x512'));
        if (need1024) assert.ok(any('1024x1024'));
        assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
        for (const i of m.icons) assert.equal(png(icons(i.src)), i.sizes, i.src);
    });
}

test('/support: static page with mailto, links to legal pages, no forms; rewrite on both domains', () => {
    const page = read('legal/support.html');
    assert.match(page, /<link rel="canonical" href="https:\/\/trip-control\.com\/support">/);
    assert.match(page, /href="mailto:support@trip-control\.com"/);
    for (const url of ['/privacy', '/offer', '/payment-refund']) assert.ok(page.includes('href="' + url + '"'), url);
    assert.doesNotMatch(page, /<form|<input|type="password"|<script src/i);
    assert.doesNotMatch(page, /width:\s*100%[^}]*\.btn|\.btn[^}]*width:\s*100%/);
    const rule = { source: '/support', destination: '/legal/support.html' };
    for (const cfg of ['vercel.json', 'apps/kontrol-plus/vercel.json']) {
        assert.deepEqual(JSON.parse(read(cfg)).rewrites.find((r) => r.source === rule.source), rule, cfg);
    }
    // На app сторінка отримує ті самі (м'якші) CSP, що й оферта: інакше inline-стилі блокуються.
    const app = JSON.parse(read('apps/kontrol-plus/vercel.json'));
    assert.ok(app.headers.some((h) => /support/.test(h.source) && !h.source.includes('?!')));
    assert.ok(app.headers.some((h) => h.source.includes('?!') && h.source.includes('support$')));
    assert.match(read('sitemap.xml'), /<loc>https:\/\/trip-control\.com\/support<\/loc>/);
});

test('store screenshots: Playwright script and README are present, no fake PNGs claimed', () => {
    assert.ok(existsSync(root + 'apps/kontrol-plus/scripts/store-screenshots.mjs'));
    assert.ok(existsSync(root + 'apps/kontrol-plus/public/screenshots/README.md'));
    const script = read('apps/kontrol-plus/scripts/store-screenshots.mjs');
    assert.match(script, /1920/);
    assert.match(script, /1080/);
    assert.match(script, /chromium/);
    assert.doesNotMatch(script, /channel:\s*['"]chrome/);
});

test('site SW never intercepts API, auth, billing or non-GET', async () => {
    const src = read('sw.js');
    const sandbox = { self: { addEventListener() {}, location: { origin: 'https://trip-control.com' } } };
    new Function('self', src)(sandbox.self);
    const strategy = sandbox.self.tcSwStrategy;
    const req = (url, extra = {}) => ({ url, method: 'GET', mode: 'cors', ...extra });
    const o = 'https://trip-control.com';
    assert.equal(strategy(req(o + '/api/billing/create-invoice'), o), 'network');
    assert.equal(strategy(req(o + '/api/team'), o), 'network');
    assert.equal(strategy(req(o + '/api/x', { method: 'POST' }), o), 'network');
    assert.equal(strategy(req(o + '/?billing=return&pid=1', { mode: 'navigate' }), o), 'network');
    assert.equal(strategy(req(o + '/?team_invite=v2.x', { mode: 'navigate' }), o), 'network');
    assert.equal(strategy(req('https://app.trip-control.com/api/team'), o), 'network');
});
