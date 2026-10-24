import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gpsAccess } from '../src/lib/gate.js';
import { parseCrmHash, tabOf } from '../src/lib/route.js';
import { errorText } from '../src/lib/errors.js';
import { gpsStatusLabel, minutesAgo, vehicleOptions, tokenLink, GPS_REGIONS, TOKEN_FORM_HINT } from '../src/views/gps.js';
import {
    formatKyivDateTime, formatKyivTime, minutesAgoText, speedText, sortMapVehicles, orderText, mapStateNotice, refreshStatusText,
    mapSectionVisible, hasCoords, OSM_TILES, OSM_ATTRIBUTION,
} from '../src/views/gps-map.js';

test('GPS tab: visible to every role on control_plus, hidden for company plan / no context', () => {
    assert.deepEqual(gpsAccess({ control_plus: true, role: 'owner' }), { visible: true, canManage: true, seesIntegration: true });
    assert.deepEqual(gpsAccess({ control_plus: true, role: 'director' }), { visible: true, canManage: false, seesIntegration: true });
    assert.deepEqual(gpsAccess({ control_plus: true, role: 'logist' }), { visible: true, canManage: false, seesIntegration: false });
    for (const ctx of [null, undefined, { control_plus: false, role: 'owner' }, { control_plus: 'true', role: 'owner' }]) {
        assert.deepEqual(gpsAccess(ctx), { visible: false, canManage: false, seesIntegration: false });
    }
});

test('route #/gps', () => {
    assert.deepEqual(parseCrmHash('#/gps'), { view: 'gps' });
    assert.equal(tabOf({ view: 'gps' }), 'gps');
    assert.equal(parseCrmHash('#/gps/x'), null);
    assert.equal(tabOf(parseCrmHash('#/report')), 'report');
    assert.equal(tabOf(parseCrmHash('#/clients/abc')), 'clients');
});

test('mapping options: current vehicle + free vehicles only', () => {
    const units = [{ id: 'u1', vehicle_id: 'v1' }, { id: 'u2', vehicle_id: null }, { id: 'u3', vehicle_id: 'v3' }];
    const fleet = [{ id: 'v1', label: 'A' }, { id: 'v2', label: 'B' }, { id: 'v3', label: 'C' }];
    assert.deepEqual(vehicleOptions(units, fleet, 'u1').map((v) => v.id), ['v1', 'v2']);
    assert.deepEqual(vehicleOptions(units, fleet, 'u2').map((v) => v.id), ['v2']);
});

test('status labels, relative time, regions', () => {
    assert.equal(gpsStatusLabel('active'), 'Підключено');
    assert.equal(gpsStatusLabel('error_auth'), 'Немає доступу (токен)');
    assert.equal(gpsStatusLabel('weird'), 'Невідомо');
    const now = Date.parse('2026-10-24T10:00:00Z');
    assert.equal(minutesAgo('2026-10-24T09:59:40Z', now), 'щойно');
    assert.equal(minutesAgo('2026-10-24T09:45:00Z', now), '15 хв тому');
    assert.equal(minutesAgo('2026-10-24T07:00:00Z', now), '3 год тому');
    assert.equal(minutesAgo(null, now), '—');
    assert.deepEqual(GPS_REGIONS.map((r) => r.value), ['com', 'eu', 'us', 'org']);
});

test('token link: hosting / local origin, access_type=256, never contains a token', () => {
    const hosting = tokenLink({ kind: 'hosting', login: 'viewer' });
    assert.match(hosting, /^https:\/\/hosting\.wialon\.com\/login\.html\?/);
    assert.match(hosting, /access_type=256/);
    assert.match(hosting, /user=viewer/);
    assert.match(tokenLink({ kind: 'local', localUrl: 'https://gps.fleet.ua/x?y=1' }), /^https:\/\/gps\.fleet\.ua\/login\.html\?/);
    assert.match(tokenLink({ kind: 'local', localUrl: 'http://gps.fleet.ua' }), /^https:\/\/<ваш-сервер-wialon>\/login/);
    assert.equal(/access_token|token=/.test(hosting), false);
    // Документація Wialon не дає окремих адрес форми для .eu / .us / .org — посилання одне, і це сказано прямо.
    assert.equal(tokenLink({ kind: 'hosting', region: 'us' }), tokenLink({ kind: 'hosting', region: 'eu' }));
    assert.match(TOKEN_FORM_HINT, /hosting\.wialon\.com для всіх серверів API/);
    assert.equal(/hosting\.wialon\.(us|eu|org)/.test(fs.readFileSync(new URL('../src/views/gps.js', import.meta.url), 'utf8')), false, 'no invented form URLs');
});

