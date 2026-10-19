import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

console.info = () => {}; // upstream log lines are checked explicitly below

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const poi = await import('../api/poi.js');
const {
    default: handler,
    handleGeo,
    geoGeocode,
    geoRoute,
    geoNormalizePhoton,
    geoParsePoint,
    geoClientIp,
    geoRateLimited,
    OSM_GEO_RATE_LIMITS,
    OSM_GEO_CACHE_CONTROL,
    OSM_GEO_REFERER,
    OVERPASS_USER_AGENT
} = poi;

function fakeRes() {
    return {
        headers: {},
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}
function mockFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        const next = typeof responses === 'function' ? responses(url, calls.length) : responses[calls.length - 1];
        if (next instanceof Error) throw next;
        return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    };
    return { fetchImpl, calls };
}
const feature = (props, lon, lat) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const PHOTON = {
    type: 'FeatureCollection',
    features: [
        feature({ name: 'Житомир', county: 'Житомирський район', state: 'Житомирська область', country: 'Україна', countrycode: 'UA' }, 28.6696281, 50.2601065),
        feature({ name: 'Житомир', county: 'Житомирський район', state: 'Житомирська область', country: 'Україна', countrycode: 'UA' }, 28.67, 50.26),
        feature({ name: 'Berlin', state: 'Berlin', country: 'Deutschland', countrycode: 'DE' }, 13.395131, 52.517389),
        feature({ name: 'Berlin', county: 'Coos', state: 'New Hampshire', country: 'United States', countrycode: 'US' }, -71.18, 44.47),
        feature({ street: 'Вокзальна вулиця', housenumber: '1', city: 'Житомир', state: 'Житомирська область', countrycode: 'UA' }, 28.69, 50.26),
        feature({ countrycode: 'UA' }, 30, 50),
        { type: 'Feature', properties: { name: 'Без координат' }, geometry: null }
    ]
};
const geoReq = (query, ip = '10.0.0.1') => ({ method: 'GET', query, headers: { 'x-forwarded-for': ip + ', 172.16.0.1' } });

test('geocode: Photon GeoJSON is normalized, no raw GeoJSON, outside Europe and duplicates dropped', () => {
    const items = geoNormalizePhoton(PHOTON);
    assert.deepEqual(items, [
        { label: 'Житомир, Житомирський район, Житомирська область', name: 'Житомир', city: 'Житомирський район', region: 'Житомирська область', lat: 50.260107, lon: 28.669628 },
        { label: 'Berlin, Deutschland', name: 'Berlin', city: '', region: 'Berlin', lat: 52.517389, lon: 13.395131 },
        { label: 'Вокзальна вулиця 1, Житомир, Житомирська область', name: 'Вокзальна вулиця 1', city: 'Житомир', region: 'Житомирська область', lat: 50.26, lon: 28.69 }
    ]);
    assert.deepEqual(geoNormalizePhoton(null), []);
});

test('geocode: right Photon parameters, User-Agent and Referer; q is trimmed and lower-cased', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, body: PHOTON }]);
    const result = await geoGeocode('  Житомир   Центр ', { fetchImpl });
    assert.equal(result.status, 200);
    assert.equal(result.body.items.length, 3);
    assert.equal(result.body.attribution, '© OpenStreetMap contributors');
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://photon.komoot.io/api/');
    assert.equal(url.searchParams.get('q'), 'житомир центр');
    assert.equal(url.searchParams.get('limit'), '6');
    assert.equal(url.searchParams.get('lat'), '49.0');
    assert.equal(url.searchParams.get('lon'), '31.5');
    assert.equal(url.searchParams.has('lang'), false, 'public Photon supports only default/en/de/fr');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers['User-Agent'], OVERPASS_USER_AGENT);
    assert.equal(calls[0].options.headers['User-Agent'], 'trip-control.com (support@trip-control.com)');
    assert.equal(calls[0].options.headers.Referer, OSM_GEO_REFERER);
    assert.equal(OSM_GEO_REFERER, 'https://trip-control.com/');
    assert.ok(calls[0].options.signal, 'AbortController signal for the timeout');
});

