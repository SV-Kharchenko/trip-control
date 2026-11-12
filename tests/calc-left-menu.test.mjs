// Ліве меню «Розрахунку рейсу» (assets/calc-menu.js): чисті функції, статичні перевірки index.html і компонентні тести на jsdom.
// jsdom-тести пропускаються, якщо jsdom не встановлено (як і в calc-onepage.test.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { FAKE_CONFIG_JS } from './helpers/fake-config.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const menuSrc = read('assets/calc-menu.js');
const sandbox = {};
runInNewContext(menuSrc, sandbox);
const M = sandbox.TCCalcMenu;
// Тіло CSS-правила: від селектора до першої «}».
const block = (src, selector) => {
    const at = src.indexOf(selector);
    assert.ok(at > -1, selector);
    return src.slice(at, src.indexOf('}', at));
};

test('підсумок маршруту: «Місто → Місто · N км», порожньо — «Не задано»', () => {
    assert.equal(M.routeSummary('Житомир, Україна', 'Одеса, Одеська обл.', 575), 'Житомир → Одеса · 575 км');
    assert.equal(M.routeSummary('Житомир', '', 0), 'Житомир');
    assert.equal(M.routeSummary('', '', 1234), '1 234 км');
    assert.equal(M.routeSummary('', '', 0), 'Не задано');
    assert.equal(M.routeSummary(null, undefined, NaN), 'Не задано');
});

test('підсумки «Останні маршрути», «ТЗ» і «Витрати»', () => {
    assert.equal(M.recentSummary(3), '3 збережені');
    assert.equal(M.recentSummary(0), 'Немає');
    assert.equal(M.vehicleSummary([]), 'Весь автопарк');
    assert.equal(M.vehicleSummary(['АА 1234 КК']), 'АА 1234 КК');
    assert.equal(M.vehicleSummary(['А', 'Б', 'В']), '3 авто');
    assert.equal(M.costsSummary(0, []), 'з витратної частини компанії');
    assert.equal(M.costsSummary(41200, []), 'з витратної частини · 41 200 грн');
    assert.equal(M.costsSummary(0, ['пробіг між ТО']), 'Немає пробігу між ТО');
});

test('ключ секції: за замовчуванням «Маршрут», невідомий ключ і збій сховища не ламають', () => {
    assert.equal(M.STORAGE_KEY, 'tc.calc.section');
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
    assert.equal(M.readKey(storage), 'route');
    M.writeKey(storage, 'fuel');
    assert.equal(store.get('tc.calc.section'), 'fuel');
    assert.equal(M.readKey(storage), 'fuel');
    store.set('tc.calc.section', 'zzz');
    assert.equal(M.readKey(storage), 'route');
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(M.readKey(broken), 'route');
    assert.doesNotThrow(() => M.writeKey(broken, 'fuel'));
});

test('↑/↓ ходять по колу', () => {
    const keys = M.keys();
    assert.deepEqual(Array.from(keys), ['route', 'fuel', 'extras', 'costs', 'recent', 'vehicle']);
    assert.equal(M.stepKey(keys, 'route', 1), 'fuel');
    assert.equal(M.stepKey(keys, 'route', -1), 'vehicle');
    assert.equal(M.stepKey(keys, 'vehicle', 1), 'route');
});

test('index.html: скрипт меню, токени в обох темах, три колонки, рейка, мобільна смуга', () => {
    assert.match(html, /<script src="\/assets\/calc-menu\.js\?v=[^"]+"><\/script>/);
    for (const theme of ['light', 'dark']) {
        const start = html.indexOf('[data-theme="' + theme + '"] {');
        const tokens = html.slice(start, html.indexOf('}', start));
        for (const t of ['--sidebar', '--sidebar-active', '--sidebar-hover', '--sidebar-text', '--sidebar-muted', '--sidebar-accent', '--sidebar-on-accent']) assert.ok(tokens.includes(t + ':'), theme + ' ' + t);
    }
    const css = html.slice(html.indexOf('/* ===== Ліве меню «Розрахунку рейсу»'), html.lastIndexOf('</style>'));
    assert.match(css, /grid-template-columns: 240px minmax\(380px, min\(34%, 520px\)\) minmax\(0, 1fr\)/);
    assert.match(css, /@media \(min-width: 901px\) and \(max-width: 1099px\)/);
    assert.match(css, /grid-template-columns: 64px minmax\(340px, 42%\) minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 900px\)/);
    assert.match(css, /height: 320px !important/);
    assert.match(css, /position: fixed; left: 0; right: 0; bottom: 0/);
    assert.match(css, /box-shadow: inset 3px 0 0 var\(--sidebar-accent\)/);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/#(tc-|route-|studio-|main-)[\w-]*/g, '').replace(/url\("[^"]*"\)/g, '')), false, 'у CSS меню лише токени тем');
});

