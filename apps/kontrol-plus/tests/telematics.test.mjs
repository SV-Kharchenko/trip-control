// Телематика (Агроконтроль, етап 2 «Власного парку»): нормалізація держномерів, розбір чисел і дат, xlsx / csv, мапінг колонок,
// детермінованість тестових даних, заглушка API і статичні гарантії (без токенів, без прямого запису таблиць, без alert / confirm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/lib/csv.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { normPlate } from '../src/lib/plates.js';
import { parseCsv as parseCsvText } from '../src/lib/csv.js';
import { excelSerialParts, parseDate, parseDateTime, parseEventKind, parseIdleMinutes, parseNumber } from '../src/lib/telematics/parse.js';
import { decodeCsvBytes, readXlsx } from '../src/lib/telematics/xlsx-read.js';
import { FIELDS, applyTemplate, buildFuelRows, buildReportRows, guessMapping, missingRequired } from '../src/lib/telematics/import.js';
import { createAgrocontrolMock, eachDate, hashSeed } from '../src/lib/telematics/agrocontrol-mock.js';
import { API_NOT_CONNECTED, createAgrocontrolApi } from '../src/lib/telematics/agrocontrol-api.js';
import { canSyncMock, createAdapter } from '../src/lib/telematics/adapter.js';
import { fmtMinutes, fmtNum, litersPer100, summaryRow, telematicsErrorText } from '../src/lib/telematics/summary.js';
import { parseCrmHash } from '../src/lib/route.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

test('держномер: кирилиця й латиниця однакових літер, регістр, пробіли, дефіси', () => {
    for (const [cyr, lat] of [['А', 'A'], ['В', 'B'], ['Е', 'E'], ['І', 'I'], ['К', 'K'], ['М', 'M'], ['Н', 'H'], ['О', 'O'], ['Р', 'P'], ['С', 'C'], ['Т', 'T'], ['Х', 'X']]) {
        assert.equal(normPlate(cyr), lat, cyr + ' → ' + lat);
        assert.equal(normPlate(cyr.toLowerCase()), lat, 'нижній регістр ' + cyr);
    }
    assert.equal(normPlate('аа 1234 вв'), 'AA1234BB');
    assert.equal(normPlate('AA-1234-BB'), 'AA1234BB');
    assert.equal(normPlate('КЕ 5555 АХ'), normPlate('KE5555AX'));
    assert.equal(normPlate(null), '');
});

test('числа: десяткова кома, пробіли, порожньо, помилки', () => {
    assert.equal(parseNumber('12,5'), '12.5');
    assert.equal(parseNumber('1 234,50'), '1234.5');
    assert.equal(parseNumber('1234.5'), '1234.5');
    assert.equal(parseNumber('1.2E+3'), '1200');
    assert.equal(parseNumber(''), '');
    assert.equal(parseNumber('  '), '');
    for (const bad of ['abc', '-5', '12,5,6', '1/2']) assert.equal(parseNumber(bad), null, bad);
});

test('дати: дд.мм.рррр, ISO, час, серійне число Excel, неіснуючі', () => {
    assert.equal(parseDate('31.12.2025'), '2025-12-31');
    assert.equal(parseDate('1.2.2026'), '2026-02-01');
    assert.equal(parseDate('2025-12-31'), '2025-12-31');
    assert.equal(parseDate('2025-12-31 08:15'), '2025-12-31');
    assert.equal(parseDate('31.12.2025 23:59'), '2025-12-31');
    assert.equal(parseDate('45992'), '2025-12-01', 'серійне число Excel (1899-12-30 + 45992 дні)');
    assert.equal(parseDate(''), '');
    for (const bad of ['31.02.2025', '2025-13-01', 'вчора', '12/31/2025']) assert.equal(parseDate(bad), null, bad);
    assert.deepEqual(excelSerialParts(45992.5), { date: '2025-12-01', time: '12:00:00' });
    assert.equal(excelSerialParts(12), null);
});

