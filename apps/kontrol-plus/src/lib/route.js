// Маршрути вкладок Контроль+ усередині сторінки сайту: #/clients, #/clients/new, #/clients/<id>, #/clients/<id>/edit, #/report, #/gps,
// #/repairs, #/repairs/new, #/repairs/stock, #/repairs/handlers, #/repairs/maintenance, #/repairs/cost,
// #/fleet, #/fleet/trailers, #/drivers, #/report/debts, #/dashboard, картки вікном: #/fleet/car/<id|new>, #/fleet/trailer/<id|new>, #/drivers/<id|new>,
// #/docs, #/docs/tab/<contracts|ttn|acts|invoices|trip_sheets|other>, #/docs/new/<invoice|act|ttn>[/<клієнт>[/<рейс>]], #/docs/<id документа>, #/docs/ttn/<id ТТН>.
// Старі #/docs/fleet, #/docs/debts ведуть на нові розділи (legacyRedirect). «Реквізити компанії» (#/company, #/docs/requisites) і
// «Статистика» (#/stats) переїхали у вкладки «Особистого кабінету» сайту: ці адреси веде туди сам сайт (#/cabinet/requisites, #/cabinet/stats),
// тут вони не є розділами Контроль+.
// Будь-який інший hash (порожній, auth-потоки Supabase, #calculator) належить сайту — null.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DOC_TABS = ['contracts', 'ttn', 'acts', 'invoices', 'trip_sheets', 'other'];

// Куди переїхали розділи, що були підвкладками «Документів». null — hash не старий.
const LEGACY = { 'docs/fleet': '#/fleet', 'docs/requisites': '#/cabinet/requisites', 'docs/debts': '#/report/debts' };
export function legacyRedirect(hash) {
    const raw = String(hash || '').replace(/^#\//, '').split(/[?&]/)[0].replace(/\/+$/, '');
    return LEGACY[raw] || null;
}

function parseDocsHash(parts) {
    if (parts.length === 1) return { view: 'docs', sub: 'list' };
    if (parts.length === 2 && (parts[1] === 'debts' || parts[1] === 'requisites' || parts[1] === 'fleet')) return { view: 'docs', sub: parts[1] };
    if (parts.length === 3 && parts[1] === 'tab' && DOC_TABS.includes(parts[2])) return { view: 'docs', sub: 'list', tab: parts[2] };
    if (parts.length === 2 && UUID.test(parts[1])) return { view: 'docs', sub: 'doc', id: parts[1] };
    if (parts.length === 3 && parts[1] === 'ttn' && UUID.test(parts[2])) return { view: 'docs', sub: 'ttn', id: parts[2] };
    if (parts.length === 3 && parts[1] === 'trip_sheet' && UUID.test(parts[2])) return { view: 'docs', sub: 'trip_sheet', id: parts[2] };
    // Документ із прийнятої заявки: #/docs/new/ttn/calc/<id> і #/docs/new/trip_sheet/calc/<id>; подорожній лист без заявки — #/docs/new/trip_sheet.
    if (parts[1] === 'new' && (parts[2] === 'ttn' || parts[2] === 'trip_sheet' || parts[2] === 'act' || parts[2] === 'invoice') && parts[3] === 'calc' && parts.length === 5 && UUID.test(parts[4])) {
        return { view: 'docs', sub: 'new', kind: parts[2], client: null, calc: parts[4] };
    }
    if (parts[1] === 'new' && parts[2] === 'trip_sheet' && parts.length === 3) return { view: 'docs', sub: 'new', kind: 'trip_sheet', client: null, calc: null };
    if (parts[1] === 'new' && parts.length >= 3 && parts.length <= 5 && (parts[2] === 'invoice' || parts[2] === 'act' || parts[2] === 'ttn')
        && parts.slice(3).every((p) => UUID.test(p))) {
        return { view: 'docs', sub: 'new', kind: parts[2], client: parts[3] || null, calc: parts[4] || null };
    }
    return null;
}

export function parseCrmHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw.startsWith('/')) return null;
    const parts = raw.split(/[?&]/)[0].split('/').filter(Boolean);
    if (parts[0] === 'docs') return parseDocsHash(parts);
    // Заявка у вікні (PR 3): #/requests/<id> — реєстр відкриває її вікном над розділом.
    if (parts[0] === 'requests' && parts.length === 2 && UUID.test(parts[1])) return { view: 'request', id: parts[1] };
    // Дашборд Контроль+ (PR 4): #/dashboard — на місці пункту меню «Огляд»; «Огляд компанії» сайту лишається в самому сайті.
    if (parts[0] === 'dashboard' && parts.length === 1) return { view: 'dashboard' };
    if (parts[0] === 'report' && parts.length === 1) return { view: 'report', sub: 'main' };
    if (parts[0] === 'report' && parts.length === 2 && parts[1] === 'debts') return { view: 'report', sub: 'debts' };
    if (parts[0] === 'fleet' && parts.length === 1) return { view: 'fleet', sub: 'cars' };
    if (parts[0] === 'fleet' && parts.length === 2 && parts[1] === 'trailers') return { view: 'fleet', sub: 'trailers' };
    if (parts[0] === 'drivers' && parts.length === 1) return { view: 'drivers' };
    // Картки авто, причепа і водія вікном над списком (як клієнт): id — UUID або «new» (створення).
    const cardId = (p) => (p === 'new' ? null : UUID.test(p || '') ? p : undefined);
    if (parts[0] === 'fleet' && parts.length === 3 && (parts[1] === 'car' || parts[1] === 'trailer') && cardId(parts[2]) !== undefined) {
        return { view: 'fleet-card', kind: parts[1] === 'car' ? 'vehicle' : 'trailer', id: cardId(parts[2]) };
    }
    if (parts[0] === 'drivers' && parts.length === 2 && cardId(parts[1]) !== undefined) return { view: 'driver-card', id: cardId(parts[1]) };
    if (parts[0] === 'gps' && parts.length === 1) return { view: 'gps' };
    // «Власний парк» (лише з прапорцем own_fleet): #/own-fleet (дошка), /list, /units, /points; картки вікном: #/own-fleet/<request|unit|point>/<id|new>.
    if (parts[0] === 'own-fleet') {
        if (parts.length === 1) return { view: 'own-fleet', sub: 'board' };
        if (parts.length === 2 && ['list', 'units', 'points'].includes(parts[1])) return { view: 'own-fleet', sub: parts[1] };
        if (parts.length === 3 && ['request', 'unit', 'point'].includes(parts[1]) && cardId(parts[2]) !== undefined) {
            return { view: 'own-fleet-card', kind: parts[1], id: cardId(parts[2]) };
        }
        return null;
    }
    if (parts[0] === 'repairs' && parts.length === 1) return { view: 'repairs', sub: 'list' };
    if (parts[0] === 'repairs' && parts.length === 2 && ['new', 'stock', 'handlers', 'maintenance', 'cost'].includes(parts[1])) return { view: 'repairs', sub: parts[1] };
    if (parts[0] !== 'clients' || parts.length > 3) return null;
    if (parts.length === 1) return { view: 'clients' };
    if (parts[1] === 'new' && parts.length === 2) return { view: 'client-new' };
    if (parts.length === 2) return { view: 'client', id: parts[1] };
    if (parts[2] === 'edit') return { view: 'client-edit', id: parts[1] };
    return null;
}

