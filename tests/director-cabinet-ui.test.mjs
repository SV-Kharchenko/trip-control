import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}

// buildCabinet() у sandbox: повертає html, який кабінет записав у #cabinet-fields.
function buildFor({ role, mode }) {
    const box = { innerHTML: '', dataset: {} };
    const context = vm.createContext({
        document: { getElementById: (id) => (id === 'cabinet-fields' ? box : { addEventListener() {}, style: {}, value: '' }), querySelector: () => null, querySelectorAll: () => [] },
        currentOrgRole: role,
        currentWorkMode: mode,
        COMPANY_PROFILE_FIELDS: ['coEdrpou', 'coCountry', 'coCity', 'coAddress', 'coPhone', 'coWebsite', 'coReportEmail', 'coOwnership', 'coZip', 'coTimezone', 'coLang']
            .map((key) => ({ key, label: key })),
        window: {},
    });
    vm.runInContext(fnSource('buildCabinet'), context);
    vm.runInContext('buildCabinet()', context);
    return box.innerHTML;
}
const tabsOf = (markup) => [...markup.matchAll(/class="cab-tab[^"]*"[^>]*data-tab="([a-z]+)"/g)].map((m) => m[1]);
const panelsOf = (markup) => [...markup.matchAll(/class="cab-panel[^"]*" data-panel="([a-z]+)"/g)].map((m) => m[1]);

test('one cabinet: the owner of a team gets Profile, Requisites, Notifications, Team, Statistics (+ Fleet) in that order', () => {
    const markup = buildFor({ role: 'owner', mode: 'team' });
    assert.deepEqual(tabsOf(markup), ['company', 'requisites', 'notifications', 'team', 'stats', 'docs']);
    assert.deepEqual(panelsOf(markup).sort(), ['company', 'docs', 'notifications', 'requisites', 'stats', 'team']);
    assert.match(markup, />Профіль</);
    assert.match(markup, />Реквізити</);
    assert.equal(markup.includes('>Компанія<'), false, 'the old "Компанія" tab is the Profile now');
    assert.match(markup, /id="cab-tab-unread"/, 'the unread counter sits on the Notifications tab');
    assert.match(markup, /id="cab-req-slot"/);
    assert.match(markup, /id="cab-stats-slot"/);
});

test('a solo owner has no Team tab; the invitation block stays in the Profile', () => {
    const markup = buildFor({ role: 'owner', mode: 'solo' });
    assert.deepEqual(tabsOf(markup), ['company', 'requisites', 'notifications', 'stats', 'docs']);
    assert.match(markup, /enableTeamAndInvite\(\)/);
});

test('a logist sees only Profile and Requisites (read-only): no Notifications, Team, Statistics or Fleet', () => {
    const markup = buildFor({ role: 'logist', mode: 'team' });
    assert.deepEqual(tabsOf(markup), ['company', 'requisites']);
    assert.deepEqual(panelsOf(markup).sort(), ['company', 'requisites']);
    assert.match(markup, /Лише перегляд/);
    for (const hidden of ['cab-notes-list', 'cab-stats-slot', 'team-members-list', 'team-invite-btn', 'cab-tab-unread']) {
        assert.equal(markup.includes(hidden), false, hidden);
    }
});

function redirectContext({ userId = 'u1', hash = '', search = '' } = {}) {
    const calls = [];
    const location = { hash, search, pathname: '/' };
    const context = vm.createContext({
        location,
        history: { replaceState: (_s, _t, url) => { location.hash = url.slice(url.indexOf('#')); calls.push('url:' + url); } },
        currentUserId: userId,
        openCabinetTab: (tab) => calls.push('open:' + tab),
        document: { querySelector: () => ({ getAttribute: () => lastTab.value }) },
        window: { addEventListener() {} },
    });
    const lastTab = { value: 'company' };
    context.lastTab = lastTab;
    vm.runInContext([
        'const CABINET_REDIRECTS = ' + html.match(/const CABINET_REDIRECTS = (\{[\s\S]*?\});/)[1] + ';',
        'const CABINET_TAB_IDS = ' + html.match(/const CABINET_TAB_IDS = (\[[^\]]*\]);/)[1] + ';',
        ...['cabinetTabFromLocation', 'openCabinetFromLocation'].map(fnSource),
    ].join('\n'), context);
    return { context, calls, location, lastTab };
}

test('old URLs redirect into the cabinet: #/company and #/docs/requisites → Requisites, #/team → Team, #/stats → Statistics', () => {
    const cases = [['#/company', 'requisites'], ['#/docs/requisites', 'requisites'], ['#/team', 'team'], ['#/stats', 'stats'],
        ['#/notifications', 'notifications'], ['#/cabinet', 'company'], ['#/cabinet/requisites', 'requisites'], ['#/cabinet/stats', 'stats'], ['#/cabinet/nonsense', 'company']];
    for (const [hash, tab] of cases) {
        const ctx = redirectContext({ hash });
        ctx.lastTab.value = tab;
        assert.equal(vm.runInContext('cabinetTabFromLocation()', ctx.context), tab, hash);
        assert.equal(vm.runInContext('openCabinetFromLocation()', ctx.context), true, hash);
        assert.deepEqual(ctx.calls, ['open:' + tab, 'url:/#/cabinet/' + tab], hash + ' opens the tab and rewrites the URL');
    }
});

test('other hashes (calculator, Контроль+ sections) and a signed-out visitor are left alone', () => {
    for (const hash of ['', '#calculator', '#/clients', '#/docs', '#/fleet', '#/report', '#/companyx']) {
        const ctx = redirectContext({ hash });
        assert.equal(vm.runInContext('openCabinetFromLocation()', ctx.context), false, hash || '(empty)');
        assert.deepEqual(ctx.calls, []);
    }
    const guest = redirectContext({ hash: '#/company', userId: null });
    assert.equal(vm.runInContext('openCabinetFromLocation()', guest.context), false);
    assert.deepEqual(guest.calls, []);
});

test('a tab the role does not have falls back to Profile; only Profile shows Save / Cancel', () => {
    const fn = fnSource('switchCabTab');
    assert.match(fn, /cab-tab\[data-tab="' \+ id \+ '"\]'\)\) id = 'company'/);
    assert.match(fn, /actions\.style\.display = id === 'company' \? '' : 'none'/);
    assert.match(fn, /new CustomEvent\('tc:cabinet-tab', \{ detail: \{ tab: id \} \}\)/);
});

test('the user menu has one cabinet entry with the unread counter; Company and Team entries are gone', () => {
    const menu = html.slice(html.indexOf('id="tc-user-menu"'), html.indexOf('id="tc-menu-install"'));
    assert.match(menu, /menuGo\('cabinet'\)"><span>Особистий кабінет<\/span><span class="tc-menu-badge" id="tc-menu-unread"/);
    for (const gone of ["menuGo('company')", "menuGo('team')", 'Компанія і реквізити', 'id="tc-menu-team"', 'tc-menu-seats']) {
        assert.equal(menu.includes(gone), false, gone);
    }
    const go = fnSource('menuGo');
    assert.match(go, /action === 'company'\) openCabinetTab\('requisites'\)/);
    assert.match(go, /action === 'team'\) openCabinetTab\('team'\)/);
    assert.match(go, /action === 'stats'\) openCabinetTab\('stats'\)/);
});

