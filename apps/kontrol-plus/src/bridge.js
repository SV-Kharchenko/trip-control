// Контроль+ поверх копії сайту trip-control.com: вкладки «Клієнти», «Звіт план/факт», «GPS», «Ремонти» і «Документи» у навігації сайту.
// Сайт працює як є (калькулятор, огляд, історія, кабінет, команда, тариф…); тут лише додаткові розділи CRM.
// Один клієнт Supabase на сторінку — той, що створив сайт (const supabaseClient у його класичному скрипті).
// Від яких id / класів сайту це залежить — README → «Залежності моста від сайту». Точка входу — site-bridge.js.
import { h, clear, spinner, notice, toast } from './ui.js';
import { errorText } from './lib/errors.js';
import { legacyRedirect, parseCrmHash, tabOf } from './lib/route.js';
import { navIcon } from './nav-icons.js';
import { ROLE_LABELS, crmAccess, crmPermissions, gpsAccess } from './lib/gate.js';
import { renderPaywall } from './views/paywall.js';
import { renderClients } from './views/clients.js';
import { renderClientCard } from './views/client-card.js';
import { renderClientForm } from './views/client-form.js';
import { renderReport } from './views/report.js';
import { renderGps } from './views/gps.js';
import { renderRepairs } from './views/repairs.js';
import { docsAccess, isMissingFeature } from './lib/docs.js';
import { paintRepairsBadge } from './views/repairs-maintenance.js';
import { repairsAccess } from './lib/repairs.js';
import { callKpApi } from './lib/gps-client.js';
import { kpVehiclesToSite, needsKpFleet } from './lib/site-fleet.js';

const SITE_URL = 'https://trip-control.com';

// Глобальна лексична змінна класичного скрипту сайту (не window.*): видно з модуля за імʼям.
function siteSupabase() {
    try {
        // eslint-disable-next-line no-undef
        return supabaseClient;
    } catch {
        return null;
    }
}

// repairs — kp_repairs_context() (етап 3a): менеджер з ремонтів має доступ лише до «Ремонтів» чужої організації.
// docs — чи є в базі функції документів (етап 4a): null — ще не перевіряли, false — міграцію не застосовано.
const state = { supabase: null, session: null, context: null, contextUser: null, route: null, repairs: null, docs: null };
// Прибирання розділу при виході / перемальовуванні (напр. map.remove() карти GPS).
let cleanups = [];
function runCleanups() {
    const list = cleanups;
    cleanups = [];
    for (const fn of list) {
        try {
            fn();
        } catch { /* прибирання не має ламати навігацію */ }
    }
}
let root = null;
const tabs = {};

function app() {
    return {
        supabase: state.supabase,
        context: state.context,
        user: state.session && state.session.user,
        ...crmPermissions(state.context),
        go: (hash) => { location.hash = hash; },
        repairs: state.repairs,
        // Бейдж ТО на вкладці «Ремонти»: з рядків, що вже завантажив розділ «ТО», або новим запитом.
        onMaintenance: (rows) => paintRepairsBadge(tabs.repairs, rows),
        refreshMaintenance: () => { loadRepairsBadge(); },
        onPlanLost: () => { state.context = null; syncGpsTab(); render(); },
        onCleanup: (fn) => { cleanups.push(fn); },
    };
}

// Вставляє вузол одразу після шапки (#sticky-top); без шапки в DOM — перед fallback.
export function insertAfterHeader(main, node, header, fallback) {
    main.insertBefore(node, header && header.nextSibling ? header.nextSibling : fallback);
}

// Пункти меню: порядок як у макеті. «Огляд» і «Розрахунки» ведуть на сторінки сайту, решта — на hash-маршрути Контроль+.
function go(hash) {
    return () => { location.hash = hash; };
}
function openSite(view) {
    return () => {
        leave();
        if (typeof setStudioView === 'function') setStudioView(view); // eslint-disable-line no-undef
    };
}
// [ключ, підпис, обробник, схований до перевірки доступу]
export const NAV_ITEMS = [
    ['overview', 'Огляд', openSite('overview'), false],
    ['calc', 'Розрахунки', openSite('calc'), false],
    ['clients', 'Клієнти', go('#/clients'), false],
    ['fleet', 'Автопарк', go('#/fleet'), true],
    ['drivers', 'Водії', go('#/drivers'), true],
    ['repairs', 'Ремонти', go('#/repairs'), true],
    ['gps', 'GPS', go('#/gps'), true],
    ['docs', 'Документи', go('#/docs'), true],
    ['report', 'План/факт', go('#/report'), false],
    ['stats', 'Статистика', go('#/stats'), false],
    ['company', 'Реквізити компанії', go('#/company'), true],
];

