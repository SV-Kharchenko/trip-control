// Тара й макс. маса причепа: поля картки, підказка «вантажопідйомність = макс. маса − тара», маса автопоїзда в ТТН, друк.
// Усі дані вигадані. Серверна частина (міграція, kp_ttn_create / kp_ttn_prefill) — supabase/tests/kp_trailer_masses.sql (check:db).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trainMasses, totalMass, massWarning, validateTtn, TTN_MASS_MAX_T } from '../src/lib/ttn.js';
import { validateTrailerMasses, trailerCapacityNote } from '../src/lib/fleet.js';
import { TRAILER_FIELDS } from '../src/lib/registry.js';
import { frontFields, vehicleParams } from '../src/lib/ttn-text.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../../../supabase/migrations/20261125090000_trailer_tare_masses.sql', import.meta.url), 'utf8');

const CAR = { tare_t: 6.7, max_mass_t: 17.2 };
// Картка причепа в тому вигляді, як її повертає kp_trailers_list (numeric приходить числом або рядком).
const TRAILER = { id: 't1', plate: 'AA 2222 XT', capacity_t: 22.8, tare_t: '7.300', max_mass_t: '30.000', active: true };

test('картка причепа: «Тара» і «Макс. дозволена маса» у блоці «Для ТТН» після обʼєму', () => {
    const keys = TRAILER_FIELDS.map((f) => f.key || 'section:' + f.section);
    assert.deepEqual(keys.slice(keys.indexOf('volume_m3')), ['volume_m3', 'section:Для ТТН', 'tare_t', 'max_mass_t', 'section:Строки ТО й страхування', 'oscpv_on', 'kasko_on', 'green_card_on']);
    for (const key of ['tare_t', 'max_mass_t']) {
        const f = TRAILER_FIELDS.find((x) => x.key === key);
        assert.equal(f.suffix, 'т');
        assert.ok(!f.owner, 'логіст з правом «Автопарк» теж редагує ТТН-поля причепа');
    }
});

test('картка причепа: тара й макс. маса — 0 < x ≤ 100 т, макс. маса не менша за тару', () => {
    assert.deepEqual(validateTrailerMasses({ tare_t: '7,3', max_mass_t: '30' }), { data: { tare_t: 7.3, max_mass_t: 30 }, errors: {} });
    assert.deepEqual(validateTrailerMasses({ tare_t: '', max_mass_t: '' }), { data: { tare_t: null, max_mass_t: null }, errors: {} });
    assert.equal(validateTrailerMasses({ tare_t: '0', max_mass_t: '' }).errors.tare_t, 'Більше 0, до 100 т');
    assert.equal(validateTrailerMasses({ tare_t: '', max_mass_t: '101' }).errors.max_mass_t, 'Більше 0, до 100 т');
    assert.equal(validateTrailerMasses({ tare_t: 'abc', max_mass_t: '' }).errors.tare_t, 'Більше 0, до 100 т');
    assert.equal(validateTrailerMasses({ tare_t: '9', max_mass_t: '8' }).errors.max_mass_t, 'Макс. маса не може бути меншою за тару');
    assert.deepEqual(validateTrailerMasses({ tare_t: '8', max_mass_t: '8' }).errors, {}, 'рівні — можна (як CHECK у БД)');
});

test('картка причепа: підказка = макс. маса − тара, попередження при розбіжності з вантажопідйомністю більше 0,5 т', () => {
    assert.deepEqual(trailerCapacityNote('', '', ''), { calc: null, text: 'Вантажопідйомність = макс. маса − тара.', warning: '' });
    assert.equal(trailerCapacityNote('7,3', '', '').calc, null);
    assert.equal(trailerCapacityNote('9', '8', '').calc, null, 'макс. менша за тару — розрахунку немає');
    const ok = trailerCapacityNote('7,3', '30', '22,7');
    assert.equal(ok.calc, 22.7);
    assert.equal(ok.text, 'Вантажопідйомність = макс. маса − тара: 22,7 т.');
    assert.equal(ok.warning, '');
    assert.equal(trailerCapacityNote('7,3', '30', '23,2').warning, '', 'рівно 0,5 т — ще можна');
    assert.notEqual(trailerCapacityNote('7,3', '30', '22,1').warning, '', '22,7 − 22,1 = 0,6 т — вже більше допуску');
});

test('картка причепа: попередження розбіжності містить обидва значення; без вантажопідйомності — без попередження', () => {
    const n = trailerCapacityNote('7,3', '30', '25');
    assert.match(n.warning, /Вантажопідйомність причепа \(25 т\) розходиться з розрахунковою \(22,7 т\) більше ніж на 0,5 т/);
    assert.equal(trailerCapacityNote('7,3', '30', '').warning, '');
    assert.equal(trailerCapacityNote('0,1', '0,3', '0,2').calc, 0.2, 'кілограми цілими: 0,3 − 0,1 = 0,2 без float-хвоста');
});

