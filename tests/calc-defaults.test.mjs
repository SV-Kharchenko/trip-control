// «Витратна частина» компанії (особистий кабінет) → калькулятор. Пріоритет значень: картка вибраного авто (пальне, AdBlue) →
// company_settings.settings (вкладка «Витратна частина») → вбудоване. tc_calc_last більше не використовується.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const { calculateTrip } = await import('../api/calculate.js');
const S0 = JSON.parse(fs.readFileSync(new URL('./fixtures/s0-fop.json', import.meta.url), 'utf8'));

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function fnSource(name) {
    const start = html.indexOf(/^(async )?function /.test(name) ? name : 'function ' + name + '(');
    assert.ok(start > 0, name);
    const from = html.lastIndexOf('\n', start) + 1;
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(from, i + 1);
    }
    throw new Error(name);
}
const literal = (name) => html.match(new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\});'))[1];
const literal2 = (name) => { const head = 'const ' + name + ' = '; const a = html.indexOf(head); return html.slice(a + head.length, html.indexOf('];', a) + 1); };
const cabSections = () => html.slice(html.indexOf('const CAB_SECTIONS = ['), html.indexOf('const LEGACY_SETTINGS_KEYS'));

// Значення, збережені в проді (company_settings.settings): ті самі ключі, що й завжди.
const PROD_SETTINGS = {
    totalFleet: 4, amort: 120000, admin: 60000, otherOperating: 30000, otherExpenses: 10000, repair: 50000, fin: 20000,
    fuelLoad: 36.5, fuelEmpty: 29, fuelPrice: 58, adblueEnable: 'off', adblueConsumption: 2.6, adbluePrice: 20,
    driverPayMode: 'pct', driverRateLoad: 4.5, driverRateEmpty: 2.5, driverPctVal: 14, perDiem: 700,
    toCost: 20000, toPeriod: 45000, tireCost: 17000, tireCount: 12, tireMileage: 140000, doc_warn_days: 45, fact_alert_pct: 12,
};

// Усі приховані поля калькулятора + мінімальний DOM; функції беремо прямо з index.html.
function setup({ settings = {}, role = 'owner', rpcError = null } = {}) {
    const els = {};
    const rpcCalls = [];
    const supabaseClient = { rpc: async (name, args) => { rpcCalls.push({ name, args }); return { error: rpcError }; } };
    const el = (id, value = '') => (els[id] = els[id] || {
        id, value, handlers: {}, style: {}, hidden: false, disabled: false, dataset: {}, textContent: '', innerText: '',
        classList: { toggle() {} }, addEventListener(n, f) { this.handlers[n] = f; }, querySelector() { return null; },
    });
    const context = vm.createContext({
        document: { getElementById: (id) => els[id] || null, querySelector: () => null },
        companySettings: settings, currentOrgRole: role, companyTax: '', refreshCabWarning() {}, bindCardOverrides() {},
        cardSourced: {}, cardPrev: {}, console, currentOrgId: 'org-1', isDemo: false, rpcCalls, supabaseClient,
    });
    vm.runInContext([
        'const OPT_ON_OFF = [["on","Увімкнено"],["off","Вимкнено"]];',
        cabSections(),
        'const SETTINGS_MAP = {}; CAB_SECTIONS.forEach(sec => sec.fields.forEach(f => { SETTINGS_MAP[f.key] = f; }));',
        'const STARTER_SETTINGS = ' + literal('STARTER_SETTINGS') + ';',
        "const PRICE_KEYS = ['fuelPrice', 'adbluePrice']; const LAST_PRICE_KEY = " + literal('LAST_PRICE_KEY') + ';',
        'const priceTouched = {}; let priceMemoryBound = false;',
        ...['calcSettingOk', 'priceValueOk', 'calcValueFor', 'hasCompanyCosts', 'bindPriceMemory', 'async function saveLastPrice(key)', 'applyCalcDefaults'].map(fnSource),
    ].join('\n'), context);
    const ids = JSON.parse(vm.runInContext('JSON.stringify(Object.fromEntries(Object.entries(SETTINGS_MAP).map(([k, f]) => [k, f.id])))', context));
    Object.values(ids).forEach((id) => el(id));
    for (const id of ['calc-type', 'driver-km-box', 'driver-pct-box', 'field-adblue-consumption', 'field-adblue-price', 'tc-costs-edit']) el(id);
    return { context, el, ids, rpcCalls };
}
const value = (s, key) => s.el(s.ids[key]).value;