test('a pending integration without a token (failed attempt trace) shows the connect form, not the card', () => {
    const src = fs.readFileSync(new URL('../src/views/gps.js', import.meta.url), 'utf8');
    assert.match(src, /if \(!it \|\| it\.status === 'disabled' \|\| \(it\.status === 'pending' && !it\.token_hint\)\) \{/);
});

test('GPS errors from the database → Ukrainian text', () => {
    assert.match(errorText({ message: 'GPS_VEHICLE_TAKEN' }), /вже привʼязане/);
    assert.match(errorText({ message: 'GPS_MAP_FORBIDDEN' }), /лише власник/);
    assert.match(errorText({ message: 'GPS_VEHICLE_NOT_FOUND' }), /не знайдено/);
});

test('GPS view: token field is a password without autocomplete, cleared after submit; no storage, no innerHTML, no dialogs', () => {
    const src = fs.readFileSync(new URL('../src/views/gps.js', import.meta.url), 'utf8');
    assert.match(src, /id: 'gps-token', type: 'password', autocomplete: 'off'/);
    assert.match(src, /token\.value = '';/);
    assert.match(src, /body\.token = null;/);
    assert.equal(/localStorage|sessionStorage|indexedDB|innerHTML|window\.(alert|confirm|prompt)|console\./.test(src), false);
});

test('map: Kyiv time formatting (summer / winter, near midnight)', () => {
    assert.equal(formatKyivDateTime('2026-10-23T21:30:00Z'), '00:30 24.10');
    assert.equal(formatKyivDateTime('2026-12-31T22:05:00Z'), '00:05 01.01');
    assert.equal(formatKyivTime('2026-10-24T06:07:00Z'), '09:07');
    assert.equal(formatKyivDateTime(null), '—');
    const now = Date.parse('2026-10-24T10:00:00Z');
    assert.equal(minutesAgoText('2026-10-24T09:59:30Z', now), 'щойно');
    assert.equal(minutesAgoText('2026-10-24T09:29:00Z', now), '31 хв тому');
    assert.equal(minutesAgoText('2026-10-24T05:00:00Z', now), '5 год тому');
    assert.equal(speedText(71.6), '72 км/год');
    assert.equal(speedText(null), '—');
});

test('map: list sorted — with signal first, then by plate (natural); no coordinates after', () => {
    const list = sortMapVehicles([
        { plate: 'AA10', no_signal: false, lat: 1, lon: 1 },
        { plate: 'AA2', no_signal: true, lat: 1, lon: 1 },
        { plate: 'AA9', no_signal: false, lat: 1, lon: 1 },
        { plate: 'AA1', no_signal: true, lat: null, lon: null },
        { plate: 'AA3', no_signal: true, lat: 1, lon: 1 },
    ]);
    assert.deepEqual(list.map((v) => v.plate), ['AA9', 'AA10', 'AA2', 'AA3', 'AA1']);
    assert.equal(hasCoords({ lat: 0, lon: 0 }), true);
    assert.equal(hasCoords({ lat: null, lon: 1 }), false);
});

test('map: order text, state notices by role, refresh status', () => {
    assert.equal(orderText(null), 'без активної заявки');
    assert.equal(orderText({ trip_date: '2026-10-23', route_from: 'Київ', route_to: 'Одеса', client_name: 'Агро' }), '23.10 · Київ → Одеса · Агро');
    assert.equal(orderText({ trip_date: '2026-10-23' }), '23.10 · маршрут не вказано');
    assert.deepEqual(mapStateNotice({ status: 'not_connected', vehicles: [], canManage: true }),
        { kind: 'info', text: 'GPS ще не підключено. Підключіть Wialon у формі нижче.', action: 'connect' });
    assert.equal(mapStateNotice({ status: 'not_connected', vehicles: [], canManage: false }).text, 'GPS ще не підключено. Попросіть власника підключити GPS.');
    assert.match(mapStateNotice({ status: 'error_auth', vehicles: [{}], canManage: false }).text, /Попросіть власника оновити токен/);
    assert.match(mapStateNotice({ status: 'active', vehicles: [], canManage: true }).text, /Привʼяжіть юніти/);
    assert.equal(mapStateNotice({ status: 'active', vehicles: [], canManage: false }).text, 'Немає привʼязаних авто.');
    assert.match(mapStateNotice({ status: 'active', vehicles: [{ lat: null, lon: null }] }).text, /Натисніть «Оновити»/);
    assert.match(mapStateNotice({ status: 'active', vehicles: [{ lat: 1, lon: 1 }], refreshError: 'Wialon тимчасово обмежив запити.' }).text, /Показано останні відомі дані/);
    assert.equal(mapStateNotice({ status: 'active', vehicles: [{ lat: 1, lon: 1 }] }), null);
    assert.equal(mapStateNotice({ networkError: true }).kind, 'error');
    const now = Date.parse('2026-10-24T06:07:00Z');
    assert.equal(refreshStatusText({ refreshed: true }, now), 'Оновлено 09:07');
    assert.equal(refreshStatusText({ refreshed: false, next_refresh_at: '2026-10-24T06:07:42Z' }, now), 'Наступне оновлення через 42 с');
    assert.equal(refreshStatusText({ refreshed: false, next_refresh_at: null }, now), '');
});

test('map: visible to every role on control_plus only; tiles and attribution as required', () => {
    for (const role of ['owner', 'director', 'logist', 'other']) assert.equal(mapSectionVisible({ control_plus: true, role }), true, role);
    assert.equal(mapSectionVisible({ control_plus: false, role: 'owner' }), false);
    assert.equal(mapSectionVisible(null), false);
    assert.equal(OSM_TILES, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.match(OSM_ATTRIBUTION, /href="https:\/\/www\.openstreetmap\.org\/copyright"/);
    assert.match(OSM_ATTRIBUTION, /OpenStreetMap<\/a> contributors/);
});

test('map view: Leaflet only via dynamic import, removed on leave; divIcon markers; no innerHTML / storage / CDN', () => {
    const src = fs.readFileSync(new URL('../src/views/gps-map.js', import.meta.url), 'utf8');
    assert.match(src, /import\('leaflet'\)/);
    assert.match(src, /import\('leaflet\/dist\/leaflet\.css'\)/);
    assert.equal(/^import .*leaflet/m.test(src), false, 'no static import of Leaflet');
    assert.match(src, /app\.onCleanup\(/);
    assert.match(src, /state\.map\.remove\(\)/);
    assert.match(src, /L\.divIcon\(/);
    assert.match(src, /maxZoom: MAX_ZOOM/);
    assert.equal(/innerHTML|localStorage|sessionStorage|unpkg|jsdelivr|cdnjs|marker-icon\.png|L\.icon\(/.test(src), false);
    const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    assert.match(bridge, /function leave\(\) \{\r?\n {4}runCleanups\(\);/);
});
