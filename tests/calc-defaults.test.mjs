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
