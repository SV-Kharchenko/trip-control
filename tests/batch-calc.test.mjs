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

// Токени картки результату, як їх бачить браузер: тема × режим («Детально» ставить картку на світло-зелений фон).
const declMap = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const ruleBody = (selectorStart) => { const s = html.indexOf(selectorStart); assert.notEqual(s, -1, selectorStart); const o = html.indexOf('{', s); return html.slice(o + 1, html.indexOf('}', o)); };
const resolveColor = (value, vars) => {
    const m = String(value).match(/^var\((--[\w-]+)\)$/);
    return m ? resolveColor(vars[m[1]], vars) : value;
};
function resultCard(themeName, mode) {
    const vars = declMap(theme(themeName));
    if (themeName === 'light' || themeName === 'dark') Object.assign(vars, declMap(theme('night')), declMap(theme(themeName)));
    else Object.assign(vars, declMap(theme('night')), declMap(theme(themeName)));
    let card = {};
    if (themeName === 'light' || themeName === 'dark') {
        const base = ruleBody('body.layout-studio[data-theme="light"] #dispatcher-result:not(.is-empty),');
        card = { ...declMap(base), bg: (base.match(/background:\s*([^;]+);/) || [])[1].trim() };
        if (themeName === 'dark') {
            const dark = ruleBody('body.layout-studio[data-theme="dark"] #dispatcher-result:not(.is-empty) {');
            card = { ...card, ...declMap(dark), bg: (dark.match(/background:\s*([^;]+);/) || [])[1].trim() };
        } else if (mode === 'detail') {
            card = { ...card, ...declMap(ruleBody('body.layout-studio[data-theme="light"][data-studio-view="calc"][data-calc-detail="1"] #tc-det-side > #dispatcher-result:not(.is-empty)')) };
        }
    } else {
        const rule = ruleBody('body.layout-studio[data-theme="night"] #dispatcher-result:not(.is-empty),');
        card = { ...declMap(rule), bg: (rule.match(/background:\s*([^;]+);/) || [])[1].trim() };
    }
    const bg = mode === 'detail'
        ? mix(hex(resolveColor('var(--positive)', vars)), hex(resolveColor('var(--surface)', vars)), 0.1)
        : hex(resolveColor(card.bg, vars));
    const ink = {};
    for (const key of ['fg', 'muted', 'up', 'down', 'be']) ink[key] = hex(resolveColor(card['--tc-result-' + key], { ...vars, ...card }));
    return { bg, ink };
}

test('п.13 / D: тексти картки результату (KPI, Беззбитковість) — контраст ≥ 4.5:1 у light, dark, night, amber, в обох режимах картки', () => {
    for (const themeName of ['light', 'dark', 'night', 'amber']) {
        for (const mode of ['normal', 'detail']) {
            const { bg, ink } = resultCard(themeName, mode);
            for (const [name, rgb] of Object.entries(ink)) {
                const r = ratio(rgb, bg);
                assert.ok(r >= 4.5, themeName + '/' + mode + ' ' + name + ' ' + r.toFixed(2));
            }
        }
    }
    // Було: світлі токени темної картки (#A9BCB7) на світло-зеленому фоні «Детально» — нижче порогу.
    const light = declMap(theme('light'));
    assert.ok(ratio(hex('#A9BCB7'), mix(hex(light['--positive']), hex(light['--surface']), 0.1)) < 4.5);
    assert.match(html, /--tc-result-muted: var\(--result-muted-on-light\)/);
});

// ---- П.14: варіанти маршруту (Google alternatives) ----
function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error('unclosed ' + name);
}

test('п.14: клік по варіанту перераховує км, час і розрахунок; до 3 варіантів; вибраний зберігається', async () => {
    const { default: vm } = await import('node:vm');
    const leg = (km, min) => ({ distance: { value: km * 1000 }, duration: { value: min * 60 } });
    const response = { routes: [
        { summary: 'E40', legs: [leg(500, 360)], overview_path: [] }, { summary: 'M06', legs: [leg(540, 330)], overview_path: [] },
        { summary: 'T10', legs: [leg(610, 420)], overview_path: [] }, { summary: 'зайвий 4-й', legs: [leg(700, 500)], overview_path: [] },
    ] };
    const elements = {};
    const el = (id) => (elements[id] = elements[id] || { id, value: '', innerText: '', style: {} });
    ['osm-from', 'osm-to', 'osm-base', 'osm-status', 'dist', 'podacha-dist', 'route-name'].forEach(el);
    elements['osm-from'].value = 'Київ';
    elements['osm-to'].value = 'Одеса';
    const calls = { calculate: 0, rendered: [], painted: 0, index: [] };
    const context = vm.createContext({
        document: { getElementById: el },
        calculate: () => { calls.calculate += 1; },
        clearPOIMarkers: () => {},
        paintRouteOverlays: () => { calls.painted += 1; },
        renderRouteAlternatives: (r, idx) => calls.rendered.push([r.routes.slice(0, 3).length, idx]),
        directionsRenderer: { setDirections: () => {}, setRouteIndex: (i) => calls.index.push(i) },
        lastDirectionsResponse: response, mainRouteView: null, lastRoutePath: null, console,
    });
    vm.runInContext(['const ROUTE_ALT_MAX = 3;', fnSource('routeTotals'), fnSource('currentRouteVariant'), fnSource('selectRouteAlternative'), fnSource('applyMainRoute')].join('\n'), context);
    vm.runInContext('selectRouteAlternative(0)', context);
    assert.equal(elements.dist.value, 500);
    vm.runInContext('selectRouteAlternative(2)', context);
    assert.equal(elements.dist.value, 610, 'км третього варіанта');
    assert.equal(calls.calculate, 2, 'кожен клік перераховує прибуток і пальне');
    assert.deepEqual(calls.rendered[1], [3, 2]);
    assert.match(fnSource('renderRouteAlternatives'), /slice\(0, ROUTE_ALT_MAX\)/, 'кнопок не більше трьох');
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(currentRouteVariant())', context)), { index: 2, count: 3, summary: 'T10', km: 610, minutes: 420 });
    vm.runInContext('selectRouteAlternative(3)', context);
    assert.equal(elements.dist.value, 610, 'четвертого варіанта немає — лишається третій');
    assert.match(html, /const routeVariant = currentRouteVariant\(\);\s+if \(routeVariant\) inputs\.routeVariant = routeVariant;/);
    assert.match(html, /strokeColor: pal\.alt/);
    assert.equal(html.includes('tcMapPillIcon'), false, 'плашки км/час з ліній прибрано');
});

