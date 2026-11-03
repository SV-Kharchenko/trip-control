// Тріал 7 днів для нових компаній (сайт і Контроль+): доступ, «лише читання», банер, cron без дублів, міграція 20261117090000.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { isOrgReadOnly, isReadOnlyAccess, loadPaidUntil, trialInfo } from '../lib/billing/access.js';
import { buildTrialEmail } from '../lib/billing/mail.js';
import { createBillingHandler } from '../lib/billing/service.js';
import { baseEnv, DAY, fakeNet, memoryStore, NOW, ORG, OTHER_ORG, request, response } from './billing-fakes.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const migration = read('supabase/migrations/20261117090000_trial_7d.sql');

// Реєстрація 14.10.2026 10:00 за Києвом → кінець тріалу = початок доби 21.10 за Києвом (20.10 21:00 UTC), NOW = 18.10 12:00 за Києвом.
const TRIAL_END = '2026-10-20T21:00:00.000Z';

test('trialInfo: у день реєстрації 7, в останній день 1 (жовтий), після кінця — «лише читання»', () => {
    const at = (iso) => trialInfo(TRIAL_END, Date.parse(iso));
    assert.equal(at('2026-10-14T07:00:00Z').daysLeft, 7);
    assert.equal(at(new Date(NOW).toISOString()).daysLeft, 3);
    assert.deepEqual([at('2026-10-20T05:00:00Z').daysLeft, at('2026-10-20T05:00:00Z').lastDay], [1, true]);
    assert.equal(at('2026-10-20T20:59:59Z').active, true, 'до кінця 7-го дня за Києвом');
    assert.deepEqual([at('2026-10-20T21:00:00Z').active, at('2026-10-20T21:00:00Z').expired], [false, true]);
    assert.equal(trialInfo(null).has, false, 'наявні компанії тріалу не мають');
});

test('isReadOnlyAccess: лише після тріалу без оплати й без ручного доступу; оплата одразу знімає', () => {
    const after = Date.parse('2026-10-22T09:00:00Z');
    assert.equal(isReadOnlyAccess({ trialEndsAt: TRIAL_END, paidUntil: null, isApproved: false }, after), true);
    assert.equal(isReadOnlyAccess({ trialEndsAt: TRIAL_END, paidUntil: '2026-11-22T09:00:00Z', isApproved: false }, after), false, 'оплата');
    assert.equal(isReadOnlyAccess({ trialEndsAt: TRIAL_END, paidUntil: null, isApproved: true }, after), false, 'is_approved');
    assert.equal(isReadOnlyAccess({ trialEndsAt: null, paidUntil: null, isApproved: false }, after), false, 'стара компанія без тріалу не змінюється');
    assert.equal(isReadOnlyAccess({ trialEndsAt: TRIAL_END, paidUntil: null, isApproved: false }, NOW), false, 'тріал іще триває');
});

function supabaseFake(tables) {
    return {
        from(table) {
            const rows = tables[table];
            const filters = [];
            const api = {
                select() { return api; },
                eq(col, val) { filters.push([col, val]); return api; },
                limit() { return api; },
                async maybeSingle() {
                    if (rows === 'error') return { data: null, error: { code: '42703' } };
                    const found = (rows || []).filter((r) => filters.every(([c, v]) => r[c] === v));
                    return { data: found[0] || null, error: null };
                },
                then(resolve) {
                    const found = rows === 'error' ? [] : (rows || []).filter((r) => filters.every(([c, v]) => r[c] === v));
                    return Promise.resolve({ data: found, error: null }).then(resolve);
                },
            };
            return api;
        },
    };
}

