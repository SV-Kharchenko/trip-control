// «Власний парк», етап 1: чиста логіка, маршрути, гейт, запрошення замовника (API і прийняття посилання), межі lazy-модуля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listFiles } from './helpers/files.mjs';
import {
    STATUS_LABELS, OWN_FLEET_ROLE_LABELS, boardGroups, counters, filterRequests, isOverdue, nextActions, ownFleetAccess, ownFleetErrorText, ownFleetOnly, routeText,
} from '../src/lib/own-fleet.js';
import { ROLE_LABELS } from '../src/lib/gate.js';
import { cardParentHash, ownFleetParentHash, parseCrmHash, tabOf, windowSpecOf } from '../src/lib/route.js';
import { SHELL_ITEMS } from '../src/shell-menu.js';
import { createRequesterInviteAcceptor, REQUESTER_INVITE_KEY, storedRequesterInvite, takeRequesterInviteFromUrl } from '../src/lib/own-fleet-invite.js';
import { createOwnFleetInvitesHandler, inviteStatus } from '../lib/own-fleet/invites.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const iso = (h) => new Date(NOW + h * HOUR).toISOString();
const UUID = '81000000-0000-0000-0000-000000000001';
const row = (n, status, over = {}) => ({ id: 'id' + n, number: n, unit_id: UUID, created_by: 'u-req', status, priority: 'normal', wanted_at: iso(5), done_at: null, ...over });

// ---- Ролі й гейт ----
test('ролі: requester — «Замовник підрозділу»; решта підписів не змінилась; ключі ролей без перейменувань', () => {
    assert.equal(ROLE_LABELS.requester, 'Замовник підрозділу');
    assert.deepEqual(OWN_FLEET_ROLE_LABELS, { owner: 'Директор', director: 'Менеджер', logist: 'Логіст', requester: 'Замовник підрозділу' });
    assert.equal(ROLE_LABELS.owner, 'Директор');
    assert.equal(ROLE_LABELS.director, 'Менеджер');
});

test('гейт: без контексту й без прапорця модуля немає; замовник без Контроль+ бачить лише «Власний парк»', () => {
    for (const ctx of [null, undefined, {}, { org_id: null, role: 'owner' }]) assert.equal(ownFleetAccess(ctx).enabled, false);
    const owner = ownFleetAccess({ org_id: 'o', role: 'owner', unit_ids: [] });
    assert.deepEqual([owner.enabled, owner.canManage, owner.isRequester], [true, true, false]);
    for (const role of ['director', 'logist']) assert.equal(ownFleetAccess({ org_id: 'o', role, unit_ids: [] }).canManage, true, role);
    const req = ownFleetAccess({ org_id: 'o', role: 'requester', unit_ids: [UUID] });
    assert.deepEqual([req.enabled, req.canManage, req.isRequester, req.unitIds], [true, false, true, [UUID]]);
    assert.equal(ownFleetOnly(req, { control_plus: false }), true);
    assert.equal(ownFleetOnly(req, { control_plus: true, role: 'owner' }), false, 'з власним Контроль+ звичайні розділи лишаються');
    assert.equal(ownFleetOnly(owner, { control_plus: false }), false);
    assert.equal(ownFleetOnly(ownFleetAccess(null), null), false);
});

// ---- Лічильники, фільтри, дошка ----
test('лічильники: нові, термінові (активні), прострочені (час минув, рейс не почався)', () => {
    const rows = [row(1, 'new', { priority: 'urgent', wanted_at: iso(-2) }), row(2, 'new'), row(3, 'accepted', { wanted_at: iso(-1) }),
        row(4, 'in_progress', { wanted_at: iso(-9) }), row(5, 'done', { priority: 'urgent', wanted_at: iso(-30) }), row(6, 'cancelled', { priority: 'urgent' })];
    assert.deepEqual(counters(rows, NOW), { new: 2, urgent: 1, overdue: 2 });
    assert.equal(isOverdue(rows[3], NOW), false, 'у рейсі вже не прострочена');
    assert.equal(isOverdue(row(7, 'assigned', { wanted_at: iso(-0.1) }), NOW), true);
    assert.deepEqual(counters([], NOW), { new: 0, urgent: 0, overdue: 0 });
});

