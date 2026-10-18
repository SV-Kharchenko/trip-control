import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createPubKeyCache, pemFromBase64, plausibleSignature, PUBKEY_REFETCH_MS, verifyMonoSignature } from '../lib/billing/mono.js';
import {
    acceptResponse, checkStatus, notificationSignature, purchaseFields, purchaseSignature,
    signaturesMatch, verifyNotification, wfpSign
} from '../lib/billing/wayforpay.js';
import { PLANS } from '../lib/billing/plans.js';
import { baseEnv, fakeNet, monoKeyPair, WFP_MERCHANT, WFP_SECRET } from './billing-fakes.mjs';

// Офіційний приклад: https://monobank.ua/api-docs/acquiring/dev/webhooks/verify (Node.js).
const DOC_PUBKEY = 'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FFQUc1LzZ3NnZubGJZb0ZmRHlYWE4vS29CbVVjTgo3NWJSUWg4MFBhaEdldnJoanFCQnI3OXNSS0JSbnpHODFUZVQ5OEFOakU1c0R3RmZ5Znhub0ZJcmZBPT0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg==';
const DOC_XSIGN = 'MEUCIQC/mVKhi8FKoayul2Mim3E2oaIOCNJk5dEXxTqbkeJSOQIgOM0hsW0qcP2H8iXy1aQYpmY0SJWEaWur7nQXlKDCFxA=';
const DOC_BODY = `{
  "invoiceId": "p2_9ZgpZVsl3",
  "status": "created",
  "failureReason": "string",
  "amount": 4200,
  "ccy": 980,
  "finalAmount": 4200,
  "createdDate": "2019-08-24T14:15:22Z",
  "modifiedDate": "2019-08-24T14:15:22Z",
  "reference": "84d0070ee4e44667b31371d8f8813947",
  "cancelList": [
    {
      "status": "processing",
      "amount": 4200,
      "ccy": 980,
      "createdDate": "2019-08-24T14:15:22Z",
      "modifiedDate": "2019-08-24T14:15:22Z",
      "approvalCode": "662476",
      "rrn": "060189181768",
      "extRef": "635ace02599849e981b2cd7a65f417fe"
    }
  ]
}`;

test('mono: official documentation vector verifies; one changed body byte does not', () => {
    const pem = pemFromBase64(DOC_PUBKEY);
    assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
    assert.equal(verifyMonoSignature(Buffer.from(DOC_BODY), DOC_XSIGN, pem), true);
    const tampered = Buffer.from(DOC_BODY);
    tampered[tampered.indexOf('4200')] = '5'.charCodeAt(0);
    assert.equal(verifyMonoSignature(tampered, DOC_XSIGN, pem), false);
    // Same JSON, different whitespace: the signature is over raw bytes.
    assert.equal(verifyMonoSignature(Buffer.from(JSON.stringify(JSON.parse(DOC_BODY))), DOC_XSIGN, pem), false);
    assert.equal(verifyMonoSignature(Buffer.from(DOC_BODY), '', pem), false);
    assert.equal(verifyMonoSignature(Buffer.from(DOC_BODY), 'not-base64-@@@', pem), false);
});

test('mono: generated prime256v1 pair; pubkey cache refetches once after rotation', async () => {
    const oldKey = monoKeyPair();
    const newKey = monoKeyPair();
    const raw = '{"invoiceId":"inv_1","status":"success"}';
    assert.equal(verifyMonoSignature(Buffer.from(raw), newKey.sign(raw), newKey.pem), true);
    assert.equal(verifyMonoSignature(Buffer.from(raw), newKey.sign(raw), oldKey.pem), false);

    const net = fakeNet({ monoKeyBase64: newKey.base64 });
    const clock = { now: Date.parse('2026-10-18T09:00:00Z') };
    const cache = createPubKeyCache(net.fetch, baseEnv({ MONO_PUBKEY: oldKey.base64 }), { now: () => clock.now });
    const fetches = () => net.calls.filter((c) => c.url.endsWith('/pubkey')).length;
    assert.equal(await cache.verify(Buffer.from(raw), newKey.sign(raw)), true, 'stale MONO_PUBKEY → refetch → ok');
    assert.equal(fetches(), 1);
    assert.equal(net.calls[0].headers['X-Token'], 'mono-test-token');
    assert.equal(await cache.verify(Buffer.from(raw), newKey.sign(raw)), true);
    assert.equal(fetches(), 1, 'cached after refetch');
    assert.equal(await cache.verify(Buffer.from(raw + ' '), newKey.sign(raw)), false);
    assert.equal(fetches(), 1, 'no second refetch within 5 minutes');
    clock.now += PUBKEY_REFETCH_MS;
    assert.equal(await cache.verify(Buffer.from(raw + ' '), newKey.sign(raw)), false);
    assert.equal(fetches(), 2, 'one refetch after 5 minutes, then false');
});

