// Звіт «План/факт»: одна база для плану й факту (рейси з фактом), «Усі рейси» окремо, CSV = таблиця, без «Разом» для одного рядка,
// без скролу на 390 / 1024 / 1366 / 1920, лише змінні тем, ролі «Директор» / «Менеджер».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
    COLUMNS, DIRECTION_HINT, columnTitle, devPct, directionHint, noFactNote, reportCards, reportCsv, showTotal, totals,
} from '../src/lib/report.js';
import { ROLE_LABELS } from '../src/lib/gate.js';
import { REPAIR_ROLE_LABELS } from '../src/lib/repairs.js';
import { roleLabel } from '../src/shell-menu.js';
import { OCT } from './helpers/report-fixture.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(APP, file), 'utf8');

test('жовтневий приклад: картки на одній базі — план з фактом, факт, відхилення, % від |плану з фактом|', () => {
    const t = totals(OCT);
    assert.equal(t.trips, 7);
    assert.equal(t.trips_with_fact, 2);
    assert.equal(t.plan_profit, 182731, 'план усіх рейсів лишається окремо');
    const c = reportCards(t);
    assert.equal(c.plan, -19379);
    assert.equal(c.fact, -50510);
    assert.equal(c.deviation, -31131);
    assert.equal(c.deviation, c.fact - c.plan, 'відхилення = факт − план тієї ж бази');
    assert.equal(c.pct, -160.6);
    assert.equal(c.missing, 5);
    assert.equal(c.noFactPlan, 202110, 'план рейсів без факту = 182 731 − (−19 379)');
    assert.equal(noFactNote(c, (v) => v + ' ₴'), 'ще 5 рейсів без факту, план 202110 ₴');
    assert.equal(noFactNote({ missing: 1, noFactPlan: 5 }, String), 'ще 1 рейс без факту, план 5');
    assert.equal(noFactNote({ missing: 3, noFactPlan: 5 }, String), 'ще 3 рейси без факту, план 5');
    assert.equal(noFactNote({ missing: 0 }, String), '');
    assert.equal(c.hint, '');
});

test('0 фактів → картки «—» і підказка; відхилення без бази не рахується', () => {
    const rows = [{ ...OCT[2] }];
    const c = reportCards(totals(rows));
    assert.deepEqual([c.plan, c.fact, c.deviation, c.pct], [null, null, null, null]);
    assert.equal(c.hasFacts, false);
    assert.equal(c.hint, 'Внесіть факт по рейсах, щоб побачити відхилення');
    assert.equal(devPct({ trips_with_fact: 1, plan_profit_with_fact: 0, deviation_profit: 5 }), null, 'ділення на 0');
    assert.equal(totals([]).deviation_pct, null);
    assert.equal(reportCards(totals([])).hasFacts, false);
});

test('таблиця: у «Рейсах з фактом» план — лише з фактом, нічого не змішує; групи без факту — «—»', () => {
    const col = (key) => COLUMNS.find((x) => x.key === key);
    assert.deepEqual(COLUMNS.map((x) => x.key), ['trips', 'plan_all', 'plan_with_fact', 'fact', 'deviation', 'pct']);
    assert.equal(col('plan_all').value(OCT[0]), 100000);
    assert.equal(col('plan_with_fact').value(OCT[0]), -9379);
    assert.equal(col('fact').value(OCT[0]), -30000);
    assert.equal(col('trips').value(OCT[0]), '1 з 3');
    for (const key of ['plan_with_fact', 'fact', 'deviation', 'pct']) assert.equal(col(key).value(OCT[2]), null, key + ' без факту');
    assert.equal(col('plan_all').value(OCT[2]), 22731, 'план усіх рейсів видно й без факту');
    // дохід / витрати факту в колонках таблиці не показуються (варіант A)
    assert.ok(!COLUMNS.some((x) => /revenue|costs/.test(x.key)));
});

test('«Разом» лише коли рядків більше одного; підказка для напрямків без шаблонів', () => {
    assert.equal(showTotal([OCT[0]]), false);
    assert.equal(showTotal(OCT), true);
    assert.equal(showTotal([]), false);
    const none = [{ group_key: 'none', group_label: 'Без шаблону' }];
    assert.equal(directionHint('direction', none), DIRECTION_HINT);
    assert.equal(DIRECTION_HINT, 'Шаблонів маршрутів немає — збережіть рейс як шаблон, щоб групувати за напрямками');
    assert.equal(directionHint('client', none), '');
    assert.equal(directionHint('direction', [...none, { group_key: 'x' }]), '');
    assert.equal(directionHint('direction', []), '');
    const csvOne = reportCsv([OCT[0]], 'Логісти').slice(1).split('\r\n').filter(Boolean);
    assert.equal(csvOne.length, 2, 'заголовок + один рядок, без «Разом»');
});

