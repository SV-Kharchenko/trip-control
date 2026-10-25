// PDF рахунку на оплату й акта надання послуг (етап 4a). pdf-lib + @pdf-lib/fontkit, шрифт Noto Sans (OFL) з /fonts/ —
// кирилиця, апостроф, «ї/є/ґ». Модуль вантажиться лише при натисканні «PDF» (динамічний import, окремий чанк).
// Дані — лише з документа (знімки seller / buyer і суми сервера); підпис і печатка — лише нашої сторони, якщо завантажені.
// Акт містить обовʼязкові реквізити первинного документа (ч. 2 ст. 9 Закону № 996-XIV): назва, дата й місце складання,
// сторони, зміст і обсяг операції з одиницями виміру, посади й ПІБ відповідальних осіб, місця для підписів обох сторін.
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fmtDate } from './format.js';
import { DOC_TITLES, dateWords, docNumberText, fmtAmount, fmtMoneyPlain, fmtQty, sniffImage } from './docs.js';
import { contractText, partyLines, rateLine, totalWords, totalsRows } from './pdf-docs-text.js';

export { contractText, partyLines, rateLine, totalWords, totalsRows };

export const FONT_URLS = { regular: '/fonts/NotoSans-Regular.ttf', bold: '/fonts/NotoSans-Bold.ttf' };
const A4 = [595.28, 841.89];
const MARGIN = 40;
const BOTTOM = 56;
const INK = rgb(0.1, 0.12, 0.12);
const MUTED = rgb(0.38, 0.42, 0.41);
const LINE = rgb(0.55, 0.58, 0.57);
const HEAD_BG = rgb(0.93, 0.92, 0.89);

