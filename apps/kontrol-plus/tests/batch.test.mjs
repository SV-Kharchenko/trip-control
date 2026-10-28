import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { docStatusKey, docStatusLabel } from '../src/lib/docs.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const readRoot = (file) => fs.readFileSync(new URL('../../../' + file, import.meta.url), 'utf8');
const css = read('src/crm.css');

// ---- 1. Статуси актів ----
test('п.1: акт — «Створено» / «Підписано» / «Анульовано», рахунок лишає статус оплати', () => {
    assert.equal(docStatusLabel('act', 'issued', false), 'Створено');
    assert.equal(docStatusLabel('act', 'issued', true), 'Підписано');
    assert.equal(docStatusLabel('act', 'cancelled', true), 'Анульовано');
    assert.equal(docStatusKey('act', 'issued', true), 'signed');
    for (const [status, label] of [['issued', 'Виставлено'], ['partial', 'Частково оплачено'], ['paid', 'Оплачено'], ['overdue', 'Прострочено'], ['cancelled', 'Анульовано']]) {
        assert.equal(docStatusLabel('invoice', status), label, status);
    }
    const docs = read('src/views/docs.js');
    assert.match(docs, /statusBadge\(r\.pay_status, r\.kind, signed\.has\(r\.id\)\)/);
    assert.match(docs, /r\.kind === 'act' \? h\('span', \{ class: 'kpd-kind kpd-kind-act' \}, 'Акт'\)/);
    assert.match(css, /\.kpd-st-signed \{/);
    assert.match(read('src/views/docs-card.js'), /rpc\('kp_doc_sign', \{ p_doc: doc\.id, p_signed: !signed \}\)/);
});

test('п.1: міграція підпису акта — окрема таблиця, RPC лише для власника, без прямого доступу', () => {
    const sql = readRoot('supabase/migrations/20261028100000_kp_act_signatures.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kp_document_signatures/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /v_org uuid := public\.kp_docs_org\('owner'\)/);
    assert.match(sql, /v_org uuid := public\.kp_docs_org\('read'\)/);
    assert.match(sql, /DOC_SIGN_ACT_ONLY/);
    assert.equal(/GRANT .* TO anon/i.test(sql), false);
    assert.match(sql, /НЕ застосовувати на прод/);
    // Не редагує старі міграції й викликає лише оголошені функції.
    const declared = new Set();
    for (const name of fs.readdirSync(new URL('../../../supabase/migrations/', import.meta.url))) {
        for (const m of readRoot('supabase/migrations/' + name).matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\s*\(/gi)) declared.add(m[1]);
    }
    for (const m of sql.replace(/--.*$/gm, '').matchAll(/public\.([a-z_0-9]+)\(/g)) assert.ok(declared.has(m[1]), m[1]);
});

// ---- 2. ТТН в Excel: графа 5 — назва одиниці, число — у кількості / масі ----
test('п.2: «Одиниця вимірювання» — назва, число переїжджає в кількість і масу (Excel, PDF-текст, збереження)', async () => {
    const { normalizeCargoLine } = await import('../src/lib/ttn.js');
    const { cargoCells, cargoTotals, CARGO_COLUMNS } = await import('../src/lib/ttn-text.js');
    const { ttnSheet } = await import('../src/lib/xlsx-docs.js');
    assert.deepEqual(normalizeCargoLine({ unit: '22', places: '', gross_t: '' }), { unit: 'т', places: 22, gross_t: 22 });
    assert.deepEqual(normalizeCargoLine({ unit: '22,5', places: null, gross_t: 20 }), { unit: 'т', places: null, gross_t: 20 });
    assert.deepEqual(normalizeCargoLine({ unit: 'кг', places: 3 }), { unit: 'кг', places: 3 }, 'назва лишається як є');
    assert.equal(normalizeCargoLine({ unit: ' 5 ', places: 7, gross_t: 9 }).places, 7, 'заповнені графи не чіпаємо');

    const doc = {
        kind: 'ttn', status: 'issued', number: 1, doc_date: '2026-10-27', cargo_gross_t: 22, operations: [],
        lines: [
            { cargo_name: 'Пшениця', unit: '22', places: null, gross_t: null },
            { cargo_name: 'Ящики', unit: 'шт', places: 40, price: 10, amount: 400, gross_t: 1.2 },
        ],
    };
    const sheet = ttnSheet(doc);
    const unitCol = CARGO_COLUMNS.findIndex((c) => c.key === 'unit');
    const placesCol = CARGO_COLUMNS.findIndex((c) => c.key === 'places');
    const grossCol = CARGO_COLUMNS.findIndex((c) => c.key === 'gross_t');
    assert.equal(CARGO_COLUMNS[unitCol].no, '5');
    const dataRows = sheet.rows.filter((r) => r[1] && (r[1].v === 'Пшениця' || r[1].v === 'Ящики'));
    assert.equal(dataRows.length, 2);
    assert.equal(dataRows[0][unitCol].v, 'т', 'у графі 5 — назва одиниці, а не 22');
    assert.equal(dataRows[0][placesCol].v, 22);
    assert.equal(dataRows[0][grossCol].v, 22);
    assert.equal(dataRows[1][unitCol].v, 'шт');
    assert.equal(dataRows[1][placesCol].v, 40);
    assert.equal(cargoCells(doc.lines[0], 0).unit, 'т');
    assert.equal(cargoTotals(doc).places, '62');
});

// ---- 3. Кнопки створення лише на потрібних вкладках ----
test('п.3: «Створити рахунок / акт» тільки на «Акти», «Створити ТТН» тільки на «ТТН / 2-ТН»', async () => {
    const fakeDom = { createElement: (tag) => ({ tagName: tag, children: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); }, addEventListener() {}, classList: {}, className: '' }), createTextNode: (text) => ({ text }) };
    Object.defineProperty(globalThis, 'document', { value: fakeDom, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Node', { value: class {}, configurable: true, writable: true });
    try {
        const { createButtonsFor } = await import('../src/views/docs.js');
        const text = (el) => el.children.map((c) => (c.text !== undefined ? c.text : text(c))).join('');
        const labels = (tab) => createButtonsFor(tab).map(text);
        assert.deepEqual(labels('acts'), ['Створити рахунок', 'Створити акт']);
        assert.deepEqual(labels('ttn'), ['Створити ТТН']);
        for (const tab of ['', 'contracts', 'other', undefined]) assert.deepEqual(labels(tab), [], String(tab));
    } finally {
        delete globalThis.document;
        delete globalThis.Node;
    }
    const docs = read('src/views/docs.js');
    assert.match(docs, /renderDocList\(app, access, TAB_KIND\[route\.tab\] \|\| '', route\.tab \|\| ''\)/);
});

// ---- 4. Статистика: графік фіксованої висоти, шрифти 12px, легенда і значення ----
test('п.4: графік ~240px заввишки, підписи 12px без масштабування, значення над стовпчиками, легенда', async () => {
    const { CHART, compactMoney, monthsChartShapes } = await import('../src/lib/stats.js');
    assert.equal(CHART.h, 240);
    assert.equal(CHART.font, 12);
    assert.equal(compactMoney(128400), '128 тис');
    assert.equal(compactMoney(1300000), '1,3 млн');
    assert.equal(compactMoney(950), '950');
    const months = [
        { key: '2026-08', revenue: 0, profit: 0, trips: 0 },
        { key: '2026-09', revenue: 300000, profit: 50000, trips: 2 },
        { key: '2026-10', revenue: 1300000, profit: 400000, trips: 5 },
    ];
    for (const width of [480, 640, 1100]) {
        const shapes = monthsChartShapes(months, width, 240);
        for (const [tag, attrs] of shapes) {
            if (tag !== 'text') continue;
            assert.equal(attrs['font-size'], 12, 'підписи фіксованого розміру ' + width);
            assert.ok(attrs.y >= 10 && attrs.y <= 240, 'підпис у межах висоти ' + attrs.y);
        }
        for (const [tag, attrs] of shapes) if (tag === 'rect') assert.ok(attrs.y >= 0 && attrs.y + attrs.height <= 240 + 0.1);
        const values = shapes.filter(([tag]) => tag === 'text').map(([, , text]) => text);
        assert.ok(values.includes('1,3 млн') && values.includes('400 тис'), 'значення над стовпчиками ' + values.join(','));
    }
    const view = read('src/views/stats.js');
    assert.match(view, /svgEl\('svg', \{ width: w, height: CHART\.h, viewBox: '0 0 ' \+ w \+ ' ' \+ CHART\.h/);
    assert.match(view, /class: 'kps-legend'/);
    assert.match(css, /\.kps-chart svg \{ display: block; max-width: 100%; height: 240px; \}/);
});

// ---- 5. Ліве меню: стабільна геометрія (не залежить від JS-змінних), 24px до контенту скрізь ----
test('п.5: меню має фіксований padding, змінні з fallback, відступ 24px між меню й контентом на всіх сторінках', () => {
    assert.match(css, /:root \{ --kp-nav-w: 224px; --kp-gap: 24px; \}/);
    assert.match(css, /width: var\(--kp-nav-w, 224px\); z-index: 35; box-sizing: border-box;\n\s+display: flex; flex-direction: column; padding: 12px 10px;/);
    assert.match(css, /body\.kp-nav-on\.layout-studio #main-app \{ padding-left: calc\(var\(--kp-nav-w, 224px\) \+ var\(--kp-gap, 24px\)\) !important; padding-right: var\(--kp-gap, 24px\) !important; \}/);
    assert.equal(/data-studio-view="history"\]:not\(\[data-kp-view\]\) #main-app/.test(css), false, 'окремих відступів для історії / огляду більше немає');
    assert.match(css, /#kp-side \.kp-nav button \{ justify-content: center; padding: 0; width: 40px; margin-inline: auto; \}/);
});

test('п.5: production-збірка містить усі правила меню після стилів сайту', async () => {
    const dist = new URL('../dist/', import.meta.url);
    if (!fs.existsSync(new URL('index.html', dist))) return; // dist збирається окремо (npm run build)
    const html = fs.readFileSync(new URL('index.html', dist), 'utf8');
    const link = html.match(/<link rel="stylesheet" href="(\/kp-assets\/site-bridge-[^"]+\.css)">/);
    assert.ok(link, 'стилі Контроль+ підключено <link> у head');
    assert.ok(html.indexOf(link[0]) > html.lastIndexOf('</style>', html.indexOf(link[0])), 'після стилів сайту');
    const built = fs.readFileSync(new URL('.' + link[1].replace('/kp-assets/', '/kp-assets/'), dist), 'utf8');
    for (const needle of ['#kp-side{position:fixed', 'padding:12px 10px', '--kp-gap: 24px', 'padding-left:calc(var(--kp-nav-w, 224px) + var(--kp-gap, 24px))!important', '@media (max-width: 1024px)']) {
        assert.ok(built.includes(needle), 'у збірці: ' + needle);
    }
});

// ---- 6. Нові поля водія: валідація й міграція ----
test('п.6: ІПН / РНОКПП — рівно 10 цифр, паспорт і телефон перевіряються, порожні поля дозволені', async () => {
    const { validateDriverDetails } = await import('../src/lib/fleet.js');
    const ok = validateDriverDetails({ phone: '+380 (67) 123-45-67', passport: 'ав 123456', ipn: '1234567890', address: '  м.  Луцьк, вул. Миру 1 ' });
    assert.deepEqual(ok.errors, {});
    assert.deepEqual(ok.data, { phone: '+380671234567', passport: 'АВ123456', ipn: '1234567890', address: 'м. Луцьк, вул. Миру 1' });
    assert.deepEqual(validateDriverDetails({}).data, { phone: null, passport: null, ipn: null, address: null });
    assert.deepEqual(validateDriverDetails({ passport: '123456789' }).errors, {}, 'ID-картка з 9 цифр');
    for (const bad of ['123456789', '12345678901', '12345a7890', '1234 5678 9', 'abcdefghij']) {
        assert.ok(validateDriverDetails({ ipn: bad }).errors.ipn, 'ІПН ' + bad);
    }
    assert.equal(validateDriverDetails({ ipn: '12 34 56 78 90' }).data.ipn, '1234567890', 'пробіли прибираються');
    assert.ok(validateDriverDetails({ passport: 'A1' }).errors.passport);
    assert.ok(validateDriverDetails({ passport: 'AB12345' }).errors.passport);
    assert.ok(validateDriverDetails({ phone: '12-34' }).errors.phone);
    assert.ok(validateDriverDetails({ address: 'x'.repeat(301) }).errors.address);
    const { ttnErrorText } = await import('../src/lib/ttn.js');
    assert.match(ttnErrorText({ message: 'DRIVER_BAD_IPN' }), /рівно 10 цифр/);
});

test('п.6: міграція деталей водія — окрема таблиця з RLS, читання своєю організацією, запис лише власником, ТТН без нових полів', () => {
    const sql = readRoot('supabase/migrations/20261028100100_kp_driver_details.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kp_driver_details/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /CREATE POLICY kp_driver_details_select ON public\.kp_driver_details\s+FOR SELECT TO authenticated\s+USING \(org_id = public\.current_org_id\(\)\);/);
    assert.match(sql, /GRANT SELECT ON public\.kp_driver_details TO authenticated;/);
    assert.equal(/GRANT (ALL|INSERT|UPDATE|DELETE)[^;]* ON public\.kp_driver_details TO authenticated/i.test(sql), false, 'прямого запису клієнтам немає');
    assert.match(sql, /v_org uuid := public\.kp_docs_org\('owner'\)/);
    assert.match(sql, /ipn ~ '\^\[0-9\]\{10\}\$'/);
    assert.match(sql, /НЕ застосовувати на прод/);
    // Жодна функція ТТН / довідника водіїв не знає нових полів.
    const ttn = readRoot('supabase/migrations/20261026130623_kp_docs_ttn.sql');
    assert.equal(/kp_driver_details|passport/i.test(ttn), false, 'у міграції ТТН немає нових полів водія');
    const ttnPrint = ['src/lib/ttn-text.js', 'src/lib/pdf-ttn.js', 'src/lib/xlsx-docs.js'].map(read).join('\n');
    assert.equal(/passport|kp_driver_details|\bipn\b/i.test(ttnPrint), false, 'ТТН (PDF / Excel / текст) не виводить нові поля');
    assert.match(read('db/check-db.mjs'), /'driver details RLS: direct ' \+ label \+ ' by ' \+ name \+ ' is refused'/);
});
