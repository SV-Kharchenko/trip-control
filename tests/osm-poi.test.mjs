import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261013100000_poi_cache.sql', import.meta.url), 'utf8');
const poiSource = readFileSync(new URL('../api/poi.js', import.meta.url), 'utf8');
const {
    POI_CORRIDOR_BUFFER_M,
    POI_CACHE_TTL_MS,
    OVERPASS_MIRRORS,
    OVERPASS_PRIMARY,
    OVERPASS_USER_AGENT,
    OVERPASS_ATTEMPT_LIMIT,
    OVERPASS_TIMEOUT_MS,
    POI_ERROR_TEXT,
    geohashEncode,
    corridorSegmentKeys,
    poiCacheFresh,
    overpassCorridorQuery,
    normalizePoiElement,
    nearestSegmentKey,
    poiRouteCacheKey,
    fetchOverpass,
    corridorChunks,
    CORRIDOR_CHUNK_METERS,
    poiCanStart,
    collectCorridorSegments
} = await import('../api/poi.js');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.equal(from >= 0, true, start);
    assert.equal(to > from, true, end);
    return source.slice(from, to);
}

test('the route search is one corridor, not a circle on every point', () => {
    const kyiv = { lat: 50.4501, lon: 30.5234 };
    const lviv = { lat: 49.8397, lon: 24.0297 };
    const query = overpassCorridorQuery([kyiv, lviv], ['gas', 'tir', 'cafe', 'sto']);
    assert.equal(POI_CORRIDOR_BUFFER_M, 3000);
    assert.match(query, /\[timeout:25\]/);
    assert.match(query, /\[maxsize:67108864\]/);
    assert.equal(OVERPASS_TIMEOUT_MS, 27000);
    assert.match(query, new RegExp('around:' + POI_CORRIDOR_BUFFER_M + ',50\\.4501,30\\.5234,49\\.8397,24\\.0297'));
    assert.equal(query.includes('around:' + POI_CORRIDOR_BUFFER_M + ',50.4501,30.5234);'), false);
    assert.match(query, /\["amenity"="fuel"\]/);
    assert.match(query, /\["amenity"="cafe"\]/);
    assert.match(query, /\["shop"="car_repair"\]/);
    assert.match(query, /\["highway"="rest_area"\]/);
    assert.equal(query.split('[out:json]').length - 1, 1);
    assert.equal((query.match(/around:/g) || []).length, 5);
    assert.equal(query.includes('nwr['), false);
    const cacheBeforeFetch = poiSource.indexOf('corridorChunks(points)');
    const fetchCall = poiSource.indexOf('fetchOverpass(overpassCorridorQuery(chunk');
    assert.equal(cacheBeforeFetch > 0 && fetchCall > cacheBeforeFetch, true);
    assert.equal(poiSource.split('fetchOverpass(overpassCorridorQuery(chunk').length - 1, 1);
    assert.equal(geohashEncode(kyiv.lat, kyiv.lon, 5), geohashEncode(kyiv.lat, kyiv.lon, 5));
    assert.notEqual(geohashEncode(kyiv.lat, kyiv.lon, 5), geohashEncode(lviv.lat, lviv.lon, 5));
    assert.deepEqual(corridorSegmentKeys([kyiv, kyiv, lviv]).length, 2);
});

