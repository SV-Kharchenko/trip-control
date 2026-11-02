// Подорожній лист, зворотний бік: редактор етапів (таблиця; на телефоні кожен рядок — картка) і редактор відміток
// (медогляд до / після рейсу, механік на виїзді й при поверненні, диспетчер). т·км рахується автоматично (км × т) і не редагується.
// Кнопки — за розміром вмісту. Зберігає картка листа (kp_trip_sheet_extra_save), поки лист «Видано».
import { h, clear } from '../ui.js';
import {
    MARK_LABELS, STAGE_LABELS, addStage, emptyStage, moveStage, removeStage, stageTkm, validateStages,
} from '../lib/trip-sheet-stages.js';

const num = (x) => (x === null || x === undefined ? '—' : String(x).replace('.', ','));

// list — масив рядків форми (emptyStage). onChange() викликається після кожної зміни (картка перераховує підсумки).
export function stagesEditor(list, onChange) {
    const state = { list };
    const box = h('div', { class: 'kpts-stages' });
    const status = h('div', { 'aria-live': 'polite' });

    function cellInput(index, field, attrs, label) {
        const input = h('input', Object.assign({ type: 'text', autocomplete: 'off', 'aria-label': label + ', етап ' + (index + 1) }, attrs));
        input.value = state.list[index][field] || '';
        input.addEventListener('input', () => {
            state.list[index][field] = input.value;
            const tkm = box.querySelector('[data-tkm="' + index + '"]');
            if (tkm) tkm.textContent = num(stageTkm(state.list[index].loaded_km, state.list[index].tonnage));
            const errors = validateStages(state.list);
            input.toggleAttribute('aria-invalid', Boolean(errors[index] && errors[index][field]));
            onChange();
        });
        return input;
    }

    function rowControls(index) {
        const last = state.list.length - 1;
        const btn = (text, title, disabled, fn) => h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title, 'aria-label': title + ', етап ' + (index + 1), disabled, onclick: fn }, text);
        return h('div', { class: 'actions kpts-rowctl' },
            btn('↑', 'Вище', index === 0, () => { state.list = moveStage(state.list, index, -1); draw(); onChange(); }),
            btn('↓', 'Нижче', index === last, () => { state.list = moveStage(state.list, index, 1); draw(); onChange(); }),
            btn('Видалити', 'Видалити рядок', false, () => { state.list = removeStage(state.list, index); draw(); onChange(); }));
    }

    function pair(index, a, b, label) {
        return h('div', { class: 'kpts-pair' },
            h('label', null, h('span', { class: 'kpts-sub' }, 'прибуття'), cellInput(index, a, { type: 'datetime-local' }, label + ': прибуття')),
            h('label', null, h('span', { class: 'kpts-sub' }, 'вибуття'), cellInput(index, b, { type: 'datetime-local' }, label + ': вибуття')));
    }

    function draw() {
        const rows = state.list.map((s, i) => h('tr', null,
            h('td', { 'data-label': '№', class: 'kpts-no' }, String(i + 1)),
            h('td', { 'data-label': STAGE_LABELS.customer }, cellInput(i, 'customer', { maxlength: 300 }, STAGE_LABELS.customer)),
            h('td', { 'data-label': STAGE_LABELS.ttn_no }, cellInput(i, 'ttn_no', { maxlength: 50 }, STAGE_LABELS.ttn_no)),
            h('td', { 'data-label': STAGE_LABELS.load_point }, cellInput(i, 'load_point', { maxlength: 500 }, STAGE_LABELS.load_point)),
            h('td', { 'data-label': STAGE_LABELS.unload_point }, cellInput(i, 'unload_point', { maxlength: 500 }, STAGE_LABELS.unload_point)),
            h('td', { 'data-label': 'Завантаження: час' }, pair(i, 'arrive_load_at', 'depart_load_at', 'Завантаження')),
            h('td', { 'data-label': 'Розвантаження: час' }, pair(i, 'arrive_unload_at', 'depart_unload_at', 'Розвантаження')),
            h('td', { 'data-label': STAGE_LABELS.loaded_km }, cellInput(i, 'loaded_km', { inputmode: 'decimal' }, STAGE_LABELS.loaded_km)),
            h('td', { 'data-label': STAGE_LABELS.tonnage }, cellInput(i, 'tonnage', { inputmode: 'decimal' }, STAGE_LABELS.tonnage)),
            h('td', { 'data-label': STAGE_LABELS.tkm, class: 'mono' }, h('b', { 'data-tkm': String(i) }, num(stageTkm(s.loaded_km, s.tonnage)))),
            h('td', { 'data-label': '' }, rowControls(i))));
        clear(box,
            state.list.length
                ? h('div', { class: 'table-wrap kpr-cards kpts-table' }, h('table', { class: 'table' },
                    h('thead', null, h('tr', null, ['№', STAGE_LABELS.customer, STAGE_LABELS.ttn_no, 'Завантаження', 'Розвантаження', 'Завантаження: прибуття / вибуття',
                        'Розвантаження: прибуття / вибуття', STAGE_LABELS.loaded_km, 'Т', STAGE_LABELS.tkm, ''].map((t) => h('th', null, t)))),
                    h('tbody', null, rows)))
                : h('p', { class: 'muted' }, 'Етапів ще немає. Додайте рядок на кожну їздку.'),
            h('div', { class: 'actions' }, h('button', {
                type: 'button', class: 'btn', onclick: () => { state.list = addStage(state.list); draw(); onChange(); },
            }, 'Додати рядок')),
            status);
    }

    draw();
    return { node: box, get: () => state.list, set: (next) => { state.list = next; draw(); }, status };
}

