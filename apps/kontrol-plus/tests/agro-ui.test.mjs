// Кнопка «АГРО» і адмін-перемикач доступу: bridge.js (agro_access_me), shell.js, довідник кабінету «Платформа». Без браузера.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AGRO_CHOICES, MODULES, actionLabel, agroChoiceArg, agroChoiceValue, agroEffectiveText, auditTarget, superadminErrorText } from '../src/lib/superadmin.js';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('bridge: кнопку вмикає лише rpc agro_access_me() === true; помилка RPC / немає функції / вихід → схована; токен видає лише /api/agro/sso', () => {
    const bridge = read('src/bridge.js');
    assert.match(bridge, /rpc\('agro_access_me'\)/);
    assert.match(bridge, /parseFlag\(await state\.supabase\.rpc\('agro_access_me'\)\)/);
    assert.match(read('src/lib/flag-check.js'), /response\.data === true\) return true;/);
    assert.match(bridge, /window\.tcKpAgro = value;/);
    assert.match(bridge, /window\.tcKpOpenAgro = \(\) => callKpApi\(\{ supabase: state\.supabase \}, '\/api\/agro\/sso', \{\}\);/);
    // Перевірка після входу (refreshGpsTab) і скидання при виході / зміні користувача.
    assert.match(bridge, /async function refreshGpsTab\(\) \{\n\s+ensureAgro\(\)\.catch/);
    assert.match(bridge, /state\.superadminUser = null;\n\s+superadminCheck\.cancel\(\);\n\s+agroCheck\.cancel\(\);\n\s+setAgro\(false, null\);/);
    // Токен у клієнті не зʼявляється: лише url із відповіді.
    assert.equal(/AGRO_SSO_SECRET|jsonwebtoken|createHmac/.test(bridge + read('src/shell.js')), false);
});

test('shell: «АГРО» у шапці перед назвою компанії й у шторці бургер-меню; блокується на час запиту; помилка — тост; перехід лише location.assign(url)', () => {
    const shell = read('src/shell.js');
    assert.match(shell, /const agroTop = agroBtn\('kp-shell-agro'\);/);
    assert.match(shell, /const agroSide = agroBtn\('kp-shell-agro kp-shell-agro-m'\);/);
    assert.match(shell, /h\('span', \{ class: 'kp-shell-grow' \}\), agroTop, companyEl, bell, who\)/);
    assert.match(shell, /nav, agroSide\);/);
    assert.match(shell, /win\.location\.assign\(out\.url\)/);
    assert.match(shell, /toast\(\(out && out\.error\)/);
    assert.match(shell, /btn\.hidden = win\.tcKpAgro !== true/);
    assert.match(shell, /win\.addEventListener\('tc-kp-agro', scheduleUpdate\)/);
    const css = read('src/kp-shell.css');
    assert.match(css, /body\.kp-shell-on \.kp-shell-agro-m \{ display: none; \}/);
    // Телефон (< 900px): у шапці кнопки нема, у шторці є на всю ширину.
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    assert.match(phone, /body\.kp-shell-on \.kp-shell-agro \{ display: none; \}/);
    assert.match(phone, /\.kp-shell-agro\.kp-shell-agro-m \{ display: inline-flex; align-items: center; justify-content: center; width: auto/);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css.slice(css.indexOf('«Park-Control»'), css.indexOf('body.kp-shell-on .kp-shell-bell {'))), false, 'кольори лише змінними');
});

