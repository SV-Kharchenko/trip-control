import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PDFDocument, PDFDict, PDFName, PDFNumber } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildDocPdf, wrapText, FONT_URLS, loadFonts } from '../src/lib/pdf-docs.js';
import { DOC_TITLES } from '../src/lib/docs.js';

const APP = new URL('../', import.meta.url);
const fonts = {
    regular: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Regular.ttf', APP))),
    bold: new Uint8Array(fs.readFileSync(new URL('public/fonts/NotoSans-Bold.ttf', APP))),
};

// Справжній PNG (RGBA) без залежностей: IHDR + IDAT (zlib) + IEND з CRC32.
function png(width, height, rgba = [20, 40, 160, 255]) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(rgba, y * (width * 4 + 1) + 1 + x * 4);
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const seller = {
    legal_name: 'ТОВ «Тест Перевезення»', legal_form: 'tov', edrpou: '12345678', iban: 'UA213223130000026007233566001', bank_name: 'АТ «Тест Банк»',
    legal_address: 'м. Київ, вул. Тестова, 1', vat_payer: true, vat_number: '123456789012', signer_name: 'Петренко Петро', signer_position: 'Директор',
    doc_place: 'м. Київ', signature_path: null, stamp_path: null,
};
const buyer = {
    name: 'Зерно', legal_name: 'ТОВ «Зерно-Трейд» — пʼять ґудзиків, їжак і єнот', edrpou: '23456789', legal_address: 'м. Одеса, вул. Портова, 7',
    signer_name: 'Іваненко Іван', signer_position: 'Директор', contract_no: 'Д-15/2026', contract_date: '2026-01-15', vat_payer: false,
};
const line = (i) => ({ sort: i + 1, title: 'Послуги з перевезення вантажу за маршрутом Київ — Одеса, 01.10.2026' + (i % 9 === 0 ? ' (довга назва: пʼять ґудзиків, їжак, єнот і ще кілька слів для переносу рядка в таблиці)' : ''),
    unit: 'послуга', qty: 1, price: 1000, amount: 1000 });
const doc = (extra = {}) => ({
    id: 'd1', kind: 'invoice', number: 12, number_text: 'РФ-12', doc_date: '2026-10-12', seller, buyer, currency: 'UAH', rate: 1, rate_date: '2026-10-12',
    vat_rate: 20, vat_mode: 'net', subtotal: 1000, vat_amount: 200, total: 1200, total_uah: 1200, due_date: '2026-10-22', status: 'issued',
    lines: [line(0)], ...extra,
});

// Прозорість (ca) зі станів ExtGState сторінки — так pdf-lib малює opacity (водяний знак, печатка).
function pageOpacities(page) {
    const res = page.node.Resources();
    const ext = res && res.lookup(PDFName.of('ExtGState'), PDFDict);
    if (!ext) return [];
    return ext.keys().map((key) => ext.lookup(key, PDFDict).get(PDFName.of('ca'))).filter((n) => n instanceof PDFNumber).map((n) => n.asNumber());
}

async function parse(bytes) {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const fontFiles = [];
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of('FontFile2'))) fontFiles.push(obj);
    }
    return { pdf, fontFiles, gstates: pdf.getPages().flatMap(pageOpacities) };
}

test('the font covers every character of the templates and of Ukrainian data (ʼ, ї, є, ґ, №, «», —)', () => {
    const regular = fontkit.create(Buffer.from(fonts.regular));
    const bold = fontkit.create(Buffer.from(fonts.bold));
    const text = 'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюяʼ\'’«»—–№%.,:;()/-+0123456789 '
        + Object.values(DOC_TITLES).join('') + 'Сторони претензій одна до одної не мають. Курс НБУ. Без ПДВ. АНУЛЬОВАНО';
    for (const ch of new Set(text)) {
        assert.ok(regular.hasGlyphForCodePoint(ch.codePointAt(0)), 'regular: ' + ch);
        assert.ok(bold.hasGlyphForCodePoint(ch.codePointAt(0)), 'bold: ' + ch);
    }
    assert.deepEqual(FONT_URLS, { regular: '/fonts/NotoSans-Regular.ttf', bold: '/fonts/NotoSans-Bold.ttf' });
});