test('calcValueFor: empty company → built-in; company values win; invalid values are ignored', () => {
    const fresh = setup();
    assert.equal(vm.runInContext('calcValueFor("fuelPrice")', fresh.context), 95);
    assert.equal(vm.runInContext('calcValueFor("adblueEnable")', fresh.context), 'on');
    assert.equal(vm.runInContext('calcValueFor("amort")', fresh.context), undefined, 'overheads stay empty without company data');
    assert.equal(vm.runInContext('hasCompanyCosts()', fresh.context), false);
    const company = setup({ settings: PROD_SETTINGS });
    assert.equal(vm.runInContext('calcValueFor("fuelPrice")', company.context), 58, 'the old fuelPrice setting is still honoured when there is no last price');
    assert.equal(vm.runInContext('calcValueFor("amort")', company.context), 120000);
    assert.equal(vm.runInContext('calcValueFor("adblueEnable")', company.context), 'off');
    assert.equal(vm.runInContext('calcValueFor("driverPayMode")', company.context), 'pct');
    assert.equal(vm.runInContext('hasCompanyCosts()', company.context), true);
    const broken = setup({ settings: { fuelLoad: -3, fuelEmpty: 'abc', adblueEnable: 'maybe', fuelPrice: null } });
    assert.equal(vm.runInContext('calcValueFor("fuelLoad")', broken.context), 38, 'negative → built-in');
    assert.equal(vm.runInContext('calcValueFor("fuelEmpty")', broken.context), 32);
    assert.equal(vm.runInContext('calcValueFor("adblueEnable")', broken.context), 'on');
    assert.equal(vm.runInContext('hasCompanyCosts()', broken.context), false);
    // Лише службові ключі (doc_warn_days тощо) — це ще не «витратна частина».
    assert.equal(vm.runInContext('hasCompanyCosts({ doc_warn_days: 30 })', fresh.context), false);
});

test('applyCalcDefaults: the company values fill the calculator fields; no tc_calc_last', () => {
    const s = setup({ settings: PROD_SETTINGS });
    vm.runInContext('applyCalcDefaults()', s.context);
    for (const [key, v] of Object.entries(PROD_SETTINGS)) if (s.ids[key]) assert.equal(String(value(s, key)), String(v), key);
    assert.equal(s.el('driver-km-box').style.display, 'none', 'pct mode hides the km rates');
    assert.equal(s.el('driver-pct-box').style.display, 'block');
    assert.equal(html.includes('tc_calc_last'), false, 'localStorage tc_calc_last is gone');
    assert.equal(/readCalcLast|saveCalcLast|bindCalcLast/.test(html), false);
    // Порожня компанія → вбудований шаблон, накладні порожні.
    const empty = setup();
    vm.runInContext('applyCalcDefaults()', empty.context);
    assert.equal(value(empty, 'fuelLoad'), 38);
    assert.equal(value(empty, 'driverRateLoad'), 4.03);
    assert.equal(value(empty, 'amort'), '');
    // Логіст бачить ті самі значення, але без посилання «Змінити».
    const logist = setup({ settings: PROD_SETTINGS, role: 'logist' });
    vm.runInContext('applyCalcDefaults()', logist.context);
    assert.equal(logist.el('tc-costs-edit').hidden, true);
    assert.equal(value(logist, 'amort'), 120000);
    const owner = setup({ settings: PROD_SETTINGS });
    vm.runInContext('applyCalcDefaults()', owner.context);
    assert.equal(owner.el('tc-costs-edit').hidden, false);
});

test('company overheads and driver rates reach the calculation (not 0)', () => {
    const s = setup({ settings: PROD_SETTINGS });
    vm.runInContext('applyCalcDefaults()', s.context);
    // Те, що калькулятор шле на сервер: поля форми за ключами SETTINGS_MAP.
    const payload = { ...S0 };
    for (const key of Object.keys(s.ids)) payload[key] = value(s, key);
    payload.driverPayMode = 'km';
    const withCompany = calculateTrip(payload);
    const without = calculateTrip({ ...S0, amort: '', admin: '', otherOperating: '', otherExpenses: '', repair: '', fin: '' });
    const row = (r, needle) => r.detailedRows.find((item) => item.name.indexOf(needle) !== -1).val;
    assert.ok(row(withCompany, 'Накладні до EBITDA') > 0, 'overheads from the company are counted');
    assert.equal(row(without, 'Накладні до EBITDA'), 0);
    assert.deepEqual(withCompany.warnings, [], 'no empty-overhead warnings when the company filled them');
    assert.ok(withCompany.netProfit < without.netProfit);
    const lowRate = calculateTrip({ ...payload, driverRateLoad: '1', driverRateEmpty: '1' });
    assert.notEqual(lowRate.netProfit, withCompany.netProfit, 'driver rate from the company changes the result');
    assert.equal(String(payload.perDiem), '700');
    assert.equal(String(payload.totalFleet), '4');
});