test('момент події: дата + час', () => {
    assert.equal(parseDateTime('31.12.2025 08:05'), '2025-12-31T08:05:00');
    assert.equal(parseDateTime('2025-12-31T08:05:30Z'), '2025-12-31T08:05:30');
    assert.equal(parseDateTime('31.12.2025'), '2025-12-31T00:00:00');
    assert.equal(parseDateTime('45992.75'), '2025-12-01T18:00:00');
    assert.equal(parseDateTime('31.12.2025 25:00'), null);
    assert.equal(parseDateTime('вчора'), null);
    assert.equal(parseDateTime(''), '');
});

test('простій: хвилини, години, год:хв; тип події', () => {
    assert.equal(parseIdleMinutes('90'), '90');
    assert.equal(parseIdleMinutes('1,5', 'h'), '90');
    assert.equal(parseIdleMinutes('1:30'), '90');
    assert.equal(parseIdleMinutes('01:30:00'), '90');
    assert.equal(parseIdleMinutes('1:75'), null);
    assert.equal(parseIdleMinutes('abc'), null);
    assert.equal(parseIdleMinutes(''), '');
    assert.equal(parseEventKind('Заправка'), 'refuel');
    assert.equal(parseEventKind('Слив топлива'), 'drain');
    assert.equal(parseEventKind('Злив'), 'drain');
    assert.equal(parseEventKind(''), '');
    assert.equal(parseEventKind('щось'), null);
});

test('мапінг колонок: підбір за заголовками, шаблон, обов’язкові поля', () => {
    const headers = ['Дата', 'Держномер', 'Пробіг, км', 'Витрата палива, л', 'Простій', 'Мотогодини'];
    const m = guessMapping('reports', headers);
    assert.deepEqual(m, { date: 'Дата', ref: 'Держномер', mileage: 'Пробіг, км', fuel: 'Витрата палива, л', idle: 'Простій', engine: 'Мотогодини' });
    assert.deepEqual(missingRequired('reports', { date: 'Дата' }), ['Держномер']);
    assert.deepEqual(missingRequired('reports', m), []);
    // шаблон діє лише коли всі його колонки є у файлі
    assert.deepEqual(applyTemplate('reports', { date: 'дата', ref: 'ДЕРЖНОМЕР' }, headers), { date: 'Дата', ref: 'Держномер' });
    assert.deepEqual(applyTemplate('reports', { date: 'Нема такої' }, headers), m, 'невідомий заголовок шаблону → підбір за заголовками');
    const fe = guessMapping('fuel_events', ['Дата й час', 'Авто', 'Тип', 'Літри', 'Місце']);
    assert.deepEqual(fe, { ts: 'Дата й час', ref: 'Авто', liters: 'Літри', kind: 'Тип', location: 'Місце' });
    assert.ok(FIELDS.fuel_events.filter((f) => f.required).length === 3);
});

test('звіт: рядки з комами й датами; порожні пропущено; помилки з номером рядка', () => {
    const { records } = parseCsv('Дата;Держномер;Пробіг;Пальне;Простій;Мотогодини\n31.12.2025;АА 1234 ВВ;120,5;40,2;1:30;6,5\n;;;;;\n01.01.2026;KE5555AX;abc;10;5;1\nвчора;KE5555AX;1;1;1;1\n02.01.2026;;5;5;5;5\n02.01.2026;KE5555AX;80;30;45;4\n');
    const mapping = guessMapping('reports', records[0].cells);
    const out = buildReportRows(records, mapping);
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows[0], { date: '2025-12-31', ref: 'АА 1234 ВВ', mileage_km: '120.5', fuel_used_l: '40.2', idle_minutes: '90', engine_hours: '6.5',
        raw: { Дата: '31.12.2025', Держномер: 'АА 1234 ВВ', Пробіг: '120,5', Пальне: '40,2', Простій: '1:30', Мотогодини: '6,5' } });
    assert.equal(out.empty, 0, 'повністю порожні рядки відсікає вже читач файлу (CSV / xlsx), нумерація рядків при цьому не збивається');
    assert.deepEqual(out.errors.map((e) => e.line), [4, 5, 6], 'номери рядків файлу (заголовок — 1, порожній — 3)');
    assert.match(out.errors[0].message, /«Пробіг»: «abc» — не число/);
    assert.match(out.errors[1].message, /«Дата»: «вчора»/);
    assert.match(out.errors[2].message, /«Держномер» порожній/);
});

