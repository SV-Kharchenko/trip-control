import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createAssetsHandler, snapshotPath } from '../lib/docs/assets.js';
import docsAssets from '../api/docs/assets.js';
import { createDocument, docAssetPaths } from '../src/lib/docs.js';
import { buildPdfForDoc } from '../src/lib/docs-pdf-client.js';

const APP = new URL('../', import.meta.url);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const ORG = '80000000-0000-0000-0000-00000000000a';
const OTHER = '80000000-0000-0000-0000-00000000000b';
const D1 = '83000000-0000-4000-8000-000000000001';
const D2 = '83000000-0000-4000-8000-000000000002';
const D3 = '83000000-0000-4000-8000-000000000003';

function mockRes() {
    const res = { statusCode: 0, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

// Справжній PNG одного кольору (колір — «вміст» підпису: старий і новий розрізняються).
function png(rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(4, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((4 * 4 + 1) * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) raw.set(rgba, y * 17 + 1 + x * 4);
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Сервер + база в памʼяті: storage — Map шлях → байти; requisites — поточні шляхи реквізитів; rpc('kp_doc_create')
// робить те саме, що SQL: шлях знімка з p_id і розширення файлу реквізитів, без скопійованого файлу — DOC_ASSETS_NOT_COPIED.
function world() {
    const storage = new Map();
    const requisites = { signature_path: null, stamp_path: null };
    const docs = new Map();
    const downloads = [];
    let nextId = [D1, D2, D3];
    const handler = createAssetsHandler({
        getUser: async (jwt) => (jwt === JWT ? { id: 'u1' } : null),
        getSource: async () => ({ org_id: ORG, ...requisites }),
        copy: async (from, to) => {
            if (!storage.has(from)) throw Object.assign(new Error('COPY_FAILED'), { notFound: true });
            if (storage.has(to)) throw new Error('exists');
            storage.set(to, storage.get(from).slice());
        },
        newId: () => nextId.shift(),
        log: { warn() {} },
    });
    const callApi = async (_app, path, body) => {
        assert.equal(path, '/api/docs/assets');
        const res = mockRes();
        await handler({ method: 'POST', headers: { authorization: 'Bearer ' + JWT }, body }, res);
        return res.statusCode === 200 ? { ok: true, ...res.body } : { ok: false, status: res.statusCode, ...res.body };
    };
    const snap = (id, kind) => {
        const src = requisites[kind + '_path'];
        return src ? `${ORG}/docs/${id}/${kind}.${src.split('.').pop()}` : null;
    };
    const app = {
        supabase: {
            rpc: async (name, params) => {
                assert.equal(name, 'kp_doc_create');
                const id = params.p_id;
                const sig = snap(id, 'signature');
                const stamp = snap(id, 'stamp');
                if ((sig && !storage.has(sig)) || (stamp && !storage.has(stamp))) return { data: null, error: { message: 'DOC_ASSETS_NOT_COPIED' } };
                docs.set(id, { id, kind: params.p_kind, seller: { legal_name: 'ТОВ «Тест»', signature_path: sig, stamp_path: stamp } });
                return { data: id, error: null };
            },
            storage: {
                from: (bucket) => ({
                    download: async (path) => {
                        assert.equal(bucket, 'kp-doc-assets');
                        downloads.push(path);
                        return storage.has(path) ? { data: new Blob([storage.get(path)]), error: null } : { data: null, error: { message: 'not found' } };
                    },
                }),
            },
        },
    };
    return { storage, requisites, docs, downloads, app, callApi, setIds: (ids) => { nextId = ids; } };
}

const pdfDoc = (doc) => ({
    ...doc, number: 1, number_text: '1', doc_date: '2026-10-14', currency: 'UAH', rate: 1, rate_date: '2026-10-14', vat_rate: 0, vat_mode: 'net',
    subtotal: 10, vat_amount: 0, total: 10, total_uah: 10, due_date: '2026-10-19', status: 'issued',
    buyer: { name: 'Зерно', legal_name: 'ТОВ «Зерно»' }, lines: [{ sort: 1, title: 'Послуга', unit: 'послуга', qty: 1, price: 10, amount: 10 }],
});

// Шрифти для pdf-lib у Node — з public/fonts (у браузері — fetch /fonts/…).
async function withFonts(fn) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const file = new URL('public' + String(url), APP);
        return { ok: true, status: 200, arrayBuffer: async () => fs.readFileSync(file) };
    };
    try {
        return await fn();
    } finally {
        globalThis.fetch = realFetch;
    }
}

test('snapshot path: <org>/docs/<doc>/<kind>.<ext of the requisites file>; another org or name refused', () => {
    assert.equal(snapshotPath(ORG, D1, 'signature', ORG + '/signature.png'), `${ORG}/docs/${D1}/signature.png`);
    assert.equal(snapshotPath(ORG, D1, 'stamp', ORG + '/stamp.jpg'), `${ORG}/docs/${D1}/stamp.jpg`);
    assert.equal(snapshotPath(ORG, D1, 'stamp', null), null);
    assert.throws(() => snapshotPath(ORG, D1, 'signature', OTHER + '/signature.png'), /BAD_SOURCE/);
    assert.throws(() => snapshotPath(ORG, D1, 'signature', ORG + '/stamp.png'), /BAD_SOURCE/);
    assert.throws(() => snapshotPath(ORG, D1, 'signature', ORG + '/docs/' + D2 + '/signature.png'), /BAD_SOURCE/);
});

test('assets endpoint: 405 / 401 / 403, copies only the current files of the requisites, no-store', async () => {
    const copies = [];
    const make = (source, extra = {}) => createAssetsHandler({
        getUser: async (jwt) => (jwt === JWT ? { id: 'u1' } : null),
        getSource: async () => {
            if (source instanceof Error) throw source;
            return source;
        },
        copy: async (from, to) => { copies.push([from, to]); },
        newId: () => D1,
        log: { warn() {} },
        ...extra,
    });
    const call = async (handler, req = {}) => {
        const res = mockRes();
        await handler({ method: 'POST', headers: { authorization: 'Bearer ' + JWT }, body: {}, ...req }, res);
        return res;
    };
    const both = make({ org_id: ORG, signature_path: ORG + '/signature.png', stamp_path: ORG + '/stamp.jpg' });
    assert.equal((await call(both, { method: 'GET' })).statusCode, 405);
    assert.equal((await call(both, { headers: {} })).statusCode, 401);
    assert.equal((await call(both, { headers: { authorization: 'Bearer nope' } })).statusCode, 401);
    assert.equal(copies.length, 0, 'nothing copied without a valid session');

    const ok = await call(both, { body: { signature_path: OTHER + '/signature.png', doc_id: D2 } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(ok.body, { doc_id: D1, signature_path: `${ORG}/docs/${D1}/signature.png`, stamp_path: `${ORG}/docs/${D1}/stamp.jpg` });
    assert.deepEqual(copies, [[ORG + '/signature.png', `${ORG}/docs/${D1}/signature.png`], [ORG + '/stamp.jpg', `${ORG}/docs/${D1}/stamp.jpg`]],
        'source and id come from the server, never from the request body');

    copies.length = 0;
    const none = await call(make({ org_id: ORG, signature_path: null, stamp_path: null }));
    assert.deepEqual(none.body, { doc_id: D1, signature_path: null, stamp_path: null });
    assert.equal(copies.length, 0, 'no signature / stamp — nothing to copy');

    assert.equal((await call(make(new Error('KP_FORBIDDEN')))).statusCode, 403, 'director / repair manager: 403');
    assert.equal((await call(make(new Error('connection reset')))).body.code, 'ASSETS_FAILED');
    assert.equal((await call(make({ org_id: ORG, signature_path: OTHER + '/signature.png', stamp_path: null }))).statusCode, 502, 'a foreign source is never copied');
    const missing = make({ org_id: ORG, signature_path: ORG + '/signature.png', stamp_path: null }, {
        copy: async () => { throw Object.assign(new Error('COPY_FAILED'), { notFound: true }); },
    });
    assert.equal((await call(missing)).statusCode, 409);
    assert.equal((await call(missing)).body.code, 'ASSET_SOURCE_MISSING');
});

test('assets endpoint (Vercel file): 405 / 401 before env, 503 without env', async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
        const res1 = mockRes();
        await docsAssets({ method: 'GET', headers: {} }, res1);
        assert.equal(res1.statusCode, 405);
        const res2 = mockRes();
        await docsAssets({ method: 'POST', headers: {} }, res2);
        assert.equal(res2.statusCode, 401);
        const res3 = mockRes();
        await docsAssets({ method: 'POST', headers: { authorization: 'Bearer ' + JWT } }, res3);
        assert.equal(res3.statusCode, 503);
    } finally {
        if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
        if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
});

test('docAssetPaths: only the own snapshot of the document, never the requisites file', () => {
    const own = { id: D1, seller: { signature_path: `${ORG}/docs/${D1}/signature.png`, stamp_path: `${ORG}/docs/${D1}/stamp.jpg` } };
    assert.deepEqual(docAssetPaths(own), { signature: own.seller.signature_path, stamp: own.seller.stamp_path });
    assert.deepEqual(docAssetPaths({ id: D1, seller: { signature_path: ORG + '/signature.png', stamp_path: ORG + '/stamp.png' } }), { signature: null, stamp: null },
        'a requisites path (older edition) is not used');
    assert.deepEqual(docAssetPaths({ id: D2, seller: own.seller }), { signature: null, stamp: null }, 'a snapshot of another document is not used');
    assert.deepEqual(docAssetPaths({ id: D1, seller: { signature_path: `${ORG}/docs/${D1}/stamp.png` } }), { signature: null, stamp: null });
    assert.deepEqual(docAssetPaths({ id: D1, seller: {} }), { signature: null, stamp: null });
    assert.deepEqual(docAssetPaths(null), { signature: null, stamp: null });
});

test('signature replaced in the requisites: the old document keeps the old signature in its PDF, a new one gets the new', async () => {
    const w = world();
    const oldSig = png([10, 20, 200, 255]);
    const newSig = png([200, 20, 10, 255]);
    w.storage.set(ORG + '/signature.png', oldSig);
    w.requisites.signature_path = ORG + '/signature.png';

    const first = await createDocument(w.app, { p_kind: 'invoice' }, w.callApi);
    assert.deepEqual(first, { id: D1 });
    const oldDoc = w.docs.get(D1);
    assert.equal(oldDoc.seller.signature_path, `${ORG}/docs/${D1}/signature.png`);
    assert.equal(oldDoc.seller.stamp_path, null);

    // Власник замінює підпис (той самий шлях, новий вміст) і додає печатку.
    w.storage.set(ORG + '/signature.png', newSig);
    w.storage.set(ORG + '/stamp.png', png([0, 0, 0, 255]));
    w.requisites.stamp_path = ORG + '/stamp.png';
    const second = await createDocument(w.app, { p_kind: 'act' }, w.callApi);
    assert.deepEqual(second, { id: D2 });
    const newDoc = w.docs.get(D2);

    assert.deepEqual(w.storage.get(oldDoc.seller.signature_path), oldSig, 'old snapshot bytes unchanged');
    assert.deepEqual(w.storage.get(newDoc.seller.signature_path), newSig, 'new document — the new signature');

    // Видалення підпису в реквізитах знімків не торкається.
    w.storage.delete(ORG + '/signature.png');
    w.requisites.signature_path = null;

    const oldPdf = await withFonts(() => buildPdfForDoc(w.app, pdfDoc(oldDoc)));
    assert.deepEqual(w.downloads, [oldDoc.seller.signature_path], 'old PDF reads only its own snapshot');
    assert.equal(oldPdf.info.signature, true);
    assert.equal(oldPdf.info.stamp, false, 'no stamp in the old document even though the company has one now');
    w.downloads.length = 0;
    const newPdf = await withFonts(() => buildPdfForDoc(w.app, pdfDoc(newDoc)));
    assert.deepEqual(w.downloads.sort(), [newDoc.seller.signature_path, newDoc.seller.stamp_path].sort());
    assert.equal(newPdf.info.signature && newPdf.info.stamp, true);
});

test('document without a signature / stamp: created without p_id copies, PDF without images', async () => {
    const w = world();
    const out = await createDocument(w.app, { p_kind: 'invoice' }, w.callApi);
    assert.deepEqual(out, { id: D1 });
    assert.deepEqual(w.docs.get(D1).seller, { legal_name: 'ТОВ «Тест»', signature_path: null, stamp_path: null });
    assert.equal(w.storage.size, 0, 'nothing copied');
    const pdf = await withFonts(() => buildPdfForDoc(w.app, pdfDoc(w.docs.get(D1))));
    assert.deepEqual(w.downloads, [], 'nothing downloaded');
    assert.equal(pdf.info.signature || pdf.info.stamp, false);
});

test('createDocument: endpoint errors shown as is; DOC_ASSETS_NOT_COPIED retried once with a fresh snapshot', async () => {
    const w = world();
    w.storage.set(ORG + '/signature.png', png([1, 2, 3, 255]));
    w.requisites.signature_path = ORG + '/signature.png';
    // Між знімком і створенням власник змінив підпис на JPEG: перша копія не підходить, друга — так.
    const rpc = w.app.supabase.rpc;
    let calls = 0;
    w.app.supabase.rpc = async (name, params) => {
        calls += 1;
        if (calls === 1) {
            w.storage.set(ORG + '/signature.jpg', png([4, 5, 6, 255]));
            w.requisites.signature_path = ORG + '/signature.jpg';
        }
        return rpc(name, params);
    };
    assert.deepEqual(await createDocument(w.app, { p_kind: 'invoice' }, w.callApi), { id: D2 });
    assert.equal(w.docs.get(D2).seller.signature_path, `${ORG}/docs/${D2}/signature.jpg`);
    assert.equal(calls, 2);

    const failing = async () => ({ ok: false, status: 409, code: 'ASSET_SOURCE_MISSING', error: 'Файл підпису чи печатки не знайдено — завантажте його знову в реквізитах.' });
    assert.deepEqual(await createDocument(w.app, { p_kind: 'invoice' }, failing), { errorText: 'Файл підпису чи печатки не знайдено — завантажте його знову в реквізитах.' });
    const forbidden = async () => ({ ok: false, status: 403, code: 'KP_FORBIDDEN', error: 'x' });
    assert.deepEqual(await createDocument(w.app, { p_kind: 'invoice' }, forbidden), { errorText: 'Недостатньо прав для цієї дії.' });
    w.app.supabase.rpc = async () => ({ data: null, error: { message: 'DOC_NUMBER_TAKEN' } });
    w.setIds([D3]);
    assert.match((await createDocument(w.app, { p_kind: 'invoice' }, w.callApi)).errorText, /з таким номером/);
});
