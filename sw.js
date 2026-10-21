// Service worker Trip Control (scope «/»).
//
// Лише мережа, без кешу й без перехоплення: усе не-GET, /api/*, будь-який інший домен (Supabase, WayForPay,
// plata by mono, Google Maps, шрифти, CDN), а також сторінки входу / повернення з оплати (параметри auth / billing).
// Навігація (HTML): спершу мережа; без мережі — /offline.html. HTML не кешується: після деплою — нова версія.
// Статика свого домену (/assets/*, іконки): cache-first у кеші з версією; нова версія SW видаляє старі кеші.
// Нічого персонального в кеш не потрапляє: лише публічні файли без cookies / токенів у відповіді.
//
// VERSION змінюйте, коли змінюються файли статики без ?v= (іконки, офлайн-сторінка) або цей файл.
const VERSION = '2026-10-21-1';
const STATIC_CACHE = 'tc-static-' + VERSION;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/assets/brand/icon-192.png'];

const STATIC_FILES = new Set(['/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png', OFFLINE_URL]);
const STATIC_EXT = /\.(css|js|mjs|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf)$/i;
// Вхід, підтвердження email, запрошення, повернення з оплати — лише мережа (не підміняти офлайн-сторінкою).
const NETWORK_ONLY_PARAMS = ['billing', 'pid', 'code', 'access_token', 'refresh_token', 'error', 'error_code',
    'error_description', 'type', 'team_invite', 'token', 'token_hash'];

// Стратегія для запиту: 'network' (не перехоплюємо), 'navigate' (мережа → офлайн-сторінка), 'static' (cache-first).
function tcSwStrategy(request, origin) {
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET') return 'network';
    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return 'network';
    }
    if (url.origin !== origin) return 'network';
    const path = url.pathname;
    if (path === '/api' || path.startsWith('/api/')) return 'network';
    if (path === '/sw.js') return 'network';
    if (request.mode === 'navigate') {
        const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
        const hasAuthOrPay = NETWORK_ONLY_PARAMS.some((key) => url.searchParams.has(key) || hash.has(key));
        if (hasAuthOrPay || /^\/(auth|callback)(\/|$)/.test(path)) return 'network';
        return 'navigate';
    }
    if (STATIC_FILES.has(path) || (path.startsWith('/assets/') && STATIC_EXT.test(path))) return 'static';
    return 'network';
}

// Для тестів (tests/pwa.test.mjs).
self.tcSwStrategy = tcSwStrategy;
self.TC_SW_VERSION = VERSION;

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith('tc-') && name !== STATIC_CACHE).map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

// Плашка «Є оновлення — Оновити» в застосунку надсилає SKIP_WAITING лише після кліку.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function fromNetworkOrOffline(request) {
    try {
        return await fetch(request);
    } catch (e) {
        const offline = await caches.match(OFFLINE_URL);
        return offline || new Response('Немає зʼєднання з інтернетом.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
}

async function fromCacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    // Лише звичайні успішні відповіді свого домену, без Set-Cookie.
    if (response.ok && response.type === 'basic' && !response.headers.has('Set-Cookie')) {
        const copy = response.clone();
        caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
}

self.addEventListener('fetch', (event) => {
    const strategy = tcSwStrategy(event.request, self.location.origin);
    if (strategy === 'navigate') event.respondWith(fromNetworkOrOffline(event.request));
    else if (strategy === 'static') event.respondWith(fromCacheFirst(event.request));
    // 'network': без respondWith — браузер іде в мережу сам, SW нічого не бачить і не кешує.
});