test('фільтри: підрозділ, пріоритет і бажана дата за Києвом', () => {
    const rows = [row(1, 'new', { unit_id: 'A', priority: 'urgent', wanted_at: '2026-11-05T22:30:00Z' }), row(2, 'new', { unit_id: 'B', wanted_at: '2026-11-05T10:00:00Z' })];
    assert.deepEqual(filterRequests(rows, { unitId: 'A' }).map((r) => r.number), [1]);
    assert.deepEqual(filterRequests(rows, { priority: 'urgent' }).map((r) => r.number), [1]);
    assert.deepEqual(filterRequests(rows, { date: '2026-11-06' }).map((r) => r.number), [1], '22:30 UTC = 00:30 6-го у Києві (взимку UTC+2)');
    assert.deepEqual(filterRequests(rows, { date: '2026-11-05' }).map((r) => r.number), [2]);
});

test('дошка: колонки за статусами; термінові вище; «Виконана» лише за сьогодні; скасовані не на дошці', () => {
    const rows = [row(1, 'new'), row(2, 'new', { priority: 'urgent' }), row(3, 'new', { priority: 'high' }), row(4, 'done', { done_at: iso(-1) }), row(5, 'done', { done_at: iso(-72) }),
        row(6, 'cancelled'), row(7, 'in_progress'), row(8, 'assigned'), row(9, 'accepted')];
    const g = boardGroups(rows, {}, NOW);
    assert.deepEqual(g.new.map((r) => r.number), [2, 3, 1], 'терміново → високий → звичайний');
    assert.deepEqual(g.done.map((r) => r.number), [4]);
    assert.deepEqual([g.accepted.length, g.assigned.length, g.in_progress.length], [1, 1, 1]);
    assert.equal(Object.values(g).flat().some((r) => r.status === 'cancelled'), false);
    assert.deepEqual(Object.keys(g), ['new', 'accepted', 'assigned', 'in_progress', 'done']);
    assert.deepEqual(boardGroups(rows, { priority: 'urgent' }, NOW).new.map((r) => r.number), [2]);
});

// ---- Дії за ролями (дзеркало серверних правил) ----
test('дії: замовник — лише скасувати свою нову; персонал — повний ланцюжок; фінальні — без дій', () => {
    const labels = (r, role, uid = 'u-req') => nextActions(r, role, uid).map((a) => a.to + (a.assign ? '*' : ''));
    assert.deepEqual(labels(row(1, 'new'), 'requester'), ['cancelled']);
    assert.deepEqual(labels(row(1, 'new', { created_by: 'other' }), 'requester'), [], 'чужа заявка підрозділу — не скасувати');
    for (const st of ['accepted', 'assigned', 'in_progress', 'done', 'cancelled']) assert.deepEqual(labels(row(1, st), 'requester'), [], 'requester: ' + st);
    for (const role of ['owner', 'director', 'logist']) {
        assert.deepEqual(labels(row(1, 'new'), role), ['accepted', 'cancelled'], role);
        assert.deepEqual(labels(row(1, 'accepted'), role), ['assigned*', 'cancelled'], role);
        assert.deepEqual(labels(row(1, 'assigned'), role), ['in_progress', 'assigned*', 'accepted', 'cancelled'], role + ': «Зняти призначення» = assigned → accepted');
        assert.deepEqual(labels(row(1, 'in_progress'), role), ['done', 'cancelled'], role);
        assert.deepEqual(labels(row(1, 'done'), role), [], role);
        assert.deepEqual(labels(row(1, 'cancelled'), role), [], role);
    }
    assert.deepEqual(labels(row(1, 'new'), 'stranger'), []);
    assert.equal(nextActions(row(1, 'new'), 'owner').find((a) => a.to === 'cancelled').needsReason, true, 'скасування з причиною');
    assert.deepEqual(Object.keys(STATUS_LABELS), ['new', 'accepted', 'assigned', 'in_progress', 'done', 'cancelled']);
});

test('тексти: помилки БД → зрозуміло; маршрут з точок і з тексту', () => {
    assert.match(ownFleetErrorText({ message: 'FLEET_REQUEST_REASON_REQUIRED' }), /причину/);
    assert.match(ownFleetErrorText({ message: 'x REQUESTER_LIMIT y' }), /30/);
    assert.match(ownFleetErrorText({ message: 'FLEET_REQUEST_BAD_TRANSITION' }), /Оновіть/);
    assert.equal(ownFleetErrorText({ message: 'weird' }), 'Не вдалося виконати дію. Спробуйте ще раз.');
    assert.equal(routeText({ from_point_id: 'p', to_point_id: null, from_text: null, to_text: 'Порт' }, [{ id: 'p', name: 'Поле 1' }]), 'Поле 1 → Порт');
});