// ---- Пальне: картка авто → середня компанії → вбудоване ----
function cardSetup({ settings = {}, vehicles = [], active = true } = {}) {
    const s = setup({ settings });
    vm.runInContext('applyCalcDefaults()', s.context);
    s.context.chosenFleetVehicles = () => vehicles;
    s.context.fleetChoiceActive = () => active && vehicles.length > 0;
    s.context.vehicleNormNumber = (v, min, max) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    const base = s.context.document.getElementById;
    s.context.document.getElementById = (id) => (id === 'field-adblue-consumption' || id === 'field-adblue-price' ? { classList: { toggle() {} } } : base(id));
    vm.runInContext([
        'const CARD_NORM_FIELDS = ' + literal2('CARD_NORM_FIELDS') + ';',
        'let cardSig = ""; let cardSyncing = false; const cardOverrides = {};',
        ...['cardNormOf', 'cardCommonNorm', 'syncCardNormsToForm', 'markCardOverride', 'stripCardOverrides'].map(fnSource),
    ].join('\n'), s.context);
    return s;
}
const car = (id, extra) => ({ id, fuel_load: null, fuel_empty: null, adblue_on: null, adblue_consumption: null, ...extra });

test('fuel: a vehicle with a consumption → by the vehicle card', () => {
    const s = cardSetup({ settings: PROD_SETTINGS, vehicles: [car('a', { fuel_load: 31, fuel_empty: 26, adblue_on: true, adblue_consumption: 3 })] });
    assert.equal(value(s, 'fuelLoad'), 36.5, 'before the choice: the company average');
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), 31);
    assert.equal(value(s, 'fuelEmpty'), 26);
    assert.equal(value(s, 'adblueConsumption'), 3);
    assert.equal(value(s, 'adblueEnable'), 'on');
});

test('fuel: a vehicle without a consumption (or no vehicle) → the company average', () => {
    const s = cardSetup({ settings: PROD_SETTINGS, vehicles: [car('a', { fuel_load: null, fuel_empty: null })] });
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), 36.5);
    assert.equal(value(s, 'fuelEmpty'), 29);
    const partial = cardSetup({ settings: PROD_SETTINGS, vehicles: [car('a', { fuel_load: 31 })] });
    vm.runInContext('syncCardNormsToForm()', partial.context);
    assert.equal(value(partial, 'fuelLoad'), 31);
    assert.equal(value(partial, 'fuelEmpty'), 29, 'what the card does not have comes from the company');
    const none = cardSetup({ settings: PROD_SETTINGS, vehicles: [] });
    vm.runInContext('syncCardNormsToForm()', none.context);
    assert.equal(value(none, 'fuelLoad'), 36.5);
});

test('fuel: empty company → the built-in values (and the card still wins)', () => {
    const s = cardSetup({ settings: {}, vehicles: [car('a', { fuel_load: 31 })] });
    assert.equal(value(s, 'fuelLoad'), 38);
    assert.equal(value(s, 'fuelEmpty'), 32);
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), 31);
    assert.equal(value(s, 'fuelEmpty'), 32, 'built-in when neither the card nor the company has it');
});

