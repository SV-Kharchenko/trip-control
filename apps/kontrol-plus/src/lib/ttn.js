// ТТН (етап 4b, форма № 1-ТН): чисті функції форми — обовʼязкові реквізити (дзеркало kp_ttn_create), маса, дані для
// збереження, тексти помилок. Сервер перевіряє те саме й рахує загальну масу сам; тут — підсвітка до відправки.
import { errorText } from './errors.js';
import { kyivDate } from './format.js';

export const TTN_MAX_LINES = 50;

// Обовʼязкові реквізити ст. 48 Закону «Про автомобільний транспорт» (поле → підпис у формі й у помилці).
export const TTN_REQUIRED = [
    ['place_of_issue', 'Місце складання'],
    ['shipper.name', 'Вантажовідправник: повне найменування / ПІБ'],
    ['shipper.code', 'Вантажовідправник: код ЄДРПОУ / РНОКПП / паспорт'],
    ['consignee.name', 'Вантажоодержувач: повне найменування / ПІБ'],
    ['consignee.code', 'Вантажоодержувач: код ЄДРПОУ / РНОКПП / паспорт'],
    ['driver.full_name', 'Водій: ПІБ'],
    ['driver.license_no', 'Водій: номер посвідчення'],
    ['vehicle.make_model', 'Автомобіль: марка, модель'],
    ['vehicle.type', 'Автомобіль: тип'],
    ['vehicle.reg_number', 'Автомобіль: реєстраційний номер'],
    ['vehicle.length_m', 'Довжина ТЗ, м'],
    ['vehicle.width_m', 'Ширина ТЗ, м'],
    ['vehicle.height_m', 'Висота ТЗ, м'],
    ['tare_t', 'Тара (маса ТЗ без вантажу), т'],
    ['cargo_gross_t', 'Маса брутто вантажу, т'],
    ['load_point', 'Пункт навантаження'],
    ['unload_point', 'Пункт розвантаження'],
];
// Причіп / напівпричіп — обовʼязкові, якщо він є (вказано номер або марку).
export const TTN_TRAILER_REQUIRED = [
    ['vehicle.trailer_make_model', 'Причіп: марка, модель'],
    ['vehicle.trailer_type', 'Причіп: тип'],
    ['vehicle.trailer_reg_number', 'Причіп: реєстраційний номер'],
];
export const TTN_FIELD_LABELS = Object.fromEntries([
    ...TTN_REQUIRED, ...TTN_TRAILER_REQUIRED,
    ['customer.name', 'Замовник: найменування'], ['customer.code', 'Замовник: код'],
    ['forwarder.name', 'Експедитор: найменування'], ['forwarder.code', 'Експедитор: код'],
    ['cargo_net_t', 'Маса нетто вантажу, т'], ['max_mass_t', 'Максимально дозволена маса, т'],
    ['places_count', 'Кількість місць'], ['total_amount', 'Усього відпущено на суму'], ['vat_amount', 'У тому числі ПДВ'],
    ['operations', 'Вантажно-розвантажувальні операції'], ['transport_kind', 'Вид перевезень'],
    ['vehicle_parking_place', 'Місце, де зберігається автомобіль'], ['readdressing', 'Переадресування вантажу'],
    ['seal_note', 'Номер пломби'], ['accompanying_docs', 'Супровідні документи'], ['received_by', 'Отримав водій / експедитор'],
    ['released_by', 'Здав'], ['accepted_by', 'Прийняв'],
]);

export const PARTY_CODE = /^([0-9]{8}|[0-9]{9}|[0-9]{10}|[А-ЯҐЄІЇ]{2}[0-9]{6})$/;

// Права як у 4a: створюють owner / logist, анулює owner, директор — перегляд (docsAccess у docs.js).

