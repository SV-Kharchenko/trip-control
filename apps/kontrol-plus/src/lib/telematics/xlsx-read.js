// Читання .xlsx у браузері (без відправки файлу кудись): zip розпаковує fflate, XML розбираємо без DOM — працює і в тестах Node.
// Береться перший аркуш книги. Результат: [{ line, cells }] — так само, як parseCsv().records (line — номер рядка аркуша).
import { unzipSync, strFromU8 } from 'fflate';

export const XLSX_MAX_BYTES = 5 * 1024 * 1024;
export const XLSX_MAX_ROWS = 5000;

export class XlsxError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// Текст усіх <t> усередині фрагмента (rich text складається з кількох <r><t>).
function textOf(fragment) {
    let out = '';
    for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decode(m[1]);
    return out;
}

function sharedStrings(xml) {
    if (!xml) return [];
    return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

// «B3» → індекс колонки 1 (A = 0).
function columnIndex(ref) {
    const letters = (String(ref).match(/^[A-Z]+/i) || [''])[0].toUpperCase();
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function firstSheetPath(files) {
    const workbook = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
    const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
    const sheet = workbook.match(/<sheet\b[^>]*>/);
    const rid = sheet && (sheet[0].match(/\br:id="([^"]+)"/) || [])[1];
    if (rid) {
        for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
            if (new RegExp('\\bId="' + rid + '"').test(rel[0])) {
                const target = (rel[0].match(/\bTarget="([^"]+)"/) || [])[1];
                if (target) return target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
            }
        }
    }
    return Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0] || null;
}

// bytes: Uint8Array вмісту .xlsx.
export function readXlsx(bytes, limits = {}) {
    const maxBytes = limits.maxBytes || XLSX_MAX_BYTES;
    const maxRows = limits.maxRows || XLSX_MAX_ROWS;
    if (!bytes || bytes.length > maxBytes) throw new XlsxError('TOO_LARGE', 'Файл більший за ' + Math.round(maxBytes / 1048576) + ' МБ.');
    let files;
    try {
        files = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name) && f.originalSize < 40 * 1048576 });
    } catch {
        throw new XlsxError('BAD_FILE', 'Не вдалося відкрити файл. Збережіть звіт як .xlsx або .csv і спробуйте ще раз.');
    }
    const path = firstSheetPath(files);
    if (!path || !files[path]) throw new XlsxError('NO_SHEET', 'У файлі немає аркуша з даними.');
    const strings = sharedStrings(files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : '');
    const xml = strFromU8(files[path]);
    const records = [];
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const line = Number((row[1].match(/\br="(\d+)"/) || [])[1]) || records.length + 1;
        const cells = [];
        let next = 0;
        for (const c of (row[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = c[1];
            const ref = (attrs.match(/\br="([A-Z]+\d+)"/i) || [])[1];
            const col = ref ? columnIndex(ref) : next;
            const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
            const body = c[2] || '';
            let value = '';
            if (type === 's') value = strings[Number((body.match(/<v>(\d+)<\/v>/) || [])[1])] ?? '';
            else if (type === 'inlineStr') value = textOf(body);
            else if (type === 'b') value = (body.match(/<v>([^<]*)<\/v>/) || [])[1] === '1' ? 'TRUE' : 'FALSE';
            else value = decode((body.match(/<v>([^<]*)<\/v>/) || [])[1] ?? '');
            while (cells.length < col) cells.push('');
            cells[col] = value;
            next = col + 1;
        }
        if (cells.some((v) => String(v).trim() !== '')) records.push({ line, cells });
    }
    if (records.length - 1 > maxRows) throw new XlsxError('TOO_MANY_ROWS', 'Понад ' + maxRows + ' рядків. Розбийте файл на частини.');
    return { delimiter: null, records };
}

// Байти файлу → текст CSV: UTF-8, а якщо там недійсні послідовності (Excel у Windows) — windows-1251.
export function decodeCsvBytes(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder('windows-1251').decode(bytes);
    }
}
