// Тег Google (GTM-TCNFWFRZ) і конверсія sign_up: тег один раз, CSP дозволяє домени Google, подія летить лише з успішної реєстрації.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

function functionSource(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error('unclosed ' + name);
}

test('тег у <head> один раз, noscript одразу після <body>, без класичного IIFE-бутстрапа', () => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    assert.equal(html.split('gtm.js?id=GTM-TCNFWFRZ').length, 2);
    assert.equal(html.split('ns.html?id=GTM-TCNFWFRZ').length, 2);
    assert.ok(head.indexOf('gtm.js?id=GTM-TCNFWFRZ') < head.indexOf('<title>'));
    assert.ok(head.includes("gtag('js', new Date());"));
    assert.match(html, /<body[^>]*>\n<noscript><iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-TCNFWFRZ"/);
    assert.equal(/\(function\(w,d,s,l,i\)/.test(html), false);
    assert.equal(/AW-\d|['"]G-[A-Z0-9]{6,}/.test(html), false);
});

test('CSP у vercel.json: джерела GTM/Ads додані, Supabase / карти / bank.gov.ua на місці', () => {
    const rule = vercel.headers.find((h) => h.source === '/(.*)');
    const csp = rule.headers.find((h) => h.key === 'Content-Security-Policy').value;
    const dir = (name) => csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(name + ' ')).split(/\s+/);
    const need = {
        'script-src': ['https://www.googletagmanager.com', 'https://www.googleadservices.com', 'https://www.google.com'],
        'connect-src': ['https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com', 'https://www.google.com', 'https://www.google.com.ua', 'https://www.googleadservices.com', 'https://googleads.g.doubleclick.net', 'https://stats.g.doubleclick.net'],
        'img-src': ['https://www.googletagmanager.com', 'https://www.google.com', 'https://www.google.com.ua', 'https://www.googleadservices.com', 'https://googleads.g.doubleclick.net'],
        'frame-src': ['https://www.googletagmanager.com'],
    };
    for (const [name, list] of Object.entries(need)) for (const src of list) assert.ok(dir(name).includes(src) || (name === 'img-src' && src === 'https://www.google.com' && dir(name).includes('https://*.google.com')), name + ' ' + src);
    for (const keep of ['https://*.supabase.co', 'wss://*.supabase.co', 'https://maps.googleapis.com', 'https://bank.gov.ua']) assert.ok(dir('connect-src').includes(keep), keep);
    assert.ok(dir('default-src').includes("'self'") && dir('default-src').length === 2);
    assert.equal(rule.headers.filter((h) => h.key === 'Content-Security-Policy').length, 1);
});

function tracker({ withGtag }) {
    const win = { dataLayer: [] };
    const factory = new Function('window', 'withGtag', `
        ${withGtag ? 'function gtag(){ window.dataLayer.push(arguments); }' : ''}
        ${functionSource(html, 'trackSignUp')}
        return trackSignUp;
    `);
    return { win, track: factory(win, withGtag) };
}

test('trackSignUp: sign_up з method=email без персональних даних; повторна пошта (identities=[]) не рахується', () => {
    const a = tracker({ withGtag: true });
    a.track({ id: 'u1', email: 'x@y.z', identities: [{}] });
    assert.equal(a.win.dataLayer.length, 1);
    assert.deepEqual(Array.from(a.win.dataLayer[0]), ['event', 'sign_up', { method: 'email' }]);
    assert.equal(/x@y\.z|u1/.test(JSON.stringify(Array.from(a.win.dataLayer[0]))), false);
    const b = tracker({ withGtag: false });
    b.track({ id: 'u2' });
    assert.deepEqual(b.win.dataLayer, [{ event: 'sign_up', method: 'email' }]);
    const c = tracker({ withGtag: true });
    c.track({ id: 'u3', identities: [] });
    assert.equal(c.win.dataLayer.length, 0);
});

test('sign_up викликається лише з успішного signUp (без error, не запрошення), більше ніде', () => {
    assert.equal(html.split('trackSignUp(').length, 3, 'визначення + один виклик');
    assert.match(html, /auth\.signUp\(\{ email, password, options: signupOptions \}\);\n\s+if \(!error && data && data\.user && !invite\) trackSignUp\(data\.user\);/);
    assert.equal(html.split("'sign_up'").length, 3, 'gtag + запасний push — обидва в trackSignUp');
});
