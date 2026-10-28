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
    remove() { this.removed = true; }
    replaceWith(node) { this.replacedBy = node; }
}

function setup({ nav = true, main = true, client = true, legacyKey = true, session = null, context = null, repairs = null,
    url = 'https://app.trip-control.com/', stored = null, acceptResponse = { status: 200, body: { ok: true, org_name: 'Агро А' } },
    maintenance = [], fetchGate = null, docs = 'ok' } = {}) {
    const byId = {};
    const navEl = nav ? new FakeElement('nav') : null;
    if (main) byId['main-app'] = new FakeElement('div', 'main-app');
    const body = new FakeElement('body');
    const storage = new Map(legacyKey ? [['kp-auth', '{"old":1}'], ['sb-qkfqjorzsxcajcneohoy-auth-token', 'site']] : []);
    if (stored) storage.set('kp_repair_invite', stored);
    const calls = { warn: 0, listeners: 0, observers: 0, removed: [], rpcs: {}, fetch: [], replaced: [], auth: null, logs: [], docsProbe: 0 };
    const loc = { hash: '', pathname: '/', search: '', href: url };
    body.append = (...nodes) => { body.children.push(...nodes); for (const n of nodes) if (n.id) byId[n.id] = n; };
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
        location: loc,
        history: { replaceState(_s, _t, path) { calls.replaced.push(path); loc.href = new URL(path, url).href; } },
        fetch: async (path, init) => {
            calls.fetch.push({ path, body: JSON.parse(init.body) });
            if (fetchGate) await fetchGate;
            return { ok: acceptResponse.status < 400, status: acceptResponse.status, json: async () => acceptResponse.body };
        },
        MutationObserver: class { constructor(cb) { calls.mutationCb = cb; } observe() { calls.observers += 1; } },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => { storage.set(k, String(v)); },
            removeItem: (k) => { calls.removed.push(k); storage.delete(k); },
        },
        console: { ...console, warn: () => { calls.warn += 1; }, log: (...a) => calls.logs.push(a.join(' ')), error: (...a) => calls.logs.push(a.join(' ')) },
        supabaseClient: client ? {
            auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: (cb) => { calls.listeners += 1; calls.auth = cb; } },
            // Етап 3a: після kp_context міст питає ще kp_repairs_context (вкладка «Ремонти»).
            rpc: async (name) => {
                if (!session) throw new Error(name + ' must not be called without a session');
                // Етап 4a: чи є функції документів (вкладка «Документи»); рахується окремо від решти RPC.
                if (name === 'kp_doc_next_number') {
                    calls.docsProbe += 1;
                    return docs === 'missing' ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } : { data: 1, error: null };
                }
                // Етап 3b: бейдж ТО — kp_maintenance_status, лише коли «Ремонти» видно.
                assert.ok(['kp_context', 'kp_repairs_context', 'kp_maintenance_status'].includes(name), 'unexpected rpc ' + name);
                calls.rpcs[name] = (calls.rpcs[name] || 0) + 1;
                if (name === 'kp_maintenance_status') {
                    if (maintenance === 'missing') return { data: null, error: { code: 'PGRST202', message: 'not found' } };
                    return { data: maintenance, error: null };
                }
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
    const signIn = (s) => { session = s; calls.auth('SIGNED_IN', s); };
    return { navEl, body, byId, storage, calls, restore, loc, signIn };
}

// Пункти лівого меню (aside#kp-side > nav > button*).
const navItems = (env) => (env.byId['kp-side'] ? env.byId['kp-side'].children[0].children : []);

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

test('bridge: site with nav, #main-app and supabaseClient → five tabs and #kp-crm; legacy kp-auth removed once', async () => {
    const env = setup();
    try {
        const { startBridge, LEGACY_SESSION_KEY } = await freshBridge();
        assert.equal(LEGACY_SESSION_KEY, 'kp-auth');
        assert.equal(await startBridge(), true);
        const items = navItems(env);
        assert.deepEqual(items.map((b) => b.id.replace('kp-nav-', '')),
            ['overview', 'calc', 'clients', 'fleet', 'drivers', 'repairs', 'gps', 'docs', 'report', 'stats', 'company']);
        const hidden = Object.fromEntries(items.map((b) => [b.id.replace('kp-nav-', ''), b.hidden === true]));
        assert.deepEqual(hidden, { overview: false, calc: false, clients: false, fleet: true, drivers: true, repairs: true, gps: true, docs: true, report: false, stats: false, company: true },
            'без сесії: GPS, Ремонти, Документи, Автопарк, Водії, Реквізити сховані');
        assert.equal(env.body.classList.contains('kp-nav-on'), true);
        assert.equal(env.navEl.children.length, 0, 'the site nav is left alone');
        assert.deepEqual(env.byId['main-app'].children.map((el) => el.id), ['kp-crm', 'kp-calc-tabs']);
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
            const gps = navItems(env).find((b) => b.id === 'kp-nav-gps');
            assert.equal(gps.hidden, !visible);
            assert.equal(env.calls.rpcs.kp_context, 1, 'kp_context asked once');
        } finally {
            env.restore();
        }
    });
}

