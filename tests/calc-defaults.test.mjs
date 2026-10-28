import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
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
const literal = (name) => html.match(new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\});'))[1];

function setup({ userId = 'u1', stored, fleetActive = false } = {}) {
    const store = new Map();
    if (stored) store.set('tc_calc_last:' + userId, JSON.stringify(stored));
    const els = {};
    const el = (id, value = '') => (els[id] = els[id] || { id, value, handlers: {}, addEventListener(n, f) { this.handlers[n] = f; } });
    const context = vm.createContext({
        currentUserId: userId,
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
        document: { getElementById: (id) => els[id] || null },
        fleetChoiceActive: () => fleetActive,
        SETTINGS_MAP: {}, STARTER_SETTINGS: null,
    });
    vm.runInContext([
        'const OPT = [["on","Увімкнено"],["off","Вимкнено"]];',
        'STARTER_SETTINGS = ' + literal('STARTER_SETTINGS') + ';',
        "SETTINGS_MAP.fuelPrice = { id: 'fuel-price' }; SETTINGS_MAP.fuelLoad = { id: 'fuel-load' };",
        'SETTINGS_MAP.adblueEnable = { id: \'adblue-enable\', select: OPT }; SETTINGS_MAP.amort = { id: \'overhead-amort\' };',
        literal('STARTER_SETTINGS') ? '' : '',
        "const CALC_LAST_KEY = 'tc_calc_last';",
        "const CALC_VEHICLE_KEYS = ['fuelLoad', 'fuelEmpty', 'adblueEnable', 'adblueConsumption'];",
        ...['calcLastStorageKey', 'readCalcLast', 'calcLastValueOk', 'calcValueFor', 'saveCalcLast'].map(fnSource),
    ].join('\n'), context);
    return { context, store, el };
}

test('п.8: калькулятор без «Значень за замовчуванням»: останні значення → вбудовані; без автопарку не ламається', () => {
    // Новий користувач: нічого не збережено → вбудовані.
    const fresh = setup();
    assert.equal(vm.runInContext('calcValueFor("fuelPrice", readCalcLast())', fresh.context), 95);
    assert.equal(vm.runInContext('calcValueFor("adblueEnable", readCalcLast())', fresh.context), 'on');
    assert.equal(vm.runInContext('calcValueFor("amort", readCalcLast())', fresh.context), undefined, 'накладні лишаються порожніми');
    // Збережені останні значення мають пріоритет; зіпсовані — ігноруються.
    const used = setup({ stored: { fuelPrice: 61.5, adblueEnable: 'off', fuelLoad: -3 } });
    assert.equal(vm.runInContext('calcValueFor("fuelPrice", readCalcLast())', used.context), 61.5);
    assert.equal(vm.runInContext('calcValueFor("adblueEnable", readCalcLast())', used.context), 'off');
    assert.equal(vm.runInContext('calcValueFor("fuelLoad", readCalcLast())', used.context), 38, 'від’ємне → вбудоване');
    // Сміття в сховищі не ламає.
    const broken = setup();
    broken.store.set('tc_calc_last:u1', '{not json');
    assert.equal(vm.runInContext('calcValueFor("fuelPrice", readCalcLast())', broken.context), 95);
    // Без користувача — просто вбудовані.
    const anon = setup({ userId: null });
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(readCalcLast())', anon.context)), {});
});

test('п.8: введене користувачем запам’ятовується, значення вибраного авто — ні', () => {
    const free = setup();
    free.el('fuel-price').value = '63.2';
    free.el('fuel-load').value = '40';
    vm.runInContext('saveCalcLast("fuelPrice"); saveCalcLast("fuelLoad");', free.context);
    assert.deepEqual(JSON.parse(free.store.get('tc_calc_last:u1')), { fuelPrice: 63.2, fuelLoad: 40 });
    free.el('fuel-price').value = '';
    vm.runInContext('saveCalcLast("fuelPrice")', free.context);
    assert.deepEqual(JSON.parse(free.store.get('tc_calc_last:u1')), { fuelLoad: 40 }, 'порожнє поле прибирає останнє');
    const withCar = setup({ fleetActive: true });
    withCar.el('fuel-load').value = '33';
    withCar.el('fuel-price').value = '70';
    vm.runInContext('saveCalcLast("fuelLoad"); saveCalcLast("fuelPrice");', withCar.context);
    assert.deepEqual(JSON.parse(withCar.store.get('tc_calc_last:u1')), { fuelPrice: 70 }, 'норма авто не стає «останньою» користувача');
});

