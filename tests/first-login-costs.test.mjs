// Перший вхід директора → кабінет «Витратна частина»; порожній стартовий рейс; режим «Сам» без перемикача «Директор / Логіст».
// Функції беруться з index.html як є і виконуються з підставними залежностями (DOM, localStorage, location).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function functionSource(source, name) {
    const start = source.indexOf((source.includes('async function ' + name + '(') ? 'async function ' : 'function ') + name + '(');
    assert.notEqual(start, -1, name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error('unclosed ' + name);
}
const literal = (name) => Function('return ' + html.match(new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\});'))[1])();

// ---------- 1. Перший вхід → #/cabinet/costs ----------
function firstLogin(initial = {}) {
    const store = new Map(initial.store || []);
    const calls = [];
    const env = {
        isKP: false, currentOrgRole: 'owner', currentUserId: 'u1', costs: false, recoveryMode: false, recoveryUrl: false,
        inviteToken: '', search: '', storageBroken: false, ...initial.env
    };
    const localStorage = {
        getItem: (k) => (env.storageBroken ? null : (store.has(k) ? store.get(k) : null)),
        setItem: (k, v) => { if (env.storageBroken) return; store.set(k, String(v)); }
    };
    const factory = new Function('env', 'calls', 'localStorage', `
        const FIRST_CABINET_COSTS_KEY = ${JSON.stringify('tc:first-cabinet-costs:')};
        const isKP = () => env.isKP, hasCompanyCosts = () => env.costs, urlLooksLikeRecovery = () => env.recoveryUrl, urlInviteToken = () => env.inviteToken;
        const location = { get search() { return env.search; }, pathname: '/' };
        const history = { replaceState: (_a, _b, url) => calls.push(['hash', url]) };
        const openCabinetTab = (id) => calls.push(['tab', id]);
        let currentOrgRole, currentUserId, recoveryMode;
        const sync = () => { currentOrgRole = env.currentOrgRole; currentUserId = env.currentUserId; recoveryMode = env.recoveryMode; };
        ${functionSource(html, 'maybeOpenFirstCabinetCosts')}
        return () => { sync(); return maybeOpenFirstCabinetCosts(); };
    `);
    return { run: factory(env, calls, localStorage), calls, env, store };
}

test('перший вхід директора на сайті з порожньою «Витратною частиною» відкриває #/cabinet/costs один раз', () => {
    const f = firstLogin();
    assert.equal(f.run(), true);
    assert.deepEqual(f.calls, [['tab', 'costs'], ['hash', '/#/cabinet/costs']]);
    assert.equal(f.store.get('tc:first-cabinet-costs:u1'), '1');
    f.calls.length = 0;
    assert.equal(f.run(), false, 'повторний вхід, оновлення сторінки, наступна сесія — калькулятор як зараз');
    assert.deepEqual(f.calls, []);
});

test('автоперехід не спрацьовує: Контроль+, не директор, витрати вже збережені, відновлення пароля, запрошення, повернення з оплати', () => {
    const cases = {
        'Контроль+': { isKP: true },
        'логіст': { currentOrgRole: 'logist' },
        'менеджер/інша роль': { currentOrgRole: 'director' },
        'витратну частину вже збережено': { costs: true },
        'відновлення пароля (режим)': { recoveryMode: true },
        'відновлення пароля (URL)': { recoveryUrl: true },
        'запрошення в команду': { inviteToken: 'signed-token' },
        '?billing=return': { search: '?billing=return&pid=1' },
        '?billing=pay': { search: '?billing=pay' },
        'без користувача': { currentUserId: '' }
    };
    for (const [name, env] of Object.entries(cases)) {
        const f = firstLogin({ env });
        assert.equal(f.run(), false, name);
        assert.deepEqual(f.calls, [], name);
        assert.equal(f.store.size, 0, name + ': позначку не ставимо, щоб перший справжній вхід не втратився');
    }
    const broken = firstLogin({ env: { storageBroken: true } });
    assert.equal(broken.run(), false, 'без localStorage не відкриваємо (інакше кабінет був би на кожному вході)');
    // Інший користувач на тому ж браузері має власну позначку.
    const other = firstLogin({ store: [['tc:first-cabinet-costs:u1', '1']], env: { currentUserId: 'u2' } });
    assert.equal(other.run(), true);
});