// «Документи» (етап 4a): лише control_plus (owner / logist / director) і лише коли в базі є функції 4a.
const RM = { org_id: 'o1', org_name: 'Org', role: 'repair_manager', can_write: true, can_manage_handlers: false };
for (const [name, context, docs, repairs, visible, probes] of [
    ['owner, migration applied', { control_plus: true, role: 'owner' }, 'ok', null, true, 1],
    ['logist', { control_plus: true, role: 'logist' }, 'ok', null, true, 1],
    ['director (read only)', { control_plus: true, role: 'director' }, 'ok', null, true, 1],
    ['migration 4a not applied', { control_plus: true, role: 'owner' }, 'missing', null, false, 1],
    ['company plan', { control_plus: false, role: null, own_org_plan: 'company' }, 'ok', null, false, 0],
    ['repair manager of another org', { control_plus: false, role: null, own_org_plan: 'company' }, 'ok', RM, false, 0],
]) {
    test(`bridge: Документи tab — ${name} → ${visible ? 'visible' : 'hidden'}`, async () => {
        const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context, docs, repairs });
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), true);
            await new Promise((resolve) => setTimeout(resolve, 0));
            const tab = navItems(env).find((b) => b.id === 'kp-nav-docs');
            assert.equal(tab.hidden, !visible);
            assert.equal(env.calls.docsProbe, probes, 'the availability probe runs only for control_plus roles');
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
            const tab = (id) => navItems(env).find((b) => b.id === id).hidden === true;
            assert.deepEqual({ repairs: tab('kp-nav-repairs'), clients: tab('kp-nav-clients'), gps: tab('kp-nav-gps') }, expected, 'hidden flags');
            assert.equal(tab('kp-nav-report'), expected.clients, 'Звіт hidden together with Клієнти');
            const badge = expected.repairs ? {} : { kp_maintenance_status: 1 };
            assert.deepEqual(env.calls.rpcs, { kp_context: 1, kp_repairs_context: 1, ...badge }, 'badge asked only when Ремонти is visible');
        } finally {
            env.restore();
        }
    });
}

// Бейдж ТО на кнопці «Ремонти»: red → кількість red; без red — yellow; нуль або без міграції 3b — без бейджа.
const nodeText = (node) => (node.text !== undefined ? node.text : (node.children || []).map(nodeText).join(''));
for (const [name, maintenance, expected] of [
    ['two red and a yellow', [{ status: 'red' }, { status: 'yellow' }, { status: 'red' }, { status: 'ok' }], { kind: 'red', count: '2' }],
    ['only yellow', [{ status: 'yellow' }, { status: 'ok' }, { status: 'unknown' }], { kind: 'yellow', count: '1' }],
    ['all ok', [{ status: 'ok' }, { status: 'unknown' }], null],
    ['migration 3b not applied', 'missing', null],
]) {
    test(`bridge: Ремонти badge — ${name}`, async () => {
        const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context: { control_plus: true, role: 'owner' },
            repairs: RP('owner'), maintenance });
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), true);
            await ticks();   // бейдж малюється у фоні
            const tab = navItems(env).find((b) => b.id === 'kp-nav-repairs');
            const spans = tab.children.filter((c) => String(c.className).startsWith('kpr-nav-badge'));
            const label = tab.children.find((c) => c.className === 'lb');
            assert.equal(nodeText(label), 'Ремонти', 'label kept');
            assert.equal(tab.children[0].className, 'ic', 'icon kept');
            if (!expected) {
                assert.equal(spans.length, 0, 'no badge');
                assert.equal(tab.getAttribute('title'), null);
            } else {
                assert.equal(spans.length, 1);
                assert.equal(spans[0].className, 'kpr-nav-badge kpr-nav-badge-' + expected.kind);
                assert.equal(nodeText(spans[0]), expected.count);
                assert.match(tab.getAttribute('title'), expected.kind === 'red' ? /Протерміноване ТО: 2/ : /Скоро ТО: 1/);
            }
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