test('гнучка ширина панелі: ≥1100 minmax(380px, 34%) до 520px, 901–1099 minmax(340px, 42%), фіксованих 380/360 немає', () => {
    const css = html.slice(html.indexOf('/* ===== Ліве меню «Розрахунку рейсу»'), html.lastIndexOf('</style>'));
    assert.equal(/240px 380px|64px 360px/.test(css), false);
    const rail = css.indexOf('/* 901–1099px: меню — іконна рейка');
    assert.ok(css.indexOf('minmax(380px, min(34%, 520px))') > -1 && css.indexOf('minmax(380px, min(34%, 520px))') < rail);
    assert.ok(css.indexOf('minmax(340px, 42%) minmax(0, 1fr)') > rail);
    // «Звідки/Куди» на всю ширину, банер переноситься
    assert.ok(css.includes('.tc-sg:has(> .tc-f-a) { grid-template-columns: minmax(0, 1fr); }'));
    assert.ok(css.includes('#onboard-banner .hint-text { display: flex; flex-wrap: wrap;'));
});

test('підсумки в меню: до 2 рядків (line-clamp) і повний текст у title; скорочені формулювання', () => {
    const css = html.slice(html.indexOf('/* ===== Ліве меню «Розрахунку рейсу»'), html.lastIndexOf('</style>'));
    assert.ok(block(css, '#tc-calc-nav .tc-nav-sum {').includes('-webkit-line-clamp: 2;'));
    assert.ok(menuSrc.includes('sum.title = text'));
    assert.equal(M.costsSummary(0, ['авто в парку']), 'Немає авто в парку');
    assert.ok(html.includes("'Форма, причіп, простій'"));
    assert.equal(html.includes("extraNames.join(', ') : 'Форма розрахунку, причіп, простій'"), false);
});

test('мобільні вкладки: короткі підписи, повні в aria-label/title, fade і автоскрол', () => {
    const short = Object.fromEntries(M.SECTIONS.map((x) => [x.key, x.short]));
    assert.deepEqual(short, { route: 'Маршрут', fuel: 'Пальне', extras: 'Параметри', costs: 'Витрати', recent: 'Останні', vehicle: 'ТЗ' });
    const css = html.slice(html.indexOf('/* ===== Ліве меню «Розрахунку рейсу»'), html.lastIndexOf('</style>'));
    assert.ok(css.includes('.tc-nav-name::before { content: attr(data-short)'));
    assert.ok(block(css, '.tc-nav-list.is-scroll-r {').includes('mask-image: linear-gradient'));
    assert.ok(block(css, '.tc-nav-list.is-scroll-l {').includes('mask-image: linear-gradient'));
    assert.ok(menuSrc.includes("btn.setAttribute('aria-label', sec.name)"));
    assert.ok(menuSrc.includes('function revealActive'));
});

test('заглушка карти: світла тема — поверхня з сіткою і текст у токенах, темна без змін', () => {
    const light = block(html, 'body[data-theme="light"] .tc-map-frame .lock-ph {');
    assert.ok(light.includes('var(--border-soft)') && light.includes('var(--surface)'));
    assert.ok(html.includes('body[data-theme="light"] .tc-map-frame .lock-ph b { color: var(--text); }'));
    assert.ok(html.includes('body[data-theme="light"] .tc-map-frame .lock-ph small { color: var(--muted); }'));
    // базове (темне) правило лишилось
    assert.ok(block(html, '.tc-map-frame .lock-ph {').includes('rgba(12,14,18,0.72)'));
});

