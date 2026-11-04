// Полірування вікон Контроль+: шкала z-index (діалог над вікном), «брудна» форма лише при реальних змінах, зміна розміру з мінімумом,
// розмір у sessionStorage, авто / причіп / водій вікнами, футер лише в налаштуваннях і тарифі, сторно ремонту, форма рахунку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIN_H, MIN_W, WIN_Z_BASE, clampRect, formSnapshot, parseWindows, resizeRect, serializeWindows } from '../src/lib/windows-core.js';
import { cardParentHash, parseCrmHash, tabOf, windowSpecOf } from '../src/lib/route.js';
import { createWindowManager } from '../src/kp-windows.js';
import { repairCopyData } from '../src/views/repairs-form.js';
import { VAT_MODES } from '../src/lib/docs.js';
import { slotCss, winCss } from '../scripts/gen-slot-css.mjs';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const UUID = '0b6f6a52-2a4e-4a52-9a43-1d9d6f0d1c11';

// ---- мінімальний DOM (як у kp-windows.test.mjs) ----
class FNode {}
class FEl extends FNode {
    constructor(tag) {
        super();
        this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.dataset = {}; this.className = ''; this.hidden = false; this.style = {};
        this.innerHTML = ''; this.textContent = ''; this.title = ''; this.listeners = {}; this.parent = null; this.id = '';
        const set = new Set();
        this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => ((on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c)) };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'id') this.id = String(v); if (k === 'title') this.title = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    fire(t, e = {}) { (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, ...e })); }
    append(...nodes) { for (const n of nodes) { if (Array.isArray(n)) { this.append(...n); continue; } if (n instanceof FNode) { n.parent = this; this.children.push(n); } else this.children.push({ text: String(n) }); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    querySelector() { return null; }
    closest(sel) { return sel === 'button' && this.tagName === 'BUTTON' ? this : null; }
    all(cls) { const out = []; const walk = (e) => { for (const c of e.children) if (c instanceof FEl) { if ((' ' + c.className + ' ').includes(' ' + cls + ' ')) out.push(c); walk(c); } }; walk(this); return out; }
}

function setup({ width = 1366, height = 768 } = {}) {
    const body = new FEl('body');
    const byId = { 'kp-shell-side': Object.assign(new FEl('aside'), { offsetWidth: 232 }), 'kp-shell-top': Object.assign(new FEl('header'), { getBoundingClientRect: () => ({ bottom: 52 }) }) };
    const doc = {
        documentElement: { dataset: { app: 'kp' } }, body, listeners: {}, modal: false,
        getElementById: (id) => byId[id] || null,
        querySelector: (sel) => (sel === '.tc-modal' && doc.modal ? {} : null),
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        createElement: (t) => new FEl(t), createTextNode: (t) => ({ text: t }),
    };
    const store = new Map();
    const win = {
        location: { hash: '', pathname: '/', search: '' }, innerWidth: width, innerHeight: height, listeners: {},
        matchMedia: () => ({ matches: true }),
        history: { replaceState() {} },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); },
        emit(t, e) { (this.listeners[t] || []).slice().forEach((fn) => fn(e)); },
    };
    const confirms = [];
    const answer = { ok: true };
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    const env = { document: doc, window: win, storage, confirm: async (o) => { confirms.push(o); return { ok: answer.ok }; }, notify: () => {} };
    return { doc, win, body, store, confirms, answer, env };
}
async function withDom(fn) {
    const saved = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), Node: Object.getOwnPropertyDescriptor(globalThis, 'Node') };
    Object.defineProperty(globalThis, 'document', { value: { createElement: (t) => new FEl(t), createTextNode: (t) => ({ text: t }) }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Node', { value: FNode, configurable: true, writable: true });
    try { return await fn(); } finally {
        for (const [key, desc] of Object.entries(saved)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
    }
}
const spec = (n, extra = {}) => ({ type: 'doc', id: 'id' + n, key: 'doc:id' + n, title: 'Рахунок № ' + n, build: () => {}, ...extra });
const formSpec = (type, extra = {}) => ({ type, id: '', key: type + ':new', title: 'Форма', build: () => {}, ...extra });
// Поля форми для знімка: { type, value, checked }.
const fakeFields = (...fields) => ({ querySelectorAll: () => fields });

// ---- 1. Шкала z-index і діалог над вікном ----
test('z-index: діалог, тости й випадні списки вищі за вікна, панель задач і меню; фон діалогу напівпрозорий', () => {
    const shell = read('src/kp-shell.css');
    const vars = Object.fromEntries([...shell.matchAll(/--kp-z-([a-z]+): (\d+);/g)].map((m) => [m[1], Number(m[2])]));
    assert.equal(vars.win, WIN_Z_BASE, 'база вікон у CSS = WIN_Z_BASE у JS');
    const topWindow = WIN_Z_BASE + 7; // ліміт 8 вікон
    assert.ok(topWindow < vars.top && vars.top <= vars.strip && vars.taskbar <= vars.side, 'вікна нижче верхньої панелі, панелі задач і меню');
    assert.ok(vars.side < vars.dropdown && vars.dropdown < vars.scrim && vars.scrim < vars.modal && vars.modal < vars.toast, 'меню < списки < фон діалогу < діалог < тости');
    const css = read('src/kp-windows.css');
    assert.match(css, /body\.kp-shell-on \.tc-modal \{[^}]*z-index: var\(--kp-z-modal\)[^}]*background: var\(--kp-scrim\)/);
    assert.match(css, /body\.kp-shell-on #kp-toast[^{]*\{ z-index: var\(--kp-z-toast\)/);
    const alpha = /--kp-scrim: rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(shell);
    assert.ok(alpha && Number(alpha[1]) > 0 && Number(alpha[1]) < 0.7, 'фон напівпрозорий, не чорний на весь екран');
    // Усе, що в KP стоїть на фіксованих числах z-index, бере їх зі шкали.
    assert.equal(/z-index: (3090|3095|3100)\b/.test(shell + css), false, 'без «магічних» чисел шару');
});

test('діалог закриття: «Закрити» — небезпечна дія, «Скасувати» — другорядна; Esc = «Скасувати»', async () => {
    const css = read('src/kp-windows.css');
    assert.match(css, /\.tc-modal \.tc-modal-actions \.btn\.btn-danger \{ background: var\(--negative\)/);
    assert.match(css, /\.tc-modal \.tc-modal-actions \.btn \{[^}]*background: transparent/, '«Скасувати» без заливки');
    const site = read('../../index.html');
    assert.match(site, /if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); finish\(false\); \}/, 'Esc у діалозі сайту = скасувати');
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        m.open(formSpec('form', { key: 'form:a', id: '#/docs/new/act' }));
        const w = m.get('form:a');
        const field = { type: 'text', value: '' };
        w.bodyEl.querySelectorAll = fakeFields(field).querySelectorAll;
        w.bodyEl.fire('keydown', {});
        field.value = 'ТОВ Агро';
        w.bodyEl.fire('input', { target: { tagName: 'INPUT' } });
        await m.close('form:a');
        assert.equal(e.confirms.length, 1);
        assert.deepEqual([e.confirms[0].title, e.confirms[0].confirmText, e.confirms[0].danger], ['Закрити вікно?', 'Закрити', true]);
    });
});

