import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function buildOnePage');
const build = html.slice(start, start + 20000);

test('п.11: порядок Звідки–Куди → Подача → «Розрахувати відстань» → числа', () => {
    const ab = build.indexOf("opCell('tc-f-a', 'Звідки'");
    const podacha = build.indexOf("opCell('tc-f-podacha'");
    const tools = build.indexOf('panel1.appendChild(routeTools)');
    const nums = build.indexOf("opGroup('nums'");
    assert.ok(ab > 0 && ab < podacha && podacha < tools && tools < nums, 'порядок блоків у panel1');
    assert.match(html, /id="route-calc-btn"[^>]*>Розрахувати відстань</);
});

test('п.12: підпис «ТЗ (транспортний засіб)» замість «Фура»', () => {
    assert.match(build, /opCell\('tc-f-truck', 'ТЗ \(транспортний засіб\)'/);
    assert.match(build, /truckLab\.textContent = 'ТЗ \(транспортний засіб\)'/);
    assert.equal(/opCell\('tc-f-truck', 'Фура'/.test(build), false);
});

// ---- П.13: контраст картки результату (Light / Dark) ----
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, pa) => a.map((v, i) => Math.round(v * pa + b[i] * (1 - pa)));
const token = (block, name) => (block.match(new RegExp(name + ':\\s*(#[0-9A-Fa-f]{6})')) || [])[1];
const theme = (name) => { const s = html.indexOf('[data-theme="' + name + '"] {'); return html.slice(s, html.indexOf('}', s)); };

test('п.13: тексти картки результату на світло-зеленому фоні — контраст ≥ 4.5:1 (Light) і в Dark', () => {
    assert.match(html, /--tc-result-muted: var\(--result-muted-on-light\)/);
    const light = theme('light');
    const dark = theme('dark');
    const lightBg = mix(hex(token(light, '--positive')), hex(token(light, '--surface')), 0.1);
    const lightInk = {
        fg: token(light, '--text'), muted: token(light, '--result-muted-on-light'), down: token(light, '--result-down-on-light'), be: token(light, '--result-be-on-light'), up: token(light, '--positive'),
    };
    for (const [name, color] of Object.entries(lightInk)) assert.ok(ratio(hex(color), lightBg) >= 4.5, 'Light ' + name + ' ' + ratio(hex(color), lightBg).toFixed(2));
    const darkBg = mix(hex(token(dark, '--positive')), hex(token(dark, '--surface')), 0.1);
    const darkInk = { fg: token(dark, '--text'), muted: token(dark, '--muted-on-dark'), down: token(dark, '--negative-on-dark'), be: token(dark, '--gold'), up: token(dark, '--positive') };
    for (const [name, color] of Object.entries(darkInk)) assert.ok(ratio(hex(color), darkBg) >= 4.5, 'Dark ' + name + ' ' + ratio(hex(color), darkBg).toFixed(2));
    // Було: світлі токени для темної картки (#F4EFE6 / #A9BCB7) на світло-зеленому — нижче порогу, тому й блякло.
    assert.ok(ratio(hex('#A9BCB7'), lightBg) < 4.5);
});
