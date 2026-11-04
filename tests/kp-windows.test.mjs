// Вікна поверх реєстру (Контроль+, PR 3 з 5): що змінилось в index.html — клік по рядку реєстру відкриває вікно заявки (лише КП),
// дані для вікна «Заявка …», посилання на документи й договір ведуть hash-маршрутами (вікна); сайт без змін. Логіку менеджера вікон — див.
// apps/kontrol-plus/tests/kp-windows.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');

function fnSource(name, isAsync) {
    const start = html.indexOf((isAsync ? 'async ' : '') + 'function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}
const constLine = (name) => {
    const start = html.indexOf('    const ' + name + ' = ');
    assert.ok(start > 0, name);
    return html.slice(start, html.indexOf(';\n', start) + 1);
};
const ID = '11111111-1111-1111-1111-111111111111';
const run = (ctx, code) => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', ctx));

test('клік по рядку реєстру: у КП з вікнами — hash #/requests/<id> (вікно); без вікон і на сайті — як раніше (розрахунок рейсу)', () => {
    const calls = [];
    const make = ({ kp, windows }) => {
        const ctx = vm.createContext({
            isKP: () => kp, REGISTRY_UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, location: { hash: '' },
            window: windows === undefined ? {} : { kpWindowsOn: () => windows },
            savedCalculations: [{ id: ID }], openSaved: (id) => calls.push(['openSaved', id]), loadSavedCalculations: () => Promise.resolve(), showToast() {},
        });
        vm.runInContext(fnSource('openRegistryRow'), ctx);
        return ctx;
    };
    const kp = make({ kp: true, windows: true });
    vm.runInContext('openRegistryRow("' + ID + '")', kp);
    assert.equal(kp.location.hash, '#/requests/' + ID);
    assert.deepEqual(calls, []);
    for (const ctx of [make({ kp: true, windows: false }), make({ kp: false, windows: true }), make({ kp: true })]) {
        vm.runInContext('openRegistryRow("' + ID + '")', ctx);
        assert.equal(ctx.location.hash, '', 'хеш не міняється');
    }
    assert.deepEqual(calls, [['openSaved', ID], ['openSaved', ID], ['openSaved', ID]], 'старий шлях: заявка відкривається в розрахунку рейсу');
    // Не uuid — завжди старий шлях.
    const bad = make({ kp: true, windows: true });
    vm.runInContext('openRegistryRow("x\\"><script>")', bad);
    assert.equal(bad.location.hash, '');
});

test('дані вікна «Заявка»: поля рядка реєстру, факт vs план, оплата, дії; на сайті — null', async () => {
    const row = { id: ID, registry_no: '2026-0012', status: 'accepted', user_id: 'u1', route_from: 'Київ', route_to: 'Львів', client_name: 'ТОВ А', distance_km: 540, revenue: 50000, profit: 12000, fact_profit: 9000, cancel_reason: '' };
    const base = (extra = {}) => {
        const ctx = vm.createContext({
            isKP: () => true, registryState: { rows: [row] }, registryDocs: { [ID]: { contract_no: 'Д-1', client_id: 'cl1', docs: [{ id: 'i1', kind: 'invoice', number: '7', status: 'issued', paid: false }] } },
            registryLocalRows: () => [], loadSavedCalculations: async () => {}, registryLoadDocs: async () => {}, currentWorkMode: 'team', savedAuthorLabel: (u) => 'Логіст ' + u,
            displayMinus: (s) => s, formatMoney: (n) => String(n), formatHistoryDate: (s) => s, formatHistoryNum: (n) => String(n), REGISTRY_STATUS_LABELS: { accepted: 'Активна', cancelled: 'Скасована' },
            REGISTRY_PAY_LABELS: { unpaid: 'не оплачено' }, registryPayState: () => 'unpaid', registryRowCan: () => ({ complete: true, cancel: false }),
            registryRouteLabel: (r) => r.route_from + ' → ' + r.route_to, registryVehicleLabel: () => 'AA1234KT',
            registryCellValue: (r, k) => ({ date: '2026-11-03', km: r.distance_km, revenue: r.revenue, profit: r.profit, fact: r.fact_profit === undefined ? null : r.fact_profit })[k] ?? null,
            registryDocActions: () => [{ kind: 'create', docKind: 'act', label: 'Створити акт' }], ...extra,
        });
        vm.runInContext(fnSource('kpRequestRow') + '\n' + fnSource('kpRequestInfo', true), ctx);
        return ctx;
    };
    const ctx = base();
    const info = JSON.parse(JSON.stringify(await vm.runInContext('kpRequestInfo("' + ID + '")', ctx)));
    assert.equal(info.registry_no, '2026-0012');
    assert.equal(info.route, 'Київ → Львів');
    assert.deepEqual([info.client, info.vehicles, info.user, info.statusLabel, info.contract, info.client_id], ['ТОВ А', 'AA1234KT', 'Логіст u1', 'Активна', 'Д-1', 'cl1']);
    assert.deepEqual([info.revenue, info.profit, info.fact, info.factState], ['50000', '12000', '9000', 'low'], 'факт 9000 < плану 12000');
    assert.deepEqual([info.payState, info.payLabel, info.can, info.docs.length, info.actions[0].label], ['unpaid', 'не оплачено', { complete: true, cancel: false }, 1, 'Створити акт']);
    // Факт ≥ плану — «ok»; факту немає — «plan» (за планом).
    const ok = base({ registryState: { rows: [{ ...row, fact_profit: 12000 }] } });
    assert.equal((await vm.runInContext('kpRequestInfo("' + ID + '")', ok)).factState, 'ok');
    const noFact = base({ registryState: { rows: [{ ...row, fact_profit: undefined }] } });
    const plan = await vm.runInContext('kpRequestInfo("' + ID + '")', noFact);
    assert.equal(plan.factState, 'plan');
    assert.match(plan.fact, /за планом/);
    // Скасована заявка: причина; невідома заявка: null; після завантаження історії рядок знаходиться; сайт: null.
    const cancelled = base({ registryState: { rows: [{ ...row, status: 'cancelled', cancel_reason: '' }] } });
    assert.equal((await vm.runInContext('kpRequestInfo("' + ID + '")', cancelled)).cancelReason, 'без причини');
    assert.equal(await vm.runInContext('kpRequestInfo("22222222-2222-2222-2222-222222222222")', base()), null);
    let loaded = 0;
    const lazy = base({ registryState: { rows: [] }, loadSavedCalculations: async () => { loaded += 1; }, registryLocalRows: () => (loaded ? [row] : []) });
    assert.equal((await vm.runInContext('kpRequestInfo("' + ID + '")', lazy)).registry_no, '2026-0012');
    assert.equal(loaded, 1);
    assert.equal(await vm.runInContext('kpRequestInfo("' + ID + '")', base({ isKP: () => false })), null);
});

test('посилання з реєстру (PR #114) — hash-маршрути, які в КП відкривають вікна; сайт без змін', () => {
    const cell = html.slice(html.indexOf('function registryDocLinks('), html.indexOf('function registryKpCell('));
    assert.ok(cell.includes("href=\"#/docs/' + encodeURIComponent(d.id)"), 'рахунок і акт → #/docs/<id> → вікно документа');
    assert.ok(cell.includes("href=\"#/clients/' + encodeURIComponent(info.client_id)"), 'договір → #/clients/<id> → вікно картки клієнта');
    assert.match(fnSource('openRegistryDoc'), /location\.hash = '#\/docs\/' \+ encodeURIComponent\(docId\)/);
    assert.match(fnSource('openCalcDoc'), /location\.hash = '#\/docs\/new\/' \+ target \+ '\/calc\/'/);
    // Рядок реєстру досі відкриває заявку через openRegistryRow (тепер це вікно).
    assert.ok(fnSource('registryRender').includes("' onclick=\"openRegistryRow(\\'' + escHtml(row.id) + '\\')\">'"));
    // Сайт: жодного коду вікон — менеджер у застосунку Контроль+, а в index.html лише гілка за isKP() і window.kpWindowsOn.
    assert.equal(/kp-windows|createWindowManager|kp-win\b|kp-taskbar/.test(html), false);
    assert.ok(fnSource('openRegistryRow').startsWith('function openRegistryRow(id) {\n        if (isKP() && REGISTRY_UUID.test(String(id)) && typeof window.kpWindowsOn === \'function\' && window.kpWindowsOn()) {'));
    assert.match(read('apps/kontrol-plus/scripts/check-scope.mjs'), /\^tests\\\/kp-windows\\\.test\\\.mjs\$/);
    // Вікно заявки малює застосунок без innerHTML: текст лише через textContent.
    assert.equal(/innerHTML/.test(read('apps/kontrol-plus/src/views/request-window.js')), false);
});

// ---- Дві картки ТТН в одному DOM (вікна): без дублів id, label другої картки перемикає саме її чекбокс ----
class FNode {}
class FEl extends FNode {
    constructor(tag) {
        super();
        this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.dataset = {}; this.className = ''; this.checked = false; this.listeners = {};
        this.parent = null; this.id = ''; this.style = {};
        this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    append(...nodes) { for (const n of nodes) { if (Array.isArray(n)) { this.append(...n); continue; } if (n instanceof FNode) { n.parent = this; this.children.push(n); } else this.children.push({ text: String(n) }); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    walk(fn) { for (const c of this.children) if (c instanceof FEl) { fn(c); c.walk(fn); } }
    byTag(tag) { const out = []; this.walk((e) => { if (e.tagName === tag) out.push(e); }); return out; }
    // Як у браузері: клік по label активує його елемент керування — за for (id в документі), інакше перший вкладений input.
    clickLabel(doc) {
        const forId = this.getAttribute('for');
        let target = null;
        if (forId) doc.walk((e) => { if (!target && e.id === forId) target = e; });
        else this.walk((e) => { if (!target && e.tagName === 'INPUT') target = e; });
        if (target && target.attrs.type === 'checkbox') target.checked = !target.checked;
    }
}

test('дві картки ТТН в одному DOM: id не дублюються, клік по label другої картки перемикає саме її чекбокс', async () => {
    const saved = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), Node: Object.getOwnPropertyDescriptor(globalThis, 'Node') };
    Object.defineProperty(globalThis, 'document', { value: { createElement: (t) => new FEl(t), createTextNode: (t) => ({ text: t }) }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Node', { value: FNode, configurable: true, writable: true });
    try {
        const { renderTtnCard } = await import('../apps/kontrol-plus/src/views/docs-ttn-card.js');
        const ttn = { id: 't1', status: 'issued', number: 1, doc_date: '2026-11-12', client_id: 'c1', client_name: 'ТОВ А', lines: [], calculation_id: null };
        const app = { supabase: { rpc: async () => ({ data: ttn, error: null }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }, context: {} };
        const access = { canWrite: true, isOwner: false };
        const first = renderTtnCard(app, access, 't1');
        const second = renderTtnCard(app, access, 't2');
        await new Promise((r) => setTimeout(r, 30));
        const page = new FEl('body');
        page.append(first, second);
        const ids = [];
        page.walk((e) => { if (e.id) ids.push(e.id); });
        assert.equal(new Set(ids).size, ids.length, 'id у DOM унікальні: ' + ids.join(', '));
        assert.equal(ids.includes('ttn-copies'), false);
        const labels = page.byTag('LABEL').filter((l) => /kpt-copies/.test(l.className));
        assert.equal(labels.length, 2, 'у кожній картці є «3 примірники»');
        for (const label of labels) {
            assert.equal(label.getAttribute('for'), null, 'без for');
            assert.equal(label.byTag('INPUT').length, 1, 'input лежить усередині label');
        }
        const boxes = labels.map((l) => l.byTag('INPUT')[0]);
        labels[1].clickLabel(page);
        assert.deepEqual(boxes.map((b) => b.checked), [false, true], 'клік по label другої картки перемикає чекбокс другої, а не першої');
        labels[0].clickLabel(page);
        assert.deepEqual(boxes.map((b) => b.checked), [true, true]);
        labels[1].clickLabel(page);
        assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
    } finally {
        for (const [key, desc] of Object.entries(saved)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
    }
});

test('картки документів у вікнах (рахунок / акт, ТТН, подорожній лист, клієнт) не мають статичних id; пари label[for] — унікальні через uniqueId', () => {
    const src = (f) => read('apps/kontrol-plus/src/views/' + f);
    for (const file of ['docs-card.js', 'docs-ttn-card.js', 'docs-ts-card.js', 'client-card.js']) {
        assert.equal(/\bid: '|\bfor: '/.test(src(file)), false, file + ': статичних id / for немає');
    }
    assert.equal(/ttn-copies/.test(src('docs-ttn-card.js')), false);
    // Спільні шматки карток: лист на пошту, відмітки подорожнього листа, договір клієнта — id з унікальним префіксом екземпляра.
    for (const file of ['doc-email.js', 'docs-ts-stages.js', 'contracts.js']) {
        assert.equal(/\bid: '[a-z]/.test(src(file).replace(/id: pfx/g, '')), false, file + ': лише унікальні id');
        assert.match(src(file), /uniqueId\('(kpe|ts-m|kpc)'\)/);
    }
    // Чекбокс у label без id: for: <box>.id дав би порожній for="" і зламав прив’язку.
    assert.equal(/for: p.box.id/.test(src('doc-email.js')), false, 'doc-email.js: label вибору PDF без for (чекбокс усередині label)');
    assert.match(read('apps/kontrol-plus/src/ui.js'), /export function uniqueId\(prefix\)/);
    assert.match(src('docs-ts-card.js'), /querySelector\('\.kpts-related-box'\)/, 'контейнер пов’язаних документів — клас, не id');
});
