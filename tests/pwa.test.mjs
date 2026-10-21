import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const ORIGIN = 'https://trip-control.com';

// sw.js у пісочниці: fake self / caches / fetch, усі обробники подій — щоб перевірити і правила, і поведінку.
function loadSw({ fetchImpl } = {}) {
    const listeners = {};
    const stores = new Map();
    const caches = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            return {
                async put(req, res) { store.set(typeof req === 'string' ? req : req.url, res); },
                async addAll(urls) { urls.forEach((u) => store.set(ORIGIN + u, { ok: true, precached: true })); },
                async keys() { return [...store.keys()]; }
            };
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); },
        async match(req) {
            const key = typeof req === 'string' ? ORIGIN + req : req.url;
            for (const store of stores.values()) if (store.has(key)) return store.get(key);
            return undefined;
        }
    };
    const self = {
        location: { origin: ORIGIN },
        clients: { claim: async () => {} },
        skipWaiting() { self.skipped = true; },
        addEventListener(type, fn) { listeners[type] = fn; }
    };
    const context = { self, caches, fetch: fetchImpl || (async () => { throw new Error('offline'); }), URL, URLSearchParams, Response: class { constructor(body, init) { this.body = body; this.status = init && init.status; } }, Promise, Set, console };
    vm.createContext(context);
    vm.runInContext(read('sw.js'), context);
    return { self, listeners, stores, caches, strategy: self.tcSwStrategy };
}

const req = (url, extra = {}) => Object.assign({ url: url.startsWith('http') ? url : ORIGIN + url, method: 'GET', mode: 'cors' }, extra);
const nav = (url) => req(url, { mode: 'navigate' });

test('sw rules: /api/*, Supabase, payments, Google, fonts, CDN and any POST — network only, never cached', () => {
    const { strategy } = loadSw();
    const network = [
        req('/api/billing/summary'), req('/api/calculate', { method: 'POST' }), req('/api/team'), nav('/api/billing/return?pid=1'),
        req('/api'), req('https://qkfqjorzsxcajcneohoy.supabase.co/rest/v1/calculations?select=*'),
        req('https://qkfqjorzsxcajcneohoy.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST' }),
        req('wss://qkfqjorzsxcajcneohoy.supabase.co/realtime/v1/websocket'),
        nav('https://secure.wayforpay.com/page?vkh=abc'), req('https://api.wayforpay.com/api', { method: 'POST' }),
        nav('https://pay.mbnk.biz/inv_1'), req('https://api.monobank.ua/api/merchant/invoice/create', { method: 'POST' }),
        req('https://maps.googleapis.com/maps/api/js?key=x'), req('https://maps.gstatic.com/x.png'),
        req('https://fonts.googleapis.com/css2?family=Manrope'), req('https://fonts.gstatic.com/s/manrope/v1/a.woff2'),
        req('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3'), req('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json'),
        req('/assets/landing.js?v=2026-10-20', { method: 'POST' }), req('/', { method: 'HEAD' }), req('/sw.js'),
        req('/'), req('/index.html'), req('/site.webmanifest'), req('/offer')
    ];
    for (const r of network) assert.equal(strategy(r, ORIGIN), 'network', r.method + ' ' + r.url + ' ' + r.mode);
});

test('sw rules: sign-in, invite and payment return pages — network only, no offline substitute', () => {
    const { strategy } = loadSw();
    for (const url of ['/?billing=return&pid=00000000-0000-4000-8000-000000000000', '/?billing=pay', '/?code=abc', '/?team_invite=x',
        '/#access_token=a&refresh_token=b&type=signup', '/?type=recovery', '/?error=access_denied&error_code=otp_expired',
        '/auth/callback?code=1', '/callback', '/?token_hash=x&type=email']) {
        assert.equal(strategy(nav(url), ORIGIN), 'network', url);
    }
});

