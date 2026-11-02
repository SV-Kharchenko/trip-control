// Подорожній лист, зворотний бік: таблиця етапів (замовник, № ТТН, пункти, час, км з вантажем, т, т·км), підсумки, відмітки
// після рейсу, перевірка закриття. Чиста логіка без DOM; формули збігаються з базою (kp_trip_sheet_stages.tkm,
// kp_trip_sheet_close): т·км = км × т, округлення до 0,1; норма пального — за сумою км з вантажем з етапів, а без етапів — за планом із завдання.
import { NORM_NEEDS_LOADED_KM, calcTripSheet, fmtDateTime, localToIso, isoToLocal, toNum } from './trip-sheet.js';
import { refuelsTotal } from './trip-sheet-refuels.js';

export const MAX_STAGES = 50;
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const round1 = (n) => Math.round(n * 10) / 10;
const DASH = '—';
const num = (x) => (x === null || x === undefined || x === '' ? DASH : String(Number(x)).replace('.', ','));

export const STAGE_FIELDS = [
    'customer', 'ttn_no', 'load_point', 'unload_point', 'arrive_load_at', 'depart_load_at', 'arrive_unload_at', 'depart_unload_at', 'loaded_km', 'tonnage',
];
export const STAGE_LABELS = {
    customer: 'Замовник', ttn_no: '№ ТТН', load_point: 'Пункт завантаження', unload_point: 'Пункт розвантаження',
    arrive_load_at: 'Прибуття на завантаження', depart_load_at: 'Вибуття із завантаження',
    arrive_unload_at: 'Прибуття на розвантаження', depart_unload_at: 'Вибуття з розвантаження',
    loaded_km: 'Км з вантажем', tonnage: 'Тонни', tkm: 'т·км',
};

// т·км одного етапу: км × т, до 0,1. Немає одного з множників → null (як NULL у базі).
export function stageTkm(km, tonnage) {
    const k = toNum(km);
    const t = toNum(tonnage);
    if (k === null || t === null || Number.isNaN(k) || Number.isNaN(t)) return null;
    return round1(k * t);
}

export function emptyStage(seed = {}) {
    const s = Object.fromEntries(STAGE_FIELDS.map((f) => [f, '']));
    return Object.assign(s, seed);
}

// Рядок із відповіді kp_trip_sheet_get (ISO-час, числа) → поля форми (час у київському datetime-local).
export function stageFromDoc(row) {
    const s = emptyStage();
    for (const f of ['customer', 'ttn_no', 'load_point', 'unload_point']) s[f] = row[f] || '';
    for (const f of ['arrive_load_at', 'depart_load_at', 'arrive_unload_at', 'depart_unload_at']) s[f] = isoToLocal(row[f]);
    s.loaded_km = row.loaded_km === null || row.loaded_km === undefined ? '' : String(row.loaded_km).replace('.', ',');
    s.tonnage = row.tonnage === null || row.tonnage === undefined ? '' : String(row.tonnage).replace('.', ',');
    return s;
}

export function stagePayload(s) {
    const txt = (v) => (hasValue(v) ? String(v).trim() : null);
    const numOrNull = (v) => (hasValue(v) ? String(v).trim().replace(',', '.') : null);
    return {
        customer: txt(s.customer), ttn_no: txt(s.ttn_no), load_point: txt(s.load_point), unload_point: txt(s.unload_point),
        arrive_load_at: localToIso(s.arrive_load_at), depart_load_at: localToIso(s.depart_load_at),
        arrive_unload_at: localToIso(s.arrive_unload_at), depart_unload_at: localToIso(s.depart_unload_at),
        loaded_km: numOrNull(s.loaded_km), tonnage: numOrNull(s.tonnage),
    };
}

const isBlankStage = (s) => STAGE_FIELDS.every((f) => !hasValue(s[f]));
// Порожні рядки не зберігаються; порядок масиву = порядок рядків.
export function stagesPayload(list) {
    return (list || []).filter((s) => !isBlankStage(s)).map(stagePayload);
}

// → { [index]: { field: текст } }; рядок перевіряється так само, як у базі (числа ≥ 0, вибуття не раніше прибуття).
export function validateStages(list) {
    const errors = {};
    if ((list || []).length > MAX_STAGES) errors.list = 'Не більше ' + MAX_STAGES + ' етапів';
    (list || []).forEach((s, i) => {
        const e = {};
        for (const f of ['loaded_km', 'tonnage']) {
            const n = toNum(s[f]);
            if (n !== null && (Number.isNaN(n) || n < 0)) e[f] = 'Число не менше 0';
        }
        if (hasValue(s.arrive_load_at) && hasValue(s.depart_load_at) && s.depart_load_at < s.arrive_load_at) e.depart_load_at = 'Не раніше прибуття';
        if (hasValue(s.arrive_unload_at) && hasValue(s.depart_unload_at) && s.depart_unload_at < s.arrive_unload_at) e.depart_unload_at = 'Не раніше прибуття';
        if (Object.keys(e).length) errors[i] = e;
    });
    return errors;
}