test('geocode: q shorter than 3 or longer than 100 characters → 400 without calling Photon', async () => {
    for (const q of ['', 'ab', '  a ', 'x'.repeat(101), undefined]) {
        const { fetchImpl, calls } = mockFetch([]);
        const result = await geoGeocode(q, { fetchImpl });
        assert.equal(result.status, 400, String(q));
        assert.equal(result.body.code, 'GEO_BAD_INPUT');
        assert.equal(calls.length, 0);
    }
});

test('route: km rounded, podacha_km for base (base → A), coordinates rounded to 4 digits', async () => {
    const { fetchImpl, calls } = mockFetch((url) => ({
        status: 200,
        body: { code: 'Ok', routes: [{ distance: url.includes('30.52,50.45;') ? 139600 : 543211.3 }] }
    }));
    const result = await geoRoute({ from: '50.260107,28.669628', to: '46.48430,30.73229', base: '50.45,30.52' }, { fetchImpl });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { km: 543, podacha_km: 140, source: 'osrm', estimate: true, attribution: '© OpenStreetMap contributors' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://router.project-osrm.org/route/v1/driving/28.6696,50.2601;30.7323,46.4843?overview=false&alternatives=false&steps=false');
    assert.equal(calls[1].url, 'https://router.project-osrm.org/route/v1/driving/30.52,50.45;28.6696,50.2601?overview=false&alternatives=false&steps=false');
    assert.equal(calls[0].options.headers['User-Agent'], OVERPASS_USER_AGENT);
    // Without base there is no podacha request.
    const single = mockFetch([{ status: 200, body: { code: 'Ok', routes: [{ distance: 1499 }] } }]);
    const one = await geoRoute({ from: '50.26,28.66', to: '50.27,28.67' }, { fetchImpl: single.fetchImpl });
    assert.deepEqual(one.body, { km: 1, source: 'osrm', estimate: true, attribution: '© OpenStreetMap contributors' });
    assert.equal(single.calls.length, 1);
});

test('route: wrong coordinates → 400 without calling OSRM; NoRoute → 404', async () => {
    for (const query of [
        { from: '50.26,28.66' },
        { from: 'abc', to: '50,30' },
        { from: '91,0', to: '50,30' },
        { from: '50,181', to: '50,30' },
        { from: '50,30', to: '-33.9,18.4' },
        { from: '50,30', to: '40.7,-74.0' },
        { from: '50,30,1', to: '50,30' },
        { from: '50,30', to: '50.1,30.1', base: 'x' }
    ]) {
        const { fetchImpl, calls } = mockFetch([]);
        const result = await geoRoute(query, { fetchImpl });
        assert.equal(result.status, 400, JSON.stringify(query));
        assert.equal(result.body.code, 'GEO_BAD_INPUT');
        assert.equal(calls.length, 0);
    }
    assert.deepEqual(geoParsePoint(' 50.123456 , 30.98765 '), { lat: 50.1235, lon: 30.9877 });
    const noRoute = mockFetch([{ status: 400, body: { code: 'NoRoute', message: 'Impossible route' } }]);
    const result = await geoRoute({ from: '50,30', to: '51,31' }, { fetchImpl: noRoute.fetchImpl });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'GEO_NO_ROUTE');
});

test('upstream failures: timeout → 504, 5xx → 502, 429 → 429; short Ukrainian JSON, no stacks', async () => {
    const hang = async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    const timeout = await geoGeocode('житомир', { fetchImpl: hang, timeoutMs: 5 });
    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.code, 'GEO_TIMEOUT');
    const down = await geoRoute({ from: '50,30', to: '51,31' }, mockFetch([{ status: 503, body: null }]));
    assert.equal(down.status, 502);
    assert.equal(down.body.code, 'GEO_UNAVAILABLE');
    const network = await geoGeocode('житомир', mockFetch([new TypeError('fetch failed')]));
    assert.equal(network.status, 502);
    const limited = await geoGeocode('житомир', mockFetch([{ status: 429, body: {} }]));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'GEO_RATE_LIMIT');
    for (const r of [timeout, down, network, limited]) {
        assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error']);
        assert.match(r.body.error, /[А-Яа-яІіЇїЄє]/);
    }
});