test('картка причепа: форма зберігає tare_t і max_mass_t через kp_trailer_save і малює підказку на input', () => {
    const fleet = read('src/views/fleet.js');
    assert.match(fleet, /validateTrailerMasses\(values\)/);
    assert.match(fleet, /p_data: \{ make_model: make, capacity_t: cap, volume_m3: vol, tare_t: masses\.data\.tare_t, max_mass_t: masses\.data\.max_mass_t \}/);
    assert.match(fleet, /for \(const key of \['tare_t', 'max_mass_t', 'capacity_t'\]\) fields\[key\]\.input\.addEventListener\('input', paintMassNote\)/);
    assert.match(fleet, /trailerCapacityNote\(fields\.tare_t\.input\.value, fields\.max_mass_t\.input\.value, fields\.capacity_t\.input\.value\)/);
});

test('ТТН: тара автопоїзда = авто + причіп з картки, макс. маса так само, без причепа — лише авто', () => {
    const m = trainMasses(CAR, TRAILER, true);
    assert.equal(m.tare, 14);
    assert.equal(m.max, 47.2);
    assert.equal(m.tareHint, 'Авто 6,7 т + причіп 7,3 т');
    assert.equal(m.maxHint, 'Авто 17,2 т + причіп 30 т');
    assert.equal(m.warning, '');
    const solo = trainMasses(CAR, TRAILER, false);
    assert.deepEqual([solo.tare, solo.max, solo.warning], [6.7, 17.2, '']);
});

test('ТТН: попередження «немає маси причепа в картці» — лише коли причіп є, а в його картці порожньо', () => {
    for (const card of [{ ...TRAILER, tare_t: null }, { ...TRAILER, max_mass_t: null }, { plate: 'AA 2222 XT' }]) {
        assert.equal(trainMasses(CAR, card, true).warning, 'немає маси причепа в картці');
    }
    assert.equal(trainMasses(CAR, { plate: 'AA 2222 XT' }, false).warning, '', 'причепа в ТТН немає — попередження немає');
    assert.equal(trainMasses(CAR, TRAILER, true).warning, '');
});

test('ТТН: суми в кілограмах без float-похибок (0,1 + 0,2; 6,7 + 7,3); загальна маса = тара автопоїзда + брутто', () => {
    assert.equal(trainMasses({ tare_t: 0.1, max_mass_t: 1 }, { tare_t: '0.200', max_mass_t: '1.000' }, true).tare, 0.3);
    const m = trainMasses(CAR, TRAILER, true);
    assert.equal(totalMass(m.tare, 24.09), 38.09);
    assert.equal(totalMass(m.tare, '24,09'), 38.09);
    assert.equal(totalMass(0.1 + 0.2, 0.1), 0.4);
});

test('ТТН: перевантаження (загальна маса більша за макс.) — попередження, а не помилка форми', () => {
    const m = trainMasses(CAR, TRAILER, true);
    assert.equal(massWarning(m.tare, 24.09, m.max), null);
    assert.match(massWarning(m.tare, 34, m.max), /Загальна маса 48 т більша за максимально дозволену 47,2 т/);
    const form = {
        place_of_issue: 'м. Київ', shipper: { name: 'А', code: '34567812' }, consignee: { name: 'Б', code: '45678123' },
        driver: { full_name: 'Водій', license_no: 'ABC1' },
        vehicle: { make_model: 'DAF', type: 'Тягач', reg_number: 'AA1111TT', length_m: 16, width_m: 2.5, height_m: 4 },
        tare_t: m.tare, max_mass_t: m.max, cargo_gross_t: 34, load_point: 'А', unload_point: 'Б', lines: [{ cargo_name: 'Пшениця', gross_t: 34 }],
    };
    assert.equal(validateTtn(form).tare_t, undefined);
    assert.equal(validateTtn(form).cargo_gross_t, undefined, 'перевантаження не блокує створення');
});

test('друк PDF / Excel (frontFields) показує суми зі збереженої ТТН: тара автопоїзда й загальна маса з вантажем', () => {
    // Знімок ТТН, як його зберіг сервер: tare = 6,7 + 7,3, total = tare + брутто 24,09.
    const doc = { vehicle: { length_m: 16.5, width_m: 2.55, height_m: 4 }, tare_t: 14, total_mass_t: 38.09, max_mass_t: 47.2, cargo_gross_t: 24.09 };
    assert.equal(vehicleParams(doc).mass, '38,09 т з вантажем (тара 14 т), маса брутто вантажу 24,09 т');
    const row = frontFields({ ...doc, lines: [] }).find(([label]) => label === 'Відомості про транспортний засіб');
    assert.match(row[1], /38,09 т з вантажем \(тара 14 т\), маса брутто вантажу 24,09 т/);
    const pdf = read('src/lib/pdf-ttn.js');
    const xlsx = read('src/lib/xlsx-docs.js');
    assert.match(pdf, /frontFields\(doc\)/);
    assert.match(xlsx, /frontFields\(doc\)/);
});

