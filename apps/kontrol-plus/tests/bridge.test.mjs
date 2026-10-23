import { test } from 'node:test';
import assert from 'node:assert/strict';

// Мінімальний DOM — рівно стільки, скільки чіпає bridge.js при старті (mount, syncNav, onHash без CRM-маршруту).
class FakeNode {}
class FakeElement extends FakeNode {
    constructor(tag, id) {
        super();
        this.tagName = String(tag).toUpperCase();
        this.id = id || '';
        this.attrs = {};
        this.children = [];
        this.dataset = {};
        this.className = '';
        const classes = new Set();
        this.classList = {
            add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
            toggle: (c, on) => ((on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c)),
        };
    }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); }
    getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    insertBefore(node) { this.children.push(node); return node; }
    focus() {}
}

function setup({ nav = true, main = true, client = true, legacyKey = true } = {}) {
    const byId = {};
    const navEl = nav ? new FakeElement('nav') : null;
    if (main) byId['main-app'] = new FakeElement('div', 'main-app');
    const body = new FakeElement('body');
    const storage = new Map(legacyKey ? [['kp-auth', '{"old":1}'], ['sb-qkfqjorzsxcajcneohoy-auth-token', 'site']] : []);
    const calls = { warn: 0, listeners: 0, observers: 0, removed: [] };
    const doc = {
        body,
        querySelector: (sel) => (sel === '#tc-nav-panel .tc-studio-nav' ? navEl : null),
        getElementById: (id) => byId[id] || null,
        createElement: (tag) => new FakeElement(tag),
        createTextNode: (text) => Object.assign(new FakeNode(), { text }),
    };
    const globals = {
        Node: FakeNode,
        document: doc,
        window: { addEventListener: () => { calls.listeners += 1; }, scrollTo() {} },
        location: { hash: '', pathname: '/', search: '' },
        history: { replaceState() {} },
        MutationObserver: class { observe() { calls.observers += 1; } },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            removeItem: (k) => { calls.removed.push(k); storage.delete(k); },
        },
        console: { ...console, warn: () => { calls.warn += 1; } },
        supabaseClient: client ? {
            auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => { calls.listeners += 1; } },
            rpc: async () => { throw new Error('kp_context must not be called without a session'); },
        } : undefined,
    };
    const saved = {};
    for (const [key, value] of Object.entries(globals)) {
        saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
        if (value === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const restore = () => {
        for (const [key, desc] of Object.entries(saved)) {
            if (desc) Object.defineProperty(globalThis, key, desc);
            else delete globalThis[key];
        }
    };
    return { navEl, body, byId, storage, calls, restore };
}

let n = 0;
// Окремий екземпляр модуля на кожен випадок (стан моста — на рівні модуля).
const freshBridge = () => import('../src/bridge.js?case=' + (n += 1));

for (const [name, opts] of [
    ['no #tc-nav-panel', { nav: false }],
    ['no #main-app', { main: false }],
    ['no supabaseClient', { client: false }],
    ['nothing at all', { nav: false, main: false, client: false }],
]) {
    test(`bridge: ${name} → no tabs, no listeners, no throw`, async () => {
        const env = setup(opts);
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), false);
            if (env.navEl) assert.equal(env.navEl.children.length, 0, 'no tabs in the site nav');
            if (env.byId['main-app']) assert.equal(env.byId['main-app'].children.length, 0, 'no #kp-crm');
            assert.equal(env.calls.listeners, 0, 'no hashchange / auth listeners');
            assert.equal(env.calls.observers, 0);
            assert.equal(env.calls.warn, 1, 'one console warning');
            assert.equal(env.body.getAttribute('data-kp-view'), null);
            assert.equal(env.storage.has('kp-auth'), false, 'legacy session key removed anyway');
        } finally {
            env.restore();
        }
    });
}

test('bridge: site with nav, #main-app and supabaseClient → two tabs and #kp-crm; legacy kp-auth removed once', async () => {
    const env = setup();
    try {
        const { startBridge, LEGACY_SESSION_KEY } = await freshBridge();
        assert.equal(LEGACY_SESSION_KEY, 'kp-auth');
        assert.equal(await startBridge(), true);
        assert.deepEqual(env.navEl.children.map((b) => b.id), ['kp-nav-clients', 'kp-nav-report']);
        assert.deepEqual(env.byId['main-app'].children.map((el) => el.id), ['kp-crm']);
        assert.equal(env.calls.warn, 0);
        assert.deepEqual(env.calls.removed, ['kp-auth'], 'only the legacy key, never the site session');
        assert.equal(env.storage.get('sb-qkfqjorzsxcajcneohoy-auth-token'), 'site');
        assert.equal(env.body.getAttribute('data-kp-view'), null, 'no CRM hash → site view untouched');
    } finally {
        env.restore();
    }
    const again = setup({ legacyKey: false });
    try {
        const { startBridge } = await freshBridge();
        assert.equal(await startBridge(), true);
        assert.deepEqual(again.calls.removed, [], 'nothing to remove on later loads');
    } finally {
        again.restore();
    }
});

test('bridge: blocked localStorage does not break start', async () => {
    const env = setup();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
        const { startBridge } = await freshBridge();
        assert.equal(await startBridge(), true);
    } finally {
        env.restore();
    }
});
