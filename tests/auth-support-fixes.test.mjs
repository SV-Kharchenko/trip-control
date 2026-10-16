import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const { userIsBlocked, userAccessStatus, USER_BLOCKED_ERROR } = await import('../lib/account-block.js');
const notify = await import('../lib/signup-notify.js');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start + ' … ' + end);
    return source.slice(from, to);
}

function extractFunction(name, params) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) return new Function(...params, html.slice(open + 1, i));
        }
    }
    throw new Error('unclosed ' + name);
}

test('1–2: login and signup are one segmented switch with a single submit and no compass', () => {
    const card = sliceBetween(html, '<div class="auth-tabs" role="tablist"', '<form id="auth-recovery-form"');
    assert.match(card, /id="auth-tab-login"[^>]*>Вхід<\/button>/);
    assert.match(card, /id="auth-tab-signup"[^>]*>Реєстрація<\/button>/);
    assert.equal((card.match(/type="submit"/g) || []).length, 1);
    assert.equal(html.includes('auth-signup-btn'), false);
    assert.equal(html.includes('🧭'), false);
    assert.match(card, /id="auth-login-btn"[^>]*>Увійти<\/button>/);
    assert.match(html, /\.auth-tabs \{[\s\S]*?padding: 3px;[\s\S]*?background: var\(--input-bg\);/);
});

test('3: every password field has a show/hide eye button', () => {
    for (const id of ['auth-password', 'auth-password2', 'auth-new-password', 'auth-new-password-2']) {
        assert.match(html, new RegExp("togglePasswordVisibility\\('" + id + "', this\\)"), id);
    }
    const toggle = extractFunction('togglePasswordVisibility', ['inputId', 'btn']);
    const input = { type: 'password' };
    const attrs = {};
    const btn = { setAttribute: (k, v) => { attrs[k] = v; } };
    globalThis.document = { getElementById: () => input };
    toggle('x', btn);
    assert.equal(input.type, 'text');
    assert.equal(attrs['aria-pressed'], 'true');
    toggle('x', btn);
    assert.equal(input.type, 'password');
    assert.equal(attrs['aria-label'], 'Показати пароль');
});

test('4: signup needs a matching repeated password before submit is enabled', () => {
    const sync = extractFunction('syncPasswordMatch', []);
    const els = {
        'auth-form': { dataset: { mode: 'signup' } },
        'auth-login-btn': { disabled: false },
        'auth-pass-match': { textContent: '', className: '' },
        'auth-password': { value: 'abc12345' },
        'auth-password2': { value: 'abc1234' }
    };
    globalThis.document = { getElementById: (id) => els[id] };
    assert.equal(sync(), false);
    assert.equal(els['auth-login-btn'].disabled, true);
    assert.equal(els['auth-pass-match'].textContent, 'Паролі не збігаються');
    assert.match(els['auth-pass-match'].className, /is-bad/);
    els['auth-password2'].value = 'abc12345';
    assert.equal(sync(), true);
    assert.equal(els['auth-login-btn'].disabled, false);
    assert.match(els['auth-pass-match'].textContent, /^✓/);
    els['auth-form'].dataset.mode = 'login';
    els['auth-password2'].value = '';
    assert.equal(sync(), true);
    assert.equal(els['auth-login-btn'].disabled, false);
    const auth = sliceBetween(html, 'async function handleAuth(type)', 'async function handleLogout()');
    assert.match(auth, /if \(!syncPasswordMatch\(\)\) \{ authMsg\.innerText = 'Паролі не збігаються\.'; return; \}/);
    assert.match(html, /\.auth-pass-match\.is-ok \{ color: var\(--positive\); \}/);
    assert.match(html, /\.auth-pass-match\.is-bad \{ color: var\(--negative\); \}/);
});

test('5: the Telegram signup alert is sent by the server, once, and never blocks signup', async () => {
    const auth = sliceBetween(html, 'async function handleAuth(type)', 'async function handleLogout()');
    assert.match(auth, /notifyOwnerAboutSignup\(data\.user\.id\)/);
    assert.equal(html.includes('api.telegram.org'), false);
    assert.equal(html.includes('TELEGRAM_BOT_TOKEN'), false);
    const client = extractFunction('notifyOwnerAboutSignup', ['userId']).toString();
    assert.match(client, /\.catch\(function \(\) \{\}\)/);

    const now = Date.parse('2026-10-16T10:00:00Z');
    const user = {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'owner@example.com',
        created_at: '2026-10-16T09:58:00Z',
        app_metadata: {},
        user_metadata: { company_name: 'ТОВ Ромашка', work_mode: 'team', ownership: 'tov' }
    };
    assert.equal(notify.shouldNotifySignup(user, now), true);
    assert.equal(notify.shouldNotifySignup({ ...user, app_metadata: { signup_notified_at: 'x' } }, now), false);
    assert.equal(notify.shouldNotifySignup({ ...user, created_at: '2026-10-15T09:00:00Z' }, now), false);
    const text = notify.signupMessage(user, null);
    assert.match(text, /Email: owner@example\.com/);
    assert.match(text, /Компанія: ТОВ Ромашка/);
    assert.match(text, /Режим роботи: З логістами/);
    assert.match(text, /Форма: ТОВ/);
    assert.match(notify.signupMessage({ ...user, user_metadata: { work_mode: 'solo', ownership: 'fop' } }, { name: 'ФОП Іван' }), /Компанія: ФОП Іван\nРежим роботи: Сам\nФорма: ФОП/);

    assert.equal(notify.telegramConfig({}), null);
    await assert.rejects(notify.sendTelegram('x', { env: {}, fetch: async () => ({ ok: true }) }), { code: 'TELEGRAM_UNCONFIGURED' });
    const calls = [];
    const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' };
    await notify.sendTelegram(text, { env, fetch: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; } });
    assert.equal(calls[0][0], 'https://api.telegram.org/bot123:abc/sendMessage');
    assert.equal(calls[0][1].chat_id, '42');
    await assert.rejects(notify.sendTelegram(text, { env, fetch: async () => ({ ok: false, status: 400 }) }), { code: 'TELEGRAM_FAILED' });

    const api = read('api/signup-notify.js');
    assert.match(api, /signup_notified_at/);
    assert.match(api, /return res\.status\(200\)\.json\(\{ ok: false \}\);\n    \}\n\}/);
});

