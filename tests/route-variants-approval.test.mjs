import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const { routeVariantResults, calculateTrip } = await import('../api/calculate.js');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const S0 = JSON.parse(fs.readFileSync(new URL('./fixtures/s0-fop.json', import.meta.url), 'utf8'));

function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}

function variantContext(extra = {}) {
    const leg = (km, min) => ({ distance: { value: km * 1000 }, duration: { value: min * 60 } });
    const pt = (lat, lng) => ({ lat: () => lat, lng: () => lng });
    const routes = [
        { summary: 'E40', altRoute: { legs: [leg(815, 582)], overview_path: [pt(49.99, 36.23), pt(46.48, 30.72)] }, legs: [leg(40, 50), leg(815, 582)], overview_path: [pt(50.45, 30.52), pt(49.99, 36.23), pt(46.48, 30.72)] },
        { summary: 'M06', altRoute: { legs: [leg(844, 600)], overview_path: [pt(48.46, 35.04), pt(46.48, 30.72)] }, legs: [leg(40, 50), leg(844, 600)], overview_path: [pt(50.45, 30.52), pt(48.46, 35.04), pt(46.48, 30.72)] },
    ];
    const context = vm.createContext({
        ROUTE_ALT_MAX: 3,
        mainRouteView: { response: { routes }, idx: 0, feed: true },
        lastExport: { result: { variantResults: [] } },
        ...extra,
    });
    vm.runInContext('const ROUTE_PATH_MAX = 1200;\n' + ['routeTotals', 'encodeRoutePath', 'decodeRoutePath', 'routeVariantKmList', 'storedRouteVariants'].map(fnSource).join('\n'), context);
    return context;
}

test('п.4: км кожного варіанта (подача окремо) і шлях encoded polyline туди й назад', () => {
    const context = variantContext();
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(routeVariantKmList())', context)), [
        { index: 0, dist: 815, podachaDist: 40 }, { index: 1, dist: 844, podachaDist: 40 },
    ]);
    const text = vm.runInContext('encodeRoutePath([{lat: 38.5, lng: -120.2}, {lat: 40.7, lng: -120.95}, {lat: 43.252, lng: -126.453}])', context);
    assert.equal(text, '_p~iF~ps|U_ulLnnqC_mqNvxq`@', 'приклад із специфікації Google');
    const back = JSON.parse(vm.runInContext('JSON.stringify(decodeRoutePath(' + JSON.stringify(text) + '))', context));
    assert.deepEqual(back.map((p) => [p.lat, p.lng]), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
    assert.equal(vm.runInContext('decodeRoutePath("")', context).length, 0);
});

test('п.4: заявка зберігає ВСІ варіанти з км, часом, шляхом, прибутком і пальним; без розрахунку варіанти не пишуться', () => {
    const calc = (index, dist, profit) => ({ index, dist, podachaDist: 40, grossIncome: 90000, marginalIncome: 1, ebitda: 2, netProfit: profit, profitabilityPct: 3, fuelAndAdblueTotal: 55000 + index });
    const ok = variantContext({ lastExport: { result: { variantResults: [calc(0, 815, 6600), calc(1, 844, 4400)] } } });
    const stored = JSON.parse(vm.runInContext('JSON.stringify(storedRouteVariants())', ok));
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((v) => [v.index, v.km, v.minutes, v.podachaKm, v.netProfit, v.fuelAndAdblueTotal, v.summary]),
        [[0, 815, 582, 40, 6600, 55000, 'E40'], [1, 844, 600, 40, 4400, 55001, 'M06']]);
    assert.ok(stored.every((v) => typeof v.path === 'string' && v.path.length > 5));
    const stale = variantContext({ lastExport: { result: { variantResults: [calc(0, 815, 6600), calc(1, 999, 4400)] } } });
    assert.equal(vm.runInContext('storedRouteVariants()', stale), null, 'розрахунок для інших км — не зберігаємо');
    const none = variantContext({ lastExport: { result: {} } });
    assert.equal(vm.runInContext('storedRouteVariants()', none), null);
    const one = variantContext({ mainRouteView: null });
    assert.equal(vm.runInContext('routeVariantKmList()', one), null);
});

test('п.4: сервер рахує кожен варіант тим самим calculateTrip (вибраний = основний розрахунок)', () => {
    const base = calculateTrip(S0);
    const results = routeVariantResults({ ...S0, routeVariantKm: [
        { index: 0, dist: S0.dist, podachaDist: S0.podachaDist },
        { index: 1, dist: Number(S0.dist) + 30, podachaDist: S0.podachaDist },
        { index: 7, dist: 1 },
        { index: 2, dist: 0 },
    ] }, null);
    assert.equal(results.length, 2);
    assert.equal(results[0].netProfit, base.netProfit);
    assert.ok(results[1].netProfit < base.netProfit, 'довший маршрут — менший прибуток');
    assert.ok(results[1].fuelAndAdblueTotal > base.fuelAndAdblueTotal);
    assert.deepEqual(routeVariantResults({ ...S0 }, null), []);
    assert.ok(html.includes('payload.routeVariantKm = variantKm;'));
    assert.ok(html.includes('delete inputs.routeVariantKm;'));
});