// Додати / видалити / переставити рядок; повертає новий масив.
export function addStage(list, seed) {
    return (list || []).length >= MAX_STAGES ? list : [...list, emptyStage(seed)];
}
export function removeStage(list, index) {
    return list.filter((_, i) => i !== index);
}
export function moveStage(list, index, delta) {
    const to = index + delta;
    if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
    const out = list.slice();
    [out[index], out[to]] = [out[to], out[index]];
    return out;
}

// Σ км з вантажем, Σ т·км, кількість їздок (непорожні рядки).
export function stageTotals(list) {
    let km = 0;
    let tkm = 0;
    let trips = 0;
    let hasKm = false;
    let hasTkm = false;
    for (const s of list || []) {
        if (isBlankStage(s)) continue;
        trips += 1;
        const k = toNum(s.loaded_km);
        if (k !== null && !Number.isNaN(k)) { km += k; hasKm = true; }
        const t = stageTkm(s.loaded_km, s.tonnage);
        if (t !== null) { tkm += t; hasTkm = true; }
    }
    return { loaded_km: hasKm ? round1(km) : null, tkm: hasTkm ? round1(tkm) : null, trips };
}

// Км з вантажем не може бути більше за пробіг за одометрами: попередження (не блок). Джерело км — етапи або план із завдання.
export function loadedKmWarning(loadedKm, distance, fromStages) {
    const loaded = toNum(loadedKm);
    if (loaded === null || Number.isNaN(loaded) || distance === null || distance === undefined || !(loaded > distance)) return '';
    return 'Км з вантажем (' + num(loaded) + ') більше за загальний пробіг за одометрами (' + num(distance) + '). '
        + (fromStages ? 'Перевірте км в етапах або одометр.' : 'Це план із завдання — внесіть фактичні км в етапах або перевірте одометр.');
}

// Підсумки листа. Джерело правди — сервер:
//  * закритий лист: пробіг, норма, факт і різниця — збережені distance_km / fuel_norm / fuel_actual / fuel_diff (нічого не перераховуємо);
//  * збережений лист (doc.totals з kp_trip_sheet_get): км з вантажем, т·км і їздки — з doc.totals;
//  * лише для «Видано» і лише як прев'ю у формі (передано stages / returnOdometer / returnFuelLeft) — перерахунок тут:
//    норма за сумою км з вантажем з етапів (як kp_trip_sheet_close), а без етапів — за планом із завдання.
export function tsTotals(doc, { stages, refuels, returnOdometer, returnFuelLeft } = {}) {
    const preview = stages !== undefined || refuels !== undefined || returnOdometer !== undefined || returnFuelLeft !== undefined;
    const server = doc.totals || null;
    const fromStages = stageTotals(stages || (doc.stages || []).map(stageFromDoc));
    const st = !preview && server ? { loaded_km: server.loaded_km ?? null, tkm: server.tkm ?? null, trips: server.trips || 0 } : fromStages;
    // Дозаправки: у прев'ю — зі списку редактора, інакше з сервера (totals.refuel_l) або з рядків листа.
    const refuelL = refuels !== undefined ? refuelsTotal(refuels)
        : server && server.refuel_l !== undefined && server.refuel_l !== null ? Number(server.refuel_l)
            : refuelsTotal((doc.refuels || []).map((r) => ({ liters: r.liters })));
    const taskKm = (doc.task || {}).loaded_km;
    const usesStages = st.loaded_km !== null && st.loaded_km > 0;
    const loadedForCheck = usesStages ? st.loaded_km : taskKm;
    if (!preview && doc.status === 'closed') {
        const stored = (key) => (doc[key] === undefined ? null : doc[key]);
        return {
            distance_km: stored('distance_km'), loaded_km: st.loaded_km, tkm: st.tkm, trips: st.trips, refuel_l: refuelL,
            fuel_norm: stored('fuel_norm'), fuel_actual: stored('fuel_actual'), fuel_diff: stored('fuel_diff'),
            loaded_warning: loadedKmWarning(loadedForCheck, stored('distance_km'), usesStages),
        };
    }
    const task = doc.task || {};
    const veh = doc.vehicle || {};
    const odo = returnOdometer !== undefined ? returnOdometer : doc.return_odometer;
    const left = returnFuelLeft !== undefined ? returnFuelLeft : doc.return_fuel_left;
    const calc = calcTripSheet({
        depart_odometer: doc.depart_odometer, depart_fuel_left: doc.depart_fuel_left, fuel_issued: doc.fuel_issued,
        return_odometer: odo, return_fuel_left: left, fuel_refueled: refuelL,
        loaded_km: st.loaded_km !== null && st.loaded_km > 0 ? st.loaded_km : task.loaded_km, fuel_load: veh.fuel_load, fuel_empty: veh.fuel_empty,
    });
    const distance = calc.distance_km !== null ? calc.distance_km : (server && server.distance_km !== undefined ? server.distance_km : null);
    return {
        distance_km: distance, loaded_km: st.loaded_km, tkm: st.tkm, trips: st.trips, refuel_l: refuelL,
        fuel_norm: calc.fuel_norm, fuel_actual: calc.fuel_actual, fuel_diff: calc.fuel_diff,
        loaded_warning: loadedKmWarning(loadedForCheck, distance, usesStages),
    };
}

