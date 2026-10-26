// Вкладка «Документи» (етап 4a): підвкладки «Документи» (список, створення, картка), «Борги», «Реквізити».
// Права — з kp_context(): пишуть owner / logist, анулює й змінює реквізити лише owner, директор — перегляд.
// Кнопки без права приховані, але база однаково перевіряє кожну дію.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, kyivDate, monthRange, daysBetween } from '../lib/format.js';
import {
    DOC_KIND_LABELS, PAY_STATUS_LABELS, docsAccess, docErrorText, docNumberText, fmtAmount, isMissingFeature,
} from '../lib/docs.js';
import { downloadDocPdf } from '../lib/docs-pdf-client.js';
import { isPlanError } from '../lib/errors.js';
import { renderDocForm } from './docs-form.js';
import { renderDocCard } from './docs-card.js';
import { renderDebts } from './docs-debts.js';
import { renderRequisites } from './docs-requisites.js';

export function docsTabs() {
    return [
        { sub: 'list', hash: '#/docs', label: 'Документи' },
        { sub: 'debts', hash: '#/docs/debts', label: 'Борги' },
        { sub: 'requisites', hash: '#/docs/requisites', label: 'Реквізити' },
    ];
}

export function statusBadge(status) {
    return h('span', { class: 'kpd-st kpd-st-' + status }, PAY_STATUS_LABELS[status] || status);
}

export function missingNotice() {
    return notice('Розділ «Документи» ще не ввімкнено для вашої компанії (міграцію бази не застосовано).', 'info');
}

// Помилка запиту розділу: немає тарифу — екран Контроль+, немає міграції — пояснення, інакше — текст помилки.
export function showError(app, box, error) {
    if (isPlanError(error)) {
        app.onPlanLost();
        return;
    }
    clear(box, isMissingFeature(error) ? missingNotice() : notice(docErrorText(error)));
}

// PDF за id: документ з kp_doc_get, підпис і печатка — зі Storage.
export function pdfButton(app, id, label = 'PDF', cls = 'btn btn-sm') {
    return h('button', {
        type: 'button', class: cls,
        onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const { data, error } = await app.supabase.rpc('kp_doc_get', { p_doc: id });
                if (error) throw error;
                await downloadDocPdf(app, data);
            } catch (error) {
                toast(error && error.message && /font|fetch|import/i.test(error.message) ? 'Не вдалося підготувати PDF. Спробуйте ще раз.' : docErrorText(error), 'error');
            } finally {
                button.disabled = false;
            }
        },
    }, label);
}

// Анулювання з причиною: перше натискання показує поле причини, далі — підтвердження другим натисканням.
export function cancelControl(app, doc, onDone) {
    const box = h('div', { class: 'kpd-cancel' });
    const open = () => {
        const reason = h('input', { type: 'text', maxlength: 500, placeholder: 'Причина анулювання', 'aria-label': 'Причина анулювання', class: 'grow' });
        const run = async () => {
            const text = reason.value.trim();
            if (!text) {
                toast('Вкажіть причину анулювання', 'error');
                reason.focus();
                return;
            }
            const { error } = await app.supabase.rpc('kp_doc_cancel', { p_doc: doc.id, p_reason: text });
            if (error) {
                toast(docErrorText(error), 'error');
                return;
            }
            toast(DOC_KIND_LABELS[doc.kind] + ' № ' + docNumberText(doc) + ' анульовано');
            onDone();
        };
        clear(box, reason, confirmButton('Анулювати', 'Точно анулювати?', run, 'btn btn-sm btn-danger'),
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => clear(box, start()) }, 'Скасувати'));
        reason.focus();
    };
    const start = () => h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: open }, 'Анулювати…');
    clear(box, start());
    return box;
}

function createButtons(clientId) {
    const tail = clientId ? '/' + clientId : '';
    return [
        h('a', { class: 'btn btn-primary', href: '#/docs/new/invoice' + tail }, 'Створити рахунок'),
        h('a', { class: 'btn btn-primary', href: '#/docs/new/act' + tail }, 'Створити акт'),
    ];
}

export { createButtons };

const STATUS_FILTERS = [
    { value: '', label: 'Усі статуси' },
    { value: 'unpaid', label: 'Неоплачені' },
    { value: 'issued', label: PAY_STATUS_LABELS.issued },
    { value: 'partial', label: PAY_STATUS_LABELS.partial },
    { value: 'paid', label: PAY_STATUS_LABELS.paid },
    { value: 'overdue', label: PAY_STATUS_LABELS.overdue },
    { value: 'cancelled', label: PAY_STATUS_LABELS.cancelled },
];

// Підсумки списку окремо за валютами (лише активні рахунки).
export function listTotals(rows) {
    const out = {};
    for (const r of rows || []) {
        if (r.kind !== 'invoice' || r.status !== 'issued') continue;
        const t = out[r.currency] || (out[r.currency] = { total: 0, debt: 0 });
        t.total = Math.round((t.total + Number(r.total || 0)) * 100) / 100;
        t.debt = Math.round((t.debt + Number(r.debt || 0)) * 100) / 100;
    }
    return out;
}

