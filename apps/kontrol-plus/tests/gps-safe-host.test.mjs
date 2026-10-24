import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    WIALON_HOSTING, hostingHost, isHostingHost, normalizeLocalUrl, parseApiHost, isPublicAddress,
    resolvePublic, pinnedLookup, safeRequest,
} from '../lib/gps/safe-host.js';
import { GpsError } from '../lib/gps/errors.js';

const lookupOf = (table) => async (host) => {
    if (!(host in table)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('hosting: only the four Wialon API hosts', () => {
    assert.deepEqual(Object.values(WIALON_HOSTING), ['hst-api.wialon.com', 'hst-api.wialon.us', 'hst-api.wialon.eu', 'hst-api.wialon.org']);
    assert.equal(hostingHost('eu'), 'hst-api.wialon.eu');
    for (const bad of ['local', 'ru', '__proto__', 'constructor', '', undefined]) assert.equal(hostingHost(bad), null, String(bad));
    assert.equal(isHostingHost('HST-API.WIALON.COM'), true);
    assert.equal(isHostingHost('hst-api.wialon.com.evil.io'), false);
    assert.throws(() => parseApiHost('evil.io', 'hosting'), (e) => e instanceof GpsError && e.code === 'unsafe_host');
});

test('local URL: normalized to https://host[:port]; path, query and fragment dropped', () => {
    assert.deepEqual(normalizeLocalUrl('https://GPS.Fleet-Co.com.ua/wialon/ajax.html?x=1#y'),
        { ok: true, host: 'gps.fleet-co.com.ua', port: 443, apiHost: 'gps.fleet-co.com.ua' });
    assert.deepEqual(normalizeLocalUrl('  https://gps.fleet-co.com.ua:8443/  '),
        { ok: true, host: 'gps.fleet-co.com.ua', port: 8443, apiHost: 'gps.fleet-co.com.ua:8443' });
    assert.equal(normalizeLocalUrl('https://gps.fleet-co.com.ua.:443').apiHost, 'gps.fleet-co.com.ua');
    assert.deepEqual(parseApiHost('gps.fleet-co.com.ua:8443', 'local'), { host: 'gps.fleet-co.com.ua', port: 8443 });
});

test('stored api_host must equal its normalized form exactly (no silent rewrite to another host)', () => {
    for (const [value, kind] of [
        ['evil.com/@x', 'local'], ['evil.com#', 'local'], ['evil.com?x=1', 'local'], ['evil.com/', 'local'], ['Evil.com', 'local'],
        ['gps.fleet.com:443', 'local'], ['gps.fleet.com.', 'local'], [' gps.fleet.com', 'local'], ['user@gps.fleet.com', 'local'],
        ['HST-API.WIALON.COM', 'hosting'], ['hst-api.wialon.com/', 'hosting'], ['hst-api.wialon.com:443', 'hosting'], ['', 'local'],
        [null, 'local'], [['gps.fleet.com'], 'local'], ['evil.com', 'hosting'],
    ]) {
        assert.throws(() => parseApiHost(value, kind), (e) => e instanceof GpsError && e.code === 'unsafe_host', String(value));
    }
    assert.deepEqual(parseApiHost('gps.fleet.com', 'local'), { host: 'gps.fleet.com', port: 443 });
    assert.deepEqual(parseApiHost('hst-api.wialon.org', 'hosting'), { host: 'hst-api.wialon.org', port: 443 });
});

test('local URL: SSRF vectors are refused before any DNS or network', () => {
    const cases = {
        'http://gps.fleet-co.com': 'scheme',
        'ftp://gps.fleet-co.com': 'scheme',
        'gps.fleet-co.com': 'scheme',
        'https://127.0.0.1': 'ip_literal',
        'https://[::1]': 'ip_literal',
        'https://[::ffff:127.0.0.1]': 'ip_literal',
        'https://169.254.169.254': 'ip_literal',
        'https://10.0.0.5': 'ip_literal',
        'https://2130706433': 'ip_literal',
        'https://0x7f000001': 'ip_literal',
        'https://0177.0.0.1': 'ip_literal',
        'https://127.1': 'ip_literal',
        'https://8.8.8.8': 'ip_literal',
        'https://localhost': 'single_label',
        'https://localhost.': 'single_label',
        'https://gps': 'single_label',
        'https://api.localhost': 'internal_name',
        'https://srv.local': 'internal_name',
        'https://srv.internal': 'internal_name',
        'https://srv.lan': 'internal_name',
        'https://srv.home': 'internal_name',
        'https://gps.fleet-co.com:8080': 'port',
        'https://gps.fleet-co.com:80': 'port',
        'https://gps.fleet-co.com:22': 'port',
        'https://user:pass@gps.fleet-co.com': 'credentials',
        'https://user@gps.fleet-co.com': 'credentials',
        'https://gps.fleet-co.com@169.254.169.254': 'credentials',
        'https://gps_fleet.com': 'hostname',
        'https://-gps.fleet.com': 'hostname',
        '': 'length',
    };
    for (const [input, reason] of Object.entries(cases)) {
        const out = normalizeLocalUrl(input);
        assert.equal(out.ok, false, input);
        assert.equal(out.code, 'unsafe_host', input);
        assert.equal(out.reason, reason, input);
    }
    for (const bad of [null, 123, ['https://gps.fleet-co.com'], { href: 'https://gps.fleet-co.com' }]) {
        assert.equal(normalizeLocalUrl(bad).ok, false);
    }
    assert.throws(() => parseApiHost('127.0.0.1', 'local'), /unsafe_host/);
    assert.throws(() => parseApiHost('localhost:443', 'local'), /unsafe_host/);
});

test('IP classification: private, loopback, link-local, CGNAT, multicast, reserved, mapped IPv6 are not public', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1',
        '100.127.255.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '198.18.0.1',
        '192.0.2.10', '203.0.113.5', '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
        '::ffff:8.8.8.8', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::1', '2001::1', 'not-an-ip', '']) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '193.0.14.129', '2606:4700:4700::1111', '2a00:1450:4001::200e']) {
        assert.equal(isPublicAddress(ip), true, ip);
    }
});