function reviewContext(row) {
    const context = vm.createContext({
        savedCalculations: [row], formatHistoryNum: (v) => String(v), escHtml: (x) => String(x),
        historyFields: () => ({ km: 500, profit: 1000, revenue: 9000, status: 'pending' }),
    });
    vm.runInContext(['requestVariants', 'logistVariantIndex', 'variantNoteText', 'reviewVariantsOf'].map(fnSource).join('\n'), context);
    return context;
}

test('п.4: історія показує «логіст» і «директор погодив»; стара заявка без варіантів — один маршрут без помилок', () => {
    const row = { id: 'a', inputs: { routeVariant: { index: 1 }, routeVariants: [
        { index: 0, km: 815, minutes: 582, netProfit: 6600 }, { index: 1, km: 844, minutes: 600, netProfit: 4400 }] } };
    const ctx = reviewContext(row);
    assert.equal(vm.runInContext('reviewVariantsOf(savedCalculations[0]).length', ctx), 2);
    assert.equal(vm.runInContext('variantNoteText(savedCalculations[0])', ctx), 'логіст: варіант 2, 844 км');
    vm.runInContext('savedCalculations[0].approvedVariant = { index: 0, km: 815 }', ctx);
    assert.equal(vm.runInContext('variantNoteText(savedCalculations[0])', ctx), 'логіст: варіант 2, 844 км · директор погодив: варіант 1, 815 км');
    const old = reviewContext({ id: 'b', inputs: { dist: 500 } });
    const legacy = JSON.parse(vm.runInContext('JSON.stringify(reviewVariantsOf(savedCalculations[0]))', old));
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].legacy, true);
    assert.equal(legacy[0].km, 500);
    assert.equal(vm.runInContext('variantNoteText(savedCalculations[0])', old), '');
    const nullInputs = reviewContext({ id: 'c', inputs: null });
    assert.equal(vm.runInContext('reviewVariantsOf(savedCalculations[0]).length', nullInputs), 1);
});

test('п.4: «Погодити» в огляді передає вибраний варіант; заявка з варіантами відкривається в огляді', () => {
    assert.ok(html.includes('if (await approveRequest(id, hasVariants ? picked : undefined)) closeApprovalReview();'));
    assert.ok(html.includes('if (Number.isInteger(variantIndex)) body.variantIndex = variantIndex;'));
    assert.ok(html.includes("button('Відкрити', reviewing ? 'openApprovalReview' : 'openSaved')"));
    assert.ok(html.includes("'Погодити варіант ' + (selected.index + 1)"));
    assert.ok(html.includes("select(fullColumns + ', approved_variant')"), 'до міграції колонки читаємо без approved_variant');
    assert.ok(html.includes("tc-map-alt' + (v.index === selected.index ? ' active' : '')"), 'ті самі перемикачі, що й у калькуляторі');
});

test('п.4: перемикання варіанта в огляді міняє цифри прибутку; різниця до варіанта логіста', () => {
    const variants = [
        { index: 0, km: 815, minutes: 582, netProfit: 6600, grossIncome: 90000, fuelAndAdblueTotal: 56000, podachaKm: 40 },
        { index: 1, km: 844, minutes: 600, netProfit: 4400, grossIncome: 90000, fuelAndAdblueTotal: 58100, podachaKm: 40 },
    ];
    const els = {
        'tc-review-alts': { classList: { toggle() {} }, innerHTML: '' },
        'tc-review-sum': { innerHTML: '' },
        'tc-review-ok': { textContent: '' },
    };
    const context = vm.createContext({
        approvalReview: { id: 'a', variants, logist: 0, selected: 0, map: null, lines: [], fitted: false },
        document: { getElementById: (id) => els[id] || null },
        escHtml: (x) => String(x), displayMinus: (x) => x, formatMoney: (x) => String(x), formatHistoryNum: (v) => String(v),
        reviewDrawMap: () => {},
    });
    vm.runInContext(['variantKmMinText', 'reviewSelect', 'reviewRender'].map(fnSource).join('\n'), context);
    vm.runInContext('reviewRender()', context);
    assert.match(els['tc-review-ok'].textContent, /Погодити варіант 1/);
    assert.ok(els['tc-review-sum'].innerHTML.includes('6600'));
    vm.runInContext('reviewSelect(1)', context);
    assert.equal(els['tc-review-ok'].textContent, 'Погодити варіант 2');
    assert.ok(els['tc-review-sum'].innerHTML.includes('4400'));
    assert.ok(els['tc-review-sum'].innerHTML.includes('-2200 до варіанта логіста'));
    assert.ok(els['tc-review-alts'].innerHTML.includes('class="tc-map-alt active" aria-pressed="true" data-variant="1">Варіант 2 · 844 км · 10 год 0 хв'));
});
