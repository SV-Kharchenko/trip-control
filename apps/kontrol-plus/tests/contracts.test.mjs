import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { createSignHandler, kepConfig } from '../lib/contracts/sign.js';
import { detectFileType, looksLikeP7s, mimeOfPath, stampContract, typeMatchesPath } from '../lib/contracts/stamp.js';
import { createSendHandler, parseSendBody } from '../lib/docs/send.js';
import contractsSign from '../api/contracts/sign.js';
import {
    attachmentNames, contractErrorText, contractPath, extOf, scanProblem, sigProblem, MAX_SCAN_BYTES, SIGNED_URL_SECONDS, CONTRACT_STATUS,
} from '../src/lib/contracts.js';
import { kepWidgetReady, openKepWidget } from '../src/lib/kep-widget.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const ORG = '80000000-0000-4000-8000-00000000000a';
const CID = '84000000-0000-4000-8000-000000000001';
const SCAN = ORG + '/' + CID + '/scan-11111111-1111-4111-8111-111111111111.pdf';
const SIG = ORG + '/' + CID + '/sig-22222222-2222-4222-8222-222222222222.p7s';

function mockRes() {
    const res = { statusCode: 0, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}
const run = async (handler, { method = 'POST', body, token = JWT } = {}) => {
    const res = mockRes();
    await handler({ method, headers: token ? { authorization: 'Bearer ' + token } : {}, body }, res);
    return res;
};

function png(rgba = [10, 20, 30, 255]) {
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
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(4).fill(rgba).flat())]);
    const raw = Buffer.concat(Array(4).fill(row));
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
async function onePagePdf() {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    return new Uint8Array(await pdf.save());
}
// Мінімальний DER-подібний .p7s: SEQUENCE { OID signedData … } (перевірка формату, не криптографія).
const P7S = new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, ...Array(300).fill(1)]);