test('форма ТТН: маса береться з карток (kp_trailers_list), причіп шукається за номером; є ↺ і підказка з розкладом', () => {
    const form = read('src/views/docs-ttn-form.js');
    assert.match(form, /app\.supabase\.rpc\('kp_trailers_list'\)/);
    assert.match(form, /trainMasses\(vehicleCard\(\), trailerCard, hasTrailer\)/);
    assert.match(form, /'Тара і макс. маса: лише авто — ' \+ masses\.warning/);
});

test('міграція: колонки, CHECK-и, право логіста, список, збереження, prefill і create (існуючі ТТН не чіпаємо)', () => {
    assert.match(migration, /^-- Apply manually after review\. This file is not applied to production by the agent\./);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS tare_t numeric\(8, 3\) NULL,\n  ADD COLUMN IF NOT EXISTS max_mass_t numeric\(8, 3\) NULL/);
    assert.match(migration, /CHECK \(tare_t IS NULL OR \(tare_t > 0 AND tare_t <= 100\)\)/);
    assert.match(migration, /CHECK \(tare_t IS NULL OR max_mass_t IS NULL OR max_mass_t >= tare_t\)/);
    assert.match(migration, /v_ttn text\[\] := ARRAY\['make_model', 'capacity_t', 'volume_m3', 'tare_t', 'max_mass_t', 'updated_at'\]/);
    assert.match(migration, /vehicle_labels text\[\], tare_t numeric, max_mass_t numeric/);
    assert.match(migration, /v_tare := CASE WHEN NOT v_has_trl THEN v_fvc\.tare_t WHEN v_trc\.tare_t IS NULL THEN NULL ELSE v_fvc\.tare_t \+ v_trc\.tare_t END/);
    assert.match(migration, /'trailer_masses_missing'/);
    assert.equal(/UPDATE public\.kp_doc_ttn/i.test(migration.replace(/^--.*$/gm, '')), false, 'жодної перерахунку існуючих ТТН');
    assert.equal(/INSERT INTO public\.kp_doc_ttn|UPDATE public\.kp_doc_ttn/i.test(migration.replace(/^--.*$/gm, '').replace(/CREATE OR REPLACE FUNCTION public\.kp_ttn_create[\s\S]*?\n\$\$;\n/, '')), false);
});

// ---- Авто без тари / макс. маси; ліміт 200 т ----
const NO_VEHICLE_TARE = { tare_t: null, max_mass_t: 17.2 };
const NO_VEHICLE_MAX = { tare_t: 6.7, max_mass_t: null };
const EMPTY_TRAILER = { tare_t: null, max_mass_t: null };
const W_TARE = 'Немає тари авто в картці — внесіть вручну або заповніть картку';
const W_MAX = 'Немає макс. маси авто в картці — внесіть вручну або заповніть картку';
const W_TRAILER = 'немає маси причепа в картці';

test('trainMasses: авто без тари + причіп з тарою — тара автопоїзда null (нуль не підставляється), попередження про авто', () => {
    const m = trainMasses(NO_VEHICLE_TARE, TRAILER, true);
    assert.equal(m.tare, null);
    assert.equal(m.tareHint, '');
    assert.equal(m.max, 47.2, 'макс. маса в авто є — рахується');
    assert.deepEqual(m.vehicleWarnings, [W_TARE]);
    assert.equal(m.warning, '');
});

test('trainMasses: авто без макс. маси — макс. автопоїзда null + попередження; тара рахується', () => {
    const m = trainMasses(NO_VEHICLE_MAX, TRAILER, true);
    assert.equal(m.max, null);
    assert.equal(m.maxHint, '');
    assert.equal(m.tare, 14);
    assert.deepEqual(m.vehicleWarnings, [W_MAX]);
});

