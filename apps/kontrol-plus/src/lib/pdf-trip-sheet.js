// PDF подорожнього листа вантажного автомобіля (типова форма № 2): A4 книжна, лицьовий бік (шапка, ТЗ і водій, завдання,
// виїзд, підписи допуску) і зворотний (повернення, розрахунок, особливі відмітки, підписи). Поля й порядок — ті самі
// розділи, що в картці й Excel (lib/trip-sheet.js tsSections). Той самий шрифт Noto Sans, що в ТТН. Анульований — водяний знак.
// Персональних даних водія (телефон, паспорт, ІПН, адреса) тут немає. Модуль вантажиться лише по кнопці PDF (окремий чанк).
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fmtDate } from './format.js';
import { docNumberText } from './docs.js';
import { loadFonts, wrapText } from './pdf-docs.js';
import { TS_FORM_NO, TS_FORM_REF, tsHeading, tsSections } from './trip-sheet.js';
import { STAGE_COLUMNS, tsBackSections, tsFrontMarks, tsStageRows, tsTotals } from './trip-sheet-stages.js';

export { loadFonts };

const PAGE = [595.28, 841.89];
// Зворотний бік — A4 альбомна: таблиця етапів із 10 колонок не обрізається.
const PAGE_BACK = [841.89, 595.28];
const MARGIN = 36;
const BOTTOM = 40;
const WIDTH = PAGE[0] - MARGIN * 2;
const INK = rgb(0.1, 0.12, 0.12);
const MUTED = rgb(0.38, 0.42, 0.41);
const LINE = rgb(0.55, 0.58, 0.57);
const HEAD_BG = rgb(0.93, 0.92, 0.89);
const LABEL_W = 190;

const plain = (text) => String(text == null ? '' : text).replace(/[  ]/g, ' ');

function createLayout(pdf, fonts, pages) {
    let page = null;
    let y = 0;
    let pageSize = PAGE;
    const L = {
        get page() { return page; },
        get y() { return y; },
        set y(value) { y = value; },
        newPage(size = PAGE) {
            page = pdf.addPage(size);
            pages.push(page);
            pageSize = size;
            y = size[1] - MARGIN;
        },
        get width() { return pageSize[0] - MARGIN * 2; },
        ensure(h) {
            if (y - h < BOTTOM) { L.newPage(pageSize); return true; }
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
            return wrapText(plain(str), bold ? fonts.bold : fonts.regular, size, width);
        },
        hline(x1, x2, at, thickness = 0.5) {
            page.drawLine({ start: { x: x1, y: at }, end: { x: x2, y: at }, thickness, color: LINE });
        },
        box(x, top, w, h, fill) {
            page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: LINE, borderWidth: 0.5, color: fill || undefined });
        },
    };
    return L;
}

// Висота розділу (для вирівнювання колонок): заголовок + рядки з урахуванням переносу.
function sectionHeight(L, section, width = WIDTH, compact = false) {
    const labelW = Math.min(LABEL_W, width * 0.48);
    const [fs, ls, pad] = compact ? [8, 10, 3] : [9, 11.5, 6];
    let total = 16 + 8;
    for (const [label, value] of section.rows) {
        const valueLines = L.lines(value, fs, width - labelW - 14);
        const labelLines = L.lines(label, fs - 0.5, labelW - 10, true);
        total += Math.max(valueLines.length, labelLines.length) * ls + pad;
    }
    return total;
}

function drawSection(L, section, x = MARGIN, width = WIDTH, { breakPages = true, compact = false } = {}) {
    const labelW = Math.min(LABEL_W, width * 0.48);
    const [fs, ls, pad] = compact ? [8, 10, 3] : [9, 11.5, 6];
    if (breakPages) L.ensure(40);
    const top = L.y;
    L.box(x, top, width, 16, HEAD_BG);
    L.y = top - 11.5;
    L.text(section.title.toUpperCase(), x + 6, 8.5, { bold: true });
    L.y = top - 16;
    for (const [label, value] of section.rows) {
        const valueLines = L.lines(value, fs, width - labelW - 14);
        const labelLines = L.lines(label, fs - 0.5, labelW - 10, true);
        const h = Math.max(valueLines.length, labelLines.length) * ls + pad;
        if (breakPages) L.ensure(h);
        const rowTop = L.y;
        labelLines.forEach((line, i) => { L.y = rowTop - fs - 1 - i * ls; L.text(line, x + 6, fs - 0.5, { bold: true }); });
        valueLines.forEach((line, i) => { L.y = rowTop - fs - 1 - i * ls; L.text(line, x + labelW + 6, fs); });
        L.y = rowTop - h;
        L.hline(x, x + width, L.y);
    }
    L.y -= compact ? 8 : 10;
}