test('fuel: switching vehicles and clearing the choice returns to the company value; manual edits stay for this trip only', () => {
    const a = car('a', { fuel_load: 31 });
    const b = car('b', { fuel_load: 35 });
    const s = cardSetup({ settings: PROD_SETTINGS, vehicles: [a] });
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), 31);
    s.context.chosenFleetVehicles = () => [b];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), 35);
    s.context.chosenFleetVehicles = () => [a, b];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), 36.5, 'different norms → the company average');
    // Компанію змінили, поки авто вибране: після повернення до «без авто» діє нове середнє.
    s.context.chosenFleetVehicles = () => [a];
    vm.runInContext('syncCardNormsToForm()', s.context);
    vm.runInContext('companySettings = Object.assign({}, companySettings, { fuelLoad: 40 }); applyCalcDefaults();', s.context);
    assert.equal(value(s, 'fuelLoad'), 31, 'the card is not overwritten by the company');
    s.context.fleetChoiceActive = () => false;
    s.context.chosenFleetVehicles = () => [];
    vm.runInContext('syncCardNormsToForm()', s.context);
    assert.equal(value(s, 'fuelLoad'), '40');
    // Ручна правка поля з картки не береться з картки.
    const t = cardSetup({ vehicles: [car('a', { fuel_load: 31, adblue_on: true, adblue_consumption: 3 })] });
    vm.runInContext('syncCardNormsToForm()', t.context);
    const resolved = { fuelLoad: 31, fuelEmpty: 26, useAdblue: true, adblueConsumption: 3 };
    const clean = (o) => JSON.parse(vm.runInContext('JSON.stringify(stripCardOverrides(' + JSON.stringify(o) + '))', t.context));
    assert.deepEqual(clean(resolved), resolved);
    vm.runInContext('markCardOverride("fuelLoad")', t.context);
    assert.deepEqual(clean(resolved), { fuelEmpty: 26, useAdblue: true, adblueConsumption: 3 });
});

// ---- Вкладка кабінету ----
function cabinetSetup({ role = 'owner', settings = PROD_SETTINGS } = {}) {
    const saved = [];
    const s = setup({ settings, role });
    const cab = {};
    const cabEl = (id) => (cab[id] = cab[id] || { id, value: '', disabled: false, hidden: false, style: {}, textContent: '', innerText: '', dataset: {}, querySelector: () => null });
    const msg = cabEl('cab-costs-message');
    const panel = { dataset: {} };
    const context = s.context;
    for (const key of Object.keys(s.ids)) cabEl('cab-' + key);
    ['cab-name', 'cab-tax', 'cab-costs-save', 'cab-save-btn', 'cab-message', 'cab-overhead-sum'].forEach(cabEl);
    cab['cab-name'].value = 'ТОВ Тест';
    cab['cab-tax'].value = 'фоп';
    context.document.getElementById = (id) => cab[id] || null;
    context.document.querySelector = (sel) => (sel.includes('data-panel="costs"') ? panel : null);
    context.currentOrgId = 'org-1';
    context.companyName = 'ТОВ Тест';
    context.COMPANY_PROFILE_FIELDS = [];
    context.LEGACY_SETTINGS_KEYS = ['normWeight', 'daysPerTrip', 'washCost', 'washFreq'];
    context.notifySaved = () => saved.push('ok');
    context.notifySaveError = () => saved.push('error');
    context.calculate = () => saved.push('calculate');
    context.refreshCalcFromCompany = () => saved.push('refresh');
    context.Intl = Intl;
    // «База»: kp_company_settings_merge зливає патч з актуальним значенням (як jsonb ||); прямого запису company_settings немає.
    const db = { settings: JSON.parse(JSON.stringify(settings)) };
    context.supabaseClient = {
        from: (table) => ({
            update: () => ({ eq: async () => { saved.push('update:' + table); return {}; } }),
            upsert: async (row) => { saved.push('upsert:' + table + ':' + JSON.stringify(row.settings || row)); return {}; },
        }),
        rpc: async (name, args) => {
            if (name !== 'kp_company_settings_merge') return { data: null, error: { message: 'unexpected rpc ' + name } };
            saved.push('rpc:merge:' + JSON.stringify(args));
            const kept = Object.fromEntries(Object.entries(db.settings).filter(([k]) => !args.p_remove.includes(k)));
            db.settings = Object.assign(kept, args.p_set);
            return { data: db.settings, error: null };
        },
    };
    vm.runInContext([
        'const COST_SHOW_IF = {' + html.slice(html.indexOf('const COST_SHOW_IF = {') + 'const COST_SHOW_IF = {'.length, html.indexOf('};', html.indexOf('const COST_SHOW_IF = {')) + 1),
        ...['updateCabVisibility', 'refreshCabOverheadSum', 'fillCostsTab', 'collectCostSettings', 'settingsPatch', 'async function mergeCompanySettings(set, remove)', 'async function saveCabinet(scope)'].map(fnSource),
    ].join('\n'), context);
    return { ...s, cab, msg, panel, saved, db };
}

