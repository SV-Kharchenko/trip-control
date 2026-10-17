import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.INVITE_SIGNING_SECRET = 'invite-test-secret';
process.env.SITE_URL = 'https://trip-control.com';

const team = await import('../api/team.js');
const mail = await import('../lib/invite-mail.js');
const { calculateTrip } = await import('../api/calculate.js');

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20261017090000_invite_flow.sql');

const NOW = Date.parse('2026-10-17T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ORG = '10000000-0000-4000-8000-000000000001';
const OWNER = uid(1);
const ENV = {
    RESEND_API_KEY: 're_test',
    INVITE_FROM_EMAIL: 'TRIP-CONTROL <team@trip-control.com>',
    TELEGRAM_BOT_TOKEN: '1:abc',
    TELEGRAM_CHAT_ID: '777'
};

// ---------------------------------------------------------------------------
// In-memory Supabase: the query shapes api/team.js uses, nothing more.
// ---------------------------------------------------------------------------
function compare(a, b) {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (typeof a === 'string' && typeof b === 'string' && Number.isFinite(da) && Number.isFinite(db) && /T/.test(a)) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
}

function fakeSupabase(state, calls) {
    function query(table) {
        const q = { table, filters: [], op: 'select', cols: '*', head: false, count: false, payload: null, returning: false, order: null, limit: null };
        const rows = () => state[table] || (state[table] = []);
        const match = (row) => q.filters.every(([kind, col, value]) => {
            const v = row[col] === undefined ? null : row[col];
            if (kind === 'eq') return v === value;
            if (kind === 'neq') return v !== value;
            if (kind === 'is') return v === value;
            if (kind === 'in') return value.includes(v);
            if (kind === 'gt') return v !== null && compare(v, value) > 0;
            if (kind === 'gte') return v !== null && compare(v, value) >= 0;
            return true;
        });
        const embed = (row) => {
            const out = { ...row };
            const m = /organizations\(([^)]*)\)/.exec(q.cols);
            if (m) {
                const org = (state.organizations || []).find((o) => o.id === row.org_id);
                out.organizations = org ? { ...org } : null;
            }
            return out;
        };
        async function run(mode) {
            calls.push([table, q.op, q.filters.map((f) => f.slice(0, 2).join(':')).join(',')]);
            let list = rows().filter(match);
            if (q.op === 'insert') {
                const row = { id: uid(900 + rows().length), created_at: iso(NOW), accepted_at: null, revoked_at: null, declined_at: null, ...q.payload };
                rows().push(row);
                list = [row];
            } else if (q.op === 'update') {
                list.forEach((row) => Object.assign(row, q.payload));
            } else if (q.op === 'delete') {
                state[table] = rows().filter((row) => !match(row));
            }
            if (q.order) list = list.slice().sort((a, b) => compare(a[q.order.col], b[q.order.col]) * (q.order.asc ? 1 : -1));
            if (q.limit !== null) list = list.slice(0, q.limit);
            if (q.count && q.head) return { count: list.length, data: null, error: null };
            const data = list.map(embed);
            if (mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'not single' } };
            if (mode === 'maybe') return data.length > 1 ? { data: null, error: { message: 'many' } } : { data: data[0] || null, error: null };
            if ((q.op === 'update' || q.op === 'insert' || q.op === 'delete') && !q.returning) return { data: null, error: null };
            return { data, error: null };
        }
        const api = {
            select(cols, opts) {
                if (q.op === 'select') {
                    q.cols = cols || '*';
                    q.count = !!(opts && opts.count);
                    q.head = !!(opts && opts.head);
                } else q.returning = true;
                return api;
            },
            insert(payload) { q.op = 'insert'; q.payload = payload; return api; },
            update(payload) { q.op = 'update'; q.payload = payload; return api; },
            delete() { q.op = 'delete'; return api; },
            eq(col, value) { q.filters.push(['eq', col, value]); return api; },
            neq(col, value) { q.filters.push(['neq', col, value]); return api; },
            is(col, value) { q.filters.push(['is', col, value]); return api; },
            in(col, value) { q.filters.push(['in', col, value]); return api; },
            gt(col, value) { q.filters.push(['gt', col, value]); return api; },
            gte(col, value) { q.filters.push(['gte', col, value]); return api; },
            order(col, opts) { q.order = { col, asc: !opts || opts.ascending !== false }; return api; },
            limit(n) { q.limit = n; return api; },
            single() { return run('single'); },
            maybeSingle() { return run('maybe'); },
            then(resolve, reject) { return run('list').then(resolve, reject); }
        };
        return api;
    }

    // Same checks and order as public.accept_org_invite (the SQL itself runs in check-invite-flow.mjs).
    function acceptRpc({ p_token_hash, p_user_id, p_email }) {
        const invite = state.org_invites.find((row) => row.token_hash === p_token_hash);
        const fail = (message) => ({ data: null, error: { message } });
        if (!invite || invite.accepted_at || invite.revoked_at) return fail('INVITE_NOT_ACTIVE');
        if (invite.declined_at) return fail('INVITE_DECLINED');
        if (!(Date.parse(invite.expires_at) > NOW)) return fail('INVITE_EXPIRED');
        if (String(p_email).toLowerCase() !== invite.email.toLowerCase()) return fail('INVITE_EMAIL_MISMATCH');
        const profile = state.profiles.find((row) => row.id === p_user_id);
        const logists = state.profiles.filter((row) => row.org_id === invite.org_id && row.org_role === 'logist' && row.member_status === 'active' && row.id !== p_user_id);
        if (logists.length >= 3) return fail('MEMBER_LIMIT');
        if (profile.org_id !== invite.org_id && state.orgData.has(profile.org_id)) return fail('OLD_ORG_HAS_DATA');
        if (profile.org_id !== invite.org_id) state.organizations = state.organizations.filter((org) => org.id !== profile.org_id);
        Object.assign(profile, { org_id: invite.org_id, org_role: invite.org_role, member_status: 'active' });
        invite.accepted_at = iso(NOW);
        return { data: { org_id: invite.org_id, org_role: invite.org_role }, error: null };
    }

    return {
        from: query,
        rpc(name, args) {
            calls.push(['rpc', name]);
            const result = name === 'accept_org_invite' ? acceptRpc(args) : { data: null, error: null };
            return { single: async () => result, then: (resolve) => resolve(result) };
        },
        auth: {
            async getUser(token) {
                const user = state.sessions[token];
                return { data: { user: user || null }, error: user ? null : { message: 'bad' } };
            },
            admin: { async listUsers() { return { data: { users: [] }, error: null }; } }
        }
    };
}

