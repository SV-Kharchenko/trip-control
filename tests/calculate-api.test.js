import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

let unexpectedRequests = [];
globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({
            id: '11111111-1111-4111-8111-111111111111',
            aud: 'authenticated',
            role: 'authenticated',
            email: 'test@example.com'
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify({
            is_approved: true,
            org_id: '22222222-2222-4222-8222-222222222222',
            organizations: { status: 'active' }
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Range': '0-0/*'
            }
        });
    }

    unexpectedRequests.push({ url, method: init.method || 'GET' });
    throw new Error(`Unexpected fetch: ${url}`);
};

const { default: handler } = await import('../api/calculate.js');
const fixtureUrl = new URL('./fixtures/calc-golden.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));

function invoke(body, options = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: options.method || 'POST',
            headers: options.auth === false ? {} : { authorization: 'Bearer test-token' },
            body
        };
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ status: this.statusCode, payload });
                return this;
            }
        };

        Promise.resolve(handler(req, res)).catch(reject);
    });
}

test('calculation API returns the pre-refactor golden response', async () => {
    const result = await invoke(fixture.base);

    assert.equal(result.status, 200);
    assert.deepStrictEqual(result.payload, fixture.cases['fop-cyclic-uah'].expected);
    assert.deepStrictEqual(unexpectedRequests, []);
});

test('calculation API rejects unsupported currencies before calculating', async () => {
    const result = await invoke({ ...fixture.base, contractCurrency: 'PLN' });

    assert.equal(result.status, 400);
    assert.deepStrictEqual(result.payload, {
        code: 'BAD_CCY',
        error: 'Валюта контракту: гривня, долар або євро.'
    });
});

test('calculation API rejects an invalid exchange rate before calculating', async () => {
    const result = await invoke({ ...fixture.base, contractCurrency: 'USD', fxRate: 0 });

    assert.equal(result.status, 400);
    assert.equal(result.payload.code, 'BAD_FX');
});

test('calculation API rejects incomplete input before calculating', async () => {
    const result = await invoke({ ...fixture.base, dist: '' });

    assert.equal(result.status, 400);
    assert.equal(result.payload.code, 'MISSING_FIELDS');
    assert.deepStrictEqual(result.payload.fields, ['dist']);
});

test('calculation API still requires authentication', async () => {
    const result = await invoke(fixture.base, { auth: false });

    assert.equal(result.status, 401);
    assert.deepStrictEqual(result.payload, { error: 'Необхідна авторизація.' });
});
