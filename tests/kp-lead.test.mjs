// Лендинг /kontrol-plus і заявка «Замовити демо»: валідація, пастка, ліміт за IP, запис і лист (з моками), посилання, privacy, міграція.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const { validateLead, processLead, ipHash, resetSaltWarning } = await import('../lib/kp-lead.js');
const { createBillingService } = await import('../lib/billing/service.js');
const { baseEnv, memoryStore, NOW } = await import('./billing-fakes.mjs');
const { buildLeadEmail, LEAD_TO } = await import('../lib/kp-lead-mail.js');
const { createKpLeadHandler } = await import('../api/kp-lead.js');

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const good = { name: 'Іван', company: 'ТОВ Транс', phone: '+380 50 111 22 33', email: 'ivan@example.com', vehicles: '12', comment: 'Є питання', consent: true };

const res = () => {
    const out = { headers: {} };
    out.setHeader = (k, v) => { out.headers[k] = v; };
    out.status = (code) => { out.code = code; return out; };
    out.json = (body) => { out.body = body; return out; };
    return out;
};
const req = (body, extra = {}) => ({ method: 'POST', body, headers: { 'x-vercel-forwarded-for': '192.0.2.44' }, socket: {}, ...extra });
const okRpc = async () => ({ data: [{ allowed: true }], error: null });

test('валідація: обовʼязкові поля, телефон, email, кількість машин, згода', () => {
    const ok = validateLead(good);
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(ok.lead)), { name: 'Іван', company: 'ТОВ Транс', phone: '+380 50 111 22 33', email: 'ivan@example.com', vehicles: 12, comment: 'Є питання' });
    const min = validateLead({ name: 'А', company: 'Б', phone: '0501112233', consent: 'on' });
    assert.equal(min.ok, true);
    assert.equal(min.lead.email, null);
    assert.equal(min.lead.vehicles, null);
    const bad = validateLead({ name: ' ', company: '', phone: 'abc', email: 'не-пошта', vehicles: '0', consent: false });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['company', 'consent', 'email', 'name', 'phone', 'vehicles']);
    assert.equal(validateLead({ ...good, phone: '12345' }).ok, false, 'занадто короткий');
    assert.equal(validateLead({ ...good, vehicles: '2.5' }).ok, false);
    assert.equal(validateLead({ ...good, consent: undefined }).errors.consent.length > 0, true);
    assert.equal(validateLead(null).ok, false);
    assert.equal(validateLead({ ...good, name: 'x'.repeat(500) }).lead.name.length, 120, 'довжина обрізається');
});

test('пастка: заповнене приховане поле → 200 без запису й листа', async () => {
    const calls = [];
    const deps = { insert: async (r) => { calls.push(['insert', r]); return { error: null }; }, sendMail: async (m) => { calls.push(['mail', m]); } };
    const out = await processLead({ ...good, website: 'http://spam.example' }, '192.0.2.1', deps);
    assert.deepEqual(out, { status: 200, body: { ok: true } });
    assert.equal(calls.length, 0);
});

test('запис: рядок зі status new і хешем IP, лист на support@, відповідь 200', async () => {
    const calls = [];
    const deps = { ipSalt: 'salt-A', insert: async (r) => { calls.push(['insert', r]); return { error: null }; }, sendMail: async (m) => { calls.push(['mail', m]); } };
    const out = await processLead(good, '192.0.2.1', deps);
    assert.equal(out.status, 200);
    assert.equal(calls[0][0], 'insert');
    assert.equal(calls[0][1].status, 'new');
    assert.equal(calls[0][1].ip_hash, ipHash('192.0.2.1', 'salt-A'));
    assert.match(calls[0][1].ip_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(calls[0][1]).includes('192.0.2.1'), false, 'сирого IP немає');
    assert.equal(calls[1][0], 'mail');
    assert.match(calls[1][1].subject, /ТОВ Транс/);
    assert.match(calls[1][1].text, /Телефон: \+380 50 111 22 33/);
});

test('збій листа не губить заявку; збій бази → 500', async () => {
    const failMail = await processLead(good, 'ip', { insert: async () => ({ error: null }), sendMail: async () => { throw new Error('resend down'); } });
    assert.equal(failMail.status, 200);
    const failDb = await processLead(good, 'ip', { insert: async () => ({ error: { message: 'x' } }), sendMail: async () => { throw new Error('не має викликатись'); } });
    assert.equal(failDb.status, 500);
    assert.equal(failDb.body.code, 'LEAD_SAVE_FAILED');
});

