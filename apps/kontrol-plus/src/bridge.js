// Контроль+ поверх копії сайту trip-control.com: вкладки «Клієнти», «Звіт план/факт», «GPS», «Ремонти» і «Документи» у навігації сайту.
// Сайт працює як є (розрахунок рейсу, огляд, історія, кабінет, команда, тариф…); тут лише додаткові розділи CRM.
// Один клієнт Supabase на сторінку — той, що створив сайт (const supabaseClient у його класичному скрипті).
// Від яких id / класів сайту це залежить — README → «Залежності моста від сайту». Точка входу — site-bridge.js.
import { h, clear, spinner, notice, toast } from './ui.js';
import { errorText } from './lib/errors.js';
import { cardParentHash, legacyRedirect, ownFleetParentHash, parseCrmHash, tabOf, windowSpecOf } from './lib/route.js';
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
import { ownFleetAccess, ownFleetOnly } from './lib/own-fleet-gate.js';
import { createRequesterInviteAcceptor } from './lib/own-fleet-invite.js';
import { callKpApi } from './lib/gps-client.js';
import { kpVehiclesToSite, needsKpFleet } from './lib/site-fleet.js';
import { mountShell } from './shell.js';
import { mountMobile } from './kp-mobile.js';
import { createWindowManager } from './kp-windows.js';
import { renderRequestWindow } from './views/request-window.js';

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

// repairs — kp_repairs_context() (етап 3a): відповідальний за ремонти має доступ лише до «Ремонтів» чужої організації.
// docs — чи є в базі функції документів (етап 4a): null — ще не перевіряли, false — міграцію не застосовано.
// ownFleet — own_fleet_context() («Власний парк»): null без прапорця own_fleet в організації; сам модуль — lazy-чанк views/own-fleet/.
const state = { supabase: null, session: null, context: null, contextUser: null, route: null, repairs: null, docs: null, ownFleet: null };
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
        // Розділи сайту (розрахунок рейсу, реєстр, «Огляд компанії») для дашборда: ті самі кнопки, що й меню (leave() + setStudioView).
        openSite: (view) => openSite(view)(),
        repairs: state.repairs,
        ownFleet: state.ownFleet,
        // Бейдж ТО на вкладці «Ремонти»: з рядків, що вже завантажив розділ «ТО», або новим запитом.
        onMaintenance: (rows) => paintRepairsBadge(tabs.repairs, rows),
        refreshMaintenance: () => { loadRepairsBadge(); },
        onPlanLost: () => { state.context = null; window.tcKpRole = null; window.tcKpOrgId = null; window.tcKpOrgName = null; syncGpsTab(); render(); },
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
    ['overview', 'Огляд', go('#/dashboard'), false],
    ['calc', 'Розрахунки', openSite('calc'), false],
    ['clients', 'Клієнти', go('#/clients'), false],
    ['fleet', 'Автопарк', go('#/fleet'), true],
    ['drivers', 'Водії', go('#/drivers'), true],
    ['repairs', 'Ремонти', go('#/repairs'), true],
    ['own_fleet', 'Власний парк', go('#/own-fleet'), true],
    ['gps', 'GPS', go('#/gps'), true],
    ['docs', 'Документи', go('#/docs'), true],
    ['report', 'План/факт', go('#/report'), false],
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

