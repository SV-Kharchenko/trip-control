// Менеджер вікон Контроль+ (PR 3 з 5): ліміт, дедуплікація, Esc, панель задач, «брудна» форма, sessionStorage, Back, XSS, перетягування.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_WINDOWS, backTarget, cleanTitle, clampPos, escHtml, iconFor, initialRect, parseWindows, serializeWindows, shortLabel, storageKey } from '../src/lib/windows-core.js';
import { isWindowRoute, parseCrmHash, windowSpecOf } from '../src/lib/route.js';
import { createWindowManager, isKpApp } from '../src/kp-windows.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

// ---- мінімальний DOM ----
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
    fire(t, e = {}) { (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() { this.prevented = true; }, ...e })); }
    append(...nodes) { for (const n of nodes) { if (Array.isArray(n)) { this.append(...n); continue; } if (n instanceof FNode) { n.parent = this; this.children.push(n); } else this.children.push({ text: String(n) }); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.removed = true; }
    querySelector() { return null; }
    closest(sel) { return sel === 'button' && this.tagName === 'BUTTON' ? this : null; }
    all(cls) { const out = []; const walk = (e) => { for (const c of e.children) if (c instanceof FEl) { if ((' ' + c.className + ' ').includes(' ' + cls + ' ')) out.push(c); walk(c); } }; walk(this); return out; }
}

