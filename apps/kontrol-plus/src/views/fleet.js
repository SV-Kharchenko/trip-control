// «Автопарк»: підвкладки Авто / Причепи на спільному шаблоні (views/registry.js): пошук за номером (підрядок, нормалізація
// кирилиця → латиниця) + «Додати …», список лише для читання, клік по рядку — картка в стилі 1С.
// Авто — kp_vehicles_list; причепи — окрема сутність fleet_trailers (kp_trailers_list, міграція 20261028110000).
// Права: номер, марку, строки, причіп за замовчуванням і зміни самих причепів — власник (прямий запис, RLS);
// поля для ТТН — власник і логіст (kp_vehicle_save / kp_trailer_save).
// «Деактивувати» авто = прибрати з автопарку (в моделі авто немає прапора «активне»); «Деактивувати» причіп = active = false
// (причіп знімається з усіх тягачів і зникає з вибору).
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

const dash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));
const DATE_KEYS = ['oscpv_on', 'kasko_on', 'green_card_on', 'inspection_on', 'tachograph_on', 'service_on'];
const TTN_KEYS = ['vehicle_type', 'length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t', 'default_driver_id'];
const NUM_KEYS = ['length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t', 'capacity_t', 'volume_m3'];
const toNum = (value) => {
    const text = String(value === null || value === undefined ? '' : value).trim().replace(',', '.');
    if (text === '') return null;
    return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
};