// Кнопки «Розрахунок рейсу» / «Огляд» / «Заявки» сайту гасимо самі, поки відкрито розділ Контроль+ (сайт підсвічує їх у applyTheme()).
function syncNav() {
    syncNavTop();
    const tab = tabOf(state.route);
    if (tab) document.body.setAttribute('data-kp-view', tab);
    else document.body.removeAttribute('data-kp-view');
    // Поза розділами Контроль+ підсвічуємо сайт: «Огляд» або «Розрахунки» (розрахунок рейсу з історією заявок).
    const siteView = document.body.getAttribute('data-studio-view');
    const active = tab === 'dashboard' ? 'overview' : tab || (siteView === 'overview' ? 'overview' : 'calc');
    const historyTab = document.getElementById('kp-calc-tab-history');
    const calcTab = document.getElementById('kp-calc-tab-calc');
    const registryTab = document.getElementById('kp-calc-tab-registry');
    if (historyTab && calcTab) {
        historyTab.classList.toggle('on', siteView === 'history');
        calcTab.classList.toggle('on', siteView !== 'history' && siteView !== 'registry');
        if (registryTab) registryTab.classList.toggle('on', siteView === 'registry');
    }
    for (const [name, button] of Object.entries(tabs)) {
        button.classList.toggle('on', name === active);
        if (name === active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    if (!tab) return;
    for (const id of ['studio-nav-calc', 'studio-nav-overview', 'studio-nav-history', 'studio-nav-registry']) {
        const button = document.getElementById(id);
        if (button && button.classList.contains('on')) button.classList.remove('on');
    }
}

// «GPS» видно лише організаціям на control_plus (тариф «Компанія» вкладки не бачить).
function syncGpsTab() {
    if (!tabs.gps) return;
    const current = state.session && state.contextUser === state.session.user.id ? state.context : null;
    tabs.gps.hidden = !gpsAccess(current).visible;
    // «Ремонти» — за kp_repairs_context(); відповідальному за ремонти без власного Контроль+ — лише ця вкладка.
    const repairs = repairsAccess(current ? state.repairs : null, current);
    if (tabs.repairs) tabs.repairs.hidden = !repairs.visible;
    // Відповідальний за ремонти чужої організації бачить лише «Ремонти»; решта розділів — як і раніше за ролями й тарифом.
    for (const key of ['clients', 'report', 'overview', 'calc']) {
        if (tabs[key] && (repairs.repairsOnly || tabs[key].hidden)) tabs[key].hidden = repairs.repairsOnly;
    }
    // Документи, Автопарк, Водії спираються на функції 4a/4b: з'являються після перевірки.
    const docsOn = docsAccess(current).visible && state.docs === true;
    for (const key of ['docs', 'fleet', 'drivers']) if (tabs[key]) tabs[key].hidden = !docsOn;
    // «Власний парк» — лише з прапорцем own_fleet; замовник підрозділу без власного Контроль+ бачить тільки цю вкладку.
    const fleetAccess = ownFleetAccess(current ? state.ownFleet : null);
    if (tabs.own_fleet) tabs.own_fleet.hidden = !fleetAccess.enabled;
    if (ownFleetOnly(fleetAccess, current)) for (const key of Object.keys(tabs)) if (key !== 'own_fleet') tabs[key].hidden = true;
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
    // Роль у Контроль+ (owner / logist / director) для сторінки сайту: «Реєстр заявок» показує кнопки директору з org_directors.
    window.tcKpRole = state.context.role || null;
    window.tcKpOrgId = state.context.org_id || null;
    // Каркас CRM (shell.js): назва компанії для верхньої панелі; подія перемальовує роль, пункти меню й лічильники.
    window.tcKpOrgName = state.context.org_name || null;
    state.ownFleet = await loadOwnFleetContext();
    syncWindowsScope();
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('tc:kp-context'));
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

// «Фура» розрахунку рейсу: якщо сайт (RLS) не дав жодного авто, а Контроль+ дає, підставляємо парк із kp_vehicles_list.
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

// Підміна loadFleetVehicles сайту доповнює його, а не замінює: owner і логіст отримують свої рядки як і раніше.
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

// null — модуль «Власний парк» вимкнено (немає прапорця own_fleet), доступу немає або міграцію ще не застосовано.
async function loadOwnFleetContext() {
    try {
        const { data, error } = await state.supabase.rpc('own_fleet_context');
        const row = !error && data && data[0];
        return row && row.org_id ? row : null;
    } catch {
        return null;
    }
}

// Запрошення замовника підрозділу (?requester_invite=…): логіка в lib/own-fleet-invite.js.
let requesterAcceptor = null;
const acceptRequesterInvite = () => {
    if (!requesterAcceptor) {
        requesterAcceptor = createRequesterInviteAcceptor({
            win: window,
            storage: { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v), removeItem: (k) => localStorage.removeItem(k) },
            hasSession: () => Boolean(state.session),
            call: (path, body) => callKpApi({ supabase: state.supabase }, path, body),
            hint: (text, kind) => inviteHint(text, kind),
            onAccepted: async (orgName) => {
                const hint = document.getElementById('kp-invite-hint');
                if (hint) hint.remove();
                state.context = null; state.contextUser = null; state.ownFleet = null;
                await refreshGpsTab();
                toast('Ви — замовник підрозділу' + (orgName ? ' компанії «' + orgName + '»' : '') + '.');
                location.hash = '#/own-fleet';
            },
        });
    }
    return requesterAcceptor();
};

// Посилання-запрошення відповідального за ремонти (?repair_invite=…). Параметр одразу прибираємо з URL. Без сесії токен
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
    state.context = null; window.tcKpRole = null; window.tcKpOrgId = null; window.tcKpOrgName = null;
    state.contextUser = null;
    await refreshGpsTab();
    toast('Ви — відповідальний за ремонти' + (out.org_name ? ' компанії «' + out.org_name + '»' : '') + '.');
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
    const fleet = ownFleetAccess(state.ownFleet);
    if (route.view === 'own-fleet' || route.view === 'own-fleet-card') {
        if (!fleet.enabled) {
            // Без прапорця own_fleet розділу не існує: прямий URL веде на огляд.
            location.hash = '#/dashboard';
            return;
        }
        runCleanups();
        clear(root, head(), lazyView(() => import('./views/own-fleet/index.js').then((m) => m.renderOwnFleet(app(), route))));
        root.focus({ preventScroll: true });
        window.scrollTo(0, 0);
        return;
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
        // Відповідальний за ремонти без власного Контроль+ — без екрана тарифу: одразу до «Ремонтів».
        if (repairs.repairsOnly) {
            location.hash = '#/repairs';
            return;
        }
        if (ownFleetOnly(fleet, state.context)) {
            location.hash = '#/own-fleet';
            return;
        }
        clear(root, renderPaywall({ context: state.context, siteUrl: SITE_URL }));
        return;
    }
    runCleanups();
    let view;
    if (route.view === 'repairs') view = h('section', { class: 'page' }, notice('Розділ «Ремонти» ще не ввімкнено для вашої компанії.', 'info'));
    else if (route.view === 'dashboard') view = lazyView(() => import('./views/dashboard.js').then((m) => m.renderDashboard(app())));
    else if (route.view === 'docs') view = lazyView(() => import('./views/docs.js').then((m) => m.renderDocs(app(), route)));
    else if (route.view === 'report') {
        view = renderReport(app(), route.sub, route.sub === 'debts'
            ? lazyView(() => import('./views/docs-debts.js').then((m) => m.renderDebts(app()))) : null);
    } else if (route.view === 'fleet') view = lazyView(() => import('./views/fleet.js').then((m) => m.renderFleetPage(app(), route.sub)));
    else if (route.view === 'drivers') view = lazyView(() => import('./views/drivers.js').then((m) => m.renderDrivers(app())));
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

// «Реквізити» і «Статистика» — вкладки «Особистого кабінету» сайту (index.html шле tc:cabinet-tab). Сайт лишає в слоті підказку,
// а тут, коли є доступ Контроль+, слот заповнюється тим самим екраном, що раніше був окремою сторінкою.
const SLOT_IDS = { requisites: 'cab-req-slot', stats: 'cab-stats-slot' };
let slotTicket = 0;
export async function fillCabinetSlot(tab) {
    const slot = SLOT_IDS[tab] && document.getElementById(SLOT_IDS[tab]);
    if (!slot || !state.session) return;
    const ticket = ++slotTicket;
    const stale = () => ticket !== slotTicket || !slot.isConnected;
    clear(slot, spinner('Перевіряємо доступ…'));
    if (!state.context || state.contextUser !== state.session.user.id) {
        const result = await loadContext();
        if (stale()) return;
        syncGpsTab();
        if (result && result.error) {
            clear(slot, notice(errorText(result.error)));
            return;
        }
    }
    if (crmAccess(state.context) !== 'open') {
        clear(slot, notice('Цей розділ доступний на тарифі Контроль+.', 'info'));
        return;
    }
    runCleanups();
    try {
        if (tab === 'requisites') {
            if (state.docs === null) await loadDocsAvailability();
            if (stale()) return;
            if (!docsAccess(state.context).visible || state.docs !== true) {
                clear(slot, notice('Реквізити ще не ввімкнено для вашої компанії.', 'info'));
                return;
            }
            const view = await import('./views/company.js').then((m) => m.renderCabinetRequisites(app()));
            if (!stale()) clear(slot, view);
        } else {
            const view = await import('./views/stats.js').then((m) => m.renderStats(app()));
            if (!stale()) clear(slot, view);
        }
    } catch {
        if (!stale()) clear(slot, notice('Не вдалося завантажити розділ. Оновіть сторінку.'));
    }
}

// «Команда» кабінету: в організації з own_fleet директор і менеджер бачать блок «Замовники підрозділів» (після таблиці команди сайту).
// Блок вставляється з боку моста: сайт (index.html) не змінюється. Без прапорця чи без прав блоку немає (старий прибирається).
let teamTicket = 0;
export async function fillRequestersBlock() {
    const list = document.getElementById('team-members-list');
    const host = list && (list.closest('.cab-card') || list.parentElement);
    let slot = document.getElementById('cab-requesters-slot');
    if (!host || !state.session) { if (slot) slot.remove(); return; }
    const ticket = ++teamTicket;
    if (!state.context || state.contextUser !== state.session.user.id) await loadContext();
    const access = ownFleetAccess(state.ownFleet);
    const allowed = access.enabled && (access.role === 'owner' || access.role === 'director');
    if (ticket !== teamTicket) return;
    if (!allowed) { if (slot) slot.remove(); return; }
    if (!slot) {
        slot = h('div', { id: 'cab-requesters-slot', class: 'cab-slot' });
        host.after(slot);
    }
    try {
        const module = await import('./views/own-fleet/index.js');
        if (ticket === teamTicket) clear(slot, module.renderRequestersBlock(app()));
    } catch {
        clear(slot, notice('Не вдалося завантажити блок «Замовники підрозділів». Оновіть сторінку.'));
    }
}

function onCabinetTab(event) {
    const tab = event && event.detail && event.detail.tab;
    if (tab === 'requisites' || tab === 'stats') fillCabinetSlot(tab);
    if (tab === 'team') fillRequestersBlock();
}

// ===== Вікна поверх розділу (PR 3): картки документів, форми, клієнт, заявка. Лише Контроль+ ≥900px (createWindowManager сам вирішує). =====
let windows = null;
let coldStart = true;
const WINDOW_TITLES = {
    doc: 'Документ', ttn: 'ТТН', trip_sheet: 'Подорожній лист', form: 'Новий документ', client: 'Клієнт', client_form: 'Клієнт', request: 'Заявка',
    vehicle: 'Авто', trailer: 'Причіп', driver: 'Водій', of_request: 'Заявка на рейс', of_unit: 'Підрозділ', of_point: 'Точка',
};

// Те саме, що app(), але навігація зсередини вікна: заміна вікна (після збереження форми), а не перемальовування розділу.
function winApp(ctl) {
    return {
        ...app(), go: (hash) => windowGo(ctl, hash), onCleanup: (fn) => ctl.onClose(fn),
        // Закрити вікно картки (авто, причіп, водій) без переходу; changed — список під вікном перечитується.
        closeWindow: (changed) => ctl.close({ force: true }).then(() => { if (changed) window.dispatchEvent(new CustomEvent('kp:registry-changed')); }),
    };
}
function windowGo(ctl, hash) {
    ctl.close({ force: true }).then(() => {
        // Той самий hash (напр. список після видалення): події hashchange не буде, тож перемальовуємо розділ самі.
        if (location.hash === hash) onHash();
        else location.hash = hash;
    });
}

async function buildWindow(type, id, container, ctl) {
    clear(container, spinner('Завантаження…'));
    if (!state.session) {
        clear(container, notice('Увійдіть, щоб відкрити розділ Контроль+.', 'info'));
        return;
    }
    if (!state.context || state.contextUser !== state.session.user.id) {
        const result = await loadContext();
        if (result && result.error) { clear(container, notice(errorText(result.error))); return; }
    }
    // «Власний парк»: картки заявки, підрозділу й точки; доступ за прапорцем own_fleet, не за тарифом (замовник підрозділу без Контроль+).
    if (type.startsWith('of_')) {
        if (!ownFleetAccess(state.ownFleet).enabled) { clear(container, notice('Розділ «Власний парк» не ввімкнено для вашої компанії.', 'info')); return; }
        if (container.classList && typeof container.classList.add === 'function') container.classList.add('kpr-page', 'kpg-page');
        const view = (await import('./views/own-fleet/index.js')).renderOwnFleetCard(winApp(ctl), type.slice(3), id || null);
        clear(container, view);
        ctl.titleFrom(container);
        return;
    }
    if (crmAccess(state.context) !== 'open') {
        clear(container, notice('Цей розділ доступний на тарифі Контроль+.', 'info'));
        return;
    }
    if (type === 'request') {
        await renderRequestWindow(container, id, ctl);
        return;
    }
    const a = winApp(ctl);
    // Той самий каркас сторінки, що й у розділі (docs.js / реєстр): його класи дають вікну ті самі правила полів, кнопок і таблиць.
    if (container.classList && typeof container.classList.add === 'function') {
        if (['doc', 'ttn', 'trip_sheet', 'form'].includes(type)) container.classList.add('kpr-page', 'kpd-page');
        else if (['vehicle', 'trailer', 'driver'].includes(type)) container.classList.add('kpr-page', 'kpg-page');
    }
    let view;
    if (type === 'client') view = renderClientCard(a, id);
    else if (type === 'vehicle' || type === 'trailer') view = await (await import('./views/fleet.js')).renderFleetCardWindow(a, type, id || null);
    else if (type === 'driver') view = await (await import('./views/drivers.js')).renderDriverCardWindow(a, id || null);
    else if (type === 'client_form') view = renderClientForm(a, id || null);
    else {
        if (state.docs === null) await loadDocsAvailability();
        const access = docsAccess(state.context);
        if (!access.visible || state.docs !== true) {
            clear(container, notice('Документи ще не ввімкнено для вашої компанії.', 'info'));
            return;
        }
        if (type === 'doc') view = (await import('./views/docs-card.js')).renderDocCard(a, access, id);
        else if (type === 'ttn') view = (await import('./views/docs-ttn-card.js')).renderTtnCard(a, access, id);
        else if (type === 'trip_sheet') view = (await import('./views/docs-ts-card.js')).renderTripSheetCard(a, access, id);
        else {
            const route = parseCrmHash(id);
            if (!route || route.view !== 'docs' || route.sub !== 'new') { clear(container, notice('Не вдалося відкрити форму.')); return; }
            if (!access.canWrite) view = notice('Створювати документи можуть директор і логіст.', 'info');
            else if (route.kind === 'ttn') view = (await import('./views/docs-ttn-form.js')).renderTtnForm(a, access, route);
            else if (route.kind === 'trip_sheet') view = (await import('./views/docs-ts-form.js')).renderTripSheetForm(a, access, route);
            else view = (await import('./views/docs-form.js')).renderDocForm(a, access, route);
        }
    }
    clear(container, view);
    ctl.titleFrom(container);
}

// spec вікна за маршрутом (або за елементом збереженого стану): ключ, тип, id і функція монтування.
function toWindowSpec(base) {
    return { ...base, title: WINDOW_TITLES[base.type] || 'Вікно', build: (container, ctl) => buildWindow(base.type, base.id, container, ctl) };
}
function specFromItem(item) {
    if (item.type === 'form') {
        const route = parseCrmHash(item.id);
        const base = windowSpecOf(route, item.id);
        return base ? toWindowSpec(base) : null;
    }
    const keyed = { doc: 'doc', ttn: 'ttn', trip_sheet: 'trip_sheet', client: 'client', request: 'request', client_form: 'client_form', vehicle: 'vehicle', trailer: 'trailer', driver: 'driver', of_request: 'of_request', of_unit: 'of_unit', of_point: 'of_point' }[item.type];
    if (!keyed) return null;
    return toWindowSpec({ type: item.type, id: item.id, key: item.type + ':' + (!item.id && ['client_form', 'vehicle', 'trailer', 'driver', 'of_request', 'of_unit', 'of_point'].includes(item.type) ? 'new' : item.id) });
}

// Пара компанія / користувач змінилась → усі вікна закриваються; для нової пари відновлюється збережений список (sessionStorage).
function syncWindowsScope() {
    if (!windows) return;
    const orgId = (state.context && state.context.org_id) || (state.ownFleet && state.ownFleet.org_id);
    const userId = state.session && state.session.user && state.session.user.id;
    windows.setScope(orgId || null, userId || null, specFromItem).catch(() => {});
}

// Розділ за замовчуванням під вікном при прямому заході за посиланням: Реєстр заявок (наявна кнопка вкладки).
function openDefaultSection() {
    const tab = document.getElementById('kp-calc-tab-registry');
    if (tab && typeof tab.click === 'function') tab.click();
}

function onHash() {
    // Старі підвкладки «Документів» переїхали: Авто й водії → Автопарк, Реквізити → Реквізити компанії, Борги → План/факт.
    const moved = legacyRedirect(location.hash);
    if (moved) history.replaceState(null, '', location.pathname + location.search + moved);
    let route = parseCrmHash(moved || location.hash);
    if (route && cardParentHash(route) && !(windows && windows.enabled())) {
        // Вікон немає (вузький екран): картка авто / причепа / водія вікном не відкривається — лишається список.
        const parent = cardParentHash(route);
        history.replaceState(null, '', location.pathname + location.search + parent);
        route = parseCrmHash(parent);
    }
    if (route && route.view === 'request' && !(windows && windows.enabled())) {
        // Вікон немає (вузький екран): заявка відкривається, як раніше, — у розрахунку рейсу.
        history.replaceState(null, '', location.pathname + location.search);
        if (typeof window.openRegistryRow === 'function') window.openRegistryRow(route.id);
        return;
    }
    if (windows) {
        const base = windowSpecOf(route, location.hash);
        // Прямий захід за посиланням на вікно: під ним розділ за замовчуванням.
        if (base && coldStart && !state.route && windows.count() === 0 && windows.enabled()) {
            const parent = cardParentHash(route) || ownFleetParentHash(route);
            if (parent) {
                // Картка авто / причепа / водія / «Власного парку»: під вікном — його список.
                state.route = parseCrmHash(parent);
                render();
            } else openDefaultSection();
        }
        const handled = windows.handleHash(location.hash, base ? toWindowSpec(base) : null);
        coldStart = false;
        if (handled) return;
    }
    coldStart = false;
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
        h('button', { type: 'button', id: 'kp-calc-tab-calc', onclick: openSite('calc') }, 'Розрахунок рейсу'),
        h('button', { type: 'button', id: 'kp-calc-tab-history', onclick: openSite('history') }, 'Заявки'),
        h('button', { type: 'button', id: 'kp-calc-tab-registry', onclick: openSite('registry') }, 'Реєстр заявок'));
    // Одразу під шапкою, над розрахунком рейсу (#studio-columns сайт перебудовує, тому прив'язуємось до шапки, а не до нього).
    insertAfterHeader(main, calcTabs, document.getElementById('sticky-top'), root);
    // «Розрахунок рейсу» / «Огляд» / логотип / «Історія» з меню — усе, що кличе setStudioView() сайту, закриває розділ Контроль+.
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
    mountShell({ supabase: state.supabase });
    mountMobile();
    windows = createWindowManager({
        storage: (() => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; } })(),
        // Підтвердження закриття «брудної» форми — наявний діалог сайту (tcModal), не confirm().
        confirm: (options) => {
            if (typeof tcModal !== 'function') return Promise.resolve({ ok: true }); // eslint-disable-line no-undef
            const answer = tcModal(options); // eslint-disable-line no-undef
            // Небезпечна дія («Закрити без збереження», «Видалити»): фокус на «Скасувати», щоб Enter не підтвердив її випадково; Esc теж скасовує.
            const cancel = options && options.danger ? document.querySelector('.tc-modal [data-act="cancel"]') : null;
            if (cancel && typeof cancel.focus === 'function') cancel.focus();
            return answer;
        },
        notify: (text) => toast(text),
    });
    window.kpWindowsOn = () => !!(windows && windows.enabled());
    state.supabase.auth.onAuthStateChange((event, session) => {
        const changedUser = (state.session && state.session.user.id) !== (session && session.user.id);
        state.session = session;
        if (event === 'SIGNED_OUT' || changedUser) {
            state.context = null; window.tcKpRole = null; window.tcKpOrgId = null; window.tcKpOrgName = null;
            state.contextUser = null;
            state.repairs = null;
            state.ownFleet = null;
            state.docs = null;
            if (windows) windows.setScope(null, null).catch(() => {});
            syncGpsTab();
            // Supabase не можна кликати прямо з колбеку onAuthStateChange.
            if (state.route) setTimeout(render, 0);
            else if (session) setTimeout(refreshGpsTab, 0);
            if (session) setTimeout(acceptRepairInvite, 0);
            if (session) setTimeout(acceptRequesterInvite, 0);
        }
    });
    window.addEventListener('hashchange', onHash);
    window.addEventListener('tc:cabinet-tab', onCabinetTab);
    onHash();
    // Кабінет міг відкритися на «Реквізитах» (#/cabinet/requisites) раніше, ніж міст був готовий.
    const openTab = document.querySelector && document.querySelector('#cabinet-screen .cab-tab.active');
    if (openTab && SLOT_IDS[openTab.getAttribute('data-tab')]) fillCabinetSlot(openTab.getAttribute('data-tab'));
    if (openTab && openTab.getAttribute('data-tab') === 'team') fillRequestersBlock();
    patchSiteFleet();
    if (!state.route) await refreshGpsTab();
    await topUpSiteFleet();
    await acceptRepairInvite();
    await acceptRequesterInvite();
    return true;
}
