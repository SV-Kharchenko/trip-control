// Контроль+ service worker (його ж реєструє скопійований код сайту: register('/sw.js'); sw.js сайту сюди не копіюється).
// Дані (/api — проксі на trip-control.com, Supabase, будь-які інші origin, не-GET) ніколи не кешуються і не перехоплюються.
// Сторінки — лише мережа, без мережі — offline.html. Кешуються тільки хешована збірка Vite (/kp-assets/), іконки й офлайн-сторінка;
// файли сайту (/assets/**) — без SW, звичайним HTTP-кешем, як на trip-control.com.
const VERSION = 'kp-2';
const STATIC_CACHE = 'kp-static-' + VERSION;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/offline.css', '/icons/icon-192.png', '/icons/symbol.svg'];

// 'bypass' — не чіпати (браузер іде в мережу сам), 'page' — навігація, 'static' — власний статичний файл.
function kpRoute(url, method, mode, origin) {
    if (method !== 'GET') return 'bypass';
    if (url.origin !== origin) return 'bypass';
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'bypass';
    if (mode === 'navigate') return 'page';
    if (url.search) return 'bypass';
    if (url.pathname.startsWith('/kp-assets/') || url.pathname.startsWith('/icons/') || PRECACHE.includes(url.pathname)) return 'static';
    return 'bypass';
}

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith('kp-static-') && key !== STATIC_CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const route = kpRoute(new URL(request.url), request.method, request.mode, self.location.origin);
    if (route === 'page') {
        event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    } else if (route === 'static') {
        event.respondWith(
            caches.match(request).then((hit) => hit || fetch(request).then((response) => {
                if (response.ok && response.type === 'basic' && !response.headers.has('Set-Cookie')) {
                    const copy = response.clone();
                    caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
                }
                return response;
            }))
        );
    }
});