// Запрошення менеджера з ремонтів: реєстрація з підтвердженням пошти відкриває сайт без ?repair_invite=.
const TOKEN = 'v2.11111111-2222-4333-8444-555555555555.' + 'A'.repeat(43);
const ticks = () => new Promise((r) => setTimeout(r, 30));

test('bridge: repair invite without a session → stored, removed from the URL, hint; after sign-in accepted and the key deleted', async () => {
    const env = setup({ url: 'https://app.trip-control.com/?repair_invite=' + encodeURIComponent(TOKEN) + '&x=1' });
    try {
        const { startBridge, REPAIR_INVITE_KEY, REPAIR_INVITE_LOGIN_HINT } = await freshBridge();
        assert.equal(await startBridge(), true);
        assert.equal(REPAIR_INVITE_KEY, 'kp_repair_invite');
        const saved = JSON.parse(env.storage.get('kp_repair_invite'));
        assert.equal(saved.token, TOKEN);
        assert.ok(Math.abs(saved.at - Date.now()) < 5000, 'stored with the time');
        assert.deepEqual(env.calls.replaced, ['/?x=1'], 'parameter removed, the rest of the URL kept');
        assert.equal(env.byId['kp-invite-hint'].children[0].children[0].text, REPAIR_INVITE_LOGIN_HINT);
        assert.deepEqual(env.calls.fetch, [], 'nothing sent without a session');

        env.signIn({ user: { id: 'u1' }, access_token: 'jwt' });
        await ticks();
        assert.deepEqual(env.calls.fetch, [{ path: '/api/repairs/invites', body: { action: 'accept', token: TOKEN } }]);
        assert.equal(env.storage.has('kp_repair_invite'), false, 'key deleted after accept');
        assert.equal(env.loc.hash, '#/repairs');
        assert.ok(env.calls.logs.every((line) => !line.includes(TOKEN)), 'token never logged');
    } finally {
        env.restore();
    }
});

test('bridge: stored repair invite — server error (404) still deletes the key and shows the error', async () => {
    const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context: { control_plus: false },
        stored: JSON.stringify({ token: TOKEN, at: Date.now() - 60000 }),
        acceptResponse: { status: 404, body: { code: 'REPAIR_INVITE_NOT_FOUND', error: 'Запрошення не знайдено або строк дії минув.' } } });
    try {
        const { startBridge } = await freshBridge();
        assert.equal(await startBridge(), true);
        assert.equal(env.calls.fetch.length, 1);
        assert.equal(env.storage.has('kp_repair_invite'), false);
        assert.equal(env.byId['kp-invite-hint'].children[0].children[0].text, 'Запрошення не знайдено або строк дії минув.');
        assert.notEqual(env.loc.hash, '#/repairs');
    } finally {
        env.restore();
    }
});

test('bridge: expired stored repair invite is ignored and deleted', async () => {
    const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context: { control_plus: false },
        stored: JSON.stringify({ token: TOKEN, at: Date.now() - 8 * 24 * 3600 * 1000 }) });
    try {
        const { startBridge } = await freshBridge();
        assert.equal(await startBridge(), true);
        assert.deepEqual(env.calls.fetch, [], 'not sent');
        assert.equal(env.storage.has('kp_repair_invite'), false, 'deleted');
        assert.ok(env.calls.removed.includes('kp_repair_invite'));
    } finally {
        env.restore();
    }
});

// Хвіст 3a: accept зі старту ще в дорозі, а onAuthStateChange кличе його знову — один запит, ключ видаляється один раз.
test('bridge: repair invite — start and onAuthStateChange at once → one accept request, the key deleted once', async () => {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context: { control_plus: false },
        stored: JSON.stringify({ token: TOKEN, at: Date.now() - 60000 }), fetchGate: gate });
    try {
        const { startBridge } = await freshBridge();
        const started = startBridge();
        await ticks();
        assert.equal(env.calls.fetch.length, 1, 'accept from start is waiting for the server');
        env.calls.auth('SIGNED_IN', { user: { id: 'u2' }, access_token: 'jwt2' });
        await ticks();
        open();
        assert.equal(await started, true);
        await ticks();
        assert.deepEqual(env.calls.fetch, [{ path: '/api/repairs/invites', body: { action: 'accept', token: TOKEN } }], 'one accept request');
        assert.equal(env.calls.removed.filter((k) => k === 'kp_repair_invite').length, 1, 'key deleted once');
        assert.equal(env.storage.has('kp_repair_invite'), false);
    } finally {
        env.restore();
    }
});

