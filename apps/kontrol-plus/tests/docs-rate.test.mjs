import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateHandler, rateParamsProblem, nbuUrl, kyivToday } from '../lib/docs/rate.js';
import docsRate from '../api/docs/rate.js';

const NOW = new Date('2026-10-25T09:00:00Z');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';

function mockRes() {
    const res = { statusCode: 0, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

function setup({ user = { id: 'u1' }, nbu, timeoutMs = 5000 } = {}) {
    const calls = { fetch: [], logs: [] };
    const fetch = async (url, init) => {
        calls.fetch.push(url);
        return nbu(url, init);
    };
    const log = { warn: (...a) => calls.logs.push(a.join(' ')), error: (...a) => calls.logs.push(a.join(' ')) };
    const handler = createRateHandler({ getUser: async (jwt) => (jwt === JWT ? user : null), fetch, now: () => NOW, timeoutMs, log });
    const call = async (req) => {
        const res = mockRes();
        await handler({ method: 'POST', headers: { authorization: 'Bearer ' + JWT }, body: {}, ...req }, res);
        return res;
    };
    return { call, calls };
}

const okNbu = (rate = 41.4567, date = '24.10.2026') => async () => ({
    ok: true, status: 200, json: async () => [{ r030: 840, txt: 'Долар США', rate, cc: 'USD', exchangedate: date }],
});

test('rate: 405 for non-POST, 401 without or with a bad JWT, no-store on every answer', async () => {
    const { call, calls } = setup({ nbu: okNbu() });
    const get = await call({ method: 'GET' });
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal(get.headers['cache-control'], 'no-store');
    const none = await call({ headers: {} });
    assert.equal(none.statusCode, 401);
    assert.equal(none.body.code, 'AUTH_REQUIRED');
    const bad = await call({ headers: { authorization: 'Bearer nope' }, body: { currency: 'USD', date: '2026-10-24' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.body.code, 'BAD_TOKEN');
    assert.equal(bad.headers['cache-control'], 'no-store');
    assert.equal(calls.fetch.length, 0, 'no NBU request without a valid session');
});

test('rate: 400 for GBP, a future date, a bad format, before 2000, bad JSON', async () => {
    const { call, calls } = setup({ nbu: okNbu() });
    for (const body of [
        { currency: 'GBP', date: '2026-10-24' },
        { currency: 'UAH', date: '2026-10-24' },
        { currency: 'USD', date: '2026-10-26' },
        { currency: 'USD', date: '24.10.2026' },
        { currency: 'USD', date: '2026-02-30' },
        { currency: 'USD', date: '1999-12-31' },
        { currency: 'USD' },
        '{not json',
    ]) {
        const res = await call({ body });
        assert.equal(res.statusCode, 400, JSON.stringify(body));
        assert.equal(res.body.code, 'BAD_PARAMS');
        assert.equal(res.headers['cache-control'], 'no-store');
    }
    assert.equal(calls.fetch.length, 0);
    assert.equal(rateParamsProblem({ currency: 'eur', date: '2000-01-01' }, NOW), null);
    assert.equal(rateParamsProblem({ currency: 'USD', date: kyivToday(NOW) }, NOW), null, 'today (Kyiv) is fine');
});

test('rate: NBU success → rate and the rate date; currency in any case; date as YYYYMMDD in the URL', async () => {
    const { call, calls } = setup({ nbu: okNbu(41.4567, '24.10.2026') });
    const res = await call({ body: JSON.stringify({ currency: 'usd', date: '2026-10-24' }) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { currency: 'USD', rate: 41.4567, rate_date: '2026-10-24', date: '2026-10-24' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(calls.fetch, ['https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=20261024&json']);
    assert.equal(nbuUrl('EUR', '2026-01-02'), 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=EUR&date=20260102&json');
});

test('rate: NBU 500, empty answer, nonsense rate or timeout → 502; logs carry no JWT', async () => {
    for (const [name, nbu, timeoutMs] of [
        ['500', async () => ({ ok: false, status: 500, json: async () => ({}) }), 5000],
        ['empty', async () => ({ ok: true, status: 200, json: async () => [] }), 5000],
        ['zero rate', okNbu(0), 5000],
        ['not JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }), 5000],
        ['network', async () => { throw new TypeError('fetch failed'); }, 5000],
        ['timeout', (_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }), 30],
    ]) {
        const { call, calls } = setup({ nbu, timeoutMs });
        const res = await call({ body: { currency: 'EUR', date: '2026-10-24' } });
        assert.equal(res.statusCode, 502, name);
        assert.equal(res.body.code, 'NBU_UNAVAILABLE', name);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.ok(calls.logs.length >= 1, name + ': logged');
        assert.ok(calls.logs.every((l) => !l.includes(JWT) && !l.includes('eyJ')), name + ': no JWT in logs');
        if (name === 'timeout') assert.match(calls.logs[0], /NBU_TIMEOUT/);
    }
});

test('api/docs/rate.js: 405 / 401 before env; 503 without Supabase env; no-store', async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
        const get = mockRes();
        await docsRate({ method: 'GET', headers: {} }, get);
        assert.equal(get.statusCode, 405);
        const anon = mockRes();
        await docsRate({ method: 'POST', headers: {}, body: { currency: 'USD', date: '2026-10-24' } }, anon);
        assert.equal(anon.statusCode, 401);
        assert.equal(anon.headers['cache-control'], 'no-store');
        const noEnv = mockRes();
        await docsRate({ method: 'POST', headers: { authorization: 'Bearer ' + JWT }, body: {} }, noEnv);
        assert.equal(noEnv.statusCode, 503);
        assert.equal(noEnv.body.code, 'NOT_CONFIGURED');
    } finally {
        if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
        if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
});
