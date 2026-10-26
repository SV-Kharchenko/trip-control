// «Авто й водії» (етап 4b): поля ТЗ для ТТН (марка / модель і номер причепа, тип, габарити, тара, макс. маса, водій
// за замовчуванням) — ті самі нові колонки fleet_vehicles, що й у картці авто сайту; пишуть owner / logist через
// kp_vehicle_save (лише нові колонки). Номер авто, марку, номер і тип причепа та строки документів змінює власник у
// картці авто на сайті. ТО і страхування — згорнутий блок із бейджем, якщо строк жовтий / червоний. Мінімальний довідник
// водіїв (ПІБ, номер посвідчення; деактивація замість видалення). Директор — лише перегляд.
import { h, clear, spinner, notice, toast } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { FLEET_DOCS, FLEET_WARN_DAYS, daysLeft, docState, fleetBadge, validateDriver, validateVehicleTtn } from '../lib/fleet.js';
import { ttnErrorText, ttnErrorField } from '../lib/ttn.js';
import { showError } from './docs.js';

const fmtNum = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));

function docNote(value, today) {
    const state = docState(value, today);
    if (state === 'empty') return 'немає дати';
    const days = daysLeft(value, today);
    if (state === 'overdue') return 'прострочено на ' + Math.abs(days) + ' дн.';
    if (days === 0) return 'сьогодні';
    return (state === 'soon' ? 'лишилось ' : 'ще ') + days + ' дн.';
}

// Згорнутий блок «Додаткова інформація про ТО і Страхування»; бейдж — кількість жовтих / червоних строків.
export function docsBlock(vehicle, today) {
    const badge = fleetBadge(vehicle, today);
    const id = 'kpt-docs-' + vehicle.id;
    const panel = h('div', { class: 'kpt-docs', id, hidden: true },
        h('dl', null, FLEET_DOCS.map(([key, label]) => {
            const state = docState(vehicle[key], today);
            return h('div', { class: 'kv kpt-doc-' + state }, h('dt', null, label),
                h('dd', null, vehicle[key] ? fmtDate(vehicle[key]) : '—', h('small', null, ' · ' + docNote(vehicle[key], today))));
        })),
        h('p', { class: 'muted small' }, 'Строки змінює власник у картці авто на сайті. Попередження — за ' + FLEET_WARN_DAYS + ' днів.'));
    const toggle = h('button', { type: 'button', class: 'kpt-docs-toggle', 'aria-expanded': 'false', 'aria-controls': id },
        'Додаткова інформація про ТО і Страхування',
        badge ? h('span', { class: 'kpt-badge is-' + badge.tone, title: badge.tone === 'overdue' ? 'є прострочені строки' : 'строки спливають' }, String(badge.count)) : null,
        h('span', { class: 'kpt-chevron', 'aria-hidden': 'true' }, '▾'));
    toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        panel.hidden = !open;
        toggle.querySelector('.kpt-chevron').textContent = open ? '▴' : '▾';
    });
    return h('div', { class: 'kpt-docs-block' }, toggle, panel);
}