function world() {
    const state = {
        organizations: [{ id: ORG, name: 'Зерно Логістик', status: 'active', work_mode: 'team' }],
        profiles: [{ id: OWNER, email: 'owner@zerno.ua', org_id: ORG, org_role: 'owner', member_status: 'active', created_at: iso(NOW - 30 * DAY) }],
        org_invites: [],
        company_settings: [{ org_id: ORG, settings: { logists_see_all: false } }],
        security_audit_log: [],
        sessions: { owner: { id: OWNER, email: 'owner@zerno.ua', email_confirmed_at: iso(NOW - 30 * DAY) } },
        orgData: new Set()
    };
    const calls = [];
    const sent = [];
    const fetch = async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({}) };
    };
    const env = { ...ENV };
    const clock = { now: NOW };
    const handler = team.createTeamHandler({ supabase: fakeSupabase(state, calls), fetch, env, now: () => clock.now });
    async function call(method, body, session) {
        const req = { method, body, headers: session ? { authorization: 'Bearer ' + session } : {} };
        let status = 0;
        let json = null;
        const res = { status(code) { status = code; return this; }, json(payload) { json = payload; return this; } };
        await handler(req, res);
        return { status, json };
    }
    // A signed-up account: own company (empty unless hasData), a session token named after it.
    function account(n, email, { hasData = false, confirmed = true } = {}) {
        const id = uid(n);
        const org = '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
        state.organizations.push({ id: org, name: 'Own ' + n, status: 'active', work_mode: 'solo' });
        state.profiles.push({ id, email, org_id: org, org_role: 'owner', member_status: 'active', created_at: iso(NOW - DAY) });
        state.sessions['u' + n] = { id, email, email_confirmed_at: confirmed ? iso(NOW - DAY) : null };
        if (hasData) state.orgData.add(org);
        return { id, org, session: 'u' + n };
    }
    const mails = () => sent.filter((item) => item.url === 'https://api.resend.com/emails');
    const telegrams = () => sent.filter((item) => item.url.startsWith('https://api.telegram.org/'));
    return { state, calls, sent, mails, telegrams, env, clock, call, account };
}

