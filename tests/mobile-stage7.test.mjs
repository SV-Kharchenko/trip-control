import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start + ' … ' + end);
    return source.slice(from, to);
}

const stage7Css = sliceBetween(html, '/* Етап 7: мобільна версія 360–768px.', '</style>');
const mobileCss = stage7Css.slice(stage7Css.indexOf('@media (max-width: 768px) {'));

test('the header keeps tabs and rates in a burger panel that is plain layout on desktop', () => {
    const top = sliceBetween(html, 'class="tc-topbar"', 'id="demo-banner"');
    const panel = sliceBetween(top, '<div class="tc-nav-panel" id="tc-nav-panel">', '<div class="tc-head-end">');
    assert.match(panel, /class="tc-studio-nav"/);
    assert.match(panel, /class="tc-meta"/);
    assert.match(top, /id="tc-burger-btn" aria-label="Розділи" aria-expanded="false" aria-controls="tc-nav-panel" onclick="toggleNavPanel\(event\)"/);
    assert.match(stage7Css, /\.tc-nav-panel \{ display: contents; \}/);
    assert.match(mobileCss, /\.tc-topbar \.tc-logo-full \{ display: none; \}/);
    assert.match(mobileCss, /body\.layout-studio \.tc-nav-panel\.is-open \{ display: grid; \}/);
    assert.match(mobileCss, /body\.layout-studio \.tc-burger \{ display: grid; \}/);
    // меню аватара не виїжджає за лівий край, коли праворуч від аватара стоїть бургер
    assert.match(mobileCss, /body\.layout-studio \.tc-menu-wrap \{ position: static; \}/);
    assert.match(mobileCss, /body\.layout-studio \.tc-user-menu \{ top: calc\(100% \+ 6px\); left: auto; right: 12px;/);
    // док над картою, але під шапкою з меню
    assert.match(stage7Css, /body\.layout-studio #dispatcher-result \{ z-index: 35 !important; \}/);
});

test('the burger closes on Escape, an outside tap and after picking a section', () => {
    const js = sliceBetween(html, "const MOBILE_HEADER_QUERY = '(max-width: 768px)';", "const MOBILE_DOCK_QUERY");
    assert.match(js, /event\.key !== 'Escape' \|\| !navPanelIsOpen\(\)/);
    assert.match(js, /closest\('\.tc-studio-nav button'\)/);
    assert.match(js, /toggleNavPanel\(null, false\);/);
    assert.match(js, /if \(open\) closeUserMenu\(\);/);
    assert.match(sliceBetween(html, 'function openUserMenu()', 'function toggleUserMenu('), /toggleNavPanel\(null, false\)/);

    const panelClasses = new Set();
    const attrs = {};
    const panel = {
        classList: {
            contains: (c) => panelClasses.has(c),
            toggle: (c, on) => { if (on) panelClasses.add(c); else panelClasses.delete(c); }
        },
        querySelector: () => null
    };
    const btn = { setAttribute: (k, v) => { attrs[k] = v; } };
    const ctx = {
        document: { getElementById: (id) => (id === 'tc-nav-panel' ? panel : id === 'tc-burger-btn' ? btn : null), addEventListener() {}, querySelector: () => null },
        window: {},
        closeUserMenu() {}
    };
    vm.runInNewContext(js + '\nglobalThis.__t = toggleNavPanel; globalThis.__o = navPanelIsOpen;', ctx);
    ctx.__t();
    assert.equal(ctx.__o(), true);
    assert.equal(attrs['aria-expanded'], 'true');
    ctx.__t(null, false);
    assert.equal(ctx.__o(), false);
    assert.equal(attrs['aria-expanded'], 'false');
});

test('the stepper is vertical on mobile and keeps full step names', () => {
    assert.match(mobileCss, /\.tc-step-tabs \{\n\s+display: grid; grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(mobileCss, /\.tc-step-tab b \{ overflow: visible; text-overflow: clip; \}/);
});

test('the result dock collapses to profit and грн/км and opens the cascade', () => {
    const dock = sliceBetween(html, '<aside class="tc-result-dock is-empty" id="dispatcher-result">', '<div class="tc-kpi kpi-strip">');
    assert.match(dock, /id="tc-dock-toggle" aria-expanded="false" aria-controls="tc-dock-cascade"[^>]*onclick="toggleResultDock\(\)"/);
    assert.match(dock, /<div class="tc-dock-cascade" id="tc-dock-cascade"/);
    const paint = sliceBetween(html, 'function paintCascade(result)', 'function paintProfitHero(result)');
    assert.match(paint, /dockCascade\.innerHTML = host\.innerHTML;/);
    assert.match(paint, /dockEmpty\.innerHTML = '';/);
    assert.match(stage7Css, /#dispatcher-result:not\(\.is-open\) \.tc-unit-row > div:not\(:first-child\),\n\s+body\.layout-studio #dispatcher-result:not\(\.is-open\) #kpi-breakeven-chip \{ display: none !important; \}/);
    assert.match(stage7Css, /padding-bottom: calc\(var\(--tc-dock-h, 96px\) \+ 24px \+ env\(safe-area-inset-bottom\)\);/);
    const js = sliceBetween(html, "const MOBILE_DOCK_QUERY = '(max-width: 900px)';", 'function syncCompanyNav(on)');
    assert.match(js, /setProperty\('--tc-dock-h'/);
    assert.match(js, /event\.key !== 'Escape' \|\| !dock \|\| !dock\.classList\.contains\('is-open'\)/);
});

test('the map gets an adaptive height and keeps route options above the controls', () => {
    assert.match(stage7Css, /--tc-map-h: clamp\(280px, 55vh, 560px\);/);
    assert.match(stage7Css, /body\.layout-studio \.tc-map-frame > \.tc-map-alts \{ grid-row: 1; grid-column: 1; \}/);
    assert.match(stage7Css, /body\.layout-studio \.poi-checks \{ flex-wrap: wrap; \}/);
});

test('mobile tap targets are at least 40px and inputs use 16px text', () => {
    assert.match(mobileCss, /min-height: 40px; \}/);
    assert.match(mobileCss, /body\.layout-studio :is\(input, select, textarea\) \{ font-size: 16px !important; \}/);
    assert.match(mobileCss, /#cabinet-screen \.tc-team-check \{ display: flex; min-height: 44px; \}/);
    assert.match(mobileCss, /#cabinet-screen \.tc-team-check input \{ width: 22px; height: 22px; \}/);
    assert.match(mobileCss, /#cabinet-screen \.cab-grid,\n\s+body\.layout-studio #cabinet-screen \.tc-fleet-docs \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});