function signatures(L, titles) {
    L.ensure(titles.length * 26 + 10);
    for (const title of titles) {
        L.y -= 20;
        L.text(title, MARGIN, 9);
        L.hline(MARGIN + 230, MARGIN + L.width - 90, L.y - 2);
        L.y -= 0;
        L.text('(підпис)', MARGIN + 230, 6.5, { color: MUTED });
    }
    L.y -= 8;
}

function drawFront(L, doc, sections) {
    L.newPage();
    const top = L.y;
    L.lines(TS_FORM_REF, 7, 360).forEach((line, i) => { L.y = top - 7 - i * 9; L.text(line, MARGIN, 7, { color: MUTED }); });
    L.y = top - 9;
    L.text(TS_FORM_NO, MARGIN + WIDTH - 110, 9, { bold: true, align: 'right', width: 110 });
    L.y = top - 46;
    L.text(tsHeading(doc), MARGIN, 14, { bold: true, align: 'center', width: WIDTH });
    L.y -= 8;
    L.text(`від ${fmtDate(doc.doc_date)}`, MARGIN, 10, { align: 'center', width: WIDTH });
    L.y -= 16;
    for (const section of [...sections.slice(0, 4), tsFrontMarks(doc)]) drawSection(L, section, MARGIN, WIDTH, { compact: true });
    signatures(L, ['Водія до рейсу допущено за станом здоров’я (медогляд)', 'Автомобіль технічно справний, випуск на лінію дозволено (механік)',
        'Автомобіль прийняв водій', 'Диспетчер, що видав лист']);
}

// Таблиця етапів: колонки пропорційні STAGE_COLUMNS, заголовок і рядки з переносом, без обрізання; заголовок повторюється на новій сторінці.
function drawStageTable(L, doc) {
    const rows = tsStageRows(doc);
    const total = STAGE_COLUMNS.reduce((sum, [, w]) => sum + w, 0);
    const widths = STAGE_COLUMNS.map(([, w]) => (w / total) * L.width);
    const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : MARGIN); return acc; }, []);
    const FONT = 7.5;
    const header = () => {
        const lines = STAGE_COLUMNS.map(([t], i) => L.lines(t, FONT, widths[i] - 6, true));
        const h = Math.max(...lines.map((l) => l.length)) * 9.5 + 6;
        const top = L.y;
        L.box(MARGIN, top, L.width, h, HEAD_BG);
        lines.forEach((ls, i) => ls.forEach((line, k) => { L.y = top - 9 - k * 9.5; L.text(line, xs[i] + 3, FONT, { bold: true }); }));
        L.y = top - h;
    };
    const body = rows.length ? rows : Array.from({ length: 5 }, (_, i) => [String(i + 1), '', '', '', '', '', '', '', '', '']);
    L.text('ЕТАПИ РЕЙСУ', MARGIN, 8.5, { bold: true });
    L.y -= 6;
    header();
    for (const row of body) {
        const cells = row.map((cell, i) => L.lines(cell, FONT, widths[i] - 6));
        const h = Math.max(...cells.map((c) => c.length), 1) * 9.5 + 8;
        if (L.y - h < BOTTOM + 150) {
            L.newPage(PAGE_BACK);
            header();
        }
        const rowTop = L.y;
        cells.forEach((ls, i) => ls.forEach((line, k) => { L.y = rowTop - 9 - k * 9.5; L.text(line, xs[i] + 3, FONT); }));
        L.y = rowTop - h;
        L.hline(MARGIN, MARGIN + L.width, L.y);
        xs.forEach((x) => L.page.drawLine({ start: { x, y: rowTop }, end: { x, y: L.y }, thickness: 0.5, color: LINE }));
        L.page.drawLine({ start: { x: MARGIN + L.width, y: rowTop }, end: { x: MARGIN + L.width, y: L.y }, thickness: 0.5, color: LINE });
    }
    L.y -= 12;
}

