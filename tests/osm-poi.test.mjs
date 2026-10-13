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
    OVERPASS_USER_AGENT,
    OVERPASS_BACKOFF_MS,
    OVERPASS_ATTEMPT_LIMIT,
    POI_BUSY_MESSAGE,
    geohashEncode,
    corridorSegmentKeys,
    poiCacheFresh,
    overpassCorridorQuery,
    normalizePoiElement,
    nearestSegmentKey,
    poiRouteCacheKey,
    fetchOverpass
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
    assert.equal(POI_CORRIDOR_BUFFER_M >= 2000 && POI_CORRIDOR_BUFFER_M <= 5000, true);
    assert.match(query, new RegExp('around:' + POI_CORRIDOR_BUFFER_M + ',50\\.4501,30\\.5234,49\\.8397,24\\.0297'));
    assert.equal(query.includes('around:' + POI_CORRIDOR_BUFFER_M + ',50.4501,30.5234);'), false);
    assert.match(query, /\["amenity"="fuel"\]/);
    assert.match(query, /\["amenity"="cafe"\]/);
    assert.match(query, /\["shop"="car_repair"\]/);
    assert.match(query, /\["highway"="rest_area"\]/);
    assert.equal(query.split('[out:json]').length - 1, 1);
    assert.equal((query.match(/around:/g) || []).length, 5);
    const cacheBeforeFetch = poiSource.indexOf('poiRouteCacheKey(points, types)');
    const fetchCall = poiSource.indexOf('fetchOverpass(overpassCorridorQuery');
    assert.equal(cacheBeforeFetch > 0 && fetchCall > cacheBeforeFetch, true);
    assert.equal(poiSource.split('fetchOverpass(overpassCorridorQuery').length - 1, 1);
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
    assert.match(poiSource, /code: 'OVERPASS_BUSY'/);
    assert.match(poiSource, /POI_CACHE_TTL_MS/);
});

test('overpass falls through mirrors on 429 and 504, then stops at three attempts', async () => {
    assert.deepEqual(OVERPASS_MIRRORS, [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter'
    ]);
    assert.deepEqual(OVERPASS_BACKOFF_MS, [1000, 3000]);
    assert.equal(OVERPASS_ATTEMPT_LIMIT, 3);
    assert.equal(OVERPASS_USER_AGENT, 'trip-control.com (support@trip-control.com)');
    assert.equal(POI_BUSY_MESSAGE, 'Сервіс карт перевантажений, спробуй за хвилину');

    const calls = [];
    const sleeps = [];
    const result = await fetchOverpass('[out:json];out;', {
        timeoutMs: 20,
        sleep: ms => {
            sleeps.push(ms);
            return Promise.resolve();
        },
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (calls.length === 1) return { ok: false, status: 429, json: async () => ({}) };
            if (calls.length === 2) return { ok: false, status: 504, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 1 }] }) };
        }
    });
    assert.deepEqual(sleeps, [1000, 3000]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.url), OVERPASS_MIRRORS);
    for (const call of calls) {
        assert.equal(call.init.headers['User-Agent'], OVERPASS_USER_AGENT);
        assert.equal(call.init.method, 'POST');
    }
    assert.equal(result.elements.length, 1);

    const extraCalls = [];
    const busy = await fetchOverpass('[out:json];out;', {
        timeoutMs: 20,
        mirrors: OVERPASS_MIRRORS.concat('https://example.test/api/interpreter'),
        sleep: () => Promise.resolve(),
        fetchImpl: async () => {
            extraCalls.push(1);
            return { ok: false, status: 429, json: async () => ({}) };
        }
    });
    assert.equal(extraCalls.length, 3);
    assert.equal(busy.error, 'overpass_busy');
    assert.equal(JSON.stringify(busy).includes('http'), false);
});

test('the page asks api/poi and does not send POI names through Places', () => {
    const search = sliceBetween(html, 'async function searchPOIsAlongRoute', 'function corridorSample');
    const marker = sliceBetween(html, 'function addPoiMarker', 'function isUiPreviewHostAllowed');
    assert.match(search, /fetch\('\/api\/poi'/);
    assert.match(search, /Сервіс карт перевантажений, спробуй за хвилину/);
    assert.equal(search.includes('відповів HTTP'), false);
    assert.equal(search.includes('overpass.kumi.systems'), false);
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