test('the costs tab shows the old production values (same keys, no migration)', () => {
    const t = cabinetSetup();
    vm.runInContext('fillCostsTab()', t.context);
    for (const [key, v] of Object.entries(PROD_SETTINGS)) {
        if (!t.cab['cab-' + key]) continue;
        assert.equal(String(t.cab['cab-' + key].value), String(v), key);
    }
    assert.equal(t.cab['cab-driverPayMode'].value, 'pct');
    assert.equal(t.panel.dataset.filled, '1');
    assert.equal(t.cab['cab-amort'].disabled, false, 'the owner edits');
    // Порожні ключі лишаються порожніми, а не підставляються вбудованими.
    const sparse = cabinetSetup({ settings: { fuelLoad: 40 } });
    vm.runInContext('fillCostsTab()', sparse.context);
    assert.equal(sparse.cab['cab-fuelLoad'].value, '40');
    assert.equal(sparse.cab['cab-amort'].value, '');
    assert.equal(sparse.cab['cab-fuelEmpty'].value, '');
});

test('the logist sees the tab read-only and cannot save the costs', async () => {
    const t = cabinetSetup({ role: 'logist' });
    vm.runInContext('fillCostsTab()', t.context);
    assert.equal(t.cab['cab-amort'].disabled, true);
    assert.equal(t.cab['cab-costs-save'].hidden, true);
    assert.match(t.msg.textContent, /Лише перегляд/);
    await vm.runInContext('saveCabinet("costs")', t.context);
    assert.deepEqual(t.saved.filter((x) => x !== 'error'), [], 'nothing is written: no upsert, no update');
    assert.match(t.msg.textContent, /Логіст може переглядати норми, але змінює їх власник/);
    await vm.runInContext('saveCabinet()', t.context);
    assert.equal(t.saved.some((x) => x.startsWith('upsert') || x.startsWith('update') || x.startsWith('rpc')), false);
});

test('the owner saves only company_settings; other keys are kept; empty fields drop their key', async () => {
    const t = cabinetSetup();
    vm.runInContext('fillCostsTab()', t.context);
    t.cab['cab-amort'].value = '150000';
    t.cab['cab-perDiem'].value = '';
    t.cab['cab-driverPayMode'].value = 'km';
    t.db.settings.lastFuelPrice = 70; // цю ціну тим часом записав логіст в іншій вкладці
    await vm.runInContext('saveCabinet("costs")', t.context);
    const call = t.saved.find((x) => x.startsWith('rpc:merge:'));
    assert.ok(call, 'company_settings is saved through the server merge');
    const patch = JSON.parse(call.slice('rpc:merge:'.length));
    assert.deepEqual(Object.keys(patch.p_set).sort(), ['amort', 'driverPayMode'], 'only the changed keys are sent');
    assert.deepEqual(patch.p_remove, ['perDiem']);
    assert.equal(t.saved.some((x) => x.startsWith('upsert:company_settings')), false, 'no whole-object overwrite');
    const next = t.db.settings;
    assert.equal(next.lastFuelPrice, 70, 'a key written meanwhile by someone else survives');
    assert.equal(vm.runInContext('companySettings.lastFuelPrice', t.context), 70, 'the page takes the merged object from the server');
    assert.equal(next.amort, 150000);
    assert.equal('perDiem' in next, false, 'an empty field removes the key (empty = 0)');
    assert.equal(next.driverPayMode, 'km');
    assert.equal(next.doc_warn_days, 45, 'unrelated keys are not wiped');
    assert.equal(next.fact_alert_pct, 12);
    assert.equal(next.fuelLoad, 36.5);
    assert.equal(t.saved.some((x) => x.startsWith('update:organizations') || x.startsWith('upsert:org_company_profiles')), false, 'the profile and the name are not touched');
    assert.ok(t.saved.includes('refresh') && t.saved.includes('ok'));
});

test('the Profile save keeps the settings as they were unless the costs tab was filled', async () => {
    const t = cabinetSetup();
    await vm.runInContext('saveCabinet()', t.context);
    assert.equal(t.saved.some((x) => x.startsWith('rpc:merge:') || x.startsWith('upsert:company_settings')), false, 'nothing changed: nothing is sent');
    assert.deepEqual(JSON.parse(JSON.stringify(t.db.settings)), PROD_SETTINGS, 'the settings are as they were');
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(companySettings)', t.context)), PROD_SETTINGS);
});