export async function loadFonts(fetchImpl = globalThis.fetch) {
    const get = async (url) => {
        const res = await fetchImpl(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error('font ' + url + ': ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
    };
    const [regular, bold] = await Promise.all([get(FONT_URLS.regular), get(FONT_URLS.bold)]);
    return { regular, bold };
}

// Пробіли Intl (вузький нерозривний) — звичайні: шрифт їх має, але так надійніше для пошуку й копіювання тексту.
function plain(text) {
    return String(text == null ? '' : text).replace(/[  ]/g, ' ');
}

// Переносить текст за шириною; довге «слово» (IBAN, URL) ріже по символах.
export function wrapText(text, font, size, width) {
    const out = [];
    for (const paragraph of plain(text).split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            const candidate = line ? line + ' ' + word : word;
            if (font.widthOfTextAtSize(candidate, size) <= width) {
                line = candidate;
                continue;
            }
            if (line) out.push(line);
            if (font.widthOfTextAtSize(word, size) <= width) {
                line = word;
                continue;
            }
            let chunk = '';
            for (const ch of word) {
                if (font.widthOfTextAtSize(chunk + ch, size) > width && chunk) {
                    out.push(chunk);
                    chunk = ch;
                } else chunk += ch;
            }
            line = chunk;
        }
        out.push(line);
    }
    return out;
}

// Верстальник: сторінки A4, позиція y, перенос на нову сторінку.
function createLayout(pdf, fonts) {
    const pages = [];
    let page = null;
    let y = 0;
    const api = {
        get page() { return page; },
        get y() { return y; },
        set y(value) { y = value; },
        pages,
        width: A4[0] - MARGIN * 2,
        newPage() {
            page = pdf.addPage(A4);
            pages.push(page);
            y = A4[1] - MARGIN;
        },
        ensure(height) {
            if (y - height < BOTTOM) {
                api.newPage();
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
        // Абзац з переносом; повертає висоту.
        paragraph(str, { x = MARGIN, width = api.width, size = 10, bold = false, color = INK, gap = 1.35 } = {}) {
            const font = bold ? fonts.bold : fonts.regular;
            const lh = size * gap;
            for (const line of wrapText(str, font, size, width)) {
                api.ensure(lh);
                y -= size;
                api.text(line, x, size, { bold, color });
                y -= lh - size;
            }
        },
        gap(h) { y -= h; },
        rule(x1 = MARGIN, x2 = MARGIN + api.width, thickness = 0.6) {
            page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: LINE });
        },
    };
    api.newPage();
    return api;
}

const COLS = [
    { key: 'n', title: '№', w: 24, align: 'center' },
    { key: 'title', title: 'Найменування', w: 0, align: 'left' },
    { key: 'unit', title: 'Од.', w: 54, align: 'center' },
    { key: 'qty', title: 'К-сть', w: 50, align: 'right' },
    { key: 'price', title: 'Ціна', w: 80, align: 'right' },
    { key: 'amount', title: 'Сума', w: 86, align: 'right' },
];

function drawTable(L, fonts, lines, currency) {
    const size = 9;
    const lh = size * 1.3;
    const pad = 4;
    const fixed = COLS.reduce((s, c) => s + c.w, 0);
    const cols = COLS.map((c) => ({ ...c, w: c.w || L.width - fixed }));
    const head = () => {
        const h = lh + pad * 2;
        L.ensure(h + lh * 2);
        let x = MARGIN;
        L.page.drawRectangle({ x: MARGIN, y: L.y - h, width: L.width, height: h, color: HEAD_BG, borderColor: LINE, borderWidth: 0.6 });
        const top = L.y;
        L.y = top - pad - size;
        for (const c of cols) {
            L.text(c.title, x + pad, size, { bold: true, align: c.align === 'left' ? 'left' : 'center', width: c.w - pad * 2 });
            x += c.w;
        }
        L.y = top - h;
    };
    head();
    lines.forEach((line, i) => {
        const cells = {
            n: String(i + 1),
            title: line.title,
            unit: line.unit || 'послуга',
            qty: fmtQty(line.qty),
            price: fmtMoneyPlain(line.price),
            amount: fmtMoneyPlain(line.amount),
        };
        const wrapped = cols.map((c) => wrapText(cells[c.key], fonts.regular, size, c.w - pad * 2));
        const rows = Math.max(...wrapped.map((w) => w.length));
        const h = rows * lh + pad * 2;
        if (L.ensure(h)) head();
        const top = L.y;
        let x = MARGIN;
        cols.forEach((c, ci) => {
            L.page.drawRectangle({ x, y: top - h, width: c.w, height: h, borderColor: LINE, borderWidth: 0.6 });
            wrapped[ci].forEach((text, li) => {
                L.y = top - pad - size - li * lh;
                L.text(text, x + pad, size, { align: c.align, width: c.w - pad * 2 });
            });
            x += c.w;
        });
        L.y = top - h;
    });
    L.gap(6);
    L.ensure(lh);
    L.y -= size;
    L.text('Валюта: ' + (currency === 'UAH' ? 'гривня' : currency), MARGIN, 8, { color: MUTED });
    L.y -= lh - size;
}

function drawTotals(L, doc) {
    const size = 10;
    const rows = totalsRows(doc);
    L.ensure(rows.length * 15 + 4);
    for (const [label, value] of rows) {
        L.y -= size + 3;
        L.text(label, MARGIN + L.width - 300, size, { bold: label.startsWith('Всього'), align: 'right', width: 190 });
        L.text(value, MARGIN + L.width - 105, size, { bold: label.startsWith('Всього'), align: 'right', width: 105 });
        L.y -= 2;
    }
    L.gap(8);
}

async function embedImage(pdf, bytes) {
    if (!bytes || !bytes.length) return null;
    const kind = sniffImage(bytes);
    if (kind === 'png') return pdf.embedPng(bytes);
    if (kind === 'jpg') return pdf.embedJpg(bytes);
    return null;
}

// Підпис над лінією підпису (x — її початок, baseline — базова лінія рядка), печатка — у точці stamp {x, y}
// (лівий нижній кут), де немає тексту.
function drawMarks(L, marks, x, baseline, stamp) {
    if (marks.signature) {
        const s = marks.signature.scaleToFit(110, 42);
        L.page.drawImage(marks.signature, { x: x + 4, y: baseline - 6, width: s.width, height: s.height });
    }
    if (marks.stamp) {
        const s = marks.stamp.scaleToFit(88, 88);
        L.page.drawImage(marks.stamp, { x: stamp.x, y: stamp.y, width: s.width, height: s.height, opacity: 0.9 });
    }
}

function signerLabel(p) {
    return [p && p.signer_position, p && p.signer_name].filter(Boolean).join(' ') || '';
}

function drawInvoice(L, fonts, doc, marks) {
    const seller = doc.seller || {};
    const buyer = doc.buyer || {};
    L.y -= 16;
    L.text(`${DOC_TITLES.invoice} № ${docNumberText(doc)}`, MARGIN, 16, { bold: true });
    L.y -= 8;
    L.paragraph('від ' + dateWords(doc.doc_date), { size: 11 });
    L.gap(10);
    const block = (label, lines) => {
        L.paragraph(label, { size: 9, bold: true, color: MUTED });
        lines.forEach((line, i) => L.paragraph(line, { size: i === 0 ? 10.5 : 9.5, bold: i === 0 }));
        L.gap(8);
    };
    block('Постачальник', partyLines(seller));
    block('Покупець', partyLines(buyer));
    const contract = contractText(buyer);
    if (contract) L.paragraph('Договір: ' + contract, { size: 9.5 });
    L.gap(8);
    drawTable(L, fonts, doc.lines || [], doc.currency);
    drawTotals(L, doc);
    L.paragraph('Всього на суму: ' + totalWords(doc), { size: 10, bold: true });
    const rate = rateLine(doc);
    if (rate) L.paragraph(rate, { size: 9.5 });
    if (doc.due_date) L.paragraph('Оплатити до: ' + fmtDate(doc.due_date), { size: 10 });
    L.paragraph('Призначення платежу: оплата за рахунком № ' + docNumberText(doc) + ' від ' + fmtDate(doc.doc_date)
        + (Number(doc.vat_rate) === 20 ? ', у т.ч. ПДВ ' + fmtAmount(doc.vat_amount, doc.currency) : ', без ПДВ'), { size: 9, color: MUTED });
    // Підписант — окремим рядком; нижче лінія підпису, печатка праворуч від неї (не на тексті).
    L.gap(20);
    L.ensure(110);
    const x = MARGIN;
    L.y -= 10;
    L.text('Виписав(ла): ' + (signerLabel(seller) || '____________________'), x, 10, { bold: true });
    L.y -= 44;
    L.page.drawLine({ start: { x, y: L.y - 2 }, end: { x: x + 170, y: L.y - 2 }, thickness: 0.6, color: LINE });
    drawMarks(L, marks, x, L.y, { x: x + 200, y: L.y - 62 });
    L.y -= 12;
    L.text('(підпис)', x + 60, 7.5, { color: MUTED });
    L.y -= 56;
}

function drawAct(L, fonts, doc, marks) {
    const seller = doc.seller || {};
    const buyer = doc.buyer || {};
    L.y -= 16;
    L.text(`${DOC_TITLES.act} № ${docNumberText(doc)}`, MARGIN, 16, { bold: true, align: 'center', width: L.width });
    L.y -= 18;
    L.text(seller.doc_place || 'м. ______________', MARGIN, 10);
    L.text(dateWords(doc.doc_date), MARGIN, 10, { align: 'right', width: L.width });
    L.y -= 8;
    L.gap(12);
    const contract = contractText(buyer);
    const sellerSigner = signerLabel(seller) || '____________________';
    const buyerSigner = signerLabel(buyer) || '____________________';
    L.paragraph(`Ми, що нижче підписалися, представник Виконавця ${seller.legal_name || '—'} ${sellerSigner}, з одного боку, `
        + `і представник Замовника ${buyer.legal_name || buyer.name || '—'} ${buyerSigner}, з іншого боку, склали цей акт про те, `
        + `що Виконавець надав, а Замовник прийняв такі послуги${contract ? ' згідно з договором ' + contract : ''}:`, { size: 10 });
    L.gap(8);
    drawTable(L, fonts, doc.lines || [], doc.currency);
    drawTotals(L, doc);
    L.paragraph('Загальна вартість наданих послуг: ' + totalWords(doc), { size: 10, bold: true });
    const rate = rateLine(doc);
    if (rate) L.paragraph(rate, { size: 9.5 });
    L.gap(4);
    L.paragraph('Послуги надано в повному обсязі, якісно і своєчасно. Сторони претензій одна до одної не мають.', { size: 10 });
    L.gap(18);

    // Підписи обох сторін: реквізити, посада й ПІБ, місце підпису.
    const colW = (L.width - 20) / 2;
    const sellerLines = partyLines(seller);
    const buyerLines = partyLines(buyer);
    const size = 9;
    const lh = size * 1.35;
    const wrapAll = (lines) => lines.flatMap((line) => wrapText(line, fonts.regular, size, colW));
    const left = wrapAll(sellerLines);
    const right = wrapAll(buyerLines);
    const blockH = (Math.max(left.length, right.length) + 2) * lh + 150;
    L.ensure(blockH);
    const top = L.y;
    const column = (x, title, lines, signer, own) => {
        L.y = top - size;
        L.text(title, x, 10, { bold: true });
        L.y -= lh + 2;
        lines.forEach((line, i) => {
            L.text(line, x, size, { bold: i === 0 });
            L.y -= lh;
        });
        L.y -= 8;
        L.text(signer.position || 'Посада: ____________', x, size);
        L.y -= 30;
        L.page.drawLine({ start: { x, y: L.y - 2 }, end: { x: x + 120, y: L.y - 2 }, thickness: 0.6, color: LINE });
        L.text('/ ' + (signer.name || '______________') + ' /', x + 126, size);
        const line = L.y;
        L.y -= lh;
        L.text('(підпис)' + (own ? '' : '        М.П.'), x + 30, 7.5, { color: MUTED });
        // Печатка нашої сторони — під лінією підпису (місце «М.П.»), не на ПІБ.
        if (own) {
            drawMarks(L, marks, x, line, { x: x + 20, y: L.y - 92 });
            L.y -= 92;
        }
        return L.y;
    };
    const yLeft = column(MARGIN, 'Від Виконавця:', left, { position: seller.signer_position, name: seller.signer_name }, true);
    const yRight = column(MARGIN + colW + 20, 'Від Замовника:', right, { position: buyer.signer_position, name: buyer.signer_name }, false);
    L.y = Math.min(yLeft, yRight) - 10;
}

// Водяний знак «АНУЛЬОВАНО» на кожній сторінці анульованого документа.
function drawWatermark(pages, font) {
    const text = 'АНУЛЬОВАНО';
    const size = 76;
    for (const page of pages) {
        const width = font.widthOfTextAtSize(text, size);
        const angle = 35;
        const rad = (angle * Math.PI) / 180;
        const cx = A4[0] / 2;
        const cy = A4[1] / 2;
        page.drawText(text, {
            x: cx - (width / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad),
            y: cy - (width / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad),
            size, font, color: rgb(0.78, 0.16, 0.14), opacity: 0.22, rotate: degrees(angle),
        });
    }
}

function drawFooters(pages, font, doc) {
    pages.forEach((page, i) => {
        const label = `${DOC_TITLES[doc.kind] || 'Документ'} № ${docNumberText(doc)} від ${fmtDate(doc.doc_date)} · сторінка ${i + 1} з ${pages.length}`;
        page.drawText(plain(label), { x: MARGIN, y: 28, size: 7.5, font, color: MUTED });
    });
}

// doc — відповідь kp_doc_get; fonts — байти TTF { regular, bold }; images — байти { signature, stamp } (необовʼязково).
// Повертає { bytes, info }: info — сторінки, водяний знак, чи вбудовано підпис / печатку (для тестів і повідомлень).
export async function buildDocPdf(doc, { fonts, images = {} } = {}) {
    if (!doc || !['invoice', 'act'].includes(doc.kind)) throw new Error('buildDocPdf: invoice or act only');
    if (!fonts || !fonts.regular || !fonts.bold) throw new Error('buildDocPdf: fonts required');
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const regular = await pdf.embedFont(fonts.regular, { subset: true });
    const bold = await pdf.embedFont(fonts.bold, { subset: true });
    const used = { regular, bold };
    const marks = {
        signature: await embedImage(pdf, images.signature),
        stamp: await embedImage(pdf, images.stamp),
    };
    const title = `${DOC_TITLES[doc.kind]} № ${docNumberText(doc)} від ${fmtDate(doc.doc_date)}`;
    pdf.setTitle(plain(title));
    pdf.setLanguage('uk-UA');
    pdf.setCreator('Контроль+ (trip-control.com)');
    pdf.setProducer('Контроль+');
    pdf.setSubject(doc.status === 'cancelled' ? 'АНУЛЬОВАНО' : DOC_TITLES[doc.kind]);
    const L = createLayout(pdf, used);
    if (doc.kind === 'invoice') drawInvoice(L, used, doc, marks);
    else drawAct(L, used, doc, marks);
    const cancelled = doc.status === 'cancelled';
    if (cancelled) drawWatermark(L.pages, bold);
    drawFooters(L.pages, regular, doc);
    const bytes = await pdf.save();
    return {
        bytes,
        info: { pages: L.pages.length, watermark: cancelled, signature: Boolean(marks.signature), stamp: Boolean(marks.stamp) },
    };
}
