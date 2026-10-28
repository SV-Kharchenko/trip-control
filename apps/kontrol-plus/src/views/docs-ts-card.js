// Картка подорожнього листа в компактному стилі 1С (підпис зліва, значення поруч): Шапка, ТЗ і водій, Завдання, Виїзд,
// Повернення, Розрахунок. Видано → «Закрити лист» (дані повернення; пробіг і витрату рахує сервер, тут — той самий розрахунок
// наперед), Закрито / Анульовано — лише перегляд. Анулює лише власник. Нижче — ТТН цього ж рейсу.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, shiftDate } from '../lib/format.js';
import { docNumberText } from '../lib/docs.js';
import { calcTripSheet, closePayload, fmtDateTime, isoToLocal, tsErrorText, tsHeading, tsSections } from '../lib/trip-sheet.js';
import { showError, statusBadge, pdfButton, excelButton, cancelControl } from './docs.js';

const fmt1 = (n) => (n === null || n === undefined ? '—' : String(n).replace('.', ','));

export function renderTripSheetCard(app, access, id) {
    const box = h('div', null, spinner());

    async function load() {
        const { data, error } = await app.supabase.rpc('kp_trip_sheet_get', { p_id: id });
        if (error) return showError(app, box, error);
        draw(data);
        if (data.calculation_id) loadRelated(data);
    }

    // ТТН цього ж рейсу (за calculation_id) — посилання зі статусами.
    async function loadRelated(doc) {
        const holder = box.querySelector('#ts-related');
        if (!holder) return;
        const { data, error } = await app.supabase.rpc('kp_ttn_list', {
            p_from: shiftDate(doc.doc_date, -365), p_to: shiftDate(doc.doc_date, 365), p_client: null, p_status: null, p_calculation: doc.calculation_id,
        });
        if (error || !(data || []).length) return;
        clear(holder, h('h3', { class: 'section-title' }, 'ТТН цього рейсу'),
            h('ul', { class: 'kpts-related' }, data.map((t) => h('li', null,
                h('a', { href: '#/docs/ttn/' + t.id }, 'ТТН № ' + (t.number_text || t.number)), ' від ' + fmtDate(t.doc_date) + ' · ',
                statusBadge(t.status === 'cancelled' ? 'cancelled' : 'issued')))));
    }

    function closeForm(doc) {
        const at = h('input', { type: 'datetime-local', id: 'ts-return-at', value: isoToLocal(new Date().toISOString()), 'aria-label': 'Дата і час повернення' });
        const odo = h('input', { type: 'text', id: 'ts-return-odo', inputmode: 'numeric', 'aria-label': 'Спідометр при поверненні' });
        const left = h('input', { type: 'text', id: 'ts-return-left', inputmode: 'decimal', 'aria-label': 'Залишок пального при поверненні' });
        const preview = h('div', { class: 'kpr-totals', 'aria-live': 'polite' });
        const message = h('div', { 'aria-live': 'polite' });
        const task = doc.task || {};
        const veh = doc.vehicle || {};
        const current = () => calcTripSheet({
            depart_odometer: doc.depart_odometer, depart_fuel_left: doc.depart_fuel_left, fuel_issued: doc.fuel_issued,
            return_odometer: odo.value, return_fuel_left: left.value, loaded_km: task.loaded_km, fuel_load: veh.fuel_load, fuel_empty: veh.fuel_empty,
        });
        const redraw = () => {
            const r = current();
            if (r.distance_km === null) return clear(preview, h('span', { class: 'muted small' }, 'Внесіть спідометр і залишок пального — покажемо пробіг і витрату.'));
            clear(preview,
                h('span', null, 'Пробіг: ', h('b', null, fmt1(r.distance_km) + ' км')),
                h('span', null, 'Факт: ', h('b', null, fmt1(r.fuel_actual) + ' л')),
                h('span', null, 'За нормою: ', h('b', null, r.fuel_norm === null ? '—' : fmt1(r.fuel_norm) + ' л')),
                h('span', null, 'Різниця: ', h('b', null, r.fuel_diff === null ? '—' : (r.fuel_diff > 0 ? '+' : '') + fmt1(r.fuel_diff) + ' л')),
                Object.values(r.errors).length ? h('span', { class: 'hint hint-error' }, Object.values(r.errors)[0]) : null);
        };
        odo.addEventListener('input', redraw);
        left.addEventListener('input', redraw);
        const row = (label, control, cls) => h('div', { class: 'field kpc-row' }, h('label', null, label), h('span', { class: 'kpc-box ' + cls }, control));
        const run = async () => {
            clear(message);
            const r = current();
            if (Object.keys(r.errors).length) return clear(message, notice(Object.values(r.errors)[0]));
            const { error } = await app.supabase.rpc('kp_trip_sheet_close', { p_id: doc.id, p_data: closePayload({ return_at: at.value, return_odometer: odo.value, return_fuel_left: left.value }) });
            if (error) return clear(message, notice(tsErrorText(error)));
            toast('Лист закрито');
            load();
        };
        redraw();
        return h('div', { class: 'card kpc', id: 'ts-close' },
            h('h3', { class: 'kpc-section' }, 'Закрити лист (дані повернення)'),
            row('Дата і час повернення', at, 'kpc-w-m'), row('Спідометр, км', odo, 'kpc-w-s'), row('Залишок пального, л', left, 'kpc-w-s'),
            preview, message,
            h('div', { class: 'actions kpc-actions' }, confirmButton('Закрити лист', 'Після закриття лист не змінюється. Закрити?', run, 'btn btn-primary')));
    }

    function draw(doc) {
        const issued = doc.status === 'issued';
        clear(box,
            h('a', { class: 'back', href: '#/docs/tab/ttn' }, '← До документів'),
            h('div', { class: 'page-head' },
                h('div', null,
                    h('h2', null, tsHeading(doc), ' від ' + fmtDate(doc.doc_date), ' ', statusBadge(doc.status, 'trip_sheet')),
                    h('p', { class: 'muted' }, doc.client_name ? ['Замовник: ', h('a', { href: '#/clients/' + doc.client_id }, doc.client_name), ' · '] : null,
                        doc.created_by_email ? 'видав(ла) ' + doc.created_by_email : '', doc.closed_at ? ' · закрив(ла) ' + fmtDateTime(doc.closed_at) : '')),
                h('div', { class: 'actions' },
                    pdfButton(app, doc.id, 'Завантажити PDF', 'btn btn-primary', 'trip_sheet'),
                    excelButton(app, doc.id, 'trip_sheet', 'Excel', 'btn'))),
            doc.status === 'cancelled' ? notice('Анульовано ' + fmtDate(doc.cancelled_at) + (doc.cancelled_by_email ? ' (' + doc.cancelled_by_email + ')' : '')
                + ': ' + (doc.cancelled_reason || '—') + '. Номер не використовується повторно.', 'error') : null,
            tsSections(doc).map((section) => h('div', { class: 'card kpc-view' },
                h('h3', { class: 'kpc-section' }, section.title),
                h('dl', { class: 'kpt-dl' }, section.rows.map(([label, value]) => h('div', { class: 'kv' }, h('dt', null, label), h('dd', null, value)))))),
            issued && access.canWrite ? closeForm(doc) : null,
            h('div', { id: 'ts-related' }),
            access.isOwner && issued ? h('div', { class: 'card kpd-danger' }, h('h3', null, 'Анулювання'),
                h('p', { class: 'small muted' }, 'Лист не видаляється: він лишається в списку з позначкою «Анульовано», номер не повторюється. Закритий лист анулювати не можна.'),
                cancelControl(app, { ...doc, kind: 'trip_sheet', number_text: docNumberText(doc) }, load)) : null);
    }

    load();
    return box;
}
