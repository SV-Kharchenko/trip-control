// Каркас CRM Контроль+ (PR 1 з 5): бокове меню, верхня панель, смуга тріалу. Сайт (без data-app="kp") не змінюється.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCrmHash } from '../src/lib/route.js';
import { NAV_ITEMS } from '../src/bridge.js';
import {
    CABINET_TABS, SHELL_GROUPS, SHELL_ITEMS, SITE_BUTTONS, activeKey, counterText, countUnpaid, parseCount, parseSidebarPref, roleLabel, sidebarKey,
} from '../src/shell-menu.js';
import { SHELL_ICON_NAMES } from '../src/shell-icons.js';
import { isKpApp, mountShell } from '../src/shell.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const site = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const bridge = read('src/bridge.js');
const shell = read('src/shell.js');
const css = read('src/kp-shell.css');

test('меню: групи й пункти за макетом каркаса, лише наявні розділи', () => {
    assert.deepEqual(SHELL_GROUPS.slice(0, 3).map((g) => g.label), ['Робота', 'Документи', 'Компанія']);
    assert.deepEqual(SHELL_GROUPS[0].items.map((i) => i.label), ['Дашборд', 'Реєстр заявок', 'Заявки', 'Розрахунок']);
    assert.deepEqual(SHELL_GROUPS[1].items.map((i) => i.label), ['Договори', 'Рахунки', 'Акти', 'ТТН', 'Подорожні листи']);
    assert.deepEqual(SHELL_GROUPS[2].items.map((i) => i.label), ['Клієнти', 'Автопарк', 'Ремонти', 'Команда', 'Статистика', 'Налаштування']);
    // Розділи, що вже є в Контроль+, але не названі в макеті, не губляться.
    assert.deepEqual(SHELL_GROUPS[3].items.map((i) => i.label), ['Огляд', 'План/факт', 'Водії', 'GPS']);
    assert.equal(new Set(SHELL_ITEMS.map((i) => i.key)).size, SHELL_ITEMS.length, 'ключі унікальні');
    // Дашборд — заглушка «скоро»: нічого не відкриває.
    const dash = SHELL_ITEMS.find((i) => i.key === 'dashboard');
    assert.equal(dash.kind, 'soon');
    assert.match(shell, /if \(item\.kind === 'soon'\) return;/);
    // Лічильники: «Реєстр заявок» і «Рахунки» (неоплачені).
    assert.deepEqual(SHELL_ITEMS.filter((i) => i.counter).map((i) => [i.key, i.counter]), [['registry', 'registry'], ['invoices', 'unpaid']]);
    for (const item of SHELL_ITEMS) assert.ok(SHELL_ICON_NAMES.includes(item.icon), 'іконка для ' + item.key);
});

test('кожен пункт веде на наявний розділ через наявні перемикачі', () => {
    const navKeys = NAV_ITEMS.map((n) => n[0]);
    const cabinetIds = /const CABINET_TAB_IDS = \[([^\]]+)\]/.exec(site)[1];
    for (const item of SHELL_ITEMS) {
        if (item.access) assert.ok(navKeys.includes(item.access), item.key + ': доступ рахує наявна кнопка #kp-nav-' + item.access);
        if (item.kind === 'hash') {
            const route = parseCrmHash(item.hash);
            assert.ok(route, item.key + ': hash ' + item.hash + ' є маршрутом Контроль+');
            const view = route.view;
            assert.ok(['docs', 'clients', 'fleet', 'repairs', 'report', 'drivers', 'gps'].includes(view), item.key + ': розділ ' + view);
            assert.ok(bridge.includes("route.view === '" + view + "'") || view === 'clients' || view === 'docs' || view === 'report', item.key + ' малює bridge.js');
        } else if (item.kind === 'site') {
            const id = SITE_BUTTONS[item.site];
            assert.ok(id, item.key + ': кнопка перемикача');
            assert.ok(bridge.includes("id: '" + id + "'") || navKeys.includes(id.replace('kp-nav-', '')), id + ' є в bridge.js');
            assert.ok(site.includes("view === '" + item.site + "'") || item.site === 'calc', 'setStudioView знає ' + item.site);
        } else if (item.kind === 'cabinet') {
            if (item.tab) {
                assert.ok(cabinetIds.includes("'" + item.tab + "'"), item.key + ': вкладка кабінету ' + item.tab);
                assert.equal(CABINET_TABS[item.tab], item.tab);
            }
        }
    }
    for (const fn of ['openCabinetTab', 'openCabinet', 'closeCabinet', 'setStudioView']) assert.ok(site.includes('function ' + fn + '('), fn + ' є на сайті');
    // Документи: п'ять вкладок наявного розділу «Документи».
    assert.deepEqual(SHELL_GROUPS[1].items.map((i) => parseCrmHash(i.hash).tab), ['contracts', 'invoices', 'acts', 'ttn', 'trip_sheets']);
    assert.match(shell, /site\('openCabinetTab', item\.tab\)/);
    assert.match(shell, /target\.click\(\)/);
});

