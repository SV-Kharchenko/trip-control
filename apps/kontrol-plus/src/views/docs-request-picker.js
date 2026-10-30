// «На основі заявки»: вибір збереженої й прийнятої заявки (kp_calc_accepted_list) і перехід до форми потрібного документа з підставленими
// полями; а також перелік документів заявки з попередженням про повтор (kp_calc_documents). Сервер однаково перевіряє організацію й статус.
import { h, clear, toast } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { DOC_KIND_LABELS } from '../lib/docs.js';
import { errorText } from '../lib/errors.js';
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
        if (!row.client_id) toast('У заявки немає клієнта — оберете його на наступному кроці', 'info');
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

// Прив'язка клієнта до заявки тим самим шляхом, що в client-card.js (insert у calculation_clients, guard kp_calculation_clients_guard / kp_can_link).
// Повертає null при успіху або текст помилки.
export async function linkCalcClient(app, calcId, clientId) {
    try {
        const { error } = await app.supabase.from('calculation_clients').insert({ calculation_id: calcId, client_id: clientId });
        if (!error) return null;
        if (/CLIENT_LINK_FORBIDDEN/.test(String(error.message || ''))) return 'Немає права привʼязувати рейси, зверніться до власника.';
        return errorText(error);
    } catch (error) {
        return errorText(error);
    }
}

// Заявка без клієнта: сервер створює документи з заявки лише для привʼязаного клієнта, тому форма спершу просить його обрати.
// Спільний блок для ТТН, акта, рахунку й подорожнього листа. onLinked(clientId) відкриває звичайну заповнену форму.
export function linkClientPanel(app, { kind, calcId, onLinked }) {
    const message = h('div', { 'aria-live': 'polite' });
    const select = h('select', { id: 'kpd-link-client', 'aria-label': 'Клієнт заявки', disabled: true }, h('option', { value: '' }, '— завантажуємо клієнтів —'));
    const button = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, 'Привʼязати і продовжити');
    (async () => {
        let rows = [];
        try {
            const res = await app.supabase.from('clients').select('id, name, archived_at').order('name', { ascending: true }).limit(2000);
            rows = res.error ? [] : (res.data || []).filter((c) => !c.archived_at);
        } catch {
            rows = [];
        }
        clear(select, h('option', { value: '' }, rows.length ? '— оберіть клієнта —' : '— клієнтів немає —'), rows.map((c) => h('option', { value: c.id }, c.name)));
        select.disabled = !rows.length;
        button.disabled = !rows.length;
    })();
    button.addEventListener('click', async () => {
        clear(message);
        if (!select.value) return clear(message, notice('Оберіть клієнта.'));
        button.disabled = true;
        const failure = await linkCalcClient(app, calcId, select.value);
        if (failure) {
            button.disabled = false;
            return clear(message, notice(failure));
        }
        onLinked(select.value);
    });
    return h('div', { class: 'card kpd-link-client' },
        notice('У заявці не вказано клієнта. Оберіть клієнта — його буде привʼязано до заявки.', 'info'),
        h('div', { class: 'field' }, h('label', { for: 'kpd-link-client' }, 'Клієнт'), select),
        message,
        h('div', { class: 'actions' }, button, h('a', { class: 'btn btn-ghost', href: '#/docs/new/' + kind }, 'Створити без заявки')));
}