// ---- Маршрути ----
test('маршрути: #/own-fleet, підрозділи, точки, картки вікном; чужі й неправильні — null', () => {
    assert.deepEqual(parseCrmHash('#/own-fleet'), { view: 'own-fleet', sub: 'board' });
    for (const sub of ['list', 'units', 'points']) assert.deepEqual(parseCrmHash('#/own-fleet/' + sub), { view: 'own-fleet', sub });
    assert.deepEqual(parseCrmHash('#/own-fleet/request/' + UUID), { view: 'own-fleet-card', kind: 'request', id: UUID });
    assert.deepEqual(parseCrmHash('#/own-fleet/request/new'), { view: 'own-fleet-card', kind: 'request', id: null });
    assert.deepEqual(parseCrmHash('#/own-fleet/unit/new'), { view: 'own-fleet-card', kind: 'unit', id: null });
    assert.deepEqual(parseCrmHash('#/own-fleet/point/' + UUID), { view: 'own-fleet-card', kind: 'point', id: UUID });
    for (const bad of ['#/own-fleet/x', '#/own-fleet/request/xyz', '#/own-fleet/request/' + UUID + '/extra', '#/own-fleet/list/1', '#/own-fleets']) assert.equal(parseCrmHash(bad), null, bad);
    assert.equal(tabOf(parseCrmHash('#/own-fleet')), 'own-fleet');
    assert.equal(tabOf(parseCrmHash('#/own-fleet/unit/new')), 'own-fleet');
    assert.deepEqual(windowSpecOf(parseCrmHash('#/own-fleet/request/' + UUID), ''), { type: 'of_request', id: UUID, key: 'of_request:' + UUID });
    assert.deepEqual(windowSpecOf(parseCrmHash('#/own-fleet/unit/new'), ''), { type: 'of_unit', id: '', key: 'of_unit:new' });
    assert.equal(windowSpecOf(parseCrmHash('#/own-fleet'), ''), null, 'розділ — сторінка, не вікно');
    assert.equal(ownFleetParentHash(parseCrmHash('#/own-fleet/unit/new')), '#/own-fleet/units');
    assert.equal(ownFleetParentHash(parseCrmHash('#/own-fleet/point/new')), '#/own-fleet/points');
    assert.equal(ownFleetParentHash(parseCrmHash('#/own-fleet/request/new')), '#/own-fleet');
    assert.equal(cardParentHash(parseCrmHash('#/own-fleet/request/new')), null, 'на вузькому екрані картка лишається сторінкою (як клієнт)');
});

// ---- Запрошення замовника: API ----
const sha = (t) => createHash('sha256').update(t).digest('hex');
function fakeStore(over = {}) {
    const calls = { reserve: [], revoke: [], accept: [] };
    const staffRole = over.staffRole || 'owner';
    const store = {
        calls,
        getUser: async (jwt) => (jwt === 'good' ? { id: 'staff', email: 'boss@example.com', email_confirmed_at: '2026-01-01' } : jwt === 'req' ? { id: 'req-user', email: 'New@Example.com', email_confirmed_at: '2026-01-01' }
            : jwt === 'unconfirmed' ? { id: 'req-user', email: 'new@example.com' } : jwt === 'banned' ? { id: 'b', email: 'b@example.com', banned_until: '2999-01-01' } : null),
        access: async (id) => (id === 'staff' ? { org_id: 'org1', role: staffRole } : id === 'req-user' ? { org_id: 'org1', role: 'requester' } : null),
        orgName: async () => 'Агрохолдинг',
        listInvites: async () => [{ id: 'i1', email: 'a@example.com', unit_ids: [UUID], expires_at: '2999-01-01', accepted_at: null, revoked_at: null, created_at: '2026-01-01' },
            { id: 'i2', email: 'b@example.com', unit_ids: [UUID], expires_at: '2000-01-01', accepted_at: null, revoked_at: null, created_at: '2026-01-01' }],
        getInvite: async (id) => (id === '81000000-0000-0000-0000-0000000000ff' ? { id, org_id: 'org1', email: 'a@example.com', unit_ids: [UUID], accepted_at: null } : null),
        reserve: async (a) => { calls.reserve.push(a); },
        revoke: async (org, id) => { calls.revoke.push([org, id]); return true; },
        accept: async (hash, user, email) => { calls.accept.push([hash, user, email]); return 'org1'; },
        ...over,
    };
    return store;
}
function call(handler, { auth = 'Bearer good', method = 'POST', body = {} } = {}) {
    return new Promise((resolve) => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(b) { resolve({ code: this.code, body: b, headers: this.headers }); } };
        handler({ method, headers: auth ? { authorization: auth } : {}, body }, res);
    });
}
const quiet = { error() {} };