const signed = (n) => `${n > 0 ? '+' : ''}${num(n)}`;
export function totalsRows(t) {
    return [
        ['Загальний пробіг (за одометрами), км', num(t.distance_km)],
        ['Пробіг із вантажем, км', num(t.loaded_km)],
        ['Сума т·км', num(t.tkm)],
        ['Кількість їздок', t.trips ? String(t.trips) : DASH],
        ['Пальне за нормою, л', t.fuel_norm === null || t.fuel_norm === undefined
            ? (t.distance_km !== null && t.distance_km !== undefined ? DASH + ' (' + NORM_NEEDS_LOADED_KM.toLowerCase() + ')' : DASH) : num(t.fuel_norm)],
        ['Дозаправки, л', num(t.refuel_l === undefined || t.refuel_l === null ? 0 : t.refuel_l)],
        ['Пальне фактично, л', num(t.fuel_actual)],
        ['Різниця, л', t.fuel_diff === null || t.fuel_diff === undefined ? DASH
            : `${signed(t.fuel_diff)} (${t.fuel_diff > 0 ? 'перевитрата' : t.fuel_diff < 0 ? 'економія' : 'за нормою'})`],
        ...(t.loaded_warning ? [['Увага', t.loaded_warning]] : []),
    ];
}

// ---- Закриття: що має бути заповнено (те саме перевіряє kp_trip_sheet_close) ----
// → { field: текст }. Порожній об'єкт — можна закривати.
export function closeProblems(c, doc = {}) {
    const e = {};
    if (!hasValue(c.return_at)) e.return_at = 'Вкажіть дату й час повернення';
    else if (doc.depart_at && localToIso(c.return_at) && Date.parse(localToIso(c.return_at)) < Date.parse(doc.depart_at)) e.return_at = 'Повернення не раніше виїзду';
    const odo = toNum(c.return_odometer);
    if (!hasValue(c.return_odometer)) e.return_odometer = 'Вкажіть спідометр при поверненні';
    else if (Number.isNaN(odo) || odo < 0) e.return_odometer = 'Число не менше 0';
    else if (doc.depart_odometer !== undefined && odo < Number(doc.depart_odometer)) e.return_odometer = 'Не менше, ніж при виїзді';
    if (!hasValue(c.return_fuel_left)) e.return_fuel_left = 'Вкажіть залишок пального при поверненні';
    return e;
}

// ---- Відмітки (форма ↔ payload kp_trip_sheet_extra_save) ----
export const MARK_FIELDS = [
    'medical_by', 'medical_at', 'medical_ok', 'tech_by', 'tech_at', 'tech_ok',
    'medical_post_by', 'medical_post_at', 'medical_post_ok', 'mech_return_by', 'mech_return_at', 'mech_return_accepted', 'dispatcher_name',
];
export const MARK_LABELS = {
    medical_by: 'Медпрацівник (до рейсу): ПІБ', medical_at: 'Медогляд до рейсу: дата й час', medical_ok: 'Допущений до рейсу',
    tech_by: 'Механік на виїзді: ПІБ', tech_at: 'Механік на виїзді: дата й час', tech_ok: 'Автомобіль справний, виїзд дозволено',
    medical_post_by: 'Медпрацівник (після рейсу): ПІБ', medical_post_at: 'Медогляд після рейсу: дата й час', medical_post_ok: 'Відмітка про проходження',
    mech_return_by: 'Механік при поверненні: ПІБ', mech_return_at: 'Механік при поверненні: дата й час', mech_return_accepted: 'Автомобіль здав / прийняв',
    dispatcher_name: 'Диспетчер: ПІБ',
};