test('checkUserAccess: кабінет після профілю, шаблону й чернетки; hash, ?cab= та запрошення мають пріоритет', () => {
    const fn = functionSource(html, 'checkUserAccess');
    const at = (s) => { const i = fn.indexOf(s); assert.notEqual(i, -1, s); return i; };
    assert.ok(at('await ensureStarterTemplate();') < at('applyCalcDefaults();'));
    assert.ok(at('applyCalcDefaults();') < at('applySampleTripIfEmpty();'));
    assert.ok(at('applySampleTripIfEmpty();') < at('applyLandingDraft()'), 'чернетка з лендингу підставляється, як і раніше');
    assert.ok(at('applyLandingDraft()') < at('openCabinetFromLocation()'));
    assert.ok(at('openCabinetFromLocation()') < at('maybeOpenFirstCabinetCosts()'));
    assert.match(fn, /if \(cabParam === 'team' \|\| cabParam === 'company' \|\| cabParam === 'docs'\) openCabinetTab\(cabParam\);\n\s+else if \(!inviteNotice\) maybeOpenFirstCabinetCosts\(\);/);
    assert.ok(at('if (await runInviteFlow(session)) return;') < at('maybeOpenFirstCabinetCosts()'));
    assert.match(html, /Відкриваємо кабінет — вкладка «Витратна частина»…/);
    assert.equal(html.includes('Відкриваємо демо зі стартовим шаблоном'), false);
    // Підтвердження email: інструкція лишається, кабінет відкриється на першому вході (той самий checkUserAccess).
    assert.match(html, /Підтвердіть email за посиланням у листі, потім увійдіть\./);
});

// ---------- 2. Порожній стартовий рейс ----------
test('STARTER_TRIP: подача, км, тоннаж і норма ваги — нулі; решта як була', () => {
    assert.deepEqual(literal('STARTER_TRIP'), {
        'route-name': 'Демо: типовий рейс зерновоза',
        'podacha-dist': 0,
        dist: 0,
        volume: 0,
        'norm-weight': 0,
        'cars-count': 1,
        'days-per-trip': 1.5,
        rate: 1800
    });
    const settings = literal('STARTER_SETTINGS');
    assert.equal(settings.fuelLoad, 38);
    assert.equal(settings.fuelPrice, 95);
});

function sampleTrip(values, usedStarterTemplate = true) {
    const els = {};
    for (const [id, value] of Object.entries(values)) els[id] = { id, value: String(value), type: id === 'route-name' ? 'text' : 'number' };
    els['trailer-type'] = { value: '' };
    const factory = new Function('els', 'usedStarterTemplate', `
        const STARTER_TRIP = ${JSON.stringify(literal('STARTER_TRIP'))};
        const document = { getElementById: (id) => els[id] || null };
        ${functionSource(html, 'applySampleTripIfEmpty')}
        return applySampleTripIfEmpty;
    `);
    return { run: factory(els, usedStarterTemplate), els };
}

test('applySampleTripIfEmpty підставляє нулі; 0 — валідне значення, повторний виклик нічого не міняє і не зациклюється', () => {
    const empty = { 'route-name': '', 'podacha-dist': '', dist: '', volume: '', 'norm-weight': '', 'cars-count': '', 'days-per-trip': '', rate: '' };
    const t = sampleTrip(empty);
    t.run();
    for (const id of ['podacha-dist', 'dist', 'volume', 'norm-weight']) assert.equal(String(t.els[id].value), '0', id);
    assert.equal(String(t.els['cars-count'].value), '1');
    assert.equal(String(t.els['days-per-trip'].value), '1.5');
    assert.equal(String(t.els.rate.value), '1800');
    assert.equal(t.els['trailer-type'].value, 'зерновоз');
    const snapshot = JSON.stringify(t.els);
    t.run();
    assert.equal(JSON.stringify(t.els), snapshot, 'другий виклик: той самий результат');
    // Значення, яке користувач вже ввів, не затирається.
    const typed = sampleTrip({ ...empty, dist: '120', volume: '300' });
    typed.run();
    assert.equal(typed.els.dist.value, '120');
    assert.equal(typed.els.volume.value, '300');
    // Не новий акаунт (витрати заповнені) — шаблон не застосовується.
    const skipped = sampleTrip(empty, false);
    skipped.run();
    assert.equal(skipped.els.dist.value, '');
    assert.ok(functionSource(html, 'ensureStarterTemplate').includes('usedStarterTemplate = !hasCompanyCosts();'));
});

test('кнопка «Підставити демо-рейс» лишається прикладом із цифрами; гостьовий приклад лендингу не змінено', () => {
    const demo = functionSource(html, 'fillDemoTrip');
    assert.match(demo, /\{ 'podacha-dist': 40, dist: 350, volume: 500, 'norm-weight': 21\.5 \}/);
    assert.match(demo, /clearVehicleNormChoice\(\);/);
});