test('лист: екранування HTML і одна лінія в темі', () => {
    const m = buildLeadEmail({ name: '<b>x</b>', company: 'А\r\nBcc: evil@example.com', phone: '1', email: null, vehicles: null, comment: '"q" & <i>' });
    assert.equal(/[\r\n]/.test(m.subject), false);
    assert.equal(m.html.includes('<b>x</b>'), false);
    assert.match(m.html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(m.html, /&quot;q&quot; &amp; &lt;i&gt;/);
    assert.equal(LEAD_TO, 'support@trip-control.com');
});

test('обробник: метод, ліміт за IP (429), валідація (400), успіх (200) і лист через Resend на support@', async () => {
    const methodRes = res();
    await createKpLeadHandler({ rpc: okRpc })({ method: 'GET', headers: {}, socket: {} }, methodRes);
    assert.equal(methodRes.code, 405);

    const rpcArgs = [];
    const limited = res();
    await createKpLeadHandler({ rpc: async (a) => { rpcArgs.push(a); return { data: [{ allowed: false, retry_after: 30 }], error: null }; }, insert: async () => { throw new Error('no'); } })(req(good), limited);
    assert.equal(limited.code, 429);
    assert.equal(limited.headers['Retry-After'], '30');
    assert.equal(rpcArgs[0].p_limit, 5, 'ліміт 5/хв за IP');
    assert.match(rpcArgs[0].p_bucket, /^kp-lead:[0-9a-f]{32}$/);
    // Bearer-токен вищого ліміту не дає: ліміт той самий.
    const withToken = [];
    await createKpLeadHandler({ rpc: async (a) => { withToken.push(a); return { data: [{ allowed: true }], error: null }; }, insert: async () => ({ error: null }), sendMail: async () => {} })(
        req(good, { headers: { authorization: 'Bearer abc', 'x-vercel-forwarded-for': '192.0.2.44' } }), res());
    assert.equal(withToken[0].p_limit, 5);
    assert.equal(withToken[0].p_bucket, rpcArgs[0].p_bucket);

    const invalid = res();
    await createKpLeadHandler({ rpc: okRpc, insert: async () => { throw new Error('no'); } })(req({ ...good, consent: false }), invalid);
    assert.equal(invalid.code, 400);
    assert.ok(invalid.body.errors.consent);
    const badJson = res();
    await createKpLeadHandler({ rpc: okRpc })(req('{не json'), badJson);
    assert.equal(badJson.code, 400);

    const inserted = [];
    const fetched = [];
    const okRes = res();
    await createKpLeadHandler({
        rpc: okRpc,
        env: { RESEND_API_KEY: 're_test', INVITE_FROM_EMAIL: 'Trip Control <noreply@trip-control.com>' },
        insert: async (r) => { inserted.push(r); return { error: null }; },
        fetch: async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 200 }; }
    })(req(JSON.stringify(good)), okRes);
    assert.equal(okRes.code, 200);
    assert.deepEqual(okRes.body, { ok: true });
    assert.equal(inserted.length, 1);
    assert.equal(fetched[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(JSON.parse(fetched[0].init.body).to, ['support@trip-control.com']);
});

test('лендинг: секції, ціна, тексти оплати, форма, футер як на інших сторінках, тема, без онлайн-оплати', () => {
    const html = read('landing/kontrol-plus.html');
    for (const id of ['features', 'price', 'custom', 'faq', 'demo']) assert.match(html, new RegExp('id="' + id + '"'));
    for (const text of ['Замовити демо', 'Доопрацювання під вас', '250', '100', 'разово', 'у.е./міс', 'Оплата за договором і рахунком на ФОП, без онлайн-оплати карткою',
        'режим лише для читання', 'Дані не видаляються', 'Дякуємо, зв’яжемося протягом робочого дня', 'оцінюються й оплачуються окремо']) assert.ok(html.includes(text), text);
    for (const name of ['name', 'company', 'phone', 'email', 'vehicles', 'comment', 'website', 'consent']) assert.match(html, new RegExp('name="' + name + '"'));
    assert.match(html, /<link rel="canonical" href="https:\/\/trip-control\.com\/kontrol-plus">/);
    assert.match(html, /\[data-theme="dark"\]/);
    assert.match(html, /max-width: 600px/);
    assert.equal((html.match(/<script defer src="\/_vercel\/insights\/script\.js"><\/script>/g) || []).length, 1);
    const footer = html.match(/<footer class="tc-legal-footer">[\s\S]*?<\/footer>/)[0];
    for (const value of ['ФОП Харченко С.В.', 'mailto:support@trip-control.com', 'tel:+380730888252', '<a href="/offer#requisites">Реквізити</a>', '<a href="/kontrol-plus">Контроль+ для компаній</a>', 'href="/privacy"', 'href="/offer"', 'href="/payment-refund"']) assert.ok(footer.includes(value), value);
    assert.match(html.match(/<nav class="kp-nav"[\s\S]*?<\/nav>/)[0], /Контроль\+ для компаній/);
    assert.equal(/api\/(billing|checkout)/.test(html), false, 'без онлайн-оплати');
});

test('маршрут, sitemap, privacy і посилання в кабінеті сайту (лише !isKP())', () => {
    const vercel = JSON.parse(read('vercel.json'));
    assert.deepEqual(vercel.rewrites.find((r) => r.source === '/kontrol-plus'), { source: '/kontrol-plus', destination: '/landing/kontrol-plus.html' });
    assert.match(read('sitemap.xml'), /<loc>https:\/\/trip-control\.com\/kontrol-plus<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    const privacy = read('legal/privacy.html');
    assert.match(privacy, /Заявка на демо Контроль\+[^<]*[\s\S]{0,400}Заявку зберігаємо 1 рік/);
    const index = read('index.html');
    assert.match(index, /\(!isKP\(\) \? '<p class="cab-note cab-kp-demo">Потрібна CRM для автопарку\? <a href="\/kontrol-plus"[^']*>Замовити демо<\/a><\/p>' : ''\)/);
});

test('міграція kp_leads: RLS без політик, гранти лише service_role, ручний відкат, pgTAP-тест', () => {
    const sql = read('supabase/migrations/20261111090000_kp_leads.sql');
    assert.match(sql, /^-- Apply manually after review\. This file is not applied to production by the agent\./);
    assert.match(sql, /РУЧНИЙ ВІДКАТ/);
    for (const col of ['id uuid PRIMARY KEY', 'created_at timestamptz', 'name text NOT NULL', 'company text NOT NULL', 'phone text NOT NULL', 'email text', 'vehicles integer', 'comment text', "status text NOT NULL DEFAULT 'new'", 'ip_hash text']) assert.ok(sql.includes(col), col);
    assert.match(sql, /ALTER TABLE public\.kp_leads ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.kp_leads FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT ALL ON TABLE public\.kp_leads TO service_role/);
    assert.equal(/CREATE POLICY/i.test(sql), false);
    const tap = read('supabase/tests/kp_leads.sql');
    assert.match(tap, /SELECT plan\(9\)/);
    assert.equal((tap.match(/^SELECT (ok|is|throws_ok)\(/gm) || []).length, 9);
});

test('сіль: хеш залежить від солі й IP, без солі ip_hash = null і одне попередження без IP', async () => {
    assert.notEqual(ipHash('192.0.2.1', 'salt-A'), ipHash('192.0.2.1', 'salt-B'));
    assert.notEqual(ipHash('192.0.2.1', 'salt-A'), ipHash('192.0.2.2', 'salt-A'));
    assert.equal(ipHash('192.0.2.1', 'salt-A'), ipHash('192.0.2.1', 'salt-A'));
    assert.match(ipHash('192.0.2.1', 'salt-A'), /^[0-9a-f]{64}$/);
    assert.equal(ipHash('192.0.2.1', ''), null);
    assert.equal(ipHash('192.0.2.1'), null);
    resetSaltWarning();
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    const rows = [];
    try {
        const deps = { insert: async (r) => { rows.push(r); return { error: null }; }, sendMail: async () => {} };
        assert.equal((await processLead(good, '203.0.113.9', deps)).status, 200, 'без солі не падаємо');
        assert.equal((await processLead(good, '203.0.113.9', deps)).status, 200);
    } finally {
        console.warn = original;
    }
    assert.deepEqual(rows.map((r) => r.ip_hash), [null, null]);
    assert.equal(warnings.length, 1, 'попередження один раз');
    assert.equal(warnings[0].includes('203.0.113.9'), false, 'без IP у логу');
    assert.match(read('.env.example'), /^KP_LEAD_IP_SALT=$/m);
    assert.match(read('api/kp-lead.js'), /ipSalt: env[.]KP_LEAD_IP_SALT/);
});

test('413: тіло понад 16 КБ → PAYLOAD_TOO_LARGE без запису, листа й ліміту', async () => {
    const touched = [];
    const deps = { rpc: async () => { touched.push('rpc'); return { data: [{ allowed: true }], error: null }; }, insert: async () => { touched.push('insert'); return { error: null }; }, sendMail: async () => { touched.push('mail'); } };
    const handler = createKpLeadHandler(deps);
    const big = { ...good, comment: 'я'.repeat(9000) };
    for (const request of [req(big), req(JSON.stringify(big)), req(good, { headers: { 'x-vercel-forwarded-for': '192.0.2.44', 'content-length': '20000' } })]) {
        const out = res();
        await handler(request, out);
        assert.equal(out.code, 413);
        assert.deepEqual(out.body, { error: 'PAYLOAD_TOO_LARGE' });
    }
    assert.deepEqual(touched, []);
    // Звичайна заявка (обмежена 2000 символів коментаря) проходить.
    const small = res();
    await createKpLeadHandler({ rpc: okRpc, insert: async () => ({ error: null }), sendMail: async () => {} })(req({ ...good, comment: 'я'.repeat(2000) }), small);
    assert.equal(small.code, 200);
});

test('дубль сторінки: /landing/kontrol-plus.html → 301 на /kontrol-plus, інші rewrite-и ті самі', () => {
    const vercel = JSON.parse(read('vercel.json'));
    assert.deepEqual(vercel.redirects, [{ source: '/landing/kontrol-plus.html', destination: '/kontrol-plus', statusCode: 301 }]);
    assert.equal(vercel.rewrites.length, 5);
    assert.deepEqual(vercel.rewrites.find((r) => r.source === '/kontrol-plus'), { source: '/kontrol-plus', destination: '/landing/kontrol-plus.html' });
});

test('шапка на 360px: один рядок, кнопка теми не менше 40×40', () => {
    const html = read('landing/kontrol-plus.html');
    assert.ok(html.includes('.kp-theme { min-width: 40px; min-height: 40px;'));
    assert.ok(html.includes('.kp-head .kp-wrap { flex-wrap: nowrap;'));
    const nav = html.slice(html.indexOf('<nav class="kp-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="kp-nav"')));
    assert.ok(nav.includes('Контроль+ для компаній'), 'пункт меню лишається в розмітці');
});

test('щоденний cron прибирає заявки старші за рік (purge_old_kp_leads), збій не ламає cron; нова функція не додається', async () => {
    const CRON = { headers: { authorization: 'Bearer cron-test-secret' } };
    const clock = { now: NOW };
    const calls = [];
    const store = Object.assign(memoryStore(clock), { purgeOldKpLeads: async () => { calls.push('purge'); return 3; } });
    const service = createBillingService({ store, fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }), env: baseEnv(), now: () => clock.now });
    assert.equal((await service.cron(CRON)).kp_leads_purged, 3);
    const failing = Object.assign(memoryStore(clock), { purgeOldKpLeads: async () => { throw Object.assign(new Error('x'), { code: 'XX' }); } });
    const original = console.warn;
    console.warn = () => {};
    try {
        const out = await createBillingService({ store: failing, fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }), env: baseEnv(), now: () => clock.now }).cron(CRON);
        assert.equal('kp_leads_purged' in out, false);
    } finally {
        console.warn = original;
    }
    assert.ok(read('lib/billing/store.js').includes("rpc('purge_old_kp_leads')"));
    const sql = read('supabase/migrations/20261112090000_kp_leads_purge.sql');
    assert.ok(sql.startsWith('-- Apply manually after review. This file is not applied to production by the agent.'));
    for (const part of ['РУЧНИЙ ВІДКАТ', "DELETE FROM public.kp_leads WHERE created_at < now() - interval '1 year'",
        'REVOKE ALL ON FUNCTION public.purge_old_kp_leads() FROM PUBLIC, anon, authenticated', 'GRANT EXECUTE ON FUNCTION public.purge_old_kp_leads() TO service_role']) assert.ok(sql.includes(part), part);
    assert.equal(read('supabase/tests/kp_leads_purge.sql').split('\n').filter((l) => /^SELECT (ok|is|throws_ok)/.test(l)).length, 7);
});
