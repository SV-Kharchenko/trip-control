import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceBetween(source, startMark, endMark) {
    const start = source.indexOf(startMark);
    const end = source.indexOf(endMark, start + startMark.length);
    assert.ok(start !== -1 && end !== -1, startMark + ' … ' + endMark);
    return source.slice(start, end);
}

test('owner role label in the UI is Директор', () => {
    const fn = sliceBetween(html, 'function roleLabel(role)', 'const UI_VIEW_KEY');
    assert.match(fn, /Директор/);
    assert.equal(fn.includes('Власник'), false);
    assert.match(html, /Директор — окремо/);
    assert.equal(html.includes('Власник — окремо'), false);
    assert.match(html, /доступне директору/);
});

test('header keeps live rates and moves actions into the avatar menu', () => {
    const top = sliceBetween(html, 'class="tc-topbar"', 'id="demo-banner"');
    assert.match(top, /id="studio-nav-calc"/);
    assert.match(top, /id="studio-nav-overview"/);
    assert.match(top, /id="studio-nav-company"/);
    assert.match(top, /id="rate-usd"/);
    assert.match(top, /id="rate-eur"/);
    assert.match(top, /id="conv-amount"/);
    assert.match(top, /onclick="cycleTheme\(\)"/);
    assert.match(top, /id="theme-label"/);
    assert.match(top, /id="tc-view-switch"/);
    assert.match(top, /Директор/);
    assert.match(top, /Логіст/);
    assert.match(top, /id="tc-avatar-btn"/);
    assert.match(top, /aria-haspopup="menu"/);
    assert.match(top, /aria-controls="tc-user-menu"/);
    assert.match(top, /id="tc-user-menu"/);
    assert.match(top, /Особистий кабінет/);
    assert.match(top, /Компанія і реквізити/);
    assert.match(top, /id="tc-menu-team"/);
    assert.match(top, /Автопарк/);
    assert.match(top, /Історія і шаблони/);
    assert.match(top, /Значення за замовчуванням/);
    assert.match(top, /id="admin-crm-btn"/);
    assert.match(top, /Клієнтська база/);
    assert.match(top, /Довідка і підтримка/);
    assert.match(top, /onclick="menuGo\('logout'\)"/);
    assert.match(top, /\/legal\/offer\.html/);
    assert.match(top, /\/legal\/privacy\.html/);
    assert.match(top, /class="tc-logo-trip"/);
    assert.equal(top.includes('tc-action-btn'), false);
    assert.equal(top.includes('logo-compass'), false);
    assert.equal(top.includes('openAdminCrm()'), false);
    const auth = sliceBetween(html, 'id="auth-screen"', 'id="auth-form"');
    assert.match(auth, /class="tc-logo-trip"/);
    assert.equal(auth.includes('logo-compass'), false);
});

test('view switch is display-only and does not rewrite the org role', () => {
    const fn = sliceBetween(html, 'function setUiView(view)', 'function menuItems()');
    assert.match(html, /const UI_VIEW_KEY = 'tc_ui_view'/);
    assert.match(fn, /localStorage\.setItem\(UI_VIEW_KEY, uiView\)/);
    assert.match(fn, /currentOrgRole !== 'owner'/);
    assert.equal(fn.includes('currentOrgRole ='), false);
    assert.equal(fn.includes('teamApi'), false);
    assert.match(html, /body:not\(\.org-owner\) #tc-view-switch \{ display: none !important; \}/);
    assert.match(html, /body\.view-logist #studio-nav-overview \{ display: none; \}/);
    assert.match(html, /body:not\(\.org-owner\) #tc-menu-team/);
    assert.match(html, /body\.view-logist #tc-menu-team/);
    assert.match(html, /body:not\(\.team-mode\) #tc-menu-team/);
});

test('avatar menu closes from Escape and an outside click, and does not calculate', () => {
    const menu = sliceBetween(html, 'function menuGo(action)', 'function openHeaderCompany()');
    assert.equal(menu.includes('calculate('), false);
    assert.match(menu, /mailto:support@trip-control.com/);
    assert.match(menu, /switchCabTab\('company'\)|openHeaderCompany\(\)/);
    assert.match(menu, /switchCabTab\('docs'\)/);
    assert.match(menu, /switchCabTab\('s0'\)/);
    assert.match(menu, /openAdminCrm\(\)/);
    assert.match(menu, /handleLogout\(\)/);
    assert.match(html, /event\.key === 'Escape'/);
    assert.match(html, /event\.key === 'ArrowDown'/);
    assert.match(html, /event\.key === 'ArrowUp'/);
    assert.match(html, /if \(menu\.contains\(event\.target\)\) return;/);
    assert.match(html, /#admin-crm-btn \{ display: none; \}/);
    assert.match(html, /body\.is-admin #admin-crm-btn \{ display: inline-flex; \}/);
    assert.match(html, /body\.is-admin #tc-user-menu #admin-crm-btn \{ display: flex; \}/);
});

test('a long menu email ellipsizes and is not repeated without a company', () => {
    assert.match(html, /\.tc-menu-who \{ min-width: 0; \}/);
    const clip = sliceBetween(html, '.tc-menu-name, .tc-menu-email {', '.tc-menu-demo');
    assert.match(clip, /overflow: hidden;/);
    assert.match(clip, /text-overflow: ellipsis;/);
    assert.match(clip, /white-space: nowrap;/);
    const sync = sliceBetween(html, 'const shownName = company || email', 'const teamBtn');
    assert.match(sync, /nameEl\.title = shownName/);
    assert.match(sync, /const showEmail = !!\(company && email\)/);
    assert.match(sync, /emailEl\.title = email/);
});
