// CSV для Excel з українською локаллю: роздільник «;», десяткова кома, UTF-8 з BOM, CRLF.
// Текст, що починається з = + - @ (або табуляції / CR), екранується апострофом — захист від формул у CSV.

function cell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100).replace('.', ',') : '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function toCsv(header, rows) {
    return '﻿' + [header, ...rows].map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

export function csvFileName(prefix, from, to) {
    return `${prefix}_${from}_${to}.csv`.replace(/[^\w.\-]+/g, '_');
}

// ---------------------------------------------------------------------------
// Розбір CSV для імпорту початкових залишків складу (етап 3a). RFC 4180: поля в лапках, "" усередині лапок,
// переноси рядків у лапках; BOM; роздільник «;» або «,» визначається за заголовком. Лише CSV UTF-8 (без .xlsx).
// ---------------------------------------------------------------------------

export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 2000;

export class CsvError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function detectDelimiter(text) {
    let semi = 0;
    let comma = 0;
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') quoted = !quoted;
        else if (!quoted && (c === '\n' || c === '\r')) break;
        else if (!quoted && c === ';') semi += 1;
        else if (!quoted && c === ',') comma += 1;
    }
    return comma > semi ? ',' : ';';
}

// → { delimiter, records: [{ line, cells }] } (line — номер рядка файлу, з якого починається запис; заголовок — 1).
export function parseCsv(input) {
    const raw = String(input ?? '');
    if (new TextEncoder().encode(raw).length > CSV_MAX_BYTES) throw new CsvError('TOO_LARGE', 'Файл більший за 1 МБ.');
    const text = raw.replace(/^﻿/, '');
    const delimiter = detectDelimiter(text);
    const records = [];
    let cells = [];
    let cell = '';
    let quoted = false;
    let line = 1;
    let start = 1;
    let fieldStarted = false;
    const endCell = () => { cells.push(cell); cell = ''; fieldStarted = false; };
    const endRecord = () => {
        endCell();
        if (cells.some((c) => c.trim() !== '')) records.push({ line: start, cells });
        cells = [];
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
            } else {
                if (c === '\n') line += 1;
                cell += c;
            }
            continue;
        }
        if (c === '"' && !fieldStarted && cell.trim() === '') { quoted = true; cell = ''; fieldStarted = true; continue; }
        if (c === delimiter) { endCell(); continue; }
        if (c === '\r' || c === '\n') {
            if (c === '\r' && text[i + 1] === '\n') i += 1;
            endRecord();
            line += 1;
            start = line;
            continue;
        }
        cell += c;
        if (c.trim() !== '') fieldStarted = true;
    }
    if (quoted) throw new CsvError('UNCLOSED_QUOTE', 'Незакриті лапки в рядку ' + start + '.');
    endRecord();
    if (records.length - 1 > CSV_MAX_ROWS) throw new CsvError('TOO_MANY_ROWS', 'Понад ' + CSV_MAX_ROWS + ' рядків. Розбийте файл на частини.');
    return { delimiter, records };
}

// «1 234,50» / «1234.5» → '1234.5'; інше → null.
export function parseDecimal(value) {
    const s = String(value ?? '').replace(/[\s ]/g, '').replace(/₴|грн\.?/gi, '');
    if (!s) return null;
    if (/^\d+([.,]\d+)?$/.test(s)) return String(Number(s.replace(',', '.')));
    return null;
}

// «31.12.2025» або «2025-12-31» → '2025-12-31'; порожньо → ''; інше → null.
export function parseCsvDate(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    let y; let m; let d;
    let match = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (match) [, d, m, y] = match.map(Number);
    else if ((match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [, y, m, d] = match.map(Number);
    else return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
}

export const IMPORT_COLUMNS = [
    { key: 'name', label: 'Назва', required: true, aliases: ['назва', 'найменування', 'name'] },
    { key: 'article', label: 'Артикул', aliases: ['артикул', 'код', 'article', 'sku'] },
    { key: 'unit', label: 'Одиниця', aliases: ['одиниця', 'од', 'од.', 'unit'] },
    { key: 'qty', label: 'Кількість', required: true, aliases: ['кількість', 'к-сть', 'залишок', 'qty'] },
    { key: 'unit_price', label: 'Ціна за одиницю', required: true, aliases: ['ціна за одиницю', 'ціна', 'собівартість', 'price', 'unit_price'] },
    { key: 'date', label: 'Дата', aliases: ['дата', 'date'] },
    { key: 'supplier', label: 'Постачальник', aliases: ['постачальник', 'supplier'] },
    { key: 'note', label: 'Примітка', aliases: ['примітка', 'коментар', 'note'] },
];

// CSV → рядки для kp_parts_import + помилки, знайдені ще в браузері (сервер однаково перевіряє все сам).
export function buildImportRows(text) {
    const { records } = parseCsv(text);
    if (!records.length) throw new CsvError('EMPTY', 'Файл порожній.');
    const header = records[0].cells.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:*]$/, ''));
    const index = {};
    for (const col of IMPORT_COLUMNS) {
        const at = header.findIndex((h) => col.aliases.includes(h));
        if (at >= 0) index[col.key] = at;
    }
    const missing = IMPORT_COLUMNS.filter((c) => c.required && index[c.key] === undefined).map((c) => c.label);
    if (missing.length) throw new CsvError('BAD_HEADER', 'У заголовку бракує колонок: ' + missing.join(', ') + '.');
    const rows = records.slice(1).map(({ line, cells }) => {
        const get = (key) => (index[key] === undefined ? '' : String(cells[index[key]] ?? '').trim());
        const qty = parseDecimal(get('qty'));
        const price = parseDecimal(get('unit_price'));
        const date = parseCsvDate(get('date'));
        return {
            line,
            name: get('name'),
            article: get('article'),
            unit: get('unit'),
            qty: qty ?? get('qty'),
            unit_price: price ?? get('unit_price'),
            date: date ?? get('date'),
            supplier: get('supplier'),
            note: get('note'),
        };
    });
    return { rows };
}

// Шаблон: UTF-8 з BOM, «;», CRLF — відкривається в Excel з українською локаллю.
export function importTemplateCsv() {
    return '﻿' + [
        IMPORT_COLUMNS.map((c) => c.label).join(';'),
        'Фільтр масляний;W 950/26;шт;4;385,50;01.10.2026;Автодеталь;',
        'Колодки гальмівні передні;;компл;2;2 150,00;01.10.2026;;Початковий залишок',
    ].join('\r\n') + '\r\n';
}