test('підсвітка активного пункту: hash-маршрути, розділи сайту, кабінет', () => {
    const at = (over) => activeKey({ hash: '', studioView: 'calc', cabinetOpen: false, cabinetTab: null, ...over });
    assert.equal(at({}), 'calc');
    assert.equal(at({ studioView: 'history' }), 'history');
    assert.equal(at({ studioView: 'registry' }), 'registry');
    assert.equal(at({ studioView: 'overview' }), 'overview');
    assert.equal(at({ hash: '#/docs/tab/contracts' }), 'contracts');
    assert.equal(at({ hash: '#/docs/tab/invoices' }), 'invoices');
    assert.equal(at({ hash: '#/docs/tab/trip_sheets' }), 'trip_sheets');
    assert.equal(at({ hash: '#/docs/tab/other' }), null);
    assert.equal(at({ hash: '#/docs' }), null);
    assert.equal(at({ hash: '#/docs/new/act/calc/11111111-1111-1111-1111-111111111111' }), 'acts');
    assert.equal(at({ hash: '#/docs/ttn/11111111-1111-1111-1111-111111111111' }), 'ttn');
    for (const view of ['fleet', 'repairs', 'gps', 'drivers']) assert.equal(at({ hash: '#/' + view }), view);
    assert.equal(at({ hash: '#/report/debts' }), 'report');
    assert.equal(at({ hash: '#/clients/new' }), 'clients');
    assert.equal(at({ hash: '#/clients', studioView: 'history' }), 'clients', 'hash-розділ має пріоритет над видом сайту');
    assert.equal(at({ cabinetOpen: true, cabinetTab: 'team' }), 'team');
    assert.equal(at({ cabinetOpen: true, cabinetTab: 'stats', hash: '#/clients' }), 'stats');
    assert.equal(at({ cabinetOpen: true, cabinetTab: 'company' }), 'settings');
    assert.equal(at({ hash: '#/cabinet/team' }), 'calc', '#/cabinet/* не маршрут Контроль+: його відкриває сайт');
});