test('stamp: signature and stamp are drawn on the last page of a PDF scan; an image scan becomes an A4 PDF', async () => {
    const pdfBytes = await onePagePdf();
    const out = await stampContract({ bytes: pdfBytes, mime: 'application/pdf', signature: png(), stamp: png([200, 0, 0, 255]) });
    assert.equal(Buffer.from(out).subarray(0, 5).toString(), '%PDF-');
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPageCount(), 1);
    assert.ok(out.length > pdfBytes.length, 'the images were embedded');
    const fromImage = await stampContract({ bytes: png(), mime: 'image/png', signature: png(), stamp: null });
    assert.equal((await PDFDocument.load(fromImage)).getPageCount(), 1);
    await assert.rejects(() => stampContract({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf' }), /CONTRACT_PDF_UNSUPPORTED/);
    await assert.rejects(() => stampContract({ bytes: png(), mime: 'text/plain' }), /CONTRACT_PDF_UNSUPPORTED/);
    assert.equal(mimeOfPath('a/b/scan-x.JPG'), 'image/jpeg');
    assert.equal(mimeOfPath('x.exe'), null);
});

test('.p7s: only a DER signedData structure is accepted (format check, not cryptography)', () => {
    assert.equal(looksLikeP7s(P7S), true);
    assert.equal(looksLikeP7s(new Uint8Array(500)), false);
    assert.equal(looksLikeP7s(new Uint8Array([0x30, 0x03, 1, 2, 3])), false, 'too short');
    assert.equal(looksLikeP7s(new Uint8Array(Buffer.from('%PDF-1.7 not a signature'.padEnd(200, ' ')))), false);
    assert.equal(looksLikeP7s(new Uint8Array(2 * 1024 * 1024).fill(0x30)), false, 'too big');
    assert.equal(looksLikeP7s(null), false);
});

function signSetup(over = {}) {
    const state = { saved: [], set: [], attached: [], removed: [], scans: [], loads: [] };
    const deps = {
        env: {},
        log: { warn() {} },
        getUser: async (jwt) => (jwt === JWT ? { id: 'u1' } : null),
        getSignContext: async () => ({ org_id: ORG, file_path: SCAN, signature_path: ORG + '/signature.png', stamp_path: ORG + '/stamp.png' }),
        getScanContext: async () => ({ org_id: ORG, contract_id: CID }),
        loadFile: async (path) => { state.loads.push(path); return path === SCAN ? await onePagePdf() : path === SIG ? P7S : null; },
        removeFile: async (path) => { state.removed.push(path); },
        attachScan: async (jwt, id, path, name) => { state.scans.push({ id, path, name }); },
        loadAsset: async () => png(),
        saveSigned: async (path, bytes) => { state.saved.push({ path, bytes }); },
        setSigned: async (id, userId, path) => { state.set.push({ id, userId, path }); },
        attachSig: async (jwt, id, path) => { state.attached.push({ id, path }); },
        newId: () => '33333333-3333-4333-8333-333333333333',
        ...over,
    };
    return { state, handler: createSignHandler(deps) };
}

test('sign by image: a signed PDF is stored in the private bucket and recorded by the service for the verified user', async () => {
    const { state, handler } = signSetup();
    const res = await run(handler, { body: { contract_id: CID, method: 'image' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.method, 'image');
    assert.equal(state.saved[0].path, ORG + '/' + CID + '/signed-33333333-3333-4333-8333-333333333333.pdf');
    assert.equal(Buffer.from(state.saved[0].bytes).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(state.set, [{ id: CID, userId: 'u1', path: state.saved[0].path }]);
});

test('sign: no right / foreign contract → 403 and nothing is stored; locked → 409; no scan → 409', async () => {
    for (const message of ['MEMBER_PERMISSION_DENIED', 'CONTRACT_NOT_FOUND', 'KP_FORBIDDEN', 'CONTROL_PLUS_REQUIRED']) {
        const { state, handler } = signSetup({ getSignContext: async () => { throw new Error(message); } });
        const res = await run(handler, { body: { contract_id: CID, method: 'image' } });
        assert.equal(res.statusCode, 403, message);
        assert.deepEqual([state.saved.length, state.set.length], [0, 0]);
    }
    assert.equal((await run(signSetup({ getSignContext: async () => { throw new Error('CONTRACT_LOCKED'); } }).handler, { body: { contract_id: CID, method: 'image' } })).statusCode, 409);
    assert.equal((await run(signSetup({ getSignContext: async () => { throw new Error('CONTRACT_FILE_MISSING'); } }).handler, { body: { contract_id: CID, method: 'image' } })).statusCode, 409);
    const noAssets = await run(signSetup({ loadAsset: async () => null }).handler, { body: { contract_id: CID, method: 'image' } });
    assert.equal(noAssets.statusCode, 409);
    assert.equal(noAssets.body.code, 'NO_ASSETS');
    const fake = await run(signSetup({ loadFile: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }).handler, { body: { contract_id: CID, method: 'image' } });
    assert.equal(fake.statusCode, 415, 'not a PDF by magic bytes');
    const broken = await run(signSetup({ loadFile: async () => new Uint8Array(Buffer.from('%PDF-1.4 truncated, not a document')) }).handler, { body: { contract_id: CID, method: 'image' } });
    assert.equal(broken.statusCode, 422);
});

test('sign by КЕП: the .p7s format is checked, then the user-level RPC (rights, status) attaches it', async () => {
    const { state, handler } = signSetup();
    const ok = await run(handler, { body: { contract_id: CID, method: 'kep', sig_path: SIG } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(state.attached, [{ id: CID, path: SIG }]);
    const notP7s = await run(signSetup({ loadFile: async () => await onePagePdf() }).handler, { body: { contract_id: CID, method: 'kep', sig_path: SIG } });
    assert.equal(notP7s.statusCode, 422);
    assert.equal(notP7s.body.code, 'BAD_P7S');
    const missing = await run(signSetup({ loadFile: async () => null }).handler, { body: { contract_id: CID, method: 'kep', sig_path: SIG } });
    assert.equal(missing.statusCode, 409);
    for (const sig_path of ['', 'x', ORG + '/' + CID + '/sig-1.p7s', ORG + '/84000000-0000-4000-8000-000000000002/sig-22222222-2222-4222-8222-222222222222.p7s', '../' + SIG]) {
        const bad = await run(signSetup().handler, { body: { contract_id: CID, method: 'kep', sig_path } });
        assert.equal(bad.statusCode, 400, sig_path);
    }
    const denied = signSetup({ attachSig: async () => { throw new Error('MEMBER_PERMISSION_DENIED'); } });
    assert.equal((await run(denied.handler, { body: { contract_id: CID, method: 'kep', sig_path: SIG } })).statusCode, 403, 'a logist without "sign" cannot attach a КЕП');
});

test('КЕП: the organisation in the .p7s path is compared with the user organisation BEFORE the service role reads the file', async () => {
    const OTHER = '80000000-0000-4000-8000-0000000000bb';
    const foreign = signSetup();
    const res = await run(foreign.handler, { body: { contract_id: CID, method: 'kep', sig_path: OTHER + '/' + CID + '/sig-22222222-2222-4222-8222-222222222222.p7s' } });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(foreign.state.loads, [], 'the file is never downloaded');
    assert.deepEqual(foreign.state.attached, []);
    const noRight = signSetup({ getSignContext: async () => { throw new Error('MEMBER_PERMISSION_DENIED'); } });
    assert.equal((await run(noRight.handler, { body: { contract_id: CID, method: 'kep', sig_path: SIG } })).statusCode, 403);
    assert.deepEqual(noRight.state.loads, [], 'no right → no read');
    const own = signSetup();
    assert.equal((await run(own.handler, { body: { contract_id: CID, method: 'kep', sig_path: SIG } })).statusCode, 200);
    assert.deepEqual(own.state.loads, [SIG]);
});

test('file type by magic bytes (PDF / JPG / PNG), not by extension or client MIME', async () => {
    const pdf = await onePagePdf();
    assert.equal(detectFileType(pdf), 'pdf');
    assert.equal(detectFileType(png()), 'png');
    assert.equal(detectFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])), 'jpg');
    for (const bad of [new Uint8Array(Buffer.from('<html><script>alert(1)</script></html>')), new Uint8Array(Buffer.from('MZ\x90\x00 executable')), new Uint8Array(3), null]) {
        assert.equal(detectFileType(bad), null);
    }
    assert.equal(typeMatchesPath(pdf, 'a/b/scan-1.pdf'), true);
    assert.equal(typeMatchesPath(pdf, 'a/b/scan-1.png'), false, 'a PDF named .png');
    assert.equal(typeMatchesPath(png(), 'a/b/scan-1.pdf'), false, 'a PNG named .pdf');
    assert.equal(typeMatchesPath(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]), 'x/scan-1.jpg'), true);
});

test('scan: organisation first, then magic bytes; a file of another type is deleted and never attached', async () => {
    const body = { contract_id: CID, method: 'scan', path: SCAN, name: 'Договір.pdf' };
    const ok = signSetup();
    const res = await run(ok.handler, { body });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(ok.state.scans, [{ id: CID, path: SCAN, name: 'Договір.pdf' }]);

    const html = signSetup({ loadFile: async () => new Uint8Array(Buffer.from('<html><body>not a pdf</body></html>')) });
    const bad = await run(html.handler, { body });
    assert.equal(bad.statusCode, 415);
    assert.equal(bad.body.code, 'BAD_FILE_TYPE');
    assert.deepEqual(html.state.removed, [SCAN], 'the fake file is removed from the bucket');
    assert.deepEqual(html.state.scans, []);

    const png2pdf = signSetup({ loadFile: async () => png() });
    assert.equal((await run(png2pdf.handler, { body })).statusCode, 415, 'PNG content under a .pdf name');

    const OTHER = '80000000-0000-4000-8000-0000000000bb';
    const foreign = signSetup();
    assert.equal((await run(foreign.handler, { body: { ...body, path: OTHER + '/' + CID + '/scan-11111111-1111-4111-8111-111111111111.pdf' } })).statusCode, 403);
    assert.deepEqual(foreign.state.loads, [], 'another organisation: nothing is read');

    const big = signSetup({ loadFile: async () => new Uint8Array(10 * 1024 * 1024 + 1) });
    assert.equal((await run(big.handler, { body })).statusCode, 413);

    const noRight = signSetup({ getScanContext: async () => { throw new Error('MEMBER_PERMISSION_DENIED'); } });
    assert.equal((await run(noRight.handler, { body })).statusCode, 403);
    assert.deepEqual(noRight.state.loads, []);
    assert.equal((await run(signSetup().handler, { body: { ...body, path: ORG + '/' + CID + '/scan-1.pdf' } })).statusCode, 400);
    assert.equal((await run(signSetup().handler, { body: { ...body, path: ORG + '/' + CID + '/scan-11111111-1111-4111-8111-111111111111.exe' } })).statusCode, 400);
});

test('sign API: auth, methods, validation and the КЕП widget config (env KEP_WIDGET_URL, https only)', async () => {
    const { handler } = signSetup();
    assert.equal((await run(handler, { token: null, body: {} })).statusCode, 401);
    assert.equal((await run(handler, { token: 'bad', body: {} })).statusCode, 401);
    assert.equal((await run(handler, { method: 'PUT' })).statusCode, 405);
    assert.equal((await run(handler, { body: { contract_id: 'x', method: 'image' } })).statusCode, 400);
    assert.equal((await run(handler, { body: { contract_id: CID, method: 'magic' } })).statusCode, 400);
    assert.deepEqual((await run(handler, { method: 'GET' })).body.kep, { widget_url: null, widget_origin: null, sign_url: 'https://id.gov.ua/sign' });
    assert.equal(kepConfig({ KEP_WIDGET_URL: 'https://widget.example.org/sign/v1' }).widget_origin, 'https://widget.example.org');
    assert.equal(kepConfig({ KEP_WIDGET_URL: 'http://insecure.example.org' }).widget_url, null);
    assert.equal(kepConfig({ KEP_WIDGET_URL: 'javascript:alert(1)' }).widget_url, null);
    const route = mockRes();
    await contractsSign({ method: 'POST', headers: {}, body: {} }, route);
    assert.equal(route.statusCode, 401);
    const noEnv = mockRes();
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
        await contractsSign({ method: 'GET', headers: { authorization: 'Bearer ' + JWT } }, noEnv);
        assert.equal(noEnv.statusCode, 503);
    } finally {
        if (saved.url) process.env.SUPABASE_URL = saved.url;
        if (saved.key) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
});

test('КЕП widget scaffold: no URL → no button; with a URL the protocol is NOT invented and a clear message is returned', async () => {
    assert.equal(kepWidgetReady(null), false);
    assert.equal(kepWidgetReady({ widget_url: null }), false);
    assert.equal(kepWidgetReady({ widget_url: 'https://w.example.org/x', widget_origin: 'https://w.example.org' }), true);
    await assert.rejects(() => openKepWidget(null), /не налаштовано/);
    await assert.rejects(() => openKepWidget({ widget_url: 'https://w.example.org/x', widget_origin: 'https://w.example.org' }), /ще не підключено/);
});

// ----- Надіслати контрагенту: той самий механізм, що й для актів -----
function mailSetup(over = {}) {
    const state = { logs: [], finished: [], mails: [], sent: [], recent: 0 };
    const contract = { id: CID, number: 'Д-15', file_path: SCAN, signed_path: null, sig_path: null, ...(over.contract || {}) };
    const deps = {
        env: { RESEND_API_KEY: 'k', EMAIL_FROM: 'docs@trip-control.com' },
        now: () => Date.parse('2026-10-28T12:00:00Z'),
        log: { warn() {} },
        getUser: async (jwt) => (jwt === JWT ? { id: 'u1' } : null),
        getContext: async () => { throw new Error('should not be used'); },
        getContractContext: over.getContractContext || (async () => ({ org_id: ORG, contract, reply_to: 'office@firm.ua', client_email: 'buyer@example.com', org_name: 'ТОВ «Тест»', sender_role: 'logist' })),
        loadFile: over.loadFile || (async (path) => (path ? new Uint8Array(Buffer.from(path.endsWith('.p7s') ? P7S : '%PDF-1.4 FILE:' + path)) : null)),
        loadFonts: async () => ({}),
        buildPdf: async () => { throw new Error('no document PDF for a contract'); },
        fileName: () => 'x.pdf',
        docAssetPaths: () => ({}),
        reserve: async (row, limit) => { if (state.recent + state.logs.length >= limit) throw new Error('RATE_LIMIT'); state.logs.push(row); return 'log-1'; },
        logFinish: async (id, patch) => { state.finished.push(patch); },
        sendMail: async (payload) => { state.mails.push(payload); return { id: 'em_1' }; },
        markContractSent: async (id) => { state.sent.push(id); },
    };
    return { state, handler: createSendHandler(deps) };
}
const BODY = { contract_id: CID, to: 'buyer@example.com', subject: 'Договір Д-15', text: 'Добрий день' };

test('send contract: scan (or signed copy) + .p7s as attachments, logged with contract_id, the contract becomes sent', async () => {
    assert.equal(parseSendBody(BODY).ok, true);
    assert.equal(parseSendBody({ ...BODY, doc_ids: ['83000000-0000-4000-8000-000000000001'] }).ok, false, 'a letter carries a contract or documents, not both');
    assert.equal(parseSendBody({ ...BODY, contract_id: 'nope' }).ok, false);
    const plain = mailSetup();
    const res = await run(plain.handler, { body: BODY });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(plain.state.mails[0].attachments.map((a) => a.filename), ['dogovir__-15.pdf']);
    assert.equal(plain.state.logs[0].contract_id, CID);
    assert.deepEqual(plain.state.logs[0].doc_ids, []);
    assert.deepEqual(plain.state.sent, [CID]);

    const signed = mailSetup({ contract: { signed_path: ORG + '/' + CID + '/signed-x.pdf' } });
    await run(signed.handler, { body: BODY });
    assert.equal(Buffer.from(signed.state.mails[0].attachments[0].content, 'base64').toString(), '%PDF-1.4 FILE:' + ORG + '/' + CID + '/signed-x.pdf', 'the signed copy is sent');

    const kep = mailSetup({ contract: { sig_path: SIG } });
    const fakeScan = mailSetup({ loadFile: async () => new Uint8Array(Buffer.from('<html>fake</html>')) });
    const fake = await run(fakeScan.handler, { body: BODY });
    assert.equal(fake.statusCode, 415, 'a file that is not a PDF / JPG / PNG by magic bytes is not mailed');
    assert.deepEqual([fakeScan.state.mails.length, fakeScan.state.finished[0].status], [0, 'failed']);
    await run(kep.handler, { body: BODY });
    assert.deepEqual(kep.state.mails[0].attachments.map((a) => a.filename), ['dogovir__-15.pdf', 'dogovir__-15.pdf.p7s'], 'file + detached signature');
});

test('send contract: foreign contract / no "contracts" right → 403; no file → 409; limit applies; provider failure keeps the status', async () => {
    for (const message of ['DOC_NOT_FOUND', 'MEMBER_PERMISSION_DENIED']) {
        const { state, handler } = mailSetup({ getContractContext: async () => { throw new Error(message); } });
        assert.equal((await run(handler, { body: BODY })).statusCode, 403, message);
        assert.equal(state.mails.length, 0);
    }
    assert.equal((await run(mailSetup({ getContractContext: async () => { throw new Error('CONTRACT_FILE_MISSING'); } }).handler, { body: BODY })).statusCode, 409);
    const limited = mailSetup();
    limited.state.recent = 20;
    assert.equal((await run(limited.handler, { body: BODY })).statusCode, 429);
});

// ----- Клієнтська частина -----
test('client rules: scan PDF / JPG / PNG up to 10 MB, .p7s only, paths match the storage policy, signed URLs live 10 minutes', () => {
    assert.equal(MAX_SCAN_BYTES, 10485760);
    assert.equal(SIGNED_URL_SECONDS, 600);
    assert.equal(scanProblem({ name: 'd.pdf', size: 1000 }), null);
    assert.equal(scanProblem({ name: 'd.JPG', size: 1000 }), null);
    assert.match(scanProblem({ name: 'd.exe', size: 1000 }), /PDF, JPG або PNG/);
    assert.match(scanProblem({ name: 'd.pdf', size: MAX_SCAN_BYTES + 1 }), /10 МБ/);
    assert.match(scanProblem({ name: 'd.pdf', size: 0 }), /порожній/);
    assert.equal(sigProblem({ name: 'd.pdf.p7s', size: 900 }), null);
    assert.match(sigProblem({ name: 'd.sig', size: 900 }), /\.p7s/);
    const path = contractPath(ORG, CID, 'scan', 'jpeg', '11111111-1111-4111-8111-111111111111');
    assert.equal(path, ORG + '/' + CID + '/scan-11111111-1111-4111-8111-111111111111.jpg');
    const policy = fs.readFileSync(new URL('../../../supabase/migrations/20261102090000_kp_contracts.sql', import.meta.url), 'utf8');
    assert.ok(policy.includes('scan-[0-9a-f-]{36}\\.(pdf|jpg|png)'));
    assert.equal(extOf('a.b.P7S'), 'p7s');
    assert.deepEqual(attachmentNames({ number: 'Д 15/2', file_path: 'x/scan-1.pdf', sig_path: 'x/sig-1.p7s' }), ['dogovir__15_2.pdf', 'dogovir__15_2.pdf.p7s']);
    assert.match(contractErrorText({ message: 'MEMBER_PERMISSION_DENIED' }), /Договори|Підпис/);
    assert.match(contractErrorText({ message: 'CONTRACT_LOCKED' }), /підписано/);
    assert.deepEqual(Object.keys(CONTRACT_STATUS), ['draft', 'signed', 'sent']);
});

test('contracts UI: private signed URLs only, no public URL, content-sized buttons, rights are server-side', () => {
    const view = fs.readFileSync(new URL('../src/views/contracts.js', import.meta.url), 'utf8');
    assert.match(view, /createSignedUrl\(path, SIGNED_URL_SECONDS\)/);
    assert.equal(/getPublicUrl/.test(view), false);
    assert.equal(/width:\s*100%|btn-block/.test(view), false);
    for (const word of ['Договори', 'Додати договір', 'Завантажити скан', 'Підписати печаткою', 'Підписати КЕП', 'Надіслати контрагенту', 'id.gov.ua/sign', '.p7s']) assert.ok(view.includes(word), word);
    const card = fs.readFileSync(new URL('../src/views/client-card.js', import.meta.url), 'utf8');
    assert.match(card, /renderContracts\(app, data\)/);
    const widget = fs.readFileSync(new URL('../src/lib/kep-widget.js', import.meta.url), 'utf8');
    assert.equal(/postMessage|addEventListener\('message'/.test(widget), false, 'the widget protocol is not invented');
});

test('migration: the bucket is forced private with limits on conflict, no octet-stream; file types are checked by the server', () => {
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/20261102090000_kp_contracts.sql', import.meta.url), 'utf8');
    assert.match(sql, /ON CONFLICT \(id\) DO UPDATE\s+SET public = false, file_size_limit = 10485760/);
    assert.equal(/octet-stream/.test(sql.replace(/--.*$/gm, '')), false, 'application/octet-stream is not allowed');
    assert.match(sql, /allowed_mime_types = ARRAY\['application\/pdf', 'image\/jpeg', 'image\/png', 'application\/pkcs7-signature'\]/);
    assert.match(sql, /kp_contract_scan_context/);
    assert.match(sql, /kp_mail_reserve[(]p_org uuid[^)]*p_contract_id uuid DEFAULT NULL/);
    const view = fs.readFileSync(new URL('../src/views/contracts.js', import.meta.url), 'utf8');
    assert.equal(/rpc\('kp_contract_attach'/.test(view), false, 'the browser attaches a scan through the server check');
    assert.match(view, /method: 'scan'/);
});

test('contract card layout: own kpk- classes (kpc-row is the 200px requisites grid), wrapping buttons, docs table scrolls sideways', () => {
    const view = fs.readFileSync(new URL('../src/views/contracts.js', import.meta.url), 'utf8');
    assert.equal(/class: '[^']*\bkpc-(row|head)\b/.test(view), false, 'no clash with the requisites grid classes');
    assert.match(view, /kpk-row/);
    const css = fs.readFileSync(new URL('../src/crm.css', import.meta.url), 'utf8');
    const mine = css.slice(css.indexOf('/* ===== Договори контрагента'));
    assert.equal(/grid-template-columns:\s*200px/.test(mine), false, 'no fixed 200px column');
    assert.match(mine, /\.kpk-row \.actions \{[^}]*flex-wrap: wrap/);
    assert.match(mine, /\.kpk-row \.actions > \.btn[^{]*\{[^}]*flex: 0 0 auto; width: auto/);
    assert.match(mine, /\.kpk-docs \.table-wrap \{[^}]*overflow-x: auto/);
    assert.match(mine, /\.kpk-docs \.table \{ min-width: 520px/);
    const card = fs.readFileSync(new URL('../src/views/client-card.js', import.meta.url), 'utf8');
    assert.match(card, /class: 'kpk-docs'/);
});
