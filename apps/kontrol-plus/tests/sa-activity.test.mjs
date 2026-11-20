// Кабінет суперадміна, вкладка «Активність»: статуси за датами, лічильники, фільтри, сортування, мітки ролей, формат дат Europe/Kyiv;
// статична перевірка міграції (лише читання, без UPDATE / DELETE), api/ = 12. Без браузера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ACTIVITY_COLUMNS, DEFAULT_SORT, activityCounts, activityStatus, filterActivity, formatKyivStamp, nextSort, roleLabel, sortActivity, statusLabel, yesNo,
} from '../src/lib/sa-activity.js';
import { planLabel } from '../src/lib/superadmin.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (days, extraHours = 0) => new Date(NOW - days * 86400000 - extraHours * 3600000).toISOString();
const R = (id, patch) => ({ user_id: id, email: id + '@example.com', org_id: 'o1', org_name: 'Компанія ' + id, org_plan: 'company', org_role: 'owner', member_status: 'active',
    registered_at: ago(100), email_confirmed_at: ago(100), last_sign_in_at: ago(1), calcs_total: 0, calcs_7d: 0, calcs_30d: 0, last_calc_at: null, last_activity_at: ago(1), ...patch });

test('статус: «Активний» до 7 днів, «Згасає» 8–30, «Неактивний» понад 30, «Не входив» — порожній last_sign_in_at', () => {
    const st = (patch) => activityStatus(R('x', patch), NOW);
    assert.equal(st({ last_activity_at: ago(0) }), 'active');
    assert.equal(st({ last_activity_at: ago(7, 23) }), 'active', '7 днів і 23 години — ще 7 повних днів');
    assert.equal(st({ last_activity_at: ago(8) }), 'fading');
    assert.equal(st({ last_activity_at: ago(30, 23) }), 'fading');
    assert.equal(st({ last_activity_at: ago(31) }), 'inactive');
    assert.equal(st({ last_activity_at: ago(400) }), 'inactive');
    assert.equal(st({ last_sign_in_at: null, last_activity_at: null }), 'never');
    assert.equal(st({ last_sign_in_at: null, last_activity_at: ago(2) }), 'never', 'без входу — «Не входив», навіть якщо є розрахунки');
    assert.equal(st({ last_sign_in_at: ago(50), last_activity_at: ago(2) }), 'active', 'свіжий розрахунок підтягує статус');
    assert.deepEqual(['active', 'fading', 'inactive', 'never'].map(statusLabel), ['Активний', 'Згасає', 'Неактивний', 'Не входив']);
});

const ROWS = [
    R('a', { last_activity_at: ago(1), org_name: 'Агро Північ', org_plan: 'control_plus', calcs_total: 10, calcs_7d: 3, calcs_30d: 6 }),
    R('b', { last_activity_at: ago(12), last_sign_in_at: ago(12), org_name: 'Транс Захід', calcs_total: 4, calcs_7d: 0, calcs_30d: 2, org_role: 'logist' }),
    R('c', { last_activity_at: ago(60), last_sign_in_at: ago(60), org_name: null, org_id: null, org_role: null, org_plan: null }),
    R('d', { last_sign_in_at: null, last_activity_at: null, email_confirmed_at: null, org_role: 'requester' }),
    R('e', { last_activity_at: ago(3), org_role: 'director', calcs_total: 25, calcs_7d: 9, calcs_30d: 20 }),
];
const ids = (rows) => rows.map((r) => r.user_id);

test('лічильники за статусами і фільтри: за статусом, пошук за email або компанією без урахування регістру', () => {
    assert.deepEqual(activityCounts(ROWS, NOW), { active: 2, fading: 1, inactive: 1, never: 1 });
    assert.deepEqual(ids(filterActivity(ROWS, { status: 'active' }, NOW)), ['a', 'e']);
    assert.deepEqual(ids(filterActivity(ROWS, { status: 'never' }, NOW)), ['d']);
    assert.deepEqual(ids(filterActivity(ROWS, { q: 'АГРО' }, NOW)), ['a'], 'за компанією, регістр не важливий');
    assert.deepEqual(ids(filterActivity(ROWS, { q: 'B@EXAMPLE' }, NOW)), ['b'], 'за email');
    assert.deepEqual(ids(filterActivity(ROWS, { q: 'example.com', status: 'fading' }, NOW)), ['b'], 'статус + пошук разом');
    assert.deepEqual(ids(filterActivity(ROWS, { q: '  ' }, NOW)), ids(ROWS));
    assert.deepEqual(ids(filterActivity(ROWS, { q: 'немає такого' }, NOW)), []);
});

test('сортування: за замовчуванням last_activity_at desc, порожні (nulls) в кінці в обох напрямках; текст, числа, дати', () => {
    assert.deepEqual(DEFAULT_SORT, { key: 'last_activity_at', dir: 'desc' });
    assert.deepEqual(ids(sortActivity(ROWS)), ['a', 'e', 'b', 'c', 'd']);
    assert.deepEqual(ids(sortActivity(ROWS, { key: 'last_activity_at', dir: 'asc' })), ['c', 'b', 'e', 'a', 'd'], 'nulls last і за зростанням');
    assert.deepEqual(ids(sortActivity(ROWS, { key: 'calcs_total', dir: 'desc' })).slice(0, 3), ['e', 'a', 'b']);
    assert.equal(sortActivity(ROWS, { key: 'org_name', dir: 'asc' }).at(-1).user_id, 'c', 'без компанії — в кінці');
    assert.equal(sortActivity(ROWS, { key: 'email', dir: 'desc' })[0].user_id, 'e');
    assert.equal(sortActivity(ROWS, { key: 'last_sign_in_at', dir: 'asc' }).at(-1).user_id, 'd');
    const before = ids(ROWS);
    sortActivity(ROWS, { key: 'email', dir: 'asc' });
    assert.deepEqual(ids(ROWS), before, 'вхідний масив не змінюється');
});

