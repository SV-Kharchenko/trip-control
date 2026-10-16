import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createTelegramWebhookHandler, withStatusLine, parseUserCommand, isOwnerChat } = await import('../lib/telegram-admin.js');
const { statusKeyboard, signupMessage } = await import('../lib/signup-notify.js');
const { setUserStatus } = await import('../lib/user-status.js');
const { calculateTrip } = await import('../api/calculate.js');

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const OWNER_CHAT = '777000';
const SECRET = 'hook_secret-123';
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: OWNER_CHAT, TELEGRAM_WEBHOOK_SECRET: SECRET };
const USER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-16T11:05:00Z'); // 14:05 за Києвом

// Мінімальний service-role клієнт: profiles, organizations, calculations, security_audit_log, auth.admin.
function fakeSupabase() {
    const db = {
        profiles: {
            [USER]: { id: USER, org_id: ORG, role: 'user', is_approved: false },
            [ADMIN]: { id: ADMIN, org_id: ORG, role: 'admin', is_approved: true }
        },
        organizations: { [ORG]: { id: ORG, name: 'ТОВ Агро' } },
        auth: {
            [USER]: { id: USER, email: 'driver@agro.ua', created_at: '2026-10-01T08:00:00Z', banned_until: null },
            [ADMIN]: { id: ADMIN, email: 'admin@trip-control.com', created_at: '2026-01-01T08:00:00Z', banned_until: null }
        },
        calcCount: { [USER]: 4 },
        audit: [],
        authUpdates: []
    };
    function query(table) {
        const state = { filters: {}, update: null, head: false };
        const rows = () => {
            const source = table === 'profiles' ? db.profiles : table === 'organizations' ? db.organizations : {};
            return Object.values(source).filter((row) => Object.entries(state.filters).every(([k, v]) => row[k] === v));
        };
        const run = () => {
            if (table === 'calculations') return { data: null, count: db.calcCount[state.filters.user_id] || 0, error: null };
            if (state.update) {
                rows().forEach((row) => Object.assign(row, state.update));
                return { data: null, error: null };
            }
            return { data: rows(), error: null };
        };
        const builder = {
            select(cols, opts) { state.head = !!(opts && opts.head); return builder; },
            update(values) { state.update = values; return builder; },
            insert(row) { if (table === 'security_audit_log') db.audit.push(row); return Promise.resolve({ error: null }); },
            eq(col, val) { state.filters[col] = val; return builder; },
            single() { return Promise.resolve({ data: rows()[0] || null, error: rows()[0] ? null : { code: 'PGRST116' } }); },
            maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
            then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
        };
        return builder;
    }
    return {
        db,
        from: query,
        auth: {
            admin: {
                async getUserById(id) { return { data: { user: db.auth[id] || null }, error: null }; },
                async updateUserById(id, attrs) {
                    db.authUpdates.push([id, attrs]);
                    if (attrs.ban_duration === 'none') db.auth[id].banned_until = null;
                    else if (attrs.ban_duration) db.auth[id].banned_until = '2126-10-16T00:00:00Z';
                    return { data: { user: db.auth[id] }, error: null };
                },
                async listUsers() { return { data: { users: Object.values(db.auth) }, error: null }; }
            }
        }
    };
}

function harness() {
    const supabase = fakeSupabase();
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ method: url.split('/').pop(), url, body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
    };
    const handler = createTelegramWebhookHandler({ supabase, fetch, env: ENV, now: () => NOW });
    async function send(update, secret = SECRET) {
        const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ method: 'POST', headers: secret == null ? {} : { 'x-telegram-bot-api-secret-token': secret }, body: update }, res);
        return res;
    }
    return { supabase, calls, send };
}

const ownerChat = { id: Number(OWNER_CHAT), type: 'private' };
const ownerFrom = { id: Number(OWNER_CHAT), is_bot: false, first_name: 'Owner' };

function callback(data, overrides = {}) {
    return {
        update_id: 1,
        callback_query: {
            id: 'cb-1',
            from: overrides.from || ownerFrom,
            data,
            message: {
                message_id: 55,
                chat: overrides.chat || ownerChat,
                text: signupMessage({ email: 'driver@agro.ua', user_metadata: { company_name: 'ТОВ Агро' } }, null),
                reply_markup: statusKeyboard(USER)
            }
        }
    };
}

