// Запуск: Vercel Web Analytics без cookies, реквізити в підвалі, чистка index.html / CSP / .vercelignore, мета для соцмереж, таймаут getUser.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const { enforceRateLimit, GETUSER_TIMEOUT_MS } = await import('../lib/rate-limit.js');

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const PAGES = ['index.html', '404.html', 'legal/offer.html', 'legal/privacy.html', 'legal/support.html', 'legal/payment-refund.html'];

test('аналітика: один same-origin скрипт Vercel Web Analytics на кожній публічній сторінці, без cookies і без зміни script-src', () => {
    for (const file of PAGES) {
        const html = read(file);
        assert.equal((html.match(/<script defer src="\/_vercel\/insights\/script\.js"><\/script>/g) || []).length, 1, file);
        assert.ok(html.indexOf('/_vercel/insights/script.js') < html.indexOf('</head>'), file + ': у <head>');
    }
    for (const file of ['vercel.json', 'apps/kontrol-plus/vercel.json']) {
        const config = JSON.parse(read(file));
        const csps = config.headers.flatMap((h) => h.headers).filter((h) => h.key === 'Content-Security-Policy').map((h) => h.value);
        assert.ok(csps.length >= 1, file);
        for (const csp of csps) {
            assert.match(csp, /script-src 'self'/, file + ': скрипт з власного походження вже дозволений');
            assert.match(csp, /connect-src 'self'/, file + ': /_vercel/insights/view — same-origin');
            assert.equal(/script\.google|vercel-scripts|va\.vercel/.test(csp), false, file);
        }
    }
    const privacy = read('legal/privacy.html');
    assert.match(privacy, /<strong>Знеособлена аналітика\.<\/strong> Для підрахунку відвідувань сайту ми використовуємо Vercel Web Analytics\. Вона працює без cookies/);
    assert.match(privacy, /не зберігає IP-адресу/);
    // Старе твердження «аналітика не підключена» прибрано, суперечностей щодо аналітики й cookies немає.
    assert.equal(/не підключено жодних аналітичних/.test(privacy), false);
    assert.equal(/Vercel Analytics|Google Analytics/.test(privacy), false);
    assert.equal((privacy.match(/Vercel Web Analytics/g) || []).length, 2, 'у таблиці постачальників і в абзаці про аналітику');
    assert.match(privacy, /Ми не використовуємо рекламних чи аналітичних cookies\. Аналітичні cookies не встановлюються: лічильник відвідувань працює без cookies/);
});

test('реквізити ФОП у підвалі кожної публічної сторінки (значення з оферти)', () => {
    const offer = read('legal/offer.html');
    for (const value of ['ФОП Харченко Святослав Вікторович', 'РНОКПП: 3184920472', '19700, Черкаська обл., м. Золотоноша, вул. Січова, буд. 25, кв. 75', 'support@trip-control.com', '+380730888252']) {
        assert.ok(offer.includes(value), 'в оферті: ' + value);
    }
    assert.match(offer, /<h2 id="requisites">15\. Реквізити Виконавця<\/h2>/, 'якір для посилання з підвалу');
    assert.ok(offer.includes('РНОКПП: 3184920472') && offer.includes('Золотоноша'), 'повні реквізити лишаються в оферті');
    for (const file of PAGES) {
        const footers = [...read(file).matchAll(/<footer class="tc-legal-footer">[\s\S]*?<\/footer>/g)].map((m) => m[0]);
        assert.ok(footers.length >= 1, file);
        for (const footer of footers) {
            for (const value of ['ФОП Харченко С.В.', 'mailto:support@trip-control.com', 'tel:+380730888252', '<a href="/offer#requisites">Реквізити</a>']) {
                assert.ok(footer.includes(value), file + ': ' + value);
            }
            // РНОКПП і адреса — лише в тілі оферти (розділ 15), не в підвалі.
            for (const value of ['3184920472', 'Золотоноша', 'Січова']) assert.equal(footer.includes(value), false, file + ': ' + value + ' не в підвалі');
            assert.equal(/TODO/.test(footer), false, file);
        }
    }
});

