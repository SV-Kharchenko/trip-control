import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kyivDate, addDays, tripDuration, inOrderWindow, currentOrder, isNoSignal, NO_SIGNAL_MIN, buildMapVehicles, readMap } from '../lib/gps/map.js';

const o = (extra) => ({ calculation_id: 'c1', status: 'accepted', trip_date: '2026-10-20', trip_days: 2, route_from: 'Київ', route_to: 'Одеса', client_name: 'Агро', ...extra });

test('Kyiv date near UTC midnight; addDays across months', () => {
    assert.equal(kyivDate(new Date('2026-10-23T21:30:00Z')), '2026-10-24', 'Kyiv is UTC+3 in October: already the next day');
    assert.equal(kyivDate(new Date('2026-10-23T20:59:00Z')), '2026-10-23');
    assert.equal(kyivDate(new Date('2026-12-31T22:00:00Z')), '2027-01-01', 'UTC+2 in winter');
    assert.equal(kyivDate(new Date('2026-12-31T21:59:00Z')), '2026-12-31');
    assert.equal(addDays('2026-10-30', 3), '2026-11-02');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('duration: ceil(trip_days), null / 0 / negative / garbage → 1 day', () => {
    assert.equal(tripDuration(2), 2);
    assert.equal(tripDuration(2.1), 3);
    assert.equal(tripDuration('1.5'), 2);
    for (const bad of [null, undefined, 0, -3, '', 'abc']) assert.equal(tripDuration(bad), 1, String(bad));
});

test('window: from trip_date to trip_date + duration + 1 spare day (exclusive)', () => {
    const order = o({ trip_date: '2026-10-20', trip_days: 2 }); // 20, 21 + запас 22; 23 — вже ні
    assert.equal(inOrderWindow(order, '2026-10-19'), false, 'before the first day');
    assert.equal(inOrderWindow(order, '2026-10-20'), true, 'first day');
    assert.equal(inOrderWindow(order, '2026-10-21'), true);
    assert.equal(inOrderWindow(order, '2026-10-22'), true, 'last day + 1 spare day');
    assert.equal(inOrderWindow(order, '2026-10-23'), false, 'next day — no longer');
    assert.equal(inOrderWindow(o({ trip_days: 1.2 }), '2026-10-22'), true, 'fractional → 2 days + spare');
    assert.equal(inOrderWindow(o({ trip_days: 1.2 }), '2026-10-23'), false);
    for (const days of [null, 0]) {
        assert.equal(inOrderWindow(o({ trip_days: days }), '2026-10-21'), true, 'null / 0 → 1 day + spare');
        assert.equal(inOrderWindow(o({ trip_days: days }), '2026-10-22'), false);
    }
    assert.equal(inOrderWindow(o({ trip_date: null }), '2026-10-20'), false);
});

test('only accepted is current; done inside the window is NOT current and not counted', () => {
    const today = '2026-10-21';
    for (const status of ['draft', 'proposed', 'rejected', 'done']) {
        assert.deepEqual(currentOrder([o({ status })], today), { order: null, more_orders: 0 }, status);
    }
    const out = currentOrder([o({ calculation_id: 'done-1', status: 'done', trip_date: '2026-10-21' }), o({ calculation_id: 'acc-1' })], today);
    assert.equal(out.order.calculation_id, 'acc-1');
    assert.equal(out.more_orders, 0, 'done is not in more_orders');
});

test('several orders: the latest already started is current, the rest — more_orders', () => {
    const today = '2026-10-22';
    const out = currentOrder([
        o({ calculation_id: 'a', trip_date: '2026-10-20', trip_days: 3 }),
        o({ calculation_id: 'b', trip_date: '2026-10-22', trip_days: 1, route_from: 'Львів', route_to: 'Рені', client_name: 'Зерно' }),
        o({ calculation_id: 'c', trip_date: '2026-10-21', trip_days: 1 }),
        o({ calculation_id: 'future', trip_date: '2026-10-23' }),
        o({ calculation_id: 'old', trip_date: '2026-10-01', trip_days: 1 }),
    ], today);
    assert.deepEqual(out, {
        order: { calculation_id: 'b', trip_date: '2026-10-22', route_from: 'Львів', route_to: 'Рені', client_name: 'Зерно' },
        more_orders: 2,
    });
    assert.equal('hidden' in out.order, false);
    assert.equal('status' in out.order, false);
});

test('no_signal: 29 / 30 min — signal, 31 min and null — no signal', () => {
    const now = new Date('2026-10-24T10:00:00Z');
    const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();
    assert.equal(NO_SIGNAL_MIN, 30);
    assert.equal(isNoSignal(ago(29), now), false);
    assert.equal(isNoSignal(ago(30), now), false);
    assert.equal(isNoSignal(ago(31), now), true);
    assert.equal(isNoSignal(null, now), true);
    assert.equal(isNoSignal('garbage', now), true);
});

test('map vehicles: only mapped active units; no external_id / api_host / token; no hidden field', () => {
    const now = new Date('2026-10-21T09:00:00Z');
    const units = [
        { id: 'g1', name: 'Unit 1', vehicle_id: 'v1', external_id: '101', active: true, last_pos_at: '2026-10-21T08:50:00Z', last_lat: 50.45, last_lon: 30.52, last_speed: 72, last_course: 90 },
        { id: 'g2', name: 'Unit 2', vehicle_id: null, external_id: '102', active: true },
        { id: 'g3', name: 'Unit 3', vehicle_id: 'v3', external_id: '103', active: false },
        { id: 'g4', name: 'Unit 4', vehicle_id: 'v4', external_id: '104', active: true, last_pos_at: null, last_lat: null, last_lon: 30 },
    ];
    const fleet = [{ id: 'v1', label: 'AA1111AA' }, { id: 'v4', label: 'BB2222BB' }];
    const orders = [{ vehicle_id: 'v1', ...o({ calculation_id: 'x' }) }];
    const out = buildMapVehicles(units, fleet, orders, now);
    assert.deepEqual(out.map((v) => v.gps_vehicle_id), ['g1', 'g4']);
    assert.deepEqual(Object.keys(out[0]).sort(), ['course', 'gps_vehicle_id', 'last_pos_at', 'lat', 'lon', 'more_orders', 'no_signal', 'order',
        'plate', 'speed', 'unit_name', 'vehicle_id']);
    assert.equal(out[0].plate, 'AA1111AA');
    assert.equal(out[0].no_signal, false);
    assert.equal(out[0].order.calculation_id, 'x');
    assert.deepEqual([out[1].lat, out[1].lon, out[1].no_signal, out[1].order], [null, null, true, null], 'half coordinates → no coordinates');
    assert.equal(/external_id|api_host|token|hidden/.test(JSON.stringify(out)), false);
});

test('readMap: orders of every logist are shown in full to every role; another org never leaks (filters go to the store)', async () => {
    const calls = [];
    const store = {
        async mappedUnits(org) { calls.push(['units', org]); return org === 'A' ? [{ id: 'g1', name: 'U', vehicle_id: 'v1', external_id: '1', active: true }] : []; },
        async fleetVehicles(org) { calls.push(['fleet', org]); return [{ id: 'v1', label: 'AA' }]; },
        async currentOrders(org, ids, today) {
            calls.push(['orders', org, ids, today]);
            // Заявка іншого логіста (автор не той, хто дивиться) — без маскування.
            return [{ vehicle_id: 'v1', calculation_id: 'other-logist', status: 'accepted', trip_date: today, trip_days: 1, route_from: 'A', route_to: 'B', client_name: 'C' }];
        },
    };
    const out = await readMap(store, 'A', new Date('2026-10-24T09:00:00Z'));
    assert.deepEqual(out[0].order, { calculation_id: 'other-logist', trip_date: '2026-10-24', route_from: 'A', route_to: 'B', client_name: 'C' });
    assert.deepEqual(calls.filter((c) => c[1] !== 'A'), [], 'every query is filtered by the caller org');
    assert.deepEqual(calls.find((c) => c[0] === 'orders'), ['orders', 'A', ['v1'], '2026-10-24']);
    assert.deepEqual(await readMap(store, 'B', new Date()), [], 'no units → no order query');
});