// ---- 2. «Брудна» форма: лише реальні зміни ----
test('«брудна» форма: відкрив і закрив — без питання; зміна — питає; повернув значення — знову без питання', async () => {
    await withDom(async () => {
        for (const type of ['form', 'client_form', 'vehicle', 'trailer', 'driver']) {
            const e = setup();
            const m = createWindowManager(e.env);
            m.open(formSpec(type));
            const w = m.get(type + ':new');
            const field = { type: 'text', value: 'Іван' };
            w.bodyEl.querySelectorAll = fakeFields(field).querySelectorAll;
            // Просто відкрив і закрив.
            assert.equal(m.list()[0].dirty, false, type);
            // Клік по формі без змін (знімок береться перед дією) — теж не брудна.
            w.bodyEl.fire('pointerdown', {});
            w.bodyEl.fire('input', { target: { tagName: 'INPUT' } });
            assert.equal(m.list()[0].dirty, false, type + ': значення не змінилось');
            // Реальна зміна.
            field.value = 'Іван П.';
            w.bodyEl.fire('input', { target: { tagName: 'INPUT' } });
            assert.equal(m.list()[0].dirty, true, type + ': змінено');
            // Повернув як було.
            field.value = 'Іван';
            assert.equal(m.list()[0].dirty, false, type + ': повернув значення');
            assert.equal(await m.close(type + ':new'), true);
            assert.equal(e.confirms.length, 0, type + ': без діалогу');
        }
    });
});

