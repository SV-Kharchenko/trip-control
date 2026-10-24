import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gpsAccess } from '../src/lib/gate.js';
import { parseCrmHash, tabOf } from '../src/lib/route.js';
import { errorText } from '../src/lib/errors.js';
import { gpsStatusLabel, minutesAgo, vehicleOptions, tokenLink, GPS_REGIONS, TOKEN_FORM_HINT } from '../src/views/gps.js';

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