test('CSV: ті самі колонки й назви, що в таблиці, з префіксами груп; числа без пробілів тисяч', () => {
    const lines = reportCsv(OCT, 'Логісти').slice(1).split('\r\n').filter(Boolean);
    assert.equal(lines[0], ['Логісти', ...COLUMNS.map(columnTitle)].join(';'));
    assert.equal(lines[0], 'Логісти;Рейси (з фактом / усього);Усі рейси: План прибутку;Рейси з фактом: План прибутку;Рейси з фактом: Факт прибутку;Рейси з фактом: Відхилення;Рейси з фактом: %');
    assert.equal(lines[1], 'Логіст А;1 з 3;100000;-9379;-30000;-20621;-219,9');
    assert.equal(lines[3], 'Логіст В;0 з 2;22731;;;;');
    assert.equal(lines[4], 'Разом;2 з 7;182731;-19379;-50510;-31131;-160,6');
    assert.ok(lines.every((l) => !/\d \d{3}/.test(l)), 'без пробілів тисяч');
    assert.equal(lines[0].split(';').length, lines[1].split(';').length);
});

test('ролі: owner — «Директор», director — «Менеджер»; шапка Контроль+ і меню узгоджені', () => {
    assert.deepEqual(ROLE_LABELS, { owner: 'Директор', logist: 'Логіст', director: 'Менеджер', repair_manager: 'Відповідальний за ремонти' });
    for (const role of ['owner', 'logist', 'director']) {
        assert.equal(roleLabel(role), ROLE_LABELS[role], 'шапка (shell-menu): ' + role);
        if (role !== 'logist' || REPAIR_ROLE_LABELS.logist) assert.equal(REPAIR_ROLE_LABELS[role], ROLE_LABELS[role], 'ремонти: ' + role);
    }
    assert.equal(roleLabel('x', 'запасний'), 'запасний');
    assert.equal(roleLabel('owner') === roleLabel('director'), false, 'owner і director — різні підписи');
    assert.equal(REPAIR_ROLE_LABELS.repair_manager, ROLE_LABELS.repair_manager);
    assert.match(read('src/views/repairs-handlers.js'), /Директор і менеджер вносять ремонти завжди/, 'director реально пише ремонти (kp_repairs_can_write)');
    // «Власник» з великої літери — як підпис ролі — ніде в UI Контроль+
    const hits = [];
    const walk = (dir) => { for (const f of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
        const rel = dir + '/' + f.name;
        if (f.isDirectory()) walk(rel);
        else if (/\.js$/.test(f.name)) read(rel).split('\n').forEach((line, i) => { if (/Власник/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(rel + ':' + (i + 1)); });
    } };
    walk('src');
    assert.deepEqual(hits, [], 'жодного «Власник» у рядках UI');
});

test('report.js і CSS звіту: лише змінні тем — без hex / rgb / hsl / ocean', () => {
    const css = read('src/kp-report.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [name, text] of [['kp-report.css', css], ['report.js', read('src/views/report.js')], ['lib/report.js', read('src/lib/report.js')]]) {
        assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, name + ': hex');
        assert.doesNotMatch(text, /\b(?:rgb|rgba|hsl|hsla)\(/i, name + ': rgb / hsl');
        assert.doesNotMatch(text, /ocean/i, name + ': ocean');
    }
    assert.match(css, /var\(--font-mono/);
    assert.match(css, /tabular-nums/);
    // Прокрутка вбік — лише всередині таблиці на телефоні (@media 720px), не сторінки.
    assert.equal((css.match(/overflow-x:\s*(auto|scroll)/g) || []).length, 1);
    assert.match(css, /@media \(max-width: 720px\) \{[^@]*\.kpq-wrap \{ overflow-x: auto;/);
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-report\.css';/);
    assert.doesNotMatch(read('src/views/report.js'), /innerHTML/);
    assert.match(read('src/views/report.js'), /kpd-periods kpq-groups/, 'групування — легкий segment як період дашборда');
});

test('дашборд: «Розрахунок рейсу» у режимі лише читання лишається disabled — розрахунок рейсу зберігає в організацію користувача, а не відмовляє', () => {
    const src = read('src/views/dashboard.js');
    assert.match(src, /id: 'kpd-calc', onclick: openSite\('calc'\), \.\.\.disabledAttrs/);
    const policy = fs.readFileSync(path.join(APP, '../../supabase/migrations/20261012161314_owner_logist_team_hardening.sql'), 'utf8');
    assert.match(policy, /CREATE POLICY calculations_insert_role ON public\.calculations\s+FOR INSERT TO authenticated\s+WITH CHECK \(\s+org_id = public\.current_org_id\(\)\s+AND user_id = auth\.uid\(\)/,
        'сервер дозволяє запис у власну організацію — режим лише читання сервер для розрахунку рейсу не забезпечує');
});

// ---------------- Браузер ----------------
async function loadBrowser() {
    let pw;
    try { pw = await import('playwright-core'); } catch { return null; }
    const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
    for (const executablePath of candidates) {
        try { return await pw.chromium.launch({ executablePath, headless: true }); } catch { /* наступний */ }
    }
    try { return await pw.chromium.launch({ headless: true }); } catch { return null; }
}
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const PAGE = `<!doctype html><html lang="uk" data-app="kp"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/crm.css"><link rel="stylesheet" href="/src/kp-dashboard.css"><link rel="stylesheet" href="/src/kp-report.css">
<style>:root{--font-mono:'JetBrains Mono',ui-monospace,monospace} body{margin:0;padding:14px 18px;font-family:system-ui,sans-serif} body[data-theme=light]{background:#F4EFE4} body[data-theme=dark]{background:#0E1117}</style></head>
<body><section id="kp-crm"></section><script type="module">
const q = new URLSearchParams(location.search);
document.body.dataset.theme = q.get('theme') || 'light'; document.body.dataset.kpView = 'report';
const { OCT } = await import('/tests/helpers/report-fixture.mjs');
const { renderReport } = await import('/src/views/report.js');
const scenario = q.get('s') || 'oct';
const rows = scenario === 'oct' ? OCT : scenario === 'one' ? [OCT[0]] : scenario === 'nofact' ? [OCT[2]]
    : scenario === 'none' ? [{ group_key: 'none', group_label: 'Без шаблону', trips: 4, trips_with_fact: 0, plan_revenue: 1, plan_costs: 1, plan_profit: 1234567, fact_revenue: 0, fact_costs: 0, fact_profit: 0, plan_profit_with_fact: 0, deviation_profit: 0, deviation_pct: null }] : [];
window.__calls = [];
const app = { supabase: { rpc: async (name, args) => { window.__calls.push({ name, args }); return { data: rows, error: null }; } }, onPlanLost() {} };
document.getElementById('kp-crm').append(renderReport(app, 'main'));
window.__ready = true;
</script></body></html>`;

async function withReport(t, fn) {
    const browser = await loadBrowser();
    if (!browser) { t.skip('no playwright-core / Chrome'); return; }
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(PAGE); return; }
        const file = path.join(APP, decodeURIComponent(url.pathname));
        if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    try { await fn(browser, base); } finally { await browser.close(); server.close(); }
}
const SHOTS = process.env.KP_SHOTS_DIR || null;

test('браузер: 390 / 1024 / 1366 / 1920 × світла / темна — без горизонтального скролу, нічого не обрізано, картки й таблиця на одній базі', async (t) => {
    await withReport(t, async (browser, base) => {
        for (const [w, hgt] of [[390, 844], [1024, 768], [1366, 768], [1920, 900]]) {
            for (const theme of ['light', 'dark']) {
                const page = await browser.newPage({ viewport: { width: w, height: hgt } });
                const errors = [];
                page.on('pageerror', (e) => errors.push(String(e)));
                await page.goto(base + '?theme=' + theme);
                await page.waitForSelector('.kpq tbody tr');
                const m = await page.evaluate(() => {
                    const vis = (el) => el.getClientRects().length > 0;
                    const clipped = [...document.querySelectorAll('.kpq td, .kpq th, .kpq-card .stat-value')].filter((el) => vis(el) && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent);
                    return {
                        overflow: document.documentElement.scrollWidth - window.innerWidth,
                        clipped,
                        cards: [...document.querySelectorAll('.kpq-card .stat-value')].map((e) => e.textContent.replace(/\s/g, ' ')),
                        note: document.querySelector('.kpq-note').textContent,
                        foot: document.querySelectorAll('.kpq tfoot tr').length,
                        allHidden: [...document.querySelectorAll('.kpq td.kpq-all')].every((e) => !vis(e)),
                        mono: getComputedStyle(document.querySelector('.kpq td.kpq-mono')).fontVariantNumeric,
                        tableMode: getComputedStyle(document.querySelector('.kpq thead')).display === 'none' ? 'cards' : 'table',
                        firstColSticky: getComputedStyle(document.querySelector('.kpq tbody tr > :first-child')).position,
                        wrapScrolls: (() => { const w = document.querySelector('.kpq-wrap'); return w.scrollWidth > w.clientWidth; })(),
                    };
                });
                assert.ok(m.overflow <= 0, `скрол при ${w} (${theme}): ${m.overflow}`);
                assert.deepEqual(m.clipped, [], 'обрізано при ' + w);
                const norm = (x) => x.replace(/[−s]/g, (c) => (c === '−' ? '-' : ' '));
                assert.deepEqual(m.cards.map(norm), ['-19 379 ₴', '-50 510 ₴', '-31 131 ₴ · -160,6%']);
                assert.match(m.note, /ще 5 рейсів без факту, план 202.110 ₴/);
                assert.equal(m.foot, 1, '«Разом» при кількох групах');
                assert.match(m.mono, /tabular-nums/);
                if (w >= 1101) assert.equal(m.allHidden, false, 'на широких видно «Усі рейси»');
                if (w <= 1100 && w > 720) assert.equal(m.allHidden, true, 'на середніх лишаються пріоритетні колонки');
                if (w <= 720) {
                    assert.equal(m.tableMode, 'table', 'телефон: та сама таблиця, не картки');
                    assert.equal(m.firstColSticky, 'sticky', 'перша колонка липка');
                    assert.ok(m.wrapScrolls, 'решта прокручується всередині таблиці, а не сторінки');
                }
                assert.deepEqual(errors, []);
                if (SHOTS && (w === 390 || w === 1366 || w === 1920)) await page.screenshot({ path: path.join(SHOTS, `report-${w}-${theme}.png`), fullPage: true });
                await page.close();
            }
        }
    });
});

test('браузер: один рядок — без «Разом»; 0 фактів — «—» і підказка; напрямки без шаблонів — пояснення; розгортання рядка', async (t) => {
    await withReport(t, async (browser, base) => {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.goto(base + '?s=one');
        await page.waitForSelector('.kpq tbody tr');
        assert.equal(await page.locator('.kpq tfoot').count(), 0);
        await page.goto(base + '?s=nofact');
        await page.waitForSelector('.kpq tbody tr');
        assert.deepEqual(await page.locator('.kpq-card .stat-value').allInnerTexts(), ['—', '—', '—']);
        assert.match(await page.locator('.kpq-note').first().innerText(), /Внесіть факт по рейсах, щоб побачити відхилення/);
        assert.equal(await page.locator('.kpq-exp').count(), 0, 'без факту розгортання немає');
        await page.goto(base + '?s=none');
        await page.waitForSelector('.kpq tbody tr');
        await page.getByRole('radio', { name: 'Напрямки (шаблони)' }).click();
        await page.waitForFunction(() => document.querySelector('.kpq-hint'));
        assert.match(await page.locator('.kpq-hint').innerText(), /Шаблонів маршрутів немає/);
        await page.goto(base + '?s=oct');
        await page.waitForSelector('.kpq tbody tr');
        const pos = await page.evaluate(() => {
            const p = (el) => (getComputedStyle(el).position === 'sticky' && getComputedStyle(el).left === '0px' ? 'sticky' : 'free'); // липкість по горизонталі (th шапки лишаються липкими лише зверху)
            const rows = document.querySelectorAll('.kpq thead tr');
            return { head1: p(rows[0].firstElementChild), head2: [...rows[1].children].map(p), body: p(document.querySelector('.kpq tbody tr').firstElementChild), foot: p(document.querySelector('.kpq tfoot tr').firstElementChild) };
        });
        assert.equal(pos.head1, 'sticky');
        assert.ok(pos.head2.every((v) => v !== 'sticky'), 'у другому рядку шапки нічого не липке: ' + pos.head2);
        assert.equal(pos.body, 'sticky');
        assert.equal(pos.foot, 'sticky');
        const detail = page.locator('.kpq-detail').first();
        assert.equal(await detail.isHidden(), true);
        await page.locator('.kpq-exp').first().click();
        assert.equal(await detail.isVisible(), true);
        assert.match(await detail.innerText(), /дохід .*80.000 ₴.*витрати .*110.000 ₴/s);
        await page.close();
    });
});