test('автозаповнення (події від скрипта, не від користувача) не робить форму брудною: нова фактура з вибором клієнта, акт, ТТН, подорожній лист', async () => {
    await withDom(async () => {
        for (const [type, id] of [['form', '#/docs/new/invoice'], ['form', '#/docs/new/act'], ['form', '#/docs/new/ttn'], ['form', '#/docs/new/trip_sheet']]) {
            const e = setup();
            const m = createWindowManager(e.env);
            m.open(formSpec(type, { key: type + ':' + id, id }));
            const w = m.get(type + ':' + id);
            const client = { type: 'select-one', value: '' };
            const due = { type: 'date', value: '' };
            w.bodyEl.querySelectorAll = fakeFields(client, due).querySelectorAll;
            // Форма сама підставила клієнта з рейсу й строк оплати та продиспатчила change (isTrusted = false).
            client.value = UUID; due.value = '2026-11-10';
            w.bodyEl.fire('change', { target: { tagName: 'SELECT' }, isTrusted: false });
            assert.equal(m.list()[0].dirty, false, id + ': автозаповнення');
            assert.equal(await m.close(w.key), true);
            assert.equal(e.confirms.length, 0, id);
        }
        // Користувач потім обрав іншого клієнта — це справжня зміна.
        const e = setup();
        const m = createWindowManager(e.env);
        m.open(formSpec('form', { key: 'form:x', id: '#/docs/new/invoice' }));
        const w = m.get('form:x');
        const client = { type: 'select-one', value: UUID };
        w.bodyEl.querySelectorAll = fakeFields(client).querySelectorAll;
        w.bodyEl.fire('pointerdown', {});
        client.value = '1c2d3e4f-0000-4000-8000-000000000001';
        w.bodyEl.fire('change', { target: { tagName: 'SELECT' } });
        assert.equal(m.list()[0].dirty, true);
        e.answer.ok = false;
        assert.equal(await m.close('form:x'), false);
        assert.equal(e.confirms.length, 1);
    });
});

test('formSnapshot: значення полів, галочки; файли ігноруються; без DOM — null', () => {
    assert.equal(formSnapshot(null), null);
    assert.equal(formSnapshot({}), null);
    const a = formSnapshot(fakeFields({ type: 'text', value: 'a' }, { type: 'checkbox', checked: true, value: 'on' }, { type: 'file', value: 'C:\\x.png' }));
    const b = formSnapshot(fakeFields({ type: 'text', value: 'a' }, { type: 'checkbox', checked: false, value: 'on' }));
    assert.notEqual(a, b);
    assert.equal(a, formSnapshot(fakeFields({ type: 'text', value: 'a' }, { type: 'checkbox', checked: true, value: 'on' })));
    // Пошук і елементи з data-no-dirty (фільтри, вибір рейсів) у знімок не входять.
    const filtered = { type: "text", value: "x", closest: (sel) => (sel === "[data-no-dirty]" ? {} : null) };
    assert.equal(formSnapshot(fakeFields({ type: "text", value: "a" }, { type: "search", value: "знайти" }, filtered)), formSnapshot(fakeFields({ type: "text", value: "a" })));
});