test('DNS: every address must be public (private, mixed public + private, empty and failures are refused)', async () => {
    const lookup = lookupOf({
        'ok.fleet.com': ['93.184.216.34'],
        'ok6.fleet.com': ['2606:4700::1'],
        'private.fleet.com': ['10.0.0.5'],
        'metadata.fleet.com': ['169.254.169.254'],
        'mixed.fleet.com': ['93.184.216.34', '192.168.0.10'],
        'mapped.fleet.com': ['::ffff:127.0.0.1'],
        'empty.fleet.com': [],
    });
    assert.deepEqual(await resolvePublic('ok.fleet.com', lookup), [{ address: '93.184.216.34', family: 4 }]);
    assert.equal((await resolvePublic('ok6.fleet.com', lookup))[0].family, 6);
    for (const [host, code] of [['private.fleet.com', 'unsafe_host'], ['metadata.fleet.com', 'unsafe_host'], ['mixed.fleet.com', 'unsafe_host'],
        ['mapped.fleet.com', 'unsafe_host'], ['empty.fleet.com', 'network'], ['missing.fleet.com', 'network']]) {
        await assert.rejects(resolvePublic(host, lookup), (e) => e instanceof GpsError && e.code === code, host);
    }
});

test('socket lookup is pinned to the checked addresses (DNS rebinding cannot swap them)', async () => {
    let n = 0;
    // Перший резолв — публічна адреса, другий (у момент зʼєднання) — приватна: зʼєднання має впасти.
    const rebinding = async () => (n++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const call = (fn, opts) => new Promise((resolve) => fn('gps.fleet.com', opts, (err, address, family) => resolve({ err, address, family })));
    const first = await call(pinnedLookup(rebinding), { all: true });
    assert.equal(first.err, null);
    assert.deepEqual(first.address, [{ address: '93.184.216.34', family: 4 }]);
    const second = await call(pinnedLookup(rebinding), {});
    assert.equal(second.err.code, 'unsafe_host');
    const single = await call(pinnedLookup(async () => [{ address: '2606:4700::1', family: 6 }]), {});
    assert.deepEqual([single.address, single.family], ['2606:4700::1', 6]);
});

// Підміна https.request: нічого не йде в мережу; можна емулювати резолв під час зʼєднання, редирект, таймаут.
function fakeRequest(behaviour) {
    const calls = [];
    const request = (options, onResponse) => {
        const req = new EventEmitter();
        calls.push({ options, req });
        req.destroyed = false;
        req.destroy = () => { req.destroyed = true; };
        req.end = (body) => {
            req.body = body;
            setImmediate(() => behaviour({ options, req, onResponse, respond: (status, text, headers = {}) => {
                const res = new EventEmitter();
                res.statusCode = status;
                res.headers = headers;
                res.resume = () => {};
                onResponse(res);
                setImmediate(() => {
                    if (text) res.emit('data', Buffer.from(text));
                    res.emit('end');
                });
            } }));
        };
        return req;
    };
    return { request, calls };
}

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];

