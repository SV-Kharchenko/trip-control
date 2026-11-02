// Сайт trip-control.com ховає те, що має сенс лише в Контроль+: мітка data-app="kp" ставиться збіркою Контроль+, а не JS після запуску.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const { injectSite, stripInjected } = await import('../apps/kontrol-plus/scripts/site-html.mjs');

function fnSource(name, isAsync) {
    const start = html.indexOf((isAsync ? 'async ' : '') + 'function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}
const context = (app, extra = {}) => vm.createContext({ document: { documentElement: { dataset: app ? { app } : {} } }, ...extra });

test('мітка: збірка Контроль+ має data-app="kp" на <html> одразу в HTML, кореневий index.html — ні; зворотна операція дає оригінал', () => {
    assert.match(html, /^<!DOCTYPE html>\n<html lang="uk">/);
    const built = injectSite(html, { js: '/kp-assets/site-bridge.js', css: ['/kp-assets/site-bridge.css'] });
    assert.match(built, /^<!DOCTYPE html>\n<html lang="uk" data-app="kp">/);
    assert.equal((built.match(/<html /g) || []).length, 1);
    assert.equal(stripInjected(built), html, 'вставки прибираються байт у байт');
    assert.equal(readFileSync(new URL('../apps/kontrol-plus/scripts/site-html.mjs', import.meta.url), 'utf8').includes('data-app'), true);
});

test('isKP() читає data-app з <html>', () => {
    const src = fnSource('isKP');
    assert.equal(vm.runInContext(src + '; isKP()', context('kp')), true);
    assert.equal(vm.runInContext(src + '; isKP()', context(null)), false);
    assert.equal(html.includes('.kp-only'), false, 'невикористаний клас прибрано');
});

test('вкладки кабінету: «Реквізити» і «Статистика» створюються лише в Контроль+, «Автопарк» і «Профіль» — завжди', () => {
    const at = html.indexOf("{ id: 'company', title: 'Профіль' }");
    const block = html.slice(at, at + 1500);
    assert.ok(block.includes("if (isKP()) tabs.splice(1, 0, { id: 'requisites', title: 'Реквізити' });"));
    assert.ok(block.includes("if (isOwner && isKP()) tabs.push({ id: 'stats', title: 'Статистика' });"));
    assert.ok(block.includes("if (isOwner) tabs.push({ id: 'docs', title: 'Автопарк' });"));
    assert.equal(block.includes("{ id: 'requisites', title: 'Реквізити' }\n"), false, 'у базовому списку немає «Реквізитів»');
    assert.ok(html.includes("if (isKP()) html += '<div class=\"cab-panel\" data-panel=\"requisites\">"), 'панель «Реквізити» лише в Контроль+');
    assert.ok(html.includes("html += (isKP() ? '<div class=\"cab-panel\" data-panel=\"stats\">"), 'панель «Статистика» лише в Контроль+');
});

test('маршрути #/company, #/docs/requisites, #/stats і #/cabinet/requisites: на сайті ведуть на «Профіль», у Контроль+ — як раніше', () => {
    const src = ['isKP', 'cabinetTabFromLocation'].map((n) => fnSource(n)).join('\n');
    const consts = html.slice(html.indexOf('const CABINET_REDIRECTS = {'), html.indexOf('function cabinetTabFromLocation'));
    const tab = (app, hash) => vm.runInContext(consts + src + '; cabinetTabFromLocation()', context(app, { location: { hash } }));
    for (const hash of ['#/company', '#/docs/requisites', '#/stats', '#/cabinet/requisites', '#/cabinet/stats']) {
        assert.equal(tab(null, hash), 'company', 'сайт ' + hash);
    }
    assert.equal(tab('kp', '#/company'), 'requisites');
    assert.equal(tab('kp', '#/docs/requisites'), 'requisites');
    assert.equal(tab('kp', '#/stats'), 'stats');
    assert.equal(tab('kp', '#/cabinet/requisites'), 'requisites');
    assert.equal(tab(null, '#/team'), 'team', 'інші адреси не змінюються');
    assert.equal(tab(null, '#/notifications'), 'notifications');
    assert.match(fnSource('openCabinetTab'), /if \(!isKP\(\) && \(id === 'requisites' \|\| id === 'stats'\)\) id = 'company';/);
});

test('кнопки документів заявки: на сайті calcDocButtons порожня і kp_ttn_list не викликається; у Контроль+ кнопки на місці', () => {
    const src = fnSource('isKP') + ' ' + fnSource('calcDocButtons');
    const run = (app) => vm.runInContext(src + "; calcDocButtons({ id: 'abc' })", context(app, {
        historyFields: () => ({ status: 'accepted' }), currentOrgRole: 'owner', escHtml: (v) => String(v),
    }));
    assert.equal(run(null), '', 'сайт');
    const kp = run('kp');
    for (const text of ['Створити ТТН', 'Створити акт', 'Створити рахунок', 'Створити подорожній лист', 'Документи заявки']) assert.ok(kp.includes(text), text);
    // kp_ttn_list викликає лише showCalcDocs, який відкривається тільки кнопкою «Документи заявки».
    const callers = [...html.matchAll(/showCalcDocs\(/g)].length;
    assert.equal(callers, 2, 'оголошення + кнопка в calcDocButtons');
});

test('«Команда»: на сайті лише «Редагувати Автопарк»; усі п’ять прав — у Контроль+; значення в БД не чіпаються', () => {
    assert.ok(html.includes("MEMBER_PERMISSION_LABELS.filter(function (item) { return isKP() || item[0] === 'fleet'; }).map("));
    assert.ok(html.includes("['acts', 'Створювати акти'], ['sign', 'Підпис і печатка'], ['fleet', 'Редагувати Автопарк']"));
    assert.equal(/can_acts\s*=|set_permissions[^\n]*isKP/.test(html), false, 'збереження прав не залежить від мітки');
});

test('«Сповіщення»: на сайті опис без підпису й печатки, а сповіщення документів — без посилання', () => {
    assert.ok(html.includes("'<p class=\"cab-note\">Заявки, що чекають погодження' + (isKP() ? ', і кожне використання підпису та печатки логістом' : '') + '.</p>'"));
    const noteHref = fnSource('isKP') + ' ' + fnSource('noteHref');
    const run = (app, note) => vm.runInContext(noteHref + '; noteHref(' + JSON.stringify(note) + ')', context(app));
    for (const note of [{ ref_kind: 'document', ref_id: 'd1' }, { ref_kind: 'ttn', ref_id: 't1' }, { ref_kind: 'contract', ref_id: 'c1', meta: { client_id: 'k1' } }]) {
        assert.equal(run(null, note), '', 'сайт ' + note.ref_kind);
        assert.notEqual(run('kp', note), '', 'Контроль+ ' + note.ref_kind);
    }
});

test('мертві теми Night / Amber / Ocean / Paper видалено; :root лишився; мапування старих tc_theme на light збережено', () => {
    assert.equal(html.includes('[data-theme="amber"] {'), false);
    assert.equal(html.includes('[data-theme="night"] {'), false);
    assert.equal(html.includes(':root, [data-theme="night"]'), false);
    assert.match(html, /\n        :root \{\n            --bg-color: #0b111b;/, ':root і його змінні на місці');
    assert.equal(/Night \/ Amber/.test(html), false, 'коментар оновлено');
    const normalize = fnSource('normalizeTheme');
    const theme = (t) => vm.runInContext(normalize + "; const THEME_ORDER = ['light', 'dark']; normalizeTheme(" + JSON.stringify(t) + ')', vm.createContext({}));
    for (const old of ['ocean', 'paper', 'night', 'amber']) assert.equal(theme(old), 'light', old);
    assert.equal(theme('control'), 'dark');
    assert.equal(theme('dark'), 'dark');
    assert.equal(theme('light'), 'light');
    assert.equal(theme('anything'), 'light');
});

// ---- Сповіщення: на сайті сховані тільки при показі й у бейджі ----
const NOTES = [
    { id: 'n1', kind: 'approval_pending', ref_kind: 'calculation', read_at: null },
    { id: 'n2', kind: 'signature_used', ref_kind: 'document', read_at: null },
    { id: 'n3', kind: 'doc_emailed', ref_kind: 'document', read_at: null },
    { id: 'n4', kind: 'doc_emailed', ref_kind: 'contract', read_at: null },
    { id: 'n5', kind: 'signature_used', ref_kind: 'ttn', read_at: null },
    { id: 'n6', kind: 'approval_pending', ref_kind: 'calculation', read_at: '2026-11-01T10:00:00Z' },
];
function notesWorld(app) {
    const calls = [];
    const ctx = context(app, {
        currentOrgRole: 'owner', currentUserId: 'u1', calls,
        teamApi: async (_method, body) => { calls.push(body); return { items: NOTES, unread: 5 }; },
        paintUnread() {}, renderNotifications() {}, showToast() {},
    });
    vm.runInContext(['isKP', 'noteKpOnly', 'visibleNotes'].map((n) => fnSource(n)).join('\n')
        + '\n' + ['refreshUnreadNotifications', 'markAllNotesRead'].map((n) => fnSource(n, true)).join('\n')
        + "\nlet notesState = { items: [], unread: 0, loaded: false };", ctx);
    return ctx;
}

test('сповіщення на сайті: підпис і печатка, документи, договори й ТТН не показуються і не входять у бейдж', async () => {
    const site = notesWorld(null);
    await vm.runInContext('refreshUnreadNotifications()', site);
    const state = JSON.parse(vm.runInContext('JSON.stringify(notesState)', site));
    assert.deepEqual(state.items.map((n) => n.id), ['n1', 'n6'], 'лишились лише заявки');
    assert.equal(state.unread, 1, 'бейдж рахує тільки показані непрочитані (сервер казав 5)');
    for (const kind of ['signature_used', 'doc_emailed']) assert.equal(state.items.some((n) => n.kind === kind), false, kind);
    for (const ref of ['document', 'contract', 'ttn']) assert.equal(state.items.some((n) => n.ref_kind === ref), false, ref);
});

test('сповіщення в Контроль+: усе показується, бейдж — серверний лічильник', async () => {
    const kp = notesWorld('kp');
    await vm.runInContext('refreshUnreadNotifications()', kp);
    const state = JSON.parse(vm.runInContext('JSON.stringify(notesState)', kp));
    assert.equal(state.items.length, NOTES.length);
    assert.equal(state.unread, 5);
});

test('«Прочитати все»: на сайті позначає лише показані непрочитані (сховані не чіпає), у Контроль+ — як раніше', async () => {
    const site = notesWorld(null);
    await vm.runInContext('refreshUnreadNotifications()', site);
    site.calls.length = 0;
    await vm.runInContext('markAllNotesRead()', site);
    const sent = site.calls.find((c) => c.action === 'notifications_read');
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), { action: 'notifications_read', ids: ['n1'] });
    assert.equal(site.calls.some((c) => c.all === true), false, 'без all:true — сховані лишаються непрочитаними');
    const kp = notesWorld('kp');
    await vm.runInContext('refreshUnreadNotifications()', kp);
    kp.calls.length = 0;
    await vm.runInContext('markAllNotesRead()', kp);
    assert.deepEqual(JSON.parse(JSON.stringify(kp.calls.find((c) => c.action === 'notifications_read'))), { action: 'notifications_read', all: true });
    // Нічого в базі не видаляється: фільтр лише в refresh / render, серверних викликів видалення немає.
    assert.equal(/notifications_(delete|remove)/.test(html), false);
});

test('дрібниці: !isKP() — перший рядок calcDocButtons; мертве правило dispatcher-result night/amber і --rc-* прибрано', () => {
    assert.match(fnSource('calcDocButtons'), /^function calcDocButtons\(row\) \{\n\s*if \(!isKP\(\)\) return '';/);
    assert.equal(/\[data-theme="(night|amber)"\] #dispatcher-result/.test(html), false);
    assert.equal(/--rc-(fg|muted|up|down|be)/.test(html), false);
});