test('заправки / зливи: тип з колонки або за замовчуванням, літри > 0', () => {
    const { records } = parseCsv('Час;Авто;Тип;Літри;Місце\n31.12.2025 10:15;AA1234BB;Злив;45,5;Поле\n31.12.2025 11:00;AA1234BB;Заправка;200;АЗС\n31.12.2025 12:00;AA1234BB;;30;\n31.12.2025 13:00;AA1234BB;Злив;0;\n31.12.2025 14:00;AA1234BB;щось інше;5;\n');
    const mapping = guessMapping('fuel_events', records[0].cells);
    const out = buildFuelRows(records, mapping, { defaultKind: 'refuel' });
    assert.deepEqual(out.rows.map((r) => [r.kind, r.liters]), [['drain', '45.5'], ['refuel', '200'], ['refuel', '30']]);
    assert.deepEqual(out.errors.map((e) => e.line), [5, 6]);
    assert.match(out.errors[0].message, /більше нуля/);
    assert.match(out.errors[1].message, /Заправка.*Злив|«Тип»/);
    const noKind = buildFuelRows(records, { ...mapping, kind: undefined }, {});
    assert.ok(noKind.errors.length >= 5, 'без типу й без значення за замовчуванням рядки відхиляються');
});

test('xlsx: читання файлу, зібраного buildXlsx (рядки, числа, дати, порожні комірки)', () => {
    const bytes = buildXlsx({ name: 'Звіт', columns: [12, 14, 10], rows: [['Дата', 'Держномер', 'Пробіг'], [{ date: '2025-12-31' }, 'AA 1234 BB', 120.5], [{ date: '2026-01-01' }, 'KE5555AX', null], ['', '', ''], [{ date: '2026-01-02' }, 'AA &amp; <1>', 80]] });
    const { records } = readXlsx(bytes);
    assert.deepEqual(records.map((r) => r.cells[1]), ['Держномер', 'AA 1234 BB', 'KE5555AX', 'AA &amp; <1>'], 'порожній рядок пропущено, спецсимволи збережено');
    assert.equal(records[0].line, 1);
    assert.equal(records[1].cells[0], '46022', 'дата — серійне число Excel');
    assert.equal(parseDate(records[1].cells[0]), '2025-12-31');
    assert.equal(records[2].cells[2] ?? '', '', 'порожня комірка');
    const out = buildReportRows(records, guessMapping('reports', records[0].cells));
    assert.equal(out.rows.length, 3);
    assert.deepEqual(out.rows.map((r) => r.date), ['2025-12-31', '2026-01-01', '2026-01-02']);
    assert.equal(out.rows[0].mileage_km, '120.5');
});

test('xlsx / csv: некоректний файл → зрозуміла помилка; кодування windows-1251', () => {
    assert.throws(() => readXlsx(new Uint8Array([1, 2, 3, 4])), (e) => e.code === 'BAD_FILE' && /Не вдалося відкрити/.test(e.message));
    assert.throws(() => readXlsx(new Uint8Array(6 * 1024 * 1024)), (e) => e.code === 'TOO_LARGE');
    const cp1251 = new Uint8Array([0xC4, 0xE0, 0xF2, 0xE0, 0x3B, 0xCF, 0xF0, 0xEE, 0xE1, 0xB3, 0xE3]);
    assert.equal(decodeCsvBytes(cp1251), 'Дата;Пробіг');
    assert.equal(decodeCsvBytes(new TextEncoder().encode('Дата;Пробіг')), 'Дата;Пробіг');
    const rows = 2500;
    const big = 'a;b\n' + Array.from({ length: rows }, (_, i) => i + ';x').join('\n');
    assert.equal(parseCsvText(big, { maxRows: 5000 }).records.length, rows + 1, 'для телематики ліміт 5000 рядків');
    assert.throws(() => parseCsvText(big), (e) => e.code === 'TOO_MANY_ROWS', 'за замовчуванням ліміт 2000 лишився');
});

