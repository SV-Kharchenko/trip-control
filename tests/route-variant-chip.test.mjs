// Чіп обраного варіанта маршруту на карті (калькулятор і екран погодження директором): видимий текст у всіх темах, aria-pressed, focus-ring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const luminance = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};
const rule = (selectorStart) => {
    const at = html.indexOf(selectorStart);
    assert.ok(at > 0, selectorStart);
    return html.slice(html.indexOf('{', at) + 1, html.indexOf('}', at));
};
const prop = (body, name) => (new RegExp('(?:^|[;\\s])' + name + ':\\s*(#[0-9A-Fa-f]{6})').exec(body) || [])[1];

test('обраний чіп: колір тексту і його заливка (-webkit-text-fill-color) задані явно, контраст ≥ 4,5:1 у Light / Dark / Night', () => {
    const base = rule('body.layout-studio .tc-map-alts .tc-map-alt.active,');
    const light = rule('body.layout-studio[data-theme="light"] .tc-map-alts .tc-map-alt.active,');
    const themes = { 'Dark / Night / Amber': base, Light: light };
    for (const [name, body] of Object.entries(themes)) {
        const bg = prop(body, 'background');
        const fg = prop(body, 'color');
        const fill = prop(body, '-webkit-text-fill-color');
        assert.ok(bg && fg && fill, name + ': background, color і text-fill задані');
        assert.equal(fill, fg, name + ': заливка тексту збігається з color (інакше її перебиває тема)');
        assert.ok(contrast(bg, fg) >= 4.5, name + ': контраст ' + contrast(bg, fg).toFixed(2));
    }
    assert.match(base, /font-weight:\s*800/);
    assert.match(base, /border:\s*2px solid/);
    // Light не успадковує світлий фон від Dark: фон і текст перевизначені в одному правилі.
    assert.notEqual(prop(base, 'background'), prop(light, 'background'));
});

test('причина виправлена: загальні правила теми не лишають темну заливку тексту на вибраному чіпі', () => {
    const theme = rule('body.layout-studio[data-theme="light"] .tc-map-btn,');
    assert.match(theme, /-webkit-text-fill-color:\s*var\(--text\)/, 'тема справді задає text-fill для всіх чіпів');
    // Правило вибраного чіпа специфічніше за правила тем (є .tc-map-alts і [aria-pressed]) і не залежить від порядку.
    assert.ok(html.indexOf('body.layout-studio .tc-map-alts .tc-map-alt.active,') > html.indexOf('body.layout-studio[data-theme="light"] .tc-map-alt,'));
});

test('hover і focus-visible: видимий focus-ring для клавіатури, чіп і вибраний, і звичайний', () => {
    const focus = rule('body.layout-studio .tc-map-alts .tc-map-alt:focus-visible');
    assert.match(focus, /outline:\s*2px solid #FFD166/);
    assert.match(focus, /outline-offset:\s*2px/);
    assert.match(html, /\.tc-map-alt\[aria-pressed="true"\]:focus-visible/);
    assert.match(html, /\.tc-map-alt\.active:hover,/);
    assert.ok(contrast('#FFD166', '#0B0E14') >= 3, 'кільце помітне на темній підкладці');
});

test('розмітка: aria-pressed на всіх чіпах варіантів (калькулятор, огляд директора, прев\'ю)', () => {
    const buttons = [...html.matchAll(/'<button type="button" class="tc-map-alt'[^\n]*/g)].map((m) => m[0]);
    assert.equal(buttons.length, 3, 'три місця створення чіпів');
    for (const line of buttons) assert.match(line, /aria-pressed="' \+ /, line.slice(0, 120));
    assert.match(html, /class="tc-map-alts" id="tc-review-alts"/, 'екран директора використовує той самий .tc-map-alt');
});

test('розмір за вмістом, текст не обрізається, на мобільному ряд із прокруткою', () => {
    const chip = rule('body.layout-studio .tc-map-alts .tc-map-alt {');
    assert.match(chip, /width:\s*max-content/);
    assert.match(chip, /max-width:\s*100%/);
    assert.match(chip, /white-space:\s*normal/);
    assert.match(chip, /overflow-wrap:\s*anywhere/);
    assert.doesNotMatch(chip, /overflow:\s*hidden|text-overflow|(?<![-\w])width:\s*100%/);
    const mobile = html.slice(html.indexOf('body.layout-studio .tc-map-frame > .tc-map-alts .tc-map-alt {\n                flex: 0 0 auto;'));
    assert.match(mobile.slice(0, 260), /white-space:\s*nowrap/);
    assert.match(html, /body\.layout-studio \.tc-map-frame > \.tc-map-alts \{\s*position: static !important;/, 'на мобільному ряд не налазить на кнопки карти');
});

test('логіка вибору не змінена: selectRouteAlternative і перерахунок на місці', () => {
    assert.match(html, /function selectRouteAlternative\(/);
    assert.match(html, /onclick="selectRouteAlternative\(' \+ i \+ '\)"/);
});