// Рядки списків. Авто — з kp_vehicles_list; причепи — з kp_trailers_list (trailers). Стану й пробігу в цих даних ще немає — «—».
export function vehicleRows(vehicles, sub, today, trailers = []) {
    if (sub === 'trailers') {
        return (trailers || []).map((t) => ({
            id: t.id, trailer: t, plate: t.plate, model: t.make_model, type: t.type, capacity: t.capacity_t,
            tractors: (t.vehicle_labels || []).join(', '), active: t.active !== false, service: t.service_on || null, today,
        }));
    }
    return (vehicles || []).map((v) => ({ id: v.id, vehicle: v, plate: v.label, model: v.make_model, type: v.vehicle_type, state: null, mileage: null, service: v.service_on || null, today }));
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
    const trailerTab = sub === 'trailers';
    const today = kyivDate();
    let vehicles = [];
    let drivers = [];
    let trailers = [];

    const tabs = h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи автопарку' }, FLEET_TABS.map((t) =>
        h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === (trailerTab ? 'trailers' : 'cars') ? ' on' : ''), 'aria-current': t.sub === (trailerTab ? 'trailers' : 'cars') ? 'page' : null }, t.label)));

    function vehicleCard(row, ctx) {
        const v = row ? row.vehicle : null;
        const fields = {};
        const message = h('div', { 'aria-live': 'polite' });
        const driverOptions = [{ value: '', label: '— без водія —' }].concat(drivers
            .filter((d) => d.active || (v && d.id === v.default_driver_id))
            .map((d) => ({ value: d.id, label: d.full_name })));
        const attached = v ? trailers.find((t) => (t.vehicle_ids || []).includes(v.id)) : null;
        const trailerOptions = [{ value: '', label: '— без причепа —' }].concat(trailers
            .filter((t) => t.active || (attached && t.id === attached.id))
            .map((t) => ({ value: t.id, label: t.plate + (t.make_model ? ' · ' + t.make_model : '') })));
        const body = VEHICLE_FIELDS.map((spec) => {
            if (spec.section) return h('h3', { class: 'kpc-section' }, spec.section);
            const raw = spec.key === 'default_trailer_id' ? (attached ? attached.id : '') : (v ? v[spec.key] : '');
            const value = NUM_KEYS.includes(spec.key) ? numText(raw) : raw;
            const disabled = spec.owner ? !access.isOwner : !access.canWrite;
            const f = cardField(spec, value, { disabled, options: spec.type === 'trailer' ? trailerOptions : driverOptions });
            fields[spec.key] = f;
            if (spec.key === 'default_trailer_id' && v && access.isOwner) {
                const box = f.row.querySelector('.kpc-box');
                box.style.width = 'auto';
                f.input.style.width = '220px';
                box.appendChild(h('button', {
                    type: 'button', class: 'btn btn-sm', id: 'kpc-unhitch',
                    onclick: async () => {
                        const { error } = await app.supabase.from('fleet_vehicles').update({ default_trailer_id: null }).eq('id', v.id).select('id').single();
                        if (error) return clear(message, notice(errorText(error)));
                        f.input.value = '';
                        toast('Причіп відчеплено');
                    },
                }, 'Відчепити'));
            }
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
            const ttn = validateVehicleTtn(Object.fromEntries(TTN_KEYS.map((k) => [k, values[k]])));
            for (const key of TTN_KEYS) if (ttn.errors[key]) errors[key] = ttn.errors[key];
            showFieldErrors(fields, errors);
            if (Object.keys(errors).length) return clear(message, notice('Перевірте поля авто.'));
            let id = v ? v.id : null;
            if (access.isOwner) {
                const dates = Object.fromEntries(DATE_KEYS.map((k) => [k, values[k] || null]));
                const patch = { label, make_model: make || null, ...dates, default_trailer_id: values.default_trailer_id || null };
                const op = v
                    ? app.supabase.from('fleet_vehicles').update(patch).eq('id', id).select('id').single()
                    : app.supabase.from('fleet_vehicles').insert({ org_id: app.context.org_id, ...patch }).select('id').single();
                const { data, error } = await op;
                if (error) return clear(message, notice(errorText(error)));
                id = data.id;
            }
            if (access.canWrite && id) {
                // Без trailer_make_model: марку причепа веде картка причепа, а не авто.
                const { trailer_make_model: _skip, ...payload } = ttn.data;
                const { error } = await app.supabase.rpc('kp_vehicle_save', { p_vehicle: id, p_data: payload });
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
        const t = row ? row.trailer : null;
        const fields = {};
        const message = h('div', { 'aria-live': 'polite' });
        const typeOptions = FLEET_TRAILER_TYPES.map((x) => ({ value: x, label: x }));
        const body = TRAILER_FIELDS.map((spec) => {
            if (spec.section) return h('h3', { class: 'kpc-section' }, spec.section);
            const raw = t ? t[spec.key] : (spec.key === 'type' ? FLEET_TRAILER_TYPES[0] : '');
            const value = NUM_KEYS.includes(spec.key) ? numText(raw) : raw;
            const f = cardField(spec, value, { disabled: spec.owner ? !access.isOwner : !access.canWrite, options: typeOptions });
            fields[spec.key] = f;
            return f.row;
        });
        if (t && t.vehicle_labels && t.vehicle_labels.length) {
            body.push(h('p', { class: 'muted small' }, 'Причіп за замовчуванням у тягачів: ' + t.vehicle_labels.join(', ')));
        }
        if (t && t.active === false) body.unshift(notice('Причіп деактивовано: він знятий з тягачів і не пропонується в ТТН.', 'info'));

        async function save() {
            const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
            const errors = {};
            const plate = values.plate.trim();
            const make = values.make_model.trim();
            const cap = toNum(values.capacity_t);
            const vol = toNum(values.volume_m3);
            if (access.isOwner) {
                if (!plate || plate.length > 40) errors.plate = 'Від 1 до 40 символів';
                else if (trailers.some((x) => (!t || x.id !== t.id) && x.plate.replace(/[\s-]/g, '').toLowerCase() === plate.replace(/[\s-]/g, '').toLowerCase())) errors.plate = 'Такий причіп вже є';
            }
            if (make.length > 100) errors.make_model = 'До 100 символів';
            if (Number.isNaN(cap) || (cap !== null && (cap <= 0 || cap > 100))) errors.capacity_t = 'Більше 0, до 100 т';
            if (Number.isNaN(vol) || (vol !== null && (vol <= 0 || vol > 200))) errors.volume_m3 = 'Більше 0, до 200 м³';
            showFieldErrors(fields, errors);
            if (Object.keys(errors).length) return clear(message, notice('Перевірте поля причепа.'));
            let id = t ? t.id : null;
            if (access.isOwner) {
                const dates = Object.fromEntries(DATE_KEYS.map((k) => [k, values[k] || null]));
                const patch = { plate, type: values.type, ...dates };
                const op = t
                    ? app.supabase.from('fleet_trailers').update(patch).eq('id', id).select('id').single()
                    : app.supabase.from('fleet_trailers').insert({ org_id: app.context.org_id, ...patch }).select('id').single();
                const { data, error } = await op;
                if (error) return clear(message, notice(errorText(error)));
                id = data.id;
            }
            if (access.canWrite && id) {
                const { error } = await app.supabase.rpc('kp_trailer_save', { p_trailer: id, p_data: { make_model: make, capacity_t: cap, volume_m3: vol } });
                if (error) return clear(message, notice(ttnErrorText(error)));
            }
            clear(message);
            toast(t ? 'Причіп збережено' : 'Причіп додано');
            ctx.close(true);
        }

        const setActive = (active) => async () => {
            const { error } = await app.supabase.from('fleet_trailers').update({ active }).eq('id', t.id).select('id').single();
            if (error) return clear(message, notice(errorText(error)));
            toast(active ? 'Причіп повернено' : 'Причіп деактивовано');
            ctx.close(true);
        };
        return cardLayout({
            title: t ? t.plate : 'Новий причіп', fields: body, message, back: ctx.back,
            actions: [
                access.isOwner || access.canWrite ? h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Зберегти') : null,
                t && access.isOwner
                    ? (t.active === false ? h('button', { type: 'button', class: 'btn', onclick: setActive(true) }, 'Повернути')
                        : confirmButton('Деактивувати', 'Точно деактивувати причіп? Його буде знято з усіх тягачів.', setActive(false), 'btn btn-danger'))
                    : null,
            ],
        });
    }

    const carColumns = [
        { label: 'Номер', mono: true, cell: (r) => dash(r.plate) },
        { label: 'Марка / модель', cell: (r) => dash(r.model) },
        { label: 'Тип', cell: (r) => dash(r.type) },
        { label: 'Стан', cell: (r) => dash(r.state) },
        { label: 'Пробіг', mono: true, cell: (r) => dash(r.mileage) },
        { label: 'Найближче ТО', cell: (r) => serviceCell(r) },
    ];
    const trailerColumns = [
        { label: 'Номер', mono: true, cell: (r) => dash(r.plate) },
        { label: 'Марка / модель', cell: (r) => dash(r.model) },
        { label: 'Тип', cell: (r) => dash(r.type) },
        { label: 'Вантажопідйомність, т', mono: true, cell: (r) => dash(numText(r.capacity)) },
        { label: 'Тягач', cell: (r) => dash(r.tractors) },
        { label: 'Статус', cell: (r) => (r.active ? 'активний' : 'неактивний') },
        { label: 'Найближче ТО', cell: (r) => serviceCell(r) },
    ];

    return renderRegistry(app, {
        id: 'kpf',
        title: 'Автопарк',
        tabs,
        searchLabel: 'Держномер',
        searchPlaceholder: 'напр. 4821',
        addLabel: trailerTab ? 'Додати причіп' : 'Додати авто',
        canAdd: access.isOwner,
        columns: trailerTab ? trailerColumns : carColumns,
        match: (r, q) => plateMatches(r.plate, q),
        rowTitle: (r) => dash(r.plate),
        rowClass: (r) => (r.active === false ? 'is-archived' : ''),
        emptyText: trailerTab ? 'Причепів ще немає — натисніть «Додати причіп».' : 'Авто ще немає — натисніть «Додати авто».',
        onError: (box, error) => showError(app, box, error),
        load: async () => {
            const [veh, drv, trl] = await Promise.all([
                app.supabase.rpc('kp_vehicles_list'), app.supabase.rpc('kp_driver_list', { p_active_only: false }), app.supabase.rpc('kp_trailers_list'),
            ]);
            if (veh.error) throw veh.error;
            vehicles = veh.data || [];
            drivers = drv.error ? [] : (drv.data || []);
            trailers = trl.error ? [] : (trl.data || []);
            if (trailerTab && trl.error) throw trl.error;
            return vehicleRows(vehicles, sub, today, trailers);
        },
        renderCard: (row, ctx) => (trailerTab ? trailerCard(row, ctx) : vehicleCard(row, ctx)),
    });
}