const tokenFrom = (url) => decodeURIComponent(new URL(url).searchParams.get('team_invite'));

test('S0 regression: profit 6 687, tax 5 400', () => {
    const result = calculateTrip(JSON.parse(read('tests/fixtures/s0-fop.json')));
    assert.equal(result.netProfit, 6687);
    assert.equal(result.taxesTotal, 5400);
});

test('any invite sends our own letter through Resend: company, inviter, Join button, 7-day signed link', async () => {
    const w = world();
    w.account(5, 'existing@example.com');
    for (const email of ['new@example.com', 'existing@example.com']) {
        const { status, json } = await w.call('POST', { action: 'invite', email }, 'owner');
        assert.equal(status, 200, JSON.stringify(json));
        assert.equal(json.delivery, 'email');
        assert.match(json.invite_url, /^https:\/\/trip-control\.com\/\?team_invite=v2\./);
        assert.equal(Date.parse(json.expires_at) - NOW, 7 * DAY);
        const letter = w.mails().at(-1).body;
        assert.deepEqual(letter.to, [email]);
        assert.equal(letter.from, 'TRIP-CONTROL <team@trip-control.com>');
        assert.match(letter.subject, /Зерно Логістик/);
        assert.match(letter.html, /owner@zerno\.ua/);
        assert.match(letter.html, />Приєднатися<\/a>/);
        assert.ok(letter.html.includes(json.invite_url.replace(/&/g, '&amp;')));
        assert.ok(letter.text.includes(json.invite_url));
    }
    assert.equal(w.mails().length, 2);
    // The copyable link stays in «Команда».
    const list = await w.call('GET', {}, 'owner');
    assert.equal(list.json.invites.length, 2);
    assert.ok(list.json.invites.every((invite) => /team_invite=v2\./.test(invite.invite_url) && invite.status === 'sent'));
});

test('without mail config the invite still exists and the owner gets the link (manual_link)', async () => {
    const w = world();
    delete w.env.RESEND_API_KEY;
    const { status, json } = await w.call('POST', { action: 'invite', email: 'new@example.com' }, 'owner');
    assert.equal(status, 200);
    assert.equal(json.delivery, 'manual_link');
    assert.match(json.invite_url, /team_invite=v2\./);
    assert.equal(w.mails().length, 0);
});

test('new email: invite_info works without login; signup + accept joins as logist and alerts Telegram', async () => {
    const w = world();
    const invite = await w.call('POST', { action: 'invite', email: 'new@example.com' }, 'owner');
    const token = tokenFrom(invite.json.invite_url);

    const info = await w.call('POST', { action: 'invite_info', token });
    assert.equal(info.status, 200);
    assert.deepEqual(info.json, {
        invite_id: invite.json.invite_id,
        email: 'new@example.com',
        org_name: 'Зерно Логістик',
        inviter_email: 'owner@zerno.ua',
        status: 'sent',
        expires_at: invite.json.expires_at,
        account_exists: false
    });

    // After the short signup the trigger has created an empty own company.
    const me = w.account(10, 'new@example.com');
    const accepted = await w.call('POST', { action: 'accept', token }, me.session);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.deepEqual(accepted.json, { ok: true, org_id: ORG, org_role: 'logist' });
    const profile = w.state.profiles.find((row) => row.id === me.id);
    assert.equal(profile.org_id, ORG);
    assert.equal(profile.org_role, 'logist');

    const alert = w.telegrams().at(-1);
    assert.match(alert.url, /\/sendMessage$/);
    assert.equal(alert.body.chat_id, '777');
    assert.match(alert.body.text, /Логіст приєднався до компанії/);
    assert.match(alert.body.text, /new@example\.com/);
    assert.match(alert.body.text, /Зерно Логістик/);
    assert.equal(alert.body.reply_markup.inline_keyboard[0][0].callback_data, 'st:full:' + me.id);

    const again = await w.call('POST', { action: 'invite_info', token });
    assert.equal(again.json.status, 'accepted');
    assert.equal(w.telegrams().length, 1);
});