test('sw rules: pages are network-first with the offline page; only own static files are cache-first', () => {
    const { strategy } = loadSw();
    for (const url of ['/', '/?source=pwa', '/?preview=1', '/offer', '/privacy', '/payment-refund', '/history']) assert.equal(strategy(nav(url), ORIGIN), 'navigate', url);
    for (const url of ['/assets/landing.js?v=2026-10-20', '/assets/legal-footer.css?v=2026-10-20b', '/assets/brand/icon-192.png',
        '/assets/payments/visa.svg', '/assets/bg-network.jpg', '/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png', '/offline.html']) {
        assert.equal(strategy(req(url), ORIGIN), 'static', url);
    }
    // Не статика: інше розширення або поза /assets.
    for (const url of ['/assets/data.json', '/robots.txt', '/sitemap.xml', '/legal/offer.html']) assert.equal(strategy(req(url), ORIGIN), 'network', url);
});

test('sw fetch handler: network requests are not intercepted; static is cached only for clean own responses', async () => {
    let responses = 0;
    const sw = loadSw({
        fetchImpl: async (request) => {
            responses += 1;
            const url = typeof request === 'string' ? request : request.url;
            const setCookie = url.includes('cookie');
            return { ok: true, type: 'basic', url, headers: { has: (h) => setCookie && h === 'Set-Cookie' }, clone() { return this; } };
        }
    });
    const respond = (request) => {
        let handled = null;
        sw.listeners.fetch({ request, respondWith(p) { handled = p; } });
        return handled;
    };
    for (const r of [req('/api/billing/summary'), req('https://x.supabase.co/rest/v1/payments'), req('/api/calculate', { method: 'POST' }), nav('/?billing=return&pid=1')]) {
        assert.equal(respond(r), null, 'not intercepted: ' + r.url);
    }
    await respond(req('/assets/landing.js?v=1'));
    await respond(req('/assets/cookie.js'));
    await new Promise((r) => setTimeout(r, 10));
    const cached = [];
    for (const store of sw.stores.values()) cached.push(...store.keys());
    assert.ok(cached.includes(ORIGIN + '/assets/landing.js?v=1'));
    assert.equal(cached.some((u) => u.includes('cookie') || u.includes('/api') || u.includes('supabase')), false);
    // Другий раз — з кешу, без мережі.
    const before = responses;
    await respond(req('/assets/landing.js?v=1'));
    assert.equal(responses, before);
});

test('sw: offline navigation answers with offline.html; activate removes old tc- caches only; SKIP_WAITING only on message', async () => {
    const sw = loadSw();
    await new Promise((resolve) => sw.listeners.install({ waitUntil: (p) => p.then(resolve) }));
    const page = await new Promise((resolve) => sw.listeners.fetch({ request: nav('/history'), respondWith: (p) => p.then(resolve) }));
    assert.equal(page.precached, true, 'offline.html from the precache');
    await sw.caches.open('tc-static-old');
    await sw.caches.open('other-app-cache');
    await new Promise((resolve) => sw.listeners.activate({ waitUntil: (p) => p.then(resolve) }));
    const names = await sw.caches.keys();
    assert.deepEqual(names.sort(), ['other-app-cache', 'tc-static-' + sw.self.TC_SW_VERSION].sort());
    assert.equal(sw.self.skipped, undefined);
    sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
    assert.equal(sw.self.skipped, true);
    const sw2 = loadSw();
    sw2.listeners.message({ data: { type: 'OTHER' } });
    assert.equal(sw2.self.skipped, undefined);
});

