// Інжект Контроль+ у КОПІЮ index.html сайту (dist/index.html і dev-сервер). Оригінал і .site/index.html не змінюються.
// Лише вставки між <!--kp:start--> і <!--kp:end--> плюс маніфест застосунку замість /site.webmanifest.
export const SITE_MANIFEST = '<link rel="manifest" href="/site.webmanifest">';
export const KP_MANIFEST = '<link rel="manifest" href="/manifest.webmanifest">';
export const KP_START = '<!--kp:start-->';
export const KP_END = '<!--kp:end-->';

const attr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function once(html, marker) {
    const first = html.indexOf(marker);
    if (first < 0 || first !== html.lastIndexOf(marker)) {
        throw new Error(`index.html сайту: очікувався рівно один ${marker} — перевірте site-html.mjs після змін сайту`);
    }
    return first;
}

function insertBefore(html, marker, block) {
    const at = once(html, marker);
    return html.slice(0, at) + KP_START + block + KP_END + '\n' + html.slice(at);
}

// js — модуль site-bridge (у dev — /src/site-bridge.js), css — його стилі після збірки (у dev Vite вставляє їх сам).
export function injectSite(html, { js, css = [] }) {
    once(html, SITE_MANIFEST);
    let out = html.replace(SITE_MANIFEST, KP_MANIFEST);
    out = insertBefore(out, '</head>', '\n<meta name="robots" content="noindex">\n'
        + css.map((href) => `<link rel="stylesheet" href="${attr(href)}">\n`).join('')
        + '<script src="/kp-entry.js"></script>\n');
    out = insertBefore(out, '</body>', `\n<script type="module" src="${attr(js)}"></script>\n`);
    return out;
}

// Зворотна операція для тестів: прибирає вставки — має вийти байт у байт оригінал сайту.
export function stripInjected(html) {
    const blocks = new RegExp(KP_START + '[\\s\\S]*?' + KP_END + '\\n', 'g');
    return html.replace(blocks, '').replace(KP_MANIFEST, SITE_MANIFEST);
}