function setup({ kp = true, wide = true, height = 800, width = 1280, hash = '' } = {}) {
    const body = new FEl('body');
    const byId = { 'kp-shell-side': Object.assign(new FEl('aside'), { offsetWidth: 232 }), 'kp-shell-top': Object.assign(new FEl('header'), { getBoundingClientRect: () => ({ bottom: 52 }) }) };
    const doc = {
        documentElement: { dataset: kp ? { app: 'kp' } : {} }, body, listeners: {}, modal: false,
        getElementById: (id) => byId[id] || null,
        querySelector: (sel) => (sel === '.tc-modal' && doc.modal ? {} : null),
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        createElement: (t) => new FEl(t), createTextNode: (t) => ({ text: t }),
    };
    const store = new Map();
    const replaced = [];
    const win = {
        location: { hash, pathname: '/', search: '' }, innerWidth: width, innerHeight: height, listeners: {},
        matchMedia: () => ({ matches: wide }),
        history: { replaceState(_s, _t, url) { replaced.push(url); win.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); },
    };
    const confirms = [];
    const notes = [];
    let answer = true;
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    const env = { document: doc, window: win, storage, confirm: async (o) => { confirms.push(o); return { ok: answer }; }, notify: (t) => notes.push(t) };
    return { doc, win, body, store, replaced, confirms, notes, env, byId, setAnswer: (v) => { answer = v; }, esc: () => doc.listeners.keydown.forEach((fn) => fn({ key: 'Escape', defaultPrevented: false })) };
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
const tick = () => new Promise((r) => setImmediate(r));

test('без isKP() менеджер вікон не ініціалізується й не торкається DOM', async () => {
    const e = setup({ kp: false });
    let touched = 0;
    e.doc.body = new Proxy({}, { get() { touched += 1; return undefined; } });
    assert.equal(isKpApp(e.doc), false);
    assert.equal(createWindowManager(e.env), null);
    assert.equal(touched, 0);
    assert.equal(createWindowManager({ document: { documentElement: {} }, window: {} }), null);
    // Підключення до застосунку: лише з каркасу Контроль+ (bridge.js), сайт цього модуля не вантажить.
    assert.match(read('src/bridge.js'), /windows = createWindowManager\(/);
    assert.equal(/kp-windows/.test(fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')), false);
});

test('відкриття: дубль не створюється (фокус на наявному), ліміт 8, активне вікно зверху', async () => {
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        assert.equal(m.open(spec(1)).ok, true);
        const again = m.open(spec(1));
        assert.equal(again.ok && again.existing, true);
        assert.equal(m.count(), 1, 'повторне відкриття того самого документа — без дубля');
        for (let i = 2; i <= MAX_WINDOWS; i += 1) assert.equal(m.open(spec(i)).ok, true);
        assert.equal(m.count(), MAX_WINDOWS);
        const refused = m.open(spec(99));
        assert.deepEqual([refused.ok, refused.reason], [false, 'limit']);
        assert.equal(m.count(), 8);
        assert.match(e.notes[0], /максимум 8/);
        // Фокус підносить вікно: його z-index найбільший і воно активне.
        m.focus('doc:id3');
        assert.equal(m.active(), 'doc:id3');
        const z = (k) => Number(m.get(k).el.style.zIndex);
        assert.ok(['doc:id1', 'doc:id2', 'doc:id4', 'doc:id8'].every((k) => z(k) < z('doc:id3')));
        // Повторне відкриття сфокусованого іншого вікна теж підносить його.
        m.open(spec(5));
        assert.equal(m.active(), 'doc:id5');
        assert.equal(Math.max(...m.list().map((w) => z(w.key))), z('doc:id5'));
    });
});

test('Esc закриває активне вікно (не чіпає, коли відкрито діалог); перемикання згортання на панелі задач', async () => {
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        m.open(spec(1)); m.open(spec(2));
        // Діалог відкрито (tcModal) → Esc закриває лише його.
        e.doc.modal = true; e.esc(); await tick();
        assert.equal(m.count(), 2);
        e.doc.modal = false;
        e.esc(); await tick();
        assert.deepEqual(m.list().map((w) => w.key), ['doc:id1'], 'закрито активне (верхнє) вікно');
        e.esc(); await tick();
        assert.equal(m.count(), 0);
        assert.equal(m.taskbar.hidden, true);
        // Панель задач: клік по активному — згортає, по згорнутому — розгортає, по неактивному — фокусує.
        m.open(spec(1)); m.open(spec(2)); m.open(spec(3));
        const task = (n) => m.get('doc:id' + n).task;
        assert.equal(m.taskbar.hidden, false);
        assert.equal(m.active(), 'doc:id3');
        task(3).fire('click');
        assert.equal(m.get('doc:id3').minimized, true, 'клік по активному згортає');
        assert.equal(m.active(), 'doc:id2', 'активним стає наступне');
        task(1).fire('click');
        assert.equal(m.active(), 'doc:id1', 'клік по неактивному фокусує');
        task(3).fire('click');
        assert.deepEqual([m.get('doc:id3').minimized, m.active()], [false, 'doc:id3'], 'клік по згорнутому розгортає й фокусує');
        // Згорнуте вікно не ловить Esc.
        task(3).fire('click');
        e.esc(); await tick();
        assert.equal(m.get('doc:id1') === null, true, 'Esc закрив активне (id1), а не згорнуте');
        assert.equal(m.get('doc:id3').minimized, true);
        // Середня кнопка миші закриває.
        m.get('doc:id2').task.fire('auxclick', { button: 1 }); await tick();
        assert.equal(m.get('doc:id2'), null);
        m.get('doc:id3').task.fire('auxclick', { button: 0 }); await tick();
        assert.notEqual(m.get('doc:id3'), null, 'ліва кнопка через auxclick не закриває');
        // Кнопки шапки: згорнути / розгорнути / закрити.
        m.focus('doc:id3');
        const w = m.get('doc:id3');
        w.minBtn.fire('click');
        assert.equal(w.minimized, true);
        m.focus('doc:id3');
        w.maxBtn.fire('click');
        assert.equal(w.maximized, true);
        assert.equal(w.el.classList.contains('is-max'), true);
        w.closeBtn.fire('click'); await tick();
        assert.equal(m.count(), 0);
    });
});

