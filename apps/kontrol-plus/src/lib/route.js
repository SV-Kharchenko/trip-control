// Маршрути вкладок Контроль+ усередині сторінки сайту: #/clients, #/clients/new, #/clients/<id>, #/clients/<id>/edit, #/report, #/gps,
// #/repairs, #/repairs/new, #/repairs/stock, #/repairs/handlers, #/repairs/maintenance, #/repairs/cost,
// #/docs, #/docs/debts, #/docs/requisites, #/docs/new/<invoice|act>[/<клієнт>[/<рейс>]], #/docs/<id документа>.
// Будь-який інший hash (порожній, auth-потоки Supabase, #calculator) належить сайту — null.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDocsHash(parts) {
    if (parts.length === 1) return { view: 'docs', sub: 'list' };
    if (parts.length === 2 && (parts[1] === 'debts' || parts[1] === 'requisites')) return { view: 'docs', sub: parts[1] };
    if (parts.length === 2 && UUID.test(parts[1])) return { view: 'docs', sub: 'doc', id: parts[1] };
    if (parts[1] === 'new' && parts.length >= 3 && parts.length <= 5 && (parts[2] === 'invoice' || parts[2] === 'act')
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
    if (parts[0] === 'report' && parts.length === 1) return { view: 'report' };
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
    if (route.view === 'report' || route.view === 'gps' || route.view === 'repairs' || route.view === 'docs') return route.view;
    return 'clients';
}