// ---- 4. Зміна розміру ----
const BOUNDS = { left: 232, top: 52, right: 1366, bottom: 736 };
test('resizeRect: мінімум 480×320, протилежний край стоїть, не виходить за робочу область; усі 8 напрямів', () => {
    const start = { x: 400, y: 200, w: 700, h: 400 };
    const r = (dir, dx, dy) => resizeRect(start, dir, dx, dy, BOUNDS);
    assert.deepEqual(r('e', 50, 0), { x: 400, y: 200, w: 750, h: 400 });
    assert.deepEqual(r('s', 0, 30), { x: 400, y: 200, w: 700, h: 430 });
    assert.deepEqual(r('w', -40, 0), { x: 360, y: 200, w: 740, h: 400 });
    assert.deepEqual(r('n', 0, -20), { x: 400, y: 180, w: 700, h: 420 });
    assert.deepEqual(r('se', 10, 10), { x: 400, y: 200, w: 710, h: 410 });
    assert.deepEqual(r('nw', -10, -10), { x: 390, y: 190, w: 710, h: 410 });
    assert.deepEqual(r('ne', 20, -20), { x: 400, y: 180, w: 720, h: 420 });
    assert.deepEqual(r('sw', -20, 20), { x: 380, y: 200, w: 720, h: 420 });
    // Мінімум: тягнемо далеко всередину — розмір 480×320, протилежний край (права / нижня) на місці.
    const small = r('nw', 900, 900);
    assert.deepEqual([small.w, small.h], [MIN_W, MIN_H]);
    assert.equal(small.x + small.w, 1100);
    assert.equal(small.y + small.h, 600);
    const small2 = r('se', -900, -900);
    assert.deepEqual([small2.x, small2.y, small2.w, small2.h], [400, 200, MIN_W, MIN_H]);
    // Межі: не далі за робочу область (праворуч / внизу / зліва / зверху).
    assert.equal(r('e', 5000, 0).x + r('e', 5000, 0).w, BOUNDS.right);
    assert.equal(r('s', 0, 5000).y + r('s', 0, 5000).h, BOUNDS.bottom);
    assert.equal(r('w', -5000, 0).x, BOUNDS.left);
    assert.equal(r('n', 0, -5000).y, BOUNDS.top);
    assert.deepEqual([MIN_W, MIN_H], [480, 320]);
});

test('clampRect: розмір не менший за мінімум і не більший за область; позиція в межах', () => {
    assert.deepEqual(clampRect({ x: -50, y: 9000, w: 100, h: 100 }, BOUNDS), { x: BOUNDS.left, y: BOUNDS.bottom - MIN_H, w: MIN_W, h: MIN_H });
    const big = clampRect({ x: 0, y: 0, w: 9000, h: 9000 }, BOUNDS);
    assert.deepEqual([big.x, big.y, big.w, big.h], [BOUNDS.left, BOUNDS.top, BOUNDS.right - BOUNDS.left, BOUNDS.bottom - BOUNDS.top]);
});

test('вікно: 8 ручок (4 краї + 4 кути), ресайз мишею, мін. розмір, розгорнуте не ресайзиться, «відновити» повертає розмір', async () => {
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        await m.setScope('o', 'u', () => null);
        m.open(spec(1));
        const w = m.get('doc:id1');
        const handles = w.el.all('kp-win-rs');
        assert.deepEqual(handles.map((x) => x.getAttribute('data-dir')).sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
        const handle = (dir) => handles.find((x) => x.getAttribute('data-dir') === dir);
        const before = { x: w.x, y: w.y, w: w.w, h: w.h };
        handle('se').fire('pointerdown', { clientX: 1000, clientY: 600, button: 0 });
        e.win.emit('pointermove', { clientX: 1030, clientY: 640 });
        assert.deepEqual([w.w, w.h], [before.w + 30, before.h + 40]);
        assert.equal(w.el.style.width, w.w + 'px');
        e.win.emit('pointermove', { clientX: -5000, clientY: -5000 });
        assert.deepEqual([w.w, w.h], [MIN_W, MIN_H], 'мінімальний розмір');
        e.win.emit('pointerup', {});
        // Позиція й розмір запам'ятовуються в тому самому стані вікон.
        handle('nw').fire('pointerdown', { clientX: 300, clientY: 100, button: 0 });
        e.win.emit('pointermove', { clientX: 280, clientY: 90 });
        e.win.emit('pointerup', {});
        const stored = JSON.parse(e.store.get('tc_kp_windows:o:u'));
        assert.deepEqual([stored[0].x, stored[0].y, stored[0].w, stored[0].h], [w.x, w.y, w.w, w.h]);
        // Розгорнуте вікно не ресайзиться; після «відновити» повертається попередній розмір.
        const rect = { x: w.x, y: w.y, w: w.w, h: w.h };
        w.maxBtn.fire('click');
        assert.equal(w.maximized, true);
        handle('e').fire('pointerdown', { clientX: 1000, clientY: 300, button: 0 });
        e.win.emit('pointermove', { clientX: 1100, clientY: 300 });
        assert.deepEqual({ x: w.x, y: w.y, w: w.w, h: w.h }, rect, 'розгорнуте не змінює розмір');
        w.maxBtn.fire('click');
        assert.equal(w.maximized, false);
        assert.deepEqual({ x: w.x, y: w.y, w: w.w, h: w.h }, rect);
        assert.equal(w.el.style.width, rect.w + 'px');
        // Відновлення після перезавантаження: розмір, позиція і «розгорнуте».
        w.maxBtn.fire('click');
        const e2 = setup();
        e2.store.set('tc_kp_windows:o:u', e.store.get('tc_kp_windows:o:u'));
        const m2 = createWindowManager(e2.env);
        await m2.setScope('o', 'u', (item) => ({ type: item.type, id: item.id, key: item.type + ':' + item.id, title: 'T', build: () => {} }));
        const r2 = m2.get('doc:id1');
        assert.equal(r2.maximized, true);
        assert.deepEqual({ x: r2.x, y: r2.y, w: r2.w, h: r2.h }, rect);
    });
});

