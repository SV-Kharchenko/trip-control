import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSendHandler, createResendSender, mailConfigured, parseSendBody, HOURLY_LIMIT } from '../lib/docs/send.js';
import docsSend from '../api/docs/send.js';
import { buildDocPdf } from '../src/lib/pdf-docs.js';
import { docAssetPaths, docFileName } from '../src/lib/docs.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const ORG = '80000000-0000-4000-8000-00000000000a';
const D1 = '83000000-0000-4000-8000-000000000001';
const D2 = '83000000-0000-4000-8000-000000000002';
const FONTS = {
    regular: new Uint8Array(fs.readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
    bold: new Uint8Array(fs.readFileSync(new URL('../public/fonts/NotoSans-Bold.ttf', import.meta.url))),
};
const ENV = { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'docs@trip-control.com' };

function mockRes() {
    const res = { statusCode: 0, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

const doc = (id, extra = {}) => ({
    id, kind: 'act', number: 7, prefix: 'АКТ-', number_text: 'АКТ-7', doc_date: '2026-10-28', status: 'issued', currency: 'UAH', rate: 1,
    vat_mode: 'net', vat_rate: 0, subtotal: 1000, vat_amount: 0, total: 1000, client_id: 'c1', client_name: 'Агро',
    seller: { legal_name: 'ТОВ «Тест»', edrpou: '12345678', signer_name: 'Петренко П.', signer_position: 'Директор', doc_place: 'м. Київ' },
    buyer: { name: 'Агро', legal_name: 'ТОВ «Агро»' },
    lines: [{ sort: 1, title: 'Перевезення зерна', unit: 'посл.', qty: 1, price: 1000, amount: 1000 }],
    ...extra,
});

function setup(over = {}) {
    const state = { logs: [], finished: [], mails: [], recent: 0, contextCalls: [], lock: Promise.resolve() };
    const deps = {
        env: ENV,
        now: () => Date.parse('2026-10-28T12:00:00Z'),
        log: { warn() {} },
        getUser: async (jwt) => (jwt === JWT ? { id: 'u1' } : null),
        getContext: async (jwt, id) => {
            state.contextCalls.push(id);
            return { org_id: ORG, doc: doc(id), client_email: 'client@example.com', reply_to: 'office@firm.ua', sender_id: 'u1', sender_role: 'logist' };
        },
        loadAsset: async () => null,
        loadFonts: async () => FONTS,
        buildPdf: buildDocPdf,
        fileName: docFileName,
        docAssetPaths,
        // Як kp_doc_email_reserve: черга на замку організації, підрахунок і вставка без розриву.
        reserve: (row, limit) => {
            const run = async () => {
                await new Promise((resolve) => setImmediate(resolve));
                if (state.recent + state.logs.length >= limit) throw new Error('RATE_LIMIT');
                state.logs.push(row);
                return 'log-' + state.logs.length;
            };
            const next = state.lock.then(run, run);
            state.lock = next.catch(() => {});
            return next;
        },
        logFinish: async (id, patch) => { state.finished.push({ id, ...patch }); },
        sendMail: async (payload) => { state.mails.push(payload); return { id: 'em_1' }; },
        ...over,
    };
    return { state, handler: createSendHandler(deps) };
}
const call = async (handler, { method = 'POST', body, token = JWT } = {}) => {
    const res = mockRes();
    await handler({ method, headers: token ? { authorization: 'Bearer ' + token } : {}, body }, res);
    return res;
};
const BODY = { doc_ids: [D1], to: 'Client@Example.com', subject: 'Акт № АКТ-7', text: 'Добрий день' };

test('without RESEND_API_KEY / EMAIL_FROM: GET says not configured, POST is a clean 503 and nothing is logged or sent', async () => {
    assert.equal(mailConfigured({}), false);
    assert.equal(mailConfigured({ RESEND_API_KEY: 'x' }), false);
    assert.equal(mailConfigured(ENV), true);
    for (const env of [{}, { RESEND_API_KEY: 'k' }, { EMAIL_FROM: 'a@b.ua' }]) {
        const { state, handler } = setup({ env });
        const status = await call(handler, { method: 'GET' });
        assert.equal(status.statusCode, 200);
        assert.equal(status.body.configured, false);
        const res = await call(handler, { body: BODY });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, 'EMAIL_NOT_CONFIGURED');
        assert.match(res.body.error, /Пошта не налаштована/);
        assert.deepEqual([state.logs.length, state.mails.length, state.contextCalls.length], [0, 0, 0]);
    }
    assert.equal((await call(setup().handler, { method: 'GET' })).body.configured, true);
});

test('the real route file answers 401 without a token and 405 for other methods, before any env is read', async () => {
    const noToken = mockRes();
    await docsSend({ method: 'POST', headers: {}, body: BODY }, noToken);
    assert.equal(noToken.statusCode, 401);
    const put = mockRes();
    await docsSend({ method: 'PUT', headers: {} }, put);
    assert.equal(put.statusCode, 405);
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
        const noEnv = mockRes();
        await docsSend({ method: 'POST', headers: { authorization: 'Bearer ' + JWT }, body: BODY }, noEnv);
        assert.equal(noEnv.statusCode, 503, 'no server config → a clean 503, not a crash');
    } finally {
        if (saved.url) process.env.SUPABASE_URL = saved.url;
        if (saved.key) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
});

test('auth: no token / bad token → 401, other methods → 405', async () => {
    const { handler } = setup();
    assert.equal((await call(handler, { token: null, body: BODY })).statusCode, 401);
    assert.equal((await call(handler, { token: 'bad', body: BODY })).statusCode, 401);
    assert.equal((await call(handler, { method: 'DELETE' })).statusCode, 405);
});

test("someone else's document or no 'acts' right → 403, nothing logged or sent", async () => {
    for (const message of ['DOC_NOT_FOUND', 'MEMBER_PERMISSION_DENIED', 'KP_FORBIDDEN', 'CONTROL_PLUS_REQUIRED']) {
        const { state, handler } = setup({ getContext: async () => { throw new Error(message); } });
        const res = await call(handler, { body: BODY });
        assert.equal(res.statusCode, 403, message);
        assert.equal(res.body.code, 'FORBIDDEN');
        assert.deepEqual([state.logs.length, state.mails.length], [0, 0]);
    }
    const mixed = setup({ getContext: async (_jwt, id) => { if (id === D2) throw new Error('DOC_NOT_FOUND'); return { org_id: ORG, doc: doc(id) }; } });
    assert.equal((await call(mixed.handler, { body: { ...BODY, doc_ids: [D1, D2] } })).statusCode, 403, 'one foreign document refuses the whole letter');
    assert.equal(mixed.state.mails.length, 0);
    const cancelled = setup({ getContext: async () => { throw new Error('DOC_CANCELLED'); } });
    assert.equal((await call(cancelled.handler, { body: BODY })).statusCode, 409);
});

test('limit: 20 letters per hour per organisation → 429 with Retry-After, before any PDF or mail', async () => {
    assert.equal(HOURLY_LIMIT, 20);
    const { state, handler } = setup();
    state.recent = 19;
    assert.equal((await call(handler, { body: BODY })).statusCode, 200);
    state.recent = 20;
    const res = await call(handler, { body: BODY });
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'RATE_LIMIT');
    assert.equal(res.headers['retry-after'], '3600');
    assert.equal(state.mails.length, 1, 'the 21st letter is not sent');
});

test('parallel requests cannot pass the limit: 25 at once → exactly 20 sent, 5 get 429', async () => {
    const { state, handler } = setup();
    const results = await Promise.all(Array.from({ length: 25 }, () => call(handler, { body: BODY })));
    assert.equal(results.filter((r) => r.statusCode === 200).length, 20);
    assert.equal(results.filter((r) => r.statusCode === 429).length, 5);
    assert.equal(state.mails.length, 20);
    assert.equal(state.logs.length, 20);
});

test('one letter, one client: documents of different clients → 400 MIXED_CLIENTS, nothing reserved or sent', async () => {
    const { state, handler } = setup({ getContext: async (_j, id) => ({ org_id: ORG, doc: doc(id, { client_id: id === D2 ? 'c2' : 'c1' }), client_email: 'client@example.com', sender_role: 'logist' }) });
    const mixed = await call(handler, { body: { ...BODY, doc_ids: [D1, D2] } });
    assert.equal(mixed.statusCode, 400);
    assert.equal(mixed.body.code, 'MIXED_CLIENTS');
    assert.deepEqual([state.logs.length, state.mails.length], [0, 0]);
    const same = setup();
    assert.equal((await call(same.handler, { body: { ...BODY, doc_ids: [D1, D2] } })).statusCode, 200, 'the same client passes');
});

test('anti-spam: only the card address by default; another address needs the explicit flag and the owner role', async () => {
    const { state, handler } = setup();
    const other = { ...BODY, to: 'someone@else.com' };
    const noFlag = await call(handler, { body: other });
    assert.equal(noFlag.statusCode, 400);
    assert.equal(noFlag.body.code, 'OTHER_ADDRESS_CONFIRM');
    const logist = await call(handler, { body: { ...other, other_address: true } });
    assert.equal(logist.statusCode, 403, 'a logist cannot send to a foreign address even when confirmed');
    assert.equal(logist.body.code, 'OTHER_ADDRESS_FORBIDDEN');
    assert.deepEqual([state.logs.length, state.mails.length], [0, 0]);
    const own = setup({ getContext: async (_j, id) => ({ org_id: ORG, doc: doc(id), client_email: 'client@example.com', sender_role: 'owner' }) });
    assert.equal((await call(own.handler, { body: other })).statusCode, 400, 'the owner also needs the confirmation');
    const ok = await call(own.handler, { body: { ...other, other_address: true } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(own.state.mails[0].to, ['someone@else.com']);
    const noCard = setup({ getContext: async (_j, id) => ({ org_id: ORG, doc: doc(id), client_email: null, sender_role: 'logist' }) });
    assert.equal((await call(noCard.handler, { body: { ...BODY, other_address: true } })).statusCode, 403, 'no card address: a logist cannot choose one');
    assert.equal((await call(handler, { body: BODY })).statusCode, 200, 'the card address (any case) goes through without a flag');
});

test('the server adds an unremovable footer and escapes user HTML', async () => {
    const { state, handler } = setup({ getContext: async (_j, id) => ({ org_id: ORG, doc: doc(id), client_email: 'client@example.com', org_name: 'ТОВ «Тест» <b>', sender_role: 'logist' }) });
    const res = await call(handler, { body: { ...BODY, text: 'Привіт <script>alert(1)</script> & "інше"' } });
    assert.equal(res.statusCode, 200);
    const mail = state.mails[0];
    assert.match(mail.text, /Надіслано через TripControl від ТОВ «Тест» <b>$/);
    assert.match(mail.html, /Надіслано через TripControl від ТОВ «Тест» &lt;b&gt;/);
    assert.ok(!/<script/i.test(mail.html), 'user HTML is escaped');
    assert.match(mail.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;інше&quot;/);
    const empty = await call(handler, { body: { ...BODY, text: '' } });
    assert.equal(empty.statusCode, 200);
    assert.match(state.mails[1].text, /Надіслано через TripControl від/);
    const forged = await call(handler, { body: { ...BODY, text: 'x', footer: 'прибрати', html: '<i>x</i>' } });
    assert.match(state.mails[2].html, /Надіслано через TripControl/);
    assert.equal(forged.statusCode, 200);
});

test('success: PDF attachment from the same template, From / Reply-To from env and requisites, queued → sent in the log', async () => {
    const { state, handler } = setup();
    const res = await call(handler, { body: { ...BODY, doc_ids: [D1, D2] } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.attachments, 2);
    const mail = state.mails[0];
    assert.equal(mail.from, 'docs@trip-control.com');
    assert.deepEqual(mail.to, ['client@example.com']);
    assert.equal(mail.reply_to, 'office@firm.ua');
    assert.equal(mail.subject, 'Акт № АКТ-7');
    assert.equal(mail.attachments.length, 2);
    for (const a of mail.attachments) {
        assert.match(a.filename, /^akt_7_2026-10-28\.pdf$/);
        assert.equal(Buffer.from(a.content, 'base64').subarray(0, 5).toString(), '%PDF-');
    }
    assert.equal(state.logs.length, 1);
    assert.deepEqual([state.logs[0].subject && 'reserved', state.logs[0].doc_ids, state.logs[0].sent_by, state.logs[0].to_email], ['reserved', [D1, D2], 'u1', 'client@example.com']);
    assert.equal(state.finished[0].status, 'sent');
    assert.equal(state.finished[0].provider_id, 'em_1');
    assert.ok(state.finished[0].finished_at);
});

test('the signature and stamp already in the document go into the PDF; missing files give a PDF without them', async () => {
    const asked = [];
    const withAssets = doc(D1, { seller: { legal_name: 'ТОВ', signature_path: ORG + '/docs/' + D1 + '/signature.png', stamp_path: ORG + '/docs/' + D1 + '/stamp.png' } });
    const { handler, state } = setup({
        getContext: async () => ({ org_id: ORG, doc: withAssets, reply_to: null, client_email: 'client@example.com' }),
        loadAsset: async (path) => { asked.push(path); return null; },
    });
    assert.equal((await call(handler, { body: BODY })).statusCode, 200);
    assert.deepEqual(asked.sort(), [ORG + '/docs/' + D1 + '/signature.png', ORG + '/docs/' + D1 + '/stamp.png'], 'only the snapshot of this very document');
    assert.equal('reply_to' in state.mails[0], false, 'no Reply-To when the organisation has no email');
});

test('provider failure: 502, log row failed with the reason, no key in the response', async () => {
    const { state, handler } = setup({ sendMail: async () => { throw new Error('Resend 422: domain not verified'); } });
    const res = await call(handler, { body: BODY });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'SEND_FAILED');
    assert.match(res.body.error, /domain not verified/);
    assert.equal(JSON.stringify(res.body).includes('re_test_key'), false);
    assert.equal(state.finished[0].status, 'failed');
    assert.match(state.finished[0].error, /domain not verified/);
});

test('PDF failure: 500, logged as failed, nothing sent', async () => {
    const { state, handler } = setup({ buildPdf: async () => { throw new Error('boom'); } });
    const res = await call(handler, { body: BODY });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'PDF_FAILED');
    assert.equal(state.mails.length, 0);
    assert.equal(state.finished[0].status, 'failed');
});

test('request validation: ids, recipient, subject; header injection is flattened; letters never carry other recipients', async () => {
    const { state, handler } = setup();
    for (const body of [{}, { ...BODY, doc_ids: [] }, { ...BODY, doc_ids: ['x'] }, { ...BODY, doc_ids: [D1, D1] },
        { ...BODY, doc_ids: Array(6).fill(0).map((_, i) => '83000000-0000-4000-8000-00000000000' + i) },
        { ...BODY, to: 'not-an-email' }, { ...BODY, to: 'a@b.ua, c@d.ua' }, { ...BODY, to: 'a@b.ua;c@d.ua' }, { ...BODY, subject: '   ' }]) {
        assert.equal((await call(handler, { body })).statusCode, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(state.contextCalls.length, 0);
    const res = await call(handler, { body: { ...BODY, subject: 'Тема\r\nBcc: spy@evil.com' } });
    assert.equal(res.statusCode, 200);
    assert.equal(/[\r\n]/.test(state.mails[0].subject), false);
    assert.deepEqual(state.mails[0].to, ['client@example.com']);
    assert.equal(parseSendBody({ ...BODY, text: 'x'.repeat(9000) }).value.text.length, 5000);
});

test('Resend sender: plain fetch with Bearer key, no SDK; an error carries the provider message, never the key', async () => {
    let seen = null;
    const ok = createResendSender('re_secret', async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ id: 'em_9' }) }; });
    assert.deepEqual(await ok({ to: ['a@b.ua'] }), { id: 'em_9' });
    assert.equal(seen.url, 'https://api.resend.com/emails');
    assert.equal(seen.init.headers.Authorization, 'Bearer re_secret');
    const bad = createResendSender('re_secret', async () => ({ ok: false, status: 403, json: async () => ({ message: 'Invalid API key' }) }));
    await assert.rejects(() => bad({}), (e) => /403/.test(e.message) && /Invalid API key/.test(e.message) && !e.message.includes('re_secret'));
    const sources = ['lib/docs/send.js', 'api/docs/send.js'].map((f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
    assert.equal(/from ['"]resend['"]/.test(sources), false, 'no Resend SDK');
    assert.equal(/re_[A-Za-z0-9]{10,}/.test(sources), false, 'no hard-coded key');
    assert.match(sources, /process\.env\.RESEND_API_KEY/);
});

test('the browser side: form with To / Subject / Text / PDF ticks, status check, content-sized buttons, log in the card', () => {
    const view = fs.readFileSync(new URL('../src/views/doc-email.js', import.meta.url), 'utf8');
    for (const word of ['Кому', 'Тема', 'Текст', 'PDF', 'Надіслати на пошту', 'Пошта не налаштована']) assert.ok(view.includes(word), word);
    assert.equal(/width:\s*100%|btn-block/.test(view), false);
    assert.match(view, /callKpApi\(app, '\/api\/docs\/send', null, 'GET'\)/);
    const card = fs.readFileSync(new URL('../src/views/docs-card.js', import.meta.url), 'utf8');
    assert.match(card, /emailControl\(app/);
    assert.match(card, /renderEmailLog\(app, doc\.id\)/);
    const client = fs.readFileSync(new URL('../src/views/client-card.js', import.meta.url), 'utf8');
    assert.match(client, /emailControl\(app/);
    const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.equal(vercel.functions['api/docs/send.js'].includeFiles, 'public/fonts/**', 'fonts ship with the function');
});