test('сервер: loadPaidUntil бере пізніше з paid_until / trial_ends_at; isOrgReadOnly після тріалу, але не для is_approved', async () => {
    const trialOnly = supabaseFake({ org_subscriptions: [{ org_id: ORG, paid_until: null, trial_ends_at: TRIAL_END }], profiles: [{ id: 'u', org_id: ORG, is_approved: false }] });
    assert.equal(await loadPaidUntil(trialOnly, ORG), TRIAL_END, 'активний тріал рахується доступом (не демо)');
    const paid = supabaseFake({ org_subscriptions: [{ org_id: ORG, paid_until: '2027-01-01T00:00:00.000Z', trial_ends_at: TRIAL_END }] });
    assert.equal(await loadPaidUntil(paid, ORG), '2027-01-01T00:00:00.000Z');
    const legacy = supabaseFake({ org_subscriptions: [{ org_id: ORG, paid_until: null }] });
    assert.equal(await loadPaidUntil(legacy, ORG), null);
    const after = Date.parse('2026-10-22T09:00:00Z');
    assert.equal(await isOrgReadOnly(trialOnly, ORG, null, after), true);
    assert.equal(await isOrgReadOnly(trialOnly, ORG, null, NOW), false);
    assert.equal(await isOrgReadOnly(paid, ORG, null, after), false);
    assert.equal(await isOrgReadOnly(legacy, ORG, null, after), false);
    const approved = supabaseFake({ org_subscriptions: [{ org_id: ORG, trial_ends_at: TRIAL_END }], profiles: [{ id: 'u', org_id: ORG, is_approved: true }] });
    assert.equal(await isOrgReadOnly(approved, ORG, null, after), false, 'ручний повний доступ — постійний');
    const noColumns = supabaseFake({ org_subscriptions: 'error' });
    assert.equal(await isOrgReadOnly(noColumns, ORG, null, after), false, 'міграція не застосована — без змін');
});

function cronWorld(envExtra = {}) {
    const clock = { now: NOW };
    const net = fakeNet({});
    const store = memoryStore(clock);
    const handler = createBillingHandler({ store, fetch: net.fetch, env: baseEnv(envExtra), now: () => clock.now });
    const call = async (route, options) => { const res = response(); await handler(request('GET', route, options), res); return res; };
    const cron = () => call('cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    const mails = () => net.calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.body));
    return { clock, net, store, call, cron, mails };
}

test('cron: тріал — сповіщення й лист на 5-й і 7-й день, без дублів; оплачені й старі компанії не отримують', async () => {
    const w = cronWorld();
    w.store.db.subs[ORG] = { org_id: ORG, paid_until: null, trial_ends_at: TRIAL_END, trial_notified_d5: null, trial_notified_d7: null };
    w.store.db.subs[OTHER_ORG] = { org_id: OTHER_ORG, paid_until: '2027-01-01T00:00:00.000Z', trial_ends_at: TRIAL_END };
    // 18.10 (залишилось 3 дні) = 5-й день.
    const first = await w.cron();
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.trial.sent, 1);
    assert.deepEqual(w.store.db.notifications.map((n) => [n.org_id, n.kind, n.meta.days_left]), [[ORG, 'trial_day5', 3]]);
    assert.equal(w.mails().length, 1);
    assert.deepEqual(w.mails()[0].to, ['owner@agro.ua']);
    assert.equal(w.mails()[0].subject, 'Trip Control: залишилось 3 дні тріалу');
    assert.match(w.mails()[0].text, /250 грн/);
    assert.match(w.mails()[0].text, /billing=pay/);
    assert.ok(w.store.db.subs[ORG].trial_notified_d5);
    // Повторні прогони того ж дня — без дублів.
    await w.cron();
    await w.cron();
    assert.equal(w.mails().length, 1);
    assert.equal(w.store.db.notifications.length, 1);
    // 19.10 (залишилось 2 дні) — 5-й день вже відправлено.
    w.clock.now = NOW + DAY;
    await w.cron();
    assert.equal(w.mails().length, 1);
    // 20.10 — останній день (7-й): одне сповіщення й один лист.
    w.clock.now = NOW + 2 * DAY;
    const last = await w.cron();
    assert.equal(last.body.trial.sent, 1);
    assert.equal(w.store.db.notifications[1].kind, 'trial_day7');
    assert.equal(w.mails()[1].subject, 'Trip Control: сьогодні останній день тріалу');
    await w.cron();
    assert.equal(w.mails().length, 2);
    assert.equal(w.store.db.notifications.length, 2);
    // Після закінчення тріалу cron нічого не шле.
    w.clock.now = Date.parse('2026-10-22T07:00:00Z');
    await w.cron();
    assert.equal(w.mails().length, 2);
});