test('клік по заголовку: той самий стовпець — інший напрямок; новий: текст asc, дати й числа desc', () => {
    assert.deepEqual(nextSort(DEFAULT_SORT, 'last_activity_at'), { key: 'last_activity_at', dir: 'asc' });
    assert.deepEqual(nextSort({ key: 'last_activity_at', dir: 'asc' }, 'last_activity_at'), { key: 'last_activity_at', dir: 'desc' });
    assert.deepEqual(nextSort(DEFAULT_SORT, 'email'), { key: 'email', dir: 'asc' });
    assert.deepEqual(nextSort(DEFAULT_SORT, 'calcs_7d'), { key: 'calcs_7d', dir: 'desc' });
    assert.deepEqual(ACTIVITY_COLUMNS.map((c) => c.label), ['Email', 'Компанія', 'Тариф', 'Роль', 'Реєстрація', 'Пошта підтверджена', 'Останній вхід',
        'Розрахунків за 7 днів', 'Розрахунків за 30 днів', 'Розрахунків усього', 'Остання дія']);
});

test('мітки: ролі (ключі БД не змінено), тариф «Сайт» / «Контроль+», «так / ні»', () => {
    assert.deepEqual(['owner', 'director', 'logist', 'repair_manager', 'requester'].map(roleLabel),
        ['Директор', 'Менеджер', 'Логіст', 'Відповідальний за ремонти', 'Замовник підрозділу']);
    assert.equal(roleLabel(null), '—');
    assert.equal(roleLabel('weird'), 'weird');
    assert.equal(planLabel('company'), 'Сайт');
    assert.equal(planLabel('control_plus'), 'Контроль+');
    assert.equal(yesNo(ago(1)), 'так');
    assert.equal(yesNo(null), 'ні');
});

test('дати: Europe/Kyiv, ДД.ММ.РРРР ГГ:ХХ (літній і зимовий час, північ)', () => {
    assert.equal(formatKyivStamp('2026-07-01T09:05:00Z'), '01.07.2026 12:05', 'літо UTC+3');
    assert.equal(formatKyivStamp('2026-11-20T12:00:00Z'), '20.11.2026 14:00', 'зима UTC+2');
    assert.equal(formatKyivStamp('2026-12-31T22:30:00Z'), '01.01.2027 00:30');
    assert.equal(formatKyivStamp(null), '—');
    assert.equal(formatKyivStamp('нісенітниця'), '—');
});

test('міграція *_sa_user_activity.sql: шапка, лише читання (без UPDATE / DELETE / INSERT), перевірка суперадміна першою, гранти', () => {
    const dir = path.join(APP, '../../supabase/migrations');
    const file = fs.readdirSync(dir).filter((f) => /^\d{14}_sa_user_activity\.sql$/.test(f));
    assert.equal(file.length, 1);
    assert.ok(file[0] > '20261129090000');
    const sql = fs.readFileSync(path.join(dir, file[0]), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(sql.split('\n')[0], '-- Apply manually after review. This file is not applied to any database by the agent.');
    const code = sql.replace(/^\s*--.*$/gm, '');
    assert.equal(/\b(UPDATE|DELETE|INSERT|TRUNCATE|ALTER|DROP)\b/i.test(code), false, 'жодних UPDATE / DELETE / INSERT / DDL окрім CREATE OR REPLACE');
    assert.match(code, /CREATE OR REPLACE FUNCTION public\.sa_list_user_activity\(p_days integer DEFAULT 30\)/);
    assert.match(code, /SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    const body = code.slice(code.indexOf('BEGIN'));
    assert.match(body, /^BEGIN\s+IF NOT public\.is_platform_superadmin\(\) THEN\s+RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';/, 'перевірка суперадміна — першим ділом');
    assert.match(code, /REVOKE ALL ON FUNCTION public\.sa_list_user_activity\(integer\) FROM PUBLIC, anon;/);
    assert.match(code, /GRANT EXECUTE ON FUNCTION public\.sa_list_user_activity\(integer\) TO authenticated;/);
});

test('UI: вкладка «Активність» читає лише sa_list_user_activity, service_role не згадується, api/ = 12', () => {
    const view = read('src/views/superadmin/activity.js');
    assert.deepEqual([...new Set([...view.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]))], ['sa_list_user_activity']);
    assert.equal(/service_role|\.from\(|confirm\(|alert\(|innerHTML/.test(view + read('src/lib/sa-activity.js')), false);
    assert.match(read('src/views/superadmin/index.js'), /'Активність'/);
    const css = read('src/kp-superadmin.css');
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css.slice(css.indexOf('/* Вкладки кабінету'))), false, 'кольори лише з токенів теми');
    assert.equal(/btn-block/.test(view), false);
    const files = fs.readdirSync(path.join(APP, 'api'), { recursive: true }).map((f) => String(f).split(String.fromCharCode(92)).join('/')).filter((f) => /\.(js|mjs|cjs|ts)$/.test(f));
    assert.equal(files.length, 12, files.join(', '));
});