test('trainMasses: усі комбінації — авто (є / нема тари й макс.) × причіп (нема / з масами / порожній)', () => {
    const FULL = { tare_t: 6.7, max_mass_t: 17.2 };
    const NONE = { tare_t: null, max_mass_t: null };
    const rows = [
        // [назва, авто, причіп, hasTrailer, tare, max, vehicleWarnings, warning]
        ['авто є, причепа нема', FULL, null, false, 6.7, 17.2, [], ''],
        ['авто є, причіп з масами', FULL, TRAILER, true, 14, 47.2, [], ''],
        ['авто є, причіп порожній', FULL, EMPTY_TRAILER, true, 6.7, 17.2, [], W_TRAILER],
        ['авто є, причіп указано без картки', FULL, null, true, 6.7, 17.2, [], W_TRAILER],
        ['авто без мас, причепа нема', NONE, null, false, null, null, [W_TARE, W_MAX], ''],
        ['авто без мас, причіп з масами', NONE, TRAILER, true, null, null, [W_TARE, W_MAX], ''],
        ['авто без мас, причіп порожній', NONE, EMPTY_TRAILER, true, null, null, [W_TARE, W_MAX], W_TRAILER],
        ['авто без тари, причепа нема', NO_VEHICLE_TARE, null, false, null, 17.2, [W_TARE], ''],
        ['авто без макс., причіп порожній', NO_VEHICLE_MAX, EMPTY_TRAILER, true, 6.7, null, [W_MAX], W_TRAILER],
        ['причіп лише з тарою', FULL, { tare_t: 7.3, max_mass_t: null }, true, 14, 17.2, [], W_TRAILER],
        ['картки авто немає (ручне введення)', null, TRAILER, true, null, null, [], ''],
        ['картки авто немає, причепа нема', null, null, false, null, null, [], ''],
    ];
    for (const [name, vehicle, trailer, hasTrailer, tare, max, vehicleWarnings, warning] of rows) {
        const m = trainMasses(vehicle, trailer, hasTrailer);
        assert.deepEqual([m.tare, m.max, m.vehicleWarnings, m.warning], [tare, max, vehicleWarnings, warning], name);
    }
});

test('trainMasses: суми в кг цілими; рядки numeric з бази теж; без причепа картка причепа ігнорується', () => {
    const m = trainMasses({ tare_t: '0.100', max_mass_t: '1.000' }, { tare_t: '0.200', max_mass_t: '1.000' }, true);
    assert.deepEqual([m.tare, m.max], [0.3, 2]);
    assert.equal(trainMasses({ tare_t: 55, max_mass_t: 55 }, { tare_t: 50, max_mass_t: 50 }, true).tare, 105);
    assert.equal(trainMasses({ tare_t: null, max_mass_t: null }, TRAILER, false).tare, null);
});

test('форма: введену вручну тару не перебиває підстановка з карток; порожнє й раніше підставлене оновлюється', () => {
    const form = read('src/views/docs-ttn-form.js');
    assert.match(form, /let autoMasses = \{ tare: '', max: '' \}/);
    assert.match(form, /if \(!keep\(d\.tare_t, autoMasses\.tare\)\) d\.tare_t = m\.tare \?\? ''/);
    assert.match(form, /masses\.vehicleWarnings\.map/);
});

test('ліміт мас ТТН 200 т: форма, kp_doc_ttn_mass і kp_ttn_create; картки авто й причепа лишаються 100 т', () => {
    assert.equal(TTN_MASS_MAX_T, 200);
    const base = {
        place_of_issue: 'м. Київ', shipper: { name: 'А', code: '34567812' }, consignee: { name: 'Б', code: '45678123' }, driver: { full_name: 'В', license_no: 'ABC1' },
        vehicle: { make_model: 'DAF', type: 'Тягач', reg_number: 'AA1111TT', length_m: 16, width_m: 2.5, height_m: 4 },
        cargo_gross_t: 24.09, load_point: 'А', unload_point: 'Б', lines: [{ cargo_name: 'Пшениця', gross_t: 24.09 }],
    };
    assert.equal(validateTtn({ ...base, tare_t: 105, max_mass_t: 110 }).tare_t, undefined, '55 + 50 = 105 т — можна');
    assert.equal(validateTtn({ ...base, tare_t: 200, max_mass_t: 200 }).max_mass_t, undefined);
    assert.equal(validateTtn({ ...base, tare_t: 201, max_mass_t: 15 }).tare_t, 'Тара (маса ТЗ без вантажу), т: більше 0, до 200 т');
    assert.match(validateTtn({ ...base, tare_t: 15, max_mass_t: 201 }).max_mass_t, /до 200 т/);
    assert.match(migration, /tare_t > 0 AND tare_t <= 200\n  AND total_mass_t = tare_t \+ cargo_gross_t/);
    assert.match(migration, /max_mass_t > 0 AND max_mass_t <= 200/);
    assert.match(migration, /kp_ttn_num\(v_data ->> 'tare_t', 0, 200, 3, 'tare_t', 'TTN_FIELD_INVALID'\)/);
    assert.match(migration, /kp_ttn_num\(v_data ->> 'max_mass_t', 0, 200, 3, 'max_mass_t', 'TTN_FIELD_INVALID'\)/);
    assert.match(migration, /fleet_trailers_tare_t_check CHECK \(tare_t IS NULL OR \(tare_t > 0 AND tare_t <= 100\)\)/);
    assert.equal(validateTrailerMasses({ tare_t: '101', max_mass_t: '' }).errors.tare_t, 'Більше 0, до 100 т', 'картка причепа — як раніше');
});
