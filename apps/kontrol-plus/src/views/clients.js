import { h, clear, spinner, notice } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { LEGAL_FORMS } from '../lib/validate.js';

const FORM_LABEL = Object.fromEntries(LEGAL_FORMS.map((f) => [f.value, f.label]));

export function filterClients(clients, query, showArchived) {
    const q = String(query || '').trim().toLowerCase();
    return clients.filter((c) => {
        if (!showArchived && c.archived_at) return false;
        if (!q) return true;
        return [c.name, c.legal_name, c.edrpou, c.ipn, c.contact_name, c.phone, c.email]
            .some((v) => v && String(v).toLowerCase().includes(q));
    });
}

export function renderClients(app) {
    const list = h('div', { class: 'list' }, spinner());
    const search = h('input', { type: 'search', placeholder: 'Пошук: назва, ЄДРПОУ, ІПН, контакт…', 'aria-label': 'Пошук клієнтів', class: 'grow' });
    const archived = h('input', { type: 'checkbox', id: 'show-archived' });
    let clients = [];

    function draw() {
        const rows = filterClients(clients, search.value, archived.checked);
        if (!clients.length) {
            clear(list, h('div', { class: 'empty' },
                h('p', null, 'Клієнтів ще немає.'),
                app.canWrite ? h('a', { class: 'btn btn-primary', href: '#/clients/new' }, 'Додати першого клієнта') : null));
            return;
        }
        if (!rows.length) {
            clear(list, h('p', { class: 'muted empty' }, 'Нічого не знайдено.'));
            return;
        }
        clear(list, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null,
                h('th', null, 'Клієнт'), h('th', null, 'Форма'), h('th', null, 'ЄДРПОУ / ІПН'),
                h('th', null, 'Контакт'), h('th', null, 'Телефон'))),
            h('tbody', null, rows.map((c) => h('tr', { class: c.archived_at ? 'is-archived' : '' },
                h('td', null, h('a', { href: '#/clients/' + c.id }, c.name),
                    c.archived_at ? h('span', { class: 'tag' }, 'архів') : null,
                    c.vat_payer ? h('span', { class: 'tag tag-vat' }, 'ПДВ') : null),
                h('td', null, FORM_LABEL[c.legal_form] || '—'),
                h('td', { class: 'mono' }, c.edrpou || c.ipn || '—'),
                h('td', null, c.contact_name || '—'),
                h('td', null, c.phone ? h('a', { href: 'tel:' + c.phone.replace(/[^\d+]/g, '') }, c.phone) : '—')))))));
    }

    async function load() {
        const { data, error } = await app.supabase.from('clients')
            .select('id, name, legal_name, legal_form, edrpou, ipn, vat_payer, contact_name, phone, email, archived_at')
            .order('name', { ascending: true })
            .limit(2000);
        if (error) {
            if (isPlanError(error)) return app.onPlanLost();
            clear(list, notice(errorText(error)));
            return;
        }
        clients = data || [];
        draw();
    }

    search.addEventListener('input', draw);
    archived.addEventListener('change', draw);
    load();

    return h('section', { class: 'page' },
        h('div', { class: 'page-head' },
            h('h1', null, 'Клієнти'),
            app.canWrite ? h('a', { class: 'btn btn-primary', href: '#/clients/new' }, '+ Додати клієнта') : null),
        app.canWrite ? null : notice('Режим перегляду: директор бачить дані організації, але не змінює їх.', 'info'),
        h('div', { class: 'toolbar' }, search,
            h('label', { class: 'check', for: 'show-archived' }, archived, ' Показати архів')),
        list);
}