test('per-IP rate limit: geocode 60/min, route 20/min; another IP and the next minute are not affected', async () => {
    assert.deepEqual(OSM_GEO_RATE_LIMITS, { geocode: 60, route: 20 });
    assert.equal(geoClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }), '1.2.3.4');
    assert.equal(geoClientIp({ headers: { 'x-real-ip': '5.6.7.8' } }), '5.6.7.8');
    const rateStore = new Map();
    let nowMs = 1000;
    const now = () => nowMs;
    const fetchImpl = async () => { throw new Error('must not be called for q < 3'); };
    const statuses = [];
    for (let i = 0; i < 61; i++) {
        const res = fakeRes();
        await handleGeo(geoReq({ mode: 'geocode', q: 'ab' }), res, { rateStore, now, fetchImpl });
        statuses.push(res.statusCode);
    }
    assert.equal(statuses.filter((s) => s === 400).length, 60);
    assert.equal(statuses[60], 429);
    const other = fakeRes();
    await handleGeo(geoReq({ mode: 'geocode', q: 'ab' }, '10.9.9.9'), other, { rateStore, now, fetchImpl });
    assert.equal(other.statusCode, 400);
    for (let i = 0; i < 20; i++) {
        const res = fakeRes();
        await handleGeo(geoReq({ mode: 'route', from: 'x', to: 'y' }), res, { rateStore, now, fetchImpl });
        assert.equal(res.statusCode, 400);
    }
    const blocked = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: 'x', to: 'y' }), blocked, { rateStore, now, fetchImpl });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers['Cache-Control'], 'no-store');
    nowMs += 60 * 1000;
    const later = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: 'x', to: 'y' }), later, { rateStore, now, fetchImpl });
    assert.equal(later.statusCode, 400);
    // The in-memory store stays bounded.
    const small = new Map();
    for (let i = 0; i < 50; i++) geoRateLimited(small, 'k' + i, 5, 0, 60000, 10);
    assert.ok(small.size <= 10);
});

test('successful GET responses are CDN-cacheable; errors are no-store', async () => {
    assert.deepEqual(OSM_GEO_CACHE_CONTROL, {
        geocode: 'public, s-maxage=604800',
        route: 'public, s-maxage=86400, stale-while-revalidate=604800'
    });
    const ok = fakeRes();
    await handleGeo(geoReq({ mode: 'geocode', q: 'Житомир' }), ok, { rateStore: new Map(), budget: poi.geoBudgetState(), ...mockFetch([{ status: 200, body: PHOTON }]) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['Cache-Control'], 'public, s-maxage=604800');
    const route = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: '50,30', to: '51,31' }), route,
        { rateStore: new Map(), budget: poi.geoBudgetState(), ...mockFetch([{ status: 200, body: { code: 'Ok', routes: [{ distance: 1000 }] } }]) });
    assert.equal(route.headers['Cache-Control'], 'public, s-maxage=86400, stale-while-revalidate=604800');
    const bad = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: '50,30' }), bad, { rateStore: new Map() });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.headers['Cache-Control'], 'no-store');
});

