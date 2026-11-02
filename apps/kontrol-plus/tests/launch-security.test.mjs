// Передрейсові відмітки подорожнього листа після виїзду — лише читання (UI; сервер і pgTAP: supabase/tests/kp_launch_security.sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tsErrorText } from '../src/lib/trip-sheet.js';
import { PRETRIP_FIELDS, PRETRIP_GRACE_MS, marksPayload, pretripLocked } from '../src/lib/trip-sheet-stages.js';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const T0 = Date.parse('2026-10-28T03:00:00Z');
const doc = (over = {}) => ({ depart_at: '2026-10-28T03:00:00Z', created_at: '2026-10-28T02:00:00Z', status: 'issued', ...over });

test('замок: now ≥ depart_at і понад 10 хвилин від створення; до виїзду й у перші хвилини видачі відмітки редагуються', () => {
    assert.equal(PRETRIP_GRACE_MS, 10 * 60 * 1000);
    assert.equal(pretripLocked(doc(), T0 - 1000), false, 'до виїзду');
    assert.equal(pretripLocked(doc(), T0), true, 'у момент виїзду (лист створено годину тому)');
    assert.equal(pretripLocked(doc(), T0 + 3600e3), true, 'після виїзду');
    const fresh = doc({ created_at: new Date(T0 + 1000).toISOString() });
    assert.equal(pretripLocked(fresh, T0 + 5 * 60e3), false, 'щойно видано: форма видачі ще дозаповнює допуск');
    assert.equal(pretripLocked(fresh, T0 + 12 * 60e3), true, 'через 10 хвилин після створення — закрито');
    assert.equal(pretripLocked({}, T0), false, 'без дат не блокуємо (сервер вирішує)');
});

test('payload відміток після виїзду не містить передрейсових полів; післярейсові й диспетчер лишаються', () => {
    const marks = {
        medical_by: 'Медик', medical_at: '2026-10-28T05:30', medical_ok: true, tech_by: 'Механік', tech_at: '2026-10-28T05:40', tech_ok: true,
        medical_post_by: 'Медик після', medical_post_at: '', medical_post_ok: true, mech_return_by: '', mech_return_at: '', mech_return_accepted: false, dispatcher_name: 'Диспетчер',
    };
    const all = marksPayload(marks);
    for (const f of PRETRIP_FIELDS) assert.ok(f in all, f + ' надсилається до виїзду');
    const locked = marksPayload(marks, { locked: true });
    for (const f of PRETRIP_FIELDS) assert.equal(f in locked, false, f + ' не надсилається після виїзду');
    assert.equal(locked.medical_post_by, 'Медик після');
    assert.equal(locked.dispatcher_name, 'Диспетчер');
    assert.equal(locked.medical_post_ok, true);
});

test('текст помилки сервера TS_PRETRIP_LOCKED зрозумілий', () => {
    assert.match(tsErrorText({ message: 'TS_PRETRIP_LOCKED' }), /Передрейсові відмітки .* після виїзду не змінюються/);
});

test('UI: редактор відміток блокує передрейсові поля, картка передає стан замка і в редактор, і в payload', () => {
    const editor = read('src/views/docs-ts-stages.js');
    assert.ok(editor.includes('export function marksEditor(m, onChange, { locked = false } = {})'));
    assert.ok(editor.includes('const frozen = locked && PRETRIP_FIELDS.includes(by);'));
    assert.ok(editor.includes('disabled: frozen'));
    assert.match(editor, /після виїзду тільки для читання/);
    const card = read('src/views/docs-ts-card.js');
    assert.ok(card.includes('marksPayload(marks, { locked: pretripLocked(doc) })'));
    assert.ok(card.includes('marksEditor(marks, () => {}, { locked: pretripLocked(doc) })'));
});

test('сервер: міграція відмовляє TS_PRETRIP_LOCKED в RPC і в тригері, повторне надсилання тих самих значень дозволене', () => {
    const sql = read('../../supabase/migrations/20261110093000_ts_pretrip_marks_lock.sql');
    assert.match(sql, /RAISE EXCEPTION 'TS_PRETRIP_LOCKED' USING ERRCODE = 'P0001'/);
    assert.match(sql, /RAISE EXCEPTION 'TS_PRETRIP_LOCKED' USING ERRCODE = '42501'/);
    assert.match(sql, /IS DISTINCT FROM/);
    assert.match(sql, /kp_ts_pretrip_locked\(v_t\.depart_at, v_t\.created_at\)/);
    assert.match(sql, /interval '10 minutes'/);
});
