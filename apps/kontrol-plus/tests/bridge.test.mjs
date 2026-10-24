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

function setup({ nav = true, main = true, client = true, legacyKey = true, session = null, context = null, repairs = null } = {}) {
    const byId = {};
    const navEl = nav ? new FakeElement('nav') : null;
    if (main) byId['main-app'] = new FakeElement('div', 'main-app');
    const body = new FakeElement('body');
    const storage = new Map(legacyKey ? [['kp-auth', '{"old":1}'], ['sb-qkfqjorzsxcajcneohoy-auth-token', 'site']] : []);
    const calls = { warn: 0, listeners: 0, observers: 0, removed: [], rpcs: {} };
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
            auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => { calls.listeners += 1; } },
            // Етап 3a: після kp_context міст питає ще kp_repairs_context (вкладка «Ремонти»).
            rpc: async (name) => {
                if (!session) throw new Error(name + ' must not be called without a session');
                assert.ok(['kp_context', 'kp_repairs_context'].includes(name), 'unexpected rpc ' + name);
                calls.rpcs[name] = (calls.rpcs[name] || 0) + 1;
                if (name === 'kp_repairs_context') {
                    if (repairs === 'missing') return { data: null, error: { code: 'PGRST202', message: 'not found' } };
                    return { data: repairs ? [repairs] : [], error: null };
                }
                return { data: context ? [context] : [], error: null };
            },
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

test('bridge: site with nav, #main-app and supabaseClient → four tabs and #kp-crm; legacy kp-auth removed once', async () => {
    const env = setup();
    try {
        const { startBridge, LEGACY_SESSION_KEY } = await freshBridge();
        assert.equal(LEGACY_SESSION_KEY, 'kp-auth');
        assert.equal(await startBridge(), true);
        assert.deepEqual(env.navEl.children.map((b) => b.id), ['kp-nav-clients', 'kp-nav-report', 'kp-nav-gps', 'kp-nav-repairs']);
        assert.equal(env.navEl.children[2].hidden, true, 'GPS tab hidden without a session');
        assert.equal(env.navEl.children[3].hidden, true, 'Ремонти hidden without a session');
        assert.equal(env.navEl.children[0].hidden, undefined, 'Клієнти / Звіт as before');
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

for (const [name, context, visible] of [
    ['control_plus owner', { control_plus: true, role: 'owner' }, true],
    ['control_plus logist', { control_plus: true, role: 'logist' }, true],
    ['control_plus director', { control_plus: true, role: 'director' }, true],
    ['company plan', { control_plus: false, role: null, own_org_plan: 'company' }, false],
    ['no context row', null, false],
]) {
    test(`bridge: GPS tab — ${name} → ${visible ? 'visible' : 'hidden'}`, async () => {
        const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context });
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), true);
            const gps = env.navEl.children.find((b) => b.id === 'kp-nav-gps');
            assert.equal(gps.hidden, !visible);
            assert.equal(env.calls.rpcs.kp_context, 1, 'kp_context asked once');
        } finally {
            env.restore();
        }
    });
}

const RP = (role, extra = {}) => ({ org_id: 'o1', org_name: 'Org', role, can_write: true, can_manage_handlers: false, ...extra });
for (const [name, context, repairs, expected] of [
    ['owner with repairs', { control_plus: true, role: 'owner' }, RP('owner', { can_manage_handlers: true }), { repairs: false, clients: false, gps: false }],
    ['logist not a handler (read only)', { control_plus: true, role: 'logist' }, RP('logist', { can_write: false }), { repairs: false, clients: false, gps: false }],
    ['repair manager of another org', { control_plus: false, role: null, own_org_plan: 'company' }, RP('repair_manager'), { repairs: false, clients: true, gps: true }],
    ['company plan, no repairs', { control_plus: false, role: null, own_org_plan: 'company' }, null, { repairs: true, clients: false, gps: true }],
    ['migration 3a not applied', { control_plus: true, role: 'owner' }, 'missing', { repairs: true, clients: false, gps: false }],
]) {
    test(`bridge: Ремонти tab — ${name}`, async () => {
        const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context, repairs });
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), true);
            const tab = (id) => env.navEl.children.find((b) => b.id === id).hidden === true;
            assert.deepEqual({ repairs: tab('kp-nav-repairs'), clients: tab('kp-nav-clients'), gps: tab('kp-nav-gps') }, expected, 'hidden flags');
            assert.equal(tab('kp-nav-report'), expected.clients, 'Звіт hidden together with Клієнти');
            assert.deepEqual(env.calls.rpcs, { kp_context: 1, kp_repairs_context: 1 });
        } finally {
            env.restore();
        }
    });
}

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
