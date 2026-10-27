// Маршрути вкладок Контроль+ усередині сторінки сайту: #/clients, #/clients/new, #/clients/<id>, #/clients/<id>/edit, #/report, #/gps,
// #/repairs, #/repairs/new, #/repairs/stock, #/repairs/handlers, #/repairs/maintenance, #/repairs/cost,
// #/fleet, #/fleet/trailers, #/drivers, #/company, #/stats, #/report/debts,
// #/docs, #/docs/tab/<contracts|ttn|acts|other>, #/docs/new/<invoice|act|ttn>[/<клієнт>[/<рейс>]], #/docs/<id документа>, #/docs/ttn/<id ТТН>.
// Старі #/docs/fleet, #/docs/requisites, #/docs/debts ведуть на нові розділи (legacyRedirect).
// Будь-який інший hash (порожній, auth-потоки Supabase, #calculator) належить сайту — null.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DOC_TABS = ['contracts', 'ttn', 'acts', 'other'];

// Куди переїхали розділи, що були підвкладками «Документів». null — hash не старий.
const LEGACY = { 'docs/fleet': '#/fleet', 'docs/requisites': '#/company', 'docs/debts': '#/report/debts' };
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
    if (parts[0] === 'report' && parts.length === 1) return { view: 'report', sub: 'main' };
    if (parts[0] === 'report' && parts.length === 2 && parts[1] === 'debts') return { view: 'report', sub: 'debts' };
    if (parts[0] === 'fleet' && parts.length === 1) return { view: 'fleet', sub: 'cars' };
    if (parts[0] === 'fleet' && parts.length === 2 && parts[1] === 'trailers') return { view: 'fleet', sub: 'trailers' };
    if ((parts[0] === 'drivers' || parts[0] === 'company' || parts[0] === 'stats') && parts.length === 1) return { view: parts[0] };
    if (parts[0] === 'gps' && parts.length === 1) return { view: 'gps' };
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
    if (['report', 'gps', 'repairs', 'docs', 'fleet', 'drivers', 'company', 'stats'].includes(route.view)) return route.view;
    return 'clients';
}
