// Підрозділ «ТО» (етап 3b): статус ТО по авто (проблемні зверху), «Шаблон ТО» (типи + перевизначення на авто),
// «Одометр» (показник і історія). Статус рахує база (kp_maintenance_status); кнопки запису — лише з правом запису.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtNumber, fmtDate, kyivDate } from '../lib/format.js';
import { repairErrorText } from '../lib/repairs.js';
import { odometerDecreaseText } from '../lib/errors.js';
import {
    sortMaintenance, maintenanceBadge, badgeTitle, intervalText, leftKmText, leftDaysText, lastText, STATUS_TEXT,
    validateTypeForm, validateOdometerForm, odometerConflict, ODOMETER_SOURCE_TEXT,
} from '../lib/maintenance.js';

// Бейдж на кнопці «Ремонти» в навігації сайту: число red (червоний) або yellow (жовтий); нуль — без бейджа.
export function paintRepairsBadge(button, rows) {
    if (!button) return null;
    const badge = maintenanceBadge(rows);
    clear(button, button.kpIcon || null, h('span', { class: 'lb' }, 'Ремонти'), badge ? h('span', { class: 'kpr-nav-badge kpr-nav-badge-' + badge.kind, 'aria-hidden': 'true' }, String(badge.count)) : null);
    if (badge) button.setAttribute('title', badgeTitle(badge));
    else button.removeAttribute('title');
    if (badge) button.setAttribute('aria-label', 'Ремонти. ' + badgeTitle(badge));
    else button.removeAttribute('aria-label');
    return badge;
}

function statusCell(row) {
    return h('span', { class: 'kpr-st kpr-st-' + row.status }, STATUS_TEXT[row.status] || row.status);
}

// Таблиця статусу (рядки — з kp_maintenance_status); лише h() / textContent.
export function maintenanceTable(rows) {
    return h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Авто', 'Тип ТО', 'Статус', 'Залишок км', 'Залишок днів', 'Остання: дата / км'].map((t) => h('th', null, t)))),
        h('tbody', null, sortMaintenance(rows).map((r) => h('tr', { class: 'kpr-row-' + r.status },
            h('td', { 'data-label': 'Авто' }, r.vehicle_label),
            h('td', { 'data-label': 'Тип ТО' }, r.type_name, h('span', { class: 'hint' }, ' ' + intervalText(r.interval_km, r.interval_months)),
                r.overridden ? h('span', { class: 'tag' }, 'своє') : null),
            h('td', { 'data-label': 'Статус' }, statusCell(r)),
            h('td', { 'data-label': 'Залишок км', class: 'mono' + (r.reason === 'km' && r.status !== 'ok' ? ' kpr-why' : '') }, leftKmText(r)),
            h('td', { 'data-label': 'Залишок днів', class: 'mono' + (r.reason === 'time' && r.status !== 'ok' ? ' kpr-why' : '') }, leftDaysText(r)),
            h('td', { 'data-label': 'Остання', class: 'mono' }, lastText(r)))))));
}

function field(id, label, input) {
    return h('div', { class: 'field' }, h('label', { for: id }, label), input);
}

const intOrNull = (value) => (value === '' || value === null || value === undefined ? null : Number(value));