test('cache rows expire after 30 days and names stay data, not markup', () => {
    const now = Date.parse('2026-10-13T09:00:00.000Z');
    assert.equal(POI_CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(poiCacheFresh(new Date(now - POI_CACHE_TTL_MS).toISOString(), now), true);
    assert.equal(poiCacheFresh(new Date(now - POI_CACHE_TTL_MS - 1).toISOString(), now), false);
    const item = normalizePoiElement({
        type: 'node',
        id: 7,
        lat: 50.45,
        lon: 30.52,
        tags: { amenity: 'fuel', name: '<script>', 'addr:city': 'Київ' }
    });
    assert.equal(item.kind, 'gas');
    assert.equal(item.name, '<script>');
    assert.equal(item.address, 'Київ');
    assert.equal(nearestSegmentKey(item, [{ lat: 50.45, lon: 30.52 }, { lat: 49.84, lon: 24.03 }]), geohashEncode(50.45, 30.52, 5));
});

test('corridors are about 60 km and a long route is not capped at six', () => {
    const short = corridorChunks([
        { lat: 50.45, lon: 30.52 },
        { lat: 50.46, lon: 30.62 }
    ]);
    assert.equal(short.length, 1);
    assert.equal(CORRIDOR_CHUNK_METERS, 60000);
    const points = [];
    for (let i = 0; i < 20; i++) points.push({ lat: 46.48 + i * 0.18, lon: 30.73 - i * 0.35 });
    const chunks = corridorChunks(points);
    assert.equal(chunks.length > 6, true);
    const firstQuery = overpassCorridorQuery(chunks[0], ['gas', 'tir']);
    assert.equal(firstQuery.split('[out:json]').length - 1, 1);
    assert.match(firstQuery, /around:3000,/);
    assert.match(poiSource, /maxDuration: 60/);
    assert.equal(poiSource.includes('kumi.systems'), false);
});

test('a repeat route reuses one cache key from rounded coordinates and categories', () => {
    const types = ['gas', 'cafe'];
    const exact = poiRouteCacheKey([{ lat: 50.4501, lon: 30.5234 }], types);
    const roundedSame = poiRouteCacheKey([{ lat: 50.454, lon: 30.524 }], types);
    const roundedOther = poiRouteCacheKey([{ lat: 50.456, lon: 30.5234 }], types);
    const otherTypes = poiRouteCacheKey([{ lat: 50.4501, lon: 30.5234 }], ['cafe', 'gas', 'sto']);
    assert.equal(exact, roundedSame);
    assert.notEqual(exact, roundedOther);
    assert.notEqual(exact, otherTypes);
    assert.equal(exact.length, 12);
    assert.match(exact, /^[0-9a-f]{12}$/);
    assert.equal(poiSource.includes('відповів HTTP'), false);
    assert.match(poiSource, /OVERPASS_TIMEOUT/);
    assert.match(poiSource, /POI_CACHE_TTL_MS/);
});

test('a segment retries once after 504, skips a dead status, and stops when 30s are gone', async () => {
    assert.deepEqual(OVERPASS_MIRRORS, [OVERPASS_PRIMARY]);
    assert.equal(OVERPASS_PRIMARY, 'https://overpass-api.de/api/interpreter');
    assert.equal(OVERPASS_ATTEMPT_LIMIT, 2);
    assert.equal(OVERPASS_USER_AGENT, 'trip-control.com (support@trip-control.com)');
    assert.equal(POI_ERROR_TEXT.OVERPASS_TIMEOUT, 'Сервіс карт не встиг відповісти');
    assert.equal(POI_ERROR_TEXT.OVERPASS_RATE_LIMIT, 'Сервіс карт перевантажений, спробуй за хвилину');
    assert.equal(POI_ERROR_TEXT.NETWORK, 'Помилка мережі');

    const calls = [];
    const recovered = await fetchOverpass('[out:json];out;', {
        startedAt: 0,
        timeoutMs: 20,
        now: () => 0,
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (calls.length === 1) return { ok: false, status: 504, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 1 }] }) };
        }
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, OVERPASS_PRIMARY);
    assert.equal(calls[1].url, OVERPASS_PRIMARY);
    assert.equal(calls[0].init.headers['User-Agent'], OVERPASS_USER_AGENT);
    assert.equal(recovered.elements.length, 1);

    const rejected = [];
    const unavailable = await fetchOverpass('[out:json];out;', {
        startedAt: 0,
        timeoutMs: 20,
        now: () => 0,
        fetchImpl: async () => {
            rejected.push(1);
            return { ok: false, status: 400, json: async () => ({}) };
        }
    });
    assert.equal(rejected.length, 1);
    assert.equal(unavailable.code, 'OVERPASS_UNAVAILABLE');
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.detail.mirror, OVERPASS_PRIMARY);
    assert.equal(unavailable.detail.status, 400);
    assert.equal(typeof unavailable.detail.ms, 'number');
    assert.equal(unavailable.error === true && String(POI_ERROR_TEXT.OVERPASS_UNAVAILABLE).includes('http'), false);

    let phase = 0;
    const lateCalls = [];
    const timedOut = await fetchOverpass('[out:json];out;', {
        startedAt: 0,
        timeoutMs: 20,
        now: () => phase,
        fetchImpl: async () => {
            phase = 40000;
            lateCalls.push(1);
            return { ok: false, status: 504, json: async () => ({}) };
        }
    });
    assert.equal(lateCalls.length, 1);
    assert.equal(timedOut.code, 'OVERPASS_TIMEOUT');
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.detail.status, 504);
    assert.equal(poiCanStart(0, 31000), false);
    assert.equal(poiCanStart(0, 30000), true);
});

