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
