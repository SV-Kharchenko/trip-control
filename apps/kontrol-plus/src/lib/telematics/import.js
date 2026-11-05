// Телематика: мапінг колонок файлу звіту й перетворення рядків у формат RPC tm_import_reports / tm_import_fuel_events.
// Валідація по рядках: порожні рядки пропускаємо, помилки збираємо списком { line, message } (номер рядка файлу), без alert.
import { parseDate, parseDateTime, parseEventKind, parseIdleMinutes, parseNumber } from './parse.js';

export const IMPORT_KINDS = {
    reports: 'Денні звіти (пробіг, пальне, простій)',
    fuel_events: 'Заправки / зливи',
};

// Поля мапінгу. required — без них імпорт неможливий.
export const FIELDS = {
    reports: [
        { key: 'date', label: 'Дата', required: true, hints: ['дата', 'date', 'день'] },
        { key: 'ref', label: 'Держномер', required: true, hints: ['держномер', 'держ. номер', 'номер', 'авто', 'транспорт', 'машина', 'plate', 'vehicle', 'name'] },
        { key: 'mileage', label: 'Пробіг', hints: ['пробіг', 'пробег', 'відстань', 'mileage', 'distance', 'км'] },
        { key: 'fuel', label: 'Пальне', hints: ['пальне', 'паливо', 'витрата', 'топливо', 'расход', 'fuel'] },
        { key: 'idle', label: 'Простій', hints: ['простій', 'простои', 'простой', 'стоянка', 'idle'] },
        { key: 'engine', label: 'Мотогодини', hints: ['мотогодин', 'моточас', 'моточасы', 'engine'] },
    ],
    fuel_events: [
        { key: 'ts', label: 'Дата й час', required: true, hints: ['дата', 'час', 'date', 'time'] },
        { key: 'ref', label: 'Держномер', required: true, hints: ['держномер', 'номер', 'авто', 'транспорт', 'машина', 'plate', 'vehicle'] },
        { key: 'liters', label: 'Літри', required: true, hints: ['літр', 'литр', 'обсяг', 'об\'єм', 'кількість', 'volume', 'liters'] },
        { key: 'kind', label: 'Тип (заправка / злив)', hints: ['тип', 'подія', 'событие', 'вид', 'type', 'event'] },
        { key: 'location', label: 'Місце', hints: ['місце', 'место', 'адреса', 'location', 'address', 'азс'] },
    ],
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Припущення мапінгу за заголовками: для кожного поля — перший заголовок, що містить підказку. Одна колонка — одному полю.
export function guessMapping(kind, headers) {
    const used = new Set();
    const mapping = {};
    for (const field of FIELDS[kind]) {
        const idx = headers.findIndex((h, i) => !used.has(i) && field.hints.some((hint) => norm(h).includes(hint)));
        if (idx >= 0) { mapping[field.key] = headers[idx]; used.add(idx); }
    }
    return mapping;
}

// Збережений шаблон діє, лише якщо всі його заголовки є у файлі; інакше — припущення за заголовками.
export function applyTemplate(kind, template, headers) {
    const has = (h) => headers.some((x) => norm(x) === norm(h));
    const entries = template && typeof template === 'object' ? Object.entries(template).filter(([k, v]) => FIELDS[kind].some((f) => f.key === k) && typeof v === 'string' && v) : [];
    if (!entries.length || !entries.every(([, v]) => has(v))) return guessMapping(kind, headers);
    const mapping = {};
    for (const [k, v] of entries) mapping[k] = headers.find((x) => norm(x) === norm(v));
    return mapping;
}

export function missingRequired(kind, mapping) {
    return FIELDS[kind].filter((f) => f.required && !mapping[f.key]).map((f) => f.label);
}

function columnOf(headers, name) {
    return name ? headers.findIndex((h) => norm(h) === norm(name)) : -1;
}

// records[0] — заголовки; решта — рядки даних. Ліміт рядків для RPC — 5000.
export const MAX_IMPORT_ROWS = 5000;

function emptyRow(cells) {
    return !cells.some((c) => String(c ?? '').trim() !== '');
}

function numberCell(cells, col, label, errors) {
    if (col < 0) return '';
    const v = parseNumber(cells[col]);
    if (v === null) errors.push('«' + label + '»: «' + String(cells[col]).trim() + '» — не число');
    return v;
}

// → { rows, errors: [{ line, message }], empty }.
// options: { idleUnit: 'min' | 'h' }
export function buildReportRows(records, mapping, options = {}) {
    const headers = (records[0] ? records[0].cells : []).map((c) => String(c ?? '').trim());
    const col = Object.fromEntries(FIELDS.reports.map((f) => [f.key, columnOf(headers, mapping[f.key])]));
    const rows = [];
    const errors = [];
    let empty = 0;
    for (const rec of records.slice(1)) {
        if (emptyRow(rec.cells)) { empty += 1; continue; }
        const problems = [];
        const date = parseDate(rec.cells[col.date]);
        if (date === null) problems.push('«Дата»: «' + String(rec.cells[col.date]).trim() + '» — очікується дд.мм.рррр або рррр-мм-дд');
        else if (date === '') problems.push('«Дата» порожня');
        const ref = String(rec.cells[col.ref] ?? '').trim();
        if (!ref) problems.push('«Держномер» порожній');
        else if (ref.length > 40) problems.push('«Держномер» задовгий');
        const mileage = numberCell(rec.cells, col.mileage, 'Пробіг', problems);
        const fuel = numberCell(rec.cells, col.fuel, 'Пальне', problems);
        const engine = numberCell(rec.cells, col.engine, 'Мотогодини', problems);
        let idle = '';
        if (col.idle >= 0) {
            idle = parseIdleMinutes(rec.cells[col.idle], options.idleUnit);
            if (idle === null) problems.push('«Простій»: «' + String(rec.cells[col.idle]).trim() + '» — не число і не год:хв');
        }
        if (problems.length) { errors.push({ line: rec.line, message: problems.join('; ') }); continue; }
        rows.push({ date, ref, mileage_km: mileage, fuel_used_l: fuel, idle_minutes: idle, engine_hours: engine, raw: rawOf(headers, rec.cells) });
    }
    return { rows, errors, empty };
}

// options: { defaultKind: 'refuel' | 'drain' } — вид, якщо колонки «Тип» немає або в рядку порожньо.
export function buildFuelRows(records, mapping, options = {}) {
    const headers = (records[0] ? records[0].cells : []).map((c) => String(c ?? '').trim());
    const col = Object.fromEntries(FIELDS.fuel_events.map((f) => [f.key, columnOf(headers, mapping[f.key])]));
    const rows = [];
    const errors = [];
    let empty = 0;
    for (const rec of records.slice(1)) {
        if (emptyRow(rec.cells)) { empty += 1; continue; }
        const problems = [];
        const ts = parseDateTime(rec.cells[col.ts]);
        if (ts === null) problems.push('«Дата й час»: «' + String(rec.cells[col.ts]).trim() + '» — очікується дд.мм.рррр гг:хх або рррр-мм-дд');
        else if (ts === '') problems.push('«Дата й час» порожні');
        const ref = String(rec.cells[col.ref] ?? '').trim();
        if (!ref) problems.push('«Держномер» порожній');
        const liters = numberCell(rec.cells, col.liters, 'Літри', problems);
        if (liters === '') problems.push('«Літри» порожні');
        else if (liters !== null && Number(liters) <= 0) problems.push('«Літри» мають бути більше нуля');
        let kind = col.kind >= 0 ? parseEventKind(rec.cells[col.kind]) : '';
        if (kind === null) problems.push('«Тип»: «' + String(rec.cells[col.kind]).trim() + '» — очікується «Заправка» або «Злив»');
        else if (!kind) kind = options.defaultKind || '';
        if (kind === '') problems.push('не вказано тип події');
        if (problems.length) { errors.push({ line: rec.line, message: problems.join('; ') }); continue; }
        rows.push({ ts, ref, kind, liters, location: col.location >= 0 ? String(rec.cells[col.location] ?? '').trim() : '', raw: rawOf(headers, rec.cells) });
    }
    return { rows, errors, empty };
}

// Оригінальний рядок файлу (заголовок → значення) зберігаємо в raw: короткі значення, не більше 12 колонок.
function rawOf(headers, cells) {
    const raw = {};
    headers.slice(0, 12).forEach((h, i) => { if (h) raw[h.slice(0, 60)] = String(cells[i] ?? '').slice(0, 120); });
    return raw;
}
