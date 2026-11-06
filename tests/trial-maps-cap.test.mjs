// Лендинг під тріал 7 днів і ліміт маршрутів Google на тріалі (20 на добу на компанію, Europe/Kyiv).
// Сам лічильник (20-й / 21-й, оплата, кеш, доба за Києвом) перевіряє pgTAP supabase/tests/trial_maps_cap.sql у npm run check:db;
// тут: тексти лендингу, міграція, шлюз у клієнті (з підставним Supabase) і те, що Places/Directions тріалу не торкаються.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = read('index.html');
const migration = read('supabase/migrations/20261124100000_trial_maps_cap.sql');
const landing = html.slice(html.indexOf('<div id="landing-screen" hidden>'), html.indexOf('<div id="auth-screen">'));
const authScreen = html.slice(html.indexOf('<div id="auth-screen">'), html.indexOf('<div id="auth-screen">') + 6000);

function functionSource(source, name) {
    const start = source.indexOf((source.includes('async function ' + name + '(') ? 'async function ' : 'function ') + name + '(');
    assert.notEqual(start, -1, name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error('unclosed ' + name);
}

test('лендинг: 7 днів повного доступу замість «демо: 5 розрахунків на добу»', () => {
    assert.match(landing, /<li>7 днів повного доступу після реєстрації<\/li>/, 'hero');
    assert.match(landing, /<p>Реєстрація займає хвилину\. Після підтвердження email — 7 днів повного доступу безкоштовно\.<\/p>/, 'CTA');
    assert.match(landing, /Після реєстрації компанія отримує 7 днів повного доступу, далі можна обрати місяць або рік\./, 'тарифи');
    assert.match(landing, /<h2>Почни безкоштовно\. Плати, коли знадобиться більше<\/h2>/);
    assert.match(landing, /<summary>Що я отримую безкоштовно після реєстрації\?<\/summary>/);
    assert.match(landing, /<summary>Що буде, коли закінчаться 7 днів\?<\/summary>/);
    assert.match(landing, /Підказки адрес на тріалі беремо з OpenStreetMap\. Карта Google і побудова маршруту доступні до 20 на добу на компанію, далі відстань рахується через OpenStreetMap, і число можна виправити\. Після оплати ліміту Google немає\./);
    assert.match(landing, /Якщо не оплатити, компанія переходить у режим лише для читання: дані лишаються, а нові розрахунки й документи не створюються\. Після оплати повний доступ повертається\./);
    assert.match(landing, /<li>Карта Google і маршрут: до 20 на добу на компанію<\/li>/);
    // Після кінця оплати у компаній, які вже мали тріал, теж «лише читання», дані не видаляються.
    assert.match(landing, /<summary>Що буде з даними, коли оплата закінчиться\?<\/summary>\s*<p>Компанія переходить у режим лише для читання[^<]*дані не видаляються/);
});

test('лендинг: старого «5 розрахунків на добу» як пропозиції новим користувачам немає', () => {
    for (const part of [landing, authScreen, html.slice(0, html.indexOf('</head>'))]) {
        assert.equal(/5 розрахунків на добу/.test(part), false);
        assert.equal(/Демо безкоштовн/.test(part), false);
        assert.equal(/безкоштовному демо/.test(part), false);
    }
    assert.match(html.slice(0, html.indexOf('</head>')), /<meta name="description" content="[^"]*7 днів повного доступу після реєстрації\.">/);
    assert.match(authScreen, /Після реєстрації — <b>7 днів повного доступу<\/b>/);
    // Гостьовий калькулятор: відстань через OSM, решта — після оплати.
    assert.match(landing, /id="t-dist-hint">Відстань за OpenStreetMap, можна виправити<\/p>/);
    assert.match(landing, /lp-osm-only">Обери адресу з підказок[^<]*<small class="lp-osm-attr">© OpenStreetMap contributors/);
});

test('міграція ліміту: 20 на добу за Києвом, таблиця закрита, платним без ліміту, без прав запису клієнтам', () => {
    assert.match(migration, /^-- Apply manually after review\. This file is not applied to production by the agent\./);
    assert.match(migration, /SELECT 20;/);
    assert.match(migration, /AT TIME ZONE 'Europe\/Kyiv'\)::date/);
    assert.match(migration, /ALTER TABLE public\.trial_maps_routes ENABLE ROW LEVEL SECURITY;/);
    assert.match(migration, /REVOKE ALL ON TABLE public\.trial_maps_routes FROM PUBLIC, anon, authenticated;/);
    assert.match(migration, /GRANT ALL ON TABLE public\.trial_maps_routes TO service_role;/);
    assert.match(migration, /org_has_paid_access\(p_org\)/);
    assert.match(migration, /p\.is_approved/);
    assert.match(migration, /org_trial_active\(p_org\)/);
    assert.match(migration, /pg_advisory_xact_lock/);
    assert.equal(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*authenticated/i.test(migration.replace(/^\s*--.*$/gm, '')), false);
    assert.equal(/google|api[_-]?key/i.test(migration.replace(/^\s*--.*$/gm, '')), false, 'ключів у міграції немає');
});

test('клієнт: на тріалі підказки OSM, Places не створюється; маршрут Google лише після maps_route_take', () => {
    assert.match(functionSource(html, 'createAddressAutocomplete'), /if \(trialOnly\(\)\) return createOsmAddressField\(/);
    const route = functionSource(html, 'calculateGoogleRoute');
    assert.ok(route.indexOf('trialOnly() && !trialRouteTicket') !== -1 && route.indexOf('trialOnly() && !trialRouteTicket') < route.indexOf('directionsService.route('), 'шлюз стоїть до виклику Directions');
    assert.ok(functionSource(route, 'failFinal').includes('trialRefund();'), 'помилка Google повертає дозвіл');
    const back = functionSource(html, 'calculateBackhaulRoute');
    assert.ok(back.indexOf('trialOnly() && !trialRouteTicket') !== -1 && back.indexOf('trialOnly() && !trialRouteTicket') < back.indexOf('directionsService.route('), 'зворотний маршрут теж через шлюз');
    assert.match(back, /trialRefund\(\);\n\s+statusEl\.innerText = '❌ Не вдалося побудувати зворотний маршрут/);
    assert.match(functionSource(html, 'trialOnly'), /!isDemo && !billingManualAccess && !billingPaidActive\(billingPaidUntil\) && billingTrial\(\)\.active/);
    assert.match(functionSource(html, 'trialTake'), /rpc\('maps_route_take'/);
    // Після оплати чи ручного схвалення ліміту немає: Google вантажиться як раніше, а залишок ховається.
    assert.match(html, /if \(!isDemo && !trialOnly\(\) && \(wasDemo \|\| !map\)\) loadGoogleMaps\(\)/);
    assert.match(html, /if \(!trialOnly\(\)\) trialMapsNote\(null\);/);
    // Ключів Google у серверних файлах немає, а Places у тріальній гілці не згадується.
    assert.equal(/PlaceAutocompleteElement|importLibrary/.test(functionSource(html, 'createOsmAddressField')), false);
});

function gate(rpc, extra = {}) {
    const calls = [];
    const state = { ticket: false, key: null };
    const src = ['trialRouteKeyOf', 'trialRoutesWord', 'trialTake', 'trialRefund', 'trialGoogleRoute'].map((n) => functionSource(html, n)).join('\n');
    const factory = new Function('ctx', `
        const { supabaseClient, calls, trialMapsNote, trialRouteStatus, trialReadyGoogle, trialOsmRoute, calculateGoogleRoute, trialMapsStatus, state } = ctx;
        let trialRouteTicket = false; let trialRouteKey = null;
        ${src}
        return { run: trialGoogleRoute, ticket: () => trialRouteTicket, key: () => trialRouteKey, setTicket: (v) => { trialRouteTicket = v; }, refund: trialRefund, word: trialRoutesWord };
    `);
    const api = factory({
        supabaseClient: { rpc: async (name, args) => { calls.push(['rpc', name, args]); return rpc(name, args); } },
        calls, state,
        trialMapsNote: () => {}, trialRouteStatus: (t) => calls.push(['status', t]), trialMapsStatus: () => {},
        trialReadyGoogle: extra.ready || (async () => { calls.push(['google-loaded']); }),
        trialOsmRoute: async (b, f, t, limitHit) => { calls.push(['osm', f, t, limitHit]); },
        calculateGoogleRoute: () => calls.push(['google-route'])
    });
    return { api, calls };
}

test('шлюз клієнта: дозволено → Google; 21-й (limit) → OSM без Google; помилка сервера → OSM без Google; помилка Google → дозвіл повертається', async () => {
    let g = gate(async () => ({ data: { allowed: true, left: 19, limit: 20, used: 1 }, error: null }));
    await g.api.run('Київ', 'Житомир', 'Одеса', ['Вінниця']);
    assert.deepEqual(g.calls.filter((c) => c[0] === 'google-route' || c[0] === 'osm').map((c) => c[0]), ['google-route']);
    assert.equal(g.calls.find((c) => c[0] === 'rpc')[2].p_key, 'київ>житомир>вінниця>одеса', 'ключ маршруту нормалізований, з проміжними точками');
    assert.equal(g.api.ticket(), true);

    g = gate(async () => ({ data: { allowed: false, reason: 'limit', left: 0, limit: 20 }, error: null }));
    await g.api.run('', 'Житомир', 'Одеса', []);
    assert.equal(g.calls.some((c) => c[0] === 'google-route' || c[0] === 'google-loaded'), false, '21-й: Google не завантажується й не викликається');
    assert.deepEqual(g.calls.find((c) => c[0] === 'osm'), ['osm', 'Житомир', 'Одеса', true]);

    g = gate(async () => ({ data: null, error: { message: 'down' } }));
    await g.api.run('', 'A', 'B', []);
    assert.equal(g.calls.some((c) => c[0] === 'google-route'), false, 'без відповіді сервера Google не викликається');
    assert.deepEqual(g.calls.find((c) => c[0] === 'osm'), ['osm', 'A', 'B', false]);

    g = gate(async () => ({ data: { allowed: true, left: 5, limit: 20 }, error: null }), { ready: async () => { throw new Error('script load error'); } });
    await g.api.run('', 'A', 'B', []);
    assert.ok(g.calls.some((c) => c[0] === 'rpc' && c[1] === 'maps_route_refund'), 'Google не завантажився → дозвіл повернуто');
    assert.equal(g.calls.some((c) => c[0] === 'google-route'), false);
    assert.deepEqual(g.calls.find((c) => c[0] === 'osm'), ['osm', 'A', 'B', false]);
});

test('залишок маршрутів: правильна форма слова', () => {
    const word = gate(async () => ({ data: null })).api.word;
    assert.deepEqual([0, 1, 2, 4, 5, 11, 12, 14, 20, 21, 22].map(word),
        ['маршрутів', 'маршрут', 'маршрути', 'маршрути', 'маршрутів', 'маршрутів', 'маршрутів', 'маршрутів', 'маршрутів', 'маршрут', 'маршрути']);
});

test('Photon/OSRM і серверні файли: нових функцій Vercel немає, Google-ключ не логується', () => {
    const api = fs.readdirSync(new URL('../api/', import.meta.url)).filter((f) => f.endsWith('.js')).sort();
    assert.equal(api.length, 9, 'функцій Vercel стільки ж, як на main (billing/ — тека)');
    assert.equal(api.some((f) => /maps|route|google/i.test(f)), false);
    assert.ok(read('assets/osm-geo.js').includes('geocode: geocode,'), 'geocode доступний для запасного шляху');
    assert.equal(/console\.(log|warn|error)\([^)]*(GOOGLE|apiKey|api_key)/i.test(html.slice(html.indexOf('// ===== Тріал: ліміт маршрутів Google'), html.indexOf('function loadGoogleMaps()'))), false);
});
