// Смоук-тест каркаса на мінімальному DOM: монтаж, підсвітка, доступ, переходи, згортання, роль.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_ITEMS } from '../src/shell-menu.js';
import { mountShell } from '../src/shell.js';

class FNode {}
class FEl extends FNode {
    constructor(tag, id) {
        super();
        this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.attrs = {}; this.children = []; this.dataset = {}; this.className = ''; this.hidden = false;
        this.textContent = ''; this.clicks = 0; this.listeners = {}; this.parent = null;
        const set = new Set();
        this.classList = {
            add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
            toggle: (c, on) => ((on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c)),
        };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    append(...nodes) { for (const n of nodes) { if (n instanceof FNode) { n.parent = this; this.children.push(n); } else this.children.push({ text: String(n) }); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    click() { this.clicks += 1; (this.listeners.click || []).forEach((fn) => fn({})); }
    focus() { this.focused = true; }
    getClientRects() { return [1]; }
    walk(fn) { for (const c of this.children) if (c instanceof FEl) { fn(c); c.walk(fn); } }
    all(cls) { const out = []; this.walk((e) => { if ((' ' + e.className + ' ').includes(' ' + cls + ' ')) out.push(e); }); return out; }
    querySelectorAll(sel) { return this.all(sel.replace(/^\./, '')); }
}

function shellEnv({ role = 'owner', kp = true } = {}) {
    const byId = {};
    const reg = (el) => { if (el.id) byId[el.id] = el; return el; };
    const body = new FEl('body');
    body.classList.add('kp-nav-on');
    const make = (id, props = {}) => reg(Object.assign(new FEl('div', id), props));
    const oldNav = make('kp-nav-list');
    for (const key of ['overview', 'calc', 'clients', 'fleet', 'drivers', 'repairs', 'gps', 'docs', 'report']) {
        oldNav.append(make('kp-nav-' + key, { hidden: ['fleet', 'drivers', 'repairs', 'gps'].includes(key) }));
    }
    for (const id of ['kp-calc-tab-registry', 'kp-calc-tab-history', 'kp-calc-tab-calc']) make(id);
    make('billing-banner', { hidden: false });
    const headEnd = new FEl('div');
    headEnd.className = 'tc-head-end';
    make('tc-menu-name', { textContent: 'Іван Петренко' });
    make('tc-menu-role', { textContent: 'Директор' });
    make('tc-menu-company', { textContent: 'ТОВ Агро' });
    make('tc-menu-unread', { textContent: '3', hidden: false });
    make('registry-count', { textContent: '12 заявок' });
    make('cabinet-screen', { style: { display: 'none' } });
    const env = { view: 'calc', byId, body, headEnd };
    const doc = {
        documentElement: { dataset: kp ? { app: 'kp' } : {} }, body, listeners: {},
        getElementById: (id) => byId[id] || null,
        querySelector: (sel) => (sel === '.tc-head-end' ? headEnd : null),
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    };
    body.append = (...nodes) => { FEl.prototype.append.call(body, ...nodes); for (const n of nodes) if (n.id) byId[n.id] = n; };
    body.getAttribute = (k) => (k === 'data-studio-view' ? env.view : null);
    const store = new Map();
    const timers = [];
    const win = {
        location: { hash: '' }, tcKpRole: role, tcKpOrgName: 'ТОВ Агро', listeners: {},
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        setTimeout: (fn) => { timers.push(fn); return timers.length; },
        openCabinetTab: (id) => { win.opened = id; }, openCabinet: () => { win.opened = 'cabinet'; }, closeCabinet: () => { win.closed = true; },
    };
    Object.assign(env, { win, store, timers, flush: () => { while (timers.length) timers.shift()(); } });
    env.options = { document: doc, window: win, storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
    return env;
}

test('смоук: каркас монтується, ховає/показує пункти за старими кнопками, веде на наявні розділи, пам’ятає згортання', () => {
    const env = shellEnv();
    const saved = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), Node: Object.getOwnPropertyDescriptor(globalThis, 'Node') };
    Object.defineProperty(globalThis, 'document', { value: { createElement: (t) => new FEl(t), createTextNode: (t) => ({ text: t }) }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Node', { value: FNode, configurable: true, writable: true });
    try {
        const api = mountShell(env.options);
        assert.ok(api);
        assert.equal(env.body.classList.contains('kp-shell-on'), true);
        assert.equal(env.body.classList.contains('kp-nav-on'), false, 'відступи старого меню знято');
        assert.equal(env.byId['billing-banner'].parent, env.byId['kp-shell-strip'], 'банер тріалу — у смузі над панеллю');
        assert.equal(env.headEnd.parent, env.byId['kp-shell-top'], 'тема, вид і меню акаунта — у верхній панелі');
        assert.equal(env.body.classList.contains('kp-shell-strip-on'), true);
        const items = Object.fromEntries(env.byId['kp-shell-side'].all('kp-shell-item').map((b) => [b.attrs['data-key'], b]));
        assert.equal(Object.keys(items).length, SHELL_ITEMS.length);
        assert.equal(items.calc.attrs['aria-current'], 'page');
        assert.equal(items.fleet.hidden, true, 'Автопарк схований, поки схована стара кнопка (доступ рахує bridge.js)');
        assert.equal(items.contracts.hidden, false);
        assert.equal(items.dashboard.attrs['aria-disabled'], 'true');
        // Імʼя, роль, компанія, лічильник реєстру, дзвіночок.
        const text = (cls) => env.byId['kp-shell-top'].all(cls)[0].textContent;
        assert.equal(text('kp-shell-who-name'), 'Іван Петренко');
        assert.equal(text('kp-shell-who-role'), 'Директор');
        assert.equal(text('kp-shell-company'), 'ТОВ Агро');
        assert.equal(text('kp-shell-bell-n'), '3');
        assert.equal(items.registry.all('kp-shell-count')[0].textContent, '12');
        // Переходи: hash — через location.hash, розділ сайту — через наявну кнопку, кабінет — через openCabinetTab.
        items.invoices.click();
        assert.equal(env.win.location.hash, '#/docs/tab/invoices');
        items.registry.click();
        assert.equal(env.byId['kp-calc-tab-registry'].clicks, 1);
        items.team.click();
        assert.equal(env.win.opened, 'team');
        items.dashboard.click();
        assert.equal(env.win.location.hash, '#/docs/tab/invoices', 'заглушка нічого не відкриває');
        // Кабінет відкрито: перехід в інший розділ спершу закриває кабінет, hash ставиться після нього.
        env.byId['cabinet-screen'].style.display = 'block';
        items.clients.click();
        assert.equal(env.win.closed, true);
        assert.notEqual(env.win.location.hash, '#/clients');
        env.flush();
        assert.equal(env.win.location.hash, '#/clients');
        // Згортання: стан у localStorage за ключем tc_kp_sidebar:<user> (user ще невідомий → anon).
        api.setCollapsed(true);
        assert.equal(env.body.classList.contains('kp-shell-collapsed'), true);
        assert.equal(env.store.get('tc_kp_sidebar:anon'), 'collapsed');
        // Логіст → «Логіст».
        const logist = shellEnv({ role: 'logist' });
        mountShell(logist.options);
        assert.equal(logist.byId['kp-shell-top'].all('kp-shell-who-role')[0].textContent, 'Логіст');
        // На сайті (без data-app) нічого не монтується.
        const plain = shellEnv({ kp: false });
        assert.equal(mountShell(plain.options), null);
        assert.equal(plain.body.classList.contains('kp-shell-on'), false);
        assert.equal(plain.body.classList.contains('kp-nav-on'), true);
    } finally {
        for (const [key, desc] of Object.entries(saved)) {
            if (desc) Object.defineProperty(globalThis, key, desc);
            else delete globalThis[key];
        }
    }
});