test('cron: без налаштованої пошти тріал не позначається (fail closed); лист не дійшов — позначка знімається', async () => {
    const noMail = cronWorld({ RESEND_API_KEY: '', REPORT_FROM_EMAIL: '' });
    noMail.store.db.subs[ORG] = { org_id: ORG, paid_until: null, trial_ends_at: TRIAL_END };
    const r = await noMail.cron();
    assert.equal(r.body.trial.sent, 0);
    assert.equal(noMail.store.db.subs[ORG].trial_notified_d5, undefined);
    const legacy = cronWorld();
    legacy.store.db.subs[ORG] = { org_id: ORG, paid_until: null, trial_ends_at: null };
    await legacy.cron();
    assert.equal(legacy.mails().length, 0, 'компанії без тріалу листів не отримують');
});

test('summary: директор бачить тріал і може платити; логіст після кінця — read_only без can_pay', async () => {
    const w = cronWorld();
    w.store.db.subs[ORG] = { org_id: ORG, paid_until: null, trial_ends_at: TRIAL_END };
    const owner = await w.call('summary', { token: 'owner' });
    assert.equal(owner.statusCode, 200);
    assert.deepEqual([owner.body.trial_active, owner.body.trial_days_left, owner.body.read_only, owner.body.can_pay], [true, 3, false, true]);
    w.clock.now = Date.parse('2026-10-22T09:00:00Z');
    const logist = await w.call('summary', { token: 'logist' });
    assert.deepEqual([logist.body.trial_active, logist.body.read_only, logist.body.can_pay], [false, true, false]);
    const ownerAfter = await w.call('summary', { token: 'owner' });
    assert.deepEqual([ownerAfter.body.read_only, ownerAfter.body.can_pay], [true, true]);
    w.store.db.subs[ORG].paid_until = '2026-11-22T09:00:00.000Z';
    assert.equal((await w.call('summary', { token: 'owner' })).body.read_only, false, 'оплата знімає обмеження');
});

test('лист тріалу: Контроль+ — «Замовити договір» замість оплати карткою', () => {
    const site = buildTrialEmail({ day: 5, daysLeft: 3, baseUrl: 'https://trip-control.com', orgName: 'ТОВ', kp: false });
    const kp = buildTrialEmail({ day: 7, daysLeft: 1, baseUrl: 'https://trip-control.com', orgName: 'ТОВ', kp: true });
    assert.match(site.html, />Оплатити<\/a>/);
    assert.match(kp.html, />Замовити договір<\/a>/);
    assert.match(kp.text, /kontrol-plus#demo/);
    assert.equal(kp.text.includes('billing=pay'), false);
});

// --- Банер (index.html) ---
function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}
const FIXED = NOW;
class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(FIXED); }
    static now() { return FIXED; }
}
function bannerWorld(extra = {}) {
    const els = {};
    const make = (id) => (els[id] = {
        id, hidden: true, textContent: '', onclick: null, classes: new Set(),
        classList: { toggle(c, on) { if (on) els[id].classes.add(c); else els[id].classes.delete(c); }, add(c) { els[id].classes.add(c); }, remove(...cs) { cs.forEach((c) => els[id].classes.delete(c)); } },
    });
    ['billing-banner', 'billing-banner-text', 'billing-banner-btn'].forEach(make);
    make('body');
    const opened = { billing: 0, urls: [] };
    const ctx = vm.createContext({
        Date: FixedDate, Intl, Number, Math, window: { open: (url) => opened.urls.push(url) },
        document: { getElementById: (id) => els[id] || null, body: els.body },
        isKP: () => false, kpDirectorActive: () => false, currentOrgRole: 'owner',
        billingTrialEndsAt: null, billingExpiredShown: false, billingManualAccess: false, billingPaidUntil: null, billingEnabled: true, billingAutoRenewOn: false,
        openBillingModal: () => { opened.billing += 1; }, billingDate: () => '01.01.2027', ...extra,
    });
    vm.runInContext(['billingPaidActive', 'billingKyivDay', 'billingTrial', 'billingReadOnly', 'billingDaysText', 'openTrialContract', 'syncTrialBanner', 'syncBillingBanner'].map(fnSource).join('\n'), ctx);
    return { ctx, els, opened, sync: () => vm.runInContext('syncBillingBanner()', ctx) };
}