test('index.html: меню підключене до розрахунку, не чіпає calculate()', () => {
    assert.ok(html.includes('actions: [clearBtn]') && html.includes('placeRouteBtn(routeBtn, routeHome)'));
    assert.match(html, /buildCalcMenu\(\);\n\s+updateOnePage\(\);/);
    assert.match(html, /op\.addEventListener\('input', calcMenuRefresh\)/);
    assert.match(html, /event\.target\.closest\('\.tc-rr'\)\) calcMenu\.select\('route'\)/);
    assert.match(html, /if \(!calcMenu\) openAccFor\(input\)/);
});

// ----- jsdom: справжня сторінка (?preview=1) -----
async function bootDom(presetSection, mobile, legacyMenu, errors) {
    let JSDOM;
    try { ({ JSDOM } = await import('jsdom')); } catch {
        try {
            const { createRequire } = await import('node:module');
            ({ JSDOM } = createRequire(process.env.JSDOM_PATH || import.meta.url)('jsdom'));
        } catch { return null; }
    }
    const dom = new JSDOM(html, {
        url: 'http://localhost/index.html?preview=1',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
            const deep = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : deep()), apply: () => deep() });
            w.supabase = { createClient: () => deep() };
            w.ResizeObserver = class { observe() {} };
            w.matchMedia = (q) => ({ matches: !!mobile && q.includes('max-width: 900px'), addEventListener() {}, addListener() {} });
            w.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
            runInNewContext(FAKE_CONFIG_JS, w);
            if (presetSection) w.localStorage.setItem('tc.calc.section', presetSection);
            // calc-menu.js підключається через <script src>, якого jsdom без resources не завантажить: підкладаємо готовий.
            runInNewContext(menuSrc, w);
            // Старий calc-menu.js із кешу (до #144): без bindHeight і roomHeight
            if (legacyMenu) { delete w.TCCalcMenu.bindHeight; delete w.TCCalcMenu.roomHeight; }
            if (errors) w.addEventListener('error', (e) => errors.push(String(e.message)));
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return dom;
}
const items = (d) => [...d.querySelectorAll('#tc-calc-nav .tc-nav-item')];
const current = (d) => d.querySelector('#tc-calc-nav [aria-current="page"]').getAttribute('data-key');
const openRows = (d) => [...d.querySelectorAll('#tc-op .tc-acc-row.is-open')].map((r) => r.getAttribute('data-acc'));

async function withMenu(t, fn, mobile) {
    const dom = await bootDom(undefined, mobile);
    if (!dom) { t.skip('no jsdom'); return; }
    try { await fn(dom.window, dom.window.document); } finally { dom.window.close(); }
}

test('jsdom: меню на місці, за замовчуванням «Маршрут», показано лише одну секцію, дії внизу меню', async (t) => {
    await withMenu(t, (w, d) => {
        assert.ok(d.body.classList.contains('tc-lm'));
        assert.equal(d.getElementById('tc-calc-nav').parentNode.id, 'studio-columns');
        assert.deepEqual(items(d).map((b) => b.getAttribute('data-key')), ['route', 'fuel', 'extras', 'costs', 'recent', 'vehicle']);
        assert.equal(current(d), 'route');
        assert.deepEqual(openRows(d), ['route']);
        assert.equal(d.getElementById('tc-sec-title').textContent, 'Маршрут');
        assert.equal(d.querySelector('#tc-calc-nav #route-calc-btn'), null, '≥901px кнопки розрахунку в меню немає');
        assert.ok(d.querySelector('#tc-calc-nav .tc-nav-actions #tc-clear'));
        assert.ok(d.getElementById('dist').closest('#tc-acc-route'), 'поля лишились у своїх блоках');
    });
});

test('jsdom: клік по пункту показує секцію й зберігає її в tc.calc.section', async (t) => {
    await withMenu(t, (w, d) => {
        items(d)[1].click();
        assert.equal(current(d), 'fuel');
        assert.deepEqual(openRows(d), ['fuel']);
        assert.equal(d.getElementById('tc-sec-title').textContent, 'Пальне');
        assert.equal(w.localStorage.getItem('tc.calc.section'), 'fuel');
        assert.equal(d.querySelector('#tc-acc-body-fuel, #tc-acc-fuel .tc-acc-body').hidden, false);
        assert.equal(d.querySelector('#tc-acc-route .tc-acc-body').hidden, true);
        items(d)[5].click();
        assert.equal(w.localStorage.getItem('tc.calc.section'), 'vehicle');
        assert.ok(d.getElementById('vehicle-norm-row').closest('#tc-acc-vehicle'), 'вибір авто тепер у секції «ТЗ»');
    });
});