test('кабінет «Платформа»: модуль AGRO у довіднику, підписи журналу й помилок, вибір «Як у компанії / Дозволено / Заборонено»', () => {
    assert.deepEqual(MODULES.map((m) => m.key), ['own_fleet', 'agro']);
    const agro = MODULES.find((m) => m.key === 'agro');
    assert.equal(agro.label, 'Park-Control');
    assert.equal(agro.desc, 'Вхід в Park-Control із Контроль+ без повторного логіну.');
    assert.deepEqual(AGRO_CHOICES, [['', 'Як у компанії'], ['true', 'Дозволено'], ['false', 'Заборонено']]);
    assert.deepEqual([null, true, false].map(agroChoiceValue), ['', 'true', 'false']);
    assert.deepEqual(['', 'true', 'false'].map(agroChoiceArg), [null, true, false]);
    assert.equal(agroEffectiveText({ allowed: true, reason: 'org' }), 'Доступ є · за прапорцем компанії');
    assert.equal(agroEffectiveText({ allowed: false, reason: 'org_blocked' }), 'Доступу немає · компанію заблоковано');
    assert.equal(actionLabel('user.agro.set'), 'Доступ до Park-Control (користувач)');
    assert.equal(auditTarget({ target_type: 'user', target_id: '12345678-aaaa' }), 'Користувач 12345678 · Park-Control');
    assert.match(superadminErrorText({ message: 'SA_USER_NOT_FOUND' }), /Користувача не знайдено/);
});

test('кабінет: блок користувачів AGRO — лише sa_list_org_agro_users / sa_set_user_agro, підтвердження через tcModal, без прямих таблиць', () => {
    const view = read('src/views/superadmin/index.js');
    assert.match(view, /rpc\('sa_list_org_agro_users', \{ p_org: org\.id \}\)/);
    assert.match(view, /rpc\('sa_set_user_agro', \{ p_user: row\.user_id, p_allowed: allowed \}\)/);
    assert.ok(view.indexOf('confirmDialog({\n                title: \'Доступ до AGRO для') < view.indexOf("rpc('sa_set_user_agro'"));
    assert.equal(/agro_user_access/.test(view), false);
});

test('міграція: AGRO вимкнений за замовчуванням, таблиця лише для service_role, agro_access_me не віддає причин', () => {
    const sql = read('../../supabase/migrations/20261127090000_agro_access.sql');
    assert.match(sql, /INSERT INTO public\.app_settings \(key, enabled\) VALUES \('agro', false\) ON CONFLICT \(key\) DO NOTHING;/);
    assert.match(sql, /REVOKE ALL ON public\.agro_user_access FROM PUBLIC, anon, authenticated;\nGRANT ALL ON public\.agro_user_access TO service_role;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.agro_access_for\(uuid\) TO service_role;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.agro_access_for\(uuid\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /SELECT coalesce\(\(public\.agro_access_for\(auth\.uid\(\)\) ->> 'allowed'\)::boolean, false\);/);
    assert.equal(/sa_set_org_feature/.test(sql.replace(/^\s*--.*$/gm, '')), false, 'sa_set_org_feature не змінюємо');
});

test('bridge: кеш agro_access_me скидається при зміні сесії й при поверненні вкладки у фокус (visibilitychange), без поллінгу', () => {
    const bridge = read('src/bridge.js');
    assert.match(bridge, /function invalidateAgro\(force = false\)/);
    assert.match(bridge, /state\.agroUser = null;\n\s+ensureAgro\(\)/);
    assert.match(bridge, /else if \(session && \(event === 'SIGNED_IN' \|\| event === 'USER_UPDATED'\)\) \{\n[^\n]*\n\s+setTimeout\(\(\) => invalidateAgro\(true\), 0\);/);
    assert.match(bridge, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) \{ invalidateAgro\(\); recheckFlags\(\); \} \}\)/);
    // Щоразу, коли вкладка стає видимою, — не частіше ніж раз на 5 с; setInterval для AGRO немає.
    assert.match(bridge, /const AGRO_RECHECK_MS = 5000;/);
    const agroPart = bridge.slice(bridge.indexOf('const AGRO_RECHECK_MS'), bridge.indexOf('async function ensureSuperadmin'));
    assert.equal(/setInterval|setTimeout\(.*loadAgro/.test(agroPart), false);
});

test('міграція: sa_list_org_agro_users рахує agro_access_for один раз на рядок (LATERAL)', () => {
    const sql = read('../../supabase/migrations/20261127090000_agro_access.sql');
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.sa_list_org_agro_users'));
    assert.match(body, /CROSS JOIN LATERAL \(SELECT public\.agro_access_for\(p\.id\) AS acc\) AS x/);
    assert.equal((body.match(/agro_access_for\(/g) || []).length, 1, 'один виклик у функції');
});