test('POI path is untouched: POST goes the old way, non-POST without a geo mode → 405, geo modes never search POI', async () => {
    const post = fakeRes();
    await handler({ method: 'POST', query: { mode: 'geocode', q: 'житомир' }, headers: {}, body: { points: [] } }, post);
    assert.equal(post.statusCode, 401);
    assert.deepEqual(post.body, { error: 'Необхідна авторизація.' });
    for (const query of [{}, { mode: 'poi' }, { mode: 'overpass' }]) {
        const res = fakeRes();
        await handler({ method: 'GET', query, headers: {} }, res);
        assert.equal(res.statusCode, 405, JSON.stringify(query));
    }
    const put = fakeRes();
    await handler({ method: 'PUT', query: { mode: 'route' }, headers: {} }, put);
    assert.equal(put.statusCode, 405);
    const source = read('api/poi.js');
    const handlerStart = source.indexOf('export default async function handler(req, res) {');
    assert.match(source.slice(handlerStart), /^export default async function handler\(req, res\) \{\n    if \(geoRequestMode\(req\)\) \{\n        return handleGeo\(req, res\);\n    \}\n    const startedAt = Date\.now\(\);\n    if \(req\.method !== 'POST'\) \{/);
    const geo = source.slice(source.indexOf('// ===== Адреси й відстань за OpenStreetMap'), handlerStart);
    const geoCode = geo.replace(/^\s*\/\/.*$/gm, '').replace(/OVERPASS_USER_AGENT/g, '');
    assert.equal(/overpass|poi_cache|fetchOverpass|searchPOIs/i.test(geoCode), false);
    // Existing POI constants keep their values.
    assert.equal(poi.POI_POINTS_LIMIT, 40);
    assert.equal(poi.POI_CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(poi.OVERPASS_TIMEOUT_MS, 27000);
    assert.deepEqual(poi.config, { maxDuration: 60 });
});

test('Photon / OSRM hostnames only on the server (and docs); CSP, rewrites, functions unchanged; no new api functions', () => {
    for (const file of ['index.html', 'assets/landing.js', 'assets/osm-geo.js', 'assets/landing.css', 'vercel.json']) {
        const source = read(file);
        assert.equal(source.includes('photon.komoot.io'), false, file);
        assert.equal(source.includes('project-osrm.org'), false, file);
    }
    assert.match(read('api/poi.js'), /https:\/\/photon\.komoot\.io\/api\//);
    assert.match(read('api/poi.js'), /https:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);
    const vercel = JSON.parse(read('vercel.json'));
    assert.equal(vercel.rewrites.length, 3);
    assert.deepEqual(vercel.functions, { 'api/poi.js': { maxDuration: 60 } });
    const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
    assert.match(csp, /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co https:\/\/maps\.googleapis\.com https:\/\/\*\.googleapis\.com https:\/\/bank\.gov\.ua https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com;/);
    const apiFiles = readdirSync(new URL('../api/', import.meta.url), { recursive: true }).filter((f) => String(f).endsWith('.js'));
    assert.ok(apiFiles.length <= 8, 'no new serverless functions: ' + apiFiles.join(', '));
    // Browser code only talks to our proxy.
    const client = read('assets/osm-geo.js');
    assert.match(client, /'\/api\/poi\?mode=geocode&q='/);
    assert.match(client, /'\/api\/poi\?mode=route&from='/);
    assert.equal(/method:\s*'POST'/.test(client), false);
});

test('route with base: if base → A fails, 200 without podacha_km is not cached (no-store)', async () => {
    const { fetchImpl } = mockFetch((url) => url.includes('30.52,50.45;')
        ? { status: 503, body: null }
        : { status: 200, body: { code: 'Ok', routes: [{ distance: 543211 }] } });
    const res = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: '50.26,28.67', to: '46.48,30.73', base: '50.45,30.52' }), res,
        { rateStore: new Map(), budget: poi.geoBudgetState(), now: () => 0, fetchImpl });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.km, 543);
    assert.equal('podacha_km' in res.body, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal('cacheable' in res.body, false);
});

test('upstream budget per instance, separate buckets for Photon and OSRM (≈1 rps, burst 4): over budget → GEO_RATE_LIMIT', async () => {
    const { OSM_GEO_UPSTREAM_RPS, OSM_GEO_UPSTREAM_BURST, geoTakeBudget, geoUpstreamCost, geoUpstreamService, geoBudgetState } = poi;
    assert.equal(OSM_GEO_UPSTREAM_RPS, 1);
    assert.ok(OSM_GEO_UPSTREAM_BURST >= 4);
    assert.deepEqual(geoBudgetState(), { photon: { tokens: OSM_GEO_UPSTREAM_BURST, at: 0 }, osrm: { tokens: OSM_GEO_UPSTREAM_BURST, at: 0 } });
    assert.equal(geoUpstreamService('geocode'), 'photon');
    assert.equal(geoUpstreamService('route'), 'osrm');
    const state = { tokens: 4, at: 0 };
    for (let i = 0; i < 4; i++) assert.equal(geoTakeBudget(state, 1, 0), true, 'burst ' + i);
    assert.equal(geoTakeBudget(state, 1, 100), false);
    assert.equal(geoTakeBudget(state, 1, 1100), true, 'refills 1 token per second');
    assert.equal(geoTakeBudget(state, 2, 1100), false);
    assert.equal(geoTakeBudget(state, 4, 60000), true, 'never above the burst');
    assert.equal(geoTakeBudget(state, 1, 60000), false);
    // Bad input does not spend the budget — including route with an invalid base.
    assert.equal(geoUpstreamCost('geocode', { q: 'ab' }), 0);
    assert.equal(geoUpstreamCost('geocode', { q: 'житомир' }), 1);
    assert.equal(geoUpstreamCost('route', { from: '50,30', to: '51,31' }), 1);
    assert.equal(geoUpstreamCost('route', { from: '50,30', to: '51,31', base: '  ' }), 1);
    assert.equal(geoUpstreamCost('route', { from: '50,30', to: '51,31', base: '50.4,30.5' }), 2);
    assert.equal(geoUpstreamCost('route', { from: '50,30', to: '51,31', base: 'x' }), 0);
    assert.equal(geoUpstreamCost('route', { from: '50,30', to: '51,31', base: '91,0' }), 0);
    assert.equal(geoUpstreamCost('route', { from: '50,30' }), 0);

    const budget = geoBudgetState();
    const photon = mockFetch(() => ({ status: 200, body: PHOTON }));
    const statuses = [];
    for (const q of ['житомир', 'одеса', 'київ', 'львів', 'рівне']) {
        const res = fakeRes();
        await handleGeo(geoReq({ mode: 'geocode', q }), res, { rateStore: new Map(), budget, now: () => 500, fetchImpl: photon.fetchImpl });
        statuses.push(res.statusCode);
        if (res.statusCode === 429) {
            assert.equal(res.body.code, 'GEO_RATE_LIMIT');
            assert.equal(res.headers['Cache-Control'], 'no-store');
        }
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
    assert.equal(photon.calls.length, 4);
    // Photon is exhausted, OSRM has its own bucket.
    const osrm = mockFetch(() => ({ status: 200, body: { code: 'Ok', routes: [{ distance: 1000 }] } }));
    const route = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: '50,30', to: '51,31', base: '50.4,30.5' }), route, { rateStore: new Map(), budget, now: () => 500, fetchImpl: osrm.fetchImpl });
    assert.equal(route.statusCode, 200);
    assert.equal(budget.osrm.tokens, OSM_GEO_UPSTREAM_BURST - 2);
    // Invalid base → 400 and the OSRM bucket is untouched.
    const bad = fakeRes();
    await handleGeo(geoReq({ mode: 'route', from: '50,30', to: '51,31', base: 'x' }), bad, { rateStore: new Map(), budget, now: () => 500, fetchImpl: osrm.fetchImpl });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.code, 'GEO_BAD_INPUT');
    assert.equal(budget.osrm.tokens, OSM_GEO_UPSTREAM_BURST - 2);
    assert.equal(osrm.calls.length, 2);
});

