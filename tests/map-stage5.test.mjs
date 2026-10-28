import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.equal(from >= 0, true, start);
    assert.equal(to > from, true, end);
    return source.slice(from, to);
}

test('route renderers hide Google markers and the main line is drawn from the same response', () => {
    const init = sliceBetween(html, 'async function initMap()', 'async function createAddressAutocomplete');
    assert.equal(init.includes('suppressMarkers: false'), false);
    assert.equal((init.match(/suppressMarkers: true/g) || []).length, 2);
    assert.match(init, /suppressPolylines: true/);

    const paint = sliceBetween(html, 'function paintRouteOverlays()', 'function shortPlace(');
    assert.match(paint, /clearRouteOverlays\(\)/);
    assert.match(paint, /new google\.maps\.Polyline/);
    assert.match(paint, /repeat: '12px'/);
    assert.match(paint, /pin\('П', pal\.teal/);
    assert.match(paint, /pin\('A', pal\.accent/);
    assert.match(paint, /pin\('B', pal\.accent/);
    assert.equal(paint.includes('directionsService'), false);

    const palette = sliceBetween(html, 'function tcMapPalette()', 'function tcMapDotIcon(');
    ['#2F8F86', '#4FD1C5', '#0D2A29', '#F4EFE5', '#7C9CFF', '#0B0E14'].forEach(function (hex) {
        assert.ok(palette.includes(hex), hex);
    });
});

test('markers repaint on route, variant and theme changes without touching the km logic', () => {
    const apply = sliceBetween(html, 'function applyMainRoute(', 'function calculateBackhaulRoute()');
    assert.match(apply, /km: podachaKm \+ mainKm/);
    assert.match(apply, /paintRouteOverlays\(\)/);
    assert.match(apply, /podachaKm = Math\.round\(\(\(legs\[0\]\.distance && legs\[0\]\.distance\.value\) \|\| 0\) \/ 1000\)/);
    assert.match(sliceBetween(html, 'function calculateBackhaulRoute()', 'function clearPOIMarkers()'), /backhaulRouteView = response;/);
    assert.match(sliceBetween(html, 'function applyMapTheme()', 'const studioMarks'), /paintRouteOverlays\(\)/);
});

test('map shows the route label, a theme legend and the OSM layer panel', () => {
    assert.match(html, /id="map-route-label"/);
    assert.match(html, /\.tc-map-route-label \.rl-path \{ min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
    assert.match(html, /\.tc-map-legend \.lg-main \{ background: var\(--accent\); \}/);
    assert.equal(html.includes('.lg-main { background: #7dd3fc; }'), false);
    assert.match(html, /<div class="tc-map-legend" id="map-legend" hidden>/);

    const panel = sliceBetween(html, 'id="map-poi-panel"', '<div class="tc-map-foot">');
    ['poi-gas', 'poi-tir', 'poi-cafe', 'poi-sto', 'poi-results', 'poi-status', 'poi-attribution'].forEach(function (id) {
        assert.equal(html.split('id="' + id + '"').length, 2, id);
        assert.ok(panel.includes('id="' + id + '"'), id);
    });
    assert.match(panel, /onclick="searchPOIsAlongRoute\(\)"/);
    assert.equal(html.includes('class="poi-box'), false);

    const marker = sliceBetween(html, 'function addPoiMarker', 'function isUiPreviewHostAllowed');
    assert.equal(marker.includes('#1e293b'), false);
    assert.match(marker, /tcMapDotIcon\(26/);
});

test('a new main route drops the old backhaul line, its stops and the legend', () => {
    const build = sliceBetween(html, '(async function runSegments()', 'function routeMeters(');
    const clearAt = build.indexOf('clearBackhaulRoute();');
    assert.ok(clearAt !== -1 && clearAt < build.indexOf('applyMainRoute('));
    assert.equal(sliceBetween(html, 'function selectRouteAlternative(', 'function applyMainRoute(').includes('clearBackhaulRoute'), false);

    const ctx = { backhaulRouteView: { routes: [{ legs: [] }] }, painted: 0, cleared: [] };
    ctx.directionsRendererBackhaul = { set: function (key, value) { ctx.cleared.push([key, value]); } };
    ctx.paintRouteOverlays = function () { ctx.painted += 1; };
    vm.runInNewContext(sliceBetween(html, 'function clearBackhaulRoute()', 'function shortPlace(') + '\nclearBackhaulRoute();', ctx);
    assert.equal(ctx.backhaulRouteView, null);
    assert.deepEqual(ctx.cleared, [['directions', null]]);
    assert.equal(ctx.painted, 1);

    const paint = sliceBetween(html, 'function paintRouteOverlays()', 'function clearBackhaulRoute()');
    assert.match(paint, /legend\.hidden = !backRoute/);
    assert.match(html, /\.tc-map-poi-panel \.btn \{ min-height: 40px; \}/);
});