// ---- Структура index.html ----
test('structure: block 4 left the calculator for a compact line; the tab is in the cabinet; the old restrictions are lifted', () => {
    const build = html.slice(html.indexOf('function buildOnePage()'), html.indexOf('function updateOnePage('));
    assert.equal(/opAccRow\('costs'/.test(build), false, 'no «Витрати і накладні» row');
    assert.equal(build.includes('Витрати і накладні'), false);
    assert.match(build, /costsText\.textContent = 'Витрати: з витратної частини компанії';/);
    assert.match(build, /costsEdit\.textContent = 'Змінити';/);
    assert.match(build, /openCabinetTab\('costs'\)/);
    assert.match(build, /costsEdit\.hidden = currentOrgRole !== 'owner'/);
    for (const id of ['driver-rate-load', 'driver-rate-empty', 'driver-pct-val', 'per-diem', 'to-cost', 'to-period', 'tire-cost', 'tire-count',
        'tire-mileage', 'total-fleet', 'overhead-amort', 'overhead-admin', 'overhead-other-op', 'overhead-other', 'overhead-repair', 'overhead-fin']) {
        assert.equal(build.includes("opMoveField('" + id + "'"), false, id + ' is no longer in the calculator');
        assert.match(html, new RegExp('<input type="number" id="' + id + '"'), id + ' stays as the hidden source of the calculation');
    }
    const panel = html.slice(html.indexOf('const COST_GROUPS = ['), html.indexOf('function updateCabVisibility()'));
    for (const title of ['Водій', 'ТО і шини', 'Накладні', 'Пальне']) assert.ok(panel.includes("title: '" + title + "'"), title);
    for (const key of ['driverPayMode', 'driverRateLoad', 'driverRateEmpty', 'perDiem', 'toCost', 'toPeriod', 'tireCost', 'tireCount', 'tireMileage',
        'totalFleet', 'amort', 'admin', 'otherOperating', 'otherExpenses', 'repair', 'fin', 'fuelLoad', 'fuelEmpty', 'adblueEnable', 'adblueConsumption']) {
        assert.ok(panel.includes("['" + key + "'"), key);
    }
    // Ціни дизпалива й AdBlue вводяться лише в калькуляторі.
    assert.equal(panel.includes("['fuelPrice'"), false);
    assert.equal(panel.includes("['adbluePrice'"), false);
    assert.equal((panel.match(/Порожньо = вбудоване значення\./g) || []).length, 2, 'driver and TO / tires');
    assert.match(panel, /Річні суми на весь парк\. Порожньо = 0 у розрахунку\./);
    assert.match(panel, /Разом накладних на рік/);
    assert.match(panel, /Річні суми на весь парк\. Порожньо = 0 у розрахунку\./);
    assert.match(html, /\{ id: 'costs', title: 'Витратна частина' \}/);
    assert.equal(/data-panel="fuel"/.test(html), false);
    // Кнопки за розміром вмісту, на всю ширину — лише з .btn-block.
    assert.equal(/cab-costs-actions[^}]*width:\s*100%/.test(html), false);
    assert.match(html, /id="cab-costs-save" onclick="saveCosts\(\)"/);
    assert.equal(/id="cab-costs-save"[^>]*btn-block/.test(html), false);
    // Калькулятор читає company_settings через calcValueFor; стартовий шаблон не пишеться в БД.
    assert.match(fnSource('applyCalcDefaults'), /calcValueFor\(key\)/);
    assert.match(fnSource('ensureStarterTemplate'), /hasCompanyCosts\(\)/);
    assert.equal(/company_settings/.test(fnSource('ensureStarterTemplate')), false);
    assert.match(fnSource('async function saveCabinet(scope)'), /const next = Object\.assign\(\{\}, companySettings\);/);
    assert.match(fnSource('async function saveCabinet(scope)'), /if \(currentOrgRole === 'logist'\) \{/);
});

test('the empty-cost warning leads the owner to the costs tab (the logist gets the text without a button)', () => {
    assert.match(fnSource('calcWarningField'), /closest\('#main-sync-fields'\)\) return \{ input: input, step: 0, cabinet: true \}/);
    assert.match(fnSource('focusCalcWarningField'), /if \(target\.cabinet\) \{ openCabinetTab\('costs'\); return; \}/);
    assert.match(fnSource('renderCostWarnings'), /target\.cabinet \? 'Заповнити у витратній частині' : 'Заповнити в калькуляторі'/);
    assert.match(fnSource('renderCostWarnings'), /!target\.cabinet \|\| currentOrgRole === 'owner'/);
});

