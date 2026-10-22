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