test('runtime log: only the upstream host, status and duration — no IP, no address, no coordinates', async () => {
    const { geoUpstreamLogLine } = poi;
    const lines = [];
    const log = (line) => lines.push(line);
    await geoGeocode('Житомир, вулиця Перемоги 1', { ...mockFetch([{ status: 403, body: {} }]), log });
    await geoRoute({ from: '50.2601,28.6696', to: '46.4843,30.7323' }, { ...mockFetch([{ status: 200, body: { code: 'Ok', routes: [{ distance: 1000 }] } }]), log });
    const hang = async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    await geoGeocode('одеса', { fetchImpl: hang, timeoutMs: 5, log });
    await geoGeocode('київ', { ...mockFetch([new TypeError('getaddrinfo ENOTFOUND')]), log });
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^osm-geo upstream photon\.komoot\.io status=403 ms=\d+$/);
    assert.match(lines[1], /^osm-geo upstream router\.project-osrm\.org status=200 ms=\d+$/);
    assert.match(lines[2], /^osm-geo upstream photon\.komoot\.io status=timeout ms=\d+$/);
    assert.match(lines[3], /^osm-geo upstream photon\.komoot\.io status=network ms=\d+$/);
    for (const line of lines) assert.equal(/житомир|перемоги|50\.26|28\.66|одеса|київ|\d+\.\d+\.\d+\.\d+/i.test(line), false, line);
    assert.equal(geoUpstreamLogLine('not a url', { status: 502 }, 12.4), 'osm-geo upstream unknown status=502 ms=12');
    const source = read('api/poi.js');
    const geo = source.slice(source.indexOf('// ===== Адреси й відстань за OpenStreetMap'), source.indexOf('export default async function handler'));
    assert.equal(/console\.(log|info|warn|error)\([^)]*(geoClientIp|x-forwarded-for|req\.headers|query\.q|url\b)/.test(geo), false);
});

