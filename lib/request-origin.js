// Origin поточного запиту для посилань (returnUrl оплати, запрошення в команду).
// Лише allowlist наших доменів; усе інше (preview, localhost, підроблений Host) — fallback.
export const ALLOWED_ORIGINS = Object.freeze([
    'https://trip-control.com',
    'https://www.trip-control.com',
    'https://app.trip-control.com'
]);

function firstHeader(req, name) {
    const headers = (req && req.headers) || {};
    const value = headers[name] != null ? headers[name] : headers[name.toLowerCase()];
    return String((Array.isArray(value) ? value[0] : value) || '').split(',')[0].trim();
}

// Origin (браузерний POST) → x-forwarded-host (запит через rewrite app → сайт) → Host.
export function requestOrigin(req, fallback) {
    const candidates = [];
    const origin = firstHeader(req, 'origin');
    if (origin) candidates.push(origin);
    for (const name of ['x-forwarded-host', 'host']) {
        const host = firstHeader(req, name);
        if (host) candidates.push('https://' + host);
    }
    for (const candidate of candidates) {
        let url;
        try { url = new URL(candidate); } catch { continue; }
        if (url.protocol === 'https:' && ALLOWED_ORIGINS.includes(url.origin)) return url.origin;
        // Перший заголовок, що вказує на чужий хост, не підміняємо наступним: це fallback.
        break;
    }
    return String(fallback || '').trim().replace(/\/+$/, '') || ALLOWED_ORIGINS[0];
}
