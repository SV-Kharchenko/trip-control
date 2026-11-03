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

test('клік по рядку реєстру: у КП з вікнами — hash #/requests/<id> (вікно); без вікон і на сайті — як раніше (калькулятор)', () => {
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
    assert.deepEqual(calls, [['openSaved', ID], ['openSaved', ID], ['openSaved', ID]], 'старий шлях: заявка відкривається в калькуляторі');
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