test('a failed segment does not stop the route, and a tight budget leaves the rest pending', async () => {
    const calls = [];
    const continued = await collectCorridorSegments([[{ lat: 1, lon: 1 }], [{ lat: 2, lon: 2 }], [{ lat: 3, lon: 3 }]], {
        startedAt: 0,
        now: () => 0,
        budgetMs: 60000,
        reserveMs: 30000,
        load: async (_chunk, index) => {
            calls.push(index);
            if (index === 0) {
                return {
                    error: true,
                    code: 'OVERPASS_TIMEOUT',
                    detail: { mirror: OVERPASS_PRIMARY, status: 504, ms: 6900 }
                };
            }
            return { elements: [{ id: 'n/' + index, lat: 1, lon: 2, name: 'АЗС', address: '', kind: 'gas' }], cached: false };
        }
    });
    assert.deepEqual(calls, [0, 1, 2]);
    assert.equal(continued.failed.length, 1);
    assert.equal(continued.failed[0].code, 'OVERPASS_TIMEOUT');
    assert.equal(continued.done.length, 2);
    assert.deepEqual(continued.pending, []);

    let loads = 0;
    const parked = await collectCorridorSegments([[{ lat: 1, lon: 1 }], [{ lat: 2, lon: 2 }]], {
        startedAt: 0,
        now: () => 31000,
        budgetMs: 60000,
        reserveMs: 30000,
        load: async () => {
            loads += 1;
            return { elements: [] };
        }
    });
    assert.equal(loads, 0);
    assert.deepEqual(parked.pending, [0, 1]);
    assert.equal(parked.failed.length, 0);
});

test('the page asks api/poi and does not send POI names through Places', () => {
    const search = sliceBetween(html, 'async function searchPOIsAlongRoute', 'function corridorSample');
    const marker = sliceBetween(html, 'function addPoiMarker', 'function isUiPreviewHostAllowed');
    assert.match(search, /fetch\('\/api\/poi'/);
    assert.match(search, /segments: batch/);
    assert.match(search, /Відрізок /);
    assert.match(search, /відрізків не завантажено/);
    assert.match(search, /setTimeout\(resolve, 500\)/);
    assert.match(html, /Повторити невдалі/);
    assert.match(html, /Помилка мережі/);
    assert.match(html, /Сервіс карт не встиг відповісти/);
    assert.match(html, /sampleRoutePoints\(path, 5000\)/);
    assert.equal(search.includes('i < 25'), false);
    assert.equal(search.includes('відповів HTTP'), false);
    assert.equal(html.includes('overpass.kumi.systems'), false);
    assert.match(marker, /poiSeenIds/);
    assert.equal(search.includes('searchNearby'), false);
    assert.equal(search.includes('searchByText'), false);
    assert.equal(search.includes("importLibrary('places')"), false);
    assert.equal(search.includes('Google Places'), false);
    assert.match(marker, /escAdm\(name\)/);
    assert.match(marker, /escAdm\(item\.address\)/);
    assert.equal(marker.includes('innerHTML'), false);
    assert.match(html, /© OpenStreetMap contributors/);
    assert.match(html, /createAddressAutocomplete/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.poi_cache/);
    assert.match(migration, /PRIMARY KEY \(poi_type, segment_key\)/);
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /REVOKE ALL ON TABLE public\.poi_cache FROM PUBLIC, anon, authenticated/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.poi_cache TO service_role/);
});