test('тестові дані Агроконтролю детерміновані й реалістичні', async () => {
    const vehicles = [{ id: 'v1', label: 'AA 1111 AA' }, { id: 'v2', label: 'KE 5555 AX' }];
    const a = createAgrocontrolMock({ orgId: 'org-1', vehicles });
    const b = createAgrocontrolMock({ orgId: 'org-1', vehicles });
    const range = { from: '2026-05-01', to: '2026-05-30' };
    const [ra, rb] = [await a.fetchReports(range), await b.fetchReports(range)];
    assert.deepEqual(ra, rb, 'один org + дати → ті самі дані');
    assert.deepEqual(await a.fetchFuelEvents(range), await b.fetchFuelEvents(range));
    const other = await createAgrocontrolMock({ orgId: 'org-2', vehicles }).fetchReports(range);
    assert.notDeepEqual(ra, other, 'інша організація → інші дані');
    assert.deepEqual(await a.fetchReports({ from: '2026-05-10', to: '2026-05-12' }), ra.filter((r) => r.date >= '2026-05-10' && r.date <= '2026-05-12'), 'вужчий період — підмножина тих самих чисел');
    assert.ok(ra.length >= 40 && ra.length <= 60, 'близько 30 днів × 2 авто мінус дні без виїзду: ' + ra.length);
    for (const r of ra) {
        const km = Number(r.mileage_km);
        assert.ok(km >= 40 && km <= 300, 'пробіг 40–300: ' + km);
        const l100 = (Number(r.fuel_used_l) / km) * 100;
        assert.ok(l100 >= 24 && l100 <= 46, 'витрата 25–45 л/100 км: ' + l100);
        assert.ok(Number(r.idle_minutes) >= 0 && Number(r.idle_minutes) <= 240, 'простій до 4 год');
    }
    const events = await createAgrocontrolMock({ orgId: 'org-3', vehicles: Array.from({ length: 30 }, (_, i) => ({ id: 'v' + i, label: 'AA ' + String(1000 + i) + ' AA' })) }).fetchFuelEvents({ from: '2026-01-01', to: '2026-03-31' });
    const drains = events.filter((e) => e.kind === 'drain');
    assert.ok(drains.length > 0 && drains.length < events.length / 5, 'зливи рідкі: ' + drains.length + ' з ' + events.length);
    for (const d of drains) assert.ok(Number(d.liters) >= 20 && Number(d.liters) <= 80, 'злив 20–80 л');
    assert.equal(hashSeed('x'), hashSeed('x'));
    assert.deepEqual(eachDate('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
});

test('API Агроконтролю — заглушка зі зрозумілою помилкою; синхронізація лише для mock', async () => {
    const api = createAgrocontrolApi();
    await assert.rejects(api.fetchReports({ from: '2026-01-01', to: '2026-01-02' }), (e) => e.code === 'NOT_CONNECTED' && e.message === API_NOT_CONNECTED);
    await assert.rejects(api.fetchFuelEvents({}), (e) => e.message === 'API Агроконтролю ще не підключено.');
    assert.equal(telematicsErrorText(Object.assign(new Error(API_NOT_CONNECTED), { code: 'NOT_CONNECTED' })), API_NOT_CONNECTED);
    assert.equal(canSyncMock({ kind: 'agrocontrol_mock' }), true);
    assert.equal(canSyncMock({ kind: 'agrocontrol_api' }), false);
    assert.equal(canSyncMock({ kind: 'file_import' }), false);
    assert.equal(canSyncMock(null), false);
    assert.equal(createAdapter('agrocontrol_mock', { orgId: 'o', vehicles: [] }).kind, 'agrocontrol_mock');
    assert.equal(createAdapter('agrocontrol_api', {}).kind, 'agrocontrol_api');
    assert.throws(() => createAdapter('file_import', {}), /Завантажте файл/);
});

test('показники: л/100 км, формати, рядок зведення', () => {
    assert.equal(litersPer100(200, 70), 35);
    assert.equal(litersPer100(0, 10), null);
    assert.equal(litersPer100(null, 10), null);
    assert.equal(litersPer100(100, null), null);
    assert.equal(fmtMinutes(185), '3 г 05 хв');
    assert.equal(fmtMinutes(null), '—');
    assert.equal(fmtNum(null), '—');
    assert.match(fmtNum(1234.5), /1\s?234,5/);
    const row = summaryRow({ ref: 'AA1234BB', vehicle_id: 'v1', unit_id: 'u1', days: 3, mileage_km: '261.0', fuel_used_l: '91.4', idle_minutes: 120, engine_hours: '10.0', drain_count: 1, drain_l: '46.0', refuel_l: '200' },
        [{ id: 'v1', label: 'AA 1234 BB' }], [{ id: 'u1', name: 'Північ' }]);
    assert.equal(row.label, 'AA 1234 BB');
    assert.equal(row.unit, 'Північ');
    assert.equal(row.mapped, true);
    assert.ok(Math.abs(row.l100 - 35.02) < 0.01);
    assert.equal(summaryRow({ ref: 'ZZ', vehicle_id: null, days: 1, mileage_km: null }, [], []).mapped, false);
});

test('маршрут #/own-fleet/telematics', () => {
    assert.deepEqual(parseCrmHash('#/own-fleet/telematics'), { view: 'own-fleet', sub: 'telematics' });
    assert.equal(parseCrmHash('#/own-fleet/telematics/x'), null);
});

test('статично: без токенів і секретів, без прямого запису таблиць, без alert / confirm, лише tm_* RPC', () => {
    const files = ['src/views/own-fleet/telematics.js', 'src/views/own-fleet/telematics-import.js', 'src/lib/telematics/adapter.js', 'src/lib/telematics/agrocontrol-api.js',
        'src/lib/telematics/agrocontrol-mock.js', 'src/lib/telematics/import.js', 'src/lib/telematics/parse.js', 'src/lib/telematics/summary.js', 'src/lib/telematics/xlsx-read.js'];
    for (const f of files) {
        const code = read(f).replace(/^\s*\/\/.*$/gm, '');
        assert.equal(/\b(window\.)?(confirm|alert|prompt)\(/.test(code), false, f + ': без confirm / alert');
        assert.equal(/\.(insert|update|upsert|delete)\(/.test(code), false, f + ': таблиці телематики пишуться лише через RPC');
        assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(code), false, f + ': жодних зовнішніх адрес');
        assert.equal(/(api[_-]?key|bearer|secret|token)/i.test(code.replace(/api_secret_name/g, '')), false, f + ': жодних токенів');
    }
    const rpcs = new Set();
    for (const f of ['src/views/own-fleet/telematics.js', 'src/views/own-fleet/telematics-import.js']) for (const m of read(f).matchAll(/rpc\('([a-z_]+)'/g)) rpcs.add(m[1]);
    assert.deepEqual([...rpcs].sort(), ['tm_ensure_source', 'tm_import_fuel_events', 'tm_import_reports', 'tm_save_template', 'tm_set_vehicle_map', 'tm_set_vehicle_unit', 'tm_summary']);
    assert.match(read('src/views/own-fleet/telematics-import.js'), /нікуди не надсилається/, 'пояснення, що файл не йде на сторонні сервіси');
    assert.match(read('src/views/own-fleet/units.js'), /Код підрозділу в 1С\/BAS для звітів собівартості\. Можна лишити порожнім\./);
});