test('чистка index.html: без console.log і без відправки в Google Таблицю; CSP без script.google.com', () => {
    const html = read('index.html');
    assert.equal(/console\.log\(/.test(html), false);
    assert.equal(/GOOGLE_SCRIPT_URL|script\.google\.com|script\.googleusercontent\.com/.test(html), false);
    for (const file of ['vercel.json', 'apps/kontrol-plus/vercel.json']) assert.equal(/script\.google/.test(read(file)), false, file);
    assert.match(html, /async function saveCalculation\(/);
    assert.match(html, /return savedId;/);
});

test('.vercelignore: внутрішнє не публікується, потрібне сайту лишається', () => {
    const lines = read('.vercelignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const entry of ['/design/', '/docs/', '/tests/', '/SECURITY-FIX-PLAN.md', '/apps/', '/supabase/', '/scripts/', '*.md']) assert.ok(lines.includes(entry), entry);
    // Усе, що віддає сайт (корінь Vercel-проєкту), не під ignore.
    const ignoredDirs = lines.filter((l) => l.startsWith('/') && l.endsWith('/'));
    for (const needed of ['index.html', '404.html', 'offline.html', 'sw.js', 'site.webmanifest', 'sitemap.xml', 'robots.txt', 'favicon.ico', 'apple-touch-icon.png',
        'legal/offer.html', 'legal/privacy.html', 'legal/support.html', 'legal/payment-refund.html', 'assets/brand/og-1200x630.png', 'api/calculate.js', 'lib/rate-limit.js']) {
        assert.ok(existsSync(new URL('../' + needed, import.meta.url)), needed + ' існує');
        assert.equal(ignoredDirs.some((d) => ('/' + needed).startsWith(d)), false, needed + ' не ігнорується');
        assert.equal(lines.some((l) => l.startsWith('*.') && needed.endsWith(l.slice(1))), false, needed + ' не потрапляє під маску');
    }
});

test('мета для соцмереж: summary_large_image, og:image 1200×630 з файлом у repo, lastmod у sitemap', () => {
    const html = read('index.html');
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/trip-control\.com\/assets\/brand\/og-1200x630\.png">/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/trip-control\.com\/assets\/brand\/og-1200x630\.png">/);
    assert.match(html, /<meta property="og:image:width" content="1200">/);
    assert.match(html, /<meta property="og:image:height" content="630">/);
    const png = readFileSync(new URL('../assets/brand/og-1200x630.png', import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
    assert.ok(png.length < 300 * 1024, 'файл помірного розміру');
    const sitemap = read('sitemap.xml');
    const urls = sitemap.match(/<url>[\s\S]*?<\/url>/g);
    assert.ok(urls.length >= 5);
    for (const url of urls) assert.match(url, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, url);
});

// ---- Таймаут перевірки токена ----
const res = () => {
    const out = {};
    out.setHeader = () => {};
    out.status = (code) => { out.code = code; return out; };
    out.json = (body) => { out.body = body; return out; };
    return out;
};
const request = (token) => ({ method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-vercel-forwarded-for': '192.0.2.8' }, socket: {} });

test('getUser довше 1,5 с не вішає запит: рахується як анонім за IP', async () => {
    assert.equal(GETUSER_TIMEOUT_MS, 1500);
    const calls = [];
    const rpc = async (args) => { calls.push(args); return { data: [{ allowed: true }], error: null }; };
    const never = () => new Promise(() => {});
    const started = Date.now();
    assert.equal(await enforceRateLimit(request('slow'), res(), 'calculate', { rpc, getUser: never, timeoutMs: 40 }), true);
    assert.ok(Date.now() - started < 1000, 'відповідь не чекає на getUser');
    assert.equal(calls[0].p_limit, 20, 'ліміт аноніма');
    // Швидка відповідь у межах таймауту лишається користувачем.
    const fast = [];
    await enforceRateLimit(request('fast'), res(), 'calculate', { rpc: async (a) => { fast.push(a); return { data: [{ allowed: true }], error: null }; }, getUser: async () => 'user-1', timeoutMs: 200 });
    assert.equal(fast[0].p_limit, 120);
    assert.match(read('lib/rate-limit.js'), /GETUSER_TIMEOUT_MS = 1500/);
});
