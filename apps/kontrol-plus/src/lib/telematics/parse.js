// Телематика: розбір значень із файлів звітів (CSV / Excel). Числа з комою, дати дд.мм.рррр і ISO, серійні дати Excel, «год:хв».
// Чисті функції без DOM; помилка значення = null (рядок потрапляє у список помилок з номером рядка).
import { parseDecimal, parseCsvDate } from '../csv.js';

export { normPlate } from '../plates.js';

// «1 234,5» / «1234.5» / «1.2E+3» → число-рядок ('1234.5'); порожньо → ''; некоректно або від'ємне → null.
export function parseNumber(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    const plain = parseDecimal(s);
    if (plain !== null) return plain;
    if (/^\d+([.,]\d+)?[eE][+-]?\d+$/.test(s)) {
        const n = Number(s.replace(',', '.'));
        if (Number.isFinite(n) && n >= 0) return String(n);
    }
    return null;
}

// Серійне число Excel (дні від 1899-12-30) → { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }.
export function excelSerialParts(serial) {
    const n = Number(serial);
    if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
    const ms = Math.round((n - 25569) * 86400 * 1000);
    const d = new Date(ms);
    const iso = d.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

// Дата: «31.12.2025», «2025-12-31», «2025-12-31 08:15», «31.12.2025 08:15», серійне число Excel → 'YYYY-MM-DD'; порожньо → ''; інше → null.
export function parseDate(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    if (/^\d{5}(\.\d+)?$/.test(s)) {
        const parts = excelSerialParts(s);
        return parts ? parts.date : null;
    }
    return parseCsvDate(s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, ''));
}

// Момент події: дата + необов'язковий час → 'YYYY-MM-DDTHH:MM:00' (час за замовчуванням 00:00; без часового поясу — як у звіті); інше → null.
export function parseDateTime(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    if (/^\d{5}(\.\d+)?$/.test(s)) {
        const parts = excelSerialParts(s);
        return parts ? parts.date + 'T' + parts.time : null;
    }
    const t = s.match(/[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
    const date = parseCsvDate(t ? s.slice(0, t.index).trim() : s);
    if (!date) return null;
    if (!t) return date + 'T00:00:00';
    const hh = Number(t[1]);
    const mm = Number(t[2]);
    const ss = Number(t[3] || 0);
    if (hh > 23 || mm > 59 || ss > 59) return null;
    return date + 'T' + String(hh).padStart(2, '0') + ':' + t[2] + ':' + String(ss).padStart(2, '0');
}

// Простій у хвилинах. «1:30» / «01:30:00» — години:хвилини; число — у одиницях unit ('min' | 'h'). → ціле число-рядок, '' або null.
export function parseIdleMinutes(value, unit = 'min') {
    const s = String(value ?? '').trim();
    if (!s) return '';
    const hm = s.match(/^(\d{1,4}):(\d{2})(?::(\d{2}))?$/);
    if (hm) {
        if (Number(hm[2]) > 59) return null;
        return String(Number(hm[1]) * 60 + Number(hm[2]) + (Number(hm[3] || 0) >= 30 ? 1 : 0));
    }
    const num = parseNumber(s);
    if (num === null || num === '') return num;
    return String(Math.round(Number(num) * (unit === 'h' ? 60 : 1)));
}

// Вид події за текстом: «Заправка» → refuel, «Злив» → drain; інше → null.
export function parseEventKind(value) {
    const s = String(value ?? '').trim().toLowerCase();
    if (!s) return '';
    if (/злив|слив|drain|theft|крад/.test(s)) return 'drain';
    if (/заправ|refuel|fill/.test(s)) return 'refuel';
    return null;
}
