import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    calcTripSheet, fuelNorm, tripSheetPayload, emptyTripSheet, tsFromPrefill, validateTripSheet, prefillSnapshot, changedPaths, setPath,
    localToIso, isoToLocal, tsSections, tsErrorText, closePayload, TS_REQUIRED,
} from '../src/lib/trip-sheet.js';

test('розрахунок: пробіг = спідометр повернення − виїзду; факт = залишок + видано − залишок повернення; норма з вантажем / порожнім', () => {
    const r = calcTripSheet({
        depart_odometer: 100000, return_odometer: 100500, depart_fuel_left: 80, fuel_issued: 200, return_fuel_left: 70,
        loaded_km: 300, fuel_load: 30, fuel_empty: 20,
    });
    assert.equal(r.distance_km, 500);
    assert.equal(r.fuel_actual, 210);
    assert.equal(r.fuel_norm, 130);
    assert.equal(r.fuel_diff, 80);
    assert.deepEqual(r.errors, {});
    const input = { depart_odometer: 0, return_odometer: 100, depart_fuel_left: 50, fuel_issued: 0, return_fuel_left: 30, fuel_load: 30, fuel_empty: 20 };
    const noLoaded = calcTripSheet(input);
    assert.equal(noLoaded.fuel_norm, null, 'без пробігу з вантажем норму не рахуємо (не весь пробіг за нормою завантаженого)');
    assert.equal(noLoaded.fuel_diff, null);
    assert.equal(noLoaded.fuel_actual, 20, 'фактична витрата рахується й без норми');
    const eco = calcTripSheet({ ...input, loaded_km: 100 });
    assert.equal(eco.fuel_norm, 30);
    assert.equal(eco.fuel_diff, -10, 'економія — від’ємна різниця');
    assert.equal(fuelNorm(100, null, 30, 20), null, 'порожній пробіг із вантажем → null');
    assert.equal(fuelNorm(100, 0, null, 20), 20, 'увесь пробіг порожнім — лише порожня норма');
    assert.equal(fuelNorm(100, 50, 30, null), null, 'немає потрібної норми → null');
});

test('розрахунок: спідометр назад і порожні поля — помилки', () => {
    assert.ok(calcTripSheet({ depart_odometer: 500, return_odometer: 400, depart_fuel_left: 1, return_fuel_left: 1 }).errors.return_odometer);
    assert.ok(calcTripSheet({ depart_odometer: 1, depart_fuel_left: 1 }).errors.return_odometer);
    assert.ok(calcTripSheet({ depart_odometer: 0, return_odometer: 10, depart_fuel_left: 5, fuel_issued: 0, return_fuel_left: 9 }).errors.return_fuel_left);
});

test('payload: лише ПІБ, посвідчення й табельний; жодних телефону, паспорта, ІПН, адреси; час із київським зсувом', () => {
    const d = emptyTripSheet('2026-10-28');
    Object.assign(d.driver, { id: 'drv', full_name: 'Іваненко І. І.', license_no: 'AB123456', phone: '+380', passport: 'AA111111', ipn: '1234567890', address: 'х' });
    Object.assign(d.vehicle, { make_model: 'DAF', reg_number: 'AA1111AA' });
    Object.assign(d.task, { route_from: 'Луцьк', route_to: 'Одеса', via: 'Рівне; Київ ', tonnage: '22,5' });
    Object.assign(d.depart, { at: '2026-10-28T06:00', odometer: '100000', fuel_left: '80' });
    const p = tripSheetPayload(d);
    assert.deepEqual(Object.keys(p.driver).sort(), ['full_name', 'id', 'license_no', 'tab_no']);
    assert.doesNotMatch(JSON.stringify(p), /380|AA111111|1234567890|"address"|phone|passport|ipn/);
    assert.deepEqual(p.task.via, ['Рівне', 'Київ']);
    assert.equal(p.task.tonnage, '22.5');
    assert.match(p.depart.at, /^2026-10-28T06:00:00\+0[23]:00$/);
    assert.equal(isoToLocal(p.depart.at), '2026-10-28T06:00');
    assert.equal(localToIso('2026-01-15T10:30'), '2026-01-15T10:30:00+02:00');
    assert.equal(p.depart.fuel_issued, '0');
    assert.equal(closePayload({ return_at: '2026-10-30T20:00', return_odometer: '100500', return_fuel_left: '70,5' }).return_fuel_left, '70.5');
});

