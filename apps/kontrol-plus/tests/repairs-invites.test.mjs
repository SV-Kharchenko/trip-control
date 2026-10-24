import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
    createRepairInvitesHandler, createSendLimiter, signedInviteToken, signedInviteTokenIsValid, signedInviteId, tokenHash,
    inviteStatus, INVITE_TTL_MS, mailProvider, inviteLink,
} from '../lib/repairs/invites.js';

const SECRET = 'test-signing-secret-not-real';
const T0 = Date.parse('2026-10-25T09:00:00Z');
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';

// Сховище в памʼяті: ті самі правила, що й функції БД (ліміт 2 місця, email, хеш токена).
function memoryStore(clock) {
    const s = {
        users: { 'jwt-owner': { id: 'u-owner', email: 'owner@a.ua' }, 'jwt-director': { id: 'u-dir', email: 'dir@x.ua' },
            'jwt-logist': { id: 'u-logist', email: 'logist@a.ua' }, 'jwt-manager': { id: 'u-man', email: 'man@m.ua' },
            'jwt-company': { id: 'u-company', email: 'c@c.ua' }, 'jwt-invitee': { id: 'u-new', email: 'New@Repair.ua' },
            'jwt-other': { id: 'u-other', email: 'other@x.ua' }, 'jwt-banned': { id: 'u-b', email: 'b@b.ua', banned_until: '2999-01-01T00:00:00Z' } },
        profiles: {
            'u-owner': { org_id: A, org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-logist': { org_id: A, org_role: 'logist', member_status: 'active', org_status: 'active', org_plan: 'control_plus' },
            'u-dir': { org_id: 'D', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-man': { org_id: 'M', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-company': { org_id: 'C', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-new': { org_id: 'N', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
            'u-other': { org_id: 'O', org_role: 'owner', member_status: 'active', org_status: 'active', org_plan: 'company' },
        },
        directors: { 'u-dir': A },
        managers: [],
        invites: [],
        reserveCalls: 0,
    };
    const pending = (org, except) => s.invites.filter((i) => i.org_id === org && i.id !== except && inviteStatus(i, clock.t) === 'sent').length;
    const store = {
        async getUser(jwt) { return s.users[jwt] || null; },
        async getProfile(id) { return s.profiles[id] || null; },
        async directorOrg(id) { return s.directors[id] || null; },
        async orgName() { return 'Агро А'; },
        async listInvites(org) { return s.invites.filter((i) => i.org_id === org).map((i) => ({ ...i })); },
        async getInvite(id) { const r = s.invites.find((i) => i.id === id); return r ? { ...r } : null; },
        async countManagers(org) { return s.managers.filter((m) => m.org_id === org).length; },
        async recentSends(org, since) { return s.invites.filter((i) => i.org_id === org && i.last_sent_at >= since).length; },
        async reserve({ orgId, inviteId, email, tokenHash: hash, invitedBy, expiresAt }) {
            s.reserveCalls += 1;
            const existing = s.invites.find((i) => i.id === inviteId);
            if (s.managers.filter((m) => m.org_id === orgId).length + pending(orgId, inviteId) >= 2) throw new Error('REPAIR_MANAGER_LIMIT');
            const at = new Date(clock.t).toISOString();
            if (existing) Object.assign(existing, { token_hash: hash, expires_at: expiresAt, last_sent_at: at });
            else s.invites.push({ id: inviteId, org_id: orgId, email, token_hash: hash, invited_by: invitedBy, expires_at: expiresAt, created_at: at, last_sent_at: at });
            return inviteId;
        },
        async revoke(org, id) {
            const r = s.invites.find((i) => i.id === id && i.org_id === org && !i.accepted_at && !i.revoked_at);
            if (!r) return false;
            r.revoked_at = new Date(clock.t).toISOString();
            return true;
        },
        async accept(hash, userId, email) {
            const r = s.invites.find((i) => i.token_hash === hash);
            if (!r || r.revoked_at) throw new Error('REPAIR_INVITE_NOT_FOUND');
            if (r.accepted_at) throw new Error('REPAIR_INVITE_USED');
            if (email !== r.email) throw new Error('INVITE_EMAIL_MISMATCH');
            r.accepted_at = new Date(clock.t).toISOString();
            s.managers.push({ org_id: r.org_id, user_id: userId });
            return r.org_id;
        },
        async decline(hash, email) {
            const r = s.invites.find((i) => i.token_hash === hash);
            if (!r) throw new Error('REPAIR_INVITE_NOT_FOUND');
            if (email !== r.email) throw new Error('INVITE_EMAIL_MISMATCH');
            r.declined_at = new Date(clock.t).toISOString();
            return true;
        },
    };
    return { s, store };
}

function harness({ secret = SECRET, env = {}, mailOk = true } = {}) {
    const clock = { t: T0 };
    const { s, store } = memoryStore(clock);
    const mails = [];
    const fakeFetch = async (url, init) => { mails.push({ url, body: JSON.parse(init.body) }); return { ok: mailOk }; };
    const logs = [];
    const handler = createRepairInvitesHandler({ store, secret, env, fetch: fakeFetch, now: () => new Date(clock.t),
        limiter: createSendLimiter({ now: () => clock.t }), log: { error: (...a) => logs.push(a.join(' ')) } });
    const call = async (body, { jwt = 'jwt-owner', method = 'POST' } = {}) => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ method, headers: jwt ? { authorization: 'Bearer ' + jwt } : {}, body }, res);
        return res;
    };
    return { call, s, clock, mails, logs };
}