test('«брудна» форма: закриття питає підтвердження через діалог; картки без форм закриваються одразу', async () => {
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        m.open({ ...spec(1), type: 'form', key: 'form:a', id: '#/docs/new/act' });
        const w = m.get('form:a');
        await m.close('form:a');
        assert.equal(m.count(), 0, 'чиста форма закривається без питань');
        assert.equal(e.confirms.length, 0);
        m.open({ ...spec(1), type: 'form', key: 'form:a', id: '#/docs/new/act' });
        const form = m.get('form:a');
        form.bodyEl.fire('input', { target: { tagName: 'INPUT' } });
        assert.equal(form.dirty, true);
        e.setAnswer(false);
        assert.equal(await m.close('form:a'), false, 'користувач залишив форму');
        assert.equal(m.count(), 1);
        assert.equal(e.confirms.length, 1);
        assert.deepEqual([e.confirms[0].danger, e.confirms[0].confirmText], [true, 'Закрити']);
        assert.match(e.confirms[0].text, /незбережені зміни/);
        // Esc теж питає.
        e.esc(); await tick();
        assert.equal(e.confirms.length, 2);
        assert.equal(m.count(), 1);
        e.setAnswer(true);
        assert.equal(await m.close('form:a'), true);
        assert.equal(m.count(), 0);
        // force (після успішного збереження) — без питань.
        m.open({ ...spec(2), type: 'client_form', key: 'client_form:new', id: '' });
        m.get('client_form:new').bodyEl.fire('change', { target: { tagName: 'SELECT' } });
        assert.equal(await m.close('client_form:new', { force: true }), true);
        assert.equal(e.confirms.length, 3, 'force не питає (3 діалоги були раніше)');
        // Кліки по кнопках і чекбоксах-не-полях не роблять форму брудною; картка (doc) не відстежується взагалі.
        m.open(spec(5));
        m.get('doc:id5').bodyEl.fire('input', { target: { tagName: 'INPUT' } });
        assert.equal(m.get('doc:id5').dirty, false);
        assert.equal(w.title, 'Рахунок № 1');
        const src = read('src/bridge.js');
        assert.match(src, /confirm: \(options\) => \(typeof tcModal === 'function' \? tcModal\(options\)/, 'діалог — наявний tcModal, не confirm()');
        assert.equal(/\bconfirm\(|\balert\(/.test(read('src/kp-windows.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').replace(/confirmClose|env\.confirm/g, '')), false, 'без confirm() і alert()');
    });
});

test('sessionStorage: лише тип, id і «згорнуте»; відновлення; скидання при зміні компанії / користувача', async () => {
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        const resolve = (item) => ({ type: item.type, id: item.id, key: item.type + ':' + item.id, title: 'Відновлено ' + item.id, build: () => {} });
        await m.setScope('org1', 'u1', resolve);
        assert.equal(m.count(), 0);
        m.open(spec(1)); m.open(spec(2)); m.minimize('doc:id2');
        const key = 'tc_kp_windows:org1:u1';
        assert.equal(storageKey('org1', 'u1'), key);
        assert.deepEqual(JSON.parse(e.store.get(key)), [{ type: 'doc', id: 'id1', minimized: false }, { type: 'doc', id: 'id2', minimized: true }]);
        assert.equal(/x"|y"|left|top|html|title/i.test(e.store.get(key)), false, 'без позицій і вмісту');
        // «Перезавантаження»: новий менеджер на тому ж сховищі відновлює вікна (з «згорнутим» станом).
        const e2 = setup();
        e2.store.set(key, e.store.get(key));
        const m2 = createWindowManager(e2.env);
        await m2.setScope('org1', 'u1', resolve);
        assert.deepEqual(m2.list().map((w) => [w.key, w.minimized]), [['doc:id1', false], ['doc:id2', true]]);
        assert.equal(m2.active(), 'doc:id1');
        // Інша компанія: всі вікна закриваються, старий ключ не затирається порожнім списком, новий порожній.
        await m2.setScope('org2', 'u1', resolve);
        assert.equal(m2.count(), 0);
        assert.deepEqual(JSON.parse(e2.store.get(key)).length, 2, 'стан старої пари лишився для неї');
        assert.ok([null, '[]'].includes(e2.store.get('tc_kp_windows:org2:u1') ?? null), 'нова пара без збережених вікон');
        // Інший користувач тієї ж компанії.
        await m2.setScope('org1', 'u2', resolve);
        assert.equal(m2.count(), 0);
        m2.open(spec(7));
        assert.deepEqual(JSON.parse(e2.store.get('tc_kp_windows:org1:u2')), [{ type: 'doc', id: 'id7', minimized: false }]);
        // Повернення до першої пари — її збережені вікна відновлюються.
        await m2.setScope('org1', 'u1', resolve);
        assert.equal(m2.count(), 2);
        // Вихід із системи: scope null — усі закриті, нічого не пишеться.
        await m2.setScope(null, null);
        assert.equal(m2.count(), 0);
        assert.equal(JSON.parse(e2.store.get(key)).length, 2);
        // Сміття у сховищі відкидається.
        assert.deepEqual(parseWindows('не json'), []);
        assert.deepEqual(parseWindows(JSON.stringify([{ type: 'evil', id: 'x' }, { type: 'doc', id: 5 }, { type: 'doc', id: 'a' }, { type: 'doc', id: 'a' }])), [{ type: 'doc', id: 'a', minimized: false }]);
        assert.equal(parseWindows(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ type: 'doc', id: 'x' + i })))).length, MAX_WINDOWS);
        assert.equal(storageKey(null, 'u'), null);
        assert.equal(serializeWindows([{ type: 'doc', id: 'a', minimized: false, x: 1, title: 'T' }]), '[{"type":"doc","id":"a","minimized":false}]');
    });
});

