// Excel (.xlsx) рахунку, акта й ТТН — з тих самих даних, що й PDF (kp_doc_get / kp_ttn_get), суми й маса прописом
// як у PDF. Анульований документ — рядок «АНУЛЬОВАНО» вгорі. Модуль вантажиться лише по кнопці «Excel» (динамічний
// import, окремий чанк разом із fflate). Значення з документа йдуть комірками-текстом або числом — формул немає.
import { buildXlsx, XLSX_MIME } from './xlsx.js';
import { DOC_TITLES, dateWords, docNumberText } from './docs.js';
import { contractText, partyLines, rateLine, totalWords, totalsRows } from './pdf-docs-text.js';
import { normalizeCargoLine } from './ttn.js';
import {
    APPENDIX_REF, CARGO_COLUMNS, FOOTNOTES, FORM_NO, cancelledLine, cargoCells, cargoTotals, frontFields, operationRows, ttnHeading,
} from './ttn-text.js';

export { XLSX_MIME };

// Аркуш з об'єднаними рядками: row(cells, { span: [[з, по], …] }) — span у номерах колонок (0…).
function sheetBuilder(width) {
    const rows = [];
    const merges = [];
    const col = (i) => {
        let n = i + 1;
        let out = '';
        while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
        return out;
    };
    return {
        rows,
        merges,
        row(cells, { span = [], height } = {}) {
            const r = rows.length + 1;
            for (const [a, b] of span) if (b > a) merges.push(`${col(a)}${r}:${col(b)}${r}`);
            rows.push(height ? { cells, height } : cells);
        },
        // Текст на всю ширину (об'єднана комірка).
        line(value, s = 'default', height) {
            this.row([{ v: value, s }], { span: [[0, width - 1]], height });
        },
        blank() { rows.push([]); },
    };
}

function cancelledRow(b, doc) {
    if (doc.status !== 'cancelled') return;
    b.line(['АНУЛЬОВАНО', doc.cancelled_reason ? '— ' + doc.cancelled_reason : null].filter(Boolean).join(' '), 'alarm');
}

const DOC_COLUMNS = [5, 46, 10, 10, 14, 15];

function partyBlock(b, title, party, opts) {
    b.line(title, 'bold');
    for (const text of partyLines(party, opts)) b.line(text, 'wrap');
}

function linesTable(b, doc) {
    b.row(['№', 'Найменування', 'Од.', 'К-сть', 'Ціна', 'Сума'].map((v) => ({ v, s: 'head' })));
    (doc.lines || []).forEach((l, i) => {
        b.row([
            { v: i + 1, s: 'int' },
            { v: l.title, s: 'cell' },
            { v: l.unit || 'послуга', s: 'cell' },
            { v: Number(l.qty), s: 'num' },
            { v: Number(l.price), s: 'money' },
            { v: Number(l.amount), s: 'money' },
        ]);
    });
    for (const [label, value] of totalsRows(doc)) {
        const amount = label.startsWith('ПДВ') && Number(doc.vat_rate) !== 20 ? null
            : label.startsWith('Разом') ? Number(doc.subtotal) : label.startsWith('ПДВ') ? Number(doc.vat_amount) : Number(doc.total);
        b.row([null, null, { v: label, s: 'boldRight' }, null, null, amount === null ? { v: value, s: 'cell' } : { v: amount, s: 'moneyBold' }], { span: [[2, 4]] });
    }
    b.line('Валюта: ' + (doc.currency === 'UAH' ? 'гривня' : doc.currency), 'small');
}

export function invoiceSheet(doc) {
    const b = sheetBuilder(6);
    cancelledRow(b, doc);
    b.line(`${DOC_TITLES.invoice} № ${docNumberText(doc)}`, 'title', 20);
    b.line('від ' + dateWords(doc.doc_date));
    b.blank();
    partyBlock(b, 'Постачальник', doc.seller);
    partyBlock(b, 'Покупець', doc.buyer);
    const contract = contractText(doc.buyer);
    if (contract) b.line('Договір: ' + contract);
    b.blank();
    linesTable(b, doc);
    b.blank();
    b.line('Всього на суму: ' + totalWords(doc), 'bold', 28);
    const rate = rateLine(doc);
    if (rate) b.line(rate, 'wrap');
    if (doc.due_date) b.row([{ v: 'Оплатити до:', s: 'bold' }, null, { date: doc.due_date, s: 'datePlain' }], { span: [[0, 1]] });
    b.blank();
    const seller = doc.seller || {};
    b.line('Виписав(ла): ' + ([seller.signer_position, seller.signer_name].filter(Boolean).join(' ') || '____________________') + '      ____________ (підпис)');
    return { name: `Рахунок ${docNumberText(doc)}`, columns: DOC_COLUMNS, rows: b.rows, merges: b.merges };
}