test('PDF invoice with one line: Cyrillic, apostrophe, ї / є / ґ; parses back with pages and an embedded font', async () => {
    const { bytes, info } = await buildDocPdf(doc(), { fonts });
    assert.ok(bytes.length > 5000);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 5)), '%PDF-');
    assert.deepEqual(info, { pages: 1, watermark: false, signature: false, stamp: false });
    const { pdf, fontFiles, gstates } = await parse(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.equal(fontFiles.length, 2, 'both Noto Sans faces embedded (subset)');
    assert.equal(pdf.getTitle(), 'Рахунок на оплату № РФ-12 від 12.10.2026');
    assert.equal(pdf.getSubject(), 'Рахунок на оплату');
    assert.ok(!gstates.some((ca) => ca < 0.5), 'no watermark transparency');
});

test('PDF with 120 lines: several pages, table header repeated, totals at the end', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => line(i));
    const { bytes, info } = await buildDocPdf(doc({ lines, subtotal: 120000, vat_amount: 24000, total: 144000, total_uah: 144000 }), { fonts });
    assert.ok(info.pages >= 4, 'pages: ' + info.pages);
    const { pdf } = await parse(bytes);
    assert.equal(pdf.getPageCount(), info.pages);
});

test('PDF act: both parties and signature places; our signature and stamp only when uploaded', async () => {
    const act = doc({ kind: 'act', number: 5, number_text: 'АКТ-5', due_date: null, lines: [line(0), line(1), line(2)], subtotal: 3000, vat_amount: 600, total: 3600, total_uah: 3600 });
    const without = await buildDocPdf(act, { fonts });
    assert.deepEqual(without.info, { pages: 1, watermark: false, signature: false, stamp: false });
    const signed = await buildDocPdf(act, { fonts, images: { signature: png(60, 20), stamp: png(40, 40, [200, 30, 30, 180]) } });
    assert.deepEqual(signed.info, { pages: 1, watermark: false, signature: true, stamp: true });
    assert.ok(signed.bytes.length > without.bytes.length, 'images embedded');
    const { pdf } = await parse(signed.bytes);
    const images = [...pdf.context.enumerateIndirectObjects()].filter(([, o]) => o && o.dict && o.dict.get && String(o.dict.get(PDFName.of('Subtype'))) === '/Image');
    assert.ok(images.length >= 2, 'signature and stamp XObjects');
    const broken = await buildDocPdf(act, { fonts, images: { signature: new Uint8Array([1, 2, 3]), stamp: null } });
    assert.equal(broken.info.signature, false, 'not a PNG / JPEG — skipped, PDF still built');
});

test('cancelled document: the «АНУЛЬОВАНО» watermark on every page', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(i));
    const { bytes, info } = await buildDocPdf(doc({ status: 'cancelled', lines }), { fonts });
    assert.equal(info.watermark, true);
    assert.ok(info.pages >= 2);
    const { pdf, gstates } = await parse(bytes);
    assert.equal(pdf.getSubject(), 'АНУЛЬОВАНО');
    for (const page of pdf.getPages()) {
        assert.ok(pageOpacities(page).some((ca) => Math.abs(ca - 0.22) < 1e-6), 'every page carries the watermark (opacity 0.22)');
    }
    assert.ok(gstates.length >= info.pages);
});

test('currency invoice: amount in USD and the NBU line; long words wrap', async () => {
    const usd = doc({ currency: 'USD', rate: 41.123456, rate_date: '2026-10-05', total_uah: 49348.15 });
    const { info } = await buildDocPdf(usd, { fonts });
    assert.equal(info.pages, 1);
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(fonts.regular, { subset: true });
    const wrapped = wrapText('IBAN UA213223130000026007233566001UA213223130000026007233566001 і пʼять слів', font, 9, 120);
    assert.ok(wrapped.length >= 3);
    assert.ok(wrapped.every((l) => font.widthOfTextAtSize(l, 9) <= 120 + 0.01));
    await assert.rejects(buildDocPdf({ ...usd, kind: 'ttn' }, { fonts }), /invoice or act/);
    await assert.rejects(buildDocPdf(usd, {}), /fonts required/);
});

test('loadFonts fetches both faces from /fonts/ (same origin, CSP font-src / connect-src self)', async () => {
    const asked = [];
    const fake = async (url) => { asked.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
    const out = await loadFonts(fake);
    assert.deepEqual(asked.sort(), ['/fonts/NotoSans-Bold.ttf', '/fonts/NotoSans-Regular.ttf']);
    assert.equal(out.regular.length, 8);
    await assert.rejects(loadFonts(async () => ({ ok: false, status: 404 })), /404/);
});