test('jsdom: збережена секція відновлюється при наступному відкритті', async (t) => {
    const dom = await bootDom('extras');
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const d = dom.window.document;
        assert.equal(current(d), 'extras');
        assert.deepEqual(openRows(d), ['extras']);
    } finally { dom.window.close(); }
});

test('jsdom: підсумки оновлюються наживо при зміні полів', async (t) => {
    await withMenu(t, (w, d) => {
        const sums = () => Object.fromEntries(items(d).map((b) => [b.getAttribute('data-key'), b.querySelector('.tc-nav-sum').textContent]));
        const dist = d.getElementById('dist');
        dist.value = '575';
        dist.dispatchEvent(new w.Event('input', { bubbles: true }));
        assert.match(sums().route, /575 км$/);
        const adblue = d.getElementById('adblue-consumption');
        adblue.value = '3.1';
        adblue.dispatchEvent(new w.Event('input', { bubbles: true }));
        assert.match(sums().fuel, /AdBlue 3,1 л\/100км/);
        assert.equal(sums().vehicle, 'Весь автопарк');
        assert.match(sums().recent, /^(\d+ збережені|Немає)$/);
        assert.equal(items(d)[0].querySelector('.tc-nav-tip small').textContent, sums().route, 'підказка рейки = підсумок');
    });
});

test('jsdom: червона крапка біля пункту з помилкою валідації', async (t) => {
    await withMenu(t, (w, d) => {
        const dot = (key) => !d.querySelector('#tc-calc-nav [data-key="' + key + '"] .tc-nav-dot').hidden;
        const load = d.getElementById('fuel-load');
        assert.equal(dot('fuel'), false);
        load.setAttribute('aria-invalid', 'true');
        w.eval("document.getElementById('tc-acc-fuel').classList.add('is-miss')");
        w.eval('calcMenuRefresh()');
        assert.equal(dot('fuel'), true);
        assert.ok(d.querySelector('#tc-calc-nav [data-key="fuel"]').classList.contains('has-error'));
        assert.equal(dot('route'), false);
        // Валідація не перемикає секцію сама: користувач лишається там, де був.
        assert.equal(current(d), 'route');
        w.eval("document.getElementById('tc-acc-fuel').classList.remove('is-miss')");
        load.removeAttribute('aria-invalid');
        w.eval('calcMenuRefresh()');
        assert.equal(dot('fuel'), false);
    });
});

test('jsdom: клік по рядку «Останніх маршрутів» підставляє маршрут і перемикає на «Маршрут»', async (t) => {
    await withMenu(t, (w, d) => {
        w.localStorage.setItem(w.eval('recentRoutesKey()') || 'tc:recent', '[]');
        w.eval("readRecentRoutes = function () { return [{ from: 'Умань', to: 'Ізмаїл', km: 640, at: 1 }]; }");
        w.eval('renderMergedRecent()');
        items(d)[4].click();
        assert.equal(current(d), 'recent');
        const row = d.querySelector('#tc-acc-body-recent .tc-rr');
        assert.ok(row, 'є рядок маршруту');
        row.click();
        assert.equal(current(d), 'route');
        assert.deepEqual(openRows(d), ['route']);
        assert.equal(d.getElementById('dist').value, '640');
        assert.equal(w.localStorage.getItem('tc.calc.section'), 'route');
    });
});

test('jsdom: ↑/↓/Home/End переносять фокус між пунктами, активний має aria-current', async (t) => {
    await withMenu(t, (w, d) => {
        const press = (key) => d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        const list = items(d);
        list[0].focus();
        press('ArrowDown');
        assert.equal(d.activeElement, list[1]);
        press('ArrowUp');
        press('ArrowUp');
        assert.equal(d.activeElement, list[5], 'по колу вгору');
        press('Home');
        assert.equal(d.activeElement, list[0]);
        press('End');
        assert.equal(d.activeElement, list[5]);
        assert.equal(list.filter((b) => b.hasAttribute('aria-current')).length, 1);
        assert.ok(list.every((b) => b.tagName === 'BUTTON' && b.type === 'button'));
        assert.equal(current(d), 'route', 'стрілки лише рухають фокус');
    });
});

