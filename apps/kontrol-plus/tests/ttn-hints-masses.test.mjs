// ТТН: маси автопоїзда (авто + причіп) і підказки «?» біля полів. Усі дані вигадані.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trainMasses, totalMass, massWarning } from '../src/lib/ttn.js';
import { TTN_HINTS, ttnHint } from '../src/lib/ttn-hints.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const form = read('src/views/docs-ttn-form.js');

const CAR = { tare_t: 6.7, max_mass_t: 17.2 };
const TRAILER = { tare_t: 7.3, max_mass_t: 22.8 };

// ---- Маси ----
test('маси: тара й макс. маса = авто + причіп; підказки з розкладом', () => {
    const m = trainMasses(CAR, TRAILER, true);
    assert.equal(m.tare, 14);
    assert.equal(m.max, 40);
    assert.equal(m.tareHint, 'Авто 6,7 т + причіп 7,3 т');
    assert.equal(m.maxHint, 'Авто 17,2 т + причіп 22,8 т');
    assert.equal(m.warning, '');
});

test('маси: загальна маса = тара (авто + причіп) + брутто вантажу; попередження про перевантаження рахується від суми', () => {
    const m = trainMasses(CAR, TRAILER, true);
    assert.equal(totalMass(m.tare, 24.09), 38.09);
    assert.equal(massWarning(m.tare, 24.09, m.max), null);
    assert.match(massWarning(m.tare, 27, m.max), /Загальна маса 41 т більша за максимально дозволену 40 т/);
    // Лише авто: ті самі 27 т були б «перевантаженням» у 17,2 т, а 14+... — тут показує, чому раніше попередження було хибним.
    assert.ok(massWarning(6.7, 24.09, 17.2));
});

test('маси: без причепа — лише авто, без попередження; картка причепа ігнорується', () => {
    const m = trainMasses(CAR, TRAILER, false);
    assert.equal(m.tare, 6.7);
    assert.equal(m.max, 17.2);
    assert.equal(m.tareHint, 'Авто 6,7 т');
    assert.equal(m.warning, '');
});

test('маси: причіп без маси в картці — лише авто + попередження «немає маси причепа в картці»', () => {
    for (const card of [null, {}, { tare_t: null, max_mass_t: null }, { tare_t: 7.3 }]) {
        const m = trainMasses(CAR, card, true);
        assert.equal(m.warning, 'немає маси причепа в картці');
        assert.equal(m.max, card && card.max_mass_t ? 17.2 + card.max_mass_t : 17.2);
    }
    assert.equal(trainMasses(CAR, {}, true).tare, 6.7);
    assert.equal(trainMasses(CAR, {}, true).tareHint, 'Авто 6,7 т');
});

test('маси: сума без похибок float (6,7 + 7,3; 0,1 + 0,2) і порожні картки', () => {
    assert.equal(trainMasses({ tare_t: 0.1, max_mass_t: 1 }, { tare_t: 0.2, max_mass_t: 1 }, true).tare, 0.3);
    const none = trainMasses(null, null, false);
    assert.equal(none.tare, null);
    assert.equal(none.max, null);
    assert.equal(none.tareHint, '');
});