function renderDocList(app, access) {
    const range = monthRange(kyivDate());
    const from = h('input', { type: 'date', value: range.from, 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', value: range.to, 'aria-label': 'Період по' });
    const kind = h('select', { 'aria-label': 'Тип документа' },
        h('option', { value: '' }, 'Рахунки й акти'), h('option', { value: 'invoice' }, 'Рахунки'), h('option', { value: 'act' }, 'Акти'));
    const status = h('select', { 'aria-label': 'Статус' }, STATUS_FILTERS.map((s) => h('option', { value: s.value }, s.label)));
    const client = h('select', { 'aria-label': 'Клієнт' }, h('option', { value: '' }, 'Усі клієнти'));
    const list = h('div', { class: 'list' }, spinner());

    async function loadClients() {
        const { data } = await app.supabase.from('clients').select('id, name, archived_at').order('name', { ascending: true }).limit(2000);
        for (const c of data || []) client.append(h('option', { value: c.id }, c.name + (c.archived_at ? ' (архів)' : '')));
    }

    async function load() {
        if (!from.value || !to.value || from.value > to.value || daysBetween(from.value, to.value) > 731) {
            clear(list, notice('Перевірте період: «з» не пізніше «по», не довше двох років.'));
            return;
        }
        clear(list, spinner());
        const { data, error } = await app.supabase.rpc('kp_doc_list', {
            p_kind: kind.value || null, p_from: from.value, p_to: to.value, p_client: client.value || null, p_status: status.value || null,
        });
        if (error) return showError(app, list, error);
        const rows = data || [];
        if (!rows.length) {
            clear(list, h('div', { class: 'empty' }, h('p', null, 'За цей період документів немає.'),
                access.canWrite ? h('div', { class: 'actions kpd-center' }, createButtons()) : null));
            return;
        }
        const totals = listTotals(rows);
        clear(list,
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Дата', '№', 'Тип', 'Клієнт', 'Сума', 'Оплачено', 'Борг', 'Строк', 'Статус', ''].map((t) => h('th', null, t)))),
                h('tbody', null, rows.map((r) => h('tr', { class: r.status === 'cancelled' ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Дата' }, fmtDate(r.doc_date)),
                    h('td', { 'data-label': '№', class: 'mono' }, h('a', { href: '#/docs/' + r.id }, docNumberText(r))),
                    h('td', { 'data-label': 'Тип' }, DOC_KIND_LABELS[r.kind] || r.kind),
                    h('td', { 'data-label': 'Клієнт' }, h('a', { href: '#/clients/' + r.client_id }, r.client_name || '—')),
                    h('td', { 'data-label': 'Сума', class: 'mono' }, h('b', null, fmtAmount(r.total, r.currency))),
                    h('td', { 'data-label': 'Оплачено', class: 'mono' }, r.kind === 'invoice' ? fmtAmount(r.paid, r.currency) : '—'),
                    h('td', { 'data-label': 'Борг', class: 'mono' }, r.debt === null || r.debt === undefined ? '—' : fmtAmount(r.debt, r.currency)),
                    h('td', { 'data-label': 'Строк' }, r.due_date ? fmtDate(r.due_date) : '—'),
                    h('td', { 'data-label': 'Статус' }, statusBadge(r.pay_status)),
                    h('td', { 'data-label': '' }, h('div', { class: 'actions' },
                        pdfButton(app, r.id),
                        access.isOwner && r.status === 'issued' ? cancelControl(app, r, load) : null))))))),
            Object.keys(totals).length
                ? h('p', { class: 'muted small' }, 'Активні рахунки у списку: ', Object.entries(totals).map(([cur, t], i) => [
                    i ? ' · ' : '', h('b', null, fmtAmount(t.total, cur)), ', борг ', h('b', null, fmtAmount(t.debt, cur))]))
                : null);
    }

    for (const el of [from, to, kind, status, client]) el.addEventListener('change', load);
    loadClients().then(load, load);
    return h('div', null,
        h('div', { class: 'toolbar' }, from, to, kind, status, client),
        access.canWrite ? h('div', { class: 'toolbar' }, createButtons()) : null,
        list);
}

export function renderDocs(app, route) {
    const access = docsAccess(app.context);
    const sub = route.sub || 'list';
    const current = sub === 'new' || sub === 'doc' ? 'list' : sub;
    let body;
    if (sub === 'new') body = access.canWrite ? renderDocForm(app, access, route) : notice('Створювати документи можуть власник і логіст.', 'info');
    else if (sub === 'doc') body = renderDocCard(app, access, route.id);
    else if (sub === 'debts') body = renderDebts(app, access);
    else if (sub === 'requisites') body = renderRequisites(app, access);
    else body = renderDocList(app, access);
    return h('section', { class: 'page kpr-page kpd-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Документи')),
        h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи документів' }, docsTabs().map((t) =>
            h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === current ? ' on' : ''), 'aria-current': t.sub === current ? 'page' : null }, t.label))),
        access.canWrite ? null : notice('Режим перегляду: директор бачить документи, оплати й борги, але не змінює їх.', 'info'),
        body);
}
