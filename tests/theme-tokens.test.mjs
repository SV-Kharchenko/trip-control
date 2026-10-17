import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../site.webmanifest', import.meta.url), 'utf8');

function extractFunction(name, params) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) return new Function(...params, html.slice(open + 1, i));
        }
    }
    throw new Error('unclosed ' + name);
}

test('light is the default theme and stored ocean, paper and control migrate', () => {
    assert.match(html, /const THEME_ORDER = \['light', 'dark'\];/);
    assert.equal(html.includes("const THEME_ORDER = ['ocean'"), false);
    assert.match(html, /<body class="layout-studio" data-theme="light">/);
    const normalizeTheme = extractFunction('normalizeTheme', ['t']);
    globalThis.THEME_ORDER = ['light', 'dark'];
    assert.equal(normalizeTheme('ocean'), 'light');
    assert.equal(normalizeTheme('paper'), 'light');
    assert.equal(normalizeTheme('night'), 'light');
    assert.equal(normalizeTheme('amber'), 'light');
    assert.equal(normalizeTheme('control'), 'dark');
    assert.equal(normalizeTheme('light'), 'light');
    assert.equal(normalizeTheme('dark'), 'dark');
    assert.equal(normalizeTheme(''), 'light');
    assert.equal(normalizeTheme(undefined), 'light');
    assert.match(html, /\[data-theme="light"\][\s\S]*--bg: #F4EFE4/);
    assert.match(html, /\[data-theme="dark"\][\s\S]*--bg: #0E1117/);
    assert.match(html, /--accent: #0D2A29/);
    assert.match(html, /--accent: #7C9CFF/);
    assert.match(html, /--brand-black: #0A0A0A/);
    assert.match(html, /--brand-cream: #F0ECE3/);
    assert.match(html, /--brand-beige: #D6C29E/);
    assert.match(html, /family=Manrope/);
    assert.match(html, /JetBrains\+Mono/);
    assert.equal(html.includes('IBM+Plex'), false);
    assert.match(html, /rel="manifest" href="\/site\.webmanifest"/);
    assert.match(manifest, /assets\/brand\/icon-512\.png/);
    assert.match(manifest, /assets\/brand\/icon-1024\.png/);
    assert.match(manifest, /apple-touch-icon\.png/);
});

function cssBlock(selector) {
    const marker = selector + ' {';
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, selector);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) return html.slice(open + 1, i);
        }
    }
    throw new Error('unclosed ' + selector);
}

function sourceOf(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) return html.slice(start, i + 1);
        }
    }
    throw new Error('unclosed ' + name);
}

function token(block, name) {
    const match = block.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})'));
    assert.ok(match, name);
    return match[1].toUpperCase();
}

function channel(hex) {
    const value = parseInt(hex.slice(1), 16);
    const raw = [value >> 16, (value >> 8) & 255, value & 255];
    return raw.map(function (part) {
        const c = part / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
}

function contrast(fg, bg) {
    const L = function (hex) {
        const [r, g, b] = channel(hex);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const hi = Math.max(L(fg), L(bg));
    const lo = Math.min(L(fg), L(bg));
    return (hi + 0.05) / (lo + 0.05);
}

test('light and dark text pairs stay at least 4.5:1', () => {
    const light = cssBlock('[data-theme="light"]');
    const dark = cssBlock('[data-theme="dark"]');
    const lightTokens = {
        bg: token(light, 'bg'),
        surface: token(light, 'surface'),
        input: token(light, 'input'),
        text: token(light, 'text'),
        muted: token(light, 'muted'),
        accent: token(light, 'accent'),
        onAccent: token(light, 'on-accent'),
        teal: token(light, 'teal'),
        warningText: token(light, 'warning-text')
    };
    const darkTokens = {
        bg: token(dark, 'bg'),
        surface: token(dark, 'surface'),
        input: token(dark, 'input'),
        text: token(dark, 'text'),
        muted: token(dark, 'muted'),
        accent: token(dark, 'accent'),
        onAccent: token(dark, 'on-accent'),
        teal: token(dark, 'teal'),
        warningText: token(dark, 'warning-text')
    };
    assert.equal(lightTokens.muted, '#5A6B66');
    assert.equal(lightTokens.teal, '#1A6B65');
    assert.equal(lightTokens.warningText, '#8A6420');
    assert.equal(light.includes('#6B7D78'), false);
    assert.equal(light.includes('#2F8F86'), false);
    assert.deepEqual(darkTokens, {
        bg: '#0E1117',
        surface: '#161B24',
        input: '#11151C',
        text: '#E8EAF0',
        muted: '#8B93A3',
        accent: '#7C9CFF',
        onAccent: '#0B0E14',
        teal: '#4FD1C5',
        warningText: '#E0B25A'
    });
    for (const tokens of [lightTokens, darkTokens]) {
        for (const bg of [tokens.bg, tokens.surface, tokens.input]) {
            assert.ok(contrast(tokens.text, bg) >= 4.5, tokens.text + ' on ' + bg);
            assert.ok(contrast(tokens.muted, bg) >= 4.5, tokens.muted + ' on ' + bg);
            assert.ok(contrast(tokens.teal, bg) >= 4.5, tokens.teal + ' on ' + bg);
            assert.ok(contrast(tokens.warningText, bg) >= 4.5, tokens.warningText + ' on ' + bg);
        }
        assert.ok(contrast(tokens.onAccent, tokens.accent) >= 4.5);
    }
    // етап 8: стилі старих тем прибрано, лишилась тільки міграція збереженого значення
    assert.equal(/\[data-theme="(ocean|control|paper)"\]/.test(html), false);
    assert.equal(/ocean|paper/i.test(html.replace(sourceOf('normalizeTheme'), '')), false);
    assert.match(html, /const TC_MAP_LIGHT_STYLES = \[/);
    assert.match(html, /const TC_MAP_DARK_STYLES = \[/);
    assert.equal(html.includes('undressPaperSections'), false);
    assert.match(html, /body\[data-theme="light"\] \.auth-card \{[\s\S]*background: var\(--surface\)/);
    assert.match(html, /body\[data-theme="light"\] \.auth-tabs button\.on \{[\s\S]*background: var\(--accent\);[\s\S]*color: var\(--on-accent\)/);
    // Плитки «Пресети причепа» прибрано разом зі стилями.
    assert.equal(html.includes('.preset-tile'), false);
    assert.equal(html.includes('paperStudio'), false);
    assert.equal(html.includes('function dressPaperSections'), false);
    for (const name of ['applyMapTheme', 'mountStudioDom', 'renderChart', 'initMap']) {
        const source = sourceOf(name);
        assert.equal(source.includes("'paper'"), false, name);
        assert.equal(source.includes("'control'"), false, name);
    }
    const migrate = sourceOf('normalizeTheme');
    assert.match(migrate, /t === 'paper'/);
    assert.match(migrate, /t === 'control'/);
});
