// Компактний «Розрахунок» (kp-calc.css): лише Контроль+, сайт і розмітка калькулятора без змін, id галочок допуску унікальні.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const site = (path) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
const css = read('src/kp-calc.css');

// Селектори правил: текст перед «{» без коментарів і без @media-обгорток.
function selectors(source) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (const m of clean.matchAll(/([^{}]+)\{/g)) {
        const head = m[1].trim();
        if (head.startsWith('@')) continue;
        for (const s of head.split(',')) out.push(s.trim());
    }
    return out;
}

test('kp-calc.css підключає тільки site-bridge.js (збірка Контроль+); сайт його не знає', () => {
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-calc\.css';/);
    assert.match(read('src/site-bridge.js'), /watchCalcMap\(\);/);
    for (const file of ['index.html', 'vercel.json', 'sitemap.xml']) {
        assert.equal(/kp-calc/.test(site(file)), false, file + ': сайт kp-calc не підключає');
    }
});

test('кожен селектор kp-calc.css починається з body.kp-shell-on', () => {
    const list = selectors(css);
    assert.ok(list.length > 20);
    for (const s of list) assert.match(s, /^body\.kp-shell-on[.\s[:]/, s);
    // Мобільну версію (≤900px) не чіпаємо: усі правила лише від 901px.
    assert.equal(/max-width:\s*900px/.test(css), false);
    assert.equal(/@media\s*\(min-width:\s*901px\)/.test(css), true);
});

test('розкладка: форма clamp(380px, 34vw, 480px), карта sticky мінімум 360px, 901–1200px — карта під формою ≈45vh', () => {
    assert.match(css, /clamp\(380px, 34vw, 480px\) minmax\(0, 1fr\)/);
    assert.match(css, /min-height: 360px !important/);
    assert.match(css, /height: 45vh !important/);
    assert.match(css, /--tc-h: 30px/);
    assert.match(css, /--kpc-kpi-h: 40px/);
});

test('розмітка калькулятора на сайті не змінилась: ті самі групи, id і пари полів', () => {
    const html = site('index.html');
    for (const frag of ["opCell('tc-f-podacha', 'Подача авто'", "opCell('tc-f-a', 'Звідки'", "opCell('tc-f-b', 'Куди'",
        "opCell('tc-f-dist', 'Відстань'", "opCell('tc-f-weight', 'Вага вантажу'", "opCell('tc-f-return', 'Повернення'",
        "opCell('tc-f-truck', 'ТЗ (транспортний засіб)'", "opCell('tc-f-rate', 'Тариф'", 'id="kb-be"', 'id="kb-margin"', 'id="kb-detail"']) {
        assert.ok(html.includes(frag), frag);
    }
    assert.equal(/kp-shell-on/.test(css.replace(/body\.kp-shell-on/g, '')), false);
});

test('docs-ts-form: id галочок допуску унікальні (uniqueId), label for збігається з id', () => {
    const src = read('src/views/docs-ts-form.js');
    assert.equal(/path\.replace\(\/\.\/g/.test(src), false, 'регулярка, що міняла всі символи на дефіси, прибрана');
    assert.match(src, /import \{[^}]*\buniqueId\b[^}]*\} from '\.\.\/ui\.js'/);
    assert.match(src, /id: uniqueId\('ts-ok'\)/);
    assert.match(src, /h\('label', \{ class: 'kpts-check', for: input\.id \}, input/);
    // Статичні id лишились унікальними між собою.
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
