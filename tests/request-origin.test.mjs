import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_ORIGINS, requestOrigin } from '../lib/request-origin.js';

test('allowlist is exactly the three production origins', () => {
    assert.deepEqual([...ALLOWED_ORIGINS], ['https://trip-control.com', 'https://www.trip-control.com', 'https://app.trip-control.com']);
});

test('requestOrigin accepts allowlisted Origin / x-forwarded-host / Host, everything else falls back', () => {
    const fb = 'https://trip-control.com';
    assert.equal(requestOrigin({ headers: { origin: 'https://app.trip-control.com' } }, fb), 'https://app.trip-control.com');
    assert.equal(requestOrigin({ headers: { 'x-forwarded-host': 'app.trip-control.com, other' } }, fb), 'https://app.trip-control.com');
    assert.equal(requestOrigin({ headers: { host: 'www.trip-control.com' } }, fb), 'https://www.trip-control.com');
    assert.equal(requestOrigin({ headers: { origin: 'http://app.trip-control.com' } }, fb), fb);
    assert.equal(requestOrigin({ headers: { host: 'evil.com' } }, fb), fb);
    assert.equal(requestOrigin({ headers: { host: 'app.trip-control.com.evil.com' } }, fb), fb);
    assert.equal(requestOrigin({ headers: { origin: 'null', host: 'localhost:3000' } }, fb), fb);
    assert.equal(requestOrigin({ headers: { origin: 'https://evil.com', host: 'app.trip-control.com' } }, 'https://www.trip-control.com/'), 'https://www.trip-control.com');
    assert.equal(requestOrigin({}, ''), 'https://trip-control.com');
    assert.equal(requestOrigin(null, fb), fb);
});
