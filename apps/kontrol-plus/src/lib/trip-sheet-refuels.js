// Подорожній лист: дозаправки в дорозі. Чиста логіка без DOM; формули збігаються з базою (kp_trip_sheet_refuels, kp_trip_sheet_close):
// сума = літри × ціна за л (до копійки), факт пального = залишок на виїзді + видано + Σ дозаправок − залишок на поверненні.
import { fmtDateTime, isoToLocal, localToIso, toNum } from './trip-sheet.js';

export const MAX_REFUELS = 50;
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const DASH = '—';
const num = (x) => (x === null || x === undefined || x === '' ? DASH : String(Number(x)).replace('.', ','));

export const REFUEL_FIELDS = ['refuel_at', 'place', 'liters', 'price_per_l', 'pay_method', 'receipt_no'];
export const PAY_METHODS = { card: 'картка', cash: 'готівка', coupons: 'талони' };
export const REFUEL_LABELS = {
    refuel_at: 'Дата й час', place: 'Місце / АЗС', liters: 'Літри', price_per_l: 'Ціна за л, грн', amount: 'Сума, грн', pay_method: 'Оплата', receipt_no: '№ чека',
};
// Колонки друкованої таблиці: [назва, вага ширини].
export const REFUEL_COLUMNS = [['№', 3], ['Дата й час', 14], ['Місце / АЗС', 28], ['Літри', 8], ['Ціна за л, грн', 10], ['Сума, грн', 11], ['Оплата', 10], ['№ чека', 12]];

// Сума дозаправки: літри × ціна, до копійки. Немає одного з множників → null (як NULL у базі).
export function refuelAmount(liters, price) {
    const l = toNum(liters);
    const p = toNum(price);
    if (l === null || p === null || Number.isNaN(l) || Number.isNaN(p)) return null;
    return round2(l * p);
}

export function emptyRefuel(seed = {}) {
    return Object.assign(Object.fromEntries(REFUEL_FIELDS.map((f) => [f, ''])), seed);
}

// Рядок із відповіді kp_trip_sheet_get → поля форми (час у київському datetime-local).
export function refuelFromDoc(row) {
    const r = emptyRefuel();
    r.refuel_at = isoToLocal(row.refuel_at);
    r.place = row.place || '';
    r.liters = row.liters === null || row.liters === undefined ? '' : String(row.liters).replace('.', ',');
    r.price_per_l = row.price_per_l === null || row.price_per_l === undefined ? '' : String(row.price_per_l).replace('.', ',');
    r.pay_method = row.pay_method || '';
    r.receipt_no = row.receipt_no || '';
    return r;
}

const isBlank = (r) => REFUEL_FIELDS.every((f) => !hasValue(r[f]));

// Те, що йде в kp_trip_sheet_refuels_save (p_rows). Порожні рядки не зберігаються; порядок масиву = порядок рядків.
export function refuelsPayload(list) {
    const txt = (v) => (hasValue(v) ? String(v).trim() : null);
    const numOrNull = (v) => (hasValue(v) ? String(v).trim().replace(',', '.') : null);
    return (list || []).filter((r) => !isBlank(r)).map((r) => ({
        refuel_at: localToIso(r.refuel_at), place: txt(r.place), liters: numOrNull(r.liters), price_per_l: numOrNull(r.price_per_l),
        pay_method: txt(r.pay_method), receipt_no: txt(r.receipt_no),
    }));
}

// → { [index]: { field: текст } }; ті самі правила, що в базі: літри обов'язкові й > 0, ціна ≥ 0, спосіб оплати зі списку.
export function validateRefuels(list) {
    const errors = {};
    if ((list || []).length > MAX_REFUELS) errors.list = 'Не більше ' + MAX_REFUELS + ' дозаправок';
    (list || []).forEach((r, i) => {
        if (isBlank(r)) return;
        const e = {};
        const l = toNum(r.liters);
        if (!hasValue(r.liters)) e.liters = 'Вкажіть літри';
        else if (Number.isNaN(l) || l <= 0 || l > 5000) e.liters = 'Літри: число більше 0 і не більше 5000';
        const p = toNum(r.price_per_l);
        if (hasValue(r.price_per_l) && (Number.isNaN(p) || p < 0 || p > 9999)) e.price_per_l = 'Ціна: число не менше 0';
        if (hasValue(r.pay_method) && !PAY_METHODS[r.pay_method]) e.pay_method = 'Оберіть спосіб оплати зі списку';
        if (Object.keys(e).length) errors[i] = e;
    });
    return errors;
}

export function addRefuel(list, seed) {
    return (list || []).length >= MAX_REFUELS ? list : [...list, emptyRefuel(seed)];
}
export function removeRefuel(list, index) {
    return list.filter((_, i) => i !== index);
}

// Σ літрів непорожніх рядків (некоректні літри не враховуються); без рядків — 0.
export function refuelsTotal(list) {
    let sum = 0;
    for (const r of list || []) {
        const l = toNum(r.liters);
        if (l !== null && !Number.isNaN(l) && l > 0) sum += l;
    }
    return round1(sum);
}

// Рядки таблиці дозаправок (текст) для картки, PDF і Excel — з відповіді сервера (сума з бази, інакше перерахунок).
export function tsRefuelRows(doc) {
    return (doc.refuels || []).map((r, i) => [
        String(i + 1), r.refuel_at ? fmtDateTime(r.refuel_at) : DASH, r.place || DASH, num(r.liters), num(r.price_per_l),
        num(r.amount !== undefined && r.amount !== null ? r.amount : refuelAmount(r.liters, r.price_per_l)), PAY_METHODS[r.pay_method] || DASH, r.receipt_no || DASH,
    ]);
}
