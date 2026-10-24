// Безпечні запити до серверів GPS-провайдерів (захист від SSRF).
//
// * Wialon Hosting — лише адреси API з allowlist (регіон → хост).
// * Wialon Local — адресу вводить клієнт: лише https, порти 443 / 8443, лише доменне імʼя (без IP-літералів, localhost,
//   внутрішніх зон і одно-лейблових імен). Шлях, query й облікові дані з адреси відкидаються.
// * Перед кожним запитом DNS-резолв; відмова, якщо ХОЧ ОДНА адреса приватна / loopback / link-local / CGNAT /
//   multicast / зарезервована. Зʼєднання йде саме на перевірені адреси (власний lookup у сокеті), тож DNS-rebinding
//   між перевіркою і зʼєднанням нічого не дає.
// * Без редиректів (3xx — помилка), таймаут, ліміт розміру відповіді, перевірку TLS-сертифіката не вимикаємо.
import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import { GpsError } from './errors.js';

export const WIALON_HOSTING = {
    com: 'hst-api.wialon.com',
    us: 'hst-api.wialon.us',
    eu: 'hst-api.wialon.eu',
    org: 'hst-api.wialon.org',
};
const HOSTING_HOSTS = new Set(Object.values(WIALON_HOSTING));
export const LOCAL_PORTS = new Set([443, 8443]);
const INTERNAL_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.localhost', '.localdomain', '.arpa', '.intranet',
    '.corp', '.private', '.test', '.invalid', '.example'];

export function hostingHost(region) {
    return Object.prototype.hasOwnProperty.call(WIALON_HOSTING, region) ? WIALON_HOSTING[region] : null;
}

export function isHostingHost(host) {
    return HOSTING_HOSTS.has(String(host || '').toLowerCase());
}

function unsafe(reason) {
    return { ok: false, code: 'unsafe_host', reason };
}

function checkHostname(host) {
    if (!host || host.length > 253) return 'hostname';
    if (host.startsWith('[') || net.isIP(host)) return 'ip_literal';
    if (!/^[a-z0-9.-]+$/.test(host)) return 'hostname';
    const labels = host.split('.');
    if (labels.length < 2) return 'single_label';
    if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return 'hostname';
    // Останній лейбл з цифр — це не домен (WHATWG URL такі адреси й так перетворює на IPv4).
    if (/^[0-9]+$/.test(labels[labels.length - 1])) return 'ip_literal';
    if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return 'internal_name';
    return null;
}

// Адреса Wialon Local від клієнта → { ok, host, port, apiHost: 'host' | 'host:8443' }.
export function normalizeLocalUrl(input) {
    if (typeof input !== 'string') return unsafe('type');
    const raw = input.trim();
    if (!raw || raw.length > 300) return unsafe('length');
    if (!/^https:\/\//i.test(raw)) return unsafe('scheme');
    let url;
    try {
        url = new URL(raw);
    } catch {
        return unsafe('parse');
    }
    if (url.protocol !== 'https:') return unsafe('scheme');
    if (url.username || url.password || /^https:\/\/[^/?#]*@/i.test(raw)) return unsafe('credentials');
    const port = url.port ? Number(url.port) : 443;
    if (!LOCAL_PORTS.has(port)) return unsafe('port');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const bad = checkHostname(host);
    if (bad) return unsafe(bad);
    return { ok: true, host, port, apiHost: port === 443 ? host : host + ':' + port };
}

// Збережене api_host ('host' або 'host:port') → { host, port }; перевіряється заново на кожен запит.
// Значення має рівно збігатися з нормалізованим: 'evil.com/@x', 'evil.com#', 'Evil.com', 'host:443' — відмова,
// а не мовчазне перетворення на інший хост.
export function parseApiHost(apiHost, hostKind) {
    if (typeof apiHost !== 'string' || !apiHost) throw new GpsError('unsafe_host', 'empty');
    if (hostKind === 'hosting' || (!hostKind && HOSTING_HOSTS.has(apiHost))) {
        if (!HOSTING_HOSTS.has(apiHost)) throw new GpsError('unsafe_host', 'not_allowlisted');
        return { host: apiHost, port: 443 };
    }
    const checked = normalizeLocalUrl('https://' + apiHost);
    if (!checked.ok) throw new GpsError('unsafe_host', checked.reason);
    if (checked.apiHost !== apiHost) throw new GpsError('unsafe_host', 'not_normalized');
    return { host: checked.host, port: checked.port };
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [subnet, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(subnet, prefix, 'ipv4');
// IPv6: дозволяємо лише глобальний unicast (2000::/3) мінус документацію, Teredo, 6to4, ORCHID, benchmarking.
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [subnet, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2002::', 16], ['2001:10::', 28], ['2001:20::', 28],
    ['2001:2::', 48], ['3fff::', 20]]) blocked.addSubnet(subnet, prefix, 'ipv6');

export function isPublicAddress(address) {
    const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    const family = net.isIP(value);
    if (family === 4) return !blocked.check(value, 'ipv4');
    if (family === 6) {
        // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d) та інші адреси поза 2000::/3 (::1, fc00::/7, fe80::/10, ff00::/8…).
        if (!globalV6.check(value, 'ipv6')) return false;
        return !blocked.check(value, 'ipv6');
    }
    return false;
}

// Усі адреси імені мають бути публічними; інакше — відмова.
export async function resolvePublic(hostname, lookup = dns.promises.lookup) {
    let list;
    try {
        list = await lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw new GpsError('network', 'dns');
    }
    if (!Array.isArray(list) || !list.length) throw new GpsError('network', 'dns_empty');
    if (list.some((a) => !isPublicAddress(a.address))) throw new GpsError('unsafe_host', 'private_address');
    return list.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) }));
}