test('стан вікон: розмір і позиція серіалізуються, сміття відкидається', () => {
    const raw = serializeWindows([{ type: 'doc', id: 'a', minimized: false, maximized: true, x: 10.4, y: 20, w: 600, h: 400 }]);
    assert.deepEqual(JSON.parse(raw), [{ type: 'doc', id: 'a', minimized: false, max: true, x: 10, y: 20, w: 600, h: 400 }]);
    assert.deepEqual(parseWindows(raw)[0], { type: 'doc', id: 'a', minimized: false, max: true, x: 10, y: 20, w: 600, h: 400 });
    assert.equal('x' in parseWindows(JSON.stringify([{ type: 'doc', id: 'a', x: 1, y: 2, w: -5, h: 4 }]))[0], false);
    assert.equal('w' in parseWindows(JSON.stringify([{ type: 'doc', id: 'a', x: 1, y: 2, w: 1e9, h: 4 }]))[0], false);
});

// ---- 5. Авто, причепи, водії — вікнами ----
test('маршрути #/fleet/car/<id|new>, #/fleet/trailer/<id|new>, #/drivers/<id|new> відкриваються вікнами без дублів', async () => {
    const car = parseCrmHash('#/fleet/car/' + UUID);
    assert.deepEqual(car, { view: 'fleet-card', kind: 'vehicle', id: UUID });
    assert.deepEqual(windowSpecOf(car, ''), { type: 'vehicle', id: UUID, key: 'vehicle:' + UUID });
    assert.deepEqual(windowSpecOf(parseCrmHash('#/fleet/car/new'), ''), { type: 'vehicle', id: '', key: 'vehicle:new' });
    assert.deepEqual(windowSpecOf(parseCrmHash('#/fleet/trailer/' + UUID), ''), { type: 'trailer', id: UUID, key: 'trailer:' + UUID });
    assert.deepEqual(windowSpecOf(parseCrmHash('#/drivers/new'), ''), { type: 'driver', id: '', key: 'driver:new' });
    assert.deepEqual(windowSpecOf(parseCrmHash('#/drivers/' + UUID), ''), { type: 'driver', id: UUID, key: 'driver:' + UUID });
    assert.equal(parseCrmHash('#/fleet/car/not-a-uuid'), null);
    assert.equal(parseCrmHash('#/drivers/xyz'), null);
    assert.deepEqual([parseCrmHash('#/fleet'), parseCrmHash('#/fleet/trailers'), parseCrmHash('#/drivers')].map((r) => r.view), ['fleet', 'fleet', 'drivers'], 'списки лишились сторінками');
    assert.deepEqual([tabOf(car), tabOf(parseCrmHash('#/drivers/new'))], ['fleet', 'drivers']);
    assert.deepEqual([cardParentHash(car), cardParentHash(parseCrmHash('#/fleet/trailer/new')), cardParentHash(parseCrmHash('#/drivers/new')), cardParentHash(parseCrmHash('#/clients'))], ['#/fleet', '#/fleet/trailers', '#/drivers', null]);
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        const base = windowSpecOf(car, '');
        assert.equal(m.open({ ...base, title: 'Авто', build: () => {} }).ok, true);
        assert.equal(m.open({ ...base, title: 'Авто', build: () => {} }).existing, true);
        assert.equal(m.count(), 1, 'те саме авто двічі — одне вікно');
        // Dirty-check діє на вікнах авто / причепа / водія.
        const w = m.get(base.key);
        const field = { type: 'text', value: 'AA 1111 AA' };
        w.bodyEl.querySelectorAll = fakeFields(field).querySelectorAll;
        w.bodyEl.fire('keydown', {});
        field.value = 'AA 2222 AA';
        w.bodyEl.fire('input', { target: { tagName: 'INPUT' } });
        e.answer.ok = false;
        assert.equal(await m.close(base.key), false);
        assert.equal(e.confirms.length, 1);
    });
});