test('tokens: HMAC with the repair_manager domain; logist-style tokens, forged and tampered ones are rejected', () => {
    const invite = { id: '11111111-2222-4333-8444-555555555555', email: 'A@B.ua', expires_at: '2026-11-01T09:00:00.000Z' };
    const token = signedInviteToken(invite, SECRET);
    assert.match(token, /^v2\.11111111-2222-4333-8444-555555555555\.[A-Za-z0-9_-]{43}$/);
    assert.equal(signedInviteId(token), invite.id);
    assert.equal(signedInviteTokenIsValid(token, invite, SECRET), true);
    assert.equal(signedInviteTokenIsValid(token, { ...invite, expires_at: '2026-11-01T09:00:00+00:00' }, SECRET), true, 'same instant, other format');
    assert.equal(signedInviteTokenIsValid(token, { ...invite, email: 'x@b.ua' }, SECRET), false);
    assert.equal(signedInviteTokenIsValid(token, invite, 'other-secret'), false);
    // Токен логіста сайту: той самий формат, але підпис без префікса repair_manager| — тут не приймається.
    const logistPayload = [invite.id, 'a@b.ua', 'logist', invite.expires_at].join('|');
    const logistToken = 'v2.' + invite.id + '.' + createHmac('sha256', SECRET).update(logistPayload).digest('base64url');
    assert.equal(signedInviteTokenIsValid(logistToken, invite, SECRET), false);
    assert.equal(signedInviteId('v2.not-a-uuid.xxxxxxxxxxxxxxxxxxxxxxxx'), null);
    assert.equal(tokenHash(token).length, 64);
    assert.match(inviteLink(token), /^https:\/\/app\.trip-control\.com\/\?repair_invite=v2\./);
});

test('401 without / with a bad JWT, 403 banned, 405 not POST, no-store; 400 unknown action', async () => {
    const h = harness();
    const r401 = await h.call({ action: 'list' }, { jwt: null });
    assert.deepEqual([r401.statusCode, r401.body.code, r401.headers['cache-control']], [401, 'AUTH_REQUIRED', 'no-store']);
    assert.deepEqual([(await h.call({ action: 'list' }, { jwt: 'jwt-nope' })).body.code], ['BAD_TOKEN']);
    assert.equal((await h.call({ action: 'list' }, { jwt: 'jwt-banned' })).statusCode, 403);
    assert.equal((await h.call({ action: 'list' }, { method: 'GET' })).statusCode, 405);
    assert.equal((await h.call({ action: 'hack' })).statusCode, 400);
});

test('503 without KP_INVITE_SIGNING_SECRET (after auth)', async () => {
    const h = harness({ secret: '' });
    assert.deepEqual([(await h.call({ action: 'list' })).statusCode, (await h.call({ action: 'list' })).body.code], [503, 'NOT_CONFIGURED']);
    assert.equal((await h.call({ action: 'list' }, { jwt: null })).statusCode, 401, '401 still comes first');
});

test('403 for logist, repair manager and company plan on create / resend / revoke / list', async () => {
    const h = harness();
    for (const jwt of ['jwt-logist', 'jwt-manager', 'jwt-company']) {
        for (const action of ['create', 'resend', 'revoke', 'list']) {
            const res = await h.call({ action, email: 'x@y.ua', id: 'aaaaaaaa-0000-4000-8000-000000000001' }, { jwt });
            assert.deepEqual([res.statusCode, res.body.code], [403, 'REPAIRS_FORBIDDEN'], jwt + ' ' + action);
        }
    }
    assert.equal(h.s.reserveCalls, 0);
});

