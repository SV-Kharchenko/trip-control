// Новий подорожній лист вантажного автомобіля (типова форма № 2). Без заявки — порожня форма; з прийнятої заявки
// (#/docs/new/trip_sheet/calc/<id>) форма відкривається заповненою (kp_calc_doc_prefill): маршрут із подачею й точками,
// ТЗ, причіп з fleet_trailers, водій (лише ПІБ і посвідчення), вантаж, строк дії з дати рейсу, план пального як «видано».
// КОЖНЕ підставлене поле редагується до видачі; біля зміненого — позначка «змінено» і кнопка повернути значення із заявки.
// Після видачі документ — знімок: подальші зміни заявки на нього не впливають (kp_trip_sheet_create копіює дані).
import { h, clear, spinner, notice, toast } from '../ui.js';
import { kyivDate } from '../lib/format.js';
import { docsAccess } from '../lib/docs.js';
import {
    TS_FIELD_LABELS, TS_REQUIRED, changedPaths, emptyTripSheet, getPath, prefillSnapshot, setPath, tripSheetPayload, tsErrorField, tsErrorText,
    tsFromPrefill, validateTripSheet,
} from '../lib/trip-sheet.js';
import { showError } from './docs.js';
import { requestPicker, requestDocsNotice, linkClientPanel } from './docs-request-picker.js';
import { withApprovedVariant, docsBackHash } from '../lib/docs-requests.js';

// Поля форми: [шлях, ширина, атрибути]. Порядок — як у розділах картки: Шапка, ТЗ і водій, Завдання, Виїзд, Відмітки.
const SECTIONS = [
    ['Шапка', [['series', 's', { maxlength: 10 }], ['valid_from', 'm', { type: 'date' }], ['valid_to', 'm', { type: 'date' }]]],
    ['ТЗ і водій', [
        ['vehicle.make_model', 'l', { maxlength: 100 }], ['vehicle.reg_number', 'm', { maxlength: 20 }], ['vehicle.garage_no', 's', { maxlength: 30 }],
        ['vehicle.fuel_load', 's', { inputmode: 'decimal' }], ['vehicle.fuel_empty', 's', { inputmode: 'decimal' }],
        ['vehicle.trailer_make_model', 'l', { maxlength: 100 }], ['vehicle.trailer_reg_number', 'm', { maxlength: 20 }],
        ['driver.full_name', 'xl', { maxlength: 200 }], ['driver.license_no', 'm', { maxlength: 30 }], ['driver.tab_no', 's', { maxlength: 30 }],
    ]],
    ['Завдання', [
        ['task.customer', 'xl', { maxlength: 300 }], ['task.route_from', 'xl', { maxlength: 500 }], ['task.feed_point', 'xl', { maxlength: 500 }],
        ['task.via', 'xl', { maxlength: 1000, placeholder: 'через «;»' }], ['task.route_to', 'xl', { maxlength: 500 }],
        ['task.cargo', 'l', { maxlength: 500 }], ['task.tonnage', 's', { inputmode: 'decimal' }], ['task.loaded_km', 's', { inputmode: 'decimal' }],
    ]],
    ['Виїзд', [
        ['depart.at', 'm', { type: 'datetime-local' }], ['depart.odometer', 's', { inputmode: 'numeric' }], ['depart.fuel_left', 's', { inputmode: 'decimal' }],
        ['depart.fuel_issued', 's', { inputmode: 'decimal' }], ['depart.fuel_kind', 's', { maxlength: 50 }],
    ]],
    ['Відмітки (лише факт і час)', [
        ['medical.by', 'l', { maxlength: 200 }], ['medical.at', 'm', { type: 'datetime-local' }],
        ['tech.by', 'l', { maxlength: 200 }], ['tech.at', 'm', { type: 'datetime-local' }],
    ]],
];
const ALL_PATHS = SECTIONS.flatMap(([, fields]) => fields.map(([p]) => p));

export function renderTripSheetForm(app, access, route) {
    const root = h('div', null, spinner());
    const load = async () => {
        const accessInfo = access || docsAccess(app.context);
        const today = kyivDate();
        let pre = null;
        if (route.calc) {
            const res = await app.supabase.rpc('kp_calc_doc_prefill', { p_calculation: route.calc });
            if (res.error) {
                if (/CALC_NOT_ACCEPTED/.test(String(res.error.message))) {
                    return clear(root, h('a', { class: 'back', href: docsBackHash('trip_sheet') }, '← До документів'), notice('Спершу прийміть заявку: подорожній лист створюється лише з прийнятої заявки.'));
                }
                return showError(app, root, res.error);
            }
            pre = withApprovedVariant(res.data);
            if (!pre.client) {
                return clear(root, h('a', { class: 'back', href: docsBackHash('trip_sheet') }, '← До документів'),
                    linkClientPanel(app, { kind: 'trip_sheet', calcId: route.calc, onLinked: () => { clear(root, spinner()); load(); } }));
            }
        }
        const [veh, trl, drv] = await Promise.all([
            app.supabase.rpc('kp_vehicles_list'), app.supabase.rpc('kp_trailers_list'), app.supabase.rpc('kp_driver_list', { p_active_only: true }),
        ]);
        clear(root, build(app, route, pre, today, veh.error ? [] : veh.data || [], trl.error ? [] : (trl.data || []).filter((t) => t.active), drv.error ? [] : drv.data || [], accessInfo));
    };
    load();
    return root;
}

