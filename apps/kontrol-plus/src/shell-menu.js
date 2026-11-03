// Каркас CRM Контроль+ (PR 1 з 5): дані бокового меню й чисті функції (без DOM) — їх перевіряють node-тести.
// Нових розділів тут немає: кожен пункт веде на НАЯВНИЙ розділ через наявні перемикачі:
//   kind 'hash'    — hash-маршрут Контроль+ (parseCrmHash у lib/route.js; малює bridge.js);
//   kind 'site'    — розділ сайту через наявні кнопки моста (#kp-calc-tab-* → setStudioView, #kp-nav-overview);
//   kind 'cabinet' — вкладка «Особистого кабінету» сайту (openCabinetTab / openCabinet з index.html).
// `access` — id старої кнопки меню (#kp-nav-<key>): пункт зникає й з'являється разом із нею (доступ, тариф, роль рахує bridge.js).
import { DOC_TABS, parseCrmHash } from './lib/route.js';

export const SHELL_GROUPS = [
    { key: 'work', label: 'Робота', items: [
        { key: 'dashboard', label: 'Дашборд', icon: 'dashboard', kind: 'soon', access: null },
        { key: 'registry', label: 'Реєстр заявок', icon: 'registry', kind: 'site', site: 'registry', counter: 'registry', access: 'calc' },
        { key: 'history', label: 'Заявки', icon: 'history', kind: 'site', site: 'history', access: 'calc' },
        { key: 'calc', label: 'Розрахунок', icon: 'calc', kind: 'site', site: 'calc', access: 'calc' },
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
        { key: 'repairs', label: 'Ремонти', icon: 'repairs', kind: 'hash', hash: '#/repairs', access: 'repairs' },
        { key: 'team', label: 'Команда', icon: 'team', kind: 'cabinet', tab: 'team', access: 'calc' },
        { key: 'stats', label: 'Статистика', icon: 'stats', kind: 'cabinet', tab: 'stats', access: 'calc' },
        { key: 'settings', label: 'Налаштування', icon: 'settings', kind: 'cabinet', tab: null, access: 'calc' },
    ] },
    // Розділи, що вже є в Контроль+, але не названі в макеті каркаса: лишаємо доступ до них (нічого не губимо).
    { key: 'more', label: 'Ще', items: [
        { key: 'overview', label: 'Огляд', icon: 'overview', kind: 'site', site: 'overview', access: 'overview' },
        { key: 'report', label: 'План/факт', icon: 'report', kind: 'hash', hash: '#/report', access: 'report' },
        { key: 'drivers', label: 'Водії', icon: 'drivers', kind: 'hash', hash: '#/drivers', access: 'drivers' },
        { key: 'gps', label: 'GPS', icon: 'gps', kind: 'hash', hash: '#/gps', access: 'gps' },
    ] },
];

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

// owner у коді — «Директор» в інтерфейсі, так само директор КП (org_directors); логіст — «Логіст».
export function roleLabel(kpRole, fallback) {
    if (kpRole === 'owner' || kpRole === 'director') return 'Директор';
    if (kpRole === 'logist') return 'Логіст';
    return fallback || '';
}

// «12 заявок» → 12; порожньо / без цифр → null.
export function parseCount(text) {
    const m = /\d[\d\s ]*/.exec(String(text || ''));
    if (!m) return null;
    const n = Number(m[0].replace(/\D/g, ''));
    return Number.isFinite(n) ? n : null;
}

// Неоплачені рахунки з kp_doc_list: чинний рахунок із боргом.
export function countUnpaid(rows) {
    return (rows || []).filter((r) => r && r.kind === 'invoice' && r.status === 'issued' && Number(r.debt) > 0).length;
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