test('реєстр: рядок і «Додати» відкривають вікно за hash; без вікон — картка у списку, як раніше; список перечитується після збереження', () => {
    const reg = read('src/views/registry.js');
    assert.match(reg, /window\.kpWindowsOn\(\)/);
    assert.match(reg, /app\.go\(cfg\.windowHash\(row\)\)/);
    assert.match(reg, /kp:registry-changed/);
    assert.match(reg, /back \? h\('button'/, 'у вікні немає «← До списку»');
    const fleet = read('src/views/fleet.js');
    assert.match(fleet, /windowHash: \(row\) => \(trailerTab \? '#\/fleet\/trailer\/' : '#\/fleet\/car\/'\) \+ \(row \? row\.id : 'new'\)/);
    assert.match(read('src/views/drivers.js'), /windowHash: \(row\) => '#\/drivers\/' \+ \(row \? row\.id : 'new'\)/);
    const bridge = read('src/bridge.js');
    assert.match(bridge, /renderFleetCardWindow\(a, type, id \|\| null\)/);
    assert.match(bridge, /renderDriverCardWindow\(a, id \|\| null\)/);
    assert.match(bridge, /closeWindow: \(changed\) => ctl\.close\(\{ force: true \}\)/);
    assert.match(bridge, /vehicle: 'Авто', trailer: 'Причіп', driver: 'Водій'/);
    // Форма компактна: поля 30px / 13px, короткі поля по два в ряд.
    const css = read('src/kp-windows.css');
    assert.match(css, /select \{ height: 30px; min-height: 30px;[^}]*font-size: 13px/);
    assert.match(css, /\.kpc-body \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

// ---- 2/3/6. Кнопки, реквізити, форма рахунку ----
test('вікна беруть стилі розділу: kp-win-scope.css згенеровано з crm.css (npm run gen:slot-css), кнопки 28px / 13px без підкреслення', () => {
    assert.equal(read('src/kp-win-scope.css'), winCss(read('src/crm.css')));
    assert.equal(read('src/cabinet-slot.css'), slotCss(read('src/crm.css')));
    const scope = read('src/kp-win-scope.css');
    assert.ok(scope.includes('body.kp-shell-on .kp-win .btn {'));
    assert.ok(scope.includes('body[data-theme="dark"].kp-shell-on .kp-win {'), 'темна тема вікна');
    assert.equal(/#kp-crm|#main-app|#kp-side/.test(scope), false);
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-win-scope\.css';\nimport '\.\/kp-windows\.css';/);
    const css = read('src/kp-windows.css');
    assert.match(css, /\.kp-win-body \.btn,[^{]*a\.btn \{[^}]*height: 28px;[^}]*font-size: 13px;[^}]*text-decoration: none/);
    assert.match(css, /\.actions,[^{]*\.kpc-actions \{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px/);
    assert.match(css, /\.btn\.btn-danger \{ color: var\(--negative\)/);
    assert.match(css, /\.kp-act-end \{[^}]*margin-left: auto/);
    assert.match(css, /\.actions > \.check,[^{]*\{ margin: 0 6px/);
    // Кольори — лише змінні (білий-лейбл): жодного hex у правилах вмісту вікон, окрім запасних значень у var().
    const content = css.slice(css.indexOf('Вміст вікон'), css.indexOf('Вікно «Заявка»'));
    assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(content.replace(/var\([^)]*\)/g, '')), false, 'кольори вмісту лише через var()');
    const client = read('src/views/client-card.js');
    assert.match(client, /h\('a', \{ class: 'btn btn-primary', href: '#\/docs\/new\/invoice\/'/, 'одна основна дія');
    assert.equal((client.match(/class: 'btn btn-primary'/g) || []).length, 1);
    assert.match(client, /h\('span', \{ class: 'kp-act-end' \}/, '«В архів» і «Видалити» — окремо');
});

test('реквізити: «назва: значення» у два стовпчики (назва 12px muted), у вузькому вікні — в один', () => {
    const css = read('src/kp-windows.css');
    assert.match(css, /\.kv,[^{]*\{\s*display: grid; grid-template-columns: minmax\(110px, 190px\) minmax\(0, 1fr\)/);
    assert.match(css, /\.kv dt,[^{]*\{[^}]*font-size: 12px;[^}]*color: var\(--muted\)/);
    assert.match(css, /container: kpwin \/ inline-size/);
    assert.match(css, /@container kpwin \(max-width: 640px\) \{[^}]*\.kv[^}]*grid-template-columns: minmax\(0, 1fr\) !important/);
});

test('форма рахунку / акта: ПДВ-сегмент із двох кнопок, таблиця рядків зі смітничком, підсумки окремими рядками, «Рейси клієнта» в один ряд', () => {
    assert.deepEqual(VAT_MODES.map((m) => m.short), ['Без ПДВ, +20% зверху', 'ПДВ всередині ціни']);
    const src = read('src/views/docs-form.js');
    assert.match(src, /m\.short \|\| m\.label/);
    for (const part of ["h('table', { class: 'table kpd-lines-table' }", "h('th', { class: 'kpd-c-title' }, 'Найменування')", "'Од.'", "'К-сть'", "'Ціна'", "'Сума'",
        "title: 'Видалити рядок'", "class: 'btn btn-ghost kpd-del'", "h('tr', { class: 'kpd-line-hint' }", "'Рядок повʼязаний з рейсом",
        "h('label', { class: 'kpd-f' }, 'з', tripsFrom)", "h('label', { class: 'kpd-f' }, 'по', tripsTo)", "'Показати рейси'", 'totalRows(']) assert.ok(src.includes(part), part);
    const totals = read('src/views/docs-totals.js');
    for (const part of ["'Без ПДВ'", "'Разом'", "'Всього'", 'kpd-total-row', 'kpd-total-label', 'kpd-total-value']) assert.ok(totals.includes(part), part);
    assert.match(read('src/views/docs-card.js'), /totalRows\(\{ vat,/, 'картка документа — ті самі підсумки');
    // База — crm.css (її бере і сторінка, і вікно через згенерований kp-win-scope.css); вузький екран — рядок-картка.
    const crm = read('src/crm.css');
    assert.match(crm, /#kp-crm \.kpd-total-row \{ display: grid; grid-template-columns: minmax\(80px, auto\) minmax\(110px, auto\); column-gap: 16px/);
    assert.match(crm, /#kp-crm \.kpd-link-hint \{[^}]*font-size: 11px[^}]*color: var\(--muted\)/);
    assert.match(crm, /#kp-crm \.kpd-lines-table thead th \{ padding: 4px 6px;/, 'шапка таблиці з відступами');
    assert.match(crm, /@media \(max-width: 767px\) \{[\s\S]*#kp-crm \.kpd-lines-table thead \{ display: none; \}[\s\S]*\.kpd-row \{ display: grid/);
    assert.equal(/\.kpd-line\b[^-]/.test(crm), false, 'старий grid-рядок .kpd-line прибрано');
    assert.ok(read('src/kp-win-scope.css').includes('body.kp-shell-on .kp-win .kpd-lines-table'), 'вікно бере ті самі правила');
    const css = read('src/kp-windows.css');
    assert.match(css, /\.segmented button\.is-on,[^{]*\{ background: var\(--accent\); color: var\(--on-accent\)/);
});

// ---- 7. Ремонти, сторно ----
test('сторнований ремонт: приглушений рядок, закреслена сума, плашка «сторно» з title, «Створити копію»; «Скасувати сторно» не робимо (потрібна міграція)', () => {
    const src = read('src/views/repairs.js');
    assert.match(src, /const VOID_TITLE = 'Ремонт сторновано, не враховується у витратах'/);
    assert.match(src, /class: r\.status === 'void' \? 'is-archived is-void' : ''/);
    assert.match(src, /h\('span', \{ class: 'tag kpr-void-tag', title: VOID_TITLE \}, 'сторно'\)/);
    assert.match(src, /h\('s', \{ class: 'kpr-void-sum', title: VOID_TITLE \}/);
    assert.match(src, /access\.canWrite && r\.status === 'void'[\s\S]*?'Створити копію'/, 'за правами з lib/repairs.js (canWrite)');
    assert.equal(/'Скасувати сторно'|kp_repair_unvoid|kp_repair_restore/.test(src), false);
    assert.match(read('src/crm.css'), /#kp-crm \.kpr-void-sum \{ text-decoration: line-through/);
    assert.match(read('src/crm.css'), /#kp-crm \.is-void \{ opacity: /);
    const copy = repairCopyData({
        vehicle_id: 'v1', works: 'Заміна масла', provider: 'СТО', service_cost: '1200.00', odometer_km: 100500, repair_date: '2026-10-20',
        parts: [{ part_id: 'p1', qty: '2.000', name: 'Масло' }, { part_id: null, qty: 1 }, { part_id: 'p2', qty: 0 }],
    });
    assert.deepEqual(copy, { vehicle_id: 'v1', works: 'Заміна масла', provider: 'СТО', service_cost: '1200.00', lines: [{ part_id: 'p1', qty: '2.000' }], from: '2026-10-20' });
    assert.equal('odometer' in copy, false, 'одометр вносять заново');
    assert.equal(repairCopyData(null), null);
    const form = read('src/views/repairs-form.js');
    assert.match(form, /value: kyivDate\(\), max: kyivDate\(\)/, 'дата — сьогодні');
    assert.match(form, /setRepairCopy/);
    assert.match(read('src/views/repairs.js'), /app\.go\('#\/repairs\/new'\)/);
});

test('ремонти: той самий каркас сторінки й відступи таблиці, що й в інших розділах (kpr-page kpg-page, kpg-table)', () => {
    const src = read('src/views/repairs.js');
    assert.match(src, /h\('section', \{ class: 'page kpr-page kpg-page' \}/);
    for (const file of ['repairs.js', 'repairs-stock.js', 'repairs-maintenance.js']) {
        const text = read('src/views/' + file);
        assert.equal(/h\('table', \{ class: 'table' \}/.test(text), false, file);
        assert.match(text, /class: 'table kpg-table'/, file);
    }
});

// ---- 8. Футер ----
test('футер з офертою прибрано з розділів КП; лишився в налаштуваннях, на тарифі й оплаті; сайт не змінено', () => {
    const shell = read('src/kp-shell.css');
    assert.match(shell, /body\.kp-shell-on #main-app > \.tc-legal-footer \{ display: none; \}/);
    const rules = (shell + read('src/kp-windows.css') + read('src/crm.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/#cabinet-screen[^{]*tc-legal-footer[^{]*\{[^}]*display: none/.test(rules), false, 'у налаштуваннях футер видно');
    const site = read('../../index.html');
    // Футер у «Налаштуваннях» (#cabinet-screen) і слот футера для тарифу / оплати лишаються в розмітці сайту.
    assert.match(site, /<footer class="tc-legal-footer">/);
    assert.match(site, /id="billing-footer-slot"/);
    assert.match(site, /#cabinet-screen \.tc-legal-footer \{ margin-top: 18px; \}/);
    assert.match(site, /#main-app > \.tc-legal-footer \{ grid-column: 1 \/ -1; margin-top: 18px; \}/, 'правило сайту не чіпали');
    assert.equal(/kp-shell-on|data-app="kp"/.test(site.split('<footer class="tc-legal-footer">')[0].slice(-200)), false);
});
