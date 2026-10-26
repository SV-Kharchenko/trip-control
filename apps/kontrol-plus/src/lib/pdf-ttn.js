// PDF ТТН за формою № 1-ТН (етап 4b): A4 альбомна, лицьовий і зворотний бік, той самий шрифт Noto Sans, що в 4a.
// Усі реквізити додатка 7 друкуються завжди (порожні — прочерком); угорі ліворуч — посилання на додаток 7, праворуч —
// порожнє місце під QR онлайн-реєстрації (е-ТТН — етап 4c, тут не генеруємо). Кількість місць, маса брутто й сума —
// словами. Підпис і печатка — лише перевізника (наша сторона), зі знімка ТТН. Анульована — водяний знак.
// 3 примірники — опція друку (за замовчуванням один): кожен примірник — повний комплект сторінок.
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fmtDate } from './format.js';
import { docNumberText, sniffImage } from './docs.js';
import { loadFonts, wrapText } from './pdf-docs.js';
import {
    APPENDIX_REF, CARGO_COLUMNS, FOOTNOTES, FORM_NO, cargoCells, cargoTotals, frontFields, operationRows, ttnHeading,
} from './ttn-text.js';

export { loadFonts };

const PAGE = [841.89, 595.28];
const MARGIN = 28;
const BOTTOM = 34;
const WIDTH = PAGE[0] - MARGIN * 2;
const INK = rgb(0.1, 0.12, 0.12);
const MUTED = rgb(0.38, 0.42, 0.41);
const LINE = rgb(0.55, 0.58, 0.57);
const HEAD_BG = rgb(0.93, 0.92, 0.89);
// Ширини граф «Відомості про вантаж» (№ з/п, 1–11), разом — ширина сторінки.
const CARGO_WIDTHS = [22, 150, 62, 50, 62, 44, 44, 60, 64, 62, 115, 50];
const COPIES = ['Примірник 1 — Замовнику (вантажовідправнику)', 'Примірник 2 — вантажоодержувачу', 'Примірник 3 — перевізнику'];

function plain(text) {
    return String(text == null ? '' : text).replace(/[  ]/g, ' ');
}

async function embedImage(pdf, bytes) {
    if (!bytes || !bytes.length) return null;
    const kind = sniffImage(bytes);
    if (kind === 'png') return pdf.embedPng(bytes);
    if (kind === 'jpg') return pdf.embedJpg(bytes);
    return null;
}

function createLayout(pdf, fonts, pages) {
    let page = null;
    let y = 0;
    const L = {
        get page() { return page; },
        get y() { return y; },
        set y(v) { y = v; },
        newPage() {
            page = pdf.addPage(PAGE);
            pages.push(page);
            y = PAGE[1] - MARGIN;
        },
        ensure(h, onNew) {
            if (y - h < BOTTOM) {
                L.newPage();
                if (onNew) onNew();
                return true;
            }
            return false;
        },
        text(str, x, size, { bold = false, color = INK, align = 'left', width = 0 } = {}) {
            const font = bold ? fonts.bold : fonts.regular;
            const s = plain(str);
            let dx = x;
            if (align === 'right') dx = x + width - font.widthOfTextAtSize(s, size);
            if (align === 'center') dx = x + (width - font.widthOfTextAtSize(s, size)) / 2;
            page.drawText(s, { x: dx, y, size, font, color });
        },
        lines(str, size, width, bold = false) {
            return wrapText(str, bold ? fonts.bold : fonts.regular, size, width);
        },
        rect(x, top, w, h, fill) {
            page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: LINE, borderWidth: 0.5, color: fill || undefined });
        },
        hline(x1, x2, at, thickness = 0.5) {
            page.drawLine({ start: { x: x1, y: at }, end: { x: x2, y: at }, thickness, color: LINE });
        },
    };
    return L;
}