test('API запрошень: без входу 401, не POST 405, заблокований 403, невідома дія 400', async () => {
    const h = createOwnFleetInvitesHandler({ store: fakeStore(), log: quiet });
    assert.equal((await call(h, { auth: '' })).code, 401);
    assert.equal((await call(h, { auth: 'Bearer nope' })).code, 401);
    assert.equal((await call(h, { method: 'GET' })).code, 405);
    assert.equal((await call(h, { auth: 'Bearer banned', body: { action: 'list' } })).code, 403);
    assert.equal((await call(h, { body: { action: 'format-disk' } })).code, 400);
    assert.equal((await call(h, { body: { action: 'list' } })).headers['Cache-Control'], 'no-store');
});

test('API запрошень: замовниками керують лише директор (owner) і менеджер (director); логіст, замовник і чужі — 403 на всіх діях', async () => {
    const body = { email: 'x@example.com', unit_ids: [UUID], id: '81000000-0000-0000-0000-0000000000ff' };
    for (const role of ['owner', 'director']) {
        const h = createOwnFleetInvitesHandler({ store: fakeStore({ staffRole: role }), log: quiet });
        for (const action of ['list', 'create', 'resend', 'revoke']) assert.equal((await call(h, { body: { action, ...body } })).code, 200, role + ': ' + action);
    }
    const logist = createOwnFleetInvitesHandler({ store: fakeStore({ staffRole: 'logist' }), log: quiet });
    for (const action of ['list', 'create', 'resend', 'revoke']) {
        const out = await call(logist, { body: { action, ...body } });
        assert.equal(out.code, 403, 'logist: ' + action);
        assert.equal(out.body.code, 'OWN_FLEET_FORBIDDEN');
    }
    const list = await call(logist, { body: { action: 'list' } });
    assert.equal(list.code, 403, 'logist отримує 403 на list');
    assert.equal(JSON.stringify(list.body).includes('@'), false, 'у відповіді 403 немає пошт запрошень');
    const requester = createOwnFleetInvitesHandler({ store: fakeStore({ staffRole: 'requester' }), log: quiet });
    const stranger = createOwnFleetInvitesHandler({ store: fakeStore({ access: async () => null }), log: quiet });
    for (const h of [requester, stranger]) for (const action of ['list', 'create', 'resend', 'revoke']) assert.equal((await call(h, { body: { action, ...body } })).code, 403, action);
    const calls = fakeStore({ staffRole: 'logist' }).calls;
    assert.deepEqual([calls.reserve.length, calls.revoke.length], [0, 0]);
});

test('API запрошень: create — токен лише в посиланні, у БД тільки sha256; без пошти листа немає, посилання повертається ініціатору', async () => {
    const store = fakeStore();
    const h = createOwnFleetInvitesHandler({ store, log: quiet, now: () => new Date('2026-11-05T12:00:00Z') });
    const out = await call(h, { body: { action: 'create', email: ' New@Example.com ', unit_ids: [UUID, 'not-a-uuid'] } });
    assert.equal(out.code, 200);
    assert.equal(out.body.mail_sent, false);
    assert.match(out.body.link, /^https:\/\/app\.trip-control\.com\/\?requester_invite=r1\./);
    const token = decodeURIComponent(out.body.link.split('requester_invite=')[1]);
    const reserved = store.calls.reserve[0];
    assert.equal(reserved.tokenHash, sha(token), 'у БД лише хеш');
    assert.equal(JSON.stringify(reserved).includes(token), false, 'токена в БД немає');
    assert.equal(reserved.email, 'new@example.com');
    assert.deepEqual(reserved.unitIds, [UUID], 'сміттєві id відкинуто');
    assert.equal(reserved.invitedBy, 'staff');
    assert.equal(reserved.orgId, 'org1');
    assert.equal(reserved.expiresAt, '2026-11-12T12:00:00.000Z', '7 днів');
    assert.equal(out.body.invite.status, 'sent');
});

