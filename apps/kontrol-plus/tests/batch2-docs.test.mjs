import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calcAccepted, CALC_DOC_HINT } from '../src/lib/docs.js';
import { NORM_NEEDS_LOADED_KM, calcTripSheet, closePayload, fuelNorm, tsFromPrefill, tsSections } from '../src/lib/trip-sheet.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const readRoot = (file) => fs.readFileSync(new URL('../../../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('п.9: ТТН з рейсу лише з прийнятої заявки — у неприйнятих рядках посилання неактивні з підказкою', () => {
    assert.equal(calcAccepted('accepted'), true);
    assert.equal(calcAccepted('done'), true);
    for (const status of ['pending', 'draft', 'rejected', undefined, null]) assert.equal(calcAccepted(status), false, String(status));
    assert.equal(CALC_DOC_HINT, 'Спершу прийміть заявку');
    const card = read('src/views/client-card.js');
    assert.ok(card.includes("calcAccepted(r.status)"));
    assert.ok(card.includes("h('span', { class: 'muted', title: CALC_DOC_HINT, 'aria-disabled': 'true' }, 'ТТН')"));
    const ttn = read('src/views/docs-ttn-card.js');
    assert.ok(ttn.includes('calcAccepted(calcStatus)'));
    assert.ok(ttn.includes("disabled: true, title: CALC_DOC_HINT }, 'Ще одна ТТН на рейс')"));
});

test('п.9: на картці подорожнього (і ТТН) активна підвкладка «ТТН / Подорожній лист»', () => {
    const docs = read('src/views/docs.js');
    assert.ok(docs.includes("const inTtnGroup = sub === 'ttn' || sub === 'trip_sheet'"));
    assert.ok(docs.includes("const currentKey = route.tab || (inTtnGroup ? 'ttn' : 'all');"));
});

test('п.9: без «пробігу з вантажем» норму не рахуємо (—), а не весь пробіг за нормою завантаженого', () => {
    const base = { depart_odometer: 0, return_odometer: 100, depart_fuel_left: 50, fuel_issued: 0, return_fuel_left: 30, fuel_load: 30, fuel_empty: 20 };
    const none = calcTripSheet(base);
    assert.equal(none.fuel_norm, null);
    assert.equal(none.fuel_diff, null);
    assert.equal(calcTripSheet({ ...base, loaded_km: '' }).fuel_norm, null);
    assert.equal(calcTripSheet({ ...base, loaded_km: 60 }).fuel_norm, 26, '60 км × 30% + 40 км × 20%');
    assert.equal(fuelNorm(100, null, 30, 20), null);
    const closed = { status: 'closed', number: 1, doc_date: '2026-10-28', valid_from: '2026-10-28', valid_to: '2026-10-28', vehicle: { fuel_load: 30, fuel_empty: 20 }, task: {}, distance_km: 100, fuel_actual: 20, fuel_norm: null };
    const calc = tsSections(closed).find((s) => s.title === 'Розрахунок').rows.find(([label]) => label === 'Витрата за нормою, л');
    assert.ok(calc[1].startsWith('—') && calc[1].includes(NORM_NEEDS_LOADED_KM.toLowerCase()));
});

test('п.9: норми л/100 км (з вантажем / порожній) є в розділах картки, PDF і Excel', () => {
    const doc = { status: 'issued', number: 7, doc_date: '2026-10-28', valid_from: '2026-10-28', valid_to: '2026-10-28', vehicle: { make_model: 'DAF', reg_number: 'AA1111AA', fuel_load: 30, fuel_empty: 22.5 }, task: {} };
    const rows = tsSections(doc).find((s) => s.title === 'ТЗ і водій').rows;
    assert.deepEqual(rows.filter(([label]) => label.startsWith('Норма')), [['Норма з вантажем, л/100 км', '30'], ['Норма порожнього, л/100 км', '22,5']]);
    assert.ok(read('src/lib/pdf-trip-sheet.js').includes('tsSections(doc)'), 'PDF бере розділи з tsSections');
    assert.ok(read('src/lib/xlsx-docs.js').includes('tsSections(doc)'), 'Excel — теж');
    const noNorms = tsSections({ ...doc, vehicle: {} }).find((s) => s.title === 'ТЗ і водій').rows.filter(([label]) => label.startsWith('Норма'));
    assert.deepEqual(noNorms.map(([, v]) => v), ['—', '—']);
});