const FIELD_ATTRS = { maxlength: 200 };

// Відмітки: рядки «ПІБ · дата й час · галочка». m — об'єкт marksFromDoc (змінюється на місці).
export function marksEditor(m, onChange) {
    const row = (title, by, at, ok) => {
        const text = (key, attrs, wide) => {
            const input = h('input', Object.assign({ type: 'text', id: 'ts-m-' + key, autocomplete: 'off', 'aria-label': MARK_LABELS[key] }, attrs));
            input.value = m[key] || '';
            input.addEventListener('input', () => { m[key] = input.value; onChange(); });
            return h('span', { class: 'kpc-box ' + (wide ? 'kpc-w-l' : 'kpc-w-m') }, input);
        };
        const check = h('input', { type: 'checkbox', id: 'ts-m-' + ok, checked: m[ok] === true });
        check.addEventListener('change', () => { m[ok] = check.checked; onChange(); });
        return h('div', { class: 'field kpc-row kpts-mark' },
            h('label', { for: 'ts-m-' + by }, title),
            text(by, FIELD_ATTRS, true), text(at, { type: 'datetime-local' }, false),
            h('label', { class: 'kpts-check', for: 'ts-m-' + ok }, check, ' ', MARK_LABELS[ok]));
    };
    const dispatcher = h('input', { type: 'text', id: 'ts-m-dispatcher_name', maxlength: 200, autocomplete: 'off', 'aria-label': MARK_LABELS.dispatcher_name });
    dispatcher.value = m.dispatcher_name || '';
    dispatcher.addEventListener('input', () => { m.dispatcher_name = dispatcher.value; onChange(); });
    return h('div', { class: 'kpts-marks' },
        row('Медогляд перед рейсом', 'medical_by', 'medical_at', 'medical_ok'),
        row('Механік на виїзді', 'tech_by', 'tech_at', 'tech_ok'),
        row('Медогляд після рейсу', 'medical_post_by', 'medical_post_at', 'medical_post_ok'),
        row('Механік при поверненні', 'mech_return_by', 'mech_return_at', 'mech_return_accepted'),
        h('div', { class: 'field kpc-row' }, h('label', { for: 'ts-m-dispatcher_name' }, 'Диспетчер'), h('span', { class: 'kpc-box kpc-w-l' }, dispatcher)));
}

export { emptyStage };
