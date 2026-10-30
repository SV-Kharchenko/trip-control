// «На основі заявки»: вибір збереженої й прийнятої заявки (kp_calc_accepted_list) і перехід до форми потрібного документа з підставленими
// полями; а також перелік документів заявки з попередженням про повтор (kp_calc_documents). Сервер однаково перевіряє організацію й статус.
import { h, clear, toast } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { DOC_KIND_LABELS } from '../lib/docs.js';
import { requestDocHash, requestOptionLabel, duplicateWarning, docKindNoun } from '../lib/docs-requests.js';

const DOC_HREF = { ttn: '#/docs/ttn/', trip_sheet: '#/docs/trip_sheet/', act: '#/docs/', invoice: '#/docs/' };

export function requestPicker(app, kind, { current = null, compact = false } = {}) {
    if (!kind || !['ttn', 'act', 'invoice', 'trip_sheet'].includes(kind)) return null;
    const search = h('input', { type: 'search', placeholder: 'Пошук заявки', 'aria-label': 'Пошук заявки', size: compact ? 12 : 18 });
    const select = h('select', { 'aria-label': 'На основі заявки', class: 'kpd-req-select' }, h('option', { value: '' }, '— без заявки —'));
    let rows = [];
    let timer = null;

    function draw() {
        clear(select, h('option', { value: '' }, '— без заявки —'));
        for (const r of rows) {
            select.append(h('option', { value: r.calculation_id, selected: r.calculation_id === current }, requestOptionLabel(r, fmtDate)));
        }
    }

    async function load() {
        try {
            const { data, error } = await app.supabase.rpc('kp_calc_accepted_list', { p_q: search.value.trim() || null });
            rows = error ? [] : data || [];
        } catch {
            rows = [];
        }
        draw();
    }

    select.addEventListener('change', () => {
        const row = rows.find((r) => r.calculation_id === select.value);
        if (!row) return;
        if ((kind === 'invoice' || kind === 'act') && !row.client_id) toast('У заявки немає клієнта: його можна обрати у формі вручну', 'info');
        app.go(requestDocHash(kind, row.calculation_id, row.client_id));
    });
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    load();
    return h('div', { class: 'kpd-req' + (compact ? ' kpd-req-compact' : '') },
        h('label', { class: 'kpd-f' }, h('span', null, 'На основі заявки'), search, select));
}

// Документи заявки: список із посиланнями і, для вибраного виду, попередження «вже є … створити ще?». Не забороняє.
export function requestDocsNotice(app, kind, calcId) {
    const box = h('div', { class: 'kpd-req-docs' });
    if (!calcId) return box;
    (async () => {
        let docs = [];
        try {
            const res = await app.supabase.rpc('kp_calc_documents', { p_calculation: calcId });
            docs = res.error ? [] : res.data || [];
        } catch {
            docs = [];
        }
        if (!docs.length) return;
        const warning = duplicateWarning(kind, docs);
        clear(box, h('div', { class: 'notice notice-info' },
            warning ? h('p', null, h('b', null, warning)) : null,
            h('p', { class: 'muted small' }, 'Документи цієї заявки: ', docs.map((d, i) => [
                i ? ', ' : '', h('a', { href: DOC_HREF[d.kind] + d.id }, (DOC_KIND_LABELS[d.kind] || docKindNoun(d.kind)) + ' № ' + d.number_text
                    + (d.status === 'cancelled' ? ' (анульовано)' : '')),
            ]))));
    })();
    return box;
}