// Лицьовий бік: шапка, реквізити в порядку форми, місце підпису перевізника.
function drawFront(L, doc, marks) {
    L.newPage();
    const top = L.y;
    L.lines(APPENDIX_REF, 7, 300).forEach((line, i) => {
        L.y = top - 7 - i * 9;
        L.text(line, MARGIN, 7, { color: MUTED });
    });
    // Праворуч угорі — порожнє місце під QR онлайн-реєстрації (е-ТТН не генеруємо).
    L.y = top - 9;
    L.text(FORM_NO, MARGIN + WIDTH - 180, 9, { bold: true, align: 'right', width: 90 });
    L.y = top - 40;
    L.text(ttnHeading(doc), MARGIN, 12.5, { bold: true, align: 'center', width: WIDTH - 110 });
    L.y -= 14;
    const labelW = 190;
    const valueX = MARGIN + labelW + 8;
    const valueW = WIDTH - labelW - 8;
    for (const [label, value, hint] of frontFields(doc)) {
        const valueLines = L.lines(value, 8.5, valueW);
        const labelLines = L.lines(label, 8, labelW, true);
        const h = Math.max(valueLines.length, labelLines.length) * 10.5 + (hint ? 8 : 0) + 4;
        L.ensure(h);
        const rowTop = L.y;
        labelLines.forEach((line, i) => {
            L.y = rowTop - 8.5 - i * 10.5;
            L.text(line, MARGIN, 8, { bold: true });
        });
        valueLines.forEach((line, i) => {
            L.y = rowTop - 8.5 - i * 10.5;
            L.text(line, valueX, 8.5);
        });
        const underline = rowTop - valueLines.length * 10.5 - 1.5;
        L.hline(valueX, MARGIN + WIDTH, underline, 0.4);
        if (hint) {
            L.y = underline - 6.5;
            L.text(hint, valueX, 6, { color: MUTED });
        }
        L.y = rowTop - h;
    }
    // Підпис і печатка перевізника (наша сторона), якщо завантажені.
    L.ensure(70);
    L.y -= 16;
    const carrier = doc.carrier || {};
    const x = MARGIN + WIDTH - 360;
    L.text('Автомобільний перевізник: ' + ([carrier.signer_position, carrier.signer_name].filter(Boolean).join(' ') || '____________________'), x, 8.5, { bold: true });
    L.y -= 30;
    L.hline(x, x + 160, L.y - 2);
    if (marks.signature) {
        const s = marks.signature.scaleToFit(100, 36);
        L.page.drawImage(marks.signature, { x: x + 20, y: L.y - 4, width: s.width, height: s.height });
    }
    if (marks.stamp) {
        const s = marks.stamp.scaleToFit(70, 70);
        L.page.drawImage(marks.stamp, { x: x + 200, y: L.y - 34, width: s.width, height: s.height, opacity: 0.9 });
    }
    L.y -= 10;
    L.text('(підпис)', x + 60, 6.5, { color: MUTED });
    L.text('М.П.', x + 220, 6.5, { color: MUTED });
}

function drawCargoHead(L) {
    const size = 6.3;
    const lh = 7.4;
    const wrapped = CARGO_COLUMNS.map((c, i) => L.lines(c.title, size, CARGO_WIDTHS[i] - 4, true));
    const h = Math.max(...wrapped.map((w) => w.length)) * lh + 6;
    const top = L.y;
    let x = MARGIN;
    CARGO_COLUMNS.forEach((c, i) => {
        L.rect(x, top, CARGO_WIDTHS[i], h, HEAD_BG);
        wrapped[i].forEach((line, li) => {
            L.y = top - 3 - size - li * lh;
            L.text(line, x + 2, size, { bold: true, align: 'center', width: CARGO_WIDTHS[i] - 4 });
        });
        x += CARGO_WIDTHS[i];
    });
    const numTop = top - h;
    x = MARGIN;
    CARGO_COLUMNS.forEach((c, i) => {
        L.rect(x, numTop, CARGO_WIDTHS[i], 10);
        L.y = numTop - 7.5;
        L.text(c.no, x, 6.5, { align: 'center', width: CARGO_WIDTHS[i] });
        x += CARGO_WIDTHS[i];
    });
    L.y = numTop - 10;
}