// Верх меню = низ шапки сайту, поки вона в кадрі (шапка пролистується, меню лишається біля верху вікна).
export function navTopPx(headBottom) {
    const n = Math.round(Number(headBottom));
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function syncNavTop() {
    const head = document.getElementById('sticky-top');
    if (!head || typeof head.getBoundingClientRect !== 'function') return;
    document.documentElement.style.setProperty('--kp-nav-top', navTopPx(head.getBoundingClientRect().bottom) + 'px');
}
// Висота шапки рахується одразу, ще раз після першого кадру і далі при будь-якій зміні розміру шапки (шрифти, перенос рядків).
function watchHeader() {
    syncNavTop();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncNavTop);
    const head = document.getElementById('sticky-top');
    if (head && typeof ResizeObserver === 'function') new ResizeObserver(syncNavTop).observe(head);
}

// Кнопки «Калькулятор» / «Огляд» / «Заявки» сайту гасимо самі, поки відкрито розділ Контроль+ (сайт підсвічує їх у applyTheme()).
function syncNav() {
    syncNavTop();
    const tab = tabOf(state.route);
    if (tab) document.body.setAttribute('data-kp-view', tab);
    else document.body.removeAttribute('data-kp-view');
    // Поза розділами Контроль+ підсвічуємо сайт: «Огляд» або «Розрахунки» (калькулятор з історією заявок).
    const siteView = document.body.getAttribute('data-studio-view');
    const active = tab || (siteView === 'overview' ? 'overview' : 'calc');
    const historyTab = document.getElementById('kp-calc-tab-history');
    const calcTab = document.getElementById('kp-calc-tab-calc');
    if (historyTab && calcTab) {
        historyTab.classList.toggle('on', siteView === 'history');
        calcTab.classList.toggle('on', siteView !== 'history');
    }
    for (const [name, button] of Object.entries(tabs)) {
        button.classList.toggle('on', name === active);
        if (name === active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    if (!tab) return;
    for (const id of ['studio-nav-calc', 'studio-nav-overview', 'studio-nav-history']) {
        const button = document.getElementById(id);
        if (button && button.classList.contains('on')) button.classList.remove('on');
    }
}

// «GPS» видно лише організаціям на control_plus (тариф «Компанія» вкладки не бачить).
function syncGpsTab() {
    if (!tabs.gps) return;
    const current = state.session && state.contextUser === state.session.user.id ? state.context : null;
    tabs.gps.hidden = !gpsAccess(current).visible;
    // «Ремонти» — за kp_repairs_context(); менеджеру з ремонтів без власного Контроль+ — лише ця вкладка.
    const repairs = repairsAccess(current ? state.repairs : null, current);
    if (tabs.repairs) tabs.repairs.hidden = !repairs.visible;
    // Менеджер з ремонтів чужої організації бачить лише «Ремонти»; решта розділів — як і раніше за ролями й тарифом.
    for (const key of ['clients', 'report', 'stats', 'overview', 'calc']) {
        if (tabs[key] && (repairs.repairsOnly || tabs[key].hidden)) tabs[key].hidden = repairs.repairsOnly;
    }
    // Документи, Автопарк, Водії, Реквізити компанії спираються на функції 4a/4b: з'являються після перевірки.
    const docsOn = docsAccess(current).visible && state.docs === true;
    for (const key of ['docs', 'fleet', 'drivers', 'company']) if (tabs[key]) tabs[key].hidden = !docsOn;
}

async function refreshGpsTab() {
    if (!state.session) {
        syncGpsTab();
        return;
    }
    if (!state.context || state.contextUser !== state.session.user.id) {
        try {
            await loadContext();
        } catch { /* вкладка лишається схованою */ }
    }
    syncGpsTab();
}

function leave() {
    runCleanups();
    if (!state.route) return;
    state.route = null;
    if (parseCrmHash(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    if (root) clear(root);
    syncNav();
}

async function loadContext() {
    const userId = state.session.user.id;
    const { data, error } = await state.supabase.rpc('kp_context');
    if (!state.session || state.session.user.id !== userId) return null;
    if (error) return { error };
    state.context = (data && data[0]) || { control_plus: false };
    state.repairs = await loadRepairsContext();
    state.contextUser = userId;
    // «Документи» — у фоні: вкладка зʼявиться, щойно база відповість, що функції 4a є.
    if (docsAccess(state.context).visible) loadDocsAvailability();
    else state.docs = false;
    // Бейдж — у фоні: статус ТО великого автопарку не має затримувати відкриття розділу.
    if (state.repairs) loadRepairsBadge();
    else paintRepairsBadge(tabs.repairs, []);
    return { context: state.context };
}

// Бейдж ТО (етап 3b): лише в Контроль+, без сповіщень. Без міграції 3b чи без доступу — без бейджа.
async function loadRepairsBadge() {
    if (!tabs.repairs || !state.session) return;
    const userId = state.session.user.id;
    let rows = [];
    try {
        const { data, error } = await state.supabase.rpc('kp_maintenance_status', { p_vehicle: null });
        if (!error) rows = data || [];
    } catch { /* без бейджа */ }
    if (state.session && state.session.user.id === userId) paintRepairsBadge(tabs.repairs, rows);
}

// «Фура» калькулятора: якщо сайт (RLS) не дав жодного авто, а Контроль+ дає, підставляємо парк із kp_vehicles_list.
async function topUpSiteFleet() {
    try {
        if (!state.supabase || !state.session) return;
        if (!state.context || state.contextUser !== state.session.user.id) await loadContext();
        // eslint-disable-next-line no-undef
        if (!needsKpFleet(fleetVehicles, state.context)) return;
        const { data, error } = await state.supabase.rpc('kp_vehicles_list');
        if (error || !Array.isArray(data) || !data.length) return;
        // eslint-disable-next-line no-undef
        fleetVehicles = kpVehiclesToSite(data);
        // eslint-disable-next-line no-undef
        if (typeof renderVehicleNormSelect === 'function') renderVehicleNormSelect();
    } catch { /* лишається порожній список, як було */ }
}

// Підміна loadFleetVehicles сайту доповнює його, а не замінює: власник і логіст отримують свої рядки як і раніше.
function patchSiteFleet() {
    const original = window.loadFleetVehicles;
    if (typeof original !== 'function' || original.kpPatched) return;
    const patched = async function (...args) {
        const result = await original.apply(this, args);
        await topUpSiteFleet();
        return result;
    };
    patched.kpPatched = true;
    window.loadFleetVehicles = patched;
}

async function loadDocsAvailability() {
    if (!state.session) return;
    const userId = state.session.user.id;
    let available = false;
    try {
        const { error } = await state.supabase.rpc('kp_doc_next_number', { p_kind: 'invoice', p_doc_date: new Date().toISOString().slice(0, 10) });
        available = !error || !isMissingFeature(error);
    } catch { /* без вкладки */ }
    if (!state.session || state.session.user.id !== userId) return;
    state.docs = available;
    syncGpsTab();
}

// null — розділу «Ремонти» немає (тариф «Компанія», не відповідальний або міграцію 3a ще не застосовано).
async function loadRepairsContext() {
    try {
        const { data, error } = await state.supabase.rpc('kp_repairs_context');
        const row = !error && data && data[0];
        return row && row.org_id ? row : null;
    } catch {
        return null;
    }
}

// Посилання-запрошення менеджера з ремонтів (?repair_invite=…). Параметр одразу прибираємо з URL. Без сесії токен
// чекає в localStorage (реєстрація з підтвердженням пошти відкриває сайт без параметра, часто в іншій вкладці), не довше
// за строк запрошення (7 днів). Після входу — accept; ключ видаляємо за будь-якої відповіді сервера. Токен не логуємо.
// Власна організація людини не змінюється.
export const REPAIR_INVITE_KEY = 'kp_repair_invite';
const REPAIR_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REPAIR_INVITE_LOGIN_HINT = 'Увійдіть або зареєструйтеся тією поштою, на яку прийшло запрошення. '
    + 'Після підтвердження пошти запрошення буде прийнято автоматично.';

function takeInviteFromUrl() {
    let url;
    try {
        url = new URL(location.href);
    } catch {
        return null;
    }
    const token = url.searchParams.get('repair_invite');
    if (!token) return null;
    url.searchParams.delete('repair_invite');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return token;
}

function storedInvite() {
    try {
        const raw = localStorage.getItem(REPAIR_INVITE_KEY);
        if (raw === null) return null;
        const saved = JSON.parse(raw);
        const age = Date.now() - Number(saved && saved.at);
        if (saved && typeof saved.token === 'string' && saved.token && age >= 0 && age < REPAIR_INVITE_TTL_MS) return saved.token;
        localStorage.removeItem(REPAIR_INVITE_KEY);
    } catch {
        try { localStorage.removeItem(REPAIR_INVITE_KEY); } catch { /* сховище заблоковане */ }
    }
    return null;
}

function forgetInvite() {
    try {
        if (localStorage.getItem(REPAIR_INVITE_KEY) !== null) localStorage.removeItem(REPAIR_INVITE_KEY);
    } catch { /* сховище заблоковане */ }
}

// Підказка поверх сайту (поза #kp-crm, який схований на сторінках сайту), закривається кнопкою.
function inviteHint(text, kind = 'info') {
    const old = document.getElementById('kp-invite-hint');
    const box = h('div', { id: 'kp-invite-hint', class: 'kp-invite-hint kp-invite-hint-' + kind, role: kind === 'error' ? 'alert' : 'status' },
        h('span', null, text),
        h('button', { type: 'button', class: 'kp-invite-hint-close', onclick: () => box.remove() }, 'Зрозуміло'));
    if (old) old.replaceWith(box);
    else document.body.append(box);
}

// Старт і onAuthStateChange можуть викликати це майже одночасно: поки accept у дорозі, другий виклик отримує той самий
// Promise — один запит kp_repair_invite_accept і одне видалення ключа.
let inviteInFlight = null;
function acceptRepairInvite() {
    if (!inviteInFlight) inviteInFlight = acceptRepairInviteOnce().finally(() => { inviteInFlight = null; });
    return inviteInFlight;
}

async function acceptRepairInviteOnce() {
    const fromUrl = takeInviteFromUrl();
    if (fromUrl && !state.session) {
        try {
            localStorage.setItem(REPAIR_INVITE_KEY, JSON.stringify({ token: fromUrl, at: Date.now() }));
        } catch { /* приватний режим: після входу посилання доведеться відкрити ще раз */ }
        inviteHint(REPAIR_INVITE_LOGIN_HINT);
        return;
    }
    if (!state.session) return;
    const token = fromUrl || storedInvite();
    if (!token) return;
    const out = await callKpApi({ supabase: state.supabase }, '/api/repairs/invites', { action: 'accept', token });
    // Відповідь сервера (успіх, 404 / 409 / 403) — ключ більше не потрібен; без мережі — спробуємо при наступному вході.
    if (!out.network) forgetInvite();
    if (!out.ok) {
        inviteHint(out.error || 'Не вдалося прийняти запрошення.', 'error');
        return;
    }
    const hint = document.getElementById('kp-invite-hint');
    if (hint) hint.remove();
    state.context = null;
    state.contextUser = null;
    await refreshGpsTab();
    toast('Ви — менеджер з ремонтів' + (out.org_name ? ' компанії «' + out.org_name + '»' : '') + '.');
    location.hash = '#/repairs';
}

function head() {
    const ctx = state.context;
    if (!ctx || !ctx.control_plus) return null;
    return h('div', { class: 'kp-who' },
        h('span', { class: 'kp-brand' }, 'Контроль', h('b', null, '+')),
        ctx.org_name ? h('span', { class: 'org' }, ctx.org_name) : null,
        ctx.role ? h('span', { class: 'badge badge-' + ctx.role }, ROLE_LABELS[ctx.role]) : null);
}

async function render() {
    const route = state.route;
    if (!route || !root) return;
    syncNav();
    if (!state.session) {
        clear(root, h('section', { class: 'page narrow' }, notice('Увійдіть, щоб відкрити розділ Контроль+.', 'info')));
        return;
    }
    if (!state.context || state.contextUser !== state.session.user.id) {
        clear(root, spinner('Перевіряємо доступ…'));
        const result = await loadContext();
        if (!result || state.route !== route) return;
        syncGpsTab();
        if (result.error) {
            clear(root, h('section', { class: 'page' }, notice(errorText(result.error)),
                h('button', { type: 'button', class: 'btn', onclick: render }, 'Спробувати ще')));
            return;
        }
    }
    const repairs = repairsAccess(state.repairs, state.context);
    if (route.view === 'repairs' && repairs.visible) {
        runCleanups();
        clear(root, head(), renderRepairs(app(), route.sub));
        root.focus({ preventScroll: true });
        window.scrollTo(0, 0);
        return;
    }
    if (crmAccess(state.context) !== 'open') {
        // Менеджер з ремонтів без власного Контроль+ — без екрана тарифу: одразу до «Ремонтів».
        if (repairs.repairsOnly) {
            location.hash = '#/repairs';
            return;
        }
        clear(root, renderPaywall({ context: state.context, siteUrl: SITE_URL }));
        return;
    }
    runCleanups();
    let view;
    if (route.view === 'repairs') view = h('section', { class: 'page' }, notice('Розділ «Ремонти» ще не ввімкнено для вашої компанії.', 'info'));
    else if (route.view === 'docs') view = lazyView(() => import('./views/docs.js').then((m) => m.renderDocs(app(), route)));
    else if (route.view === 'report') {
        view = renderReport(app(), route.sub, route.sub === 'debts'
            ? lazyView(() => import('./views/docs-debts.js').then((m) => m.renderDebts(app()))) : null);
    } else if (route.view === 'fleet') view = lazyView(() => import('./views/fleet.js').then((m) => m.renderFleetPage(app(), route.sub)));
    else if (route.view === 'drivers') view = lazyView(() => import('./views/drivers.js').then((m) => m.renderDrivers(app())));
    else if (route.view === 'company') view = lazyView(() => import('./views/company.js').then((m) => m.renderCompany(app())));
    else if (route.view === 'stats') view = lazyView(() => import('./views/stats.js').then((m) => m.renderStats(app())));
    else if (route.view === 'client-new') view = renderClientForm(app(), null);
    else if (route.view === 'client-edit') view = renderClientForm(app(), route.id);
    else if (route.view === 'client') view = renderClientCard(app(), route.id);
    else if (route.view === 'gps') view = renderGps(app());
    else view = renderClients(app());
    clear(root, head(), view);
    root.focus({ preventScroll: true });
    window.scrollTo(0, 0);
}

// Розділ окремим чанком (вантажиться при першому відкритті): «Документи» не збільшують основний бандл.
function lazyView(load) {
    const box = h('div', null, spinner());
    load().then((el) => {
        if (box.isConnected) box.replaceWith(el);
    }, () => {
        clear(box, h('section', { class: 'page' }, notice('Не вдалося завантажити розділ. Оновіть сторінку.')));
    });
    return box;
}

function onHash() {
    // Старі підвкладки «Документів» переїхали: Авто й водії → Автопарк, Реквізити → Реквізити компанії, Борги → План/факт.
    const moved = legacyRedirect(location.hash);
    if (moved) history.replaceState(null, '', location.pathname + location.search + moved);
    const route = parseCrmHash(moved || location.hash);
    if (!route) {
        leave();
        return;
    }
    state.route = route;
    render();
}

function mount() {
    const nav = document.querySelector('#tc-nav-panel .tc-studio-nav');
    const main = document.getElementById('main-app');
    if (!nav || !main) return false;
    // Ліве вертикальне меню замість кнопок у навігації сайту (на ≤1024 — лише іконки з підказками).
    for (const [key, label, onclick, hidden] of NAV_ITEMS) {
        const button = h('button', { type: 'button', id: 'kp-nav-' + key, title: label, onclick }, navIcon(key), h('span', { class: 'lb' }, label));
        button.kpIcon = button.children[0];
        if (hidden) button.hidden = true;
        tabs[key] = button;
    }
    const side = h('aside', { id: 'kp-side', class: 'kp-side', 'aria-label': 'Меню кабінету' },
        h('nav', { id: 'kp-nav-list', class: 'kp-nav' }, NAV_ITEMS.map(([key]) => tabs[key])));
    if (main.parentNode && typeof main.parentNode.insertBefore === 'function') main.parentNode.insertBefore(side, main);
    else document.body.append(side);
    document.body.classList.add('kp-nav-on');
    watchHeader();
    window.addEventListener('scroll', syncNavTop, { passive: true });
    window.addEventListener('resize', syncNavTop);
    root = h('section', { id: 'kp-crm', class: 'kp-crm', 'aria-label': 'Контроль+', tabindex: '-1' });
    main.insertBefore(root, document.getElementById('studio-overview'));
    // «Розрахунок» і «Заявки» — вкладки всередині «Розрахунків» (кнопки з верхньої шапки сайту прибрано, щоб не дублювати меню).
    const calcTabs = h('nav', { id: 'kp-calc-tabs', class: 'kp-calc-tabs', 'aria-label': 'Розрахунки' },
        h('button', { type: 'button', id: 'kp-calc-tab-calc', onclick: openSite('calc') }, 'Розрахунок'),
        h('button', { type: 'button', id: 'kp-calc-tab-history', onclick: openSite('history') }, 'Заявки'));
    // Одразу під шапкою, над калькулятором (#studio-columns сайт перебудовує, тому прив'язуємось до шапки, а не до нього).
    insertAfterHeader(main, calcTabs, document.getElementById('sticky-top'), root);
    // «Калькулятор» / «Огляд» / логотип / «Історія» з меню — усе, що кличе setStudioView() сайту, закриває розділ Контроль+.
    // Зміна розділу сайту: закриваємо розділ Контроль+ і завжди перемальовуємо підсвітку (leave() без відкритого розділу нічого не робить).
    new MutationObserver((records) => {
        if (records.some((r) => r.attributeName === 'data-studio-view')) leave();
        syncNav();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-studio-view', 'data-theme'] });
    syncNav();
    return true;
}

// Старий окремий застосунок Контроль+ тримав власну сесію під цим ключем; тепер сесія — лише сайту (sb-…-auth-token).
export const LEGACY_SESSION_KEY = 'kp-auth';

function dropLegacySession() {
    try {
        if (localStorage.getItem(LEGACY_SESSION_KEY) !== null) localStorage.removeItem(LEGACY_SESSION_KEY);
    } catch { /* приватний режим / заблоковане сховище */ }
}

// true — вкладки додано; false — сайт без потрібних вузлів або без supabaseClient: нічого не змінюємо, сайт працює як є.
export async function startBridge() {
    dropLegacySession();
    state.supabase = siteSupabase();
    if (!state.supabase || !mount()) {
        console.warn('[kontrol-plus] site-bridge: немає supabaseClient або навігації сайту — вкладки Контроль+ не додано');
        return false;
    }
    const { data } = await state.supabase.auth.getSession();
    state.session = data.session;
    state.supabase.auth.onAuthStateChange((event, session) => {
        const changedUser = (state.session && state.session.user.id) !== (session && session.user.id);
        state.session = session;
        if (event === 'SIGNED_OUT' || changedUser) {
            state.context = null;
            state.contextUser = null;
            state.repairs = null;
            state.docs = null;
            syncGpsTab();
            // Supabase не можна кликати прямо з колбеку onAuthStateChange.
            if (state.route) setTimeout(render, 0);
            else if (session) setTimeout(refreshGpsTab, 0);
            if (session) setTimeout(acceptRepairInvite, 0);
        }
    });
    window.addEventListener('hashchange', onHash);
    onHash();
    patchSiteFleet();
    if (!state.route) await refreshGpsTab();
    await topUpSiteFleet();
    await acceptRepairInvite();
    return true;
}
