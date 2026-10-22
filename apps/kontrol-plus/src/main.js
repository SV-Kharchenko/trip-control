import './styles.css';
import { supabase, configured, SITE_URL } from './supabase.js';
import { h, clear, spinner, notice } from './ui.js';
import { errorText } from './lib/errors.js';
import { renderLogin } from './views/login.js';
import { renderPaywall } from './views/paywall.js';
import { renderClients } from './views/clients.js';
import { renderClientCard } from './views/client-card.js';
import { renderClientForm } from './views/client-form.js';
import { renderReport } from './views/report.js';
import { registerServiceWorker } from './sw-register.js';

const root = document.getElementById('app');
const ROLE_LABELS = { owner: 'Власник', logist: 'Логіст', director: 'Директор (перегляд)' };

const state = { session: null, context: null };

// Права в інтерфейсі — лише підказка; справжня перевірка — RLS і функції БД.
function app() {
    const role = state.context && state.context.role;
    return {
        supabase,
        context: state.context,
        user: state.session && state.session.user,
        canWrite: role === 'owner' || role === 'logist',
        canDelete: role === 'owner',
        go: (hash) => { location.hash = hash; },
        onPlanLost: () => loadContext(),
    };
}

async function loadContext() {
    clear(root, spinner('Перевіряємо доступ…'));
    const { data, error } = await supabase.rpc('kp_context');
    if (error) {
        clear(root, shell(null, h('section', { class: 'page' }, notice(errorText(error)),
            h('button', { type: 'button', class: 'btn', onclick: loadContext }, 'Спробувати ще'))));
        return;
    }
    state.context = (data && data[0]) || null;
    route();
}

function shell(context, content) {
    const nav = context && context.control_plus
        ? h('nav', { class: 'nav', 'aria-label': 'Розділи' },
            h('a', { href: '#/clients', class: location.hash.startsWith('#/clients') || !location.hash.startsWith('#/report') ? 'is-active' : '' }, 'Клієнти'),
            h('a', { href: '#/report', class: location.hash.startsWith('#/report') ? 'is-active' : '' }, 'Звіт план/факт'))
        : null;
    const user = state.session && state.session.user;
    return [
        h('header', { class: 'topbar' },
            h('a', { class: 'brand', href: '#/clients', 'aria-label': 'Контроль+ — на головну' },
                h('img', { src: '/icons/symbol.svg', width: 28, height: 28, alt: '' }),
                h('span', null, 'Контроль', h('b', null, '+'))),
            nav,
            h('div', { class: 'who' },
                context && context.org_name ? h('span', { class: 'org' }, context.org_name) : null,
                context && context.role ? h('span', { class: 'badge badge-' + context.role }, ROLE_LABELS[context.role]) : null,
                user ? h('span', { class: 'email' }, user.email) : null,
                user ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: signOut }, 'Вийти') : null)),
        h('main', { id: 'main', class: 'main', tabindex: '-1' }, content),
    ];
}

async function signOut() {
    await supabase.auth.signOut();
    state.context = null;
    location.hash = '';
}

function route() {
    if (!state.session) {
        clear(root, renderLogin({ supabase, siteUrl: SITE_URL }));
        return;
    }
    if (!state.context) {
        loadContext();
        return;
    }
    if (!state.context.control_plus) {
        clear(root, shell(state.context, renderPaywall({ context: state.context, siteUrl: SITE_URL })));
        return;
    }
    const hash = location.hash.replace(/^#/, '') || '/clients';
    const parts = hash.split('/').filter(Boolean);
    let view;
    if (parts[0] === 'report') view = renderReport(app());
    else if (parts[0] === 'clients' && parts[1] === 'new') view = renderClientForm(app(), null);
    else if (parts[0] === 'clients' && parts[1] && parts[2] === 'edit') view = renderClientForm(app(), parts[1]);
    else if (parts[0] === 'clients' && parts[1]) view = renderClientCard(app(), parts[1]);
    else view = renderClients(app());
    clear(root, shell(state.context, view));
    const main = document.getElementById('main');
    if (main) main.focus({ preventScroll: true });
}

async function boot() {
    registerServiceWorker();
    if (!configured) {
        clear(root, h('section', { class: 'page narrow' },
            h('h1', null, 'Контроль+'),
            notice('Не задано VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Скопіюйте .env.example у .env.local і перезапустіть.')));
        return;
    }
    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    supabase.auth.onAuthStateChange((event, session) => {
        const changedUser = (state.session && state.session.user.id) !== (session && session.user.id);
        state.session = session;
        if (event === 'SIGNED_OUT' || changedUser) {
            state.context = null;
            route();
        }
    });
    window.addEventListener('hashchange', route);
    route();
}

boot();
