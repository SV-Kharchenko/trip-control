import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const tg = await import('../lib/telegram-admin.js');
const { statusKeyboard } = await import('../lib/signup-notify.js');
const { calculateTrip } = await import('../api/calculate.js');

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const OWNER_CHAT = '777000';
const SECRET = 'hook_secret-123';
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: OWNER_CHAT, TELEGRAM_WEBHOOK_SECRET: SECRET };
const NOW = Date.parse('2026-10-16T11:05:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ORG = '33333333-3333-4333-8333-333333333333';
const ownerChat = { id: Number(OWNER_CHAT), type: 'private' };
const ownerFrom = { id: Number(OWNER_CHAT), is_bot: false, first_name: 'Owner' };

const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

// 23 users: user N registered N days ago (user 1 is the newest).
// 1..3 blocked, 4..10 full, 11..22 demo, 23 is the platform admin.
function fixture() {
    const auth = [];
    const profiles = [];
    const calcs = [];
    for (let n = 1; n <= 23; n++) {
        const id = uid(n);
        auth.push({
            id,
            email: 'user' + String(n).padStart(2, '0') + '@agro.ua',
            created_at: new Date(NOW - n * DAY).toISOString(),
            banned_until: n <= 3 ? '2126-10-16T00:00:00Z' : null
        });
        profiles.push({ id, org_id: ORG, role: n === 23 ? 'admin' : 'user', is_approved: n >= 4 && n <= 10 || n === 23 });
        for (let k = 0; k < n % 4; k++) calcs.push({ id: calcs.length + 1, user_id: id });
    }
    // 1 500 calculations for user 4: counts must not stop at the 1 000-row PostgREST page.
    for (let k = 0; k < 1500; k++) calcs.push({ id: calcs.length + 1, user_id: uid(4) });
    return { auth, profiles, calculations: calcs, organizations: [{ id: ORG, name: 'ТОВ Агро' }] };
}

function fakeSupabase(db) {
    const log = [];
    function query(table) {
        const state = { eq: {}, in: null, range: null, head: false };
        log.push(table);
        const source = () => (db[table] || []).filter((row) =>
            Object.entries(state.eq).every(([k, v]) => row[k] === v) &&
            (!state.in || state.in[1].includes(row[state.in[0]])));
        const builder = {
            select(cols, opts) { state.head = !!(opts && opts.head); return builder; },
            eq(col, val) { state.eq[col] = val; return builder; },
            in(col, values) { state.in = [col, values]; return builder; },
            order() { return builder; },
            range(from, to) {
                state.range = [from, to];
                const rows = source();
                // PostgREST caps a response at 1 000 rows.
                return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null });
            },
            maybeSingle() { return Promise.resolve({ data: source()[0] || null, error: null }); },
            single() { return Promise.resolve({ data: source()[0] || null, error: null }); },
            then(resolve, reject) {
                const rows = source();
                return Promise.resolve(state.head ? { count: rows.length, data: null, error: null } : { data: rows.slice(0, 1000), error: null }).then(resolve, reject);
            }
        };
        return builder;
    }
    return {
        log,
        from: query,
        auth: {
            admin: {
                async listUsers({ page, perPage }) {
                    log.push('auth.listUsers');
                    return { data: { users: db.auth.slice((page - 1) * perPage, page * perPage) }, error: null };
                },
                async getUserById(id) {
                    log.push('auth.getUserById');
                    return { data: { user: db.auth.find((u) => u.id === id) || null }, error: null };
                },
                async updateUserById() { throw new Error('not expected'); }
            }
        }
    };
}

function harness() {
    const db = fixture();
    const supabase = fakeSupabase(db);
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ method: url.split('/').pop(), body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
    };
    const handler = tg.createTelegramWebhookHandler({ supabase, fetch, env: ENV, now: () => NOW });
    async function send(update) {
        const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: update }, res);
        return res;
    }
    const message = (text, chat = ownerChat, from = ownerFrom) => ({ update_id: 1, message: { message_id: 7, chat, from, text } });
    const callback = (data, chat = ownerChat, from = ownerFrom) => ({
        update_id: 2,
        callback_query: { id: 'cb', from, data, message: { message_id: 70, chat, text: 'list' } }
    });
    return { db, supabase, calls, send, message, callback };
}

const userRows = (markup) => markup.inline_keyboard.slice(0, -1);
const navRow = (markup) => markup.inline_keyboard.at(-1);