test('offline page: Ukrainian text, «Спробувати ще», nothing from the network', () => {
    const page = read('offline.html');
    assert.match(page, /<h1>Немає зʼєднання з інтернетом<\/h1>/);
    assert.match(page, /<p>Trip Control працює онлайн, перевір мережу\.<\/p>/);
    assert.match(page, /<button type="button" onclick="location\.reload\(\)">Спробувати ще<\/button>/);
    assert.equal(/(src|href)="https?:/.test(page), false);
});

test('manifest: Chrome / PWABuilder fields, icons (any + maskable) and screenshots', () => {
    const m = JSON.parse(read('site.webmanifest'));
    assert.deepEqual([m.id, m.name, m.short_name, m.lang, m.start_url, m.scope, m.display], ['/', 'Trip Control', 'TripControl', 'uk', '/?source=pwa', '/', 'standalone']);
    assert.deepEqual(m.display_override, ['window-controls-overlay', 'standalone']);
    assert.match(m.description, /^Калькулятор прибутковості вантажних рейсів/);
    // Колір першого екрана (світла тема, «Ocean» мігрує в неї) — без білого спалаху.
    assert.equal(m.background_color, '#F4EFE4');
    assert.equal(m.theme_color, '#F4EFE4');
    assert.match(html, /<meta name="theme-color" content="#F4EFE4">/);
    const icon = (purpose, size) => m.icons.find((i) => i.purpose === purpose && i.sizes === size);
    assert.ok(icon('any', '192x192') && icon('any', '512x512') && icon('maskable', '512x512'));
    const png = (path) => { const b = readFileSync(new URL('../' + path.replace(/^\//, ''), import.meta.url)); return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); };
    for (const i of m.icons) assert.equal(png(i.src), i.sizes, i.src);
    assert.ok(m.screenshots.some((s) => s.form_factor === 'wide' && s.sizes === '1280x800'));
    assert.ok(m.screenshots.some((s) => s.form_factor === 'narrow'));
    for (const s of m.screenshots) {
        assert.equal(png(s.src), s.sizes, s.src);
        assert.ok(s.label && s.type === 'image/png');
    }
});

test('vercel.json: sw.js no-cache, manifest content type, CSP not weakened', () => {
    const config = JSON.parse(read('vercel.json'));
    const rule = (source) => config.headers.find((r) => r.source === source);
    const value = (source, key) => (rule(source).headers.find((h) => h.key === key) || {}).value;
    assert.equal(value('/sw.js', 'Cache-Control'), 'no-cache');
    assert.match(value('/site.webmanifest', 'Content-Type'), /^application\/manifest\+json/);
    const csp = value('/(.*)', 'Content-Security-Policy');
    assert.equal(csp, "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://maps.googleapis.com https://maps.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://*.googleapis.com https://bank.gov.ua https://script.google.com https://script.googleusercontent.com; frame-src https://maps.google.com https://*.google.com; worker-src 'self' blob:; base-uri 'self'; form-action 'self'");
    assert.equal(value('/(.*)', 'X-Frame-Options'), 'DENY');
});

test('client: SW registration, update banner without alert / confirm, install item, standalone title', () => {
    const pwa = html.slice(html.indexOf('// ПРОГРАМА (PWA)'), html.indexOf('// ЛОГІКА КАЛЬКУЛЯТОРА'));
    assert.match(pwa, /navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/', updateViaCache: 'none' \}\)/);
    assert.equal(/\balert\(|\bconfirm\(/.test(pwa), false);
    // Оновлення: лише після кліку (SKIP_WAITING), перезавантаження — після controllerchange, а не при першому встановленні.
    assert.match(pwa, /pwaWaitingWorker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
    assert.match(pwa, /if \(pwaUpdateRequested\) location\.reload\(\);/);
    assert.match(pwa, /if \(worker\.state === 'installed' && navigator\.serviceWorker\.controller\) showAppUpdate\(worker\);/);
    // Деплой без зміни sw.js — за ETag «/».
    assert.match(pwa, /fetch\('\/', \{ method: 'HEAD', cache: 'no-store', credentials: 'omit' \}\)/);
    assert.match(html, /<div class="tc-update-bar" id="tc-update-bar" role="status" aria-live="polite" hidden>\n\s+<span>Є оновлення<\/span>\n\s+<button type="button" class="tc-update-go" onclick="applyAppUpdate\(\)">Оновити<\/button>/);
    // Кнопка встановлення — лише в меню, лише після beforeinstallprompt і не в standalone.
    assert.match(html, /<button type="button" role="menuitem" class="tc-menu-item" id="tc-menu-install" hidden onclick="installApp\(\)">Встановити як програму<\/button>/);
    assert.match(pwa, /event\.preventDefault\(\);\n\s+pwaInstallPrompt = event;/);
    assert.match(pwa, /item\.hidden = !pwaInstallPrompt \|\| isStandaloneApp\(\);/);
    assert.match(pwa, /if \(isStandaloneApp\(\)\) document\.title = 'Trip Control';/);
    // Оплата у вікні програми: та сама вкладка (повернення /api/billing/return → 303 на «/» у межах scope).
    assert.match(html, /setBillingMessage\('Переходимо на сторінку оплати…', 'ok'\);\n\s+location\.href = res\.url;/);
});