test('API запрошень: create — з поштою лист іде, посилання не віддається; перевірки пошти й підрозділів; ліміт з БД → 409', async () => {
    const sent = [];
    const fetchStub = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return { ok: true }; };
    const h = createOwnFleetInvitesHandler({ store: fakeStore(), env: { RESEND_API_KEY: 'k', INVITE_FROM_EMAIL: 'Trip <no-reply@example.com>' }, fetch: fetchStub, log: quiet });
    const out = await call(h, { body: { action: 'create', email: 'a@example.com', unit_ids: [UUID] } });
    assert.equal(out.body.mail_sent, true);
    assert.equal('link' in out.body, false, 'при надісланому листі посилання не повертається');
    assert.match(sent[0][1].subject, /замовник підрозділу/);
    assert.match(sent[0][1].text, /requester_invite=r1\./);
    const bare = createOwnFleetInvitesHandler({ store: fakeStore(), log: quiet });
    assert.equal((await call(bare, { body: { action: 'create', email: 'bad', unit_ids: [UUID] } })).code, 400);
    assert.equal((await call(bare, { body: { action: 'create', email: 'a@example.com', unit_ids: [] } })).code, 400);
    const limited = createOwnFleetInvitesHandler({ store: fakeStore({ reserve: async () => { throw new Error('REQUESTER_LIMIT'); } }), log: quiet });
    const lim = await call(limited, { body: { action: 'create', email: 'a@example.com', unit_ids: [UUID] } });
    assert.equal(lim.code, 409);
    assert.equal(lim.body.code, 'REQUESTER_LIMIT');
});

test('API запрошень: ліміт відправок на організацію (10 за годину) → 429', async () => {
    const h = createOwnFleetInvitesHandler({ store: fakeStore(), log: quiet });
    let last;
    for (let i = 0; i < 11; i++) last = await call(h, { body: { action: 'create', email: 'u' + i + '@example.com', unit_ids: [UUID] } });
    assert.equal(last.code, 429);
});

test('API запрошень: list зі статусами; resend лише чужого org — 404; revoke', async () => {
    const store = fakeStore();
    const h = createOwnFleetInvitesHandler({ store, log: quiet, now: () => new Date('2026-11-05T12:00:00Z') });
    const list = await call(h, { body: { action: 'list' } });
    assert.deepEqual(list.body.invites.map((i) => i.status), ['sent', 'expired']);
    assert.equal(JSON.stringify(list.body).includes('token'), false);
    assert.equal((await call(h, { body: { action: 'resend', id: 'bad' } })).code, 400);
    assert.equal((await call(h, { body: { action: 'resend', id: UUID } })).code, 404);
    const again = await call(h, { body: { action: 'resend', id: '81000000-0000-0000-0000-0000000000ff' } });
    assert.equal(again.code, 200);
    assert.equal(store.calls.reserve.at(-1).inviteId, '81000000-0000-0000-0000-0000000000ff', 'той самий id, новий токен');
    assert.equal((await call(h, { body: { action: 'revoke', id: UUID } })).code, 200);
    assert.deepEqual(store.calls.revoke[0], ['org1', UUID]);
    const gone = createOwnFleetInvitesHandler({ store: fakeStore({ revoke: async () => false }), log: quiet });
    assert.equal((await call(gone, { body: { action: 'revoke', id: UUID } })).code, 404);
    assert.equal(inviteStatus({ accepted_at: 'x' }), 'accepted');
    assert.equal(inviteStatus({ revoked_at: 'x', expires_at: '2999-01-01' }), 'revoked');
});

test('API запрошень: accept — лише з підтвердженою поштою й справжнім форматом токена; у БД іде хеш і пошта з акаунта', async () => {
    const store = fakeStore();
    const h = createOwnFleetInvitesHandler({ store, log: quiet });
    const token = 'r1.' + UUID + '.' + 'A'.repeat(32);
    assert.equal((await call(h, { auth: 'Bearer unconfirmed', body: { action: 'accept', token } })).code, 403);
    for (const bad of ['', 'x', 'v2.' + UUID + '.' + 'A'.repeat(32), 'r1.' + UUID, token + '!', 'r1.' + UUID + '.' + 'A'.repeat(400)]) {
        assert.equal((await call(h, { auth: 'Bearer req', body: { action: 'accept', token: bad } })).code, 404, bad.slice(0, 20));
    }
    const ok = await call(h, { auth: 'Bearer req', body: { action: 'accept', token } });
    assert.deepEqual(ok.body, { ok: true, org_name: 'Агрохолдинг' });
    assert.deepEqual(store.calls.accept[0], [sha(token), 'req-user', 'new@example.com'], 'пошта береться з акаунта, не з тіла запиту');
    const mismatch = createOwnFleetInvitesHandler({ store: fakeStore({ accept: async () => { throw new Error('INVITE_EMAIL_MISMATCH'); } }), log: quiet });
    assert.equal((await call(mismatch, { auth: 'Bearer req', body: { action: 'accept', token } })).code, 403);
    const used = createOwnFleetInvitesHandler({ store: fakeStore({ accept: async () => { throw new Error('REQUESTER_INVITE_USED'); } }), log: quiet });
    assert.equal((await call(used, { auth: 'Bearer req', body: { action: 'accept', token } })).code, 409);
    const member = createOwnFleetInvitesHandler({ store: fakeStore({ accept: async () => { throw new Error('REQUESTER_IS_MEMBER'); } }), log: quiet });
    assert.equal((await call(member, { auth: 'Bearer req', body: { action: 'accept', token } })).code, 409);
});