test('п.8: «Значення за замовчуванням» прибрано з меню й кабінету, а калькулятор не читає company_settings', () => {
    assert.equal(html.includes('Значення за замовчуванням'), false);
    assert.equal(html.includes("menuGo('defaults')"), false);
    assert.equal(/data-panel="(costs|fuel)"/.test(html), false);
    assert.match(fnSource('applyCalcDefaults'), /calcValueFor\(key, last\)/);
    assert.equal(/companySettings\[/.test(fnSource('applyCalcDefaults')), false);
    assert.match(fnSource('ensureStarterTemplate'), /readCalcLast\(\)/);
    assert.equal(/company_settings/.test(fnSource('ensureStarterTemplate')), false, 'стартовий шаблон більше не пишеться в БД');
    // Дані компанії в БД не чіпаємо: збереження кабінету копіює наявні settings.
    assert.match(fnSource('saveCabinet'), /const next = Object\.assign\(\{\}, companySettings\);/);
});

// ---- Три рівні пріоритету: картка авто → останнє введене користувачем → вбудоване ----
function cardSetup({ stored, vehicles = [], active = true } = {}) {
    const s = setup({ stored, fleetActive: active });
    const ids = { fuelLoad: 'fuel-load', fuelEmpty: 'fuel-empty', adblueEnable: 'adblue-enable', adblueConsumption: 'adblue-consumption' };
    Object.values(ids).forEach((id) => s.el(id));
    s.el('fuel-load').value = '38'; // вбудоване / останнє значення, яке вже підставила applyCalcDefaults
    s.el('fuel-empty').value = '32';
    s.el('adblue-enable').value = 'on';
    s.el('adblue-consumption').value = '2.85';
    s.context.chosenFleetVehicles = () => vehicles;
    s.context.fleetChoiceActive = () => active && vehicles.length > 0;
    s.context.vehicleNormNumber = (value, min, max) => {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    s.context.document.getElementById = (id) => (id === 'field-adblue-consumption' || id === 'field-adblue-price' ? { classList: { toggle() {} } } : s.el(id));
    vm.runInContext([
        "const CARD_NORM_FIELDS = " + literal2('CARD_NORM_FIELDS') + ';',
        'let cardSig = ""; let cardSyncing = false; const cardSourced = {}; const cardPrev = {}; const cardOverrides = {};',
        ...['cardNormOf', 'cardCommonNorm', 'syncCardNormsToForm', 'markCardOverride', 'stripCardOverrides'].map(fnSource),
    ].join('\n'), s.context);
    return s;
}
const literal2 = (name) => { const head = 'const ' + name + ' = '; const a = html.indexOf(head); return html.slice(a + head.length, html.indexOf('];', a) + 1); };
const car = (id, extra) => ({ id, fuel_load: null, fuel_empty: null, adblue_on: null, adblue_consumption: null, ...extra });

test('п.2 рівень 1: поле з картки авто підставляється в калькулятор і має пріоритет над останнім / вбудованим', () => {
    const vehicles = [car('a', { fuel_load: 31, fuel_empty: 26, adblue_on: true, adblue_consumption: 3 })];
    const s = cardSetup({ stored: { fuelLoad: 40 }, vehicles });
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, 31, 'картка > останнє значення (40) > вбудоване (38)');
    assert.equal(s.el('fuel-empty').value, 26);
    assert.equal(s.el('adblue-consumption').value, 3);
    // Картка нічого не пише в localStorage: підстановка програмна.
    assert.equal(s.store.has('tc_calc_last:u1'), true);
    assert.deepEqual(JSON.parse(s.store.get('tc_calc_last:u1')), { fuelLoad: 40 });
});

test('п.2 рівень 2 і 3: поле, якого в картці немає, лишається останнім введеним, а за його відсутності вбудованим', () => {
    const vehicles = [car('a', { fuel_load: 31 })];
    const s = cardSetup({ vehicles });
    s.el('fuel-empty').value = '29.5'; // останнє введене користувачем
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, 31);
    assert.equal(s.el('fuel-empty').value, '29.5', 'у картці порожньо — ручне значення не чіпаємо');
    assert.equal(s.el('adblue-consumption').value, '2.85', 'вбудоване значення лишається, якщо ні картки, ні останнього');
    const fresh = setup();
    assert.equal(vm.runInContext('calcValueFor("fuelEmpty", readCalcLast())', fresh.context), 32, 'без останнього — вбудоване');
});

