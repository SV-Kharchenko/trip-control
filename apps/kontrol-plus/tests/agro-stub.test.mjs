// Заглушка «Перевезення між компаніями холдингу тепер в АГРО»: для користувача без жодного пункту меню (наприклад, замовник підрозділу без власного КП).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AGRO_STUB_BUTTON, AGRO_STUB_OFF, AGRO_STUB_TEXT, renderAgroStub } from '../src/views/agro-stub.js';

class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.className = ''; this.disabled = false; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    append(...n) { this.children.push(...n); }
    replaceChildren(...n) { this.children = n; }
    querySelectorAll(sel) { const out = []; const walk = (e) => { for (const c of e.children) if (c instanceof El) { if (sel === 'button' && c.tagName === 'BUTTON') out.push(c); walk(c); } }; walk(this); return out; }
}
const text = (e) => (e instanceof El ? e.children.map(text).join('') : (e && e.text) || String(e));
const buttons = (e) => e.querySelectorAll('button');

function withDom(fn) {
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: { createElement: (t) => new El(t), createTextNode: (t) => ({ text: t }) }, configurable: true, writable: true });
    const prevNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
    Object.defineProperty(globalThis, 'Node', { value: El, configurable: true, writable: true });
    const restore = () => {
        if (prev) Object.defineProperty(globalThis, 'document', prev); else delete globalThis.document;
        if (prevNode) Object.defineProperty(globalThis, 'Node', prevNode); else delete globalThis.Node;
    };
    let out;
    try { out = fn(); } catch (e) { restore(); throw e; }
    return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out);
}
const fakeWin = (props = {}) => { const l = {}; return { addEventListener: (t, fn) => { l[t] = fn; }, removeEventListener() {}, location: { assign(u) { this.to = u; } }, listeners: l, ...props }; };

test('AGRO вимкнений: лише текст «Зверніться до директора…», кнопки немає', () => withDom(() => {
    const el = renderAgroStub(fakeWin({ tcKpAgro: false }));
    assert.equal(text(el).includes(AGRO_STUB_TEXT), true);
    assert.equal(text(el).includes(AGRO_STUB_OFF), true);
    assert.equal(buttons(el).length, 0);
    assert.equal(AGRO_STUB_OFF, 'Зверніться до директора за доступом до АГРО');
}));

test('AGRO ввімкнений: кнопка «Перейти в АГРО» веде тим самим SSO-переходом (tcKpOpenAgro), не на всю ширину', async () => {
    await withDom(async () => {
        let called = 0;
        const win = fakeWin({ tcKpAgro: true, tcKpOpenAgro: async () => { called += 1; return { ok: true, url: 'https://agro.trip-control.com/sso#t' }; } });
        const el = renderAgroStub(win);
        assert.equal(buttons(el).length, 1);
        assert.equal(text(buttons(el)[0]), AGRO_STUB_BUTTON);
        assert.equal(/\bbtn-block\b/.test(buttons(el)[0].className), false, 'розмір за вмістом');
        await buttons(el)[0].listeners.click[0]();
        assert.equal(called, 1);
        assert.equal(win.location.to, 'https://agro.trip-control.com/sso#t');
    });
});

test('доступ до AGRO підтвердився пізніше (подія tc-kp-agro): заглушка перемальовується', () => withDom(() => {
    const win = fakeWin({ tcKpAgro: false });
    const el = renderAgroStub(win);
    assert.equal(buttons(el).length, 0);
    win.tcKpAgro = true;
    win.listeners['tc-kp-agro']();
    assert.equal(buttons(el).length, 1);
}));

test('стилі: кнопка не на всю ширину; bridge показує заглушку замість редіректу в «Власний парк», #/own-fleet не чіпали', () => {
    const css = readFileSync(new URL('../src/kp-shell.css', import.meta.url), 'utf8');
    assert.match(css, /\.kp-agro-stub-btn \{ width: auto; flex: none; \}/);
    const bridge = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    assert.match(bridge, /clear\(root, renderAgroStub\(\)\)/);
    assert.equal(/ownFleetOnly\(fleet, state\.context\)\) \{\s*location\.hash = '#\/own-fleet'/.test(bridge), false);
    assert.match(bridge, /route\.view === 'own-fleet' \|\| route\.view === 'own-fleet-card'/);
});
