// Мінімальний запис .xlsx (Office Open XML) без сторонніх бібліотек таблиць: лише fflate.zipSync для архіву.
// Один аркуш: [Content_Types].xml, _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels, xl/styles.xml,
// xl/sharedStrings.xml, xl/worksheets/sheet1.xml. Лише запис, без парсингу.
//
// Безпека (formula injection): жодного <f> — формул у файлі немає взагалі. Текст, що починається з = + - @, TAB або CR,
// пишеться як текст зі стилем quotePrefix (Excel / LibreOffice показують його як текст і не обчислюють навіть після
// редагування комірки). Числа пишуться лише як t="n" з числа JS, ніколи з рядка. Усі значення XML-екрануються, керівні
// символи (крім TAB і LF) видаляються, назва аркуша ≤ 31 символ без []:*?/\.
import { zipSync, strToU8 } from 'fflate';

const NUM_FMTS = { money: 164, mass: 165, date: 166, int: 1 };
const NUM_FMT_CODES = { 164: '#,##0.00', 165: '0.000', 166: 'dd.mm.yyyy' };

// Стилі комірок: шрифт (0 звичайний, 1 жирний, 2 заголовок, 3 червоний жирний, 4 дрібний сірий), заливка, рамка,
// формат числа, перенос / вирівнювання. Для кожного стилю є варіант «…Q» з quotePrefix (для небезпечного тексту).
const STYLE_SPECS = {
    default: {},
    bold: { font: 1 },
    title: { font: 2 },
    alarm: { font: 3 },
    small: { font: 4, wrap: true },
    wrap: { wrap: true },
    label: { font: 1, wrap: true },
    boldRight: { font: 1, right: true },
    cell: { border: true, wrap: true },
    cellBold: { border: true, font: 1, wrap: true },
    head: { border: true, font: 1, fill: true, wrap: true, center: true },
    num: { border: true },
    money: { border: true, fmt: 'money' },
    moneyBold: { border: true, font: 1, fmt: 'money' },
    mass: { border: true, fmt: 'mass' },
    massBold: { border: true, font: 1, fmt: 'mass' },
    int: { border: true, fmt: 'int' },
    date: { border: true, fmt: 'date' },
    datePlain: { fmt: 'date' },
    moneyPlain: { fmt: 'money' },
    massPlain: { fmt: 'mass' },
};
export const STYLE_NAMES = Object.keys(STYLE_SPECS);
const STYLE_INDEX = {};
const XFS = [];
for (const name of STYLE_NAMES) {
    STYLE_INDEX[name] = XFS.length;
    XFS.push({ ...STYLE_SPECS[name], quote: false });
    STYLE_INDEX[name + 'Q'] = XFS.length;
    XFS.push({ ...STYLE_SPECS[name], quote: true });
}

// Керівні символи, яких не має бути у файлі (XML 1.0 їх не допускає або вони небезпечні): усе < 0x20, крім TAB і LF,
// а також DEL, C1 і неприпустимі U+FFFE / U+FFFF і самотні сурогати.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(value) {
    return String(value == null ? '' : value).replace(CONTROL, '');
}