test('safeRequest: POST to the pinned host, TLS verification untouched, body only in the request body', async () => {
    const { request, calls } = fakeRequest(({ respond }) => respond(200, '{"ok":1}'));
    const out = await safeRequest({ host: 'hst-api.wialon.com', path: '/wialon/ajax.html', body: 'svc=x&params=%7B%7D', lookup: PUBLIC, request });
    assert.deepEqual(out, { status: 200, text: '{"ok":1}' });
    const o = calls[0].options;
    assert.equal(o.method, 'POST');
    assert.equal(o.host, 'hst-api.wialon.com');
    assert.equal(o.servername, 'hst-api.wialon.com');
    assert.equal(o.path, '/wialon/ajax.html');
    assert.equal(typeof o.lookup, 'function');
    assert.equal('rejectUnauthorized' in o, false, 'certificate checks are never disabled');
    assert.equal(calls[0].req.body, 'svc=x&params=%7B%7D');
});

test('safeRequest: redirects are errors (never followed, e.g. to an internal address)', async () => {
    const { request, calls } = fakeRequest(({ respond }) => respond(302, '', { location: 'https://169.254.169.254/latest/meta-data' }));
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/wialon/ajax.html', body: '', lookup: PUBLIC, request }),
        (e) => e.code === 'network' && e.reason === 'redirect');
    assert.equal(calls.length, 1);
});

test('safeRequest: a host that resolves to a private address fails at connect time', async () => {
    const { request } = fakeRequest(({ options, req }) => {
        options.lookup('gps.fleet.com', { all: true }, (err) => { if (err) req.emit('error', err); });
    });
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/', body: '', lookup: async () => [{ address: '10.0.0.5', family: 4 }], request }),
        (e) => e.code === 'unsafe_host');
});

test('safeRequest: unsafe hosts and ports are refused before any request', async () => {
    const { request, calls } = fakeRequest(({ respond }) => respond(200, '{}'));
    for (const [host, port] of [['localhost', 443], ['127.0.0.1', 443], ['gps.fleet.com', 8080], ['srv.internal', 443], ['gps.fleet.com', 0]]) {
        await assert.rejects(safeRequest({ host, port, path: '/', body: '', lookup: PUBLIC, request }), (e) => e.code === 'unsafe_host', host + ':' + port);
    }
    assert.equal(calls.length, 0);
});

test('safeRequest: timeout, response size limit, TLS errors', async () => {
    const silent = fakeRequest(() => {});
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/', body: '', timeoutMs: 20, lookup: PUBLIC, request: silent.request }),
        (e) => e.code === 'network' && e.reason === 'timeout');
    assert.equal(silent.calls[0].req.destroyed, true);
    const big = fakeRequest(({ respond }) => respond(200, 'x'.repeat(2000)));
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/', body: '', maxBytes: 1000, lookup: PUBLIC, request: big.request }),
        (e) => e.reason === 'too_large');
    const declared = fakeRequest(({ respond }) => respond(200, 'x', { 'content-length': '999999999' }));
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/', body: '', maxBytes: 1000, lookup: PUBLIC, request: declared.request }),
        (e) => e.reason === 'too_large');
    const tls = fakeRequest(({ req }) => req.emit('error', Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })));
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/', body: '', lookup: PUBLIC, request: tls.request }), (e) => e.code === 'tls');
    const reset = fakeRequest(({ req }) => req.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
    await assert.rejects(safeRequest({ host: 'gps.fleet.com', path: '/', body: '', lookup: PUBLIC, request: reset.request }), (e) => e.code === 'network');
});