test('owner and director invite; without Resend env no mail and the link goes only to the inviter; DB keeps only the hash', async () => {
    const h = harness();
    const res = await h.call({ action: 'create', email: ' New@Repair.ua ' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.mail_sent, res.body.invite.email, res.body.invite.status], [false, 'new@repair.ua', 'sent']);
    assert.match(res.body.link, /^https:\/\/app\.trip-control\.com\/\?repair_invite=v2\./);
    assert.equal(h.mails.length, 0, 'no Resend env — no mail');
    const row = h.s.invites[0];
    const token = decodeURIComponent(res.body.link.split('repair_invite=')[1]);
    assert.equal(row.token_hash, tokenHash(token));
    assert.equal(JSON.stringify(row).includes(token), false, 'only the hash is stored');
    assert.equal(row.expires_at, new Date(T0 + INVITE_TTL_MS).toISOString(), '7 days');
    const dir = await h.call({ action: 'create', email: 'second@repair.ua' }, { jwt: 'jwt-director' });
    assert.equal(dir.statusCode, 200, 'director of the control_plus org can invite');
    const list = await h.call({ action: 'list' });
    assert.deepEqual(list.body.seats, { used: 2, limit: 2, managers: 0, pending: 2 });
    assert.equal(JSON.stringify(list.body).includes('token'), false);
});