test('api/poi.js loads without SUPABASE_* (Preview): geocode / route work, Supabase is created only on the POI path', async () => {
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env };
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const script = `
        const poi = await import(${JSON.stringify(new URL('../api/poi.js', import.meta.url).href)});
        console.info = () => {};
        const res = () => ({ h: {}, setHeader(k, v) { this.h[k] = v; }, status(s) { this.s = s; return this; }, json(b) { this.b = b; return this; } });
        const out = [];
        let r = res(); await poi.default({ method: 'GET', query: { mode: 'geocode', q: 'ab' }, headers: {} }, r); out.push(r.s, r.b.code);
        r = res(); await poi.handleGeo({ method: 'GET', query: { mode: 'geocode', q: 'житомир' }, headers: {} }, r,
            { rateStore: new Map(), budget: poi.geoBudgetState(), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) }) });
        out.push(r.s);
        r = res(); await poi.default({ method: 'POST', query: {}, headers: {}, body: {} }, r); out.push(r.s);
        process.stdout.write(JSON.stringify(out));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [400, 'GEO_BAD_INPUT', 200, 401]);
    const source = read('api/poi.js');
    assert.equal(/^const supabase = createClient\(/m.test(source), false);
    assert.match(source, /function supabaseAdmin\(\) \{\n\s+if \(!supabaseClient\) \{\n\s+supabaseClient = createClient\(/);
    assert.equal((source.match(/supabaseAdmin\(\)/g) || []).length, 5);
});

test('client: route retries once after ~1 s on GEO_RATE_LIMIT; other errors and a second 429 are not retried', async () => {
    const vm = await import('node:vm');
    const load = (responses) => {
        const calls = [];
        const waits = [];
        const sandbox = {
            window: {},
            setTimeout: (fn, ms) => { waits.push(ms); fn(); return 0; },
            fetch: async (url) => {
                calls.push(url);
                const next = responses[calls.length - 1];
                return { ok: next.status === 200, status: next.status, json: async () => next.body };
            }
        };
        vm.runInNewContext(read('assets/osm-geo.js'), sandbox);
        return { geo: sandbox.window.TcOsmGeo, calls, waits };
    };
    const points = { from: { lat: 50.26, lon: 28.67 }, to: { lat: 46.48, lon: 30.73 } };
    const limited = { status: 429, body: { code: 'GEO_RATE_LIMIT', error: 'x' } };
    const ok = { status: 200, body: { km: 543 } };
    const retried = load([limited, ok]);
    assert.equal((await retried.geo.route(points)).km, 543);
    assert.equal(retried.calls.length, 2);
    assert.equal(retried.calls[0], retried.calls[1]);
    assert.deepEqual(retried.waits, [1000]);
    const twice = load([limited, limited]);
    await assert.rejects(twice.geo.route(points), (err) => err.code === 'GEO_RATE_LIMIT');
    assert.equal(twice.calls.length, 2);
    const other = load([{ status: 502, body: { code: 'GEO_UNAVAILABLE', error: 'x' } }]);
    await assert.rejects(other.geo.route(points), (err) => err.code === 'GEO_UNAVAILABLE');
    assert.equal(other.calls.length, 1);
    assert.deepEqual(other.waits, []);
});