test('existing account: invite_info says so; accept from the join screen works', async () => {
    const w = world();
    const me = w.account(11, 'driver@example.com');
    const invite = await w.call('POST', { action: 'invite', email: 'DRIVER@example.com' }, 'owner');
    const token = tokenFrom(invite.json.invite_url);
    const info = await w.call('POST', { action: 'invite_info', token });
    assert.equal(info.json.account_exists, true);
    assert.equal(info.json.email, 'driver@example.com');
    const accepted = await w.call('POST', { action: 'accept', token }, me.session);
    assert.equal(accepted.status, 200);
    assert.equal(w.state.profiles.find((row) => row.id === me.id).org_id, ORG);
});

test('signed in as another email: accept and decline are refused, nothing changes', async () => {
    const w = world();
    const other = w.account(12, 'other@example.com');
    const invite = await w.call('POST', { action: 'invite', email: 'right@example.com' }, 'owner');
    const token = tokenFrom(invite.json.invite_url);
    const accepted = await w.call('POST', { action: 'accept', token }, other.session);
    assert.equal(accepted.status, 403);
    assert.equal(accepted.json.code, 'INVITE_EMAIL_MISMATCH');
    const declined = await w.call('POST', { action: 'decline', token }, other.session);
    assert.equal(declined.status, 403);
    assert.equal(declined.json.code, 'INVITE_EMAIL_MISMATCH');
    assert.equal(w.state.org_invites[0].declined_at, null);
    assert.equal(w.state.profiles.find((row) => row.id === other.id).org_id, other.org);
    assert.equal(w.telegrams().length, 0);
});

test('decline: marked declined, frees the seat, cannot be accepted; resend brings it back', async () => {
    const w = world();
    const me = w.account(13, 'nope@example.com');
    const invite = await w.call('POST', { action: 'invite', email: 'nope@example.com' }, 'owner');
    const token = tokenFrom(invite.json.invite_url);
    assert.equal((await w.call('GET', {}, 'owner')).json.seats.used, 1);

    const declined = await w.call('POST', { action: 'decline', token }, me.session);
    assert.equal(declined.status, 200);
    assert.ok(w.state.org_invites[0].declined_at);
    assert.ok(w.state.security_audit_log.some((row) => row.action === 'decline_invite' && row.org_id === ORG));

    const list = await w.call('GET', {}, 'owner');
    assert.equal(list.json.seats.used, 0);
    assert.equal(list.json.invites[0].status, 'declined');
    assert.equal((await w.call('POST', { action: 'invite_info', token })).json.status, 'declined');

    const late = await w.call('POST', { action: 'accept', token }, me.session);
    assert.equal(late.status, 409);
    assert.equal(late.json.code, 'INVITE_DECLINED');
    const twice = await w.call('POST', { action: 'decline', token }, me.session);
    assert.equal(twice.status, 409);

    w.clock.now = NOW + 60 * 1000;
    const resent = await w.call('POST', { action: 'resend', invite_id: invite.json.invite_id }, 'owner');
    assert.equal(resent.status, 200);
    assert.equal(w.state.org_invites[0].declined_at, null);
    assert.equal(w.mails().length, 2);
    const fresh = tokenFrom(resent.json.invite_url);
    assert.equal((await w.call('POST', { action: 'invite_info', token: fresh })).json.status, 'sent');
    // The old link no longer matches the row.
    assert.equal((await w.call('POST', { action: 'invite_info', token })).status, 400);
});