export function actSheet(doc) {
    const b = sheetBuilder(6);
    const seller = doc.seller || {};
    const buyer = doc.buyer || {};
    cancelledRow(b, doc);
    b.line(`${DOC_TITLES.act} № ${docNumberText(doc)}`, 'title', 20);
    b.row([{ v: seller.doc_place || 'м. ______________' }, null, null, null, { date: doc.doc_date, s: 'datePlain' }], { span: [[0, 3], [4, 5]] });
    b.blank();
    const contract = contractText(buyer);
    const sellerSigner = [seller.signer_position, seller.signer_name].filter(Boolean).join(' ') || '____________________';
    const buyerSigner = [buyer.signer_position, buyer.signer_name].filter(Boolean).join(' ') || '____________________';
    b.line(`Ми, що нижче підписалися, представник Виконавця ${seller.legal_name || '—'} ${sellerSigner}, з одного боку, і представник Замовника `
        + `${buyer.legal_name || buyer.name || '—'} ${buyerSigner}, з іншого боку, склали цей акт про те, що Виконавець надав, а Замовник прийняв такі послуги`
        + `${contract ? ' згідно з договором ' + contract : ''}:`, 'wrap', 54);
    b.blank();
    linesTable(b, doc);
    b.blank();
    b.line('Загальна вартість наданих послуг: ' + totalWords(doc), 'bold', 28);
    const rate = rateLine(doc);
    if (rate) b.line(rate, 'wrap');
    b.line('Послуги надано в повному обсязі, якісно і своєчасно. Сторони претензій одна до одної не мають.', 'wrap');
    b.blank();
    b.row([{ v: 'Від Виконавця:', s: 'bold' }, null, null, { v: 'Від Замовника:', s: 'bold' }], { span: [[0, 2], [3, 5]] });
    const left = partyLines(seller);
    const right = partyLines(buyer);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        b.row([{ v: left[i] || null, s: 'wrap' }, null, null, { v: right[i] || null, s: 'wrap' }], { span: [[0, 2], [3, 5]] });
    }
    b.row([{ v: (seller.signer_position || 'Посада: ____________') + ' ____________ / ' + (seller.signer_name || '______________') + ' /' }, null, null,
        { v: (buyer.signer_position || 'Посада: ____________') + ' ____________ / ' + (buyer.signer_name || '______________') + ' /' }], { span: [[0, 2], [3, 5]] });
    b.row([{ v: '(підпис)', s: 'small' }, null, null, { v: '(підпис)        М.П.', s: 'small' }], { span: [[0, 2], [3, 5]] });
    return { name: `Акт ${docNumberText(doc)}`, columns: DOC_COLUMNS, rows: b.rows, merges: b.merges };
}

