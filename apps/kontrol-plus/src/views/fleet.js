// «Автопарк»: підвкладки Авто / Причепи на спільному шаблоні (views/registry.js): пошук за номером (підрядок, нормалізація
// кирилиця → латиниця) + «Додати …», список лише для читання, клік по рядку — картка в стилі 1С.
// Дані — kp_vehicles_list (RLS директора обійдено RPC). Картка авто містить усе, що раніше було в блоці під
// таблицею: поля для ТТН, водій за замовчуванням, строки ТО й страхування. Права: номер, марку, строки і причеп змінює
// власник (прямий запис у fleet_vehicles, як у картці авто на сайті); поля для ТТН — власник і логіст (kp_vehicle_save).
// «Деактивувати» = прибрати авто з автопарку (в цій моделі даних немає окремого прапора «активне»), для причепа — зняти причіп.
import { h, clear, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { daysLeft, docState, validateVehicleTtn } from '../lib/fleet.js';
import { plateMatches } from '../lib/plates.js';
import { docsAccess } from '../lib/docs.js';
import { errorText } from '../lib/errors.js';
import { ttnErrorText } from '../lib/ttn.js';
import { FLEET_TRAILER_TYPES, TRAILER_FIELDS, VEHICLE_FIELDS, numText } from '../lib/registry.js';
import { cardField, cardLayout, renderRegistry, showFieldErrors } from './registry.js';
import { showError } from './docs.js';

export const FLEET_TABS = [
    { sub: 'cars', hash: '#/fleet', label: 'Авто' },
    { sub: 'trailers', hash: '#/fleet/trailers', label: 'Причепи' },
];

const COLUMNS = ['Номер', 'Марка / модель', 'Тип', 'Стан', 'Пробіг', 'Найближче ТО'];
const dash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));
const DATE_KEYS = ['oscpv_on', 'kasko_on', 'green_card_on', 'inspection_on', 'tachograph_on', 'service_on'];
const TTN_KEYS = ['vehicle_type', 'length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t', 'default_driver_id'];

// Рядок списку «Авто» / «Причепи» з запису kp_vehicles_list. Стану й пробігу в цих даних ще немає — «—».
export function vehicleRows(vehicles, sub, today) {
    const rows = [];
    for (const v of vehicles || []) {
        if (sub === 'trailers') {
            if (!v.trailer_plate) continue;
            rows.push({ id: v.id, vehicle: v, plate: v.trailer_plate, model: v.trailer_make_model, type: v.trailer_type, state: null, mileage: null, service: null });
        } else {
            rows.push({ id: v.id, vehicle: v, plate: v.label, model: v.make_model, type: v.vehicle_type, state: null, mileage: null, service: v.service_on || null, today });
        }
    }
    return rows;
}

function serviceCell(row) {
    if (!row.service) return '—';
    const state = docState(row.service, row.today);
    const days = daysLeft(row.service, row.today);
    const text = fmtDate(row.service);
    if (state === 'overdue') return [text, ' ', h('span', { class: 'kpt-badge is-overdue' }, 'прострочено')];
    if (state === 'soon') return [text, ' ', h('span', { class: 'kpt-badge is-soon' }, 'за ' + days + ' дн.')];
    return text;
}