test('wrong or missing webhook secret → 401 and nothing happens', async () => {
    const h = harness();
    for (const secret of ['wrong', '', null, SECRET + 'x']) {
        const res = await h.send(callback('st:blocked:' + USER), secret);
        assert.equal(res.code, 401, String(secret));
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.supabase.db.authUpdates.length, 0);
    assert.equal(h.supabase.db.audit.length, 0);

    const noSecret = createTelegramWebhookHandler({ supabase: fakeSupabase(), fetch: async () => ({ ok: true }), env: { ...ENV, TELEGRAM_WEBHOOK_SECRET: '' } });
    const res = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };
    await noSecret({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': '' }, body: {} }, res);
    assert.equal(res.code, 401, 'no configured secret never authorizes');
});

test('updates from another chat or sender are silently ignored with 200', async () => {
    const h = harness();
    const strangerChat = { id: 999, type: 'private' };
    const strangerFrom = { id: 999, is_bot: false, first_name: 'X' };
    for (const update of [
        callback('st:blocked:' + USER, { chat: strangerChat, from: strangerFrom }),
        callback('st:blocked:' + USER, { from: strangerFrom }),
        { update_id: 2, message: { message_id: 1, chat: strangerChat, from: strangerFrom, text: '/user driver@agro.ua' } },
        { update_id: 3, message: { message_id: 1, chat: { id: -100500, type: 'group' }, from: ownerFrom, text: '/user driver@agro.ua' } }
    ]) {
        const res = await h.send(update);
        assert.equal(res.code, 200);
    }
    assert.equal(h.calls.length, 0, 'no reply to strangers');
    assert.equal(h.supabase.db.authUpdates.length, 0);
    assert.equal(h.supabase.db.audit.length, 0);
    assert.equal(isOwnerChat({ message: { chat: ownerChat, from: ownerFrom } }, OWNER_CHAT), true);
});

test('in a group with TELEGRAM_CHAT_ID only the owner acts; other members get silence', async () => {
    const group = { id: Number(OWNER_CHAT), type: 'supergroup', title: 'TRIP-CONTROL' };
    const member = { id: 424242, is_bot: false, first_name: 'Member' };
    const h = harness();
    for (const update of [
        callback('st:blocked:' + USER, { chat: group, from: member }),
        callback('st:full:' + USER, { chat: { ...group, type: 'group' }, from: member }),
        { update_id: 9, message: { message_id: 2, chat: group, from: member, text: '/user driver@agro.ua' } },
        { update_id: 10, message: { message_id: 3, chat: group, text: '/user driver@agro.ua' } }
    ]) {
        const res = await h.send(update);
        assert.equal(res.code, 200);
        assert.deepEqual(res.body, { ok: true });
    }
    assert.equal(h.calls.length, 0, 'no reply, no answerCallbackQuery');
    assert.equal(h.supabase.db.authUpdates.length, 0, 'status unchanged');
    assert.equal(h.supabase.db.profiles[USER].is_approved, false);
    assert.equal(h.supabase.db.audit.length, 0, 'no audit rows');
    assert.equal(isOwnerChat({ message: { chat: group, from: member } }, OWNER_CHAT), false);
    assert.equal(isOwnerChat({ message: { chat: group, from: ownerFrom } }, OWNER_CHAT), true);
});

test('an audit insert error is logged by code only and does not undo the status change', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => { warnings.push(args); });
    const h = harness();
    const realFrom = h.supabase.from;
    h.supabase.from = (table) => {
        const builder = realFrom(table);
        if (table === 'security_audit_log') {
            builder.insert = async () => ({ data: null, error: { code: '42501', message: 'permission denied for table security_audit_log', details: 'row 1' } });
        }
        return builder;
    };
    const res = await h.send(callback('st:blocked:' + USER));
    assert.equal(res.code, 200);
    assert.equal(h.supabase.db.auth[USER].banned_until !== null, true, 'status changed');
    assert.equal(h.calls.find((c) => c.method === 'answerCallbackQuery').body.text, 'Статус: Заблоковано');
    assert.equal(h.calls.some((c) => c.method === 'editMessageText'), true);
    assert.deepEqual(warnings, [['audit insert failed', '42501']]);

    warnings.length = 0;
    const thrown = fakeSupabase();
    const realThrownFrom = thrown.from;
    thrown.from = (table) => {
        const builder = realThrownFrom(table);
        if (table === 'security_audit_log') builder.insert = async () => { throw Object.assign(new Error('socket hang up at 10.0.0.1'), { code: 'ECONNRESET' }); };
        return builder;
    };
    const result = await setUserStatus(thrown, { userId: USER, status: 'full', actor: ADMIN, source: 'admin' });
    assert.equal(result.status, 'full');
    assert.equal(thrown.db.profiles[USER].is_approved, true);
    assert.deepEqual(warnings, [['audit insert failed', 'ECONNRESET']]);
});

