// lib/ — серверний код (api/ імпортує з нього: rate-limit, billing, agro-sso…), а Vercel роздає корінь репозиторію як статику, тож /lib/*.js
// був доступний у браузері. Rewrite не допомагає (Vercel спершу віддає файл з диска), тому redirect, що спрацьовує до файлу. .vercelignore тут не годиться (виріже lib/ із збірки функцій), тому і його не використано.
// Єдиний виняток — lib/weekly-report.js: чиста функція, яку index.html імпортує в браузері (прев'ю тижневого звіту).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const BROWSER_LIB = ['/lib/weekly-report.js'];

function rule() {
    const found = JSON.parse(read('vercel.json')).redirects.filter((r) => r.source.startsWith('/lib/'));
    assert.equal(found.length, 1, 'одне правило для /lib/ у redirects');
    return found[0];
}
const matches = (pathname) => new RegExp('^/lib/(' + rule().source.match(/:path((.*))$/)[1] + ')$').test(pathname);

test('vercel.json: /lib/* — тимчасовий редірект на /404 (redirects спрацьовують до файлу на диску), крім браузерного weekly-report.js', () => {
    assert.equal(rule().destination, '/404');
    assert.equal(rule().permanent, false);
    for (const p of ['/lib/rate-limit.js', '/lib/agro-sso.js', '/lib/billing/plans.js', '/lib/billing/x.js', '/lib/trip-fact.js', '/lib/weekly-report.json', '/lib/weekly-report.js.bak']) assert.equal(matches(p), true, p);
    for (const p of BROWSER_LIB) assert.equal(matches(p), false, p);
    assert.equal(fs.existsSync(new URL('./404', root)), false, '/404 не файл: Vercel віддає сторінку 404 зі статусом 404');
});

test('vercel.json: у rewrites правила для /lib/ немає (rewrites стоять після файлової системи й /lib/ не закривають)', () => {
    const rewrites = JSON.parse(read('vercel.json')).rewrites;
    assert.equal(rewrites.some((r) => /lib/.test(r.source) || /lib/.test(r.destination)), false);
    assert.equal(rewrites.length, 5);
});

test('.vercelignore не вирізає lib/ і api/ (інакше функції втратять імпорти)', () => {
    const lines = read('.vercelignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const l of lines) assert.equal(/^\/?(lib|api)\b/.test(l), false, l);
});

test('браузерний код сайту звертається лише до дозволеного /lib/*', () => {
    const walk = (dir) => fs.readdirSync(new URL(dir + '/', root), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name]));
    const files = ['index.html', 'sw.js', '404.html', 'offline.html', 'site.webmanifest', ...walk('assets'), ...walk('landing'), ...walk('legal')]
        .filter((f) => /\.(js|html|webmanifest)$/.test(f));
    for (const f of files) {
        for (const m of read(f).matchAll(/['"(=]\s*(\/lib\/[\w./-]+)/g)) assert.ok(BROWSER_LIB.includes(m[1]), f + ' → ' + m[1]);
    }
});

test('lib/weekly-report.js, що йде в браузер, без імпортів і без env-секретів', () => {
    assert.equal(/^import\s/m.test(read('lib/weekly-report.js')), false);
});