const NAV_ORDER = ['overview', 'calc', 'clients', 'fleet', 'drivers', 'repairs', 'gps', 'docs', 'report', 'stats', 'company'];
// Ліве меню: Автопарк, Водії, Реквізити компанії з'являються разом з «Документами» (функції 4a/4b); менеджер ремонтів бачить лише «Ремонти».
const visibleKeys = (env) => navItems(env).filter((b) => b.hidden !== true).map((b) => b.id.replace('kp-nav-', ''));
for (const [name, opts, expected] of [
    ['owner, migration applied', { context: { control_plus: true, role: 'owner' }, docs: 'ok', repairs: null },
        ['overview', 'calc', 'clients', 'fleet', 'drivers', 'gps', 'docs', 'report', 'stats', 'company']],
    ['director (read only)', { context: { control_plus: true, role: 'director' }, docs: 'ok', repairs: null },
        ['overview', 'calc', 'clients', 'fleet', 'drivers', 'gps', 'docs', 'report', 'stats', 'company']],
    ['migration 4a not applied', { context: { control_plus: true, role: 'owner' }, docs: 'missing', repairs: null },
        ['overview', 'calc', 'clients', 'gps', 'report', 'stats']],
    ['repair manager of another org sees only Ремонти', { context: { control_plus: false, role: null, own_org_plan: 'company' }, docs: 'ok', repairs: RM },
        ['repairs']],
    ['company plan: site pages and report only', { context: { control_plus: false, role: null, own_org_plan: 'company' }, docs: 'ok', repairs: null },
        ['overview', 'calc', 'clients', 'report', 'stats']],
]) {
    test(`bridge: left menu — ${name}`, async () => {
        const env = setup({ session: { user: { id: 'u1' }, access_token: 'jwt' }, context: opts.context, docs: opts.docs, repairs: opts.repairs });
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), true);
            await ticks();
            const got = visibleKeys(env);
            assert.deepEqual(got, NAV_ORDER.filter((k) => expected.includes(k)), name);
            assert.deepEqual(navItems(env).map((b) => b.id.replace('kp-nav-', '')), NAV_ORDER, 'DOM order never changes');
        } finally {
            env.restore();
        }
    });
}

test('bridge: old #/docs/debts | fleet | requisites redirect to the new sections', async () => {
    for (const [from, to] of [['#/docs/debts', '#/report/debts'], ['#/docs/fleet', '#/fleet'], ['#/docs/requisites', '#/company']]) {
        const env = setup(); // без сесії: після редіректу розділ не рендериться, перевіряємо лише hash
        env.loc.hash = from;
        try {
            const { startBridge } = await freshBridge();
            assert.equal(await startBridge(), true);
            assert.deepEqual(env.calls.replaced.filter((p) => p.includes('#/')), ['/' + to], from);
        } finally {
            env.restore();
        }
    }
});


// Підсвітка «Розрахунки» і вкладок «Розрахунок / Заявки» одразу при завантаженні й при кожній зміні data-studio-view.
test('bridge: active menu item and calc tabs follow data-studio-view from the first render', async () => {
    const env = setup();
    try {
        const { startBridge } = await freshBridge();
        assert.equal(await startBridge(), true);
        const tabsNav = env.byId['main-app'].children.find((c) => c.id === 'kp-calc-tabs');
        env.byId['kp-calc-tab-calc'] = tabsNav.children[0];
        env.byId['kp-calc-tab-history'] = tabsNav.children[1];
        const items = () => navItems(env).filter((b) => b.classList.contains('on')).map((b) => b.id.replace('kp-nav-', ''));
        const tabs = () => tabsNav.children.filter((b) => b.classList.contains('on')).map((b) => b.id);
        const change = (view) => {
            env.body.setAttribute('data-studio-view', view);
            env.calls.mutationCb([{ attributeName: 'data-studio-view' }]);
        };
        env.calls.mutationCb([{ attributeName: 'data-theme' }]);
        assert.deepEqual(items(), ['calc'], 'калькулятор за замовчуванням: «Розрахунки» підсвічено');
        assert.deepEqual(tabs(), ['kp-calc-tab-calc']);
        change('history');
        assert.deepEqual(items(), ['calc'], 'історія заявок — теж «Розрахунки»');
        assert.deepEqual(tabs(), ['kp-calc-tab-history']);
        change('overview');
        assert.deepEqual(items(), ['overview']);
        change('calc');
        assert.deepEqual(items(), ['calc']);
        assert.deepEqual(tabs(), ['kp-calc-tab-calc']);
    } finally {
        env.restore();
    }
});