test('п.9: пробіг із вантажем береться з основного рейсу заявки (без подачі), назва вантажу — з inputs', () => {
    const pre = { route: { from: 'Луцьк', to: 'Одеса', dist_km: 500, feed_km: 40 }, cargo: { tonnage: 22, name: 'Пшениця 3 кл.' }, dates: { trip_date: '2026-10-28', days: 2 } };
    const d = tsFromPrefill(pre, '2026-10-28');
    assert.equal(d.task.loaded_km, '500', 'без подачі');
    assert.equal(d.task.planned_km, '540', 'план разом із подачею');
    assert.equal(d.task.cargo, 'Пшениця 3 кл.');
    assert.equal(tsFromPrefill({ route: { dist_km: 500 } }, '2026-10-28').task.cargo, '', 'без назви — порожньо, вводить користувач');
    assert.ok(read('src/views/docs-ttn-form.js').includes('d.lines[0].cargo_name = String(cargoName)'), 'ТТН підставляє назву вантажу в перший рядок');
});

test('п.9: поля повернення редагуються до закриття: «Зберегти повернення» + «Закрити лист»; після закриття форма зникає', () => {
    const card = read('src/views/docs-ts-card.js');
    assert.ok(card.includes("rpc('kp_trip_sheet_return_save', { p_id: doc.id, p_data: values() })"));
    assert.ok(card.includes("rpc('kp_trip_sheet_close', { p_id: doc.id, p_data: values() })"));
    assert.ok(card.includes('value: saved(doc.return_odometer)') && card.includes('value: saved(doc.return_fuel_left)'), 'збережені значення підставляються');
    assert.ok(card.includes('issued && access.canWrite ? closeForm(doc) : null'), 'форма лише для виданого листа');
    assert.ok(card.includes("'Зберегти повернення'"));
    assert.deepEqual(closePayload({ return_at: '', return_odometer: '100400', return_fuel_left: '' }), { return_at: null, return_odometer: '100400', return_fuel_left: null });
});

test('міграція 20261030091000: kp_calc_is_accepted з перевіркою організації, відкат прибирає її, поля повернення зберігаються до закриття', () => {
    const sql = readRoot('supabase/migrations/20261030091000_kp_trip_sheet_followups.sql');
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.kp_calc_is_accepted'), sql.indexOf('$$;', sql.indexOf('CREATE OR REPLACE FUNCTION public.kp_calc_is_accepted')));
    assert.ok(fn.includes('c.org_id = public.current_org_id() OR public.is_service_role()'));
    assert.ok(sql.includes('--   DROP FUNCTION IF EXISTS public.kp_calc_is_accepted(uuid);'), 'блок відкату прибирає kp_calc_is_accepted');
    assert.ok(sql.includes('--   DROP FUNCTION IF EXISTS public.kp_trip_sheet_return_save(uuid, jsonb);'));
    assert.ok(sql.includes("v_return text[] := ARRAY['return_at', 'return_odometer', 'return_fuel_left'];"));
    assert.ok(sql.includes('IF p_loaded_km IS NULL THEN\n    RETURN NULL;'), 'норма NULL без пробігу з вантажем');
    assert.ok(sql.includes("'name', nullif(left(btrim(coalesce(v_inp ->> 'cargoName', '')), 500), '')"));
    assert.ok(sql.includes("'approved_variant', v_calc.approved_variant"));
    // Старі міграції не редагуються.
    assert.ok(readRoot('supabase/migrations/20261029100000_kp_trip_sheets.sql').includes('SELECT EXISTS (SELECT 1 FROM public.calculations AS c WHERE c.id = p_calculation AND c.status IN (\'accepted\', \'done\'));'));
});