test('кеш: src з новим ключем версії, bindHeight викликається лише якщо є функція, у try/catch', () => {
    assert.ok(html.includes('<script src="/assets/calc-menu.js?v=2026-11-12-2"></script>'));
    assert.equal(html.includes('calc-menu.js?v=2026-11-12"'), false);
    const at = html.indexOf("typeof window.TCCalcMenu.bindHeight === 'function'");
    assert.ok(at > -1);
    assert.ok(html.slice(at - 80, at).includes('try {') && html.slice(at, at + 220).includes('catch (e)'));
});

test('jsdom: старий calc-menu.js без bindHeight — без uncaught exception, меню монтується, onload доходить до кінця', async (t) => {
    const errors = [];
    const dom = await bootDom(undefined, false, true, errors);
    if (!dom) { t.skip('no jsdom'); return; }
    try {
        const d = dom.window.document;
        assert.equal(typeof dom.window.TCCalcMenu.bindHeight, 'undefined');
        assert.deepEqual(errors, [], 'жодного uncaught exception: ' + errors.join('; '));
        assert.ok(d.body.classList.contains('tc-lm'), 'меню змонтовано');
        assert.equal(d.querySelectorAll('#tc-calc-nav .tc-nav-item').length, 6);
        assert.ok(d.getElementById('studio-columns'), 'колонки створено');
        assert.equal(d.getElementById('tc-calc-nav').parentNode.id, 'studio-columns');
        assert.ok(d.documentElement.style.getPropertyValue('--lm-room') === '', 'без bindHeight висота лишається з CSS');
        assert.ok(d.body.getAttribute('data-theme'), 'restoreTheme з onload відпрацював (дійшло далі за buildOnePage)');
    } finally { dom.window.close(); }
});

test('jsdom: ≥901px «Розрахувати відстань» стоїть у секції «Маршрут» під «A ↔ B» і над статусом', async (t) => {
    await withMenu(t, (w, d) => {
        const calc = d.getElementById('route-calc-btn');
        assert.ok(calc.closest('#tc-acc-route'), 'у секції Маршрут');
        if (d.body.classList.contains('demo-mode')) {
            // демо: .tc-maps-box схований, кнопка — у блоці OpenStreetMap під рядком «A ↔ B»
            assert.equal(calc.parentNode.id, 'tc-osm-box');
            assert.ok(calc.previousElementSibling.querySelector('.preset-btn'));
            assert.ok(calc.nextElementSibling.classList.contains('tc-osm-note'));
        } else {
            assert.ok(calc.previousElementSibling.querySelector('#swap-ab-btn'), 'одразу під рядком «+ Проміжна зупинка / A ↔ B»');
            assert.equal(calc.nextElementSibling.id, 'osm-status');
        }
        assert.equal(calc.getAttribute('onclick'), 'calculateGoogleRoute()');
    });
});

test('jsdom: ≤900px «Розрахувати відстань» переїжджає в нижню панель перед «Очистити» (той самий елемент)', async (t) => {
    await withMenu(t, (w, d) => {
        const actions = d.querySelector('#tc-calc-nav .tc-nav-actions');
        assert.deepEqual(Array.from(actions.children).map((b) => b.id), ['route-calc-btn', 'tc-clear']);
        assert.equal(d.querySelectorAll('#route-calc-btn').length, 1, 'без дублю');
        assert.equal(d.getElementById('route-calc-btn').getAttribute('onclick'), 'calculateGoogleRoute()');
        assert.equal(d.querySelector('#tc-acc-route #route-calc-btn'), null);
    }, true);
});

test('CSS: кнопка в «Маршруті» — на всю ширину, 36px, акцент; рейка без іконки розрахунку; KPI-відступи 20/16/12', () => {
    const rule = block(html, 'body.layout-studio.tc-lm[data-theme] #tc-op #route-calc-btn {');
    assert.ok(rule.includes('width: 100%') && rule.includes('height: 36px') && rule.includes('var(--sidebar-accent)'));
    assert.equal(html.includes('#tc-calc-nav #route-calc-btn { --lm-btn-ico'), false);
    assert.ok(html.includes('#tc-kpi-bar { padding-inline: calc(var(--tc-pad) + 20px); }'));
    assert.ok(html.includes('#tc-kpi-bar { padding-inline: calc(var(--tc-pad) + 16px); }'));
    assert.ok(html.includes('#tc-kpi-bar { padding-inline: calc(var(--tc-pad) + 12px); }'));
});