test('банер сайту: «Тріал: залишилось N днів» + «Оплатити»; в останній день жовтий; після кінця — модалка й «лише читання»', () => {
    const w = bannerWorld();
    w.ctx.billingTrialEndsAt = TRIAL_END; // NOW = 18.10 → 3 дні
    w.sync();
    assert.equal(w.els['billing-banner'].hidden, false);
    assert.equal(w.els['billing-banner-text'].textContent, 'Тріал: залишилось 3 дні.');
    assert.equal(w.els['billing-banner-btn'].textContent, 'Оплатити');
    assert.equal(w.els['billing-banner-btn'].hidden, false);
    assert.equal(w.els['billing-banner'].classes.has('is-warn'), false);
    w.els['billing-banner-btn'].onclick();
    assert.equal(w.opened.billing, 1, 'кнопка відкриває модалку з тарифами 250 / 2500');
    // Останній день: 20.10.
    const last = bannerWorld();
    last.ctx.billingTrialEndsAt = '2026-10-18T21:00:00.000Z';
    last.sync();
    assert.equal(last.els['billing-banner'].classes.has('is-warn'), true, 'останній день — жовтий');
    assert.match(last.els['billing-banner-text'].textContent, /останній день/);
    // Після кінця.
    const done = bannerWorld();
    done.ctx.billingTrialEndsAt = '2026-10-17T21:00:00.000Z';
    done.sync();
    assert.match(done.els['billing-banner-text'].textContent, /лише читання/);
    assert.equal(done.els['billing-banner'].classes.has('is-expired'), true);
    assert.equal(done.els.body.classes.has('trial-readonly'), true);
    assert.equal(done.opened.billing, 1, 'модалка з вибором тарифу відкривається один раз');
    done.sync();
    assert.equal(done.opened.billing, 1);
    assert.equal(vm.runInContext('billingReadOnly()', done.ctx), true);
});

test('банер: Контроль+ — «Замовити договір» (форма /kontrol-plus#demo → /api/kp-lead), без оплати карткою', () => {
    const w = bannerWorld({ isKP: () => true });
    w.ctx.billingTrialEndsAt = TRIAL_END;
    w.ctx.billingEnabled = false;
    w.sync();
    assert.equal(w.els['billing-banner-btn'].textContent, 'Замовити договір');
    assert.equal(w.els['billing-banner-btn'].hidden, false);
    w.els['billing-banner-btn'].onclick();
    assert.deepEqual(w.opened.urls, ['https://trip-control.com/kontrol-plus#demo']);
    assert.equal(w.opened.billing, 0);
    assert.ok(read('landing/kontrol-plus.html').includes('id="demo"') && read('landing/kontrol-plus.html').includes("'/api/kp-lead'"));
    // Директор КП (org_directors) теж бачить банер із кнопкою.
    const dir = bannerWorld({ isKP: () => true, kpDirectorActive: () => true, currentOrgRole: 'logist' });
    dir.ctx.billingTrialEndsAt = TRIAL_END;
    dir.sync();
    assert.equal(dir.els['billing-banner-btn'].hidden, false);
});

test('права: логіст бачить лише «Тріал закінчився, зверніться до директора»; поки тріал триває — банера немає', () => {
    const active = bannerWorld({ currentOrgRole: 'logist' });
    active.ctx.billingTrialEndsAt = TRIAL_END;
    active.sync();
    assert.equal(active.els['billing-banner'].hidden, true);
    const done = bannerWorld({ currentOrgRole: 'logist' });
    done.ctx.billingTrialEndsAt = '2026-10-17T21:00:00.000Z';
    done.sync();
    assert.equal(done.els['billing-banner'].hidden, false);
    assert.match(done.els['billing-banner-text'].textContent, /^Тріал закінчився, зверніться до директора/);
    assert.equal(done.els['billing-banner-btn'].hidden, true);
    assert.equal(done.opened.billing, 0, 'модалку логісту не показуємо');
});

test('компанії без тріалу й оплачені: банер тріалу не з\'являється, поведінка не змінилась', () => {
    const legacy = bannerWorld();
    legacy.sync();
    assert.equal(legacy.els['billing-banner'].hidden, true);
    const paid = bannerWorld({ billingPaidUntil: '2026-10-19T09:00:00.000Z' });
    paid.ctx.billingTrialEndsAt = '2026-10-17T21:00:00.000Z';
    paid.sync();
    assert.match(paid.els['billing-banner-text'].textContent, /^Доступ діє до/, 'оплачено — звичайний банер продовження');
    assert.equal(vm.runInContext('billingReadOnly()', paid.ctx), false);
});