test('API запрошень: внутрішня помилка — без токена, пошти й тексту бази в логах і відповіді', async () => {
    const logs = [];
    const h = createOwnFleetInvitesHandler({ store: fakeStore({ reserve: async () => { throw new Error('secret db detail new@example.com'); } }), log: { error: (m) => logs.push(m) } });
    const out = await call(h, { body: { action: 'create', email: 'new@example.com', unit_ids: [UUID] } });
    assert.equal(out.code, 500);
    assert.equal(JSON.stringify(out.body).includes('secret'), false);
    assert.equal(logs.join('').includes('example.com'), false);
    assert.equal(logs.join('').includes('secret'), false);
});

// ---- Прийняття посилання у фронтенді ----
function fakeWindow(href) {
    const calls = { replaced: [] };
    return { calls, location: { href }, history: { replaceState: (_s, _t, url) => calls.replaced.push(url) } };
}
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

test('посилання-запрошення: параметр прибирається з URL; без сесії токен чекає в сховищі; після входу — accept і ключ видалено', async () => {
    const win = fakeWindow('https://app.trip-control.com/?requester_invite=r1.tok&x=1#/own-fleet');
    assert.equal(takeRequesterInviteFromUrl(win), 'r1.tok');
    assert.deepEqual(win.calls.replaced, ['/?x=1#/own-fleet']);
    const w2 = fakeWindow('https://app.trip-control.com/?requester_invite=r1.tok');
    const storage = fakeStorage();
    let session = false;
    const hints = [];
    const calls = [];
    const accept = createRequesterInviteAcceptor({ win: w2, storage, hasSession: () => session, hint: (t, k) => hints.push([t, k]),
        call: async (p, b) => { calls.push([p, b]); return { ok: true, org_name: 'Агро' }; }, onAccepted: async (n) => { calls.push(['accepted', n]); } });
    assert.equal(await accept(), false);
    assert.equal(hints.length, 1, 'підказка увійти тією поштою');
    assert.equal(JSON.parse(storage.map.get(REQUESTER_INVITE_KEY)).token, 'r1.tok');
    assert.equal(calls.length, 0);
    session = true;
    assert.equal(await accept(), true);
    assert.deepEqual(calls, [['/api/own-fleet/invites', { action: 'accept', token: 'r1.tok' }], ['accepted', 'Агро']]);
    assert.equal(storage.map.has(REQUESTER_INVITE_KEY), false, 'ключ видалено');
});

test('посилання-запрошення: відмова сервера видаляє ключ, помилка мережі — лишає; одночасні виклики = один запит; протухлий токен ігнорується', async () => {
    const storage = fakeStorage({ [REQUESTER_INVITE_KEY]: JSON.stringify({ token: 'r1.keep', at: Date.now() }) });
    const hints = [];
    let n = 0;
    const net = createRequesterInviteAcceptor({ win: fakeWindow('https://app.trip-control.com/'), storage, hasSession: () => true, hint: (t, k) => hints.push(k),
        call: async () => { n += 1; return { ok: false, network: true, error: 'offline' }; }, onAccepted: async () => {} });
    assert.equal(await net(), false);
    assert.equal(storage.map.has(REQUESTER_INVITE_KEY), true, 'без мережі ключ лишається');
    const denied = createRequesterInviteAcceptor({ win: fakeWindow('https://app.trip-control.com/'), storage, hasSession: () => true, hint: (t, k) => hints.push(k),
        call: async () => { n += 1; return { ok: false, error: 'Запрошення вже прийнято.' }; }, onAccepted: async () => {} });
    await Promise.all([denied(), denied()]);
    assert.equal(n, 2, 'мережевий виклик + один виклик на два одночасні');
    assert.equal(storage.map.has(REQUESTER_INVITE_KEY), false);
    assert.deepEqual(hints, ['error', 'error'], 'обидві невдачі показують помилку');
    const old = fakeStorage({ [REQUESTER_INVITE_KEY]: JSON.stringify({ token: 'r1.old', at: Date.now() - 8 * 24 * HOUR }) });
    assert.equal(storedRequesterInvite(old), null);
    assert.equal(old.map.has(REQUESTER_INVITE_KEY), false);
});

