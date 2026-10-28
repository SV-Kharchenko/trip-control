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

export { loadFonts };

const PAGE = [595.28, 841.89];
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
    const L = {
        get page() { return page; },
        get y() { return y; },
        set y(value) { y = value; },
        newPage() {
            page = pdf.addPage(PAGE);
            pages.push(page);
            y = PAGE[1] - MARGIN;
        },
        ensure(h) {
            if (y - h < BOTTOM) { L.newPage(); return true; }
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

function drawSection(L, section) {
    L.ensure(40);
    const top = L.y;
    L.box(MARGIN, top, WIDTH, 16, HEAD_BG);
    L.y = top - 11.5;
    L.text(section.title.toUpperCase(), MARGIN + 6, 8.5, { bold: true });
    L.y = top - 16;
    for (const [label, value] of section.rows) {
        const valueLines = L.lines(value, 9, WIDTH - LABEL_W - 14);
        const labelLines = L.lines(label, 8.5, LABEL_W - 10, true);
        const h = Math.max(valueLines.length, labelLines.length) * 11.5 + 6;
        L.ensure(h);
        const rowTop = L.y;
        labelLines.forEach((line, i) => { L.y = rowTop - 10 - i * 11.5; L.text(line, MARGIN + 6, 8.5, { bold: true }); });
        valueLines.forEach((line, i) => { L.y = rowTop - 10 - i * 11.5; L.text(line, MARGIN + LABEL_W + 6, 9); });
        L.y = rowTop - h;
        L.hline(MARGIN, MARGIN + WIDTH, L.y);
    }
    L.y -= 10;
}

function signatures(L, titles) {
    L.ensure(titles.length * 26 + 10);
    for (const title of titles) {
        L.y -= 20;
        L.text(title, MARGIN, 9);
        L.hline(MARGIN + 230, MARGIN + WIDTH - 90, L.y - 2);
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
    for (const section of sections.slice(0, 4)) drawSection(L, section);
    signatures(L, ['Водія до рейсу допущено за станом здоров’я (медогляд)', 'Автомобіль технічно справний, випуск на лінію дозволено (механік)',
        'Автомобіль прийняв водій', 'Диспетчер, що видав лист']);
}

function drawBack(L, sections) {
    L.newPage();
    L.text('Зворотний бік', MARGIN, 8, { color: MUTED });
    L.y -= 16;
    for (const section of sections.slice(4)) drawSection(L, section);
    L.ensure(120);
    const top = L.y;
    L.box(MARGIN, top, WIDTH, 16, HEAD_BG);
    L.y = top - 11.5;
    L.text('ОСОБЛИВІ ВІДМІТКИ', MARGIN + 6, 8.5, { bold: true });
    L.y = top - 16;
    for (let i = 0; i < 5; i += 1) { L.y -= 18; L.hline(MARGIN, MARGIN + WIDTH, L.y); }
    L.y -= 12;
    signatures(L, ['Водій (автомобіль здав, лист закрито)', 'Механік (стан автомобіля при поверненні)', 'Диспетчер (лист прийнято)']);
}

function drawWatermark(pages, font) {
    const text = 'АНУЛЬОВАНО';
    const size = 80;
    for (const page of pages) {
        const width = font.widthOfTextAtSize(text, size);
        const rad = (45 * Math.PI) / 180;
        page.drawText(text, {
            x: PAGE[0] / 2 - (width / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad),
            y: PAGE[1] / 2 - (width / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad),
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
    drawBack(L, sections);
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