test('форма: тара/макс. маса беруться з trainMasses, ↺ повертає суму, «Операції» беруть тару форми; масу не додаємо в картки', () => {
    assert.match(form, /trainMasses\(vehicleCard\(\), trailerCard, hasTrailer\)/);
    assert.match(form, /function applyMasses\(\)[\s\S]*?snap = Object\.assign\(snap \|\| \{\}, \{ tare_t: String\(d\.tare_t\), max_mass_t: String\(d\.max_mass_t\) \}\)/);
    assert.match(form, /function applyVehicle[\s\S]*?applyMasses\(\);/);
    assert.match(form, /function applyTrailer[\s\S]*?applyMasses\(\);/);
    assert.match(form, /const total = totalMass\(d\.tare_t, d\.cargo_gross_t\);\s*const o = d\.operations\.find\(\(x\) => x\.op === 'load'\);\s*Object\.assign\(o, \{ gross_t: total \?\? '', tare_t: d\.tare_t \?\? ''/);
    assert.match(form, /'немає маси|masses\.warning/);
});

test('старі ТТН не перераховуються: маси рахує лише форма створення, друк бере збережені значення', () => {
    for (const file of ['src/lib/pdf-ttn.js', 'src/lib/ttn-text.js', 'src/views/docs-ttn.js', 'src/views/docs.js']) {
        if (!fs.existsSync(new URL('../' + file, import.meta.url))) continue;
        assert.doesNotMatch(read(file), /trainMasses/, file);
    }
    assert.match(read('src/lib/ttn.js'), /export function trainMasses/);
});

// ---- Підказки: мінімальний DOM ----
class FakeNode {
    constructor(tag) {
        this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.hidden = false;
        this.className = ''; this._text = ''; this.parent = null;
        const set = new Set();
        this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    append(...kids) { for (const k of kids) { if (k.parent) k.parent.children = k.parent.children.filter((c) => c !== k); k.parent = this; this.children.push(k); } }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    dispatch(type, extra = {}) { const event = { type, target: this, preventDefault() {}, ...extra }; for (const fn of [...(this.listeners[type] || [])]) fn(event); return event; }
    contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
    matches() { return this.keyboardFocus === true; }
    focus() { this.dispatch('focus'); }
    getBoundingClientRect() { return this.rect || { left: 0, right: 100, top: 0, bottom: 20, height: 20, width: 100 }; }
}
function withFakeDom(run) {
    const doc = new FakeNode('document');
    doc.createElement = (tag) => new FakeNode(tag);
    doc.createTextNode = (t) => ({ text: t });
    doc.body = new FakeNode('body');
    const keep = { document: globalThis.document, window: globalThis.window };
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'window', { value: Object.assign(new FakeNode('window'), { innerWidth: 390, innerHeight: 800 }), configurable: true, writable: true });
    return Promise.resolve(run(doc)).finally(() => {
        for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    });
}

test('підказка: кнопка type=button, aria-label, tooltip, текст лише через textContent; відкриття/закриття кліком', async () => {
    await withFakeDom(async () => {
        const { fieldHint } = await import('../src/lib/field-hint.js');
        const wrap = fieldHint('Ціна', '<b>Ціна</b> за одну одиницю');
        const [btn, pop] = wrap.children;
        assert.equal(btn.tagName, 'button');
        assert.equal(btn.getAttribute('type'), 'button');
        assert.equal(btn.getAttribute('aria-label'), 'Підказка: Ціна');
        assert.equal(btn.getAttribute('aria-expanded'), 'false');
        assert.equal(pop.getAttribute('role'), 'tooltip');
        assert.equal(btn.getAttribute('aria-describedby'), pop.getAttribute('id'));
        assert.equal(pop.textContent, '<b>Ціна</b> за одну одиницю', 'HTML не інтерпретується');
        assert.equal(pop.children.length, 0, 'жодних дочірніх елементів: лише текст');
        assert.equal(pop.hidden, true);
        btn.dispatch('click');
        assert.equal(pop.hidden, false);
        assert.equal(btn.getAttribute('aria-expanded'), 'true');
        btn.dispatch('click');
        assert.equal(pop.hidden, true);
        assert.equal(btn.getAttribute('aria-expanded'), 'false');
    });
});

test('підказка: Esc і клік поза закривають; клік усередині не закриває; слухачі знімаються', async () => {
    await withFakeDom(async (doc) => {
        const { fieldHint } = await import('../src/lib/field-hint.js');
        const wrap = fieldHint('Одиниця', 'Одиниця виміру');
        const [btn, pop] = wrap.children;
        btn.dispatch('click');
        assert.equal(pop.hidden, false);
        doc.dispatch('keydown', { key: 'Enter' });
        assert.equal(pop.hidden, false, 'інші клавіші не закривають');
        doc.dispatch('keydown', { key: 'Escape' });
        assert.equal(pop.hidden, true);
        assert.equal((doc.listeners.keydown || []).length, 0, 'слухач Esc знято');
        btn.dispatch('click');
        doc.dispatch('pointerdown', { target: pop });
        assert.equal(pop.hidden, false, 'клік у підказці не закриває');
        doc.dispatch('pointerdown', { target: new FakeNode('div') });
        assert.equal(pop.hidden, true, 'клік поза');
        assert.equal((doc.listeners.pointerdown || []).length, 0);
    });
});

test('підказка: фокус з клавіатури відкриває, фокус мишею — ні; blur закриває', async () => {
    await withFakeDom(async () => {
        const { fieldHint } = await import('../src/lib/field-hint.js');
        const [btn, pop] = fieldHint('Тара', 'Маса порожнього авто').children;
        btn.keyboardFocus = false;
        btn.focus();
        assert.equal(pop.hidden, true, 'тап / клік мишею відкриває лише click, інакше click одразу закрив би підказку');
        btn.keyboardFocus = true;
        btn.focus();
        assert.equal(pop.hidden, false);
        btn.dispatch('blur');
        assert.equal(pop.hidden, true);
    });
});

test('підказка: поповер переїжджає в <body>, стоїть біля «?» і не виходить за вікно браузера', async () => {
    await withFakeDom(async (doc) => {
        const { fieldHint } = await import('../src/lib/field-hint.js');
        const wrap = fieldHint('Сума', 'Рахується автоматично');
        const [btn, pop] = wrap.children;
        btn.rect = { left: 340, right: 360, top: 100, bottom: 120, height: 20, width: 20 };
        pop.rect = { left: 0, right: 160, top: 0, bottom: 60, height: 60, width: 160 };
        btn.dispatch('click');
        assert.equal(pop.parent, doc.body, 'відкрита підказка лежить у body');
        assert.equal(pop.style.left, '200px', 'правий край: 360 - 160, всередині 390 - 8');
        assert.equal(pop.style.top, '126px', 'під «?» з проміжком 6');
        btn.dispatch('click');
        assert.equal(pop.parent, wrap, 'закрита повертається до свого «?»');
        btn.rect = { left: 100, right: 120, top: 760, bottom: 780, height: 20, width: 20 };
        btn.dispatch('click');
        assert.equal(pop.classList.contains('kp-hint-up'), true, 'знизу тісно — вгору');
        assert.equal(pop.style.top, '694px');
        btn.dispatch('click');
        btn.rect = { left: -30, right: -10, top: 100, bottom: 120, height: 20, width: 20 };
        btn.dispatch('click');
        assert.equal(pop.style.left, '8px', 'лівий край вікна');
    });
});

test('підказка: відкрита лише одна; скрол і resize закривають; слухачі знімаються', async () => {
    await withFakeDom(async (doc) => {
        const { fieldHint } = await import('../src/lib/field-hint.js');
        const [b1, p1] = fieldHint('А', 'Перша').children;
        const [b2, p2] = fieldHint('Б', 'Друга').children;
        b1.dispatch('click');
        b2.dispatch('click');
        assert.equal(p1.hidden, true, 'відкриття другої закриває першу');
        assert.equal(p2.hidden, false);
        assert.equal(b1.getAttribute('aria-expanded'), 'false');
        window.dispatch('scroll', { target: doc });
        assert.equal(p2.hidden, false, 'скрол одразу після відкриття (браузер докручує до «?») лише переставляє підказку');
        const realNow = Date.now;
        Date.now = () => realNow() + 1000;
        try { window.dispatch('scroll', { target: doc }); } finally { Date.now = realNow; }
        assert.equal(p2.hidden, true, 'скрол закриває');
        b1.dispatch('click');
        window.dispatch('resize');
        assert.equal(p1.hidden, true);
        assert.equal((window.listeners.scroll || []).length, 0);
        assert.equal((window.listeners.resize || []).length, 0);
    });
});

test('підказка: withHint кладе значок поруч із полем у клітинку, кнопка не розтягується', async () => {
    await withFakeDom(async () => {
        const { withHint } = await import('../src/lib/field-hint.js');
        const input = new FakeNode('input');
        const cell = withHint(input, 'Ціна', 'Ціна за одиницю');
        assert.equal(cell.children[0], input);
        assert.equal(cell.children[1].children[0].getAttribute('aria-label'), 'Підказка: Ціна');
    });
    const css = read('src/crm.css');
    assert.doesNotMatch(css.match(/\.kp-hint-btn \{[^}]*\}/)[0], /width: 100%|flex: 1|btn-block/);
});

// ---- Словник ----
test('словник: тексти рядка вантажу з вимог дослівно, кожне поле форми має підказку', () => {
    const exact = {
        'line.cargo_name': 'Що везете, конкретно: культура/товар, клас, тара. Напр. «Пшениця 3 клас у біг-бегах».',
        'line.unit': 'Одиниця виміру кількості: т, кг, шт, м³.',
        'line.gross_t': 'Скільки одиниць вантажу.',
        'line.price': 'Ціна за ОДНУ одиницю без ПДВ, не за весь вантаж.',
        'line.amount': 'Рахується автоматично: кількість × ціна.',
        'line.packaging': 'Вид тари: насипом, біг-беги, мішки, палети, коробки.',
        'line.places': 'Скільки окремих місць (бегів, палет, коробок). Для насипу — 1 або порожньо.',
        'line.owner_price': 'Ставте, якщо ціна — облікова вартість власника вантажу, а не ціна продажу.',
        'line.bulk': 'Тільки для вантажу без тари: тоді брутто дорівнює нетто.',
        'line.docs': 'Що їде з вантажем: сертифікат якості, карантинний, ветеринарний тощо, з номерами.',
        'line.temperature': 'Лише для вантажів, що псуються (рефрижератор). Інакше порожньо.',
        'line.animal_id': 'Лише при перевезенні тварин. Інакше порожньо.',
        'line.animal_kind': 'Лише при перевезенні тварин. Інакше порожньо.',
        tare_t: 'Маса порожнього авто + причепа, з карток. Можна виправити для цієї ТТН.',
        max_mass_t: 'Сума дозволених мас авто і причепа. Лише для попередження.',
        total_mass: 'Тара + брутто вантажу.',
    };
    for (const [key, text] of Object.entries(exact)) assert.equal(TTN_HINTS[key], text, key);
    // Усі шляхи полів форми мають текст.
    const paths = new Set([...form.matchAll(/(?:field|numField|partyField)\('([a-z_.]+)'/g)].map((m) => m[1]));
    for (const who of ['customer', 'shipper', 'consignee']) for (const k of ['name', 'code', 'address']) paths.add(who + '.' + k);
    assert.ok(paths.size >= 25, 'знайдено поля форми: ' + paths.size);
    for (const path of paths) assert.ok(ttnHint(path), 'немає підказки: ' + path);
    // Усі рядки вантажу й службові ключі.
    for (const key of ['cargo_name', 'unit', 'places', 'price', 'amount', 'packaging', 'gross_t', 'owner_price', 'bulk', 'docs', 'temperature', 'animal_id', 'animal_kind']) {
        assert.ok(TTN_HINTS['line.' + key], 'рядок вантажу: ' + key);
    }
    for (const key of ['client', 'doc_date', 'number', 'vehicle_pick', 'driver_pick', 'trailer_pick', 'op_gross', 'op_tare', 'op_net', 'op_arrival', 'op_departure', 'op_idle']) assert.ok(TTN_HINTS[key], key);
    for (const [key, text] of Object.entries(TTN_HINTS)) {
        assert.ok(text.length > 10 && text.length < 220, key);
        assert.doesNotMatch(text, /<|>/, key + ': без розмітки');
    }
});

test('форма: підказки підключено до кожного поля рядка вантажу, операцій і шапки; без innerHTML', () => {
    assert.match(form, /import \{ fieldHint, withHint \} from '..\/lib\/field-hint\.js'/);
    assert.match(form, /return withHint\(input, attrs\['aria-label'\]\.replace/, 'поля рядка вантажу');
    assert.match(form, /fieldHint\(label, ttnHint\('line\.' \+ key\)\)/, 'чекбокси ОЦВТ / насип');
    assert.match(form, /ttnHint\(hintKey\)/, 'операції');
    for (const key of ['vehicle_pick', 'driver_pick', 'trailer_pick', 'doc_date', 'number', 'client']) assert.ok(form.includes("ttnHint('" + key + "')"), key);
    assert.doesNotMatch(form + read('src/lib/field-hint.js'), /innerHTML/);
    for (const key of ['cargo_name', 'unit', 'places', 'price', 'amount', 'packaging', 'gross_t', 'docs', 'temperature', 'animal_id', 'animal_kind']) {
        assert.ok(new RegExp("bind\\('" + key + "'").test(form), 'рядок вантажу має поле ' + key);
    }
});
