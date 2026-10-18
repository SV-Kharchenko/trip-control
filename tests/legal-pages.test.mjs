import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const PAGES = [
    { file: 'legal/offer.html', url: '/offer' },
    { file: 'legal/privacy.html', url: '/privacy' },
    { file: 'legal/payment-refund.html', url: '/payment-refund' }
];
const CONSENT_TEXT = 'Погоджуюсь з Публічною офертою та Політикою конфіденційності';

function footersOf(source) {
    return source.match(/<footer class="tc-legal-footer">[\s\S]*?<\/footer>/g) || [];
}
const normalize = (markup) => markup.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start + ' … ' + end);
    return source.slice(from, to);
}

test('three legal pages: full page around <article class="legal-doc">, canonical on the short URL, no external scripts', () => {
    for (const { file, url } of PAGES) {
        const page = read(file);
        assert.match(page, /^<!DOCTYPE html>\n<html lang="uk"/, file);
        assert.equal((page.match(/<article class="legal-doc"[^>]*>/g) || []).length, 1, file);
        assert.equal((page.match(/<\/article>/g) || []).length, 1, file);
        assert.match(page, new RegExp('<link rel="canonical" href="https://trip-control\\.com' + url + '">'), file);
        assert.match(page, new RegExp('<meta property="og:url" content="https://trip-control\\.com' + url + '">'), file);
        assert.match(page, /<meta charset="UTF-8">/);
        assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
        assert.match(page, /<meta name="twitter:card" content="summary">/);
        assert.match(page, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
        assert.match(page, /family=Manrope:wght@400;500;600;700;800&family=JetBrains\+Mono/);
        assert.match(page, /<a class="legal-back" href="\/">← Trip Control<\/a>/);
        assert.equal(/<script[^>]+src=/i.test(page), false, file + ': external script');
        // The document text may name processors (e.g. Supabase); the page code around it must not load them.
        const shell = page.replace(/<article class="legal-doc"[\s\S]*<\/article>/, '');
        assert.equal(/supabase|googletagmanager|gtag\(|analytics/i.test(shell), false, file + ': analytics / Supabase');
        // Theme: reads tc_theme, never writes it.
        assert.match(page, /localStorage\.getItem\('tc_theme'\)/);
        assert.equal(page.includes('localStorage.setItem'), false, file);
        assert.match(page, /\[data-theme="light"\] \{[\s\S]*--bg: #F4EFE4;/);
        assert.match(page, /\[data-theme="dark"\] \{[\s\S]*--bg: #0E1117;/);
        assert.match(page, /\.legal-doc \{[^}]*max-width|\.legal-page \{ max-width: 760px/);
        assert.match(page, /\.legal-doc table \{ display: block; max-width: 100%; overflow-x: auto;/);
        assert.match(page, /\.legal-doc mark \{/);
    }
});

test('vercel.json: three rewrites to legal/*.html, headers and CSP untouched', () => {
    const config = JSON.parse(read('vercel.json'));
    assert.deepEqual(config.rewrites, [
        { source: '/offer', destination: '/legal/offer.html' },
        { source: '/privacy', destination: '/legal/privacy.html' },
        { source: '/payment-refund', destination: '/legal/payment-refund.html' }
    ]);
    const csp = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
    assert.match(csp, /^default-src 'self'; script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    const sitemap = read('sitemap.xml');
    for (const { url } of PAGES) assert.match(sitemap, new RegExp('<loc>https://trip-control\\.com' + url + '</loc>'));
    assert.equal(sitemap.includes('/legal/'), false);
});

test('index.html links only to the short URLs', () => {
    assert.equal(html.includes('/legal/offer.html'), false);
    assert.equal(html.includes('/legal/privacy.html'), false);
    assert.equal(html.includes('/legal/'), false);
});

test('one footer component with the three links, payments and seller on every page', () => {
    const pages = { 'index.html': html, '404.html': read('404.html') };
    for (const { file } of PAGES) pages[file] = read(file);
    const reference = normalize(footersOf(html)[0] || '');
    assert.ok(reference, 'footer in index.html');
    // On the legal pages the footer links open in the same tab; otherwise the markup is identical.
    const sameTab = reference.replace(/ target="_blank" rel="noopener"/g, '');
    for (const [file, source] of Object.entries(pages)) {
        const footers = footersOf(source);
        assert.ok(footers.length >= 1, file);
        const expected = file.startsWith('legal/') ? sameTab : reference;
        for (const footer of footers) {
            assert.equal(normalize(footer), expected, file + ': same markup');
        }
        assert.match(source, /<link rel="stylesheet" href="\/assets\/legal-footer\.css\?v=[\d-]+">/, file);
    }
    for (const { file } of PAGES) {
        const footer = footersOf(pages[file])[0];
        assert.equal(footer.includes('target='), false, file);
        assert.match(footer, /<a href="\/offer">Публічна оферта<\/a>/);
        assert.match(footer, /<a href="\/privacy">Політика конфіденційності<\/a>/);
        assert.match(footer, /<a href="\/payment-refund">Оплата та повернення<\/a>/);
    }
    assert.match(reference, /<a href="\/offer" target="_blank" rel="noopener">Публічна оферта<\/a>/);
    assert.match(reference, /<a href="\/privacy" target="_blank" rel="noopener">Політика конфіденційності<\/a>/);
    assert.match(reference, /<a href="\/payment-refund" target="_blank" rel="noopener">Оплата та повернення<\/a>/);
    // Official logos: Visa blue on light, white on dark; Mastercard the same for both.
    assert.match(reference, /<img class="tc-pay-logo tc-pay-logo--visa tc-pay-logo--on-light" src="\/assets\/payments\/visa\.svg" alt="Visa" width="62" height="20">/);
    assert.match(reference, /<img class="tc-pay-logo tc-pay-logo--visa tc-pay-logo--on-dark" src="\/assets\/payments\/visa-white\.svg" alt="Visa" width="62" height="20">/);
    assert.match(reference, /<img class="tc-pay-logo tc-pay-logo--mc" src="\/assets\/payments\/mastercard\.svg" alt="Mastercard" width="32" height="20">/);
    assert.equal(/tc-pay-badge|>VISA</.test(reference), false);
    const css = read('assets/legal-footer.css');
    assert.match(css, /\.tc-pay-logo \{ display: block; height: 20px;/);
    assert.match(css, /\.tc-pay-logo--on-dark \{ display: none; \}/);
    assert.match(css, /\[data-theme="dark"\] \.tc-pay-logo--on-light \{ display: none; \}/);
    assert.match(css, /\[data-theme="dark"\] \.tc-pay-logo--on-dark \{ display: block; \}/);
    for (const svg of ['visa.svg', 'visa-white.svg', 'mastercard.svg']) {
        assert.match(read('assets/payments/' + svg), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, svg);
    }
    // 404 is always dark: white Visa.
    assert.match(read('404.html'), /<html lang="uk" data-theme="dark">/);
    assert.match(reference, /Оплата карткою через plata by mono \(monobank\) та WayForPay · Apple Pay \/ Google Pay/);
    assert.match(reference, /ФОП Харченко Святослав Вікторович · <a href="mailto:tripcontrol\.com@gmail\.com">tripcontrol\.com@gmail\.com<\/a> · <a href="tel:\+380730888252">\+380730888252<\/a>/);
    // Auth screen, menu, bottom of the app, bottom of the cabinet.
    assert.equal(footersOf(html).length, 4);
    assert.match(sliceBetween(html, '<div class="tc-footer">', '</div>\n    </div>\n</div>'), /tc-legal-footer/);
    assert.match(sliceBetween(html, '<div class="tc-menu-foot">', '<button type="button" class="tc-icon-btn tc-burger"'), /tc-legal-footer/);
    assert.match(sliceBetween(html, '</section>\n', '<div id="cabinet-screen">'), /<footer class="tc-legal-footer">/);
    assert.match(sliceBetween(html, '<div id="cabinet-screen">', '<div id="admin-screen">'), /<footer class="tc-legal-footer">/);
    // Logos come from the files, not drawn inline.
    assert.equal(/<svg[^>]*(visa|mastercard)/i.test(reference), false);
});

test('signup consent: exact text, both links, unchecked, required for regular and invite signup', () => {
    const box = sliceBetween(html, '<div class="auth-legal" id="auth-legal-box">', '</div>');
    assert.match(box, /<input type="checkbox" id="auth-consent" name="consent" required>/);
    assert.equal(/checked/.test(box), false);
    const text = box.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(text, CONSENT_TEXT);
    assert.match(box, /<a href="\/offer" target="_blank" rel="noopener">Публічною офертою<\/a>/);
    assert.match(box, /<a href="\/privacy" target="_blank" rel="noopener">Політикою конфіденційності<\/a>/);
    // The box is outside .auth-owner-only, so the invite form (which hides only those) keeps it.
    assert.equal(/auth-owner-only/.test(box), false);
    assert.match(html, /#auth-form\.is-invite \.auth-owner-only \{ display: none !important; \}/);
    assert.match(html, /function showSignupMode\(\) \{[\s\S]*?document\.getElementById\('auth-legal-box'\)\.classList\.add\('show'\);/);
    // Checked before either branch builds its signUp options.
    const auth = sliceBetween(html, 'async function handleAuth(type) {', 'async function handleLogout()');
    const check = auth.indexOf("if (!consent || !consent.checked)");
    assert.ok(check > 0 && check < auth.indexOf('const signupOptions = invite'));
    assert.match(auth, /if \(!consent \|\| !consent\.checked\) \{\n\s+authMsg\.innerText = 'Потрібна згода з Публічною офертою та Політикою конфіденційності\.';\n\s+return;/);
});

test('signUp sends consent_* = LEGAL_VERSION for both branches; one version everywhere', () => {
    const auth = sliceBetween(html, 'const signupOptions = invite', 'const { data, error } = await supabaseClient.auth.signUp');
    const [inviteBranch, ownerBranch] = auth.split('\n                : {');
    for (const branch of [inviteBranch, ownerBranch]) {
        assert.match(branch, /consent_offer_version: LEGAL_VERSION/);
        assert.match(branch, /consent_privacy_version: LEGAL_VERSION/);
    }
    assert.match(inviteBranch, /invite_id: invite\.info\.invite_id/);
    assert.match(ownerBranch, /company_name: company/);
    const version = html.match(/const LEGAL_VERSION = '([\d-]+)';/)[1];
    assert.equal(version, '2026-10-18');
    assert.match(read('lib/legal.js'), new RegExp("export const LEGAL_VERSION = '" + version + "';"));
    const migration = read('supabase/migrations/20261018100000_legal_consents.sql');
    assert.match(migration, new RegExp("v_allowed constant text\\[\\] := ARRAY\\['" + version + "'\\]"));
    // Edition date in the documents matches.
    for (const file of ['legal/offer.html', 'legal/privacy.html']) {
        assert.match(read(file), /Редакція від 18\.10\.2026/);
    }
});

test('legal_consents migration: new table, RLS, no IP, separate trigger, handle_new_tripcontrol_user untouched', () => {
    const sql = read('supabase/migrations/20261018100000_legal_consents.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.legal_consents/);
    assert.match(sql, /user_id uuid NOT NULL REFERENCES auth\.users \(id\) ON DELETE CASCADE/);
    assert.match(sql, /kind text NOT NULL CHECK \(kind IN \('signup', 'payment'\)\)/);
    assert.match(sql, /ALTER TABLE public\.legal_consents ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON public\.legal_consents FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT SELECT ON public\.legal_consents TO authenticated;/);
    assert.match(sql, /USING \(user_id = auth\.uid\(\)\)/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.record_signup_consent\(\)[\s\S]*SECURITY DEFINER\nSET search_path = public/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_signup_consent\(\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /CREATE TRIGGER on_auth_user_record_signup_consent\n\s+AFTER INSERT ON auth\.users/);
    assert.equal(/\bip\b|inet/i.test(sql.replace(/^--.*$/gm, '')), false);
    assert.equal(sql.replace(/^--.*$/gm, '').includes('handle_new_tripcontrol_user'), false);
});

test('no retired payment providers anywhere in the repo (rg -i finds nothing)', () => {
    const banned = new RegExp(['liq', 'pay'].join('') + '|' + ['str', 'ipe'].join(''), 'i');
    const skip = new Set(['node_modules', '.git', '.vercel']);
    const hits = [];
    (function walk(dir) {
        for (const name of readdirSync(dir)) {
            if (skip.has(name)) continue;
            const path = join(dir, name);
            const stat = statSync(path);
            if (stat.isDirectory()) walk(path);
            else if (stat.size < 5_000_000 && /\.(html|js|mjs|json|md|sql|txt|xml|css|yml|yaml)$/i.test(name)) {
                if (banned.test(readFileSync(path, 'utf8'))) hits.push(path.slice(root.length));
            }
        }
    })(root);
    assert.deepEqual(hits, []);
});

test('legal_consents on Postgres (PGlite)', async (t) => {
    const { createRequire } = await import('node:module');
    const { spawnSync } = await import('node:child_process');
    try {
        createRequire(import.meta.url).resolve('@electric-sql/pglite');
    } catch (error) {
        t.skip('npm i --no-save @electric-sql/pglite@0.2.17 to run');
        return;
    }
    const run = spawnSync(process.execPath, [join(root, 'scripts/check-legal-consents.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const line of [
        'signup with consent versions: one signup row, server time, company from the profile',
        'invite signup with consent versions: row written',
        'signup without versions: no row, insert does not fail',
        'consent insert error: signup and profile still created',
        'authenticated sees only own consent rows',
        'authenticated cannot insert / update / delete (42501)'
    ]) {
        assert.ok(run.stdout.includes('PASS ' + line), line);
    }
});