test('team rights: five switches per logist, written only through the API; the owner has none to toggle', () => {
    const labels = html.match(/const MEMBER_PERMISSION_LABELS = (\[[\s\S]*?\]\s*\]);/)[1];
    for (const word of ['Створювати акти', 'Підпис і печатка', 'Редагувати Автопарк', 'Додавати клієнтів', 'Договори']) assert.ok(labels.includes(word), word);
    for (const key of ["'acts'", "'sign'", "'fleet'", "'clients'", "'contracts'"]) assert.ok(labels.includes(key), key);
    const panel = fnSource('renderTeamPanel');
    assert.match(panel, /canManage && member\.org_role === 'logist' && member\.permissions/);
    assert.match(panel, /setMemberPermission\(/);
    const set = fnSource('setMemberPermission');
    assert.match(set, /action: 'set_permissions'/);
    assert.match(set, /input\.checked = !wanted/, 'a refused change is rolled back in the UI');
    assert.equal(/supabaseClient/.test(set), false, 'rights are not written from the client');
});

function notesContext(items, role = 'owner') {
    const els = {
        'cab-notes-list': { innerHTML: '' },
        'cab-notes-all': { disabled: false },
    };
    const context = vm.createContext({
        notesState: { items, unread: items.filter((n) => !n.read_at).length, loaded: true },
        document: { getElementById: (id) => els[id] || null },
        teamEsc: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
        currentOrgRole: role,
    });
    vm.runInContext([
        'const NOTE_KIND_TEXT = ' + html.match(/const NOTE_KIND_TEXT = (\{[\s\S]*?\n    \});/)[1] + ';',
        ...['noteHref', 'renderNotifications'].map(fnSource),
    ].join('\n'), context);
    return { context, els };
}