test('status buttons switch demo → full → blocked → demo through the shared logic', async () => {
    const h = harness();
    const { db } = h.supabase;

    let res = await h.send(callback('st:full:' + USER));
    assert.equal(res.code, 200);
    assert.equal(db.profiles[USER].is_approved, true);
    assert.equal(db.auth[USER].banned_until, null);
    assert.deepEqual(db.audit[0], {
        actor: null, org_id: ORG, action: 'set_user_status', entity: 'profiles', entity_id: USER,
        detail: { status: 'full', previous: 'demo', source: 'telegram', telegram_user_id: Number(OWNER_CHAT) }
    });
    const answer = h.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.deepEqual(answer.body, { callback_query_id: 'cb-1', text: 'Статус: Повний доступ' });
    const edit = h.calls.find((c) => c.method === 'editMessageText');
    assert.equal(edit.body.chat_id, Number(OWNER_CHAT));
    assert.equal(edit.body.message_id, 55);
    assert.match(edit.body.text, /🆕 Нова реєстрація/);
    assert.match(edit.body.text, /\nСтатус: Повний доступ · 16\.10\.2026, 14:05$/);
    assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] }, 'buttons are removed after a successful change');

    res = await h.send(callback('st:blocked:' + USER));
    assert.equal(db.auth[USER].banned_until !== null, true);
    assert.deepEqual(db.authUpdates.at(-1), [USER, { ban_duration: '876000h' }]);
    assert.equal(db.audit[1].detail.status, 'blocked');
    assert.equal(db.audit[1].detail.previous, 'full');
    assert.match(h.calls.filter((c) => c.method === 'editMessageText').at(-1).body.text, /Статус: Заблоковано · /);

    res = await h.send(callback('st:demo:' + USER));
    assert.equal(db.auth[USER].banned_until, null);
    assert.deepEqual(db.authUpdates.at(-1), [USER, { ban_duration: 'none' }]);
    assert.equal(db.profiles[USER].is_approved, false);
    assert.equal(db.audit[2].detail.previous, 'blocked');
    const lastText = h.calls.filter((c) => c.method === 'editMessageText').at(-1).body.text;
    assert.equal(lastText.match(/Статус: /g).length, 1, 'status line is replaced, not stacked');
    const edits = h.calls.filter((c) => c.method === 'editMessageText');
    assert.equal(edits.length, 3);
    for (const e of edits) assert.deepEqual(e.body.reply_markup, { inline_keyboard: [] }, 'no buttons after each change');
});

test('the admin account cannot be changed from Telegram', async () => {
    const h = harness();
    await h.send(callback('st:blocked:' + ADMIN));
    assert.equal(h.supabase.db.auth[ADMIN].banned_until, null);
    assert.equal(h.supabase.db.audit.length, 0);
    const answer = h.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.equal(answer.body.text, 'Статус адміністратора не змінюється.');
    assert.equal(answer.body.show_alert, true);
    assert.equal(h.calls.some((c) => c.method === 'editMessageText'), false);
});

test('errors reach the chat as a short message without internals', async () => {
    const h = harness();
    h.supabase.auth.admin.updateUserById = async () => ({ error: Object.assign(new Error('db exploded at /var/task/x.js token=123:abc'), { status: 500 }) });
    await h.send(callback('st:blocked:' + USER));
    const answer = h.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.equal(answer.body.text, 'Не вдалося змінити статус. Спробуйте ще раз.');
    assert.equal(JSON.stringify(h.calls).includes('exploded'), false);
    assert.equal(h.calls.some((c) => /^editMessage/.test(c.method)), false, 'on error the message and its buttons stay as they were');

    const bad = await h.send(callback('st:root:' + USER));
    assert.equal(bad.code, 200);
    assert.equal(h.calls.at(-1).body.text, 'Невідома дія.');
});

