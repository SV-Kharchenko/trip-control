import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261013100000_poi_cache.sql', import.meta.url), 'utf8');
const {
    POI_CORRIDOR_BUFFER_M,
    POI_CACHE_TTL_MS,
    geohashEncode,
    corridorSegmentKeys,
    poiCacheFresh,
    overpassCorridorQuery,
    normalizePoiElement,
    nearestSegmentKey
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

test('the page asks api/poi and does not send POI names through Places', () => {
    const search = sliceBetween(html, 'async function searchPOIsAlongRoute', 'function corridorSample');
    const marker = sliceBetween(html, 'function addPoiMarker', 'function isUiPreviewHostAllowed');
    assert.match(search, /fetch\('\/api\/poi'/);
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