// ---- Правка F: відрізки — подача, рейс, зупинки; варіанти лише на одному відрізку ----
test('F: маршрут з подачею й зупинками — км, час і подача як сума вибраних відрізків; клік по варіанту перераховує', async () => {
    const { default: vm } = await import('node:vm');
    const leg = (km, min) => ({ distance: { value: km * 1000 }, duration: { value: min * 60 } });
    const route = (km, min, summary = '') => ({ summary, legs: [leg(km, min)], overview_path: [{ lat: km, lng: 0 }] });
    const el = {};
    const get = (id) => (el[id] = el[id] || { id, value: '', innerText: '', style: {} });
    ['osm-from', 'osm-to', 'osm-base', 'osm-status', 'dist', 'podacha-dist', 'route-name'].forEach(get);
    get('osm-from').value = 'Луцьк';
    get('osm-to').value = 'Одеса';
    get('osm-base').value = 'Рівне';
    const calls = { calculate: 0 };
    const context = vm.createContext({
        document: { getElementById: get }, calculate: () => { calls.calculate += 1; }, clearPOIMarkers: () => {}, paintRouteOverlays: () => {},
        renderRouteAlternatives: () => {}, directionsRenderer: { setDirections: () => {} }, lastDirectionsResponse: null, mainRouteView: null, lastRoutePath: null, console,
    });
    vm.runInContext(['const ROUTE_ALT_MAX = 3;', 'function selectRouteAlternative(idx) { applyMainRoute(lastDirectionsResponse, idx, "Рівне", "Луцьк", "Одеса", get("osm-status")); }',
        fnSource('routeMeters'), fnSource('longestSegmentIndex'), fnSource('composeRouteVariants'), fnSource('routeTotals'), fnSource('currentRouteVariant'), fnSource('applyMainRoute')].join('\n'),
    Object.assign(context, { get }));
    // Подача 35 км; відрізки A→W1 100 км, W1→B 400 км (найдовший); варіанти найдовшого: 400 / 380 / 450 км.
    const feed = route(35, 40);
    const mains = [route(100, 90), route(400, 330)];
    context.feed = feed; context.mains = mains;
    context.alts = [route(400, 330, 'M05'), route(380, 360, 'E95'), route(450, 300, 'T15')];
    const longest = vm.runInContext('longestSegmentIndex(mains)', context);
    assert.equal(longest, 1, 'варіанти просимо для найдовшого відрізка');
    vm.runInContext(`lastDirectionsResponse = { composed: true, routes: composeRouteVariants(feed, mains, ${longest}, alts) };`, context);
    vm.runInContext('selectRouteAlternative(1)', context);
    assert.equal(el['podacha-dist'].value, 35, 'подача окремо');
    assert.equal(el.dist.value, 100 + 380, 'рейс = сума вибраних відрізків (100 + варіант 380)');
    vm.runInContext('selectRouteAlternative(2)', context);
    assert.equal(el.dist.value, 100 + 450, 'клік по третьому варіанту перераховує км');
    assert.equal(el['podacha-dist'].value, 35);
    assert.equal(calls.calculate, 2, 'пальне й прибуток перераховуються при кожному виборі');
    const variant = JSON.parse(vm.runInContext('JSON.stringify(currentRouteVariant())', context));
    assert.equal(variant.index, 2);
    assert.equal(variant.minutes, 40 + 90 + 300, 'час = сума відрізків, разом із подачею');
    // Кнопки й плашки показують км / час варіанта відрізка, а не всього рейсу.
    assert.match(html, /routeTotals\(route\.altRoute \|\| route\)/);
    assert.match(fnSource('calculateGoogleRoute'), /longestSegmentIndex\(/);
    assert.match(fnSource('calculateGoogleRoute'), /askSegmentSafe\(pair, pairs\.length === 1 && pair === pairs\[0\]\)/, 'подача завжди без варіантів');
    assert.match(html, /const composed = composeRouteVariants\(/);
});