function cargoRow(L, cells, bold = false) {
    const size = 7.2;
    const lh = 8.6;
    const wrapped = CARGO_COLUMNS.map((c, i) => L.lines(cells[c.key] ?? '', size, CARGO_WIDTHS[i] - 4, bold));
    const h = Math.max(1, ...wrapped.map((w) => w.length)) * lh + 4;
    // Не вміщається — нова сторінка з шапкою таблиці.
    L.ensure(h + 2, () => {
        L.y -= 8;
        L.text('ВІДОМОСТІ ПРО ВАНТАЖ (продовження)', MARGIN, 8, { bold: true });
        L.y -= 6;
        drawCargoHead(L);
    });
    const top = L.y;
    let x = MARGIN;
    CARGO_COLUMNS.forEach((c, i) => {
        L.rect(x, top, CARGO_WIDTHS[i], h);
        const right = ['places', 'price', 'amount', 'gross_t', 'n'].includes(c.key);
        wrapped[i].forEach((line, li) => {
            L.y = top - 2 - size - li * lh;
            L.text(line, x + 2, size, { bold, align: right ? 'right' : 'left', width: CARGO_WIDTHS[i] - 4 });
        });
        x += CARGO_WIDTHS[i];
    });
    L.y = top - h;
}

// Зворотний бік: відомості про вантаж (графи 1–11, «Усього»), здав / прийняв, вантажно-розвантажувальні операції, виноски.
function drawBack(L, doc) {
    L.newPage();
    L.y -= 8;
    L.text('Зворотний бік', MARGIN, 7, { color: MUTED });
    L.text('ВІДОМОСТІ ПРО ВАНТАЖ', MARGIN, 10, { bold: true, align: 'center', width: WIDTH });
    L.y -= 8;
    drawCargoHead(L);
    (doc.lines || []).forEach((line, i) => cargoRow(L, cargoCells(line, i)));
    const totals = cargoTotals(doc);
    cargoRow(L, { n: '', cargo_name: 'Усього:', places: totals.places, amount: totals.amount, gross_t: totals.gross_t }, true);

    L.ensure(52);
    L.y -= 18;
    const half = WIDTH / 2;
    L.text('Здав (відповідальна особа вантажовідправника)', MARGIN, 8, { bold: true });
    L.text('Прийняв (відповідальна особа вантажоодержувача)', MARGIN + half, 8, { bold: true });
    L.y -= 16;
    L.text(doc.released_by || '', MARGIN, 8.5);
    L.text(doc.accepted_by || '', MARGIN + half, 8.5);
    L.hline(MARGIN, MARGIN + half - 30, L.y - 2);
    L.hline(MARGIN + half, MARGIN + WIDTH, L.y - 2);
    L.y -= 9;
    L.text('(прізвище, власне ім’я та по батькові, посада, підпис)', MARGIN, 6, { color: MUTED });
    L.text('(прізвище, власне ім’я та по батькові, посада, підпис)', MARGIN + half, 6, { color: MUTED });

    // Вантажно-розвантажувальні операції.
    const widths = [120, 170, 110, 110, 110, WIDTH - 620];
    const head = ['Операція', 'Маса брутто, т (брутто/тара/нетто)', 'Час прибуття (год хв)', 'Час вибуття (год хв)', 'Час простою (год хв)', 'Підпис відповідальної особи'];
    L.ensure(80);
    L.y -= 16;
    L.text('ВАНТАЖНО-РОЗВАНТАЖУВАЛЬНІ ОПЕРАЦІЇ', MARGIN, 9, { bold: true, align: 'center', width: WIDTH });
    L.y -= 6;
    const row = (cells, h, fill, bold, size = 7.5) => {
        const top = L.y;
        let x = MARGIN;
        cells.forEach((cell, i) => {
            L.rect(x, top, widths[i], h, fill);
            L.y = top - 3 - size;
            L.text(cell, x + 3, size, { bold, align: i === 0 ? 'left' : 'center', width: widths[i] - 6 });
            x += widths[i];
        });
        L.y = top - h;
    };
    row(head, 16, HEAD_BG, true, 7);
    row(['1', '2', '3', '4', '5', '6'], 10, null, false, 6.5);
    for (const op of operationRows(doc)) row([op.label, op.mass, op.arrival, op.departure, op.idle, ''], 18, null, false);

    L.y -= 10;
    for (const note of FOOTNOTES) {
        for (const line of L.lines(note, 6.3, WIDTH)) {
            L.ensure(8);
            L.y -= 7.6;
            L.text(line, MARGIN, 6.3, { color: MUTED });
        }
    }
}

