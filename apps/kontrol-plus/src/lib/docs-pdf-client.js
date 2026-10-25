// PDF документа в браузері: pdf-lib і шрифт вантажаться лише тут (динамічний import — окремий чанк, основний бандл
// не росте). Підпис і печатка — з приватного бакета Storage, лише знімок самого документа (<org>/docs/<id>/…, не файли
// реквізитів); немає знімка — PDF без них. Файл віддаємо як Blob + <a download> (без нових доменів і без змін CSP).
import { download } from '../ui.js';
import { ASSET_BUCKET, docAssetPaths, docFileName } from './docs.js';

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