test('account whose company has data: 409 with a human message, company kept', async () => {
    const w = world();
    const me = w.account(14, 'busy@example.com', { hasData: true });
    const invite = await w.call('POST', { action: 'invite', email: 'busy@example.com' }, 'owner');
    const accepted = await w.call('POST', { action: 'accept', token: tokenFrom(invite.json.invite_url) }, me.session);
    assert.equal(accepted.status, 409);
    assert.equal(accepted.json.code, 'OLD_ORG_HAS_DATA');
    assert.equal(accepted.json.error, team.OLD_ORG_HAS_DATA_MESSAGE);
    assert.match(accepted.json.error, /розрахунки, автопарк, налаштування або інші учасники/);
    assert.ok(w.state.organizations.some((org) => org.id === me.org));
    assert.equal(w.state.profiles.find((row) => row.id === me.id).org_id, me.org);
    assert.equal(w.telegrams().length, 0);
});

test('seat limit: owner + 3 logists, pending invites take a seat, declined and expired do not', async () => {
    const w = world();
    w.state.profiles.push(
        { id: uid(20), email: 'l1@example.com', org_id: ORG, org_role: 'logist', member_status: 'active' },
        { id: uid(21), email: 'l2@example.com', org_id: ORG, org_role: 'logist', member_status: 'active' }
    );
    const third = await w.call('POST', { action: 'invite', email: 'l3@example.com' }, 'owner');
    assert.equal(third.status, 200);
    const fourth = await w.call('POST', { action: 'invite', email: 'l4@example.com' }, 'owner');
    assert.equal(fourth.status, 409);
    assert.equal(fourth.json.code, 'MEMBER_LIMIT');
    assert.match(fourth.json.error, /3 з 3/);

    // Expired pending invite frees the seat.
    w.state.org_invites[0].expires_at = iso(NOW - 1000);
    const afterExpiry = await w.call('POST', { action: 'invite', email: 'l4@example.com' }, 'owner');
    assert.equal(afterExpiry.status, 200);

    // Accepting the last seat with a fourth active logist is refused by the RPC.
    w.state.profiles.push({ id: uid(22), email: 'l3b@example.com', org_id: ORG, org_role: 'logist', member_status: 'active' });
    const me = w.account(23, 'l4@example.com');
    const accepted = await w.call('POST', { action: 'accept', token: tokenFrom(afterExpiry.json.invite_url) }, me.session);
    assert.equal(accepted.status, 409);
    assert.equal(accepted.json.code, 'MEMBER_LIMIT');
});

test('self-registered on an invited email: my_invites offers it (confirmed email only)', async () => {
    const w = world();
    const invite = await w.call('POST', { action: 'invite', email: 'self@example.com' }, 'owner');
    const unconfirmed = w.account(30, 'self@example.com', { confirmed: false });
    assert.deepEqual((await w.call('POST', { action: 'my_invites' }, unconfirmed.session)).json, { invites: [] });

    w.state.sessions[unconfirmed.session].email_confirmed_at = iso(NOW);
    const mine = await w.call('POST', { action: 'my_invites' }, unconfirmed.session);
    assert.equal(mine.status, 200);
    assert.equal(mine.json.invites.length, 1);
    const item = mine.json.invites[0];
    assert.equal(item.invite_id, invite.json.invite_id);
    assert.equal(item.org_name, 'Зерно Логістик');
    assert.equal(item.inviter_email, 'owner@zerno.ua');
    assert.equal(item.token, tokenFrom(invite.json.invite_url));

    const accepted = await w.call('POST', { action: 'accept', token: item.token }, unconfirmed.session);
    assert.equal(accepted.status, 200);
    assert.deepEqual((await w.call('POST', { action: 'my_invites' }, unconfirmed.session)).json, { invites: [] });
});