test('валідація: обовʼязкові поля й числа', () => {
    const d = emptyTripSheet('2026-10-28');
    const errors = validateTripSheet(d);
    for (const path of TS_REQUIRED) assert.ok(errors[path], path);
    d.valid_to = '2026-10-27';
    assert.ok(validateTripSheet(d).valid_to);
    setPath(d, 'depart.odometer', '-5');
    assert.ok(validateTripSheet(d)['depart.odometer']);
});

test('префіл із заявки: маршрут, подача, ТЗ, причіп, водій, вантаж, строк із тривалості, план пального; ручна правка позначається', () => {
    const pre = {
        client: { id: 'c1', name: 'Агро', legal_name: 'ТОВ Агро' },
        route: { from: 'Луцьк', to: 'Одеса', base: 'Рівне', via: ['Київ'], dist_km: 500, feed_km: 40 },
        vehicle_id: 'v1', vehicle: { make_model: 'DAF', reg_number: 'AA1111AA', fuel_load: 30, fuel_empty: 20 },
        trailer_id: 't1', trailer: { plate: 'AA2222XX', make_model: 'Schmitz' },
        driver: { id: 'd1', full_name: 'Петренко П. П.', license_no: 'BB654321' },
        cargo: { tonnage: 22 }, dates: { trip_date: '2026-10-28', days: 2.4 }, plan_fuel_l: 258,
    };
    const d = tsFromPrefill(pre, '2026-10-28');
    assert.equal(d.task.customer, 'ТОВ Агро');
    assert.equal(d.task.route_from, 'Луцьк');
    assert.equal(d.task.feed_point, 'Рівне');
    assert.equal(d.task.via, 'Київ');
    assert.equal(d.task.loaded_km, '500');
    assert.equal(d.valid_from, '2026-10-28');
    assert.equal(d.valid_to, '2026-10-30', '2,4 дні → 3 доби: 28–30');
    assert.equal(d.vehicle.trailer_reg_number, 'AA2222XX');
    assert.equal(d.driver.full_name, 'Петренко П. П.');
    assert.equal(d.depart.fuel_issued, '258');
    const paths = ['task.route_from', 'task.route_to', 'vehicle.reg_number', 'depart.fuel_issued'];
    const snap = prefillSnapshot(d, paths);
    assert.deepEqual(changedPaths(d, snap), []);
    setPath(d, 'task.route_to', 'Миколаїв');
    assert.deepEqual(changedPaths(d, snap), ['task.route_to'], 'змінене вручну поле видно');
    assert.equal(tsFromPrefill(null, '2026-10-28').task.route_from, '');
});

test('розділи картки / PDF / Excel: Шапка, ТЗ і водій, Завдання, Виїзд, Повернення, Розрахунок; без персональних даних', () => {
    const doc = {
        number: 3, prefix: 'ПЛ-', doc_date: '2026-10-28', valid_from: '2026-10-28', valid_to: '2026-10-30', status: 'closed',
        carrier: { name: 'ТОВ П', code: '123' }, driver: { full_name: 'Іваненко', license_no: 'AB1' },
        vehicle: { make_model: 'DAF', reg_number: 'AA1', trailer_reg_number: 'AA2' }, task: { route_from: 'A', route_to: 'B', via: ['X'], tonnage: 22 },
        depart_at: '2026-10-28T03:00:00Z', depart_odometer: 100, depart_fuel_left: 80, fuel_issued: 200, fuel_kind: 'ДП',
        return_at: '2026-10-30T17:00:00Z', return_odometer: 600, return_fuel_left: 70, distance_km: 500, fuel_actual: 210, fuel_norm: 130, fuel_diff: 80,
    };
    const sections = tsSections(doc);
    assert.deepEqual(sections.map((s) => s.title), ['Шапка', 'ТЗ і водій', 'Завдання', 'Виїзд', 'Повернення', 'Розрахунок']);
    const text = JSON.stringify(sections);
    assert.match(text, /\+80/);
    assert.match(text, /перевитрата/);
    assert.doesNotMatch(text, /phone|passport|ipn|address|телефон|паспорт/i);
    assert.deepEqual(tsSections({ ...doc, status: 'issued' }).at(-1).rows, [['Розрахунок', 'Після закриття листа']]);
});

test('помилки: людські тексти', () => {
    assert.match(tsErrorText({ message: 'CALC_NOT_ACCEPTED' }), /прийміть заявку/);
    assert.match(tsErrorText({ message: 'TS_FIELD_REQUIRED:depart.odometer' }), /Виїзд: спідометр.*обовʼязково/);
    assert.match(tsErrorText({ message: 'TS_ODOMETER_DECREASE' }), /Спідометр/);
});
