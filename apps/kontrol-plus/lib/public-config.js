// Публічна конфігурація фронтенду з env Vercel: адреса бази, ПУБЛІЧНИЙ (anon / publishable) ключ, середовище й вимкнені модулі.
// Віддається скриптом /api/config → window.TC_CONFIG (index.html і «Контроль+» читають її при ініціалізації Supabase).
//
// Правила:
// * Жодного запасного варіанта з продовими значеннями: немає env — явна помилка (503, скрипт не виконується, фронт показує повідомлення),
//   а не тихий preview у продовій базі.
// * Service role НІКОЛИ не потрапляє у відповідь: віддаються лише чотири поля, а ключ, схожий на service role / secret, відхиляється.
// * Копія цього файлу лежить в apps/kontrol-plus/lib/public-config.js (окремий проєкт Vercel не бачить корінь репозиторію); тест
//   tests/public-config.test.mjs стежить, щоб копії були однакові.

const SUPABASE_HOST = /^[a-z0-9]{10,40}\.supabase\.co$/;

// Ключі модулів: малі латинські літери, цифри, підкреслення (як key в app_settings).
export function disabledFeatures(env) {
    return String((env && env.KP_DISABLED_FEATURES) || '')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter((k, i, all) => /^[a-z][a-z0-9_]{0,63}$/.test(k) && all.indexOf(k) === i);
}

export function isFeatureDisabled(env, key) {
    return disabledFeatures(env).includes(String(key || '').toLowerCase());
}

// Ключ сесії supabase-js залежить від ref проєкту: sb-<ref>-auth-token (так само рахує supabase-js).
export function sessionStorageKey(supabaseUrl) {
    return 'sb-' + new URL(supabaseUrl).hostname.split('.')[0] + '-auth-token';
}

function jwtRole(key) {
    const parts = String(key).split('.');
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || null;
    } catch {
        return null;
    }
}

// Назва середовища для бейджа: production лише на проді; усе інше (preview, development, не задано) — не прод.
export function appEnvironment(env) {
    const raw = String((env && (env.APP_ENV || env.VERCEL_ENV)) || '').trim().toLowerCase();
    return raw === 'production' ? 'production' : 'staging';
}

// → { ok: true, config } | { ok: false, problems: [...] } (у problems лише назви змінних і причини, без значень).
export function buildPublicConfig(env) {
    const problems = [];
    const url = String((env && env.SUPABASE_URL) || '').trim().replace(/\/+$/, '');
    const key = String((env && env.SUPABASE_ANON_KEY) || '').trim();
    if (!url) problems.push('SUPABASE_URL is not set');
    else {
        let host = '';
        try {
            const u = new URL(url);
            host = u.protocol === 'https:' && !u.port && !u.username && (u.pathname === '/' || u.pathname === '') ? u.hostname : '';
        } catch { /* нижче — помилка */ }
        if (!SUPABASE_HOST.test(host)) problems.push('SUPABASE_URL must look like https://<project-ref>.supabase.co');
    }
    if (!key) problems.push('SUPABASE_ANON_KEY is not set');
    else if (/^sb_secret_/i.test(key) || jwtRole(key) === 'service_role' || !/^[A-Za-z0-9._-]{20,400}$/.test(key)) {
        problems.push('SUPABASE_ANON_KEY must be the public anon / publishable key');
    }
    if (problems.length) return { ok: false, problems };
    return { ok: true, config: { supabaseUrl: url, supabaseAnonKey: key, env: appEnvironment(env), disabledFeatures: disabledFeatures(env) } };
}

// Бейдж «STAGING» (не прод): фіксована смужка зверху по центру; кольори — CSS-змінні, які можна перекрити темою.
export const STAGING_BADGE_CSS = ':root{--tc-staging-bg:#b3261e;--tc-staging-ink:#fff}'
    + '[data-theme="dark"]{--tc-staging-bg:#f2b8b5;--tc-staging-ink:#410e0b}'
    + '#tc-staging-badge{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:3600;padding:2px 14px;border-radius:0 0 8px 8px;'
    + 'background:var(--tc-staging-bg);color:var(--tc-staging-ink);font:700 11px/1.6 system-ui,sans-serif;letter-spacing:.12em;pointer-events:none}';

// JS для <script src="/api/config">: заморожений window.TC_CONFIG (+ бейдж поза продом). </ екранується, щоб значення не закрило тег.
export function renderConfigScript(config) {
    const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
    let js = 'window.TC_CONFIG = Object.freeze(' + json + ');\n';
    if (config.env !== 'production') {
        js += 'document.documentElement.setAttribute("data-env", "staging");\n'
            + '(function(){var s=document.createElement("style");s.textContent=' + JSON.stringify(STAGING_BADGE_CSS) + ';document.head.appendChild(s);'
            + 'function add(){if(document.getElementById("tc-staging-badge"))return;var b=document.createElement("div");b.id="tc-staging-badge";b.setAttribute("role","status");'
            + 'b.textContent="STAGING";document.body.appendChild(b);}'
            + 'if(document.body)add();else document.addEventListener("DOMContentLoaded",add);})();\n';
    }
    return js;
}

// Обробник GET /api/config (Vercel): 200 + скрипт або 503 без тіла-скрипта (браузер не виконає, фронт покаже явну помилку).
export function createConfigHandler(getEnv = () => process.env, log = console) {
    return function configHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            return res.status(405).send('Method Not Allowed');
        }
        const built = buildPublicConfig(getEnv());
        if (!built.ok) {
            // Лише назви змінних: значення не логуємо.
            log.error('[config] ' + built.problems.join('; '));
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.status(503).send('Public config is not set up on the server.');
        }
        // Конфіг змінюється лише з env + редеплоєм: хвилина приватного кешу браузера знімає зайві запити; помилки (405 / 503) не кешуються (no-store вище).
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        return res.status(200).send(renderConfigScript(built.config));
    };
}
