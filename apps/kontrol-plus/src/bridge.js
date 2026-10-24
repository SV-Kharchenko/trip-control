// Контроль+ поверх копії сайту trip-control.com: вкладки «Клієнти», «Звіт план/факт», «GPS» і «Ремонти» у навігації сайту.
// Сайт працює як є (калькулятор, огляд, історія, кабінет, команда, тариф…); тут лише додаткові розділи CRM.
// Один клієнт Supabase на сторінку — той, що створив сайт (const supabaseClient у його класичному скрипті).
// Від яких id / класів сайту це залежить — README → «Залежності моста від сайту». Точка входу — site-bridge.js.
import { h, clear, spinner, notice, toast } from './ui.js';
import { errorText } from './lib/errors.js';
import { parseCrmHash, tabOf } from './lib/route.js';
import { ROLE_LABELS, crmAccess, crmPermissions, gpsAccess } from './lib/gate.js';
import { renderPaywall } from './views/paywall.js';
import { renderClients } from './views/clients.js';
import { renderClientCard } from './views/client-card.js';
import { renderClientForm } from './views/client-form.js';
import { renderReport } from './views/report.js';
import { renderGps } from './views/gps.js';
import { renderRepairs } from './views/repairs.js';
import { repairsAccess } from './lib/repairs.js';
import { callKpApi } from './lib/gps-client.js';

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
const state = { supabase: null, session: null, context: null, contextUser: null, route: null, repairs: null };
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
        onPlanLost: () => { state.context = null; syncGpsTab(); render(); },
        onCleanup: (fn) => { cleanups.push(fn); },
    };
}

// Кнопки «Калькулятор» / «Огляд» сайту гасимо самі, поки відкрито розділ Контроль+ (сайт підсвічує їх у applyTheme()).
function syncNav() {
    const tab = tabOf(state.route);
    if (tab) document.body.setAttribute('data-kp-view', tab);
    else document.body.removeAttribute('data-kp-view');
    for (const [name, button] of Object.entries(tabs)) {
        button.classList.toggle('on', name === tab);
        if (name === tab) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    if (!tab) return;
    for (const id of ['studio-nav-calc', 'studio-nav-overview']) {
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
    if (repairs.repairsOnly || tabs.clients.hidden) tabs.clients.hidden = repairs.repairsOnly;
    if (repairs.repairsOnly || tabs.report.hidden) tabs.report.hidden = repairs.repairsOnly;
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
    return { context: state.context };
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

// Посилання-запрошення менеджера з ремонтів (?repair_invite=…): після входу приймаємо й прибираємо параметр з URL.
// Власна організація людини не змінюється.
async function acceptRepairInvite() {
    let token = null;
    try {
        token = new URL(location.href).searchParams.get('repair_invite');
    } catch { /* немає URL */ }
    if (!token || !state.session) return;
    const url = new URL(location.href);
    url.searchParams.delete('repair_invite');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    const out = await callKpApi({ supabase: state.supabase }, '/api/repairs/invites', { action: 'accept', token });
    if (!out.ok) {
        toast(out.error || 'Не вдалося прийняти запрошення.', 'error');
        return;
    }
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
    else if (route.view === 'report') view = renderReport(app());
    else if (route.view === 'client-new') view = renderClientForm(app(), null);
    else if (route.view === 'client-edit') view = renderClientForm(app(), route.id);
    else if (route.view === 'client') view = renderClientCard(app(), route.id);
    else if (route.view === 'gps') view = renderGps(app());
    else view = renderClients(app());
    clear(root, head(), view);
    root.focus({ preventScroll: true });
    window.scrollTo(0, 0);
}

function onHash() {
    const route = parseCrmHash(location.hash);
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
    tabs.clients = h('button', { type: 'button', id: 'kp-nav-clients', onclick: () => { location.hash = '#/clients'; } }, 'Клієнти');
    tabs.report = h('button', { type: 'button', id: 'kp-nav-report', onclick: () => { location.hash = '#/report'; } }, 'Звіт план/факт');
    tabs.gps = h('button', { type: 'button', id: 'kp-nav-gps', onclick: () => { location.hash = '#/gps'; } }, 'GPS');
    tabs.gps.hidden = true;
    tabs.repairs = h('button', { type: 'button', id: 'kp-nav-repairs', onclick: () => { location.hash = '#/repairs'; } }, 'Ремонти');
    tabs.repairs.hidden = true;
    nav.append(tabs.clients, tabs.report, tabs.gps, tabs.repairs);
    root = h('section', { id: 'kp-crm', class: 'kp-crm', 'aria-label': 'Контроль+', tabindex: '-1' });
    main.insertBefore(root, document.getElementById('studio-overview'));
    // «Калькулятор» / «Огляд» / логотип / «Історія» з меню — усе, що кличе setStudioView() сайту, закриває розділ Контроль+.
    new MutationObserver((records) => {
        if (records.some((r) => r.attributeName === 'data-studio-view')) leave();
        else syncNav();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-studio-view', 'data-theme'] });
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
            syncGpsTab();
            // Supabase не можна кликати прямо з колбеку onAuthStateChange.
            if (state.route) setTimeout(render, 0);
            else if (session) setTimeout(refreshGpsTab, 0);
            if (session) setTimeout(acceptRepairInvite, 0);
        }
    });
    window.addEventListener('hashchange', onHash);
    onHash();
    if (!state.route) await refreshGpsTab();
    await acceptRepairInvite();
    return true;
}