export function renderFleet(app, access) {
    const box = h('div', null, spinner());
    let drivers = [];

    async function load() {
        const [veh, drv] = await Promise.all([app.supabase.rpc('kp_vehicles_list'), app.supabase.rpc('kp_driver_list', { p_active_only: false })]);
        if (veh.error) return showError(app, box, veh.error);
        if (drv.error) return showError(app, box, drv.error);
        drivers = drv.data || [];
        const today = kyivDate();
        clear(box,
            h('h2', { class: 'section-title' }, 'Авто'),
            h('p', { class: 'muted small' }, 'Поля для ТТН: тип, причіп, габарити автопоїзда, тара, максимально дозволена маса, водій за замовчуванням. '
                + 'Номер авто, марку, номер і тип причепа та строки документів змінює власник у картці авто на сайті (вкладка «Кабінет»).'),
            (veh.data || []).length ? h('div', { class: 'kpt-vehicles' }, veh.data.map((v) => vehicleCard(v, today)))
                : notice('Авто ще немає — власник додає їх у картці авто на сайті.', 'info'),
            h('h2', { class: 'section-title' }, 'Водії'),
            driversBlock());
    }

    function vehicleCard(v, today) {
        const canWrite = access.canWrite;
        const inputs = {};
        const hints = {};
        const message = h('div', { 'aria-live': 'polite' });
        const field = (key, label, attrs = {}) => {
            const id = 'v-' + v.id + '-' + key;
            const input = h('input', Object.assign({ id, type: 'text', autocomplete: 'off', disabled: !canWrite, value: fmtNum(v[key]) }, attrs));
            inputs[key] = input;
            hints[key] = h('div', { class: 'hint', 'aria-live': 'polite' });
            return h('div', { class: 'field' }, h('label', { for: id }, label), input, hints[key]);
        };
        const driverSel = h('select', { id: 'v-' + v.id + '-driver', disabled: !canWrite },
            h('option', { value: '' }, '— без водія за замовчуванням —'),
            drivers.filter((d) => d.active || d.id === v.default_driver_id).map((d) => h('option', { value: d.id, selected: d.id === v.default_driver_id },
                d.full_name + (d.license_no ? ' · ' + d.license_no : '') + (d.active ? '' : ' (неактивний)'))));
        inputs.default_driver_id = driverSel;
        const save = async (event) => {
            event.preventDefault();
            const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
            const { data, errors } = validateVehicleTtn(values);
            for (const key of Object.keys(hints)) {
                hints[key].textContent = errors[key] || '';
                hints[key].className = 'hint' + (errors[key] ? ' hint-error' : '');
                inputs[key].toggleAttribute('aria-invalid', Boolean(errors[key]));
            }
            if (Object.keys(errors).length) return clear(message, notice('Перевірте поля авто.'));
            const { error } = await app.supabase.rpc('kp_vehicle_save', { p_vehicle: v.id, p_data: data });
            if (error) {
                const bad = ttnErrorField(error);
                if (bad && hints[bad.field]) {
                    hints[bad.field].textContent = ttnErrorText(error);
                    hints[bad.field].className = 'hint hint-error';
                }
                return clear(message, notice(ttnErrorText(error)));
            }
            clear(message);
            toast('Авто ' + v.label + ' збережено');
            load();
        };
        return h('form', { class: 'card kpt-vehicle', novalidate: true, onsubmit: save },
            h('div', { class: 'kpt-vehicle-head' },
                h('b', { class: 'mono' }, v.label),
                h('span', { class: v.make_model ? '' : 'muted' }, v.make_model || 'без марки'),
                v.trailer_plate ? h('span', { class: 'muted small' }, 'причіп ' + v.trailer_plate + (v.trailer_type ? ' · ' + v.trailer_type : '')) : null),
            h('div', { class: 'kpd-grid' },
                field('vehicle_type', 'Тип ТЗ', { maxlength: 100, placeholder: 'напр. тягач сідловий' }),
                field('trailer_make_model', 'Причіп / напівпричіп: марка, модель', { maxlength: 100, placeholder: 'напр. Schmitz SKO' }),
                field('length_m', 'Довжина автопоїзда, м', { inputmode: 'decimal', placeholder: 'напр. 16,5' }),
                field('width_m', 'Ширина, м', { inputmode: 'decimal', placeholder: 'напр. 2,55' }),
                field('height_m', 'Висота, м', { inputmode: 'decimal', placeholder: 'напр. 4' }),
                field('tare_t', 'Тара (маса без вантажу), т', { inputmode: 'decimal', placeholder: 'напр. 15,75' }),
                field('max_mass_t', 'Максимально дозволена маса, т', { inputmode: 'decimal', placeholder: 'напр. 40' }),
                h('div', { class: 'field' }, h('label', { for: 'v-' + v.id + '-driver' }, 'Водій за замовчуванням'), driverSel)),
            docsBlock(v, today),
            message,
            canWrite ? h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Зберегти')) : null);
    }

    function driversBlock() {
        const message = h('div', { 'aria-live': 'polite' });
        const name = h('input', { type: 'text', maxlength: 200, placeholder: 'Прізвище Імʼя По батькові', 'aria-label': 'ПІБ водія', class: 'grow' });
        const license = h('input', { type: 'text', maxlength: 30, placeholder: 'Посвідчення: серія й номер', 'aria-label': 'Номер посвідчення водія', class: 'mono' });
        const saveDriver = async (id, values, active) => {
            const { data, errors } = validateDriver(values);
            if (Object.keys(errors).length) return clear(message, notice(Object.values(errors).join(' · ')));
            const { error } = await app.supabase.rpc('kp_driver_save', { p_id: id, p_full_name: data.full_name, p_license_no: data.license_no, p_active: active });
            if (error) return clear(message, notice(ttnErrorText(error)));
            clear(message);
            toast(id ? 'Водія збережено' : 'Водія додано');
            load();
        };
        const rows = drivers.map((d) => {
            const n = h('input', { type: 'text', maxlength: 200, value: d.full_name, disabled: !access.canWrite, 'aria-label': 'ПІБ водія ' + d.full_name });
            const l = h('input', { type: 'text', maxlength: 30, value: d.license_no || '', disabled: !access.canWrite, class: 'mono', 'aria-label': 'Посвідчення водія ' + d.full_name });
            return h('tr', { class: d.active ? '' : 'is-archived' },
                h('td', { 'data-label': 'ПІБ' }, n),
                h('td', { 'data-label': 'Посвідчення' }, l),
                h('td', { 'data-label': 'Статус' }, d.active ? 'активний' : 'неактивний'),
                h('td', { 'data-label': '' }, access.canWrite ? h('div', { class: 'actions' },
                    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => saveDriver(d.id, { full_name: n.value, license_no: l.value }, d.active) }, 'Зберегти'),
                    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => saveDriver(d.id, { full_name: n.value, license_no: l.value }, !d.active) },
                        d.active ? 'Деактивувати' : 'Повернути')) : null));
        });
        return h('div', null,
            h('p', { class: 'muted small' }, 'Лише ПІБ і номер посвідчення — для ТТН. Видалення немає: неактивний водій зникає з вибору, але лишається в уже виданих ТТН. '
                + 'Дані бачать лише учасники вашої компанії.'),
            access.canWrite ? h('form', {
                class: 'toolbar', novalidate: true,
                onsubmit: (event) => { event.preventDefault(); saveDriver(null, { full_name: name.value, license_no: license.value }, true); },
            }, name, license, h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Додати водія')) : null,
            message,
            drivers.length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['ПІБ', 'Посвідчення', 'Статус', ''].map((t) => h('th', null, t)))),
                h('tbody', null, rows))) : h('p', { class: 'muted' }, 'Водіїв ще немає.'));
    }

    load();
    return box;
}
