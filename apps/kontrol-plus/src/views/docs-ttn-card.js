// Картка ТТН: реквізити в порядку форми № 1-ТН, відомості про вантаж, операції, PDF (1 або 3 примірники) і Excel.
// Дані — знімок на момент створення (після випуску незмінні). Анулює лише owner; DELETE немає.
import { h, clear, spinner, notice } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { CALC_DOC_HINT, calcAccepted, docNumberText } from '../lib/docs.js';
import { CARGO_COLUMNS, cargoCells, cargoTotals, frontFields, operationRows, FOOTNOTES } from '../lib/ttn-text.js';
import { showError, statusBadge, pdfButton, excelButton, cancelControl } from './docs.js';
import { docsBackHash } from '../lib/docs-requests.js';

export function renderTtnCard(app, access, id) {
    const box = h('div', null, spinner());

    async function load() {
        const { data, error } = await app.supabase.rpc('kp_ttn_get', { p_id: id });
        if (error) return showError(app, box, error);
        // «Ще одна ТТН на рейс» — лише коли заявка рейсу прийнята.
        let calcStatus = null;
        if (data.calculation_id) {
            const res = await app.supabase.from('calculations').select('status').eq('id', data.calculation_id).maybeSingle();
            calcStatus = res.data ? res.data.status : null;
        }
        draw(data, calcStatus);
    }

    function draw(doc, calcStatus) {
        const active = doc.status === 'issued';
        const copies = h('input', { type: 'checkbox', id: 'ttn-copies' });
        const used = new Set((doc.lines || []).flatMap((l) => [l.owner_price ? 'owner' : null, l.bulk ? 'bulk' : null]).filter(Boolean));
        clear(box,
            h('a', { class: 'back', href: docsBackHash('ttn') }, '← До документів'),
            h('div', { class: 'page-head' },
                h('div', null,
                    h('h2', null, 'ТТН № ' + docNumberText(doc) + ' від ' + fmtDate(doc.doc_date), ' ', statusBadge(doc.status === 'cancelled' ? 'cancelled' : 'issued')),
                    h('p', { class: 'muted' }, 'Замовник: ', h('a', { href: '#/clients/' + doc.client_id }, doc.client_name || '—'),
                        doc.created_by_email ? ' · створив(ла) ' + doc.created_by_email : '')),
                h('div', { class: 'actions' },
                    pdfButton(app, doc.id, 'Завантажити PDF', 'btn btn-primary', 'ttn', () => (copies.checked ? 3 : 1)),
                    excelButton(app, doc.id, 'ttn', 'Excel', 'btn'),
                    h('label', { class: 'check kpt-copies', for: 'ttn-copies' }, copies, ' 3 примірники'),
                    active && access.canWrite && doc.calculation_id
                        ? (calcAccepted(calcStatus)
                            ? h('a', { class: 'btn', href: '#/docs/new/ttn/' + doc.client_id + '/' + doc.calculation_id }, 'Ще одна ТТН на рейс')
                            : h('button', { type: 'button', class: 'btn', disabled: true, title: CALC_DOC_HINT }, 'Ще одна ТТН на рейс')) : null)),
            doc.status === 'cancelled' ? notice('Анульовано ' + fmtDate(doc.cancelled_at) + (doc.cancelled_by_email ? ' (' + doc.cancelled_by_email + ')' : '')
                + ': ' + (doc.cancelled_reason || '—') + '. Номер не використовується повторно.', 'error') : null,
            h('div', { class: 'card' }, h('dl', { class: 'kpt-dl' }, frontFields(doc).map(([label, value]) =>
                h('div', { class: 'kv' }, h('dt', null, label), h('dd', null, value))))),
            h('h3', { class: 'section-title' }, 'Відомості про вантаж'),
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, CARGO_COLUMNS.map((c) => h('th', null, c.no ? c.no + '. ' + c.title.replace(/\s*\(.*\)\*\*.*$/, '') : c.title)))),
                h('tbody', null,
                    (doc.lines || []).map((line, i) => {
                        const cells = cargoCells(line, i);
                        return h('tr', null, CARGO_COLUMNS.map((c) => h('td', { 'data-label': c.title.split(' (')[0], class: ['places', 'price', 'amount', 'gross_t'].includes(c.key) ? 'mono' : null }, cells[c.key])));
                    }),
                    (() => {
                        const t = cargoTotals(doc);
                        return h('tr', { class: 'kpt-total' }, CARGO_COLUMNS.map((c, i) => h('td', { 'data-label': i ? c.title.split(' (')[0] : '' },
                            i === 0 ? h('b', null, 'Усього') : c.key === 'places' ? t.places : c.key === 'amount' ? t.amount : c.key === 'gross_t' ? h('b', null, t.gross_t) : '')));
                    })()))),
            h('div', { class: 'grid-2' },
                h('div', { class: 'card' }, h('h3', { class: 'kpd-party-title' }, 'Здав (вантажовідправник)'), h('p', null, doc.released_by || '—')),
                h('div', { class: 'card' }, h('h3', { class: 'kpd-party-title' }, 'Прийняв (вантажоодержувач)'), h('p', null, doc.accepted_by || '—'))),
            h('h3', { class: 'section-title' }, 'Вантажно-розвантажувальні операції'),
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Операція', 'Маса брутто / тара / нетто, т', 'Прибуття', 'Вибуття', 'Простій'].map((t) => h('th', null, t)))),
                h('tbody', null, operationRows(doc).map((o) => h('tr', null,
                    h('td', { 'data-label': 'Операція' }, o.label), h('td', { 'data-label': 'Маса', class: 'mono' }, o.mass),
                    h('td', { 'data-label': 'Прибуття' }, o.arrival), h('td', { 'data-label': 'Вибуття' }, o.departure), h('td', { 'data-label': 'Простій' }, o.idle)))))),
            used.size ? h('p', { class: 'muted small' }, [used.has('owner') ? FOOTNOTES[3] : null, used.has('bulk') ? FOOTNOTES[4] : null].filter(Boolean).join(' ')) : null,
            access.isOwner && active ? h('div', { class: 'card kpd-danger' }, h('h3', null, 'Анулювання'),
                h('p', { class: 'small muted' }, 'ТТН не видаляється: вона лишається в списку з позначкою «Анульовано», номер не повторюється.'),
                cancelControl(app, { ...doc, kind: 'ttn' }, load)) : null);
    }

    load();
    return box;
}