function get(obj, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function filled(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

// '16,5' → 16.5; '' / null → null; не число → NaN.
export function parseNum(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const text = String(value).replace(/\s+/g, '').replace(',', '.');
    if (text === '') return null;
    return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

export function normalizeCode(value) {
    return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
}

// Тонни → кілограми цілим (без похибок float при додаванні).
function kg(value) {
    const n = parseNum(value);
    return n === null || Number.isNaN(n) ? null : Math.round(n * 1000);
}

// Загальна маса з вантажем = тара + маса брутто вантажу (15,75 + 24,09 = 39,84).
export function totalMass(tare, gross) {
    const a = kg(tare);
    const b = kg(gross);
    return a === null || b === null ? null : (a + b) / 1000;
}

// Сума мас брутто рядків, якщо маса вказана в кожному рядку; інакше null.
export function linesGross(lines) {
    const list = (lines || []).map((l) => kg(l.gross_t));
    if (!list.length || list.some((v) => v === null)) return null;
    return list.reduce((s, v) => s + v, 0) / 1000;
}

// Попередження (не помилка): загальна маса більша за максимально дозволену.
export function massWarning(tare, gross, maxMass) {
    const total = totalMass(tare, gross);
    const max = parseNum(maxMass);
    if (total === null || max === null || Number.isNaN(max) || !(max > 0)) return null;
    return total > max ? `Загальна маса ${String(total).replace('.', ',')} т більша за максимально дозволену ${String(max).replace('.', ',')} т` : null;
}

const CONTROL = /[\u0000-\u001F\u007F]/;

// Перевірка до відправлення: { поле: текст }. Ті самі правила, що kp_ttn_create.
export function validateTtn(data) {
    const errors = {};
    const d = data || {};
    for (const [path, label] of TTN_REQUIRED) {
        if (!filled(get(d, path))) errors[path] = label + ' — обовʼязково';
    }
    const v = d.vehicle || {};
    if (filled(v.trailer_reg_number) || filled(v.trailer_make_model)) {
        for (const [path, label] of TTN_TRAILER_REQUIRED) if (!filled(get(d, path))) errors[path] = label + ' — обовʼязково, якщо є причіп';
    }
    for (const party of ['shipper', 'consignee', 'customer', 'forwarder']) {
        const p = d[party] || {};
        const code = normalizeCode(p.code);
        if (code && !PARTY_CODE.test(code)) errors[party + '.code'] = 'Код: ЄДРПОУ (8 цифр), РНОКПП (10), ID-картка (9) або серія й номер паспорта';
        // Необовʼязкова сторона (замовник, експедитор): якщо щось вказано — потрібні і назва, і код.
        if ((party === 'customer' || party === 'forwarder') && (filled(p.name) || filled(p.code) || filled(p.address))) {
            if (!filled(p.name)) errors[party + '.name'] = TTN_FIELD_LABELS[party + '.name'] + ' — вкажіть разом із кодом';
            if (!filled(p.code)) errors[party + '.code'] = TTN_FIELD_LABELS[party + '.code'] + ' — вкажіть разом із назвою';
        }
    }
    for (const key of ['vehicle.length_m', 'vehicle.width_m', 'vehicle.height_m']) {
        const n = parseNum(get(d, key));
        if (n !== null && (Number.isNaN(n) || n <= 0 || n > 30)) errors[key] = TTN_FIELD_LABELS[key] + ': від 0 до 30 м';
    }
    for (const [key, max] of [['tare_t', 100], ['max_mass_t', 100], ['cargo_gross_t', 1000], ['cargo_net_t', 1000]]) {
        const n = parseNum(d[key]);
        if (n !== null && (Number.isNaN(n) || n <= 0 || n > max)) errors[key] = TTN_FIELD_LABELS[key] + ': більше 0, до ' + max + ' т';
    }
    const gross = parseNum(d.cargo_gross_t);
    const net = parseNum(d.cargo_net_t);
    if (!errors.cargo_net_t && net !== null && gross !== null && !Number.isNaN(gross) && net > gross) errors.cargo_net_t = 'Маса нетто не може бути більшою за брутто';
    const places = parseNum(d.places_count);
    if (places !== null && (Number.isNaN(places) || !Number.isInteger(places) || places < 0)) errors.places_count = 'Кількість місць — ціле число від 0';
    const total = parseNum(d.total_amount);
    const vat = parseNum(d.vat_amount);
    if (total !== null && (Number.isNaN(total) || total < 0)) errors.total_amount = 'Сума — число від 0';
    if (vat !== null && (Number.isNaN(vat) || vat < 0 || total === null || vat > total)) errors.vat_amount = 'ПДВ — не більше загальної суми (і лише разом із сумою)';
    for (const key of ['place_of_issue', 'load_point', 'unload_point']) {
        if (filled(d[key]) && CONTROL.test(String(d[key]))) errors[key] = TTN_FIELD_LABELS[key] + ': без службових символів';
    }
    const lines = d.lines || [];
    if (!lines.length) errors.lines = 'Додайте хоча б один рядок вантажу';
    else if (lines.length > TTN_MAX_LINES) errors.lines = 'Не більше ' + TTN_MAX_LINES + ' рядків вантажу';
    lines.forEach((l, i) => {
        if (!filled(l.cargo_name)) errors['lines.' + i] = 'Рядок ' + (i + 1) + ': найменування вантажу';
        else if (l.owner_price && filled(l.price)) errors['lines.' + i] = 'Рядок ' + (i + 1) + ': облікова ціна власника — без ціни';
        else {
            const g = parseNum(l.gross_t);
            if (g !== null && (Number.isNaN(g) || g <= 0 || g > 1000)) errors['lines.' + i] = 'Рядок ' + (i + 1) + ': маса брутто більше 0';
        }
    });
    const sum = linesGross(lines);
    if (!errors.lines && sum !== null && gross !== null && !Number.isNaN(gross) && Math.round(sum * 1000) !== Math.round(gross * 1000)) {
        errors.cargo_gross_t = 'Маса брутто вантажу не дорівнює сумі мас у рядках (' + String(sum).replace('.', ',') + ' т)';
    }
    return errors;
}

function party(p) {
    if (!p) return null;
    const out = { name: String(p.name || '').trim(), code: normalizeCode(p.code), address: String(p.address || '').trim() };
    if (!out.name && !out.code && !out.address) return null;
    return out;
}

function num(value) {
    const n = parseNum(value);
    return n === null || Number.isNaN(n) ? null : n;
}

function text(value) {
    const t = String(value == null ? '' : value).trim();
    return t || null;
}

// Дані для kp_ttn_create: числа — числами, порожні — null.
export function ttnPayload(d) {
    const v = d.vehicle || {};
    return {
        place_of_issue: text(d.place_of_issue),
        transport_kind: text(d.transport_kind),
        vehicle_parking_place: text(d.vehicle_parking_place),
        readdressing: text(d.readdressing),
        seal_note: text(d.seal_note),
        shipper: party(d.shipper),
        consignee: party(d.consignee),
        customer: party(d.customer),
        forwarder: party(d.forwarder),
        driver: { id: d.driver && d.driver.id ? d.driver.id : null, full_name: text(d.driver && d.driver.full_name), license_no: text(d.driver && d.driver.license_no) },
        vehicle_id: d.vehicle_id || null,
        vehicle: {
            make_model: text(v.make_model), type: text(v.type), reg_number: text(v.reg_number),
            trailer_make_model: text(v.trailer_make_model), trailer_type: text(v.trailer_type), trailer_reg_number: text(v.trailer_reg_number),
            length_m: num(v.length_m), width_m: num(v.width_m), height_m: num(v.height_m),
        },
        tare_t: num(d.tare_t),
        max_mass_t: num(d.max_mass_t),
        cargo_net_t: num(d.cargo_net_t),
        cargo_gross_t: num(d.cargo_gross_t),
        load_point: text(d.load_point),
        unload_point: text(d.unload_point),
        places_count: num(d.places_count),
        accompanying_docs: text(d.accompanying_docs),
        total_amount: num(d.total_amount),
        vat_amount: num(d.vat_amount),
        received_by: text(d.received_by),
        released_by: text(d.released_by),
        accepted_by: text(d.accepted_by),
        operations: (d.operations || []).map((o) => ({
            op: o.op, gross_t: num(o.gross_t), tare_t: num(o.tare_t), net_t: num(o.net_t),
            arrival: text(o.arrival), departure: text(o.departure), idle: text(o.idle),
        })),
        lines: (d.lines || []).map(normalizeCargoLine).map((l) => ({
            cargo_name: text(l.cargo_name), animal_id: text(l.animal_id), animal_kind: text(l.animal_kind), temperature: text(l.temperature),
            unit: text(l.unit), places: num(l.places), price: l.owner_price ? null : num(l.price), owner_price: Boolean(l.owner_price),
            amount: num(l.amount), packaging: text(l.packaging), docs: text(l.docs), gross_t: num(l.gross_t), bulk: Boolean(l.bulk),
        })),
    };
}

// Графа 5 «Одиниця вимірювання» — назва (т, кг, шт…). Якщо туди вписали число (кількість), одиниця стає «т», а число йде в
// «Кількість місць» і «Маса брутто» (лише в порожні графи).
export const DEFAULT_UNIT = 'т';
export function normalizeCargoLine(line) {
    const l = line || {};
    const unit = String(l.unit === null || l.unit === undefined ? '' : l.unit).trim();
    if (!/^\d+(?:[.,]\d+)?$/.test(unit)) return l;
    const value = Number(unit.replace(',', '.'));
    const empty = (v) => v === null || v === undefined || v === '';
    return {
        ...l,
        unit: DEFAULT_UNIT,
        gross_t: empty(l.gross_t) ? value : l.gross_t,
    };
}

export function emptyLine() {
    return { cargo_name: '', unit: 'т', places: '', price: '', owner_price: false, amount: '', packaging: '', docs: '', gross_t: '', bulk: false };
}

// Початкові дані форми з kp_ttn_prefill: вантажовідправник і вантажоодержувач порожні (рішення 26.10).
export function ttnFromPrefill(pre) {
    const p = pre || {};
    const vehicle = p.vehicle || {};
    const net = p.cargo_net_t === null || p.cargo_net_t === undefined ? '' : String(p.cargo_net_t);
    return {
        doc_date: kyivDate(),
        place_of_issue: p.place_of_issue || '',
        transport_kind: '',
        vehicle_parking_place: '',
        readdressing: '',
        seal_note: '',
        shipper: { name: '', code: '', address: '' },
        consignee: { name: '', code: '', address: '' },
        customer: p.customer ? { ...p.customer } : { name: '', code: '', address: '' },
        forwarder: { name: '', code: '', address: '' },
        driver: p.driver ? { id: p.driver.id || null, full_name: p.driver.full_name || '', license_no: p.driver.license_no || '' } : { id: null, full_name: '', license_no: '' },
        vehicle_id: p.vehicle_id || null,
        vehicle: {
            make_model: vehicle.make_model || '', type: vehicle.type || '', reg_number: vehicle.reg_number || '',
            trailer_make_model: vehicle.trailer_make_model || '', trailer_type: vehicle.trailer_type || '', trailer_reg_number: vehicle.trailer_reg_number || '',
            length_m: vehicle.length_m ?? '', width_m: vehicle.width_m ?? '', height_m: vehicle.height_m ?? '',
        },
        tare_t: p.tare_t ?? '',
        max_mass_t: p.max_mass_t ?? '',
        cargo_net_t: net,
        cargo_gross_t: net,
        load_point: p.load_point || '',
        unload_point: p.unload_point || '',
        places_count: '',
        accompanying_docs: '',
        total_amount: '',
        vat_amount: '',
        received_by: p.driver && p.driver.full_name ? p.driver.full_name + ', водій' : '',
        released_by: '',
        accepted_by: '',
        operations: [{ op: 'load' }, { op: 'unload' }],
        lines: [{ ...emptyLine(), gross_t: net }],
    };
}

// Створення ТТН: сервер копіює поточні підпис і печатку реквізитів у знімок (/api/docs/assets → id), потім
// kp_ttn_create з тим самим id (як createDocument у 4a). Реквізити змінили між кроками — ще одна спроба.
// → { id } або { error } (помилка сервера — для підсвітки поля).
export async function createTtn(app, params, callApi) {
    let error = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const prep = await callApi(app, '/api/docs/assets', {});
        if (!prep.ok) return { error: { message: prep.code === 'KP_FORBIDDEN' ? 'KP_FORBIDDEN' : prep.error || 'ASSETS_FAILED' } };
        const res = await app.supabase.rpc('kp_ttn_create', { ...params, p_id: prep.doc_id });
        if (!res.error) return { id: res.data };
        error = res.error;
        if (!/DOC_ASSETS_NOT_COPIED/.test(String(error.message || ''))) break;
    }
    return { error };
}

export function ttnFileName(doc, ext = 'pdf') {
    return `ttn_${doc.number}_${String(doc.doc_date || kyivDate()).slice(0, 10)}${doc.status === 'cancelled' ? '_anulovano' : ''}.${ext}`;
}

const TTN_ERRORS = [
    [/KP_FORBIDDEN/, 'Недостатньо прав для цієї дії.'],
    [/CALC_NOT_ACCEPTED/, 'Спершу прийміть заявку: документ створюється лише з прийнятої заявки.'],
    [/REQUISITES_REQUIRED/, 'Спершу заповніть реквізити компанії: назва, ЄДРПОУ або ІПН (перевізник у ТТН — ваша компанія).'],
    [/TTN_BAD_LINES/, 'Перевірте рядки вантажу: найменування, маса більша за 0, 1–50 рядків; облікова ціна власника — без ціни.'],
    [/TTN_MASS_MISMATCH/, 'Маса брутто вантажу не дорівнює сумі мас у рядках.'],
    [/TTN_DRIVER_FORBIDDEN/, 'Водія не знайдено серед водіїв вашої компанії.'],
    [/TTN_VEHICLE_FORBIDDEN/, 'Авто не знайдено серед авто вашої компанії.'],
    [/TTN_BAD_DATA/, 'Перевірте дані ТТН.'],
    [/DOC_TRIP_FORBIDDEN/, 'Рейс не належить цьому клієнту або недоступний вам.'],
    [/DOC_NUMBER_TAKEN/, 'ТТН з таким номером цього року вже є (номери анульованих теж зайняті).'],
    [/DOC_BAD_NUMBER/, 'Номер — ціле число від 1.'],
    [/DOC_NOT_FOUND/, 'ТТН не знайдено.'],
    [/DOC_ALREADY_CANCELLED/, 'ТТН уже анульовано.'],
    [/DOC_CANCEL_REASON/, 'Вкажіть причину анулювання (до 500 символів).'],
    [/DOC_ASSETS_NOT_COPIED|DOC_ID_TAKEN/, 'Не вдалося додати підпис і печатку до ТТН. Спробуйте ще раз.'],
    [/CLIENT_NOT_FOUND/, 'Клієнта не знайдено.'],
    [/CLIENT_ARCHIVED/, 'Клієнт в архіві — поверніть його з архіву, щоб виписати ТТН.'],
    [/VEHICLE_NOT_FOUND/, 'Авто не знайдено.'],
    [/VEHICLE_DRIVER_FORBIDDEN/, 'Водія не знайдено серед водіїв вашої компанії.'],
    [/DRIVER_BAD_NAME/, 'Вкажіть ПІБ водія (до 200 символів).'],
    [/DRIVER_BAD_LICENSE/, 'Номер посвідчення — до 30 символів.'],
    [/DRIVER_LIMIT/, 'У довіднику вже 500 водіїв.'],
    [/DRIVER_BAD_PHONE/, 'Телефон: 10–15 цифр, напр. +380671234567.'],
    [/DRIVER_BAD_PASSPORT/, 'Паспорт: 2 літери + 6 цифр (АА123456) або ID-картка з 9 цифр.'],
    [/DRIVER_BAD_IPN/, 'ІПН / РНОКПП — рівно 10 цифр.'],
    [/DRIVER_BAD_ADDRESS/, 'Адреса — до 300 символів.'],
    [/DRIVER_NOT_FOUND/, 'Водія не знайдено.'],
    [/BAD_DATE/, 'Перевірте дату (не пізніше завтрашньої).'],
    [/BAD_PERIOD/, 'Перевірте період: «з» не пізніше «по», не довше двох років.'],
];

// TTN_FIELD_REQUIRED:<поле> / TTN_FIELD_INVALID:<поле> / VEHICLE_FIELD_INVALID:<поле> → текст із назвою поля.
export function ttnErrorField(error) {
    const message = String((error && (error.message || error.error_description)) || error || '');
    const m = /(TTN_FIELD_REQUIRED|TTN_FIELD_INVALID|VEHICLE_FIELD_INVALID):([a-z_.]+)/.exec(message);
    return m ? { kind: m[1], field: m[2] } : null;
}

export function ttnErrorText(error) {
    const field = ttnErrorField(error);
    if (field) {
        const label = TTN_FIELD_LABELS[field.field] || TTN_FIELD_LABELS['vehicle.' + field.field] || field.field;
        return field.kind === 'TTN_FIELD_REQUIRED' ? label + ' — обовʼязково.' : label + ' — перевірте значення.';
    }
    const message = String((error && (error.message || error.error_description)) || error || '');
    for (const [pattern, t] of TTN_ERRORS) if (pattern.test(message)) return t;
    return errorText(error);
}