test('«Команда» lists invite statuses: sent, accepted, declined, expired; revoked is gone', async () => {
    const w = world();
    const base = { org_id: ORG, org_role: 'logist', invited_by: OWNER, token_hash: 'x', accepted_at: null, revoked_at: null, declined_at: null };
    w.state.org_invites.push(
        { ...base, id: uid(41), email: 'sent@example.com', created_at: iso(NOW - DAY), expires_at: iso(NOW + 6 * DAY) },
        { ...base, id: uid(42), email: 'ok@example.com', created_at: iso(NOW - 2 * DAY), expires_at: iso(NOW + 5 * DAY), accepted_at: iso(NOW - DAY) },
        { ...base, id: uid(43), email: 'no@example.com', created_at: iso(NOW - 3 * DAY), expires_at: iso(NOW + 4 * DAY), declined_at: iso(NOW - DAY) },
        { ...base, id: uid(44), email: 'late@example.com', created_at: iso(NOW - 8 * DAY), expires_at: iso(NOW - DAY) },
        { ...base, id: uid(45), email: 'gone@example.com', created_at: iso(NOW - DAY), expires_at: iso(NOW + 6 * DAY), revoked_at: iso(NOW) }
    );
    const { json } = await w.call('GET', {}, 'owner');
    assert.deepEqual(json.invites.map((invite) => [invite.email, invite.status]), [
        ['sent@example.com', 'sent'],
        ['ok@example.com', 'accepted'],
        ['no@example.com', 'declined'],
        ['late@example.com', 'expired']
    ]);
    assert.equal(json.invites[1].invite_url, '');
    assert.equal(json.seats.pending, 1);
});

test('invite_info rejects tampered, foreign and malformed links without touching anything else', async () => {
    const w = world();
    const invite = await w.call('POST', { action: 'invite', email: 'new@example.com' }, 'owner');
    const token = tokenFrom(invite.json.invite_url);
    const parts = token.split('.');
    for (const bad of [parts[0] + '.' + parts[1] + '.' + 'A'.repeat(parts[2].length), 'v2.not-a-uuid.' + parts[2], '', 'x'.repeat(600)]) {
        const res = await w.call('POST', { action: 'invite_info', token: bad });
        assert.equal(res.status, 400, bad);
        assert.equal(res.json.code, 'BAD_INVITE_TOKEN');
    }
    assert.equal(team.signedInviteId(token), invite.json.invite_id);
    assert.equal(team.inviteStatus({ expires_at: iso(NOW + 1) }, NOW), 'sent');
    assert.equal(team.inviteStatus({ expires_at: iso(NOW - 1) }, NOW), 'expired');
    // Other actions still require a session.
    const anonymous = await w.call('POST', { action: 'accept', token });
    assert.equal(anonymous.status, 401);
});

test('invite letter escapes the company name and states the 7-day link', () => {
    const letter = mail.buildInviteEmail({
        orgName: 'ТОВ <Ромашка> & Co',
        inviterEmail: 'boss@x.ua',
        url: 'https://trip-control.com/?team_invite=v2.a.b',
        expiresAt: '2026-10-24T09:00:00Z'
    });
    assert.match(letter.html, /ТОВ &lt;Ромашка&gt; &amp; Co/);
    assert.doesNotMatch(letter.html, /<Ромашка>/);
    assert.match(letter.text, /дійсне до 24\.10\.2026/);
    assert.equal(mail.inviteMailProvider({ RESEND_API_KEY: 'k', REPORT_FROM_EMAIL: 'a@b.ua' }).from, 'a@b.ua');
    assert.equal(mail.inviteMailProvider({ RESEND_API_KEY: '', INVITE_FROM_EMAIL: 'a@b.ua' }), null);
});

// ---------------------------------------------------------------------------
// Client: the decision table and the wiring in index.html.
// ---------------------------------------------------------------------------
function clientFn(name) {
    const start = html.indexOf('    function ' + name + '(');
    const end = html.indexOf('\n    }\n', start);
    assert.ok(start > 0 && end > start, name);
    return new Function(html.slice(start, end + 7) + '\nreturn ' + name + ';')();
}

test('client decides join / auto-join / mismatch / inactive from the invite and the session', () => {
    const decide = clientFn('inviteDecision');
    const info = { invite_id: 'i1', email: 'logist@example.com', status: 'sent' };
    assert.equal(decide(info, { email: 'LOGIST@example.com' }), 'join');
    assert.equal(decide(info, { email: 'logist@example.com', user_metadata: { invite_id: 'i1' } }), 'auto_accept');
    assert.equal(decide(info, { email: 'logist@example.com', user_metadata: { invite_id: 'other' } }), 'join');
    assert.equal(decide(info, { email: 'boss@example.com', user_metadata: { invite_id: 'i1' } }), 'mismatch');
    for (const status of ['accepted', 'declined', 'expired', 'revoked', 'unavailable']) {
        assert.equal(decide({ ...info, status }, { email: 'logist@example.com' }), 'inactive');
    }
});

