// PDF документа в браузері: pdf-lib і шрифт вантажаться лише тут (динамічний import — окремий чанк, основний бандл
// не росте). Підпис і печатка — з приватного бакета Storage, лише знімок самого документа (<org>/docs/<id>/…, не файли
// реквізитів); немає знімка — PDF без них. Файл віддаємо як Blob + <a download> (без нових доменів і без змін CSP).
// Excel (.xlsx) — так само: xlsx-docs.js і fflate вантажаться лише по кнопці «Excel».
import { download } from '../ui.js';
import { ASSET_BUCKET, docAssetPaths, docFileName } from './docs.js';
import { ttnFileName } from './ttn.js';

async function assetBytes(app, path) {
    if (!path) return null;
    try {
        const { data, error } = await app.supabase.storage.from(ASSET_BUCKET).download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
    } catch {
        return null;
    }
}

export async function buildPdfForDoc(app, doc) {
    const paths = docAssetPaths(doc);
    const [mod, signature, stamp] = await Promise.all([
        import('./pdf-docs.js'),
        assetBytes(app, paths.signature),
        assetBytes(app, paths.stamp),
    ]);
    const fonts = await mod.loadFonts();
    return mod.buildDocPdf(doc, { fonts, images: { signature, stamp } });
}

export async function downloadDocPdf(app, doc) {
    const { bytes, info } = await buildPdfForDoc(app, doc);
    download(docFileName(doc), bytes, 'application/pdf');
    return info;
}

// ТТН: підпис і печатка перевізника (наша сторона) — лише знімок цієї ТТН (ті самі правила шляху, що й у 4a).
export async function buildPdfForTtn(app, doc, { copies = 1 } = {}) {
    const paths = docAssetPaths({ id: doc.id, seller: doc.carrier });
    const [mod, signature, stamp] = await Promise.all([
        import('./pdf-ttn.js'),
        assetBytes(app, paths.signature),
        assetBytes(app, paths.stamp),
    ]);
    const fonts = await mod.loadFonts();
    return mod.buildTtnPdf(doc, { fonts, images: { signature, stamp }, copies });
}

export async function downloadTtnPdf(app, doc, options) {
    const { bytes, info } = await buildPdfForTtn(app, doc, options);
    download(ttnFileName(doc), bytes, 'application/pdf');
    return info;
}

export async function downloadDocXlsx(doc) {
    const mod = await import('./xlsx-docs.js');
    download(mod.xlsxFileName(doc), mod.buildDocXlsx(doc), mod.XLSX_MIME);
}