export function tabOf(route) {
    if (!route) return null;
    if (['report', 'gps', 'repairs', 'docs', 'fleet', 'drivers', 'dashboard', 'own-fleet'].includes(route.view)) return route.view;
    if (route.view === 'own-fleet-card') return 'own-fleet';
    if (route.view === 'fleet-card') return 'fleet';
    if (route.view === 'driver-card') return 'drivers';
    return 'clients';
}

// Маршрути, які в Контроль+ (≥900px, каркас CRM) відкриваються ВІКНОМ над поточним розділом: картки документів, форми створення,
// картка / форма клієнта, заявка. Решта (списки, розділи) — звичайна сторінка. Повертає { type, id, key } або null.
// key — ключ вікна: той самий документ двічі не відкривається. Для форм id — повний hash (з ним форму можна відновити).
export function windowSpecOf(route, hash) {
    if (!route) return null;
    if (route.view === 'docs') {
        if (route.sub === 'doc') return { type: 'doc', id: route.id, key: 'doc:' + route.id };
        if (route.sub === 'ttn') return { type: 'ttn', id: route.id, key: 'ttn:' + route.id };
        if (route.sub === 'trip_sheet') return { type: 'trip_sheet', id: route.id, key: 'trip_sheet:' + route.id };
        if (route.sub === 'new') {
            const id = '#/' + String(hash || '').replace(/^#\/?/, '').split(/[?&]/)[0].replace(/\/+$/, '');
            return { type: 'form', id, key: 'form:' + id };
        }
        return null;
    }
    if (route.view === 'client') return { type: 'client', id: route.id, key: 'client:' + route.id };
    if (route.view === 'client-edit') return { type: 'client_form', id: route.id, key: 'client_form:' + route.id };
    if (route.view === 'client-new') return { type: 'client_form', id: '', key: 'client_form:new' };
    if (route.view === 'request') return { type: 'request', id: route.id, key: 'request:' + route.id };
    if (route.view === 'fleet-card') return { type: route.kind, id: route.id || '', key: route.kind + ':' + (route.id || 'new') };
    if (route.view === 'driver-card') return { type: 'driver', id: route.id || '', key: 'driver:' + (route.id || 'new') };
    if (route.view === 'own-fleet-card') return { type: 'of_' + route.kind, id: route.id || '', key: 'of_' + route.kind + ':' + (route.id || 'new') };
    return null;
}
// Список, над яким відкривається вікно картки (та адреса, на яку повертаємось, якщо вікон немає — вузький екран).
export function cardParentHash(route) {
    if (!route) return null;
    if (route.view === 'fleet-card') return route.kind === 'trailer' ? '#/fleet/trailers' : '#/fleet';
    if (route.view === 'driver-card') return '#/drivers';
    return null;
}
// «Власний парк»: список під вікном картки. На вузькому екрані картка відкривається сторінкою (як картка клієнта), тому cardParentHash її не чіпає.
export function ownFleetParentHash(route) {
    if (!route || route.view !== 'own-fleet-card') return null;
    return route.kind === 'unit' ? '#/own-fleet/units' : route.kind === 'point' ? '#/own-fleet/points' : '#/own-fleet';
}
export function isWindowRoute(route) {
    return windowSpecOf(route, '') !== null || (!!route && route.view === 'docs' && route.sub === 'new');
}