function build(app, route, pre, today, vehicles, trailers, drivers, access) {
    let d = pre ? tsFromPrefill(pre, today) : emptyTripSheet(today);
    let snap = pre ? prefillSnapshot(d, ALL_PATHS) : null;
    let tried = false;
    const fields = {};
    const message = h('div', { 'aria-live': 'polite' });
    const body = h('div', { class: 'kpts-body' });
    const docDate = h('input', { type: 'date', id: 'ts-date', value: today, max: today });
    const number = h('input', { type: 'number', id: 'ts-number', min: 1, step: 1, inputmode: 'numeric', placeholder: 'авто' });
    const numberHint = h('div', { class: 'hint' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Видати подорожній лист');

    function paint() {
        const errors = validateTripSheet(d);
        const changed = new Set(snap ? changedPaths(d, snap) : []);
        for (const [path, f] of Object.entries(fields)) {
            const missing = TS_REQUIRED.includes(path) && String(getPath(d, path) ?? '').trim() === '';
            f.wrap.classList.toggle('kpt-missing', missing);
            const err = tried ? errors[path] : null;
            f.input.toggleAttribute('aria-invalid', Boolean(err));
            f.hint.textContent = err || '';
            f.hint.className = 'hint' + (err ? ' hint-error' : '');
            f.mark.hidden = !changed.has(path);
        }
        return errors;
    }

    function field(path, width, attrs) {
        const id = 'ts-' + path.replace(/\./g, '-');
        const input = h('input', Object.assign({ id, type: 'text', autocomplete: 'off' }, attrs));
        input.value = String(getPath(d, path) ?? '');
        input.addEventListener('input', () => { setPath(d, path, input.value); paint(); });
        const hint = h('div', { class: 'hint', id: id + '-hint', 'aria-live': 'polite' });
        const reset = h('button', {
            type: 'button', class: 'kpts-reset', title: 'Повернути значення із заявки', 'aria-label': 'Повернути значення із заявки: ' + (TS_FIELD_LABELS[path] || path),
            onclick: () => { setPath(d, path, snap[path]); input.value = snap[path]; paint(); },
        }, '↺');
        const mark = h('span', { class: 'kpts-changed', hidden: true }, 'змінено ', reset);
        const req = TS_REQUIRED.includes(path) ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null;
        const wrap = h('div', { class: 'field kpc-row', 'data-path': path },
            h('label', { for: id }, TS_FIELD_LABELS[path] || path, req), h('span', { class: 'kpc-box kpc-w-' + width }, input), mark, hint);
        fields[path] = { input, hint, wrap, mark };
        return wrap;
    }

    function pickBlock() {
        const vehicleSel = h('select', { id: 'ts-vehicle', 'aria-label': 'Авто з автопарку' },
            h('option', { value: '' }, vehicles.length ? '— авто з автопарку (заповнить поля) —' : 'Авто ще немає — заповніть вручну'),
            vehicles.map((v) => h('option', { value: v.id, selected: v.id === d.vehicle_id }, v.label + (v.make_model ? ' · ' + v.make_model : ''))));
        vehicleSel.addEventListener('change', () => {
            const v = vehicles.find((x) => x.id === vehicleSel.value);
            d.vehicle_id = v ? v.id : '';
            if (v) {
                Object.assign(d.vehicle, {
                    make_model: v.make_model || '', reg_number: v.label || '',
                    fuel_load: v.fuel_load === null || v.fuel_load === undefined ? d.vehicle.fuel_load : String(v.fuel_load),
                    fuel_empty: v.fuel_empty === null || v.fuel_empty === undefined ? d.vehicle.fuel_empty : String(v.fuel_empty),
                    trailer_make_model: v.trailer_make_model || '', trailer_reg_number: v.trailer_plate || '',
                });
                const t = trailers.find((x) => x.plate === v.trailer_plate);
                d.trailer_id = t ? t.id : '';
                const dr = drivers.find((x) => x.id === v.default_driver_id);
                if (dr) Object.assign(d.driver, { id: dr.id, full_name: dr.full_name, license_no: dr.license_no || '' });
            }
            drawBody();
        });
        const trailerSel = h('select', { id: 'ts-trailer', 'aria-label': 'Причіп з автопарку' },
            h('option', { value: '' }, trailers.length ? '— причіп з автопарку —' : 'Причепів ще немає'),
            trailers.map((t) => h('option', { value: t.id, selected: t.id === d.trailer_id }, t.plate + (t.make_model ? ' · ' + t.make_model : ''))));
        trailerSel.addEventListener('change', () => {
            const t = trailers.find((x) => x.id === trailerSel.value);
            d.trailer_id = t ? t.id : '';
            Object.assign(d.vehicle, { trailer_make_model: t ? t.make_model || '' : '', trailer_reg_number: t ? t.plate : '' });
            drawBody();
        });
        const driverSel = h('select', { id: 'ts-driver', 'aria-label': 'Водій з довідника' },
            h('option', { value: '' }, drivers.length ? '— водій з довідника —' : 'Довідник водіїв порожній'),
            drivers.map((x) => h('option', { value: x.id, selected: x.id === d.driver.id }, x.full_name + (x.license_no ? ' · ' + x.license_no : ''))));
        driverSel.addEventListener('change', () => {
            const x = drivers.find((y) => y.id === driverSel.value);
            Object.assign(d.driver, x ? { id: x.id, full_name: x.full_name, license_no: x.license_no || '' } : { id: '', full_name: '', license_no: '' });
            drawBody();
        });
        const row = (label, control) => h('div', { class: 'field kpc-row' }, h('label', null, label), h('span', { class: 'kpc-box kpc-w-xl' }, control));
        return h('div', { class: 'kpts-pick' }, row('Авто', vehicleSel), row('Причіп', trailerSel), row('Водій', driverSel));
    }

    function drawBody() {
        for (const key of Object.keys(fields)) delete fields[key];
        clear(body, SECTIONS.map(([title, list], i) => h('div', { class: 'kpts-section' },
            h('h2', { class: 'form-section' }, title),
            i === 1 ? pickBlock() : null,
            list.map(([path, width, attrs]) => field(path, width, attrs)))));
        paint();
    }

    const form = h('form', {
        class: 'card kpd-form kpt-form kpc', novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            clear(message);
            tried = true;
            const errors = paint();
            const keys = Object.keys(errors);
            if (keys.length) {
                clear(message, notice('Заповніть обовʼязкові поля (' + keys.length + '): ' + keys.slice(0, 4).map((k) => TS_FIELD_LABELS[k] || k).join('; ') + (keys.length > 4 ? '…' : '')));
                const first = fields[keys[0]];
                if (first) { first.input.focus(); first.wrap.scrollIntoView({ block: 'center' }); }
                return;
            }
            if (number.value && !(Number(number.value) >= 1 && Number.isInteger(Number(number.value)))) return clear(message, notice('Номер — ціле число від 1.'));
            submit.disabled = true;
            const { data, error } = await app.supabase.rpc('kp_trip_sheet_create', {
                p_doc_date: docDate.value, p_number: number.value ? Number(number.value) : null, p_data: tripSheetPayload(d),
                p_calculation: pre && pre.calculation ? pre.calculation.id : null, p_client: d.client_id || null,
            });
            submit.disabled = false;
            if (error) {
                const bad = tsErrorField(error);
                clear(message, notice(tsErrorText(error)));
                if (bad && fields[bad.field]) fields[bad.field].input.focus();
                return;
            }
            toast('Подорожній лист видано');
            app.go('#/docs/trip_sheet/' + data);
        },
    },
    h('div', { class: 'kpts-section' },
        h('h2', { class: 'form-section' }, 'Номер і дата'),
        h('div', { class: 'field kpc-row' }, h('label', { for: 'ts-date' }, TS_FIELD_LABELS.doc_date), h('span', { class: 'kpc-box kpc-w-m' }, docDate)),
        h('div', { class: 'field kpc-row' }, h('label', { for: 'ts-number' }, TS_FIELD_LABELS.number), h('span', { class: 'kpc-box kpc-w-s' }, number), numberHint)),
    message,
    body,
    h('p', { class: 'muted small' }, h('span', { class: 'req' }, '*'), ' — обовʼязкові поля. Після видачі шапка, ТЗ, водій і завдання не змінюються; на поверненні вносяться лише спідометр, залишок пального й час. Телефон, паспорт, ІПН і адреса водія в лист не потрапляють.'),
    h('div', { class: 'actions kpr-sticky' }, submit, h('a', { class: 'btn btn-ghost', href: docsBackHash('trip_sheet') }, 'Скасувати')));

    async function loadNumber() {
        const { data, error } = await app.supabase.rpc('kp_trip_sheet_next_number', { p_doc_date: docDate.value || today });
        if (!error) numberHint.textContent = 'Порожньо — автоматичний номер (наступний: ' + data + ').';
    }
    docDate.addEventListener('change', loadNumber);
    loadNumber();
    drawBody();
    if (pre) {
        clear(message, notice('Заявку «' + (pre.calculation.name || '') + '» прийнято: поля підставлено. Змінені вручну позначені «змінено» — їх можна повернути.', 'info'));
    }
    return h('div', null,
        h('a', { class: 'back', href: docsBackHash('trip_sheet') }, '← До документів'),
        h('h2', null, 'Подорожній лист вантажного автомобіля — новий'),
        h('div', { class: 'card' }, requestPicker(app, 'trip_sheet', { current: route.calc }), requestDocsNotice(app, 'trip_sheet', route.calc)),
        form);
}
