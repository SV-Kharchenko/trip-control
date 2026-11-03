// Компактний «Розрахунок рейсу» на сайті (без isKP()) і перейменування «калькулятор» → «Розрахунок рейсу» у видимих текстах.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const block = html.slice(html.indexOf('/*TC-COMPACT-START*/'), html.indexOf('/*TC-COMPACT-END*/'));

test('компактний CSS є в index.html і не залежить від isKP() / kp-shell-on', () => {
    assert.ok(block.length > 3000, 'блок TC-COMPACT на місці');
    assert.equal(/kp-shell|isKP|data-app/.test(block), false);
    assert.match(block, /body\.layout-studio\[data-theme\]\[data-studio-view="calc"\] \{[^}]*--tc-h: 30px/);
    assert.match(block, /--kpc-off: var\(--cc-off, var\(--tc-sticky-h, 0px\)\)/);
    assert.match(block, /--kpc-kpi-h: var\(--tc-strip-h, 49px\)/);
    assert.match(block, /clamp\(380px, 34vw, 480px\) minmax\(0, 1fr\)/);
    assert.match(block, /min-height: 360px !important/);
    assert.match(block, /height: 45vh !important/);
    assert.match(block, /@media \(min-width: 901px\) and \(max-width: 1200px\)/);
});

test('висота карти не використовує --tc-map-h; нових зашитих кольорів у блоці немає', () => {
    assert.equal(/height:[^;]*--tc-map-h/.test(block), false);
    assert.match(block, /height: calc\(100vh - var\(--kpc-off\)[^;]*!important/);
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#(tc-|route-|swap-|studio-|podacha-|vehicle-|demo)[\w-]*/g, '')), false, 'лише змінні тем');
});

test('розмітка калькулятора і id полів на сайті ті самі', () => {
    for (const id of ['route-name', 'dist', 'podacha-dist', 'volume', 'rate', 'swap-ab-btn', 'route-calc-btn', 'waypoints-list', 'osm-base-wrap', 'tc-kpi-bar']) {
        assert.ok(html.includes('id="' + id + '"') || html.includes("'" + id + "'") || html.includes('"' + id + '"'), id);
    }
    assert.ok(html.includes('<body class="layout-studio" data-theme="light">'));
});

test('сайт: ResizeObserver на мапу шле window resize; у Контроль+ це робить kp-calc.js', () => {
    assert.match(html, /document\.documentElement\.getAttribute\('data-app'\) === 'kp'\) return;/);
    assert.match(html, /querySelector\('#studio-right > \.tc-map-frame'\)/);
});

// Видимі рядки: без коментарів (/* */, <!-- -->, // у кінці рядка).
function visible(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
        .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}
function walk(dir, out = []) {
    for (const name of readdirSync(new URL('../' + dir, import.meta.url))) {
        if (name === 'node_modules' || name === 'dist' || name === 'tests') continue;
        const rel = dir + '/' + name;
        if (statSync(new URL('../' + rel, import.meta.url)).isDirectory()) walk(rel, out);
        else if (/\.(js|mjs|html|css)$/.test(name)) out.push(rel);
    }
    return out;
}

test('у видимих текстах немає слова «калькулятор»: сайт, лендинг, листи, KP', () => {
    const files = ['index.html', 'landing/kontrol-plus.html', 'lib/weekly-report.js', 'site.webmanifest', 'scripts/gen-og-image.mjs',
        ...walk('apps/kontrol-plus/src')];
    const bad = [];
    for (const f of files) {
        visible(read(f)).split('\n').forEach((l, i) => { if (/калькулятор/i.test(l)) bad.push(f + ':' + (i + 1)); });
    }
    assert.deepEqual(bad, []);
    assert.match(html, /id="studio-nav-calc"[^>]*>Розрахунок рейсу<\/button>/);
    assert.match(html, /<title>TRIP-CONTROL · розрахунок рейсу/);
    assert.match(html, /tc-panel-eyebrow">Розрахунок рейсу</);
    assert.match(read('apps/kontrol-plus/src/views/request-window.js'), /'Відкрити в розрахунку рейсу'/);
});