// ТТН: лицьовий бік (реквізити в порядку форми) і зворотний (відомості про вантаж, здав / прийняв, операції, виноски)
// на одному аркуші; друк — A4 альбомна, вписати по ширині.
export function ttnSheet(doc) {
    const W = CARGO_COLUMNS.length;
    const b = sheetBuilder(W);
    b.row([{ v: APPENDIX_REF, s: 'small' }, ...Array(W - 3).fill(null), { v: FORM_NO, s: 'bold' }], { span: [[0, W - 4], [W - 3, W - 1]] });
    const cancelled = cancelledLine(doc);
    if (cancelled) b.line(cancelled, 'alarm');
    b.line(ttnHeading(doc), 'title', 22);
    b.blank();
    for (const [label, value, hint] of frontFields(doc)) {
        b.row([{ v: label, s: 'label' }, null, null, { v: value, s: 'wrap' }], { span: [[0, 2], [3, W - 1]], height: String(value).length > 110 ? 30 : undefined });
        if (hint) b.row([null, null, null, { v: hint, s: 'small' }], { span: [[3, W - 1]] });
    }
    b.blank();
    b.line('Зворотний бік', 'small');
    b.line('ВІДОМОСТІ ПРО ВАНТАЖ', 'bold');
    b.row(CARGO_COLUMNS.map((c) => ({ v: c.title, s: 'head' })), { height: 80 });
    b.row(CARGO_COLUMNS.map((c) => ({ v: c.no, s: 'head' })));
    (doc.lines || []).map(normalizeCargoLine).forEach((line, i) => {
        const cells = cargoCells(line, i);
        b.row(CARGO_COLUMNS.map((c) => {
            if (c.key === 'n') return { v: i + 1, s: 'int' };
            if (c.key === 'places' && line.places !== null && line.places !== undefined) return { v: Number(line.places), s: 'int' };
            if (c.key === 'price' && !line.owner_price && line.price !== null && line.price !== undefined) return { v: Number(line.price), s: 'money' };
            if (c.key === 'amount' && line.amount !== null && line.amount !== undefined) return { v: Number(line.amount), s: 'money' };
            if (c.key === 'gross_t' && line.gross_t !== null && line.gross_t !== undefined) return { v: Number(line.gross_t), s: 'mass' };
            return { v: cells[c.key], s: 'cell' };
        }));
    });
    const totals = cargoTotals(doc);
    b.row(CARGO_COLUMNS.map((c, i) => {
        if (i === 0) return { v: 'Усього:', s: 'cellBold' };
        if (c.key === 'places') return { v: totals.places, s: 'cellBold' };
        if (c.key === 'amount') return { v: totals.amount, s: 'cellBold' };
        if (c.key === 'gross_t') return { v: Number(doc.cargo_gross_t), s: 'massBold' };
        return { v: null, s: 'cell' };
    }), { span: [[0, 1]] });
    b.blank();
    const half = Math.floor(W / 2);
    b.row([{ v: 'Здав (відповідальна особа вантажовідправника)', s: 'bold' }, ...Array(half - 1).fill(null), { v: 'Прийняв (відповідальна особа вантажоодержувача)', s: 'bold' }],
        { span: [[0, half - 1], [half, W - 1]] });
    b.row([{ v: (doc.released_by || '') + ' ____________' }, ...Array(half - 1).fill(null), { v: (doc.accepted_by || '') + ' ____________' }],
        { span: [[0, half - 1], [half, W - 1]] });
    b.row([{ v: '(ПІБ, посада, підпис)', s: 'small' }, ...Array(half - 1).fill(null), { v: '(ПІБ, посада, підпис)', s: 'small' }],
        { span: [[0, half - 1], [half, W - 1]] });
    b.blank();
    b.line('ВАНТАЖНО-РОЗВАНТАЖУВАЛЬНІ ОПЕРАЦІЇ', 'bold');
    const opHead = ['Операція', 'Маса брутто, т (брутто/тара/нетто)', 'Час прибуття (год хв)', 'Час вибуття (год хв)', 'Час простою (год хв)', 'Підпис відповідальної особи'];
    const opSpan = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]];
    const spread = (values, s) => {
        const out = [];
        values.forEach((v, i) => { out.push({ v, s: Array.isArray(s) ? s[i] : s }); out.push({ v: null, s: Array.isArray(s) ? s[i] : s }); });
        return out;
    };
    b.row(spread(opHead, 'head'), { span: opSpan, height: 30 });
    b.row(spread(['1', '2', '3', '4', '5', '6'], 'head'), { span: opSpan });
    for (const op of operationRows(doc)) b.row(spread([op.label, op.mass, op.arrival, op.departure, op.idle, ''], 'cell'), { span: opSpan, height: 22 });
    b.blank();
    for (const note of FOOTNOTES) b.line(note, 'small', 24);
    return { name: `ТТН ${docNumberText(doc)}`, columns: [5, 30, 13, 10, 12, 9, 9, 11, 12, 12, 14, 10], rows: b.rows, merges: b.merges, landscape: true };
}

export function docSheet(doc) {
    if (doc.kind === 'invoice') return invoiceSheet(doc);
    if (doc.kind === 'act') return actSheet(doc);
    if (doc.kind === 'ttn') return ttnSheet(doc);
    throw new Error('docSheet: unknown kind ' + doc.kind);
}

export function buildDocXlsx(doc) {
    return buildXlsx(docSheet(doc));
}

export function xlsxFileName(doc) {
    const kind = doc.kind === 'act' ? 'akt' : doc.kind === 'invoice' ? 'rakhunok' : doc.kind === 'ttn' ? 'ttn' : 'doc';
    return `${kind}_${doc.number}_${String(doc.doc_date || '').slice(0, 10)}${doc.status === 'cancelled' ? '_anulovano' : ''}.xlsx`;
}