// ---- Остання ціна дизпалива й AdBlue: на компанію, не в localStorage ----
test('last price: the company last price → the built-in; one company never sees another one\'s price', () => {
    const a = setup({ settings: { lastFuelPrice: 63.2, lastAdbluePrice: 21 } });
    const b = setup({ settings: { lastFuelPrice: 55 } });
    const c = setup({ settings: {} });
    vm.runInContext('applyCalcDefaults()', a.context);
    vm.runInContext('applyCalcDefaults()', b.context);
    vm.runInContext('applyCalcDefaults()', c.context);
    assert.equal(value(a, 'fuelPrice'), 63.2);
    assert.equal(value(a, 'adbluePrice'), 21);
    assert.equal(value(b, 'fuelPrice'), 55);
    assert.equal(value(b, 'adbluePrice'), 18, 'B has no AdBlue price: the built-in, not A\'s');
    assert.equal(value(c, 'fuelPrice'), 95, 'an empty company: the built-in');
    assert.equal(value(c, 'adbluePrice'), 18);
    // Недопустимі значення ігноруються (0, від’ємні, ≥ 1000, не число).
    const bad = setup({ settings: { lastFuelPrice: 0, lastAdbluePrice: 1000 } });
    assert.equal(vm.runInContext('calcValueFor("fuelPrice")', bad.context), 95);
    assert.equal(vm.runInContext('calcValueFor("adbluePrice")', bad.context), 18);
    assert.equal(vm.runInContext('calcValueFor("fuelPrice", { lastFuelPrice: "63" })', bad.context), 95);
    // Найновіша ціна компанії перемагає старе значення з налаштувань.
    assert.equal(vm.runInContext('calcValueFor("fuelPrice", { fuelPrice: 58, lastFuelPrice: 60.5 })', bad.context), 60.5);
    assert.equal(html.includes('tc_calc_last'), false);
    assert.equal(/localStorage[^;\n]*(lastFuelPrice|lastAdbluePrice)/.test(html), false, 'the last price is not kept in localStorage');
});

test('last price: a manual edit is saved through the RPC, the logist can do it, and only the price is sent', async () => {
    for (const role of ['owner', 'logist']) {
        const s = setup({ settings: PROD_SETTINGS, role });
        vm.runInContext('applyCalcDefaults()', s.context);
        s.el('fuel-price').value = '61.236';
        s.el('fuel-price').handlers.change();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(JSON.parse(JSON.stringify(s.rpcCalls)), [{ name: 'kp_set_last_fuel_prices', args: { p_fuel: 61.24, p_adblue: null } }], role);
        assert.equal(vm.runInContext('companySettings.lastFuelPrice', s.context), 61.24);
        assert.equal(vm.runInContext('companySettings.amort', s.context), 120000, 'the costs are not touched');
        s.el('adblue-price').value = '19.5';
        s.el('adblue-price').handlers.change();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(JSON.parse(JSON.stringify(s.rpcCalls[1])), { name: 'kp_set_last_fuel_prices', args: { p_fuel: null, p_adblue: 19.5 } });
        // Те саме значення вдруге не пишемо; сміття не пишемо.
        s.el('adblue-price').handlers.change();
        s.el('fuel-price').value = '-3';
        s.el('fuel-price').handlers.change();
        s.el('fuel-price').value = '1000';
        s.el('fuel-price').handlers.change();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(s.rpcCalls.length, 2);
    }
    // Демо і перегляд (директор) нічого не пишуть.
    const demo = setup({ settings: {} });
    vm.runInContext('isDemo = true; applyCalcDefaults()', demo.context);
    demo.el('fuel-price').value = '70';
    demo.el('fuel-price').handlers.change();
    const viewer = setup({ settings: {}, role: 'director' });
    vm.runInContext('applyCalcDefaults()', viewer.context);
    viewer.el('fuel-price').value = '70';
    viewer.el('fuel-price').handlers.change();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(demo.rpcCalls.length + viewer.rpcCalls.length, 0);
    // Помилка бази: ціна діє в рейсі, у пам’ять компанії не потрапляє.
    const failing = setup({ settings: {}, rpcError: { message: 'x' } });
    vm.runInContext('applyCalcDefaults()', failing.context);
    failing.el('fuel-price').value = '64';
    failing.el('fuel-price').handlers.change();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vm.runInContext('companySettings.lastFuelPrice', failing.context), undefined);
    assert.equal(failing.el('fuel-price').value, '64');
});

