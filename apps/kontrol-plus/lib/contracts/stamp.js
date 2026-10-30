// Підписана копія договору: до скану (PDF або JPEG / PNG) додаються зображення підпису й печатки з реквізитів — так само, як
// в актах (pdf-lib, лише на сервері). PDF: підпис і печатка на останній сторінці внизу праворуч; зображення: нова сторінка A4
// зі сканом договору. Зашифрований або пошкоджений PDF → помилка CONTRACT_PDF_UNSUPPORTED (файл не змінюється).
import { PDFDocument } from 'pdf-lib';

const A4 = [595.28, 841.89];

function isPng(bytes) {
    return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function embed(pdf, bytes) {
    if (!bytes || !bytes.length) return null;
    try {
        return isPng(bytes) ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    } catch {
        return null;
    }
}

export function mimeOfPath(path) {
    const ext = String(path || '').toLowerCase().split('.').pop();
    return ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : null;
}

// Справжній тип файлу за першими байтами (а не за розширенням чи MIME від клієнта): 'pdf' | 'jpg' | 'png' | null.
export function detectFileType(bytes) {
    if (!bytes || bytes.length < 8) return null;
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'pdf';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    return null;
}

// Тип за magic bytes збігається з розширенням у шляху.
export function typeMatchesPath(bytes, path) {
    const real = detectFileType(bytes);
    const ext = String(path || '').toLowerCase().split('.').pop();
    return real !== null && (real === ext || (real === 'jpg' && ext === 'jpeg'));
}

export async function stampContract({ bytes, mime, signature, stamp }) {
    let pdf;
    try {
        if (mime === 'application/pdf') {
            pdf = await PDFDocument.load(bytes);
        } else if (mime === 'image/png' || mime === 'image/jpeg') {
            pdf = await PDFDocument.create();
            const image = mime === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
            const page = pdf.addPage(A4);
            const scale = Math.min((A4[0] - 40) / image.width, (A4[1] - 40) / image.height, 1);
            const w = image.width * scale;
            const h = image.height * scale;
            page.drawImage(image, { x: (A4[0] - w) / 2, y: A4[1] - 20 - h, width: w, height: h });
        } else {
            throw new Error('mime');
        }
    } catch {
        throw Object.assign(new Error('CONTRACT_PDF_UNSUPPORTED'), { code: 'CONTRACT_PDF_UNSUPPORTED' });
    }
    let pages;
    try {
        pages = pdf.getPages();
    } catch {
        pages = [];
    }
    if (!pages.length) throw Object.assign(new Error('CONTRACT_PDF_UNSUPPORTED'), { code: 'CONTRACT_PDF_UNSUPPORTED' });
    const page = pages[pages.length - 1];
    const { width } = page.getSize();
    const sig = await embed(pdf, signature);
    const seal = await embed(pdf, stamp);
    const fit = (img, maxW, maxH) => { const k = Math.min(maxW / img.width, maxH / img.height); return { w: img.width * k, h: img.height * k }; };
    if (sig) {
        const { w, h } = fit(sig, 150, 60);
        page.drawImage(sig, { x: width - 80 - w, y: 80, width: w, height: h });
    }
    if (seal) {
        const { w, h } = fit(seal, 110, 110);
        page.drawImage(seal, { x: width - 40 - w, y: 50, width: w, height: h, opacity: 0.9 });
    }
    return pdf.save();
}

// Відокремлений підпис CAdES / CMS (.p7s): DER SEQUENCE, перший елемент якої — OID signedData (1.2.840.113549.1.7.2).
// Це перевірка ФОРМАТУ, а не криптографічна перевірка підпису (її робить id.gov.ua / ЦСК).
const SIGNED_DATA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

export function looksLikeP7s(bytes) {
    if (!bytes || bytes.length < 100 || bytes.length > 1048576 || bytes[0] !== 0x30) return false;
    let i = 1;
    if (bytes[i] & 0x80) i += 1 + (bytes[i] & 0x7f);
    else i += 1;
    return SIGNED_DATA_OID.every((b, k) => bytes[i + k] === b);
}