test('jsdom: «Очистити» й «Розрахувати відстань» у меню працюють як раніше (ті самі id й обробники)', async (t) => {
    await withMenu(t, (w, d) => {
        const calc = d.getElementById('route-calc-btn');
        const clear = d.getElementById('tc-clear');
        assert.equal(calc.getAttribute('onclick'), 'calculateGoogleRoute()');
        assert.equal(clear.getAttribute('onclick'), 'clearCalcForm()');
        d.getElementById('dist').value = '300';
        clear.click();
        assert.equal(d.getElementById('dist').value, '');
        assert.equal(items(d)[0].querySelector('.tc-nav-sum').textContent, 'Не задано');
    });
});

// ----- бежеве меню у світлій темі, рівна висота колонок, Контроль+ -----
const themeTokens = (theme) => {
    const start = html.indexOf('[data-theme="' + theme + '"] {');
    return html.slice(start, html.indexOf('}', start));
};
const tokenOf = (block, name) => (block.match(new RegExp('--' + name + ': ([^;]+);')) || [])[1];
const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('меню: у світлій темі беж у палітрі сайту (темніший за картки), у темній — графіт; токени, не хекси в правилах', () => {
    const light = themeTokens('light');
    const dark = themeTokens('dark');
    const bg = tokenOf(light, 'bg');
    const surface = tokenOf(light, 'surface');
    const side = tokenOf(light, 'sidebar');
    assert.ok(lum(side) < lum(surface), 'меню трохи темніше за картки');
    assert.ok(lum(side) > 0.6, 'беж, а не графіт: ' + side);
    assert.ok(Math.abs(lum(side) - lum(bg)) < 0.1, 'у палітрі сайту: ' + side + ' ~ ' + bg);
    assert.equal(tokenOf(light, 'sidebar-active'), surface, 'активний пункт світліший за меню (колір картки)');
    assert.equal(tokenOf(light, 'sidebar-border'), tokenOf(light, 'border'), 'межа 1px у токені лінії теми');
    assert.ok(contrast(tokenOf(light, 'sidebar-text'), side) >= 7, 'темний текст');
    assert.ok(contrast(tokenOf(light, 'sidebar-muted'), side) >= 4.5, 'приглушені підсумки AA');
    assert.ok(contrast(tokenOf(light, 'sidebar-ink-accent'), tokenOf(light, 'sidebar-active')) >= 4.5, 'акцентний текст активного пункту AA');
    assert.ok(contrast(tokenOf(light, 'sidebar-on-accent'), tokenOf(light, 'sidebar-accent')) >= 4.5, 'текст на золотій кнопці AA');
    // темна тема лишилась графітовою
    assert.ok(lum(tokenOf(dark, 'sidebar')) < 0.05);
    assert.equal(tokenOf(dark, 'sidebar'), '#1C1F25');
    // правила меню беруть кольори з токенів
    const css = html.slice(html.indexOf('/* ===== Ліве меню «Розрахунку рейсу»'), html.lastIndexOf('</style>'));
    assert.ok(css.includes('color: var(--sidebar-ink-accent)'));
    assert.ok(css.includes('background: var(--sidebar-dot)'));
    assert.equal(/#24272C|#33373E/i.test(html), false, 'графіту в світлій темі більше немає');
});

test('висота: меню, панель і мапа — одна --lm-room (низ на одній лінії); у Контроль+ нижній відступ 16px, сторінка не додає відступів під колонками', () => {
    const css = html.slice(html.indexOf('/* ===== Ліве меню «Розрахунку рейсу»'), html.lastIndexOf('</style>'));
    const heights = css.match(/height: var\(--lm-room, var\(--lm-h\)\)/g) || [];
    assert.ok(heights.length >= 3, 'nav, панель, мапа: ' + heights.length);
    assert.ok(css.includes('--lm-h: calc(100vh - var(--lm-top) - 16px)'));
    assert.ok(html.includes('window.TCCalcMenu.bindHeight(window, document)'));
    assert.equal(html.includes('--lm-gap'), false);
    const kp = read('apps/kontrol-plus/src/kp-calc.css');
    assert.ok(/#studio-columns \{ padding-bottom: 0; \}/.test(kp) && kp.includes('#main-app { padding-bottom: 0 !important; }'));
    // KPI-смуга і рядок колонок — один спільний контейнер (однакові ширина, max-width і padding)
    const shared = block(html, 'body.layout-studio[data-studio-view="calc"] #tc-kpi-bar,');
    assert.ok(shared.includes('#studio-columns') && shared.includes('padding-inline: var(--tc-pad)') && shared.includes('max-width: 1840px'));
});

// ----- одна функція висоти колонок (сайт і Контроль+), container query для «Повернення» -----
test('roomHeight: вікно − верх рядка колонок − 16px, не менше 360; липкий верх береться, коли сторінку прокручено', () => {
    assert.equal(M.roomHeight(900, 220, 0), 664);
    assert.equal(M.roomHeight(900, 300, 0), 584, 'демо-банер опускає колонки — вони коротшають');
    assert.equal(M.roomHeight(900, 40, 120), 764, 'прокручено: верх = липкий верх');
    assert.equal(M.roomHeight(500, 300, 0), 360);
    assert.equal(M.roomHeight(900, 220, 0, 8), 672);
});

// Мінімальне оточення: вікно/документ із підміненою геометрією і ручним запуском ResizeObserver.
function fakeEnv({ kp, colsTop, width = 1440, height = 900 }) {
    const props = {};
    const els = {
        'studio-columns': { top: colsTop, getBoundingClientRect() { return { top: this.top }; } },
        'tc-calc-nav': {},
    };
    const observers = [];
    const win = {
        innerWidth: width, innerHeight: height, listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeEventListener() {},
        requestAnimationFrame(fn) { fn(); return 1; },
        getComputedStyle: () => ({ top: '0px' }),
        ResizeObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    };
    const doc = {
        documentElement: { dataset: kp ? { app: 'kp' } : {}, style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } } },
        body: {},
        getElementById: (id) => els[id] || null,
        querySelector: () => null,
    };
    return { win, doc, els, props, fire: () => observers.forEach((o) => o.cb()) };
}