// ---------- 3. Режим «Сам»: без перемикача «Директор / Логіст» ----------
function header(initial) {
    const els = new Map();
    const make = (id) => {
        const classes = new Set();
        const attrs = {};
        return {
            id, hidden: false, textContent: '', title: '', style: {}, attrs,
            classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); }, contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
            setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, getAttribute: (k) => attrs[k] ?? null
        };
    };
    const get = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
    const store = new Map(initial.store || []);
    const factory = new Function('get', 'store', 'init', `
        const UI_VIEW_KEY = 'tc-ui-view';
        const document = { getElementById: get, body: get('body') };
        document.body.getAttribute = () => null;
        const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
        let currentOrgRole = init.role, currentWorkMode = init.mode, uiView = init.view, companyName = 'Test', currentUserEmail = 'a@b.c', teamState = null;
        const syncApprovalUi = () => {}, setStudioView = () => {}, roleLabel = () => '';
        ${functionSource(html, 'viewIsLogist')}
        ${functionSource(html, 'viewSwitchAllowed')}
        ${functionSource(html, 'viewLabel')}
        ${functionSource(html, 'headerInitials')}
        ${functionSource(html, 'syncHeaderChrome')}
        ${functionSource(html, 'setUiView')}
        return {
            sync: syncHeaderChrome, setUiView, viewIsLogist,
            setMode: (m) => { currentWorkMode = m; syncHeaderChrome(); },
            view: () => uiView
        };
    `);
    const api = factory(get, store, { role: initial.role || 'owner', mode: initial.mode || 'solo', view: initial.view || 'director' });
    return { ...api, get, store };
}

test('директор у режимі «Сам»: #tc-view-switch прихований цілком, вигляд логіста неможливий', () => {
    const h = header({ mode: 'solo' });
    h.sync();
    assert.equal(h.get('tc-view-switch').hidden, true);
    assert.equal(h.viewIsLogist(), false);
    assert.equal(h.get('tc-role-badge').textContent, 'Директор');
    assert.equal(h.get('tc-menu-role').textContent, 'Директор');
    h.setUiView('logist');
    assert.equal(h.viewIsLogist(), false, 'setUiView(logist) у solo ігнорується');
    assert.equal(h.view(), 'director');
});

test('у localStorage лишився вигляд «логіст» → у solo повертаємо «Директор» і чистимо збережене', () => {
    const h = header({ mode: 'solo', view: 'logist', store: [['tc-ui-view', 'logist']] });
    assert.equal(h.viewIsLogist(), false);
    h.sync();
    assert.equal(h.view(), 'director');
    assert.equal(h.store.get('tc-ui-view'), 'director');
    assert.equal(h.get('tc-view-switch').hidden, true);
    assert.equal(h.get('tc-role-badge').textContent, 'Директор');
    assert.equal(h.get('body').classList.contains('view-logist'), false);
});

test('перемикання компанії на «Є логісти» повертає перемикач, і кнопка «Логіст» працює', () => {
    const h = header({ mode: 'solo' });
    h.sync();
    assert.equal(h.get('tc-view-switch').hidden, true);
    h.setMode('team');
    assert.equal(h.get('tc-view-switch').hidden, false);
    h.setUiView('logist');
    assert.equal(h.viewIsLogist(), true);
    assert.equal(h.get('tc-role-badge').textContent, 'Логіст');
    assert.equal(h.get('tc-view-logist').attrs['aria-pressed'], 'true');
    h.setUiView('director');
    assert.equal(h.viewIsLogist(), false);
    // Назад у «Сам» — вигляд логіста знову скидається.
    h.setUiView('logist');
    h.setMode('solo');
    assert.equal(h.get('tc-view-switch').hidden, true);
    assert.equal(h.viewIsLogist(), false);
    assert.equal(h.get('tc-role-badge').textContent, 'Директор');
});

test('логіст за роллю лишається логістом, у «Сам» вкладки «Команда» немає, а вхід в командний режим є в профілі', () => {
    const logist = header({ role: 'logist', mode: 'team' });
    logist.sync();
    assert.equal(logist.viewIsLogist(), true);
    assert.equal(logist.get('tc-view-switch').hidden, true);
    assert.match(html, /if \(isOwner && currentWorkMode === 'team'\) tabs\.push\(\{ id: 'team', title: 'Команда' \}\);/);
    assert.match(html, /currentWorkMode === 'solo' && currentOrgRole === 'owner'/);
    // Зміна режиму у кабінеті перемальовує шапку (applyTeamModeUi → syncHeaderChrome).
    assert.match(functionSource(html, 'applyTeamModeUi'), /syncHeaderChrome\(\);/);
});