test('XSS: заголовки вікон і підписи панелі задач проходять через escHtml', async () => {
    await withDom(async () => {
        const evil = '<img src=x onerror=alert(1)>"\'&';
        assert.equal(escHtml(evil), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
        assert.equal(escHtml(null), '');
        const e = setup();
        const m = createWindowManager(e.env);
        m.open(spec(1, { title: evil }));
        const w = m.get('doc:id1');
        assert.equal(w.titleEl.innerHTML.includes('<img'), false);
        assert.ok(w.titleEl.innerHTML.includes('&lt;img'));
        assert.equal(w.taskLabel.innerHTML.includes('<img'), false);
        assert.equal(w.el.getAttribute('aria-label'), evil, 'атрибути ставляться через setAttribute (не innerHTML)');
        // Заголовок, що прийшов із вмісту (ctl.setTitle), теж екранується.
        w.ctl.setTitle('Клієнт <script>alert(2)</script>');
        assert.equal(w.titleEl.innerHTML.includes('<script'), false);
        assert.ok(w.titleEl.innerHTML.includes('&lt;script&gt;'));
        assert.match(read('src/kp-windows.js'), /w\.titleEl\.innerHTML = escHtml\(w\.title\);/);
        assert.match(read('src/kp-windows.js'), /w\.taskLabel\.innerHTML = escHtml\(shortLabel\(w\.title\)\);/);
    });
});

test('перетягування за шапку не виходить за межі робочої області (viewport без меню, верхньої панелі й панелі задач)', async () => {
    const b = { left: 232, top: 52, right: 1280, bottom: 768 };
    assert.deepEqual(clampPos(-500, -500, 600, 400, b), { x: 232, y: 52 });
    assert.deepEqual(clampPos(5000, 5000, 600, 400, b), { x: 680, y: 368 });
    assert.deepEqual(clampPos(300, 100, 600, 400, b), { x: 300, y: 100 });
    assert.deepEqual(clampPos(0, 0, 2000, 2000, b), { x: 232, y: 52 }, 'вікно більше області — притискається до кута');
    const r = initialRect(b, 0);
    assert.ok(r.x >= b.left && r.y >= b.top && r.x + r.w <= b.right && r.y + r.h <= b.bottom);
    for (let n = 0; n < 12; n += 1) { const q = initialRect(b, n); assert.ok(q.x >= b.left && q.y >= b.top && q.x + q.w <= b.right && q.y + q.h <= b.bottom, 'каскад ' + n); }
    await withDom(async () => {
        const e = setup();
        const m = createWindowManager(e.env);
        m.open(spec(1));
        const w = m.get('doc:id1');
        const head = w.el.children[0];
        head.fire('pointerdown', { button: 0, clientX: 400, clientY: 100, target: head });
        const move = e.win.listeners.pointermove[0];
        move({ clientX: -9999, clientY: -9999 });
        assert.deepEqual([w.x, w.y], [232, 52], 'не виходить за ліву / верхню межі');
        move({ clientX: 99999, clientY: 99999 });
        assert.ok(w.x + w.w <= 1280 && w.y + w.h <= 768, 'не виходить за праву / нижню межі');
        assert.equal(w.el.style.left, w.x + 'px');
        e.win.listeners.pointerup[0]();
        assert.equal(e.win.listeners.pointermove.length, 0, 'слухачі знімаються');
        // Клік по кнопці шапки не починає перетягування; розгорнуте вікно не тягнеться.
        const btn = w.closeBtn;
        const before = [w.x, w.y];
        head.fire('pointerdown', { button: 0, clientX: 1, clientY: 1, target: btn });
        assert.equal((e.win.listeners.pointermove || []).length, 0);
        assert.deepEqual([w.x, w.y], before);
    });
});

test('Back і hash: вікно відкривається над розділом, Back закриває верхнє, повторний hash фокусує, ліміт повертає hash', async () => {
    await withDom(async () => {
        const e = setup({ hash: '#/clients' });
        const m = createWindowManager(e.env);
        const sp = (key, type = 'doc') => ({ type, id: key.split(':')[1], key, title: 'Т', build: () => {} });
        // Відкриваємо картку з розділу #/clients.
        e.win.location.hash = '#/docs/A';
        assert.equal(m.handleHash('#/docs/A', sp('doc:A')), true);
        assert.equal(m.count(), 1);
        assert.deepEqual([m.get('doc:A').hash, m.get('doc:A').prevHash, m.get('doc:A').viaHash], ['#/docs/A', '#/clients', true]);
        // Друге вікно з першого.
        e.win.location.hash = '#/docs/B';
        assert.equal(m.handleHash('#/docs/B', sp('doc:B')), true);
        assert.equal(m.count(), 2);
        // Back: B → A. Верхнє вікно (B) закривається, A лишається активним, розділ не перемальовується (handled = true).
        e.win.location.hash = '#/docs/A';
        assert.equal(m.handleHash('#/docs/A', sp('doc:A')), true);
        await tick();
        assert.deepEqual(m.list().map((w) => w.key), ['doc:A']);
        assert.equal(m.active(), 'doc:A');
        // Ще Back: A → #/clients. Закривається A, розділ під ним не чіпаємо.
        e.win.location.hash = '#/clients';
        assert.equal(m.handleHash('#/clients', null), true);
        await tick();
        assert.equal(m.count(), 0);
        // Перехід у розділ, який не є «попереднім» для вікна, вікон не закриває і не обробляється менеджером.
        e.win.location.hash = '#/docs/C';
        m.handleHash('#/docs/C', sp('doc:C'));
        e.win.location.hash = '#/fleet';
        assert.equal(m.handleHash('#/fleet', null), false, 'розділ під вікнами міняє bridge');
        assert.equal(m.count(), 1);
        // Закриття вікна, коли адреса вже в іншому розділі, адресу не чіпає.
        await m.close('doc:C');
        assert.equal(e.win.location.hash, '#/fleet');
        // Закриття кнопкою, поки адреса вказує на це вікно, повертає її до попереднього hash (F5 не відкриє вікно знову).
        e.win.location.hash = '#/docs/D';
        m.handleHash('#/docs/D', sp('doc:D'));
        await m.close('doc:D');
        assert.equal(e.win.location.hash, '#/fleet', 'hash повернуто до prevHash вікна');
        // Ліміт: дев'ятий hash-перехід відхилено й адресу повернуто.
        for (let i = 1; i <= MAX_WINDOWS; i += 1) m.open(sp('doc:L' + i));
        e.win.location.hash = '#/docs/X';
        assert.equal(m.handleHash('#/docs/X', sp('doc:X')), true);
        assert.equal(m.count(), 8);
        assert.notEqual(e.win.location.hash, '#/docs/X', 'адреса не вказує на невідкрите вікно');
        // Вузький екран: вікон немає, менеджер нічого не обробляє.
        const n = setup({ wide: false });
        const mn = createWindowManager(n.env);
        assert.equal(mn.handleHash('#/docs/A', sp('doc:A')), false);
        assert.deepEqual(mn.open(sp('doc:A')), { ok: false, reason: 'narrow' });
        assert.equal(mn.count(), 0);
    });
});

test('маршрути вікон: що відкривається вікном, ключі, #/requests/<id>; решта — звичайні сторінки', () => {
    const U = '11111111-1111-1111-1111-111111111111';
    const spec = (hash) => windowSpecOf(parseCrmHash(hash), hash);
    assert.deepEqual(spec('#/docs/' + U), { type: 'doc', id: U, key: 'doc:' + U });
    assert.deepEqual(spec('#/docs/ttn/' + U), { type: 'ttn', id: U, key: 'ttn:' + U });
    assert.deepEqual(spec('#/docs/trip_sheet/' + U), { type: 'trip_sheet', id: U, key: 'trip_sheet:' + U });
    assert.deepEqual(spec('#/clients/' + U), { type: 'client', id: U, key: 'client:' + U });
    assert.deepEqual(spec('#/clients/' + U + '/edit'), { type: 'client_form', id: U, key: 'client_form:' + U });
    assert.deepEqual(spec('#/clients/new'), { type: 'client_form', id: '', key: 'client_form:new' });
    assert.deepEqual(spec('#/requests/' + U), { type: 'request', id: U, key: 'request:' + U });
    const form = '#/docs/new/act/calc/' + U;
    assert.deepEqual(spec(form), { type: 'form', id: form, key: 'form:' + form });
    for (const hash of ['#/docs', '#/docs/tab/invoices', '#/clients', '#/fleet', '#/report', '#/repairs', '#/gps', '#/drivers', '']) assert.equal(spec(hash), null, hash + ' — не вікно');
    assert.equal(isWindowRoute(parseCrmHash('#/requests/' + U)), true);
    assert.equal(isWindowRoute(parseCrmHash('#/docs/tab/acts')), false);
    assert.equal(parseCrmHash('#/requests/не-uuid'), null);
    // Для документів значок і підпис: за словом у заголовку.
    assert.equal(iconFor('doc', 'Акт № 3'), 'acts');
    assert.equal(iconFor('doc', 'Рахунок № 7'), 'invoices');
    assert.equal(iconFor('request', ''), 'registry');
    assert.equal(shortLabel('Рахунок № 7'), 'Рахунок № 7');
    assert.equal(cleanTitle('Рахунок № 7 від 12.11.2026 оплачено'), 'Рахунок № 7');
    assert.equal(backTarget([{ key: 'a', viaHash: true, hash: '#a', prevHash: '#p' }], '#a', '#p').key, 'a');
    assert.equal(backTarget([{ key: 'a', viaHash: true, hash: '#a', prevHash: '#p' }], '#a', '#other'), null);
});

test('bridge: hash-маршрути вікон, scope, мобільний фолбек, розділ за замовчуванням; стилі лише під body.kp-shell-on', () => {
    const bridge = read('src/bridge.js');
    for (const part of ["windows.handleHash(location.hash, base ? toWindowSpec(base) : null)", 'openDefaultSection()', "document.getElementById('kp-calc-tab-registry')", 'windows.setScope(', 'syncWindowsScope();',
        "route.view === 'request' && !(windows && windows.enabled())", 'window.kpWindowsOn = ', 'renderRequestWindow(container, id, ctl)', "(await import('./views/docs-card.js')).renderDocCard(a, access, id)",
        "(await import('./views/docs-ttn-card.js')).renderTtnCard(a, access, id)", "(await import('./views/docs-ts-card.js')).renderTripSheetCard(a, access, id)", 'renderClientCard(a, id)',
        "go: (hash) => windowGo(ctl, hash)", 'ctl.titleFrom(container)']) assert.ok(bridge.includes(part), part);
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-windows\.css';/);
    const css = read('src/kp-windows.css');
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((r) => r && !r.startsWith('@'));
    for (const list of rules) for (const sel of list.split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(sel.startsWith('body.kp-shell-on'), 'правило без області КП: ' + sel);
    assert.match(css, /@media \(max-width: 899px\) \{\s+body\.kp-shell-on \.kp-win, body\.kp-shell-on \.kp-taskbar \{ display: none !important; \}/);
    assert.match(css, /height: 32px/);
    // Шлях зсередини вікна: збереження форми → app.go(...) → вікно замінюється, а не розділ перемальовується.
    assert.match(bridge, /ctl\.close\(\{ force: true \}\)\.then\(\(\) => \{[\s\S]*?if \(location\.hash === hash\) onHash\(\);/);
    // Старі шляхи цілі: розділи й повні сторінки документів на вузькому екрані.
    assert.match(bridge, /else if \(route\.view === 'docs'\) view = lazyView\(\(\) => import\('\.\/views\/docs\.js'\)/);
    assert.match(bridge, /else if \(route\.view === 'client'\) view = renderClientCard\(app\(\), route\.id\);/);
});