test('index.html: тріал не вмикає демо; відмова TRIAL_EXPIRED при збереженні; сповіщення trial_day5 / trial_day7', () => {
    assert.ok(html.includes('billingPaidActive(billingPaidUntil) || billingTrial().active)'));
    assert.match(fnSource('saveCalculation'), /TRIAL_EXPIRED/);
    assert.ok(html.includes('trial_day5:') && html.includes('trial_day7:'));
    assert.ok(read('api/calculate.js').includes("'TRIAL_EXPIRED'") && read('api/team.js').includes("'TRIAL_EXPIRED'"), 'сервер також відмовляє');
});

test('міграція: колонки, trial_claims, тригери, читання лишається, відкат, нічого не видаляється/не змінюється для наявних', () => {
    assert.ok(migration.startsWith('-- Apply manually after review. This file is not applied to production by the agent.'));
    for (const part of ['ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz NULL', 'trial_notified_d5', 'trial_notified_d7', 'CREATE TABLE IF NOT EXISTS public.trial_claims',
        'REFERENCES public.organizations (id) ON DELETE CASCADE', 'ALTER TABLE public.trial_claims ENABLE ROW LEVEL SECURITY', "'Europe/Kyiv'", "interval '7 days'",
        'CREATE OR REPLACE FUNCTION public.org_readonly(p_org uuid)', 'CREATE OR REPLACE FUNCTION public.current_is_approved()', 'org_trial_active(public.current_org_id())',
        "RAISE EXCEPTION 'TRIAL_EXPIRED' USING ERRCODE = '42501'", 'BEFORE INSERT OR UPDATE ON public.%I', "ARRAY['calculations', 'kp_documents', 'kp_document_lines', 'kp_contracts', 'kp_doc_ttn', 'kp_other_docs']",
        "'trial_day5', 'trial_day7'", 'trg_trial_start', 'trg_trial_tax_claim', 'CREATE OR REPLACE FUNCTION public.org_has_user_data(']) assert.ok(migration.includes(part), part);
    const body = migration.slice(migration.lastIndexOf('BEGIN;'));
    assert.equal(/UPDATE public\.org_subscriptions\s+SET trial_ends_at = (?!NULL)/.test(body), false, 'наявним компаніям тріал не виставляється');
    assert.equal(/INSERT INTO public\.org_subscriptions[^;]*SELECT/i.test(body), false, 'без backfill тріалу для наявних компаній');
    assert.equal(/DELETE FROM|DROP TABLE|TRUNCATE/.test(body), false, 'нічого не видаляється');
    assert.equal(/BEFORE (INSERT OR UPDATE OR DELETE|DELETE)/.test(body), false, 'DELETE не блокується');
    const head = migration.slice(migration.indexOf('-- РУЧНИЙ ВІДКАТ'), migration.indexOf('\nBEGIN;\n'));
    for (const part of ['DROP TRIGGER IF EXISTS trg_trial_readonly ON public.calculations', 'DROP TRIGGER IF EXISTS trg_trial_start', 'DROP FUNCTION IF EXISTS public.org_readonly(uuid)',
        'DROP TABLE IF EXISTS public.trial_claims', 'DROP COLUMN IF EXISTS trial_ends_at', "'approval_decided')"]) assert.ok(head.includes(part), part);
    assert.ok(head.indexOf('CREATE OR REPLACE FUNCTION public.current_is_approved()') < head.indexOf('DROP FUNCTION IF EXISTS public.org_trial_active(uuid)'), 'функція повертається до оригіналу до видалення хелперів');
    assert.ok(head.indexOf('DROP TRIGGER IF EXISTS trg_trial_readonly') < head.indexOf('DROP FUNCTION IF EXISTS public.trial_readonly_guard()'));
    const tap = read('supabase/tests/trial_7d.sql');
    assert.ok(tap.includes('SELECT plan(14);'));
    assert.equal(tap.split('\n').filter((l) => /^SELECT (is|ok|like)\(/.test(l)).length, 14);
});
