// Картка подорожнього листа в компактному стилі 1С (підпис зліва, значення поруч): Шапка, ТЗ і водій, Завдання, Виїзд,
// Повернення, Розрахунок. Видано → поля повернення можна зберігати до закриття («Зберегти повернення») і «Закрити лист» (пробіг і
// витрату рахує сервер, тут — той самий розрахунок наперед), Закрито / Анульовано — лише перегляд. Анулює лише власник. Нижче — ТТН цього ж рейсу.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, shiftDate } from '../lib/format.js';
import { docNumberText } from '../lib/docs.js';
import { NORM_NEEDS_LOADED_KM, calcTripSheet, closePayload, fmtDateTime, isoToLocal, tsErrorText, tsHeading, tsSections } from '../lib/trip-sheet.js';
import { showError, statusBadge, pdfButton, excelButton, cancelControl } from './docs.js';
import { docsBackHash } from '../lib/docs-requests.js';
import {
    STAGE_COLUMNS, closeProblems, marksFromDoc, marksPayload, stageFromDoc, stagesPayload, tsBackSections, tsFrontMarks, tsStageRows, tsTotals, validateStages,
} from '../lib/trip-sheet-stages.js';
import { marksEditor, stagesEditor } from './docs-ts-stages.js';

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

    function closeForm(doc, ctx) {
        const saved = (value) => (value === null || value === undefined ? '' : String(value).replace('.', ','));
        const at = h('input', { type: 'datetime-local', id: 'ts-return-at', value: isoToLocal(doc.return_at || new Date().toISOString()), 'aria-label': 'Дата і час повернення' });
        const odo = h('input', { type: 'text', id: 'ts-return-odo', inputmode: 'numeric', value: saved(doc.return_odometer), 'aria-label': 'Спідометр при поверненні' });
        const left = h('input', { type: 'text', id: 'ts-return-left', inputmode: 'decimal', value: saved(doc.return_fuel_left), 'aria-label': 'Залишок пального при поверненні' });
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
            const noLoaded = r.fuel_norm === null && !String(task.loaded_km ?? '').trim();
            clear(preview,
                h('span', null, 'Норми: ', h('b', null, fmt1(veh.fuel_load) + ' / ' + fmt1(veh.fuel_empty) + ' л/100 км'), ' (з вантажем / порожній)'),
                h('span', null, 'Пробіг: ', h('b', null, fmt1(r.distance_km) + ' км')),
                h('span', null, 'Факт: ', h('b', null, fmt1(r.fuel_actual) + ' л')),
                h('span', { title: noLoaded ? NORM_NEEDS_LOADED_KM : null }, 'За нормою: ', h('b', null, r.fuel_norm === null ? '—' : fmt1(r.fuel_norm) + ' л'),
                    noLoaded ? h('small', { class: 'muted' }, ' ' + NORM_NEEDS_LOADED_KM) : null),
                h('span', null, 'Різниця: ', h('b', null, r.fuel_diff === null ? '—' : (r.fuel_diff > 0 ? '+' : '') + fmt1(r.fuel_diff) + ' л')),
                Object.values(r.errors).length ? h('span', { class: 'hint hint-error' }, Object.values(r.errors)[0]) : null);
        };
        const sync = () => { redraw(); ctx.onInput(odo.value, left.value); };
        odo.addEventListener('input', sync);
        left.addEventListener('input', sync);
        const row = (label, control, cls) => h('div', { class: 'field kpc-row' }, h('label', null, label), h('span', { class: 'kpc-box ' + cls }, control));
        const values = () => closePayload({ return_at: at.value, return_odometer: odo.value, return_fuel_left: left.value });
        // Зберегти повернення без закриття: поля редагуються, доки лист «Видано». Порожнє поле очищає збережене значення.
        const saveDraft = async () => {
            clear(message);
            const saved1 = await ctx.saveExtra();
            if (!saved1.ok) return clear(message, saved1.node);
            const { error } = await app.supabase.rpc('kp_trip_sheet_return_save', { p_id: doc.id, p_data: values() });
            if (error) return clear(message, notice(tsErrorText(error)));
            toast('Дані повернення збережено');
            load();
        };
        const run = async () => {
            clear(message);
            const r = current();
            // Те саме, що перевіряє сервер: без дати/часу й одометра повернення лист не закривається.
            const need = closeProblems({ return_at: at.value, return_odometer: odo.value, return_fuel_left: left.value }, doc);
            if (Object.keys(need).length) return clear(message, notice(Object.values(need)[0]));
            if (Object.keys(r.errors).length) return clear(message, notice(Object.values(r.errors)[0]));
            const saved2 = await ctx.saveExtra();
            if (!saved2.ok) return clear(message, saved2.node);
            const { error } = await app.supabase.rpc('kp_trip_sheet_close', { p_id: doc.id, p_data: values() });
            if (error) return clear(message, notice(tsErrorText(error)));
            toast('Лист закрито');
            load();
        };
        redraw();
        ctx.onInput(odo.value, left.value);
        return h('div', { class: 'card kpc', id: 'ts-close' },
            h('h3', { class: 'kpc-section' }, 'Повернення (змінюється до закриття листа)'),
            row('Дата і час повернення', at, 'kpc-w-m'), row('Спідометр, км', odo, 'kpc-w-s'), row('Залишок пального, л', left, 'kpc-w-s'),
            preview, message,
            h('div', { class: 'actions kpc-actions' },
                h('button', { type: 'button', class: 'btn', id: 'ts-return-save', onclick: saveDraft }, 'Зберегти повернення'),
                confirmButton('Закрити лист', 'Після закриття лист не змінюється. Закрити?', run, 'btn btn-primary')));
    }

    const sectionCard = (section) => h('div', { class: 'card kpc-view' },
        h('h3', { class: 'kpc-section' }, section.title),
        h('dl', { class: 'kpt-dl' }, section.rows.map(([label, value]) => h('div', { class: 'kv' }, h('dt', null, label), h('dd', null, value)))));

    // Лицьовий бік (шапка … виїзд, допуск до рейсу) і повернення з розрахунком; у режимі редагування відмітки й підсумки — в блоках нижче.
    function viewSections(doc, editable) {
        const base = tsSections(doc);
        const out = [...base.slice(0, 4), ...(editable ? [] : [tsFrontMarks(doc)]), ...base.slice(4)];
        return out.map(sectionCard);
    }

    // Таблиця етапів + відмітки після рейсу + підсумки для читання (закритий / анульований лист або режим перегляду).
    function stageView(doc) {
        const rows = tsStageRows(doc);
        const totals = tsTotals(doc);
        return h('div', null,
            h('div', { class: 'card kpc-view' }, h('h3', { class: 'kpc-section' }, 'Зворотний бік: етапи'),
                rows.length
                    ? h('div', { class: 'table-wrap kpr-cards kpts-table' }, h('table', { class: 'table' },
                        h('thead', null, h('tr', null, STAGE_COLUMNS.map(([t]) => h('th', null, t)))),
                        h('tbody', null, rows.map((row) => h('tr', null, row.map((cell, i) => h('td', { 'data-label': STAGE_COLUMNS[i][0], class: i >= 7 ? 'mono' : '' }, cell)))))))
                    : h('p', { class: 'muted' }, 'Етапів не внесено.')),
            tsBackSections(doc, totals).map(sectionCard));
    }

    // Редактор відміток і етапів + форма закриття + живі підсумки (лист «Видано»).
    function editBlocks(doc) {
        const marks = marksFromDoc(doc);
        const totalsBox = h('div', { class: 'card kpc-view', id: 'ts-totals' });
        let editor = null;
        let ret = { odo: doc.return_odometer, left: doc.return_fuel_left };
        const refresh = () => {
            const t = tsTotals(doc, { stages: editor.get(), returnOdometer: ret.odo, returnFuelLeft: ret.left });
            clear(totalsBox, h('h3', { class: 'kpc-section' }, 'Підсумки'),
                h('dl', { class: 'kpt-dl' }, tsBackSections(doc, t)[1].rows.map(([label, value]) => h('div', { class: 'kv' }, h('dt', null, label), h('dd', null, value)))));
        };
        editor = stagesEditor((doc.stages || []).map(stageFromDoc), refresh);
        const message = h('div', { 'aria-live': 'polite' });
        // Зберігає відмітки й етапи; повертає { ok, node } — node з помилкою для показу.
        const saveExtra = async () => {
            const bad = validateStages(editor.get());
            if (Object.keys(bad).length) return { ok: false, node: notice('Перевірте етапи: числа не менше 0, вибуття не раніше прибуття.') };
            const { error } = await app.supabase.rpc('kp_trip_sheet_extra_save', { p_id: doc.id, p_data: { ...marksPayload(marks), stages: stagesPayload(editor.get()) } });
            return error ? { ok: false, node: notice(tsErrorText(error)) } : { ok: true };
        };
        const save = h('button', { type: 'button', class: 'btn btn-primary', id: 'ts-extra-save', onclick: async () => {
            clear(message);
            const res = await saveExtra();
            if (!res.ok) return clear(message, res.node);
            toast('Відмітки й етапи збережено');
            return load();
        } }, 'Зберегти відмітки й етапи');
        const close = access.canWrite ? closeForm(doc, { saveExtra, onInput: (odo, left) => { ret = { odo, left }; refresh(); } }) : null;
        refresh();
        return h('div', null,
            h('div', { class: 'card kpc' }, h('h3', { class: 'kpc-section' }, 'Відмітки (допуск до рейсу, механік, диспетчер)'), marksEditor(marks, () => {})),
            h('div', { class: 'card kpc' }, h('h3', { class: 'kpc-section' }, 'Зворотний бік: етапи'), editor.node),
            h('div', { class: 'actions kpc-actions' }, save), message,
            close, totalsBox);
    }

    function draw(doc) {
        const issued = doc.status === 'issued';
        const editable = issued && access.canWrite;
        clear(box,
            h('a', { class: 'back', href: docsBackHash('trip_sheet') }, '← До документів'),
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
            ...viewSections(doc, editable),
            editable ? editBlocks(doc) : stageView(doc),
            h('div', { id: 'ts-related' }),
            access.isOwner && issued ? h('div', { class: 'card kpd-danger' }, h('h3', null, 'Анулювання'),
                h('p', { class: 'small muted' }, 'Лист не видаляється: він лишається в списку з позначкою «Анульовано», номер не повторюється. Закритий лист анулювати не можна.'),
                cancelControl(app, { ...doc, kind: 'trip_sheet', number_text: docNumberText(doc) }, load)) : null);
    }

    load();
    return box;
}