export function xmlEscape(value) {
    return cleanText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Текст, який табличний процесор міг би сприйняти як формулу або команду (CSV / DDE): = + - @ TAB CR на початку.
export function needsQuotePrefix(text) {
    return /^[=+\-@\t\r]/.test(String(text));
}

export function safeSheetName(name) {
    const cleaned = cleanText(name).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
    return (cleaned || 'Аркуш').slice(0, 31).trim();
}

// Дата 'YYYY-MM-DD' → серійне число Excel (система 1900, з урахуванням вигаданого 29.02.1900: від 01.03.1900 +1).
export function excelSerial(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    const days = (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86400000;
    if (!Number.isFinite(days) || days < 1) return null;
    return days < 61 ? days - 1 : days;
}

export function colName(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        out = String.fromCharCode(65 + r) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

// Комірка: null / '' — порожня; число — t="n"; рядок — текст; { v, s } — значення зі стилем;
// { date: 'YYYY-MM-DD', s } — дата серійним числом. Рядки-рядки, що виглядають як числа, лишаються текстом.
function normalizeCell(cell) {
    if (cell === null || cell === undefined || cell === '') return null;
    if (typeof cell === 'number') return { kind: 'n', v: cell, s: 'default' };
    if (typeof cell === 'string') return { kind: 's', v: cell, s: 'default' };
    if (typeof cell === 'object') {
        const s = STYLE_SPECS[cell.s] ? cell.s : 'default';
        if (cell.date !== undefined) {
            const serial = excelSerial(cell.date);
            return serial === null ? (cell.date ? { kind: 's', v: String(cell.date), s } : (STYLE_SPECS[s].border ? { kind: 'blank', s } : null))
                : { kind: 'n', v: serial, s };
        }
        const v = cell.v;
        if (v === null || v === undefined || v === '') return STYLE_SPECS[s].border ? { kind: 'blank', s } : null;
        if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'n', v, s } : null;
        return { kind: 's', v: String(v), s };
    }
    return { kind: 's', v: String(cell), s: 'default' };
}

function stylesXml() {
    const fonts = [
        '<font><sz val="10"/><name val="Arial"/><family val="2"/></font>',
        '<font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font>',
        '<font><b/><sz val="13"/><name val="Arial"/><family val="2"/></font>',
        '<font><b/><sz val="12"/><color rgb="FFC0281F"/><name val="Arial"/><family val="2"/></font>',
        '<font><sz val="8"/><color rgb="FF5F6B69"/><name val="Arial"/><family val="2"/></font>',
    ];
    const fills = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEBE3"/><bgColor indexed="64"/></patternFill></fill>',
    ];
    const borders = [
        '<border><left/><right/><top/><bottom/><diagonal/></border>',
        '<border><left style="thin"><color rgb="FF8C9491"/></left><right style="thin"><color rgb="FF8C9491"/></right>'
            + '<top style="thin"><color rgb="FF8C9491"/></top><bottom style="thin"><color rgb="FF8C9491"/></bottom><diagonal/></border>',
    ];
    const xfs = XFS.map((x) => {
        const numFmtId = x.fmt ? NUM_FMTS[x.fmt] : 0;
        const attrs = [`numFmtId="${numFmtId}"`, `fontId="${x.font || 0}"`, `fillId="${x.fill ? 2 : 0}"`, `borderId="${x.border ? 1 : 0}"`, 'xfId="0"'];
        if (numFmtId) attrs.push('applyNumberFormat="1"');
        if (x.font) attrs.push('applyFont="1"');
        if (x.fill) attrs.push('applyFill="1"');
        if (x.border) attrs.push('applyBorder="1"');
        if (x.quote) attrs.push('quotePrefix="1"');
        const horizontal = x.center ? ' horizontal="center"' : x.right ? ' horizontal="right"' : '';
        const align = x.wrap || x.center || x.right ? `<alignment${horizontal} vertical="${x.center ? 'center' : 'top'}"${x.wrap ? ' wrapText="1"' : ''}/>` : '';
        if (align) attrs.push('applyAlignment="1"');
        return align ? `<xf ${attrs.join(' ')}>${align}</xf>` : `<xf ${attrs.join(' ')}/>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<numFmts count="${Object.keys(NUM_FMT_CODES).length}">`
        + Object.entries(NUM_FMT_CODES).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`).join('') + '</numFmts>'
        + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
        + `<fills count="${fills.length}">${fills.join('')}</fills>`
        + `<borders count="${borders.length}">${borders.join('')}</borders>`
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>';
}

// sheet: { name, columns: [ширина у символах], rows: [ [комірки] | { cells, height } ], merges: ['A1:F1'],
//          landscape: bool, header / footer: текст колонтитула (необовʼязково) }.
export function buildXlsx(sheet) {
    const name = safeSheetName(sheet.name);
    const strings = [];
    const stringIndex = new Map();
    const sst = (text) => {
        if (!stringIndex.has(text)) {
            stringIndex.set(text, strings.length);
            strings.push(text);
        }
        return stringIndex.get(text);
    };
    let maxCol = 0;
    const rowsXml = (sheet.rows || []).map((row, r) => {
        const cells = Array.isArray(row) ? row : (row && row.cells) || [];
        const height = !Array.isArray(row) && row && row.height ? ` ht="${Number(row.height)}" customHeight="1"` : '';
        const cellsXml = cells.map((raw, c) => {
            const cell = normalizeCell(raw);
            if (!cell) return '';
            maxCol = Math.max(maxCol, c + 1);
            const ref = colName(c) + (r + 1);
            if (cell.kind === 'blank') return `<c r="${ref}" s="${STYLE_INDEX[cell.s]}"/>`;
            if (cell.kind === 'n') return `<c r="${ref}" s="${STYLE_INDEX[cell.s]}" t="n"><v>${cell.v}</v></c>`;
            const text = cleanText(cell.v);
            const style = needsQuotePrefix(text) ? cell.s + 'Q' : cell.s;
            return `<c r="${ref}" s="${STYLE_INDEX[style]}" t="s"><v>${sst(text)}</v></c>`;
        }).join('');
        return `<row r="${r + 1}"${height}>${cellsXml}</row>`;
    }).join('');
    const rowCount = Math.max(1, (sheet.rows || []).length);
    const lastCol = colName(Math.max(1, maxCol, (sheet.columns || []).length) - 1);
    const cols = (sheet.columns || []).length
        ? '<cols>' + sheet.columns.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 10}" customWidth="1"/>`).join('') + '</cols>'
        : '';
    const merges = (sheet.merges || []).filter((m) => /^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/.test(m));
    const mergeXml = merges.length ? `<mergeCells count="${merges.length}">` + merges.map((m) => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>' : '';
    const headerFooter = sheet.footer || sheet.header
        ? '<headerFooter>' + (sheet.header ? `<oddHeader>${xmlEscape(sheet.header)}</oddHeader>` : '')
            + (sheet.footer ? `<oddFooter>${xmlEscape(sheet.footer)}</oddFooter>` : '') + '</headerFooter>'
        : '';
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
        + `<dimension ref="A1:${lastCol}${rowCount}"/>`
        + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        + '<sheetFormatPr defaultRowHeight="13.8"/>'
        + cols
        + `<sheetData>${rowsXml}</sheetData>`
        + mergeXml
        + '<pageMargins left="0.5" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
        + `<pageSetup paperSize="9" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
        + headerFooter
        + '</worksheet>';
    const sharedXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`
        + strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('') + '</sst>';
    const files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + '<Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            + '</Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            + '</Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            + '<workbookPr date1904="false"/>'
            + `<sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets>`
            + '</workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            + '</Relationships>',
        'xl/styles.xml': stylesXml(),
        'xl/sharedStrings.xml': sharedXml,
        'xl/worksheets/sheet1.xml': sheetXml,
    };
    const entries = {};
    for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
    // Фіксована дата в архіві: однакові дані — однаковий файл.
    return zipSync(entries, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