test('верхня панель: роль «Директор» для owner і директора КП, «Логіст» для логіста; лічильники; стан меню', () => {
    assert.equal(roleLabel('owner'), 'Директор');
    assert.equal(roleLabel('director'), 'Директор');
    assert.equal(roleLabel('logist'), 'Логіст');
    assert.equal(roleLabel(null, 'Директор'), 'Директор');
    assert.equal(roleLabel(undefined), '');
    assert.equal(parseCount('12 заявок'), 12);
    assert.equal(parseCount('1 204'), 1204);
    assert.equal(parseCount(''), null);
    assert.equal(counterText(0), '');
    assert.equal(counterText(7), '7');
    assert.equal(counterText(150), '99+');
    assert.equal(countUnpaid([
        { kind: 'invoice', status: 'issued', debt: '100' }, { kind: 'invoice', status: 'issued', debt: '0' },
        { kind: 'invoice', status: 'cancelled', debt: '50' }, { kind: 'act', status: 'issued', debt: '10' }, { kind: 'invoice', status: 'issued', debt: 3 },
    ]), 2);
    assert.equal(sidebarKey('u1'), 'tc_kp_sidebar:u1');
    assert.equal(parseSidebarPref('collapsed'), 'collapsed');
    assert.equal(parseSidebarPref(null), 'expanded');
    assert.equal(parseSidebarPref('x'), 'expanded');
    // Перемикач компанії: у коді немає вибору кількох компаній для директора КП (kp_context віддає одну) — показуємо назву компанії.
    assert.match(shell, /companyEl = h\('span', \{ class: 'kp-shell-company'/);
    assert.match(shell, /win\.tcKpOrgName \|\| text\('tc-menu-company'\)/);
    assert.match(shell, /openCabinetTab', 'notifications'/, 'дзвіночок веде на наявні сповіщення');
    assert.match(shell, /String\(event\.key\)\.toLowerCase\(\) === 'k'/, 'Ctrl+K');
    for (const sel of ['#registry-q', '#history-search', '#kp-crm input[type="search"]']) assert.ok(shell.includes(sel), 'пошук розділу ' + sel);
});

test('сайт без data-app="kp": каркас нічого не монтує й не торкається DOM; старі вкладки сайту на місці', () => {
    const touched = [];
    const poison = new Proxy({}, { get(_, name) { touched.push(String(name)); return undefined; } });
    const siteDoc = { documentElement: { dataset: {} }, get body() { touched.push('body'); return null; }, getElementById() { touched.push('getElementById'); return null; }, querySelector() { touched.push('qs'); return null; } };
    assert.equal(isKpApp(siteDoc), false);
    assert.equal(mountShell({ document: siteDoc, window: poison }), null);
    assert.deepEqual(touched, [], 'DOM сайту не чіпаємо');
    assert.equal(isKpApp({ documentElement: { dataset: { app: 'kp' } } }), true);
    // Розмітка сайту: жодного сліду каркаса, старі вкладки є.
    assert.equal(/kp-shell|kp-nav-on/.test(site), false, 'index.html сайту без каркаса');
    for (const id of ['studio-nav-calc', 'studio-nav-overview', 'studio-nav-history', 'studio-nav-registry']) assert.ok(site.includes('id="' + id + '"'), id);
    assert.ok(site.includes('class="tc-studio-nav"'));
    // Сайт каркас не підключає: стилі й модуль тільки в застосунку Контроль+.
    assert.equal(site.includes('kp-shell.css'), false);
    assert.match(read('src/site-bridge.js'), /import '\.\/kp-shell\.css';/);
    assert.match(bridge, /mountShell\(\{ supabase: state\.supabase \}\);/);
});

test('стилі: лише для data-app="kp" / .kp-shell-*, старі вкладки ховаються (код лишається), мобільний бургер, згортання, смуга тріалу', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter((s) => s && !s.startsWith('@'));
    for (const selectorList of rules) {
        for (const sel of selectorList.split(',').map((s) => s.trim()).filter(Boolean)) {
            assert.ok(/^(html\[data-app="kp"\]|body\.kp-shell-|\.kp-shell-)/.test(sel), 'правило без області КП: ' + sel);
        }
    }
    // Старі горизонтальні вкладки й старе меню лишаються в DOM, але приховані.
    for (const old of ['#kp-side', '#kp-calc-tabs', '.tc-studio-nav', '#sticky-top .tc-topbar']) assert.ok(css.includes(old), old);
    assert.match(css, /display: none !important;/);
    assert.match(css, /--kp-side-w: 232px;/);
    assert.match(css, /--kp-side-w: 64px;/);
    assert.match(css, /--kp-top-h: 52px;/);
    assert.match(css, /--kp-strip-h: 30px;/);
    assert.match(css, /--kp-side-bg: #0D2A29;/);
    assert.match(css, /--kp-side-gold: #B08A4C;/);
    assert.match(css, /Manrope/);
    assert.match(css, /JetBrains Mono/);
    assert.match(css, /@media \(max-width: 899px\)/);
    assert.match(css, /\.kp-shell-burger \{ display: inline-flex; \}/);
    assert.match(css, /\[data-theme="dark"\] \{ --kp-side-bg: #0A1717; --kp-side-gold: #E0B25A; \}/, 'темна тема КП не ламається');
    // Нижньої навігації в цьому PR немає.
    assert.equal(/bottom-nav|kp-shell-tabbar/.test(css + shell), false);
});

test('shell.js: наявні вузли сайту переїжджають без змін, логіка тріалу не міняється, стан меню в localStorage', () => {
    assert.match(shell, /doc\.querySelector\('\.tc-head-end'\)/);
    assert.match(shell, /strip\.append\(banner\)/);
    assert.match(shell, /\$\('billing-banner'\)/);
    assert.match(shell, /body\.classList\.add\('kp-shell-on'\)/);
    assert.match(shell, /body\.classList\.remove\('kp-nav-on'\)/);
    assert.match(shell, /store\.set\(sidebarKey\(userId\)/);
    assert.match(shell, /kp_doc_list/);
    // Банер тріалу #111 не змінено: сайтові функції syncBillingBanner / syncTrialBanner у index.html на місці й shell їх не чіпає.
    assert.ok(site.includes('function syncTrialBanner(banner)') && site.includes('function syncBillingBanner()'));
    assert.equal(/syncTrialBanner|syncBillingBanner|billingTrial|trial_ends_at/.test(shell), false);
    // Без міграцій і нових Vercel-функцій.
    assert.equal(/\.rpc\('(?!kp_doc_list)/.test(shell), false, 'shell кличе лише наявну kp_doc_list');
});