test('6: help opens a support modal instead of mailto', () => {
    const modal = sliceBetween(html, '<div id="tc-help-modal"', '<div id="tc-toast"');
    assert.match(modal, /role="dialog" aria-modal="true"/);
    assert.match(modal, /href="mailto:tripcontrol\.com@gmail\.com"/);
    assert.match(modal, /href="tel:\+380966888252"/);
    assert.match(modal, /Viber · Telegram · WhatsApp/);
    assert.match(modal, /href="viber:\/\/chat\?number=%2B380966888252"/);
    assert.match(modal, /href="https:\/\/t\.me\/\+380966888252"/);
    assert.match(modal, /href="https:\/\/wa\.me\/380966888252"/);
    assert.match(modal, /onclick="if \(event\.target === this\) closeHelpModal\(\)"/);
    assert.match(modal, /class="tc-modal-close" aria-label="Закрити" onclick="closeHelpModal\(\)">✕</);
    assert.equal(html.includes('support@trip-control.com'), false);
    const keys = sliceBetween(html, 'function closeHelpModal()', 'function openHeaderCompany()');
    assert.match(keys, /event\.key === 'Escape'/);
    assert.match(html, /@media \(max-width: 480px\) \{\n\s+\.tc-modal \{ align-items: flex-end;/);
});

test('7: recent routes are stored per user and the shared key is dropped', () => {
    assert.match(html, /const RECENT_ROUTES_KEY = 'tc_recent_routes_v1';/);
    const keyFn = extractFunction('recentRoutesKey', []);
    globalThis.RECENT_ROUTES_KEY = 'tc_recent_routes_v1';
    globalThis.currentUserId = 'u-1';
    assert.equal(keyFn(), 'tc_recent_routes_v1:u-1');
    globalThis.currentUserId = null;
    assert.equal(keyFn(), null);
    const recent = sliceBetween(html, 'function recentRoutesKey()', 'function setPlaceText(');
    assert.match(recent, /localStorage\.removeItem\(RECENT_ROUTES_KEY\)/);
    assert.equal(/localStorage\.(get|set)Item\(RECENT_ROUTES_KEY/.test(html), false);
    assert.match(html, /window\.onload = function\(\) \{\n\s+dropLegacyRecentRoutes\(\);/);
    const auth = sliceBetween(html, 'supabaseClient.auth.onAuthStateChange(', 'let currentSessionToken');
    assert.match(auth, /event === 'SIGNED_OUT'/);
    assert.match(auth, /nextUserId !== currentUserId/);
    assert.match(auth, /resetUserScopedState\(\);\n\s+setTimeout\(function \(\) \{ checkUserAccess\(\); \}, 0\);/);
    const reset = sliceBetween(html, 'function resetUserScopedState()', 'let calcRequestId');
    assert.match(reset, /savedCalculations = \[\];/);
    assert.match(reset, /getElementById\('saved-recent'\)/);
    assert.match(sliceBetween(html, 'async function handleLogout()', '// ЛОГІКА КАЛЬКУЛЯТОРА'), /resetUserScopedState\(\);/);
});

test('8: with VAT the tax row shows VAT for reference and the totals stay the same', () => {
    globalThis.vatAmountOf = extractFunction('vatAmountOf', ['result']);
    const rows = extractFunction('cascadeRows', ['result', 'opts']);
    const result = { grossIncome: 120000, netIncome: 100000, marginalIncome: 60000, ebitda: 40000, netProfit: 30000 };
    const plain = rows(result);
    const vat = rows(result, { vat: true });
    assert.equal(vat.length, plain.length + 1);
    assert.deepEqual(vat[1], { key: '− ПДВ (довідково)', amount: 20000, tone: 'muted' });
    assert.equal(vat[vat.length - 1].amount, 30000);
    const apply = sliceBetween(html, 'function applyCalcResult(', 'async function calculate()');
    assert.match(apply, /lastCalcVatMode = !!\(payload && payload\.calcType === 'безготівковий'\);/);
    assert.match(apply, /ПДВ, довідково — вже виключено з чистого доходу/);
    assert.match(apply, /sum \+ \(isVatRow\(r\) \? 0 : r\.val\)/);
    assert.match(apply, /<td>—<\/td>/);
    assert.match(apply, /renderChart\(result\.fuelAndAdblueTotal, result\.driverTotal, result\.toTotal, result\.overheadTotal, result\.taxesTotal, result\.extrasTotal\)/);
    assert.equal(read('api/calculate.js').includes('vatAmount'), false);
});

test('9: fleet cards offer only real AdBlue and trailer choices', () => {
    assert.equal(html.includes('Як у компанії'), false);
    const markup = sliceBetween(html, 'function fleetNormMarkup(vehicle, owner)', 'function readFleetNorms(id)');
    assert.match(markup, /\[\['on', 'Є'\], \['off', 'Немає'\]\]/);
    assert.match(markup, /data-norm="trailer_type" required/);
    const norms = sliceBetween(html, 'function readFleetNorms(id)', 'function emptyFleetNorms()');
    assert.match(norms, /AdBlue: оберіть «Є» або «Немає»\./);
    assert.match(norms, /Оберіть тип причепа\./);
    const migration = read('supabase/migrations/20261016120000_fleet_adblue_trailer_required.sql');
    assert.match(migration, /SET adblue_on = true\nWHERE adblue_on IS NULL;/);
    assert.match(migration, /'зерновоз'\n\)\nWHERE v\.trailer_type IS NULL;/);
    assert.match(migration, /not applied to production by the agent/);
});

test('10: saves show one shared toast with a success or an error tone', () => {
    assert.match(html, /function notifySaved\(\) \{\n\s+showToast\('✓ Збережено', 2500, 'ok'\);/);
    assert.match(html, /showToast\('Помилка збереження: ' \+ text, 4000, 'error'\);/);
    assert.match(html, /#tc-toast \{[\s\S]*?z-index: 13000;/);
    const fleet = sliceBetween(html, 'async function saveFleetVehicle(id)', 'async function removeFleetVehicle(id)');
    assert.equal((fleet.match(/notifySaved\(\)/g) || []).length, 2);
    assert.match(fleet, /notifySaveError\(fleetWriteError\(e\)\)/);
    const cab = sliceBetween(html, 'async function saveCabinet()', 'let lastExport = null;');
    assert.match(cab, /notifySaved\(\);/);
    assert.match(cab, /notifySaveError\(e && e\.message \? e\.message : e\);/);
});

test('11: admins set one status per user and a blocked user is stopped everywhere', () => {
    const now = Date.parse('2026-10-16T10:00:00Z');
    assert.equal(userIsBlocked({ banned_until: '2126-01-01T00:00:00Z' }, now), true);
    assert.equal(userIsBlocked({ banned_until: '2020-01-01T00:00:00Z' }, now), false);
    assert.equal(userIsBlocked({}, now), false);
    assert.equal(userAccessStatus({ banned_until: '2126-01-01T00:00:00Z' }, { is_approved: true }, now), 'blocked');
    assert.equal(userAccessStatus({}, { is_approved: true }, now), 'full');
    assert.equal(userAccessStatus({}, { is_approved: false }, now), 'demo');
    assert.equal(USER_BLOCKED_ERROR.error, 'Акаунт заблоковано, зверніться в підтримку.');

    const admin = read('api/admin.js');
    assert.match(admin, /action === 'set_user_status'/);
    assert.match(admin, /ban_duration: BLOCK_BAN_DURATION/);
    assert.match(admin, /ban_duration: 'none'/);
    assert.match(admin, /target\.role === 'admin'/);
    assert.match(admin, /audit\(admin\.user\.id, 'set_user_status'/);
    assert.match(admin, /action === 'set_org_status'/);
    for (const file of ['api/calculate.js', 'api/poi.js', 'api/team.js']) {
        assert.match(read(file), /userIsBlocked\(user\)/, file);
    }

    const crm = sliceBetween(html, 'async function loadAdminCrm()', 'async function adminSetOrgStatus(');
    assert.match(crm, /onchange="adminSetUserStatus\(this\)"/);
    assert.match(crm, /\['full', 'Повний доступ'\], \['demo', 'Демо'\], \['blocked', 'Заблоковано'\]/);
    assert.match(crm, /window\.confirm\('Заблокувати '/);
    assert.match(crm, /showToast\('✓ Статус: '/);
    assert.match(crm, /Блок org/);
    assert.equal(html.includes('adminSetApproved'), false);

    assert.match(html, /function accountBlockedHtml\(\)[\s\S]*?Акаунт заблоковано, зверніться в підтримку\.[\s\S]*?tripcontrol\.com@gmail\.com[\s\S]*?\+380966888252/);
    assert.match(html, /errInfo\.code === 'USER_BLOCKED'\) \{\n\s+showAccountBlocked\(\);/);
    assert.match(html, /if \(authUserBlocked\(session\.user\)\) \{\n\s+showAccountBlocked\(\);/);
    assert.match(html, /if \(error && isBannedAuthError\(error\)\) \{\n\s+authMsg\.innerHTML = accountBlockedHtml\(\);/);
});