test('with Resend env the mail is sent and no link is returned; limit of 2 seats comes from the DB', async () => {
    const h = harness({ env: { RESEND_API_KEY: 're_test_not_real', INVITE_FROM_EMAIL: 'Контроль+ <no-reply@trip-control.com>' } });
    assert.ok(mailProvider({ RESEND_API_KEY: 'x', INVITE_FROM_EMAIL: 'a@b.c' }));
    assert.equal(mailProvider({ RESEND_API_KEY: 'x' }), null);
    const res = await h.call({ action: 'create', email: 'new@repair.ua' });
    assert.deepEqual([res.body.mail_sent, 'link' in res.body], [true, false]);
    assert.equal(h.mails[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(h.mails[0].body.to, ['new@repair.ua']);
    await h.call({ action: 'create', email: 'b@repair.ua' });
    const third = await h.call({ action: 'create', email: 'c@repair.ua' });
    assert.deepEqual([third.statusCode, third.body.code], [409, 'REPAIR_MANAGER_LIMIT']);
});

test('resend: new token and expiry, same seat; old token stops working; revoke frees the seat', async () => {
    const h = harness();
    const first = await h.call({ action: 'create', email: 'new@repair.ua' });
    const oldToken = decodeURIComponent(first.body.link.split('repair_invite=')[1]);
    await h.call({ action: 'create', email: 'b@repair.ua' });
    h.clock.t += 3600000;
    const again = await h.call({ action: 'resend', id: first.body.invite.id });
    assert.equal(again.statusCode, 200, 'resend keeps the seat (no limit error with 2 pending)');
    assert.notEqual(again.body.link, first.body.link);
    assert.equal(h.s.invites[0].expires_at, new Date(h.clock.t + INVITE_TTL_MS).toISOString());
    const stale = await h.call({ action: 'accept', token: oldToken }, { jwt: 'jwt-invitee' });
    assert.equal(stale.statusCode, 404, 'old token after resend → 404');
    assert.equal((await h.call({ action: 'revoke', id: first.body.invite.id })).statusCode, 200);
    assert.equal((await h.call({ action: 'create', email: 'c@repair.ua' })).statusCode, 200, 'revoked frees a seat');
});

test('accept / decline: email must match; forged / expired / revoked → 404; second accept → 409', async () => {
    const h = harness();
    const created = await h.call({ action: 'create', email: 'new@repair.ua' });
    const token = decodeURIComponent(created.body.link.split('repair_invite=')[1]);
    const mismatch = await h.call({ action: 'accept', token }, { jwt: 'jwt-other' });
    assert.deepEqual([mismatch.statusCode, mismatch.body.code], [403, 'INVITE_EMAIL_MISMATCH']);
    const forged = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    assert.equal((await h.call({ action: 'accept', token: forged }, { jwt: 'jwt-invitee' })).statusCode, 404);
    assert.equal((await h.call({ action: 'accept', token: 'garbage' }, { jwt: 'jwt-invitee' })).statusCode, 404);
    const ok = await h.call({ action: 'accept', token }, { jwt: 'jwt-invitee' });
    assert.deepEqual([ok.statusCode, ok.body.org_name], [200, 'Агро А']);
    assert.deepEqual(h.s.managers, [{ org_id: A, user_id: 'u-new' }]);
    const twice = await h.call({ action: 'accept', token }, { jwt: 'jwt-invitee' });
    assert.deepEqual([twice.statusCode, twice.body.code], [409, 'REPAIR_INVITE_USED']);

    const exp = harness();
    const e = await exp.call({ action: 'create', email: 'new@repair.ua' });
    exp.clock.t += INVITE_TTL_MS + 1;
    assert.equal((await exp.call({ action: 'accept', token: decodeURIComponent(e.body.link.split('repair_invite=')[1]) }, { jwt: 'jwt-invitee' })).statusCode, 404, 'expired → 404');
    const rev = harness();
    const r = await rev.call({ action: 'create', email: 'new@repair.ua' });
    await rev.call({ action: 'revoke', id: r.body.invite.id });
    assert.equal((await rev.call({ action: 'accept', token: decodeURIComponent(r.body.link.split('repair_invite=')[1]) }, { jwt: 'jwt-invitee' })).statusCode, 404, 'revoked → 404');
    const dec = harness();
    const d = await dec.call({ action: 'create', email: 'new@repair.ua' });
    assert.equal((await dec.call({ action: 'decline', token: decodeURIComponent(d.body.link.split('repair_invite=')[1]) }, { jwt: 'jwt-invitee' })).statusCode, 200);
    const list = await dec.call({ action: 'list' });
    assert.equal(list.body.invites[0].status, 'declined');
});

test('limit: 10 create + resend per org per hour', async () => {
    const h = harness();
    const first = await h.call({ action: 'create', email: 'a0@repair.ua' });
    let last;
    for (let i = 0; i < 10; i++) last = await h.call({ action: 'resend', id: first.body.invite.id });
    assert.deepEqual([last.statusCode, last.body.code], [429, 'RATE_LIMITED'], '11th send within the hour');
    h.clock.t += 3600001;
    assert.equal((await h.call({ action: 'resend', id: first.body.invite.id })).statusCode, 200);
});

test('token and email never in console.* or in error bodies', async () => {
    const seen = [];
    const original = {};
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
        original[k] = console[k];
        console[k] = (...a) => seen.push(a.map(String).join(' '));
    }
    try {
        const h = harness();
        const created = await h.call({ action: 'create', email: 'secret.person@repair.ua' });
        const token = decodeURIComponent(created.body.link.split('repair_invite=')[1]);
        const bodies = [];
        bodies.push((await h.call({ action: 'accept', token }, { jwt: 'jwt-other' })).body);
        bodies.push((await h.call({ action: 'accept', token: token + 'x' }, { jwt: 'jwt-other' })).body);
        bodies.push((await h.call({ action: 'create', email: 'not-an-email' })).body);
        const broken = harness();
        broken.s.invites = null; // будь-який виклик сховища впаде
        bodies.push((await broken.call({ action: 'list' })).body);
        const text = JSON.stringify(bodies) + seen.join('\n') + h.logs.join('\n') + broken.logs.join('\n');
        for (const bad of [token, 'secret.person', 'not-an-email', SECRET]) assert.equal(text.includes(bad), false, bad);
        assert.match(broken.logs.join(), /\[repairs-invites\] list: internal error/);
    } finally {
        Object.assign(console, original);
    }
});

test('Vercel function: 405 and 401 before env, 503 without KP_INVITE_SIGNING_SECRET', async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, secret: process.env.KP_INVITE_SIGNING_SECRET };
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-not-real';
    delete process.env.KP_INVITE_SIGNING_SECRET;
    try {
        const { default: route } = await import('../api/repairs/invites.js');
        const resOf = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
        const get = resOf();
        await route({ method: 'GET', headers: {} }, get);
        assert.equal(get.statusCode, 405);
        const noJwt = resOf();
        await route({ method: 'POST', headers: {}, body: { action: 'list' } }, noJwt);
        assert.deepEqual([noJwt.statusCode, noJwt.body.code, noJwt.headers['Cache-Control']], [401, 'AUTH_REQUIRED', 'no-store']);
        const noSecret = resOf();
        await route({ method: 'POST', headers: { authorization: 'Bearer x.y.z' }, body: { action: 'list' } }, noSecret);
        assert.deepEqual([noSecret.statusCode, noSecret.body.code], [503, 'NOT_CONFIGURED']);
    } finally {
        for (const [k, v] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_ROLE_KEY', saved.key], ['KP_INVITE_SIGNING_SECRET', saved.secret]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});
