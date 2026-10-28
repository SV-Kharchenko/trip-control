// Подорожній лист вантажного автомобіля (типова форма № 2, наказ 488/346): чиста логіка без DOM — розрахунок пробігу й
// пального (та сама формула, що kp_trip_sheet_close / kp_trip_sheet_fuel_norm у базі), форма → payload, тексти розділів
// для картки, PDF і Excel, помилки. Усе, що називається trip_sheet, — подорожній лист; ТТН — окремо (lib/ttn.js).
// Персональні дані водія (телефон, паспорт, ІПН, адреса) сюди не потрапляють: у payload йдуть лише ПІБ, посвідчення, табельний.
import { fmtDate } from './format.js';
import { errorText } from './errors.js';
import { ttnErrorText } from './ttn.js';

export const TS_STATUS_LABELS = { issued: 'Видано', closed: 'Закрито', cancelled: 'Анульовано' };
export const TS_FORM_NO = 'Типова форма № 2';
export const TS_FORM_REF = 'Подорожній лист вантажного автомобіля (типова форма № 2, наказ Мінтрансу та Мінстату від 29.12.1995 № 488/346)';

export const TS_FIELD_LABELS = {
    doc_date: 'Дата видачі', number: 'Номер', series: 'Серія', valid_from: 'Дійсний з', valid_to: 'Дійсний по',
    'driver.full_name': 'Водій: ПІБ', 'driver.license_no': 'Водій: посвідчення', 'driver.tab_no': 'Водій: табельний номер',
    'vehicle.make_model': 'Автомобіль: марка, модель', 'vehicle.reg_number': 'Автомобіль: держномер', 'vehicle.garage_no': 'Автомобіль: гаражний номер',
    'vehicle.trailer_make_model': 'Причіп: марка', 'vehicle.trailer_reg_number': 'Причіп: держномер',
    'vehicle.fuel_load': 'Норма з вантажем, л/100 км', 'vehicle.fuel_empty': 'Норма порожнього, л/100 км',
    'task.customer': 'Замовник', 'task.route_from': 'Звідки', 'task.route_to': 'Куди', 'task.feed_point': 'Подача', 'task.via': 'Проміжні точки',
    'task.cargo': 'Вантаж', 'task.tonnage': 'Маса вантажу, т', 'task.loaded_km': 'Пробіг із вантажем, км',
    'depart.at': 'Виїзд: дата і час', 'depart.odometer': 'Виїзд: спідометр, км', 'depart.fuel_left': 'Виїзд: залишок пального, л',
    'depart.fuel_issued': 'Видано пального, л', 'depart.fuel_kind': 'Марка пального',
    'medical.by': 'Передрейсовий медогляд: хто', 'medical.at': 'Передрейсовий медогляд: коли',
    'tech.by': 'Технічний огляд: хто', 'tech.at': 'Технічний огляд: коли', 'tech.ok': 'Технічно справний',
    return_at: 'Повернення: дата і час', return_odometer: 'Повернення: спідометр, км', return_fuel_left: 'Повернення: залишок пального, л',
};