export function renderFleetPage(app, sub = 'cars') {
    const access = docsAccess(app.context);
    const trailers = sub === 'trailers';
    const today = kyivDate();
    let vehicles = [];
    let drivers = [];

    const tabs = h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи автопарку' }, FLEET_TABS.map((t) =>
        h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === (trailers ? 'trailers' : 'cars') ? ' on' : ''), 'aria-current': t.sub === (trailers ? 'trailers' : 'cars') ? 'page' : null }, t.label)));

    function vehicleCard(row, ctx) {
        const v = row ? row.vehicle : null;
        const fields = {};
        const message = h('div', { 'aria-live': 'polite' });
        const driverOptions = [{ value: '', label: '— без водія —' }].concat(drivers
            .filter((d) => d.active || (v && d.id === v.default_driver_id))
            .map((d) => ({ value: d.id, label: d.full_name })));
        const body = VEHICLE_FIELDS.map((spec) => {
            if (spec.section) return h('h3', { class: 'kpc-section' }, spec.section);
            const raw = v ? v[spec.key] : '';
            const value = ['length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t'].includes(spec.key) ? numText(raw) : raw;
            const disabled = spec.owner ? !access.isOwner : !access.canWrite;
            const f = cardField(spec, value, { disabled, options: driverOptions });
            fields[spec.key] = f;
            return f.row;
        });

        async function save() {
            const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
            const errors = {};
            const label = values.label.trim();
            const make = values.make_model.trim();
            if (access.isOwner) {
                if (!label || label.length > 40) errors.label = 'Від 1 до 40 символів';
                if (make.length > 80) errors.make_model = 'До 80 символів';
                if (vehicles.some((x) => (!v || x.id !== v.id) && String(x.label || '').trim().toLowerCase() === label.toLowerCase())) errors.label = 'Таке авто вже є';
                if (!v && vehicles.length >= 100) errors.label = 'У списку вже 100 авто';
            }
            const ttn = validateVehicleTtn({ ...Object.fromEntries(TTN_KEYS.map((k) => [k, values[k]])), trailer_make_model: v ? v.trailer_make_model : '' });
            for (const key of TTN_KEYS) if (ttn.errors[key]) errors[key] = ttn.errors[key];
            showFieldErrors(fields, errors);
            if (Object.keys(errors).length) return clear(message, notice('Перевірте поля авто.'));
            let id = v ? v.id : null;
            if (access.isOwner) {
                const dates = Object.fromEntries(DATE_KEYS.map((k) => [k, values[k] || null]));
                const op = v
                    ? app.supabase.from('fleet_vehicles').update({ label, make_model: make || null, ...dates }).eq('id', id).select('id').single()
                    : app.supabase.from('fleet_vehicles').insert({ org_id: app.context.org_id, label, ...(make ? { make_model: make } : {}), ...dates }).select('id').single();
                const { data, error } = await op;
                if (error) return clear(message, notice(errorText(error)));
                id = data.id;
            }
            if (access.canWrite && id) {
                const { error } = await app.supabase.rpc('kp_vehicle_save', { p_vehicle: id, p_data: ttn.data });
                if (error) return clear(message, notice(ttnErrorText(error)));
            }
            clear(message);
            toast(v ? 'Авто збережено' : 'Авто додано');
            ctx.close(true);
        }

        const remove = async () => {
            const { error } = await app.supabase.from('fleet_vehicles').delete().eq('id', v.id);
            if (error) return clear(message, notice(errorText(error)));
            toast('Авто прибрано з автопарку');
            ctx.close(true);
        };
        return cardLayout({
            title: v ? v.label : 'Нове авто', fields: body, message, back: ctx.back,
            actions: [
                access.isOwner || access.canWrite ? h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Зберегти') : null,
                v && access.isOwner ? confirmButton('Деактивувати', 'Точно прибрати авто з автопарку?', remove, 'btn btn-danger') : null,
            ],
        });
    }

    function trailerCard(row, ctx) {
        const v = row ? row.vehicle : null;
        const fields = {};
        const message = h('div', { 'aria-live': 'polite' });
        const options = {
            vehicle: vehicles.filter((x) => (v ? x.id === v.id : !x.trailer_plate)).map((x) => ({ value: x.id, label: x.label + (x.make_model ? ' · ' + x.make_model : '') })),
            trailer_type: FLEET_TRAILER_TYPES.map((t) => ({ value: t, label: t })),
        };
        const body = TRAILER_FIELDS.map((spec) => {
            const value = !v ? (spec.key === 'trailer_type' ? FLEET_TRAILER_TYPES[0] : '') : (spec.key === 'vehicle_id' ? v.id : v[spec.key]);
            const disabled = spec.owner ? !access.isOwner || (spec.key === 'vehicle_id' && Boolean(v)) : !access.canWrite;
            const f = cardField(spec, value, { disabled, options: spec.type === 'vehicle' ? options.vehicle : options.trailer_type });
            fields[spec.key] = f;
            return f.row;
        });

        async function save() {
            const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
            const errors = {};
            const plate = values.trailer_plate.trim();
            const target = vehicles.find((x) => x.id === (v ? v.id : values.vehicle_id));
            if (!target) errors.vehicle_id = 'Оберіть тягач';
            if (access.isOwner && (!plate || plate.length > 40)) errors.trailer_plate = 'Від 1 до 40 символів';
            const ttn = validateVehicleTtn({ ...(target || {}), trailer_make_model: values.trailer_make_model });
            if (ttn.errors.trailer_make_model) errors.trailer_make_model = ttn.errors.trailer_make_model;
            showFieldErrors(fields, errors);
            if (Object.keys(errors).length) return clear(message, notice('Перевірте поля причепа.'));
            if (access.isOwner) {
                const { error } = await app.supabase.from('fleet_vehicles').update({ trailer_plate: plate, trailer_type: values.trailer_type }).eq('id', target.id).select('id').single();
                if (error) return clear(message, notice(errorText(error)));
            }
            if (access.canWrite) {
                const { error } = await app.supabase.rpc('kp_vehicle_save', { p_vehicle: target.id, p_data: ttn.data });
                if (error) return clear(message, notice(ttnErrorText(error)));
            }
            toast(v ? 'Причіп збережено' : 'Причіп додано');
            ctx.close(true);
        }

        const remove = async () => {
            const { error } = await app.supabase.from('fleet_vehicles').update({ trailer_plate: null }).eq('id', v.id).select('id').single();
            if (error) return clear(message, notice(errorText(error)));
            if (access.canWrite) {
                const { data } = validateVehicleTtn({ ...v, trailer_make_model: '' });
                await app.supabase.rpc('kp_vehicle_save', { p_vehicle: v.id, p_data: data });
            }
            toast('Причіп знято з тягача');
            ctx.close(true);
        };
        return cardLayout({
            title: v ? v.trailer_plate : 'Новий причіп', fields: body, message, back: ctx.back,
            actions: [
                access.isOwner || access.canWrite ? h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Зберегти') : null,
                v && access.isOwner ? confirmButton('Деактивувати', 'Точно зняти причіп з тягача?', remove, 'btn btn-danger') : null,
            ],
        });
    }

    return renderRegistry(app, {
        id: 'kpf',
        title: 'Автопарк',
        tabs,
        searchLabel: 'Держномер',
        searchPlaceholder: 'напр. 4821',
        addLabel: trailers ? 'Додати причіп' : 'Додати авто',
        canAdd: access.isOwner,
        columns: [
            { label: COLUMNS[0], mono: true, cell: (r) => dash(r.plate) },
            { label: COLUMNS[1], cell: (r) => dash(r.model) },
            { label: COLUMNS[2], cell: (r) => dash(r.type) },
            { label: COLUMNS[3], cell: (r) => dash(r.state) },
            { label: COLUMNS[4], mono: true, cell: (r) => dash(r.mileage) },
            { label: COLUMNS[5], cell: (r) => serviceCell(r) },
        ],
        match: (r, q) => plateMatches(r.plate, q),
        rowTitle: (r) => dash(r.plate),
        emptyText: trailers ? 'Причепів ще немає.' : 'Авто ще немає — натисніть «Додати авто».',
        onError: (box, error) => showError(app, box, error),
        load: async () => {
            const [veh, drv] = await Promise.all([app.supabase.rpc('kp_vehicles_list'), app.supabase.rpc('kp_driver_list', { p_active_only: false })]);
            if (veh.error) throw veh.error;
            vehicles = veh.data || [];
            drivers = drv.error ? [] : (drv.data || []);
            return vehicleRows(vehicles, sub, today);
        },
        renderCard: (row, ctx) => (trailers ? trailerCard(row, ctx) : vehicleCard(row, ctx)),
    });
}
