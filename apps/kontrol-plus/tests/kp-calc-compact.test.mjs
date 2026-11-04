// Компактний «Розрахунок рейсу»: правила спільні для сайту й Контроль+ (блок TC-COMPACT в index.html), kp-calc.css лишає лише різницю Контроль+.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const site = (path) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
const html = site('index.html');
const kpCss = read('src/kp-calc.css');
const css = html.slice(html.indexOf('/*TC-COMPACT-START*/'), html.indexOf('/*TC-COMPACT-END*/'));

// Селектори правил: текст перед «{» без коментарів і без @media-обгорток; кома рахується лише на верхньому рівні.
function selectors(source) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (const m of clean.matchAll(/([^{}]+)\{/g)) {
        const head = m[1].trim();
        if (head.startsWith('@')) continue;
        let depth = 0, cur = '';
        for (const ch of head) {
            if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
            if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
        }
        out.push(cur.trim());
    }
    return out;
}

test('kp-calc.css підключає site-bridge.js (збірка Контроль+); він лишає лише різницю: усі селектори з body.kp-shell-on', () => {
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-calc\.css';/);
    assert.match(read('src/site-bridge.js'), /watchCalcMap\(\);/);
    for (const s of selectors(kpCss)) assert.match(s, /^body\.kp-shell-on[.\s[:]/, s);
    assert.match(kpCss, /--cc-off: calc\(var\(--kp-strip-h, 0px\) \+ var\(--kp-top-h, 52px\)\)/);
    assert.equal(/max-width:\s*900px/.test(kpCss), false);
});

test('спільні правила: кожен селектор від body.layout-studio[data-theme], лише від 901px', () => {
    const list = selectors(css);
    assert.ok(list.length > 20);
    for (const s of list) assert.match(s, /^body\.layout-studio\[data-theme\][.\s[:]/, s);
    assert.equal(/max-width:\s*900px/.test(css), false);
    assert.equal(/@media\s*\(min-width:\s*901px\)/.test(css), true);
    assert.equal(/kp-shell/.test(css), false, 'у спільному блоці немає прив’язки до Контроль+');
});

test('розкладка: форма clamp(380px, 34vw, 480px), карта sticky мінімум 360px, 901–1200px — карта під формою ≈45vh', () => {
    assert.match(css, /clamp\(380px, 34vw, 480px\) minmax\(0, 1fr\)/);
    assert.match(css, /min-height: 360px !important/);
    assert.match(css, /height: 45vh !important/);
    assert.match(css, /--tc-h: 30px/);
    assert.match(css, /--kpc-kpi-h: var\(--tc-strip-h, 49px\)/);
});

test('розмітка розрахунку рейсу на сайті не змінилась: ті самі групи, id і пари полів', () => {
    for (const frag of ["opCell('tc-f-podacha', 'Подача авто'", "opCell('tc-f-a', 'Звідки'", "opCell('tc-f-b', 'Куди'",
        "opCell('tc-f-dist', 'Відстань'", "opCell('tc-f-weight', 'Вага вантажу'", "opCell('tc-f-return', 'Повернення'",
        "opCell('tc-f-truck', 'ТЗ (транспортний засіб)'", "opCell('tc-f-rate', 'Тариф'", 'id="kb-be"', 'id="kb-margin"', 'id="kb-detail"',
        'id="swap-ab-btn"', 'id="route-calc-btn"']) {
        assert.ok(html.includes(frag), frag);
    }
});

test('docs-ts-form: id галочок допуску унікальні (uniqueId), label for збігається з id', () => {
    const src = read('src/views/docs-ts-form.js');
    assert.equal(/path\.replace\(\/\.\/g/.test(src), false, 'регулярка, що міняла всі символи на дефіси, прибрана');
    assert.match(src, /import \{[^}]*\buniqueId\b[^}]*\} from '\.\.\/ui\.js'/);
    assert.match(src, /id: uniqueId\('ts-ok'\)/);
    assert.match(src, /h\('label', \{ class: 'kpts-check', for: input\.id \}, input/);
    const ids = [...src.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'дублів id немає: ' + ids.join(', '));
});

test('watchCalcMap: ResizeObserver на карту шле window resize (Google Maps перемальовується)', async () => {
    const { watchCalcMap } = await import('../src/kp-calc.js');
    let callback; const observed = []; const events = [];
    class RO { constructor(cb) { callback = cb; } observe(el) { observed.push(el); } }
    const frame = { dataset: {} };
    const win = {
        ResizeObserver: RO, Event: class { constructor(type) { this.type = type; } },
        cancelAnimationFrame() {}, requestAnimationFrame: (fn) => { fn(); return 1; },
        dispatchEvent: (e) => events.push(e.type),
    };
    watchCalcMap({ querySelector: () => frame, body: {} }, win);
    assert.deepEqual(observed, [frame]);
    callback();
    assert.deepEqual(events, ['resize']);
});

test('--kpc-kpi-h не зашита константою: береться з виміряної --tc-strip-h; відступи карти рахуються від неї', () => {
    assert.equal(/--kpc-kpi-h: \d+px/.test(css), false, 'константи 40px немає');
    assert.match(html, /setProperty\('--tc-strip-h'/, 'index.html ставить --tc-strip-h з виміру KPI-рядка');
    assert.equal((css.match(/var\(--kpc-kpi-h\)/g) || []).length >= 2, true);
});

test('рядок проміжної зупинки і пари полів: min-width:0, один flex-рядок, підпис над полем з ellipsis', () => {
    const rule = (re) => { const m = css.match(re); assert.ok(m, String(re)); return m[0]; };
    assert.match(rule(/div:has\(> #swap-ab-btn\) \{[^}]*\}/), /display: flex; flex-wrap: nowrap;[^}]*min-width: 0/);
    assert.match(rule(/> \.preset-btn:not\(#swap-ab-btn\) \{[^}]*\}/), /min-width: 0;[^}]*text-overflow: ellipsis; white-space: nowrap/);
    assert.match(rule(/#swap-ab-btn \{[^}]*\}/), /flex: 0 0 auto !important/);
    assert.match(rule(/:is\(#route-fields-slot,[^{]*\) \{[^}]*\}/), /min-width: 0; box-sizing: border-box/);
    assert.match(rule(/\.form-row:has\(> \.tc-in > input\[type="number"\]\) \{[^}]*\}/), /display: grid; grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(rule(/\.form-row:has\(> \.tc-in > input\[type="number"\]\) > label,[^{]*\{[^}]*\}/), /min-width: 0;[^}]*text-overflow: ellipsis; white-space: nowrap/);
    assert.match(rule(/\.tc-place-field gmp-place-autocomplete \{[^}]*\}/), /min-height: 30px !important/);
});

test('KPI-рядок ≈60px: padding 11px, підпис над значенням 18px (mono), кнопка 28px по центру; висота мапи без --tc-map-h', () => {
    assert.match(css, /\.tc-kpi-bar \{[^}]*padding-block: 11px/);
    assert.match(css, /\.tc-kb-m \{[^}]*flex-direction: column/);
    assert.match(css, /\.tc-kb-m b \{[^}]*font-family: var\(--font-mono[^}]*font-size: 18px; font-weight: 700/);
    assert.match(css, /\.tc-kb-detail \{[^}]*height: 28px;[^}]*align-self: center/);
    assert.match(css, /height: min\(calc\(100vh - var\(--kpc-off\)[^;]*var\(--cc-room, 100vh\)\)[^;]*!important/);
    assert.equal(/height:[^;]*--tc-map-h/.test(css), false, 'висота карти не використовує --tc-map-h');
});