test('client wiring: short signup keeps the invite, join/decline screen, mismatch, self-registration', () => {
    // Short registration: owner questionnaire hidden, email locked, invite in emailRedirectTo and metadata.
    for (const id of ['auth-company', 'auth-ownership', 'auth-tax']) {
        assert.match(html, new RegExp('<div class="form-row two-cols auth-owner-only"[^>]*>\\s*<label class="visually-hidden" for="' + id + '"'));
    }
    assert.match(html, /<div class="auth-mode-grid auth-owner-only" role="radiogroup"/);
    assert.match(html, /#auth-form\.is-invite \.auth-owner-only \{ display: none !important; \}/);
    assert.match(html, /email\.readOnly = true;/);
    assert.match(html, /emailRedirectTo: location\.origin \+ '\/\?team_invite=' \+ encodeURIComponent\(invite\.token\),/);
    assert.match(html, /data: \{ invite_id: invite\.info\.invite_id \}/);
    assert.match(html, /if \(!invite && !company\)/);
    assert.match(html, /if \(!error && data && data\.user && !invite\) notifyOwnerAboutSignup/);
    // Join / decline and mismatch texts.
    assert.match(html, /'Вас запросили в «' \+/);
    assert.match(html, /label: 'Приєднатися', primary: true/);
    assert.match(html, /label: 'Відхилити', run:/);
    assert.match(html, /'Запрошення надіслано на ' \+ info\.email \+ ', а ви увійшли як ' \+ current \+ '\.'/);
    assert.match(html, /label: 'Вийти й увійти як ' \+ info\.email/);
    assert.match(html, /await teamApi\('POST', \{ action: 'decline', token: token \}\)/);
    // Self-registration with an active invite.
    assert.match(html, /await teamApi\('POST', \{ action: 'my_invites' \}\)/);
    // checkUserAccess routes through the invite flow before loading the profile.
    assert.match(html, /if \(await runInviteFlow\(session\)\) return;\s*hideInviteBox\(\);\s*const inviteNotice = takeInviteNotice\(\);/);
    assert.match(html, /if \(!\(opts && opts\.preserveMessage\)\) authMsg\.innerText = '';\s*syncInviteAuth\(\);/);
    // «Команда» statuses.
    assert.match(html, /sent: \{ label: 'надіслано'/);
    assert.match(html, /accepted: \{ label: 'прийнято'/);
    assert.match(html, /declined: \{ label: 'відхилено'/);
    assert.match(html, /expired: \{ label: 'прострочено'/);
});

test('migration: declined_at, data check before dropping the old company, not applied by tests', () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS declined_at timestamptz/);
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.org_has_user_data\(p_org_id uuid, p_user_id uuid\)/);
    assert.match(migration, /RAISE EXCEPTION 'OLD_ORG_HAS_DATA'/);
    assert.match(migration, /RAISE EXCEPTION 'INVITE_DECLINED'/);
    assert.match(migration, /IF public\.org_has_user_data\(v_profile\.org_id, p_user_id\) THEN/);
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.org_has_user_data\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/);
    for (const table of ['calculations', 'fleet_vehicles', 'route_templates', 'trip_actuals', 'weekly_reports']) {
        assert.match(migration, new RegExp("'" + table + "'"));
    }
});

test('accept_org_invite on Postgres: empty company removed, company with data kept (PGlite)', (t) => {
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const script = fileURLToPath(new URL('../scripts/check-invite-flow.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS new email: empty signup company removed with its default settings/);
    assert.match(run.stdout, /PASS old org with calculation: OLD_ORG_HAS_DATA/);
    assert.match(run.stdout, /PASS old org with fleet vehicle: OLD_ORG_HAS_DATA/);
    assert.match(run.stdout, /PASS old org with another member: OLD_ORG_HAS_DATA/);
    assert.match(run.stdout, /PASS declined invite: INVITE_DECLINED/);
    assert.match(run.stdout, /PASS fourth logist: MEMBER_LIMIT/);
});
