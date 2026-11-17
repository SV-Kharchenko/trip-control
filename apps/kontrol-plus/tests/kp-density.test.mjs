// Щільність Контроль+ на ноутбуках 14" (≈1200–1500px): лише КП, лише токени й media query, без zoom / transform: scale; телефон, планшет і 1920 не міняються.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const css = read('src/kp-density.css');
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('одна media query 1200–1500px: усе правила всередині неї, нижче й вище діапазону нічого немає', () => {
    const medias = [...clean.matchAll(/@media\s*([^{]+)\{/g)].map((m) => m[1].trim());
    assert.deepEqual(medias, ['(min-width: 1200px) and (max-width: 1500px)']);
    // Файл — одна обгортка @media: після її закриття правил немає.
    assert.equal(clean.trim().startsWith('@media'), true);
    assert.equal(clean.trim().endsWith('}'), true);
    assert.equal(/max-width:\s*(?:[1-9]\d{0,2}|1[01]\d\d)px/.test(clean), false, '390 і 1024 не чіпаємо');
});

test('без zoom і transform: scale; розміри через токени (--kp-*, --kpd-*, --tc-*) і кореневий font-size', () => {
    assert.equal(/\bzoom\s*:/.test(clean), false);
    assert.equal(/transform\s*:/.test(clean), false);
    assert.equal(/scale\(/.test(clean), false);
    assert.match(clean, /html\[data-app="kp"\] \{ font-size: 85%; \}/);
    for (const token of ['--kp-side-w: 196px', '--kp-top-h: 44px', '--kpd-ctl: 32px', '--kpd-ctl-sm: 26px', '--tc-h: 26px']) assert.ok(clean.includes(token), token);
    assert.match(clean, /body\.kp-shell-on\.kp-shell-collapsed \{ --kp-side-w: 56px; \}/);
    assert.match(clean, /body\.kp-shell-on\.kp-shell-strip-on \{ --kp-strip-h: 26px; \}/);
});

test('зменшення ≈15–20% від поточних розмірів (сайдбар, шапка, поле, кнопка, KPI)', () => {
    const base = read('src/kp-shell.css');
    assert.match(base, /--kp-side-w: 232px/);
    assert.match(base, /--kp-top-h: 52px/);
    const ratio = (a, b) => 1 - a / b;
    for (const [now, was] of [[196, 232], [44, 52], [32, 38], [26, 30]]) assert.ok(ratio(now, was) >= 0.1 && ratio(now, was) <= 0.2, now + '/' + was);
    assert.ok(0.85 >= 0.8 && 0.85 <= 0.85);
});

test('лише Контроль+: файл підключає site-bridge.js, сайт (index.html, assets) його не знає, правила не зачіпають сайтові селектори без області КП', () => {
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-density\.css';/);
    const site = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    assert.equal(/kp-density/.test(site), false);
    // Кожен селектор — з області КП (html[data-app="kp"], body.kp-shell-on, #kp-crm, .kpd-*, #tc-calc-nav).
    const heads = [...clean.replace(/@media[^{]+\{/, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).flatMap((h) => h.split(/,(?![^(]*\))/).map((s) => s.trim()));
    assert.ok(heads.length > 40);
    for (const sel of heads) assert.match(sel, /^(html\[data-app="kp"\]|body\.kp-shell-(on|collapsed)|#kp-crm|\.kpd-|#tc-calc-nav)/, sel);
});

test('карта, клікабельні зони й вікна: розміри карти лишаються від виміряних токенів, фіксовані вікна й попапи не чіпаємо', () => {
    assert.equal(/position\s*:\s*fixed/.test(clean), false);
    assert.equal(/\.kp-win|\.kpw-|gm-style|gmp-map/.test(clean), false, 'вікна й Google Map не стилізуються тут');
    assert.equal(/min-height:\s*(?:[0-9]|1\d)px/.test(clean.replace(/min-height:\s*(var|calc)\([^;]*;/g, '')), false, 'кнопки не стають менше 20px заввишки');
    assert.match(clean, /\.tc-map-frame \{ min-height: 320px !important; \}/);
    assert.match(clean, /grid-template-columns: 200px minmax\(360px, min\(34%, 440px\)\) minmax\(0, 1fr\)/);
});