test('/user <email> sends a card with the same buttons', async () => {
    const h = harness();
    await h.send({ update_id: 4, message: { message_id: 9, chat: ownerChat, from: ownerFrom, text: '/user Driver@Agro.ua' } });
    const card = h.calls.at(-1);
    assert.equal(card.method, 'sendMessage');
    assert.equal(card.body.chat_id, Number(OWNER_CHAT));
    assert.equal(card.body.text, [
        '👤 Користувач',
        'Email: driver@agro.ua',
        'Компанія: ТОВ Агро',
        'Розрахунків: 4',
        'Зареєстровано: 01.10.2026',
        '',
        'Статус: Демо'
    ].join('\n'));
    assert.deepEqual(card.body.reply_markup, statusKeyboard(USER));

    await h.send({ update_id: 5, message: { message_id: 10, chat: ownerChat, from: ownerFrom, text: '/user admin@trip-control.com' } });
    assert.match(h.calls.at(-1).body.text, /Статус: Адміністратор \(не змінюється\)/);
    assert.equal(h.calls.at(-1).body.reply_markup, undefined);

    await h.send({ update_id: 6, message: { message_id: 11, chat: ownerChat, from: ownerFrom, text: '/user nobody@example.com' } });
    assert.equal(h.calls.at(-1).body.text, 'Користувача nobody@example.com не знайдено.');

    await h.send({ update_id: 7, message: { message_id: 12, chat: ownerChat, from: ownerFrom, text: '/user' } });
    assert.equal(h.calls.at(-1).body.text, 'Вкажіть email: /user name@example.com');

    h.supabase.auth.admin.listUsers = async () => ({ data: null, error: new Error('secret internals') });
    await h.send({ update_id: 8, message: { message_id: 13, chat: ownerChat, from: ownerFrom, text: '/user driver@agro.ua' } });
    assert.equal(h.calls.at(-1).body.text, 'Не вдалося отримати дані користувача. Спробуйте пізніше.');
    assert.equal(parseUserCommand('/user@TripControlBot a@b.ua').email, 'a@b.ua');
});

test('signup notification carries the three status buttons', () => {
    const keyboard = statusKeyboard(USER);
    assert.deepEqual(keyboard.inline_keyboard[0].map((b) => b.text), ['✅ Повний доступ', '🧪 Демо', '⛔ Заблокувати']);
    assert.deepEqual(keyboard.inline_keyboard[0].map((b) => b.callback_data), ['st:full:' + USER, 'st:demo:' + USER, 'st:blocked:' + USER]);
    for (const b of keyboard.inline_keyboard[0]) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    assert.match(read('api/signup-notify.js'), /replyMarkup: statusKeyboard\(user\.id\)/);
    assert.equal(withStatusLine('A\nСтатус: Демо', 'full', NOW), 'A\n\nСтатус: Повний доступ · 16.10.2026, 14:05');
});

test('admin panel and Telegram share one status implementation', async () => {
    const admin = read('api/admin.js');
    const telegram = read('lib/telegram-admin.js');
    assert.match(admin, /import \{ setUserStatus, UserStatusError, writeAudit \} from '\.\.\/lib\/user-status\.js'/);
    assert.match(telegram, /from '\.\/user-status\.js'/);
    assert.equal(/ban_duration/.test(admin), false);
    assert.equal(/ban_duration/.test(telegram), false);
    const supabase = fakeSupabase();
    await setUserStatus(supabase, { userId: USER, status: 'full', actor: ADMIN, source: 'admin' });
    assert.equal(supabase.db.audit[0].actor, ADMIN);
    assert.equal(supabase.db.audit[0].detail.source, 'admin');
    const script = read('scripts/set-telegram-webhook.js');
    assert.match(script, /setWebhook/);
    assert.match(script, /secret_token: secret/);
    assert.match(read('api/telegram-webhook.js'), /createTelegramWebhookHandler/);
});

test('S0 regression: profit 6 687, tax 5 400', () => {
    const payload = JSON.parse(read('tests/fixtures/s0-fop.json'));
    const result = calculateTrip(payload);
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
    assert.equal(result.grossIncome, 90000);
});