function drawBack(L, doc, sections) {
    L.newPage(PAGE_BACK);
    L.text('Зворотний бік', MARGIN, 8, { color: MUTED });
    L.y -= 14;
    drawStageTable(L, doc);
    // Нижче таблиці — дві колонки: повернення, після рейсу | розрахунок, підсумки.
    const back = tsBackSections(doc, tsTotals(doc));
    const left = [sections[4], back[0], sections[5]];
    const right = [back[1]];
    const colW = (L.width - 14) / 2;
    const need = Math.max(left.reduce((n, sct) => n + sectionHeight(L, sct, colW, true), 0), right.reduce((n, sct) => n + sectionHeight(L, sct, colW, true), 0));
    L.ensure(need + 56);
    const startY = L.y;
    left.forEach((sct) => drawSection(L, sct, MARGIN, colW, { breakPages: false, compact: true }));
    const endLeft = L.y;
    L.y = startY;
    right.forEach((sct) => drawSection(L, sct, MARGIN + colW + 14, colW, { breakPages: false, compact: true }));
    L.y = Math.min(endLeft, L.y);
    L.ensure(46);
    signaturesRow(L, ['Водій (автомобіль здав, лист закрито)', 'Механік (стан автомобіля при поверненні)', 'Диспетчер (лист прийняв)']);
}

// Підписи в один рядок (зворотний бік): лінія й підпис під нею.
function signaturesRow(L, titles) {
    const colW = L.width / titles.length;
    L.y -= 22;
    titles.forEach((title, i) => {
        const x = MARGIN + i * colW;
        L.hline(x + 4, x + colW - 14, L.y);
        const lines = L.lines(title + ' — підпис', 7, colW - 24);
        const top = L.y;
        lines.forEach((line, k) => { L.y = top - 9 - k * 8.5; L.text(line, x + 4, 7, { color: MUTED }); });
        L.y = top;
    });
    L.y -= 20;
}

function drawWatermark(pages, font) {
    const text = 'АНУЛЬОВАНО';
    const size = 80;
    for (const page of pages) {
        const [pw, ph] = [page.getWidth(), page.getHeight()];
        const width = font.widthOfTextAtSize(text, size);
        const rad = (45 * Math.PI) / 180;
        page.drawText(text, {
            x: pw / 2 - (width / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad),
            y: ph / 2 - (width / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad),
            size, font, color: rgb(0.78, 0.16, 0.14), opacity: 0.22, rotate: degrees(45),
        });
    }
}

// doc — відповідь kp_trip_sheet_get; fonts — байти TTF { regular, bold }. Повертає { bytes, info }.
export async function buildTripSheetPdf(doc, { fonts } = {}) {
    if (!doc || doc.kind !== 'trip_sheet') throw new Error('buildTripSheetPdf: trip_sheet only');
    if (!fonts || !fonts.regular || !fonts.bold) throw new Error('buildTripSheetPdf: fonts required');
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const regular = await pdf.embedFont(fonts.regular, { subset: true });
    const bold = await pdf.embedFont(fonts.bold, { subset: true });
    pdf.setTitle(plain(`Подорожній лист № ${docNumberText(doc)} від ${fmtDate(doc.doc_date)}`));
    pdf.setLanguage('uk-UA');
    pdf.setCreator('Контроль+ (trip-control.com)');
    pdf.setProducer('Контроль+');
    pdf.setSubject(doc.status === 'cancelled' ? 'АНУЛЬОВАНО' : 'Подорожній лист вантажного автомобіля (типова форма № 2)');
    const pages = [];
    const L = createLayout(pdf, { regular, bold }, pages);
    const sections = tsSections(doc);
    drawFront(L, doc, sections);
    drawBack(L, doc, sections);
    pages.forEach((page, i) => {
        const label = `Подорожній лист № ${docNumberText(doc)} від ${fmtDate(doc.doc_date)} · ${i === 0 ? 'лицьовий бік' : 'зворотний бік'}`
            + (pages.length > 2 ? ` · сторінка ${i + 1} з ${pages.length}` : '');
        page.drawText(plain(label), { x: MARGIN, y: 18, size: 7, font: regular, color: MUTED });
    });
    const cancelled = doc.status === 'cancelled';
    if (cancelled) drawWatermark(pages, bold);
    const bytes = await pdf.save();
    return { bytes, info: { pages: pages.length, watermark: cancelled } };
}