export function renderMaintenance(app, access) {
    const state = { rows: [], types: [], vehicles: [] };
    const vehicle = h('select', { 'aria-label': 'Авто' }, h('option', { value: '' }, 'Усі авто'));
    const list = h('div', { class: 'list' }, spinner());
    const panel = h('div', { class: 'kpr-panel' });
    const message = h('div', { 'aria-live': 'polite' });
    const fail = (error) => clear(message, notice(repairErrorText(error)));

    function draw() {
        if (!state.types.some((t) => t.is_active)) {
            clear(list, h('div', { class: 'empty' }, h('p', null, 'Типів ТО ще немає. Почніть з типового шаблону — інтервали можна змінити.'),
                access.canWrite ? h('button', { type: 'button', class: 'btn btn-primary', onclick: seed }, 'Заповнити типовий шаблон') : null));
            return;
        }
        const rows = state.rows.filter((r) => !vehicle.value || r.vehicle_id === vehicle.value);
        if (!rows.length) {
            clear(list, h('div', { class: 'empty' }, h('p', null, state.vehicles.length ? 'Для цього авто ТО не відстежується.' : 'В автопарку ще немає авто.')));
            return;
        }
        const noBase = new Set(rows.filter((r) => r.odometer_km === null || r.odometer_km === undefined).map((r) => r.vehicle_label));
        clear(list, maintenanceTable(rows),
            noBase.size ? h('p', { class: 'muted small' }, 'Вкажіть показник одометра (кнопка «Одометр»), щоб рахувати залишок км: ' + [...noBase].join(', ') + '.') : null,
            h('p', { class: 'muted small' }, 'Пробіг = останній показник одометра + км з прийнятих і виконаних рейсів після нього. '
                + 'Червоний — термін настав, жовтий — до 5000 км або 14 днів.'));
    }

    async function loadTypes() {
        const { data, error } = await app.supabase.from('maintenance_types').select('id, name, interval_km, interval_months, is_active, sort')
            .order('sort', { ascending: true }).limit(200);
        if (error) throw error;
        state.types = data || [];
    }

    async function load() {
        const [{ data, error }] = await Promise.all([app.supabase.rpc('kp_maintenance_status', { p_vehicle: null }), loadTypes()]);
        if (error) throw error;
        state.rows = data || [];
        if (app.onMaintenance) app.onMaintenance(state.rows);
        draw();
    }

    async function reload() {
        try {
            await load();
        } catch (error) {
            clear(list, notice(repairErrorText(error)));
        }
    }

    async function seed() {
        const { data, error } = await app.supabase.rpc('kp_maintenance_seed_defaults');
        if (error) return fail(error);
        state.types = data || [];
        toast('Типовий шаблон ТО додано');
        await reload();
    }

    function vehicleSelect(id, selected, withEmpty = true) {
        return h('select', { id }, withEmpty ? h('option', { value: '' }, '— оберіть авто —') : null,
            state.vehicles.map((v) => h('option', { value: v.id, selected: v.id === selected }, v.label)));
    }

    // Шаблон: типи організації й перевизначення інтервалів на окреме авто.
    function templatePanel() {
        const typesBox = h('div');
        const overridesBox = h('div');
        const overrideVehicle = vehicleSelect('kpr-o-vehicle', vehicle.value);

        function typeForm(type) {
            const name = h('input', { id: 'kpr-t-name', maxlength: '80', value: type ? type.name : '' });
            const km = h('input', { id: 'kpr-t-km', type: 'number', inputmode: 'numeric', min: '1', step: '1', value: type && type.interval_km !== null ? type.interval_km : '' });
            const months = h('input', { id: 'kpr-t-months', type: 'number', inputmode: 'numeric', min: '1', max: '120', step: '1', value: type && type.interval_months !== null ? type.interval_months : '' });
            const errors = h('div', { 'aria-live': 'polite' });
            return h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
                e.preventDefault();
                const values = { name: name.value, interval_km: km.value, interval_months: months.value };
                const problems = validateTypeForm(values);
                if (problems.length) return clear(errors, h('div', { class: 'notice notice-error', role: 'alert' }, problems.join(' ')));
                const { data, error } = await app.supabase.rpc('kp_maintenance_type_upsert', { p_id: type ? type.id : null, p_name: name.value.trim(),
                    p_interval_km: intOrNull(km.value), p_interval_months: intOrNull(months.value), p_sort: null });
                if (error) return clear(errors, notice(repairErrorText(error)));
                state.types = data || [];
                toast(type ? 'Тип ТО збережено' : 'Тип ТО додано');
                drawTypes();
                await reload();
            } }, h('h3', null, type ? 'Тип ТО: ' + type.name : 'Новий тип ТО'),
            h('div', { class: 'form' }, field('kpr-t-name', 'Назва', name), field('kpr-t-km', 'Інтервал, км', km), field('kpr-t-months', 'Інтервал, місяців', months),
                h('p', { class: 'muted small kpr-wide' }, 'Достатньо одного інтервалу. Якщо обидва — ТО настає за тим, що раніше.'),
                errors,
                h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти'),
                    h('button', { type: 'button', class: 'btn btn-ghost', onclick: drawTypes }, 'Скасувати'))));
        }

        function drawTypes() {
            const active = state.types.filter((t) => t.is_active);
            clear(typesBox,
                active.length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                    h('thead', null, h('tr', null, ['Тип ТО', 'Інтервал', ''].map((t) => h('th', null, t)))),
                    h('tbody', null, active.map((t) => h('tr', null,
                        h('td', { 'data-label': 'Тип ТО' }, t.name),
                        h('td', { 'data-label': 'Інтервал', class: 'mono' }, intervalText(t.interval_km, t.interval_months)),
                        h('td', { 'data-label': '' }, access.canWrite ? h('div', { class: 'actions' },
                            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => clear(typesBox, typeForm(t)) }, 'Змінити'),
                            confirmButton('Архівувати', 'Точно в архів?', async () => {
                                const { data, error } = await app.supabase.rpc('kp_maintenance_type_archive', { p_id: t.id });
                                if (error) return fail(error);
                                state.types = data || [];
                                toast('Тип ТО в архіві; історія виконань лишається');
                                drawTypes();
                                await reload();
                            }, 'btn btn-sm btn-danger')) : null)))))) : h('p', { class: 'muted' }, 'Активних типів немає.'),
                access.canWrite ? h('div', { class: 'actions' },
                    h('button', { type: 'button', class: 'btn', onclick: () => clear(typesBox, typeForm(null)) }, '+ Тип ТО'),
                    active.length ? null : h('button', { type: 'button', class: 'btn btn-ghost', onclick: seed }, 'Типовий шаблон')) : null);
        }

        async function drawOverrides() {
            const vehicleId = overrideVehicle.value;
            if (!vehicleId) return clear(overridesBox, h('p', { class: 'muted small' }, 'Оберіть авто, щоб змінити інтервали лише для нього.'));
            clear(overridesBox, spinner());
            const { data, error } = await app.supabase.from('vehicle_maintenance_overrides').select('type_id, interval_km, interval_months, disabled').eq('vehicle_id', vehicleId);
            if (error) return clear(overridesBox, notice(repairErrorText(error)));
            const byType = new Map((data || []).map((o) => [o.type_id, o]));
            clear(overridesBox, h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Тип ТО', 'Шаблон', 'Для цього авто', ''].map((t) => h('th', null, t)))),
                h('tbody', null, state.types.filter((t) => t.is_active).map((t) => overrideRow(vehicleId, t, byType.get(t.id) || null))))));
        }

        function overrideRow(vehicleId, type, current) {
            const km = h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '1', 'aria-label': 'Інтервал км: ' + type.name,
                placeholder: type.interval_km === null ? '—' : String(type.interval_km), value: current && current.interval_km !== null ? current.interval_km : '' });
            const months = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '120', step: '1', 'aria-label': 'Інтервал місяців: ' + type.name,
                placeholder: type.interval_months === null ? '—' : String(type.interval_months), value: current && current.interval_months !== null ? current.interval_months : '' });
            const off = h('input', { type: 'checkbox', checked: Boolean(current && current.disabled), 'aria-label': 'Не відстежувати: ' + type.name });
            const save = async () => {
                const { error } = await app.supabase.rpc('kp_maintenance_override_set', { p_vehicle: vehicleId, p_type: type.id,
                    p_interval_km: intOrNull(km.value), p_interval_months: intOrNull(months.value), p_disabled: off.checked });
                if (error) return fail(error);
                toast('Інтервали авто збережено');
                await drawOverrides();
                await reload();
            };
            const reset = async () => {
                const { error } = await app.supabase.rpc('kp_maintenance_override_clear', { p_vehicle: vehicleId, p_type: type.id });
                if (error) return fail(error);
                toast('Як у шаблоні');
                await drawOverrides();
                await reload();
            };
            const own = current ? (current.disabled ? 'не відстежується' : intervalText(current.interval_km ?? type.interval_km, current.interval_months ?? type.interval_months)) : 'як у шаблоні';
            return h('tr', { class: current && current.disabled ? 'is-archived' : '' },
                h('td', { 'data-label': 'Тип ТО' }, type.name),
                h('td', { 'data-label': 'Шаблон', class: 'mono' }, intervalText(type.interval_km, type.interval_months)),
                h('td', { 'data-label': 'Для авто' }, access.canWrite
                    ? h('div', { class: 'kpr-override' }, km, h('span', { class: 'hint' }, 'км'), months, h('span', { class: 'hint' }, 'міс'),
                        h('label', { class: 'check' }, off, ' не відстежувати'))
                    : own),
                h('td', { 'data-label': '' }, access.canWrite ? h('div', { class: 'actions' },
                    h('button', { type: 'button', class: 'btn btn-sm', onclick: save }, 'Зберегти'),
                    current ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: reset }, 'Як у шаблоні') : null) : null));
        }

        overrideVehicle.addEventListener('change', drawOverrides);
        drawTypes();
        drawOverrides();
        clear(panel, h('div', { class: 'card' },
            h('div', { class: 'page-head' }, h('h3', null, 'Шаблон ТО'), h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => clear(panel) }, 'Закрити')),
            typesBox,
            h('h3', null, 'Інтервали для окремого авто'),
            h('p', { class: 'muted small' }, 'Порожнє поле — як у шаблоні. «Не відстежувати» прибирає тип для цього авто.'),
            h('div', { class: 'toolbar' }, overrideVehicle),
            overridesBox));
    }

    // Одометр: показник (база пробігу) й історія — ручні показання й одометри проведених ремонтів (теж бази);
    // поточний пробіг = остання база + км рейсів після неї.
    function odometerPanel() {
        const car = vehicleSelect('kpr-od-vehicle', vehicle.value);
        const date = h('input', { id: 'kpr-od-date', type: 'date', value: kyivDate(), max: kyivDate() });
        const km = h('input', { id: 'kpr-od-km', type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: 'км' });
        const note = h('input', { id: 'kpr-od-note', maxlength: '200', placeholder: 'Необовʼязково' });
        const errors = h('div', { 'aria-live': 'polite' });
        const now = h('p', { class: 'small' });
        const history = h('div');
        let historyRows = [];

        function drawHistory(rows) {
            historyRows = rows || [];
            clear(history, (rows || []).length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Дата', 'Показник', 'Джерело', 'Примітка'].map((t) => h('th', null, t)))),
                h('tbody', null, rows.map((r) => h('tr', null,
                    h('td', { 'data-label': 'Дата' }, fmtDate(r.read_on)),
                    h('td', { 'data-label': 'Показник', class: 'mono' }, fmtNumber(r.odometer_km) + ' км'),
                    h('td', { 'data-label': 'Джерело' }, ODOMETER_SOURCE_TEXT[r.source] || 'Вручну'),
                    h('td', { 'data-label': 'Примітка' }, r.note || '—')))))) : h('p', { class: 'muted small' }, 'Показників ще немає.'));
        }

        async function drawVehicle() {
            clear(errors);
            if (!car.value) {
                clear(now);
                clear(history);
                return;
            }
            const [list, mileage] = await Promise.all([
                app.supabase.rpc('kp_odometer_list', { p_vehicle: car.value }),
                app.supabase.rpc('kp_vehicle_mileage', { p_vehicle: car.value, p_on: null }),
            ]);
            if (list.error || mileage.error) return clear(errors, notice(repairErrorText(list.error || mileage.error)));
            const m = (mileage.data || [])[0];
            clear(now, m && m.odometer_km !== null
                ? ['Поточний пробіг: ', h('b', null, fmtNumber(m.odometer_km) + ' км'), (m.source === 'repair' ? ' (одометр ремонту ' : ' (показник ') + fmtDate(m.base_read_on) + ': ' + fmtNumber(m.base_km)
                    + ' км + рейси: ' + fmtNumber(m.trips_km) + ' км)']
                : h('span', { class: 'muted' }, 'Вкажіть показник одометра (або одометр у ремонті) — від нього рахується пробіг.'));
            drawHistory(list.data);
        }

        car.addEventListener('change', drawVehicle);
        const form = access.canWrite ? h('form', { class: 'form', novalidate: true, onsubmit: async (e) => {
            e.preventDefault();
            const problems = validateOdometerForm({ vehicle_id: car.value, date: date.value, km: km.value }, kyivDate());
            const conflict = problems.length ? null : odometerConflict(historyRows, date.value, km.value);
            if (conflict) problems.push(odometerDecreaseText(conflict.km, conflict.read_on, conflict.kind) + '.');
            if (problems.length) return clear(errors, h('div', { class: 'notice notice-error', role: 'alert' }, problems.join(' ')));
            const { data, error } = await app.supabase.rpc('kp_odometer_add', { p_vehicle: car.value, p_read_on: date.value,
                p_odometer: Number(km.value), p_note: note.value.trim() || null });
            if (error) return clear(errors, notice(repairErrorText(error)));
            km.value = '';
            note.value = '';
            toast('Показник збережено');
            drawHistory(data);
            await drawVehicle();
            await reload();
        } }, field('kpr-od-date', 'Дата', date), field('kpr-od-km', 'Показник, км', km), field('kpr-od-note', 'Примітка', note),
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти показник'))) : null;

        clear(panel, h('div', { class: 'card' },
            h('div', { class: 'page-head' }, h('h3', null, 'Одометр'), h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => clear(panel) }, 'Закрити')),
            h('div', { class: 'toolbar' }, car), now, form, errors, history));
        drawVehicle();
    }

    async function start() {
        const { data } = await app.supabase.rpc('kp_repair_vehicles');
        state.vehicles = data || [];
        for (const v of state.vehicles) vehicle.append(h('option', { value: v.id }, v.label));
        await reload();
    }

    vehicle.addEventListener('change', draw);
    start();
    return h('div', null,
        h('div', { class: 'toolbar' }, vehicle,
            h('button', { type: 'button', class: 'btn', onclick: templatePanel }, 'Шаблон ТО'),
            h('button', { type: 'button', class: 'btn', onclick: odometerPanel }, 'Одометр')),
        message, panel, list);
}