// lookup для сокета: повертає лише перевірені адреси (саме на них і йде зʼєднання).
export function pinnedLookup(lookup) {
    return function safeLookup(hostname, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'object' && options ? options : {};
        resolvePublic(hostname, lookup).then((list) => {
            if (opts.all) cb(null, list);
            else cb(null, list[0].address, list[0].family);
        }, (error) => cb(error));
    };
}

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_)/;

function toGpsError(error) {
    if (error instanceof GpsError) return error;
    if (error && TLS_CODES.test(String(error.code || ''))) return new GpsError('tls', 'tls');
    return new GpsError('network', error && error.code ? String(error.code) : 'socket');
}

// POST на перевірений хост. Повертає { status, text }; тіло (з токеном) ніде не логуємо.
export function safeRequest({ host, port = 443, path, body, timeoutMs = 15000, maxBytes = 2000000,
    lookup = dns.promises.lookup, request = https.request }) {
    return new Promise((resolve, reject) => {
        const target = isHostingHost(host) && port === 443
            ? { host: String(host).toLowerCase(), port: 443 }
            : (() => {
                const checked = normalizeLocalUrl('https://' + host + (port === 443 ? '' : ':' + port));
                if (!checked.ok) throw new GpsError('unsafe_host', checked.reason);
                return checked;
            })();
        let done = false;
        let req;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            fn(value);
        };
        const fail = (error) => {
            if (req) req.destroy();
            finish(reject, toGpsError(error));
        };
        const timer = setTimeout(() => fail(new GpsError('network', 'timeout')), timeoutMs);
        try {
            req = request({
                host: target.host,
                port: target.port,
                path,
                method: 'POST',
                servername: target.host,
                lookup: pinnedLookup(lookup),
                agent: false,
                timeout: timeoutMs,
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': Buffer.byteLength(body || ''),
                    accept: 'application/json',
                },
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400) {
                    res.resume();
                    fail(new GpsError('network', 'redirect'));
                    return;
                }
                const declared = Number(res.headers && res.headers['content-length']);
                if (declared > maxBytes) {
                    res.resume();
                    fail(new GpsError('network', 'too_large'));
                    return;
                }
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > maxBytes) fail(new GpsError('network', 'too_large'));
                    else chunks.push(chunk);
                });
                res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
                res.on('error', fail);
            });
            req.on('timeout', () => fail(new GpsError('network', 'timeout')));
            req.on('error', fail);
            req.end(body || '');
        } catch (error) {
            fail(error);
        }
    }).catch((error) => { throw toGpsError(error); });
}