export function marksFromDoc(doc) {
    const m = {};
    for (const f of MARK_FIELDS) {
        if (f.endsWith('_at')) m[f] = isoToLocal(doc[f]);
        else if (f.endsWith('_ok') || f.endsWith('_accepted')) m[f] = doc[f] === true;
        else m[f] = doc[f] || '';
    }
    return m;
}

export function marksPayload(m) {
    const out = {};
    for (const f of MARK_FIELDS) {
        if (f.endsWith('_at')) out[f] = localToIso(m[f]);
        else if (f.endsWith('_ok') || f.endsWith('_accepted')) out[f] = Boolean(m[f]);
        else out[f] = hasValue(m[f]) ? String(m[f]).trim() : null;
    }
    return out;
}

// ---- Тексти: лицьовий бік (відмітки) і зворотний бік ----
const markLine = (by, at, ok, okText) => {
    if (!hasValue(by) && !at && !ok) return DASH;
    return [hasValue(by) ? by : DASH, at ? fmtDateTime(at) : DASH].join(', ') + (ok ? ' — ' + okText : '');
};

// Відмітки лицьового боку (допуск до рейсу, механік на виїзді, диспетчер) — окремий розділ для картки, PDF і Excel.
export function tsFrontMarks(doc) {
    return {
        title: 'Допуск до рейсу',
        rows: [
            ['Медогляд перед рейсом', markLine(doc.medical_by, doc.medical_at, doc.medical_ok, 'допущений')],
            ['Механік на виїзді', markLine(doc.tech_by, doc.tech_at, doc.tech_ok, 'автомобіль справний, виїзд дозволено')],
            ['Диспетчер', hasValue(doc.dispatcher_name) ? doc.dispatcher_name : DASH],
        ],
    };
}

// Відмітки після рейсу + підсумки (зворотний бік).
export function tsBackSections(doc, totals) {
    return [
        {
            title: 'Після рейсу',
            rows: [
                ['Медогляд після рейсу', markLine(doc.medical_post_by, doc.medical_post_at, doc.medical_post_ok, 'пройшов')],
                ['Механік при поверненні', markLine(doc.mech_return_by, doc.mech_return_at, doc.mech_return_accepted, 'автомобіль здав / прийняв')],
            ],
        },
        { title: 'Підсумки', rows: totalsRows(totals || tsTotals(doc)) },
    ];
}

export const STAGE_COLUMNS = [
    ['№', 3], ['Замовник', 13], ['№ ТТН', 12], ['Завантаження', 14], ['Розвантаження', 14],
    ['Прибуття / вибуття (завантаження)', 15], ['Прибуття / вибуття (розвантаження)', 15], ['Км з вантажем', 7], ['Т', 4], ['т·км', 7],
];

const fmtPair = (arrive, depart) => (arrive || depart ? `${arrive ? fmtDateTime(arrive) : DASH} / ${depart ? fmtDateTime(depart) : DASH}` : DASH);

// Рядки таблиці етапів (текст) для картки, PDF і Excel. Тут же т·км з бази (r.tkm) або перерахунок.
export function tsStageRows(doc) {
    return (doc.stages || []).map((r, i) => [
        String(i + 1), r.customer || DASH, r.ttn_no || DASH, r.load_point || DASH, r.unload_point || DASH,
        fmtPair(r.arrive_load_at, r.depart_load_at), fmtPair(r.arrive_unload_at, r.depart_unload_at),
        num(r.loaded_km), num(r.tonnage), num(r.tkm !== undefined && r.tkm !== null ? r.tkm : stageTkm(r.loaded_km, r.tonnage)),
    ]);
}


// Диспетчер за замовчуванням — поточний користувач (імʼя з профілю входу, інакше email); у формі це поле можна змінити.
export function dispatcherName(user) {
    const meta = (user && user.user_metadata) || {};
    return String(meta.full_name || meta.name || (user && user.email) || '').trim();
}

// Перший етап із завдання листа (замовник, звідки → куди, км з вантажем, тонни) — payload для kp_trip_sheet_extra_save.
export function firstStage(d) {
    const t = (d && d.task) || {};
    return stagePayload(emptyStage({
        customer: t.customer || '', load_point: t.route_from || '', unload_point: t.route_to || '', loaded_km: t.loaded_km || '', tonnage: t.tonnage || '',
    }));
}
