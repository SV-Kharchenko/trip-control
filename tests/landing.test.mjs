import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const landingJs = read('assets/landing.js');
const osmJs = read('assets/osm-geo.js');
const landingCss = read('assets/landing.css');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start + ' … ' + end);
    return source.slice(from, to);
}
function functionSource(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('unclosed ' + name);
}
const landing = sliceBetween(html, '<div id="landing-screen" hidden>', '<div id="auth-screen">');
const panel = sliceBetween(landing, 'id="try-panel"', '</form>');
const result = sliceBetween(landing, '<section class="lp-try-res lp-card" id="try-res"', '</section>');

// landing.js without a DOM: only the pure helpers are exposed (the script returns early without #landing-screen).
const sandbox = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(landingJs, sandbox);
const L = sandbox.window.TcLanding;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('landing lives in index.html on «/»: no new rewrites, styles and scripts from /assets, one h1, SEO', () => {
    assert.match(html, /<link rel="stylesheet" href="\/assets\/landing\.css\?v=[\d-]+">/);
    assert.match(html, /<script src="\/assets\/osm-geo\.js\?v=[\d-]+" defer><\/script>/);
    assert.match(html, /<script src="\/assets\/landing\.js\?v=[\d-]+" defer><\/script>/);
    assert.ok(html.indexOf('<div id="landing-screen" hidden>') < html.indexOf('<div id="auth-screen">'));
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
    assert.match(landing, /<h1>Порахуй, чи вигідний рейс, <em>ще до того, як погодився<\/em><\/h1>/);
    for (const id of ['example', 'features', 'who', 'pricing', 'faq']) assert.match(landing, new RegExp('<section[^>]* id="' + id + '"'));
    const description = html.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(description.length <= 160, description.length);
    assert.equal(html.match(/<meta property="og:description" content="([^"]+)">/)[1], description);
    assert.equal(html.match(/<meta name="twitter:description" content="([^"]+)">/)[1], description);
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    assert.equal(html.match(/<meta property="og:title" content="([^"]+)">/)[1], title);
    assert.equal(html.match(/<meta name="twitter:title" content="([^"]+)">/)[1], title);
    assert.match(html, /<link rel="canonical" href="https:\/\/trip-control\.com\/">/);
    assert.match(html, /<html lang="uk">/);
    // Landing styles are scoped and use the existing theme tokens only.
    assert.equal(/\[data-theme="(dark|light|ocean|paper|control)"\]\s*\{/.test(landingCss), false);
    assert.equal(/--(bg|surface|accent|text|muted):/.test(landingCss), false);
    assert.equal(landing.includes('/legal/'), false);
    assert.equal(landing.includes('data:image'), false);
});

test('entry script: session key or an auth flow in the URL → app, otherwise landing', () => {
    const script = sliceBetween(html, '<body class="layout-studio" data-theme="light">\n<script>', '</script>');
    assert.match(script, /localStorage\.getItem\('sb-qkfqjorzsxcajcneohoy-auth-token'\)/);
    assert.match(script, /document\.documentElement\.setAttribute\('data-entry', entry\);/);
    assert.match(script, /if \(entry === 'landing'\) document\.documentElement\.setAttribute\('data-screen', 'landing'\);/);
    const entry = new Function(functionSource(script, 'tcEntryScreen') + '\nreturn tcEntryScreen;')();
    assert.equal(entry(true, '', ''), 'app');
    assert.equal(entry(false, '', ''), 'landing');
    assert.equal(entry(false, '', '#pricing'), 'landing');
    assert.equal(entry(false, '?utm_source=x', ''), 'landing');
    for (const [search, hash] of [
        ['', '#access_token=a&refresh_token=b&type=recovery'],
        ['?type=recovery', ''],
        ['?code=abc', ''],
        ['', '#error=access_denied&error_code=otp_expired&error_description=Email+link'],
        ['?error_description=x', ''],
        ['?team_invite=tok', ''],
        ['?preview=1', ''],
        ['', '#refresh_token=x']
    ]) assert.equal(entry(false, search, hash), 'app', search + hash);
    // CSS: the landing is visible only on data-screen="landing", and then the auth screen and the app are hidden.
    assert.match(landingCss, /#landing-screen \{ display: none; \}\nhtml\[data-screen="landing"\] #landing-screen \{ display: block; \}/);
    assert.match(landingCss, /html\[data-screen="landing"\] #auth-screen,\nhtml\[data-screen="landing"\] #main-app \{ display: none; \}/);
});

test('checkUserAccess: guest without an auth flow → landing; invite, recovery, blocked go through #auth-screen', () => {
    const access = functionSource(html, 'checkUserAccess');
    assert.match(access, /if \(!session\) \{\n\s+\/\/[^\n]*\n\s+if \(landingEntry\(\) && !landingAuthOpened\) \{\n\s+showLanding\(\);\n\s+logoutBtn\.style\.display = 'none';\n\s+return;\n\s+\}\n\s+leaveLanding\(\);\n\s+authScreen\.style\.display = 'flex';/);
    assert.ok(access.indexOf('leaveLanding();\n        if (authUserBlocked(session.user))') > 0);
    assert.match(functionSource(html, 'showRecoveryForm'), /^function showRecoveryForm\(\) \{\n\s+leaveLanding\(\);/);
    assert.match(functionSource(html, 'showAccountBlocked'), /^function showAccountBlocked\(\) \{\n\s+leaveLanding\(\);/);
    const open = functionSource(html, 'openAuthFromLanding');
    assert.match(open, /landingAuthOpened = true;/);
    assert.match(open, /showAuthForm\(\);\n\s+setAuthTab\(tab === 'signup' \? 'signup' : 'login'\);/);
    assert.match(open, /document\.getElementById\('auth-email'\)/);
    assert.match(functionSource(html, 'backToLanding'), /landingAuthOpened = false;[\s\S]*showLanding\(\);/);
    // «← На головну» is a plain button, the auth card keeps a single submit.
    assert.match(html, /<button type="button" class="auth-landing-back" id="landing-back-btn" hidden onclick="backToLanding\(\)">← На головну<\/button>/);
    // Landing buttons open the existing auth form, there is no other signup form.
    assert.match(landingJs, /window\.openAuthFromLanding\(el\.getAttribute\('data-auth'\)\)/);
    assert.equal(/<form/.test(landing.replace(/<form class="lp-try-form lp-card" id="try-form"/, '')), false);
    for (const label of ['Увійти', 'Реєстрація', 'Зареєструватись', 'У мене вже є акаунт']) {
        assert.match(landing, new RegExp('data-auth="(login|signup)">' + label + '<'));
    }
    assert.match(landing, /href="#signup" data-auth="signup">Зареєструватись</);
    assert.match(landing, /href="#login" data-auth="login">У мене вже є акаунт</);
});

test('try panel: dialog, 5 steps, «Далі» primary on 1–4, «Розрахувати» only on step 5', () => {
    assert.match(landing, /<div class="lp-try" id="try-panel" hidden role="dialog" aria-modal="true" aria-labelledby="try-title">/);
    for (let i = 1; i <= 5; i++) assert.match(panel, new RegExp('id="t-tab-' + i + '"[^>]*data-step="' + i + '"'));
    assert.match(panel, /<button type="button" class="lp-btn lp-btn-ghost" id="t-back" hidden>← Назад<\/button>/);
    assert.match(panel, /<button type="button" class="lp-btn lp-btn-primary" id="t-next">Далі →<\/button>/);
    assert.match(panel, /<button type="submit" class="lp-btn lp-btn-primary" id="t-calc" hidden>▶ Розрахувати<\/button>/);
    for (let step = 1; step <= 5; step++) {
        const b = L.stepButtons(step);
        assert.equal(b.backHidden, step === 1, 'back ' + step);
        assert.equal(b.nextHidden, step === 5, 'next ' + step);
        assert.equal(b.calcHidden, step !== 5, 'calc ' + step);
    }
    assert.match(landingJs, /\$\('t-back'\)\.hidden = buttons\.backHidden; \$\('t-next'\)\.hidden = buttons\.nextHidden; \$\('t-calc'\)\.hidden = buttons\.calcHidden;/);
    assert.match(landingJs, /if \(step < STEPS\) \{ showStep\(step \+ 1\); return; \} \/\/ Enter на кроках 1–4/);
    assert.match(landingJs, /if \(e\.key !== 'Escape'/);
    assert.match(landingJs, /panel\.addEventListener\('click', function \(e\) \{ if \(e\.target === panel\) closeTry\(\); \}\);/);
    assert.match(landingJs, /if \(!silent && lastFocus && lastFocus\.focus\) lastFocus\.focus\(\);/);
});

test('try panel fields: no value="0"; real defaults only in «ТО та шини»; decimal inputs with placeholders; one-off by default', () => {
    const inputs = panel.match(/<input [^>]*>/g);
    assert.ok(inputs.length > 40);
    assert.equal(inputs.some((i) => / value="0"/.test(i)), false);
    const DEFAULTS = { 'to-cost': '15000', 'to-period': '50000', 'tire-cost': '16500', 'tire-count': '14', 'tire-mileage': '100000' };
    const withValue = inputs.filter((i) => / value="/.test(i));
    assert.equal(withValue.length, Object.keys(DEFAULTS).length, withValue.join('\n'));
    for (const [name, value] of Object.entries(DEFAULTS)) {
        assert.match(panel, new RegExp('<input type="text" inputmode="decimal" id="t-' + name + '" name="' + name + '" value="' + value
            + '" placeholder="напр\\. ' + value + '" data-default="' + value + '" autocomplete="off">'), name);
    }
    // An empty value from an older draft does not wipe these defaults.
    assert.match(landingJs, /if \(value\.trim\(\) === '' && el\.hasAttribute\('data-default'\)\) value = el\.getAttribute\('data-default'\);/);
    assert.equal(panel.includes('type="number"'), false);
    const numeric = inputs.filter((i) => /inputmode="decimal"/.test(i));
    assert.equal(numeric.length, 44);
    for (const input of numeric) {
        assert.match(input, /type="text" inputmode="decimal"/);
        assert.match(input, / placeholder="[^"]+"/);
    }
    assert.match(panel, /<option value="разовий" selected>/);
    assert.equal(/<option value="циклічний" selected>/.test(panel), false);
    assert.match(landing, /💾 Дані зберігаються в цьому браузері\. Після реєстрації підставимо їх у калькулятор\./);
    // Validation like the app: > 0, volume is not needed for a one-off trip.
    const full = { dist: '542', volume: '60', 'norm-weight': '20', 'cars-count': '3', 'days-per-trip': '2', rate: '1500',
        'fuel-load': '37', 'fuel-empty': '32', 'fuel-price': '57', 'total-fleet': '1', 'to-period': '50000', 'tire-mileage': '150000' };
    assert.deepEqual(plain(L.missingRequired(full, false)), []);
    assert.deepEqual(plain(L.missingRequired({ ...full, volume: '' }, true)), []);
    assert.deepEqual(plain(L.missingRequired({ ...full, volume: '' }, false).map((p) => p[0])), ['volume']);
    assert.deepEqual(plain(L.missingRequired({ ...full, rate: '0', dist: '1,5' }, false).map((p) => p[0])), ['rate']);
});

test('result is locked: placeholders only, no digits, no calculation in the browser of a guest', () => {
    const text = result.replace(/<[^>]+>/g, ' ');
    assert.equal(/[0-9]/.test(text), false, text);
    assert.equal(/6\s?687/.test(result), false);
    assert.match(result, /Доступно після реєстрації/);
    assert.match(result, /•• ••• грн/);
    for (const source of [landingJs, osmJs]) {
        assert.equal(source.includes('/api/calculate'), false);
        assert.equal(source.includes('calculateTrip'), false);
    }
    assert.equal(/fetch\(/.test(landingJs), false, 'the landing script makes no requests of its own');
});

test('tc_draft_trip: saved on input/change with _step, restored on open; old zeros show empty', () => {
    assert.equal(L.DRAFT_KEY, 'tc_draft_trip');
    assert.match(landingJs, /form\.addEventListener\('input', function \(e\) \{\n\s+saveDraft\(\);/);
    assert.match(landingJs, /form\.addEventListener\('change', function \(\) \{ syncVisibility\(\); saveDraft\(\); \}\);/);
    assert.match(landingJs, /data\._step = step;/);
    assert.match(functionSource(landingJs, 'openTry'), /loadDraft\(\); syncVisibility\(\); showStep\(step\);/);
    assert.equal(L.draftValue('0', true), '');
    assert.equal(L.draftValue('0.0', true), '');
    assert.equal(L.draftValue('0', false), '0');
    assert.equal(L.draftValue('12', true), '12');
    assert.equal(L.draftValue(undefined, true), '');
    assert.match(panel, /id="t-idle-days" name="idle-days" placeholder="0" data-zero="1"/);
});

function fakeElement(id, tag, value, options) {
    return {
        id, tagName: tag, value, dataset: {}, style: {},
        options: (options || []).map((v) => ({ value: v })),
        classList: { toggle() {} }
    };
}

test('applyLandingDraft: only allowed ids, skips empty / 0 / unknown options, route name, removes the key', () => {
    const constants = sliceBetween(html, "const LANDING_DRAFT_KEY = 'tc_draft_trip';", 'function applyLandingDraft()');
    const fn = functionSource(html, 'applyLandingDraft');
    const els = {
        dist: fakeElement('dist', 'INPUT', '350'),
        'podacha-dist': fakeElement('podacha-dist', 'INPUT', '40'),
        rate: fakeElement('rate', 'INPUT', '1800'),
        volume: fakeElement('volume', 'INPUT', '500'),
        'fuel-load': fakeElement('fuel-load', 'INPUT', '38'),
        'return-mode': fakeElement('return-mode', 'SELECT', 'циклічний', ['циклічний', 'разовий']),
        'trailer-type': fakeElement('trailer-type', 'SELECT', 'зерновоз', ['зерновоз', 'тент']),
        'contract-currency': fakeElement('contract-currency', 'SELECT', 'UAH', ['UAH', 'USD', 'EUR']),
        'route-name': fakeElement('route-name', 'INPUT', 'Демо: типовий рейс зерновоза'),
        'extras-box': fakeElement('extras-box', 'DIV', ''),
        'round-trip-box': fakeElement('round-trip-box', 'DIV', ''),
        'field-adblue-consumption': fakeElement('x', 'DIV', ''),
        'field-adblue-price': fakeElement('x', 'DIV', ''),
        'driver-km-box': fakeElement('x', 'DIV', ''),
        'driver-pct-box': fakeElement('x', 'DIV', ''),
        'osm-demo-from': fakeElement('osm-demo-from', 'INPUT', ''),
        secret: fakeElement('secret', 'INPUT', 'keep')
    };
    const store = {
        tc_draft_trip: JSON.stringify({
            dist: '543', 'podacha-dist': '0', rate: '', volume: 'abc', 'fuel-load': '37,5',
            'return-mode': 'разовий', 'trailer-type': 'контейнеровоз', 'contract-currency': 'EUR',
            'osm-from': 'Житомир', 'osm-from-coords': '50.26,28.67', 'osm-to': 'Одеса', 'osm-to-coords': '46.48,30.73',
            'route-name': '', secret: 'leak', _step: 5
        })
    };
    const localStorage = { getItem: (k) => store[k] ?? null, removeItem: (k) => { delete store[k]; } };
    const document = { getElementById: (id) => els[id] || null };
    const places = [];
    const setPlaceText = (wrap, id, value) => places.push([wrap, id, value]);
    const noop = () => {};
    const run = new Function('localStorage', 'document', 'setPlaceText', 'updateContractCurrencyUi', 'updateRouteBar', 'updateStepSummaries', 'STARTER_TRIP',
        'let contractCurrency = "UAH";\n' + constants + fn + '\nreturn [applyLandingDraft(), contractCurrency];');
    const STARTER_TRIP = { 'route-name': 'Демо: типовий рейс зерновоза' };
    const [applied, currency] = run(localStorage, document, setPlaceText, noop, noop, noop, STARTER_TRIP);
    assert.equal(applied, true);
    assert.equal(els.dist.value, '543');
    assert.equal(els['podacha-dist'].value, '40', '0 is skipped');
    assert.equal(els.rate.value, '1800', 'empty is skipped');
    assert.equal(els.volume.value, '500', 'not a number is skipped');
    assert.equal(els['fuel-load'].value, '37.5', 'decimal comma');
    assert.equal(els['return-mode'].value, 'разовий');
    assert.equal(els['trailer-type'].value, 'зерновоз', 'unknown option is skipped');
    assert.equal(els['contract-currency'].value, 'EUR');
    assert.equal(currency, 'EUR', 'currency switched without converting the rate');
    assert.equal(els.secret.value, 'keep', 'ids outside the list are never written');
    assert.deepEqual(places, [['osm-from-wrap', 'osm-from', 'Житомир'], ['osm-to-wrap', 'osm-to', 'Одеса']]);
    assert.equal(els['osm-demo-from'].dataset.coords, '50.26,28.67');
    assert.equal(els['route-name'].value, 'Житомир → Одеса');
    assert.equal('tc_draft_trip' in store, false);
    // No draft → nothing happens.
    assert.equal(run(localStorage, document, setPlaceText, noop, noop, noop, STARTER_TRIP)[0], false);
    // Allowed lists: no _step, no coordinates, nothing that is a company setting key.
    assert.equal(/'_step'|-coords'/.test(constants), false);
});

test('applyLandingDraft runs after the sample trip and before onTrailerChange; no auto-calculation, only a toast', () => {
    const access = functionSource(html, 'checkUserAccess');
    const sample = access.indexOf('applySampleTripIfEmpty();');
    const draft = access.indexOf('const landingDraftApplied = applyLandingDraft();');
    const trailer = access.indexOf('onTrailerChange();');
    assert.ok(sample > 0 && draft > sample && trailer > draft);
    assert.match(access, /showToast\('Підставили дані з головної — натисни «Розрахувати»'\)/);
    const fn = functionSource(html, 'applyLandingDraft');
    assert.equal(/calculate\(|runDemoCalc|demoForce|company_settings|supabaseClient/.test(fn), false);
});

test('demo path: OSM instead of Google, the paid branch unchanged, POI search stays locked in demo', () => {
    const access = functionSource(html, 'checkUserAccess');
    const demo = sliceBetween(access, 'if (isDemo) {', '} else {');
    assert.match(demo, /loadDemoUsage\(profile\.org_id\);/);
    assert.match(demo, /initDemoOsmRoute\(\);/);
    assert.equal(demo.includes('loadGoogleMaps'), false);
    assert.match(access, /\} else \{\n\s+\/\/ Google Maps \(платні запити\) підвантажуємо лише для повного доступу\n\s+loadGoogleMaps\(\)\.then\(initMap\)\.catch\(e => console\.warn\('Google Maps не завантажився:', e\)\);\n\s+\}/);
    // Google code identical to main.
    const hashes = {
        createAddressAutocomplete: '14972e2290e18993',
        calculateGoogleRoute: '55dfbd10d93b5646',
        initMap: 'fbc9a3b9e85c38e0',
        loadGoogleMaps: 'fe25b745d23abd82',
        searchPOIsAlongRoute: '37ed8ce988a61277'
    };
    for (const [name, hash] of Object.entries(hashes)) {
        assert.equal(createHash('sha256').update(functionSource(html, name)).digest('hex').slice(0, 16), hash, name);
    }
    // Demo OSM block: separate .demo-only box; the Google box stays full-only.
    assert.match(html, /<div class="tc-osm-box demo-only" id="tc-osm-box">/);
    assert.match(html, /<div class="tc-maps-box full-only">/);
    assert.ok(html.indexOf('id="tc-osm-box"') < html.indexOf('<div class="tc-maps-box full-only">'), 'querySelector(.tc-maps-box) still finds the Google box');
    const demoCode = ['initDemoOsmRoute', 'recomputeDemoOsmRoute', 'swapDemoOsmEnds', 'demoOsmPoint'].map((n) => functionSource(html, n)).join('\n');
    assert.equal(/loadGoogleMaps|google\.maps|searchPOIsAlongRoute|\/api\/poi'|method: 'POST'|demoForce|runDemoCalc/.test(demoCode), false);
    assert.match(functionSource(html, 'initDemoOsmRoute'), /if \(!geo \|\| demoOsmReady\) return;\n\s+demoOsmReady = true;/);
    for (const source of [osmJs, landingJs]) assert.equal(source.includes('searchPOIsAlongRoute'), false);
    // «Знайти об'єкти» lives only in full-only containers; the demo lock stays.
    const poiPanel = sliceBetween(html, '<div class="tc-map-poi-panel full-only" id="map-poi-panel"', '<div id="poi-results"');
    assert.match(poiPanel, /onclick="searchPOIsAlongRoute\(\)">🔍 Знайти об'єкти<\/button>/);
    assert.equal((html.match(/searchPOIsAlongRoute\(\)"/g) || []).length, 1);
    assert.match(html, /class="tc-map-btn tc-map-poi-btn full-only" id="map-poi-btn"/);
    assert.match(html, /<div class="lock-ph demo-only"><b>🔒 Доступно після оплати<\/b><small>📍 Пошук АЗС, стоянок TIR, кафе і СТО вздовж маршруту<\/small><\/div>/);
    assert.match(html, /body\.demo-mode \.full-only \{ display: none !important; \}/);
    // Map lock in demo: distance is computed via OSM now.
    assert.match(html, /<b>Карта маршруту, проміжні зупинки й пошук об'єктів — після оплати<\/b>\n\s+<small>У демо відстань рахується через OpenStreetMap<\/small>/);
    assert.equal(html.includes('вводьте відстань вручну'), false);
    // New lock text over the route.
    assert.match(html, /<div class="lock-ph demo-only"><b>🔒 Карти Google і проміжні зупинки — після оплати<\/b>/);
});

test('OSM honesty: switch, hint, attribution, fallback text, client-side normalization', () => {
    assert.match(osmJs, /var OSM_GEO = true;/);
    assert.match(osmJs, /enabled: OSM_GEO/);
    assert.match(html, /window\.TcOsmGeo && window\.TcOsmGeo\.enabled \? window\.TcOsmGeo : null/);
    assert.match(landingJs, /window\.TcOsmGeo && window\.TcOsmGeo\.enabled \? window\.TcOsmGeo : null/);
    assert.match(html, /Відстань за OpenStreetMap, можна виправити/);
    assert.match(landing, /<p class="lp-t-note lp-osm-only" id="t-dist-hint">Відстань за OpenStreetMap, можна виправити<\/p>/);
    assert.match(landing, /© OpenStreetMap contributors/);
    assert.match(osmJs, /FAIL: 'Не вдалося визначити відстань — введи вручну, км'/);
    assert.match(osmJs, /var MIN_CHARS = 3;/);
    assert.match(osmJs, /var DEBOUNCE_MS = 300;/);
    assert.match(osmJs, /if \(ctrl\) ctrl\.abort\(\);/);
    assert.match(osmJs, /cache\.has\(key\)/);
    const sb = { window: {} };
    vm.runInNewContext(osmJs, sb);
    const geo = sb.window.TcOsmGeo;
    assert.equal(geo.normalizeQuery('  Житомир   Центр '), 'житомир центр');
    assert.equal(geo.pointParam({ lat: 50.260107, lon: 28.669628 }), '50.2601,28.6696');
    assert.equal(geo.pointParam({ lat: 50, lon: 30.5 }), '50,30.5');
    assert.deepEqual({ ...geo.parsePoint('50.26,28.67') }, { lat: 50.26, lon: 28.67 });
    assert.equal(geo.parsePoint(''), null);
    // A manually typed distance is not overwritten silently: only a picked point or A↔B recompute it.
    assert.match(landingJs, /onPick: function \(item\) \{[\s\S]*?recomputeRoute\(\);/);
    assert.match(landingJs, /onEdit: function \(\) \{ coords\.value = ''; \}/);
});

test('landing texts: pricing from plans.js, demo has OSM, paid keeps Google; no compass; footer and payments from files', () => {
    assert.match(landing, /<li>Підказки адрес і відстань за OpenStreetMap<\/li>/);
    assert.equal(landing.includes('Відстань і подачу вводиш вручну'), false);
    assert.match(landing, /<li>Маршрут за картами Google, проміжні зупинки, АЗС, TIR, кафе й СТО по дорозі<\/li>/);
    assert.match(landingJs, /month: \{ name: 'Місяць', amt: '250'/);
    assert.match(landingJs, /year: \{ name: 'Рік', amt: '2 500'/);
    assert.match(landing, /<div class="lp-amt">0 <small>грн<\/small><\/div>/);
    assert.match(landing, /class="tc-pay-logo tc-pay-logo--visa tc-pay-logo--on-light" src="\/assets\/payments\/visa\.svg"/);
    assert.match(landing, /<a href="\/offer" target="_blank" rel="noopener">Публічна оферта<\/a>/);
    assert.equal(landing.includes('class="tc-footer"'), false);
    assert.equal(landing.includes('🧭'), false);
    // Example numbers are static text from the golden S0, not computed.
    assert.match(landing, /<div class="lp-tc-profit-value">6 687 грн<\/div>/);
    assert.match(landing, /542 км · 60 т за ставкою 1 500 грн\/т/);
});

test('review fixes: OSM box hidden wins over demo-only; landing hidden without CSS; step 5 note matches empty fields', () => {
    assert.match(landingCss, /\.tc-osm-box\[hidden\] \{ display: none !important; \}/);
    assert.match(functionSource(html, 'initDemoOsmRoute'), /box\.hidden = !geo;/);
    assert.match(html, /<div id="landing-screen" hidden>\n<script>\n[^\n]*\n    if \(document\.documentElement\.getAttribute\('data-screen'\) === 'landing'\) document\.getElementById\('landing-screen'\)\.hidden = false;\n<\/script>/);
    assert.match(functionSource(html, 'showLanding'), /landing\.hidden = false;/);
    assert.match(functionSource(html, 'leaveLanding'), /landing\.hidden = true;/);
    assert.match(landing, /Значення — приклад; у кабінеті вони вже заповнені стартовими нормами\./);
    assert.equal(html.includes('Тут стартові значення нового кабінету'), false);
});
