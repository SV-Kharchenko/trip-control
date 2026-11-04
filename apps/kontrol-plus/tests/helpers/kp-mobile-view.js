// Браузерна сторінка для перевірок мобільної версії: справжні оболонка (mountShell), мобільні доповнення і розділи Контроль+ на підміні Supabase.
// ?view=<invoice|client|vehicle|fleet|drivers|repairs|docs|dashboard|report>&theme=light|dark. Лише тести й знімки екранів.
import { mountShell } from '/src/shell.js';
import { mountMobile } from '/src/kp-mobile.js';
import { createWindowManager } from '/src/kp-windows.js';
import { h } from '/src/ui.js';
import { UUID, access, app, client, supabase } from '/tests/helpers/kp-mock.mjs';

const q = new URLSearchParams(location.search);
const view = q.get('view') || 'client';
document.body.className = 'layout-studio';
document.body.dataset.theme = q.get('theme') || 'light';
document.body.dataset.kpView = view;
const HASH = { invoice: '#/docs/new/invoice/' + client.id, client: '#/clients/' + client.id, vehicle: '#/fleet/car/' + UUID(31) };
if (HASH[view]) history.replaceState(null, '', location.pathname + location.search + HASH[view]);

const head = h('div', { class: 'tc-head-end' });
document.body.append(head);
// Старі кнопки доступу, за якими оболонка вирішує, які пункти меню показувати.
const oldNav = h('div', { id: 'kp-nav-list', hidden: true }, ['overview', 'calc', 'clients', 'docs', 'fleet', 'drivers', 'repairs', 'gps', 'report'].map((k) => h('button', { type: 'button', id: 'kp-nav-' + k })));
document.body.append(oldNav);
const main = h('main', { id: 'main-app', class: 'container' });
main.style.display = 'grid';
const root = h('section', { id: 'kp-crm', class: 'kp-crm' });
main.append(root, h('footer', { class: 'tc-legal-footer' }, 'Публічна оферта'));
document.body.append(main);
window.tcKpRole = 'owner';
window.tcKpOrgName = 'ТОВ «Логістик-Т»';
mountShell({ supabase: { ...supabase, auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: UUID(8) } } } }) } } });
mountMobile();
window.__wm = createWindowManager({ storage: sessionStorage, confirm: async () => ({ ok: true }), notify() {} });

const page = (cls, el) => { const s = h('section', { class: 'page ' + cls }); s.append(el); return s; };
const views = {
    client: async () => (await import('/src/views/client-card.js')).renderClientCard({ ...app, go: (x) => { location.hash = x; } }, client.id),
    invoice: async () => page('kpr-page kpd-page', (await import('/src/views/docs-form.js')).renderDocForm(app, access, { view: 'docs', sub: 'new', kind: 'invoice', client: client.id, calc: null })),
    fleet: async () => (await import('/src/views/fleet.js')).renderFleetPage(app, 'cars'),
    vehicle: async () => page('kpr-page kpg-page', await (await import('/src/views/fleet.js')).renderFleetCardWindow({ ...app, closeWindow: () => {} }, 'vehicle', UUID(31))),
    drivers: async () => (await import('/src/views/drivers.js')).renderDrivers(app),
    dashboard: async () => {
        const { makeFixture, makeRows } = await import('/tests/helpers/dashboard-fixture.mjs');
        const fx = makeFixture({ role: 'owner', rows: makeRows(14), plan: true });
        const a = { supabase: { rpc: fx.rpc }, context: fx.context, openSite() {}, onCleanup() {}, onPlanLost() {} };
        return (await import('/src/views/dashboard.js')).renderDashboard(a, { today: () => '2026-11-18', storage: { getItem: () => null, setItem() {} } });
    },
    report: async () => {
        const { OCT } = await import('/tests/helpers/report-fixture.mjs');
        const a = { supabase: { rpc: async () => ({ data: OCT, error: null }) }, onPlanLost() {} };
        return (await import('/src/views/report.js')).renderReport(a, 'main');
    },
    repairs: async () => { app.repairs = { org_id: UUID(9), role: 'owner', can_write: true, can_manage_handlers: true }; return (await import('/src/views/repairs.js')).renderRepairs(app, 'list'); },
};
const el = await views[view]();
root.append(el);
window.__ready = true;