test('mono: empty or non-base64 x-sign → false without any request to mono', async () => {
    const net = fakeNet({ monoKeyBase64: monoKeyPair().base64 });
    const cache = createPubKeyCache(net.fetch, baseEnv({ MONO_PUBKEY: '' }));
    for (const bad of [undefined, '', '   ', 'not base64!', 'abc', 'A'.repeat(500), '====']) {
        assert.equal(plausibleSignature(bad), false, String(bad));
        assert.equal(await cache.verify(Buffer.from('{}'), bad), false);
    }
    assert.equal(net.calls.length, 0);
    assert.equal(plausibleSignature(DOC_XSIGN), true);
});

const md5 = (key, text) => crypto.createHmac('md5', key).update(text, 'utf8').digest('hex');

test('WayForPay purchase: field order and amount strings byte-for-byte as sent', () => {
    const env = baseEnv();
    const payment = { id: '3f2b6c1e-0000-4000-8000-000000000001', provider_order_id: 'tc-3f2b6c1e-0000-4000-8000-000000000001' };
    const fields = purchaseFields({ payment, plan: PLANS.year, ownerEmail: 'owner@agro.ua', baseUrl: 'https://trip-control.com', env, now: 1760778000000 });
    const base = [
        WFP_MERCHANT, 'trip-control.com', payment.provider_order_id, '1760778000', '2500', 'UAH',
        'Доступ до онлайн-сервісу Trip Control — тариф 1 рік', '1', '2500'
    ].join(';');
    assert.equal(fields.merchantSignature, md5(WFP_SECRET, base));
    assert.equal(purchaseSignature(fields, WFP_SECRET), fields.merchantSignature);
    assert.equal(fields.amount, '2500');
    assert.deepEqual(fields.productPrice, ['2500']);
    assert.deepEqual(fields.productCount, ['1']);
    assert.equal(fields.currency, 'UAH');
    assert.equal(fields.paymentSystems, 'card;applePay;googlePay');
    assert.equal(fields.serviceUrl, 'https://trip-control.com/api/billing/wayforpay-webhook');
    assert.equal(fields.returnUrl, 'https://trip-control.com/api/billing/return?pid=' + payment.id);
    assert.equal(fields.merchantTransactionSecureType, 'AUTO');
    assert.equal(fields.orderLifetime, '3600');
    // A different amount string gives a different signature.
    assert.notEqual(purchaseSignature(Object.assign({}, fields, { amount: '2500.00' }), WFP_SECRET), fields.merchantSignature);
});

test('WayForPay notification, accept response and CHECK_STATUS signatures', async () => {
    const env = baseEnv();
    const body = {
        merchantAccount: WFP_MERCHANT, orderReference: 'tc-order-1', amount: 250, currency: 'UAH',
        authCode: '541963', cardPan: '41****8217', transactionStatus: 'Approved', reasonCode: 1100
    };
    const expected = md5(WFP_SECRET, 'trip_control_test;tc-order-1;250;UAH;541963;41****8217;Approved;1100');
    assert.equal(notificationSignature(body, WFP_SECRET), expected);
    assert.equal(verifyNotification(Object.assign({ merchantSignature: expected }, body), env), true);
    assert.equal(verifyNotification(Object.assign({ merchantSignature: expected }, body, { amount: 2500 }), env), false);
    assert.equal(verifyNotification(Object.assign({ merchantSignature: expected }, body, { merchantAccount: 'someone_else' }), env), false);
    assert.equal(verifyNotification(Object.assign({ merchantSignature: expected.toUpperCase() }, body), env), false);
    assert.equal(signaturesMatch('', ''), false);

    const accept = acceptResponse('tc-order-1', 1760778000123, WFP_SECRET);
    assert.deepEqual(accept, {
        orderReference: 'tc-order-1', status: 'accept', time: 1760778000,
        signature: md5(WFP_SECRET, 'tc-order-1;accept;1760778000')
    });

    const net = fakeNet({ wfpCheck: Object.assign({ merchantSignature: expected }, body) });
    const checked = await checkStatus(net.fetch, env, 'tc-order-1');
    assert.equal(checked.transactionStatus, 'Approved');
    const sent = JSON.parse(net.calls[0].body);
    assert.equal(sent.transactionType, 'CHECK_STATUS');
    assert.equal(sent.merchantSignature, md5(WFP_SECRET, 'trip_control_test;tc-order-1'));
    assert.equal(sent.apiVersion, 1);

    const forged = fakeNet({ wfpCheck: Object.assign({ merchantSignature: '0'.repeat(32) }, body) });
    await assert.rejects(checkStatus(forged.fetch, env, 'tc-order-1'), (e) => e.code === 'WFP_BAD_SIGNATURE');
    assert.equal(wfpSign('k', ['a', 1, null]), md5('k', 'a;1;'));
});