for (const kp of [false, true]) {
    test('bindHeight (' + (kp ? 'Контроль+, data-app="kp"' : 'сайт') + '): --lm-room з верху колонок, без банера і з банером, перерахунок на resize і ResizeObserver', () => {
        const env = fakeEnv({ kp, colsTop: 220 });
        const h = M.bindHeight(env.win, env.doc);
        assert.equal(env.props['--lm-room'], '664px');
        env.els['studio-columns'].top = 300; // з'явився демо-банер
        env.fire();
        assert.equal(env.props['--lm-room'], '584px');
        env.els['studio-columns'].top = 220; // банер закрито
        env.win.listeners.resize.forEach((fn) => fn());
        assert.equal(env.props['--lm-room'], '664px');
        env.win.innerHeight = 800;
        env.win.listeners.resize.forEach((fn) => fn());
        assert.equal(env.props['--lm-room'], '564px');
        env.win.innerWidth = 700; // ≤900px: висоти з CSS
        assert.equal(h.measure(), null);
        assert.equal(env.props['--lm-room'], undefined);
    });
}

test('висота: у kp-режимі не залежить від IIFE сайту (він виходить при data-app="kp"), bindHeight викликається з buildCalcMenu', () => {
    assert.ok(html.includes("document.documentElement.getAttribute('data-app') === 'kp') return;"));
    assert.equal(html.includes("setProperty('--lm-room'"), false, 'IIFE не пише --lm-room: єдине місце — calc-menu.js');
    assert.ok(menuSrc.includes("root.style.setProperty('--lm-room'"));
});

test('container query: «Повернення» на всю ширину за шириною панелі, а не вікна', () => {
    assert.ok(html.includes('#studio-left { container: tcpanel / inline-size; }'));
    const at = html.indexOf('@container tcpanel (max-width: 480px)');
    assert.ok(at > -1);
    assert.ok(html.slice(at, at + 260).includes('.tc-f-return { grid-column: 1 / -1; }'));
    // за шириною вікна лишився лише запасний варіант без меню (контейнер там не діє)
    const win = html.indexOf('@media (min-width: 901px) and (max-width: 1365px)');
    assert.ok(win > -1 && html.slice(win, win + 220).includes('body.layout-studio:not(.tc-lm)'));
    assert.equal(html.split('@media (min-width: 901px) and (max-width: 1365px)').length, 2);
});