test('п.2: при зміні авто поля з картки перепідставляються, а повернення без картки відновлює попереднє значення', () => {
    const a = car('a', { fuel_load: 31 });
    const b = car('b', { fuel_load: 35 });
    const s = cardSetup({ vehicles: [a] });
    s.el('fuel-load').value = '40'; // що було в полі до підстановки
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, 31);
    s.context.chosenFleetVehicles = () => [b];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, 35, 'інше авто — інше значення з картки');
    s.context.chosenFleetVehicles = () => [a, b];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, '40', 'у авто різні значення — лишається ручне / останнє');
    s.context.fleetChoiceActive = () => false;
    s.context.chosenFleetVehicles = () => [];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, '40');
});

test('п.2: ручна правка поля з картки діє лише на цей рейс (розрахунок бере форму), нова вибірка авто її скидає', () => {
    const vehicles = [car('a', { fuel_load: 31, adblue_on: true, adblue_consumption: 3 })];
    const s = cardSetup({ vehicles });
    vm.runInContext('syncCardNormsToForm()', s.context);
    const resolved = { fuelLoad: 31, fuelEmpty: 26, useAdblue: true, adblueConsumption: 3 };
    const clean = (o) => JSON.parse(vm.runInContext('JSON.stringify(stripCardOverrides(' + JSON.stringify(o) + '))', s.context));
    assert.deepEqual(clean(resolved), resolved, 'без правок картка діє як є');
    s.el('fuel-load').value = '36';
    vm.runInContext('markCardOverride("fuelLoad")', s.context);
    assert.deepEqual(clean(resolved), { fuelEmpty: 26, useAdblue: true, adblueConsumption: 3 }, 'виправлене поле не береться з картки');
    vm.runInContext('markCardOverride("adblueEnable")', s.context);
    assert.deepEqual(clean(resolved), { fuelEmpty: 26 });
    // Інше авто: правки скинуті, поле знову з картки.
    s.context.chosenFleetVehicles = () => [car('b', { fuel_load: 33 })];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(s.el('fuel-load').value, 33);
    assert.deepEqual(clean(resolved), resolved);
    // Поле, якого в картці немає, не позначається як «з картки»: правка не створює перекриття.
    vm.runInContext('markCardOverride("fuelEmpty")', s.context);
    assert.deepEqual(clean(resolved), resolved);
});

test('п.2: ставки водія, ТО, шини, накладні й склад парку знову видимі, ручні значення не пишуться в картку авто', () => {
    const build = html.slice(html.indexOf('function buildOnePage()'), html.indexOf('function updateOnePage('));
    for (const id of ['driver-rate-load', 'driver-rate-empty', 'driver-pct-val', 'per-diem', 'to-cost', 'to-period', 'tire-cost', 'tire-count',
        'tire-mileage', 'total-fleet', 'overhead-amort', 'overhead-admin', 'overhead-other-op', 'overhead-other', 'overhead-repair', 'overhead-fin', 'adblue-price']) {
        assert.ok(build.includes("opMoveField('" + id + "'"), id);
    }
    assert.match(build, /opAccRow\('costs', '4', 'Витрати і накладні'/);
    assert.match(html, /\.tc-costs-rows \.form-row > label[\s\S]{0,80}flex: 0 0 190px/, 'компактний рядок: підпис зліва, поле вузьке');
    assert.equal(/from\('fleet_vehicles'\)\s*\.(update|upsert)\([^)]*(driverRate|toCost|tire|overhead)/.test(html), false);
});