export const TS_REQUIRED = [
    'driver.full_name', 'driver.license_no', 'vehicle.make_model', 'vehicle.reg_number', 'task.route_from', 'task.route_to',
    'depart.at', 'depart.odometer', 'depart.fuel_left',
];

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';
export function toNum(value) {
    if (!hasValue(value)) return null;
    const n = Number(String(value).trim().replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
}
const round1 = (n) => Math.round(n * 10) / 10;

// Нормативна витрата, л. loadedKm не задано — весь пробіг за нормою з вантажем (немає її — за порожнім); немає потрібної норми → null.
export function fuelNorm(distance, loadedKm, fuelLoad, fuelEmpty) {
    const dist = toNum(distance);
    if (dist === null || Number.isNaN(dist) || dist < 0) return null;
    const load = toNum(fuelLoad);
    const empty = toNum(fuelEmpty);
    const lk = toNum(loadedKm);
    const loaded = lk === null || Number.isNaN(lk) ? (load !== null && !Number.isNaN(load) ? dist : 0) : Math.min(Math.max(lk, 0), dist);
    const emptyKm = dist - loaded;
    const hasLoad = load !== null && !Number.isNaN(load);
    const hasEmpty = empty !== null && !Number.isNaN(empty);
    if ((loaded > 0 && !hasLoad) || (emptyKm > 0 && !hasEmpty)) return null;
    return round1(loaded * (hasLoad ? load : 0) / 100 + emptyKm * (hasEmpty ? empty : 0) / 100);
}

// Пробіг = спідометр повернення − виїзду; фактична витрата = залишок виїзду + видано − залишок повернення; різниця = факт − норма
// (плюс — перевитрата, мінус — економія). Невалідні вхідні дані → errors.
export function calcTripSheet(input) {
    const i = input || {};
    const errors = {};
    const odo0 = toNum(i.depart_odometer);
    const odo1 = toNum(i.return_odometer);
    const left0 = toNum(i.depart_fuel_left);
    const left1 = toNum(i.return_fuel_left);
    const issued = toNum(i.fuel_issued) ?? 0;
    if (odo0 === null || Number.isNaN(odo0)) errors.depart_odometer = 'Вкажіть спідометр при виїзді';
    if (odo1 === null || Number.isNaN(odo1)) errors.return_odometer = 'Вкажіть спідометр при поверненні';
    else if (odo0 !== null && !Number.isNaN(odo0) && odo1 < odo0) errors.return_odometer = 'Не менше, ніж при виїзді';
    if (left0 === null || Number.isNaN(left0)) errors.depart_fuel_left = 'Вкажіть залишок при виїзді';
    if (left1 === null || Number.isNaN(left1)) errors.return_fuel_left = 'Вкажіть залишок при поверненні';
    if (Object.keys(errors).length) return { distance_km: null, fuel_actual: null, fuel_norm: null, fuel_diff: null, errors };
    const distance = Math.round(odo1 - odo0);
    const actual = round1(left0 + issued - left1);
    if (actual < 0) errors.return_fuel_left = 'Залишок більший, ніж було пального';
    const norm = fuelNorm(distance, i.loaded_km, i.fuel_load, i.fuel_empty);
    return { distance_km: distance, fuel_actual: actual, fuel_norm: norm, fuel_diff: norm === null ? null : round1(actual - norm), errors };
}

// ---- Дата / час: поле datetime-local (YYYY-MM-DDTHH:mm, київський час) ↔ ISO із зсувом ----
export function kyivOffset(localIso) {
    const [date, time = '00:00'] = String(localIso).split('T');
    const probe = new Date(`${date}T${time}:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' }).formatToParts(probe);
    const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT+02:00';
    return name === 'GMT' ? '+00:00' : name.replace('GMT', '');
}
export function localToIso(value) {
    if (!hasValue(value)) return null;
    const v = String(value).slice(0, 16);
    return `${v}:00${kyivOffset(v)}`;
}
export function isoToLocal(iso) {
    if (!iso) return '';
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(new Date(iso));
    return parts.replace(' ', 'T');
}
export function fmtDateTime(iso) {
    if (!iso) return '—';
    const local = isoToLocal(iso);
    return `${fmtDate(local.slice(0, 10))} ${local.slice(11, 16)}`;
}

// ---- Форма ----
export function emptyTripSheet(today) {
    return {
        doc_date: today, series: '', valid_from: today, valid_to: today, client_id: '',
        driver: { id: '', full_name: '', license_no: '', tab_no: '' },
        vehicle_id: '', trailer_id: '',
        vehicle: { make_model: '', reg_number: '', garage_no: '', trailer_make_model: '', trailer_reg_number: '', fuel_load: '', fuel_empty: '' },
        task: { customer: '', route_from: '', feed_point: '', via: '', route_to: '', cargo: '', tonnage: '', loaded_km: '', planned_km: '' },
        depart: { at: '', odometer: '', fuel_left: '', fuel_issued: '', fuel_kind: 'ДП' },
        medical: { by: '', at: '' }, tech: { by: '', at: '', ok: true },
    };
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Відповідь kp_calc_doc_prefill → поля форми. Строк дії: з дати рейсу на розрахункову тривалість (днів, мінімум 1).
export function tsFromPrefill(pre, today) {
    const d = emptyTripSheet(today);
    if (!pre) return d;
    const p = pre;
    const trip = (p.dates && p.dates.trip_date) || today;
    const days = Math.max(1, Math.ceil(Number(p.dates && p.dates.days) || 1));
    d.doc_date = today;
    d.valid_from = trip;
    d.valid_to = addDays(trip, days - 1);
    if (p.client) {
        d.client_id = p.client.id || '';
        d.task.customer = p.client.legal_name || p.client.name || '';
    }
    if (p.route) {
        d.task.route_from = p.route.from || '';
        d.task.route_to = p.route.to || '';
        d.task.feed_point = p.route.base || '';
        d.task.via = Array.isArray(p.route.via) ? p.route.via.join('; ') : '';
        if (p.route.dist_km !== undefined && p.route.dist_km !== null) {
            d.task.loaded_km = String(p.route.dist_km);
            d.task.planned_km = String((Number(p.route.dist_km) || 0) + (Number(p.route.feed_km) || 0));
        }
    }
    if (p.cargo && p.cargo.tonnage !== undefined && p.cargo.tonnage !== null) d.task.tonnage = String(p.cargo.tonnage).replace('.', ',');
    if (p.vehicle) {
        d.vehicle_id = p.vehicle_id || '';
        Object.assign(d.vehicle, {
            make_model: p.vehicle.make_model || '', reg_number: p.vehicle.reg_number || '',
            fuel_load: p.vehicle.fuel_load !== undefined && p.vehicle.fuel_load !== null ? String(p.vehicle.fuel_load) : '',
            fuel_empty: p.vehicle.fuel_empty !== undefined && p.vehicle.fuel_empty !== null ? String(p.vehicle.fuel_empty) : '',
        });
    }
    if (p.trailer) {
        d.trailer_id = p.trailer_id || '';
        Object.assign(d.vehicle, { trailer_make_model: p.trailer.make_model || '', trailer_reg_number: p.trailer.plate || '' });
    }
    if (p.driver) Object.assign(d.driver, { id: p.driver.id || '', full_name: p.driver.full_name || '', license_no: p.driver.license_no || '' });
    if (p.plan_fuel_l !== undefined && p.plan_fuel_l !== null) d.depart.fuel_issued = String(p.plan_fuel_l).replace('.', ',');
    return d;
}

export function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
}

// Поля, змінені вручну відносно підставленого із заявки (snapshot — копія значень на момент підстановки).
export function prefillSnapshot(d, paths) {
    return Object.fromEntries(paths.map((p) => [p, String(getPath(d, p) ?? '')]));
}
export function changedPaths(d, snapshot) {
    return Object.keys(snapshot || {}).filter((p) => String(getPath(d, p) ?? '') !== snapshot[p]);
}

export function validateTripSheet(d) {
    const errors = {};
    for (const path of TS_REQUIRED) if (!hasValue(getPath(d, path))) errors[path] = 'Обовʼязкове поле';
    for (const path of ['depart.odometer', 'depart.fuel_left', 'depart.fuel_issued', 'vehicle.fuel_load', 'vehicle.fuel_empty', 'task.tonnage', 'task.loaded_km']) {
        const n = toNum(getPath(d, path));
        if (n !== null && (Number.isNaN(n) || n < 0)) errors[path] = 'Число не менше 0';
    }
    if (hasValue(d.valid_from) && hasValue(d.valid_to) && d.valid_to < d.valid_from) errors.valid_to = 'Не раніше, ніж «дійсний з»';
    return errors;
}

const txt = (v) => (hasValue(v) ? String(v).trim() : null);
const numOrNull = (v) => (hasValue(v) ? String(v).trim().replace(',', '.') : null);

// Те, що йде в kp_trip_sheet_create (p_data). Персональних даних водія тут немає за конструкцією.
export function tripSheetPayload(d) {
    return {
        series: txt(d.series), valid_from: d.valid_from, valid_to: d.valid_to,
        driver: { id: txt(d.driver.id), full_name: txt(d.driver.full_name), license_no: txt(d.driver.license_no), tab_no: txt(d.driver.tab_no) },
        vehicle_id: txt(d.vehicle_id), trailer_id: txt(d.trailer_id),
        vehicle: {
            make_model: txt(d.vehicle.make_model), reg_number: txt(d.vehicle.reg_number), garage_no: txt(d.vehicle.garage_no),
            trailer_make_model: txt(d.vehicle.trailer_make_model), trailer_reg_number: txt(d.vehicle.trailer_reg_number),
            fuel_load: numOrNull(d.vehicle.fuel_load), fuel_empty: numOrNull(d.vehicle.fuel_empty),
        },
        task: {
            customer: txt(d.task.customer), route_from: txt(d.task.route_from), route_to: txt(d.task.route_to), feed_point: txt(d.task.feed_point),
            via: hasValue(d.task.via) ? String(d.task.via).split(/[;\n]/).map((s) => s.trim()).filter(Boolean) : [],
            cargo: txt(d.task.cargo), tonnage: numOrNull(d.task.tonnage), loaded_km: numOrNull(d.task.loaded_km), planned_km: numOrNull(d.task.planned_km),
        },
        depart: {
            at: localToIso(d.depart.at), odometer: numOrNull(d.depart.odometer), fuel_left: numOrNull(d.depart.fuel_left),
            fuel_issued: numOrNull(d.depart.fuel_issued) ?? '0', fuel_kind: txt(d.depart.fuel_kind),
        },
        medical: { by: txt(d.medical.by), at: localToIso(d.medical.at) },
        tech: { by: txt(d.tech.by), at: localToIso(d.tech.at), ok: Boolean(d.tech.ok) },
    };
}

export function closePayload(c) {
    return { return_at: localToIso(c.return_at), return_odometer: numOrNull(c.return_odometer), return_fuel_left: numOrNull(c.return_fuel_left) };
}

// ---- Тексти розділів (картка, PDF, Excel — один порядок) ----
const DASH = '—';
const v = (x) => (hasValue(x) ? String(x) : DASH);
const n1 = (x) => (x === null || x === undefined || x === '' ? DASH : String(Number(x)).replace('.', ','));

export function tsHeading(doc) {
    return `Подорожній лист вантажного автомобіля № ${doc.number_text || (doc.prefix || '') + doc.number}`;
}

export function tsSections(doc) {
    const veh = doc.vehicle || {};
    const drv = doc.driver || {};
    const task = doc.task || {};
    const carrier = doc.carrier || {};
    const closed = doc.status === 'closed';
    const via = Array.isArray(task.via) ? task.via.join('; ') : '';
    return [
        { title: 'Шапка', rows: [
            ['Номер', doc.number_text || (doc.prefix || '') + doc.number],
            ['Дата видачі', fmtDate(doc.doc_date)],
            ['Строк дії', `${fmtDate(doc.valid_from)} — ${fmtDate(doc.valid_to)}`],
            ['Перевізник', [carrier.name, carrier.code ? 'код ' + carrier.code : null, carrier.address].filter(Boolean).join(', ') || DASH],
        ] },
        { title: 'ТЗ і водій', rows: [
            ['Автомобіль', [veh.make_model, veh.reg_number].filter(Boolean).join(', ') || DASH],
            ['Гаражний номер', v(veh.garage_no)],
            ['Причіп', [veh.trailer_make_model, veh.trailer_reg_number].filter(Boolean).join(', ') || DASH],
            ['Водій', drv.full_name || DASH],
            ['Посвідчення водія', v(drv.license_no)],
            ['Табельний номер', v(drv.tab_no)],
        ] },
        { title: 'Завдання', rows: [
            ['Замовник', v(task.customer)],
            ['Звідки', v(task.route_from)],
            ['Подача', v(task.feed_point)],
            ['Проміжні точки', via || DASH],
            ['Куди', v(task.route_to)],
            ['Вантаж', v(task.cargo)],
            ['Маса вантажу, т', n1(task.tonnage)],
            ['Пробіг із вантажем (план), км', n1(task.loaded_km)],
        ] },
        { title: 'Виїзд', rows: [
            ['Дата і час виїзду', fmtDateTime(doc.depart_at)],
            ['Спідометр, км', n1(doc.depart_odometer)],
            ['Залишок пального, л', n1(doc.depart_fuel_left)],
            ['Видано пального, л', n1(doc.fuel_issued)],
            ['Марка пального', v(doc.fuel_kind)],
            ['Передрейсовий медогляд', hasValue(doc.medical_by) || doc.medical_at ? `${v(doc.medical_by)}, ${fmtDateTime(doc.medical_at)}` : DASH],
            ['Технічний огляд', hasValue(doc.tech_by) || doc.tech_at ? `${v(doc.tech_by)}, ${fmtDateTime(doc.tech_at)}${doc.tech_ok ? ' — технічно справний' : ''}` : DASH],
        ] },
        { title: 'Повернення', rows: closed ? [
            ['Дата і час повернення', fmtDateTime(doc.return_at)],
            ['Спідометр, км', n1(doc.return_odometer)],
            ['Залишок пального, л', n1(doc.return_fuel_left)],
        ] : [['Статус', doc.status === 'cancelled' ? 'Анульовано' : 'Не закрито — дані повернення ще не внесено']] },
        { title: 'Розрахунок', rows: closed ? [
            ['Пробіг, км', n1(doc.distance_km)],
            ['Витрата фактична, л', n1(doc.fuel_actual)],
            ['Витрата за нормою, л', n1(doc.fuel_norm)],
            ['Різниця, л', doc.fuel_diff === null || doc.fuel_diff === undefined ? DASH
                : `${Number(doc.fuel_diff) > 0 ? '+' : ''}${n1(doc.fuel_diff)} (${Number(doc.fuel_diff) > 0 ? 'перевитрата' : Number(doc.fuel_diff) < 0 ? 'економія' : 'за нормою'})`],
        ] : [['Розрахунок', 'Після закриття листа']] },
    ];
}

export function tsFileName(doc, ext = 'pdf') {
    return `podorozhnii_list_${doc.number}_${String(doc.doc_date || '').slice(0, 10)}${doc.status === 'cancelled' ? '_anulovano' : ''}.${ext}`;
}

// ---- Помилки ----
const TS_ERRORS = [
    [/KP_FORBIDDEN/, 'Недостатньо прав для цієї дії.'],
    [/CALC_NOT_ACCEPTED/, 'Спершу прийміть заявку: документ створюється лише з прийнятої заявки.'],
    [/TS_NOT_ISSUED/, 'Лист уже закрито або анульовано.'],
    [/TS_CLOSED_IMMUTABLE/, 'Закритий лист не змінюється й не анулюється.'],
    [/TS_ODOMETER_DECREASE/, 'Спідометр при поверненні не може бути меншим, ніж при виїзді.'],
    [/TS_RETURN_BEFORE_DEPART/, 'Повернення не може бути раніше виїзду.'],
    [/TS_FUEL_NEGATIVE/, 'Залишок пального при поверненні більший, ніж було з видачею.'],
    [/TS_BAD_DATA/, 'Некоректні дані листа.'],
    [/DOC_IMMUTABLE/, 'Виданий лист не змінюється.'],
    [/DOC_NUMBER_TAKEN/, 'Такий номер уже використано.'],
    [/DOC_CANCEL_REASON/, 'Вкажіть причину анулювання (до 500 символів).'],
    [/DOC_NOT_FOUND/, 'Лист не знайдено.'],
];

export function tsErrorField(error) {
    const message = String((error && (error.message || error.error_description)) || error || '');
    const m = /(TS_FIELD_REQUIRED|TS_FIELD_INVALID|TTN_FIELD_INVALID):([a-z_.]+)/.exec(message);
    return m ? { kind: m[1], field: m[2] } : null;
}

export function tsErrorText(error) {
    const field = tsErrorField(error);
    if (field) {
        const label = TS_FIELD_LABELS[field.field] || field.field;
        return field.kind === 'TS_FIELD_REQUIRED' ? label + ' — обовʼязково.' : label + ' — перевірте значення.';
    }
    const message = String((error && (error.message || error.error_description)) || error || '');
    for (const [pattern, t] of TS_ERRORS) if (pattern.test(message)) return t;
    return /REQUISITES_REQUIRED|CLIENT_|DRIVER_|VEHICLE_|TRAILER_/.test(message) ? ttnErrorText(error) : errorText(error);
}