// ---- Межі модуля ----
test('lazy-модуль: основний бандл імпортує лише гейт; views/own-fleet вантажиться dynamic import-ом і лише з прапорцем', () => {
    const bridge = read('src/bridge.js');
    assert.doesNotMatch(bridge, /from '\.\/views\/own-fleet/, 'статичного імпорту модуля немає');
    assert.doesNotMatch(bridge, /from '\.\/lib\/own-fleet\.js'/, 'лише гейт і запрошення в основному бандлі');
    assert.match(bridge, /import\('\.\/views\/own-fleet\/index\.js'\)/);
    assert.match(bridge, /if \(!fleet\.enabled\) \{[\s\S]*?location\.hash = '#\/dashboard';[\s\S]*?return;[\s\S]*?\}\s*runCleanups\(\);\s*clear\(root, head\(\), lazyView\(\(\) => import\('\.\/views\/own-fleet\/index\.js'\)/,
        'без прапорця — редірект на огляд ДО lazy import');
    assert.match(bridge, /if \(!ownFleetAccess\(state\.ownFleet\)\.enabled\) \{ clear\(container, notice\('Розділ «Власний парк» не ввімкнено/, 'вікна карток теж за прапорцем');
    assert.ok(fs.existsSync(path.join(APP, 'src/views/own-fleet/index.js')));
    for (const file of ['src/site-bridge.js', 'src/shell.js', 'src/shell-menu.js']) assert.doesNotMatch(read(file), /own-fleet\/|lib\/own-fleet\.js/, file);
    assert.doesNotMatch(read('src/site-bridge.js'), /kp-own-fleet\.css/, 'стилі модуля вантажаться разом із чанком, не з основним бандлом');
    assert.match(read('src/views/own-fleet/index.js'), /import '\.\.\/\.\.\/kp-own-fleet\.css'/);
    assert.ok(read('src/lib/own-fleet-gate.js').split('\n').length < 30, 'гейт крихітний');
});

test('модуль: без innerHTML і діалогів браузера; права не вигадуються на клієнті (запис лише RPC fleet_request_* і RLS-таблиці units / points)', () => {
    for (const file of listFiles(APP, 'src/views/own-fleet').concat(['src/lib/own-fleet.js', 'src/lib/own-fleet-gate.js', 'src/lib/own-fleet-invite.js'])) {
        const code = read(file);
        assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
        assert.doesNotMatch(code, /window\.(alert|confirm|prompt)\(|\balert\(/, file);
        assert.doesNotMatch(code, /createClient|serviceWorker\.register/, file);
    }
    const writes = listFiles(APP, 'src/views/own-fleet').map((f) => read(f)).join('\n');
    assert.doesNotMatch(writes, /from\('fleet_requests'\)\.(insert|update|delete|upsert)/, 'заявки пише лише БД-функціями');
    assert.doesNotMatch(writes, /from\('(org_requesters|requester_invites|fleet_request_log)'\)\.(insert|update|delete|upsert)/);
    for (const rpc of ['fleet_request_create', 'fleet_request_transition', 'fleet_request_assign', 'fleet_request_conflicts']) assert.match(writes, new RegExp(rpc), rpc);
});

test('vercel / api: запрошення замовника — окремий статичний файл у api/own-fleet/, рейтліміт і формат токена на сервері', () => {
    const cfg = JSON.parse(read('vercel.json'));
    assert.deepEqual(cfg.functions['api/own-fleet/*.js'], { maxDuration: 15 });
    const api = read('api/own-fleet/invites.js');
    assert.match(api, /METHOD_NOT_ALLOWED/);
    assert.match(api, /AUTH_REQUIRED/);
    assert.match(api, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(read('lib/own-fleet/invites.js'), /console\.(log|info|debug)/, 'токен і пошта не логуються');
});

test('built dist/: код «Власного парку» лише в окремому lazy-чанку, не в основному бандлі', (t) => {
    const dir = path.join(APP, 'dist/kp-assets');
    if (!fs.existsSync(dir)) { t.skip('run npm run build first'); return; }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
    const main = files.filter(([, code]) => code.includes('kp-nav-'));
    assert.ok(main.length >= 1, 'основний бандл моста знайдено');
    for (const [name, code] of main) {
        for (const marker of ['fleet_request_transition', 'fleet_request_assign', 'org_units', 'kpof-board']) assert.equal(code.includes(marker), false, name + ' не містить ' + marker);
    }
    const lazy = files.filter(([, code]) => code.includes('fleet_request_transition'));
    assert.equal(lazy.length, 1, 'модуль — рівно один окремий чанк');
    assert.equal(main.some(([name]) => name === lazy[0][0]), false);
    assert.ok(files.length > 3);
});

test('дії: «Зняти призначення» лише для персоналу й лише з assigned', () => {
    const unassign = (r, role) => nextActions(r, role, 'u-req').find((a) => a.to === 'accepted');
    for (const role of ['owner', 'director', 'logist']) assert.equal(unassign(row(1, 'assigned'), role).label, 'Зняти призначення', role);
    assert.equal(unassign(row(1, 'assigned'), 'requester'), undefined);
    for (const st of ['new', 'accepted', 'in_progress', 'done']) assert.equal(unassign(row(1, st), 'owner') === undefined || st === 'new', true, st);
    assert.equal(nextActions(row(1, 'new'), 'owner').find((a) => a.to === 'accepted').label, 'Прийняти', 'у new «accepted» — це «Прийняти»');
});

test('тексти помилок рев\'ю: причіп в архіві, чужий подорожній, акаунт працює в іншій компанії', () => {
    assert.match(ownFleetErrorText({ message: 'FLEET_REQUEST_TRAILER_ARCHIVED' }), /Причіп в архіві/);
    assert.match(ownFleetErrorText({ message: 'FLEET_REQUEST_BAD_TRIP' }), /Подорожній лист не знайдено/);
    assert.match(ownFleetErrorText({ message: 'REQUESTER_WORKS_ELSEWHERE' }), /уже працює в іншій компанії/);
});

test('API запрошень: акаунт, що вже працює в іншій компанії, — 409 REQUESTER_WORKS_ELSEWHERE з окремим текстом', async () => {
    const token = 'r1.' + UUID + '.' + 'A'.repeat(32);
    const h = createOwnFleetInvitesHandler({ store: fakeStore({ accept: async () => { throw new Error('REQUESTER_WORKS_ELSEWHERE'); } }), log: quiet });
    const out = await call(h, { auth: 'Bearer req', body: { action: 'accept', token } });
    assert.equal(out.code, 409);
    assert.equal(out.body.code, 'REQUESTER_WORKS_ELSEWHERE');
    assert.match(out.body.error, /уже працює в іншій компанії/);
});

test('меню: «Власний парк» має власну іконку, не таку, як «Автопарк»', () => {
    const own = SHELL_ITEMS.find((i) => i.key === 'own_fleet');
    const fleet = SHELL_ITEMS.find((i) => i.key === 'fleet');
    assert.equal(own.icon, 'own_fleet');
    assert.notEqual(own.icon, fleet.icon);
    assert.equal(own.label, 'Власний парк');
});

test('«Команда»: блок «Замовники підрозділів» вставляє міст лише директору й менеджеру з прапорцем; інакше блоку немає', () => {
    const bridge = read('src/bridge.js');
    assert.match(bridge, /if \(tab === 'team'\) fillRequestersBlock\(\);/, 'з вкладки «Команда» кабінету');
    assert.match(bridge, /const allowed = access\.enabled && \(access\.role === 'owner' \|\| access\.role === 'director'\);/);
    assert.match(bridge, /if \(!allowed\) \{ if \(slot\) slot\.remove\(\); return; \}/, 'без прапорця чи без прав блок прибирається');
    assert.match(bridge, /host\.after\(slot\)/, 'міст вставляє слот сам: index.html сайту не змінюється');
    assert.match(read('src/views/own-fleet/requesters.js'), /if \(role !== 'owner' && role !== 'director'\) return h\('div', \{ hidden: true \}\);/, 'і сам блок перевіряє роль');
    assert.doesNotMatch(read('src/site-bridge.js'), /requesters/);
});