test('/users lists 10 per page, newest first, with totals and line format', async () => {
    const h = harness();
    await h.send(h.message('/users'));
    const sent = h.calls.at(-1);
    assert.equal(sent.method, 'sendMessage');
    const lines = sent.body.text.split('\n');
    assert.equal(lines[0], '👥 Користувачі');
    assert.equal(lines[1], 'Всього 23 · Повний 8 · Демо 12 · Заблоковано 3');
    assert.equal(lines.filter((l) => /^\d+\. /.test(l)).length, 10);
    assert.equal(lines[3], '1. user01@agro.ua · Заблоковано · розрахунків 1 · 15.10.2026');
    assert.equal(lines[6], '4. user04@agro.ua · Повний доступ · розрахунків 1500 · 12.10.2026');
    assert.equal(lines[12], '10. user10@agro.ua · Повний доступ · розрахунків 2 · 06.10.2026');

    const rows = userRows(sent.body.reply_markup);
    assert.equal(rows.length, 10);
    assert.deepEqual(rows[0], [{ text: '👤 user01@agro.ua', callback_data: 'ui:' + uid(1) }]);
    assert.deepEqual(navRow(sent.body.reply_markup), [
        { text: 'Сторінка 1/3', callback_data: 'ul:all:1' },
        { text: '▶', callback_data: 'ul:all:2' }
    ]);
    for (const row of sent.body.reply_markup.inline_keyboard) {
        for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    }
});

test('pagination edits the same message; last page has ◀ only; out-of-range page clamps', async () => {
    const h = harness();
    await h.send(h.callback('ul:all:2'));
    assert.deepEqual(h.calls[0], { method: 'answerCallbackQuery', body: { callback_query_id: 'cb' } });
    let edit = h.calls[1];
    assert.equal(edit.method, 'editMessageText');
    assert.equal(edit.body.chat_id, Number(OWNER_CHAT));
    assert.equal(edit.body.message_id, 70);
    assert.match(edit.body.text, /^11\. user11@agro\.ua · Демо/m);
    assert.deepEqual(navRow(edit.body.reply_markup).map((b) => b.text), ['◀', 'Сторінка 2/3', '▶']);
    assert.deepEqual(navRow(edit.body.reply_markup).map((b) => b.callback_data), ['ul:all:1', 'ul:all:2', 'ul:all:3']);

    await h.send(h.callback('ul:all:3'));
    edit = h.calls.at(-1);
    assert.equal(userRows(edit.body.reply_markup).length, 3);
    assert.match(edit.body.text, /^23\. user23@agro\.ua · Адміністратор/m);
    assert.deepEqual(userRows(edit.body.reply_markup).at(-1), [{ text: '👑 user23@agro.ua', callback_data: 'ui:' + uid(23) }]);
    assert.deepEqual(navRow(edit.body.reply_markup).map((b) => b.text), ['◀', 'Сторінка 3/3']);

    await h.send(h.callback('ul:all:9999'));
    assert.deepEqual(navRow(h.calls.at(-1).body.reply_markup).map((b) => b.text), ['◀', 'Сторінка 3/3']);
    assert.equal(h.calls.filter((c) => c.method === 'sendMessage').length, 0, 'pagination never posts a new message');
});

test('filters: demo, full, blocked, new; bad filter gets a hint', async () => {
    const h = harness();
    const listFor = async (text) => { await h.send(h.message(text)); return h.calls.at(-1).body; };

    let body = await listFor('/users demo');
    assert.match(body.text, /\nФільтр: demo · знайдено 12\n/);
    assert.match(body.text, /Всього 23 · Повний 8 · Демо 12 · Заблоковано 3/, 'totals stay global');
    assert.equal(body.text.split('\n').filter((l) => /^\d+\. /.test(l)).every((l) => / · Демо · /.test(l)), true);
    assert.deepEqual(navRow(body.reply_markup).map((b) => b.callback_data), ['ul:demo:1', 'ul:demo:2']);

    body = await listFor('/users full');
    assert.match(body.text, /Фільтр: full · знайдено 8/);
    assert.match(body.text, /user23@agro\.ua · Адміністратор/);

    body = await listFor('/users BLOCKED');
    assert.match(body.text, /Фільтр: blocked · знайдено 3/);
    assert.deepEqual(userRows(body.reply_markup).map((r) => r[0].callback_data), [uid(1), uid(2), uid(3)].map((id) => 'ui:' + id));
    assert.deepEqual(navRow(body.reply_markup), [{ text: 'Сторінка 1/1', callback_data: 'ul:blocked:1' }]);

    body = await listFor('/users new');
    assert.match(body.text, /Фільтр: new · знайдено 7/, 'registered within 7 days');

    body = await listFor('/users vip');
    assert.equal(body.text, 'Фільтр: all, demo, full, blocked, new. Напр. /users demo');
    assert.equal(body.reply_markup, undefined);

    h.db.auth = [];
    body = await listFor('/users');
    assert.match(body.text, /Всього 0 · Повний 0 · Демо 0 · Заблоковано 0\n\nНікого не знайдено\./);
    assert.deepEqual(navRow(body.reply_markup), [{ text: 'Сторінка 1/1', callback_data: 'ul:all:1' }]);
});

