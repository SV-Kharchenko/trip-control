// Каркас CRM Контроль+ (PR 1 з 5): дані бокового меню й чисті функції (без DOM) — їх перевіряють node-тести.
// Нових розділів тут немає: кожен пункт веде на НАЯВНИЙ розділ через наявні перемикачі:
//   kind 'hash'    — hash-маршрут Контроль+ (parseCrmHash у lib/route.js; малює bridge.js);
//   kind 'site'    — розділ сайту через наявні кнопки моста (#kp-calc-tab-* → setStudioView, #kp-nav-overview);
//   kind 'cabinet' — вкладка «Особистого кабінету» сайту (openCabinetTab / openCabinet з index.html).
// `access` — id старої кнопки меню (#kp-nav-<key>): пункт зникає й з'являється разом із нею (доступ, тариф, роль рахує bridge.js).
import { DOC_TABS, parseCrmHash } from './lib/route.js';
import { ROLE_LABELS } from './lib/gate.js';

// «Огляд» у Контроль+ веде на дашборд (#/dashboard, PR 4); сайтовий «Огляд компанії» лишається на сайті й відкривається
// посиланням «Детальний огляд» з дашборда (SITE_BUTTONS.overview).
export const SHELL_GROUPS = [
    { key: 'work', label: 'Робота', items: [
        { key: 'overview', label: 'Огляд', icon: 'overview', kind: 'hash', hash: '#/dashboard', access: 'overview' },
        { key: 'registry', label: 'Реєстр заявок', icon: 'registry', kind: 'site', site: 'registry', counter: 'registry', access: 'calc' },
        { key: 'history', label: 'Заявки', icon: 'history', kind: 'site', site: 'history', access: 'calc' },
        { key: 'calc', label: 'Розрахунок', icon: 'calc', kind: 'site', site: 'calc', access: 'calc' },
        { key: 'report', label: 'План/факт', icon: 'report', kind: 'hash', hash: '#/report', access: 'report' },
    ] },
    { key: 'docs', label: 'Документи', items: [
        { key: 'contracts', label: 'Договори', icon: 'contracts', kind: 'hash', hash: '#/docs/tab/contracts', access: 'docs' },
        { key: 'invoices', label: 'Рахунки', icon: 'invoices', kind: 'hash', hash: '#/docs/tab/invoices', counter: 'unpaid', access: 'docs' },
        { key: 'acts', label: 'Акти', icon: 'acts', kind: 'hash', hash: '#/docs/tab/acts', access: 'docs' },
        { key: 'ttn', label: 'ТТН', icon: 'ttn', kind: 'hash', hash: '#/docs/tab/ttn', access: 'docs' },
        { key: 'trip_sheets', label: 'Подорожні листи', icon: 'trip_sheets', kind: 'hash', hash: '#/docs/tab/trip_sheets', access: 'docs' },
    ] },
    { key: 'company', label: 'Компанія', items: [
        { key: 'clients', label: 'Клієнти', icon: 'clients', kind: 'hash', hash: '#/clients', access: 'clients' },
        { key: 'fleet', label: 'Автопарк', icon: 'fleet', kind: 'hash', hash: '#/fleet', access: 'fleet' },
        { key: 'drivers', label: 'Водії', icon: 'drivers', kind: 'hash', hash: '#/drivers', access: 'drivers' },
        { key: 'gps', label: 'GPS', icon: 'gps', kind: 'hash', hash: '#/gps', access: 'gps' },
        { key: 'repairs', label: 'Ремонти', icon: 'repairs', kind: 'hash', hash: '#/repairs', access: 'repairs' },
        { key: 'team', label: 'Команда', icon: 'team', kind: 'cabinet', tab: 'team', access: 'calc' },
        { key: 'stats', label: 'Статистика', icon: 'stats', kind: 'cabinet', tab: 'stats', access: 'calc' },
        { key: 'settings', label: 'Налаштування', icon: 'settings', kind: 'cabinet', tab: null, access: 'calc' },
    ] },
];