test('last price: a price typed in the current trip is not overwritten by applyCalcDefaults / the costs refresh; a new calculation takes the last price', () => {
    const s = setup({ settings: { lastFuelPrice: 60, lastAdbluePrice: 20, amort: 100000 } });
    vm.runInContext('applyCalcDefaults()', s.context);
    assert.equal(value(s, 'fuelPrice'), 60, 'a new calculation: the last company price');
    s.el('fuel-price').value = '66';
    s.el('fuel-price').handlers.input();
    vm.runInContext('companySettings = Object.assign({}, companySettings, { lastFuelPrice: 61, amort: 150000 }); applyCalcDefaults()', s.context);
    assert.equal(value(s, 'fuelPrice'), '66', 'the typed price survives applyCalcDefaults');
    assert.equal(value(s, 'amort'), 150000, 'the costs are refreshed');
    assert.equal(value(s, 'adbluePrice'), 20, 'the untouched price follows the company');
    // Після збереження вкладки витрат ціни не чіпаємо взагалі (вони можуть бути з відкритої заявки).
    s.el('adblue-price').value = '17';
    vm.runInContext('companySettings = Object.assign({}, companySettings, { lastAdbluePrice: 25, amort: 160000 }); applyCalcDefaults(true)', s.context);
    assert.equal(value(s, 'adbluePrice'), '17');
    assert.equal(value(s, 'amort'), 160000);
    assert.match(html.slice(html.indexOf('function refreshCalcFromCompany()'), html.indexOf('function saveCosts()')), /applyCalcDefaults\(true\)/);
});

test('the costs tab: built-in values as placeholders for driver and TO / tires; no price fields', () => {
    const markup = html.slice(html.indexOf('function costFieldHtml('), html.indexOf('function updateCabVisibility()'));
    assert.match(markup, /placeholder=/);
    assert.match(markup, /builtin && STARTER_SETTINGS\[f\.key\] !== undefined/);
    const groups = html.slice(html.indexOf('const COST_GROUPS = ['), html.indexOf('const COST_SHOW_IF'));
    assert.match(groups, /title: 'Водій', builtin: true, note: 'Порожньо = вбудоване значення\.'/);
    assert.match(groups, /title: 'ТО і шини', builtin: true, note: 'Порожньо = вбудоване значення\.'/);
    assert.equal(/title: 'Накладні', builtin/.test(groups), false, 'overheads keep «Порожньо = 0»');
    assert.equal(/title: 'Пальне', builtin/.test(groups), false);
});

test('saving the costs keeps the last prices the logists wrote in the meantime (server merge, not a whole overwrite)', async () => {
    const t = cabinetSetup({ settings: { ...PROD_SETTINGS, lastFuelPrice: 50 } });
    vm.runInContext('fillCostsTab()', t.context);
    t.cab['cab-amort'].value = '150000';
    // Поки сторінка була відкрита, логіст записав нові ціни, а інша вкладка — ще один ключ.
    Object.assign(t.db.settings, { lastFuelPrice: 62.5, lastAdbluePrice: 19, other_tab: 'x' });
    await vm.runInContext('saveCabinet("costs")', t.context);
    const patch = JSON.parse(t.saved.find((x) => x.startsWith('rpc:merge:')).slice('rpc:merge:'.length));
    assert.deepEqual(patch.p_set, { amort: 150000 });
    assert.equal(t.saved.some((x) => x.startsWith('upsert:company_settings')), false);
    const next = t.db.settings;
    assert.equal(next.amort, 150000);
    assert.equal(next.lastFuelPrice, 62.5, 'the fresher price from the database is kept');
    assert.equal(next.lastAdbluePrice, 19);
    assert.equal(next.other_tab, 'x');
    assert.equal(next.fuelLoad, 36.5);
});

test('the other settings writers (warning days, fact alert %) also use the merge', () => {
    assert.equal(html.includes("from('company_settings').upsert"), false, 'no whole-object upsert of company_settings is left');
    assert.equal(html.includes("from('company_settings')\n                .upsert"), false);
    assert.ok(html.includes('mergeCompanySettings({ doc_warn_days: Math.round(n) }, [])'));
    assert.ok(html.includes('mergeCompanySettings({ fact_alert_pct: n }, [])'));
    assert.ok(html.includes("rpc('kp_company_settings_merge', { p_set: set, p_remove: remove || [] })"));
});