test('user button opens the same card as /user; admin card has no status buttons', async () => {
    const h = harness();
    await h.send(h.callback('ui:' + uid(12)));
    assert.equal(h.calls[0].method, 'answerCallbackQuery');
    const fromButton = h.calls[1];
    assert.equal(fromButton.method, 'sendMessage');
    await h.send(h.message('/user user12@agro.ua'));
    const fromCommand = h.calls.at(-1);
    assert.equal(fromButton.body.text, fromCommand.body.text);
    assert.deepEqual(fromButton.body.reply_markup, statusKeyboard(uid(12)));
    assert.match(fromButton.body.text, /Статус: Демо/);

    await h.send(h.callback('ui:' + uid(23)));
    const admin = h.calls.at(-1);
    assert.match(admin.body.text, /Статус: Адміністратор \(не змінюється\)/);
    assert.equal(admin.body.reply_markup, undefined);
});

test('callback_data is validated before anything is read', async () => {
    for (const data of ['ul:all:0', 'ul:all:-1', 'ul:all:1.5', 'ul:all:10000', 'ul:vip:1', 'ul:all:', 'ul:all:1:x', 'ul:ALL:1',
        'ui:not-a-uuid', 'ui:' + uid(1) + 'x', 'ui:', 'st:root:' + uid(1), 'zz:all:1', '', 'ul:all:01']) {
        assert.equal(tg.parseCallbackData(data), null, JSON.stringify(data));
        const h = harness();
        await h.send(h.callback(data));
        assert.deepEqual(h.calls, [{ method: 'answerCallbackQuery', body: { callback_query_id: 'cb', text: 'Невідома дія.' } }], data);
        assert.deepEqual(h.supabase.log, [], data + ': no DB access');
    }
    assert.deepEqual(tg.parseCallbackData('ul:new:12'), { kind: 'list', filter: 'new', page: 12 });
    assert.deepEqual(tg.parseCallbackData('ui:' + uid(5).toUpperCase()), { kind: 'open', userId: uid(5) });
    assert.deepEqual(tg.parseCallbackData('st:demo:' + uid(5)), { kind: 'status', status: 'demo', userId: uid(5) });
});

test('another chat or another group member is ignored for /users and list callbacks', async () => {
    const stranger = { id: 999, is_bot: false, first_name: 'X' };
    const group = { id: Number(OWNER_CHAT), type: 'supergroup' };
    const h = harness();
    for (const update of [
        h.message('/users', { id: 999, type: 'private' }, stranger),
        h.message('/users', group, stranger),
        h.message('/help', { id: 999, type: 'private' }, stranger),
        h.callback('ul:all:2', { id: 999, type: 'private' }, stranger),
        h.callback('ui:' + uid(1), group, stranger)
    ]) {
        const res = await h.send(update);
        assert.equal(res.code, 200);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.supabase.log, []);
});

test('the list is loaded in batches, not one query per user', async () => {
    const h = harness();
    await h.send(h.message('/users'));
    const counts = h.supabase.log.reduce((m, t) => { m[t] = (m[t] || 0) + 1; return m; }, {});
    // 23 users fit in one Auth page and one profiles page; calculations for the 10 shown users
    // take two 1 000-row pages because user04 has 1 500 rows.
    assert.deepEqual(counts, { 'auth.listUsers': 1, profiles: 1, calculations: 2 });
    assert.equal(h.supabase.log.includes('auth.getUserById'), false);
    assert.equal(h.supabase.log.includes('organizations'), false);
});

test('/help lists the commands; setMyCommands is in the webhook script', async () => {
    const h = harness();
    await h.send(h.message('/help'));
    const help = h.calls.at(-1).body.text;
    assert.equal(help, tg.HELP_TEXT);
    assert.match(help, /\/users \[all\|demo\|full\|blocked\|new\]/);
    assert.match(help, /\/user <email>/);
    assert.match(help, /\/help/);
    await h.send(h.message('/start'));
    assert.equal(h.calls.at(-1).body.text, tg.HELP_TEXT);

    assert.deepEqual(tg.BOT_COMMANDS.map((c) => c.command), ['users', 'user', 'help']);
    for (const c of tg.BOT_COMMANDS) {
        assert.match(c.command, /^[a-z0-9_]{1,32}$/);
        assert.ok(c.description.length >= 1 && c.description.length <= 256);
    }
    const script = read('scripts/set-telegram-webhook.js');
    assert.match(script, /import \{ BOT_COMMANDS \} from '\.\.\/lib\/telegram-admin\.js'/);
    assert.match(script, /\/setMyCommands'/);
    assert.match(script, /JSON\.stringify\(\{ commands: BOT_COMMANDS \}\)/);
    assert.match(script, /secret_token: secret/);
});

test('S0 regression: profit 6 687, tax 5 400', () => {
    const result = calculateTrip(JSON.parse(read('tests/fixtures/s0-fop.json')));
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
});