// Чи фокус у полі введення (Ctrl+K тоді не перехоплюємо): input, textarea, select, contenteditable.
export function isEditableTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable === true) return true;
    const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
    return ce !== null && ce !== undefined && String(ce).toLowerCase() !== 'false';
}

export const SHELL_ITEMS = SHELL_GROUPS.flatMap((group) => group.items);

// Наявні кнопки, які вже вміють відкривати розділ сайту (bridge.js: openSite → leave() + setStudioView).
export const SITE_BUTTONS = {
    registry: 'kp-calc-tab-registry',
    history: 'kp-calc-tab-history',
    calc: 'kp-calc-tab-calc',
    overview: 'kp-nav-overview',
};

// Вкладки кабінету сайту (CABINET_TAB_IDS в index.html), на які ведуть пункти «Команда» й «Статистика».
export const CABINET_TABS = { team: 'team', stats: 'stats' };

// Ключ стану згортання меню: tc_kp_sidebar:<user>.
export function sidebarKey(userId) {
    return 'tc_kp_sidebar:' + (userId || 'anon');
}
export function parseSidebarPref(raw) {
    return raw === 'collapsed' ? 'collapsed' : 'expanded';
}

// Підписи ролей — одне джерело, ROLE_LABELS (lib/gate.js): owner — «Директор», director (org_directors) — «Менеджер», logist — «Логіст», repair_manager — «Відповідальний за ремонти».
export function roleLabel(kpRole, fallback) {
    return ROLE_LABELS[kpRole] || fallback || '';
}

// «12 заявок» → 12; порожньо / без цифр → null.
export function parseCount(text) {
    const m = /\d[\d\s ]*/.exec(String(text || ''));
    if (!m) return null;
    const n = Number(m[0].replace(/\D/g, ''));
    return Number.isFinite(n) ? n : null;
}

// RPC, після успішного виклику яких міняється кількість неоплачених рахунків (позначка «оплачено» з реєстру, журнал оплат, видача / анулювання).
// Імена оплат (kp_payment_*) беремо за префіксом: назви RPC розділу «Документи» не мають потрапляти в основний бандл (тест docs.test.mjs).
export const UNPAID_REFRESH_RPCS = ['registry_doc_set_paid', 'kp_doc_create', 'kp_doc_cancel'];
export const UNPAID_REFRESH_PREFIX = 'kp_payment_';
export function refreshesUnpaid(name) {
    const n = String(name || '');
    return UNPAID_REFRESH_RPCS.includes(n) || n.startsWith(UNPAID_REFRESH_PREFIX);
}

export function counterText(n) {
    if (!(n > 0)) return '';
    return n > 99 ? '99+' : String(n);
}

// Який пункт підсвічено: кабінет → його вкладка; hash-маршрут Контроль+; інакше розділ сайту (data-studio-view).
export function activeKey({ hash, studioView, cabinetOpen, cabinetTab }) {
    if (cabinetOpen) return CABINET_TABS[cabinetTab] ? CABINET_TABS[cabinetTab] : 'settings';
    const route = parseCrmHash(hash);
    if (route) {
        if (route.view === 'docs') return DOC_TABS.includes(route.tab) && route.tab !== 'other' ? route.tab : cardTab(route);
        if (route.view === 'dashboard') return 'overview';
        if (['report', 'gps', 'repairs', 'fleet', 'drivers'].includes(route.view)) return route.view;
        return 'clients';
    }
    if (studioView === 'overview') return 'overview';
    if (studioView === 'history') return 'history';
    if (studioView === 'registry') return 'registry';
    return 'calc';
}

// Картка документа / форма створення: підсвічуємо його вид (рахунок → «Рахунки» тощо), «Усі» й «Інше» — без підсвітки.
function cardTab(route) {
    const kind = route.sub === 'new' ? route.kind : route.sub;
    return { ttn: 'ttn', trip_sheet: 'trip_sheets', act: 'acts', invoice: 'invoices' }[kind] || null;
}