test('notifications list: who, when, link to the request or the document, unread marker', () => {
    const items = [
        { id: 'n2', kind: 'signature_used', ref_kind: 'document', ref_id: 'doc-1', actor_email: 'logist@x.test', meta: { doc_kind: 'act', number: 5, prefix: 'АКТ-' }, created_at: '2026-10-28T11:00:00Z', read_at: null },
        { id: 'n1', kind: 'approval_pending', ref_kind: 'calculation', ref_id: 'calc-1', actor_email: 'logist@x.test', meta: { name: 'Київ — Львів' }, created_at: '2026-10-28T10:00:00Z', read_at: '2026-10-28T12:00:00Z' },
    ];
    const { context, els } = notesContext(items);
    vm.runInContext('renderNotifications()', context);
    const out = els['cab-notes-list'].innerHTML;
    assert.match(out, /Використано підпис і печатку: акт АКТ-5/);
    assert.match(out, /Логіст: logist@x\.test/);
    assert.match(out, /href="#\/docs\/doc-1"/, 'the document link');
    assert.match(out, /Заявка чекає погодження: «Київ — Львів»/);
    assert.match(out, /openNotification\('n1'\)">Відкрити заявку/, 'the request opens in the approval review');
    assert.match(out, /markNoteRead\('n2'\)/, 'an unread note can be marked');
    assert.equal(out.includes("markNoteRead('n1')"), false, 'a read note has no mark button');
    assert.match(out, /tc-note-row is-read/);
    assert.equal(els['cab-notes-all'].disabled, false);
    const { context: empty, els: emptyEls } = notesContext([]);
    vm.runInContext('renderNotifications()', empty);
    assert.match(emptyEls['cab-notes-list'].innerHTML, /Сповіщень поки немає/);
    assert.equal(emptyEls['cab-notes-all'].disabled, true);
});

test('notifications are read and marked only through the API; the unread counter sits on the menu and the tab, owner only', () => {
    for (const name of ['refreshUnreadNotifications', 'markNoteRead', 'markAllNotesRead']) {
        const fn = fnSource(name);
        assert.match(fn, /teamApi\('POST'/, name);
        assert.equal(/supabaseClient|\.from\(/.test(fn), false, name + ' does not touch tables from the client');
    }
    assert.match(fnSource('refreshUnreadNotifications'), /currentOrgRole !== 'owner'/);
    assert.match(fnSource('startNotificationPolling'), /currentOrgRole !== 'owner'/);
    assert.match(fnSource('paintUnread'), /tc-menu-unread/);
    assert.match(fnSource('paintUnread'), /cab-tab-unread/);
    assert.match(html, /body:not\(\.org-owner\) \.tc-menu-badge \{ display: none !important; \}/);
});

test('the Requisites and Statistics slots have a fallback for the plain site and the Contrast stays on theme tokens', () => {
    assert.match(html, /Реквізити компанії, підпис і печатка для актів і ТТН доступні в Контроль\+/);
    assert.match(html, /Статистика за період доступна в Контроль\+/);
    const css = html.slice(html.indexOf('/* Права логіста: компактний ряд прапорців'), html.indexOf('#cabinet-screen .cab-card-head .btn { width: auto;'));
    assert.ok(css.length > 200);
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(css), false, 'only theme variables, so Ocean / Dark / Light keep their contrast');
    const badge = html.slice(html.indexOf('.tc-menu-badge {'), html.indexOf('.tc-menu-badge[hidden]'));
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(badge), false);
});

test('the unread badge keeps WCAG AA contrast (≥ 4.5) in every theme: night, amber, light, dark', () => {
    const lum = (hex) => {
        const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    assert.match(html, /\.tc-menu-badge \{[^}]*background: var\(--danger\); color: var\(--surface\);/);
    for (const head of [':root, [data-theme="night"] {', '[data-theme="amber"] {', '[data-theme="light"] {', '[data-theme="dark"] {']) {
        const at = html.indexOf('\n        ' + head);
        assert.ok(at > 0, head);
        const block = html.slice(at, html.indexOf('\n        }', at));
        const token = (name) => {
            const m = block.match(new RegExp('--' + name + ': (#[0-9a-fA-F]{6}|var\\(--[a-z-]+\\))'));
            assert.ok(m, head + ' defines --' + name);
            if (m[1].startsWith('var(')) return token(m[1].slice(6, -1));
            return m[1];
        };
        assert.ok(ratio(token('danger'), token('surface')) >= 4.5, head + ' badge contrast ' + ratio(token('danger'), token('surface')).toFixed(2));
    }
});
