import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start + ' … ' + end);
    return source.slice(from, to);
}

test('the old compass logo is gone from every page and from assets', () => {
    for (const page of ['index.html', '404.html', 'legal/offer.html', 'legal/privacy.html', 'site.webmanifest']) {
        assert.equal(read(page).includes('logo-compass'), false, page);
    }
    for (const file of ['logo-compass-112.png', 'logo-compass-112.webp', 'logo-compass-512.png', 'logo-compass-only.png']) {
        assert.equal(existsSync(new URL('../assets/' + file, import.meta.url)), false, file);
    }
    assert.match(read('legal/offer.html'), /og:image" content="https:\/\/trip-control\.com\/assets\/brand\/icon-512\.png"/);
    assert.match(read('legal/privacy.html'), /twitter:image" content="https:\/\/trip-control\.com\/assets\/brand\/icon-512\.png"/);
    assert.match(read('404.html'), /<img src="\/assets\/brand\/symbol-dark\.svg"/);
    const crm = sliceBetween(html, '<div class="tc-lockup tc-lockup--crm"', '<h2');
    assert.match(crm, /<svg class="tc-logo-svg tc-crm-mark"/);
    assert.equal(crm.includes('<img'), false);
});

test('old header and theme styles are removed', () => {
    const css = sliceBetween(html, '<style>', '</style>');
    for (const dead of ['.tc-actions', '.tc-action-btn', '.tc-lockup--header', '.tc-lockup__compass', '.paper-', 'bg-network.jpg\') center / cover no-repeat;\n']) {
        assert.equal(css.includes(dead), false, dead);
    }
    assert.equal(/\[data-theme="(ocean|control|paper)"\]/.test(css), false);
    // фото-фон лишається тільки на екрані входу (його видно в темній темі)
    assert.equal((css.match(/bg-network\.jpg/g) || []).length, 1);
});

test('cascade sums and result card numbers use the typographic minus', () => {
    const paint = sliceBetween(html, 'function paintCascade(result)', 'function paintProfitHero(result)');
    assert.match(paint, /tc-cascade-num">' \+ displayMinus\(formatMoney\(row\.amount\)\) \+ note/);
    assert.match(paint, /dockCascade\.innerHTML = host\.innerHTML;/);
    const apply = sliceBetween(html, 'function applyCalcResult(', 'async function calculate()');
    for (const id of ['res-income-net', 'res-margin-ton', 'res-ebitda-ton']) {
        assert.match(apply, new RegExp("getElementById\\('" + id + "'\\)\\.innerText = displayMinus\\("), id);
    }
    assert.match(apply, /profitFx\.textContent = displayMinus\(fxSuffix\(result\.netProfit\)\)/);
    assert.match(apply, /beFullEl\.innerText = displayMinus\(/);
    assert.match(apply, /beOpEl\.innerText = displayMinus\(/);
});

test('the header logo link is at least 44px square on mobile', () => {
    const mobile = sliceBetween(html, '@media (max-width: 768px) {\n            /* Шапка:', '</style>');
    assert.match(mobile, /\.tc-topbar \.tc-brand \{\n\s+flex: 0 1 auto !important; width: auto !important; min-width: 44px; min-height: 44px;/);
});