function drawWatermark(pages, font) {
    const text = 'АНУЛЬОВАНО';
    const size = 92;
    for (const page of pages) {
        const width = font.widthOfTextAtSize(text, size);
        const rad = (25 * Math.PI) / 180;
        page.drawText(text, {
            x: PAGE[0] / 2 - (width / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad),
            y: PAGE[1] / 2 - (width / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad),
            size, font, color: rgb(0.78, 0.16, 0.14), opacity: 0.22, rotate: degrees(25),
        });
    }
}

// doc — відповідь kp_ttn_get; fonts — байти TTF { regular, bold }; images — { signature, stamp } (необовʼязково);
// copies — 1 або 3. Повертає { bytes, info } (сторінки, водяний знак, підпис / печатка, примірники).
export async function buildTtnPdf(doc, { fonts, images = {}, copies = 1 } = {}) {
    if (!doc || doc.kind !== 'ttn') throw new Error('buildTtnPdf: ttn only');
    if (!fonts || !fonts.regular || !fonts.bold) throw new Error('buildTtnPdf: fonts required');
    const count = copies === 3 ? 3 : 1;
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const regular = await pdf.embedFont(fonts.regular, { subset: true });
    const bold = await pdf.embedFont(fonts.bold, { subset: true });
    const marks = { signature: await embedImage(pdf, images.signature), stamp: await embedImage(pdf, images.stamp) };
    pdf.setTitle(plain(`ТТН № ${docNumberText(doc)} від ${fmtDate(doc.doc_date)}`));
    pdf.setLanguage('uk-UA');
    pdf.setCreator('Контроль+ (trip-control.com)');
    pdf.setProducer('Контроль+');
    pdf.setSubject(doc.status === 'cancelled' ? 'АНУЛЬОВАНО' : 'Товарно-транспортна накладна (форма № 1-ТН)');
    const all = [];
    for (let c = 0; c < count; c += 1) {
        const pages = [];
        const L = createLayout(pdf, { regular, bold }, pages);
        drawFront(L, doc, marks);
        drawBack(L, doc);
        pages.forEach((page, i) => {
            const label = `ТТН № ${docNumberText(doc)} від ${fmtDate(doc.doc_date)} · ${i === 0 ? 'лицьовий бік' : 'зворотний бік'}`
                + (pages.length > 2 ? ` · сторінка ${i + 1} з ${pages.length}` : '') + (count > 1 ? ' · ' + COPIES[c] : '');
            page.drawText(plain(label), { x: MARGIN, y: 16, size: 7, font: regular, color: MUTED });
        });
        all.push(...pages);
    }
    const cancelled = doc.status === 'cancelled';
    if (cancelled) drawWatermark(all, bold);
    const bytes = await pdf.save();
    return {
        bytes,
        info: { pages: all.length, copies: count, watermark: cancelled, signature: Boolean(marks.signature), stamp: Boolean(marks.stamp) },
    };
}
