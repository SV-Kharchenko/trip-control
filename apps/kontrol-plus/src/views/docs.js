// Вкладка «Документи» (етапи 4a, 4b): підвкладки «Документи» (список рахунків, актів і ТТН, створення, картка),
// «Борги», «Авто й водії» (поля ТЗ для ТТН), «Реквізити». Права — з kp_context(): пишуть owner / logist, анулює й змінює
// реквізити лише owner, директор — перегляд. Кнопки без права приховані, але база однаково перевіряє кожну дію.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, kyivDate, monthRange, daysBetween } from '../lib/format.js';
import {
    DOC_KIND_LABELS, PAY_STATUS_LABELS, docsAccess, docErrorText, docNumberText, fmtAmount, isMissingFeature,
} from '../lib/docs.js';
import { ttnErrorText } from '../lib/ttn.js';
import { downloadDocPdf, downloadDocXlsx, downloadTtnPdf } from '../lib/docs-pdf-client.js';
import { isPlanError } from '../lib/errors.js';
import { renderDocForm } from './docs-form.js';
import { renderDocCard } from './docs-card.js';
import { renderDebts } from './docs-debts.js';
import { renderRequisites } from './docs-requisites.js';
import { renderTtnForm } from './docs-ttn-form.js';
import { renderTtnCard } from './docs-ttn-card.js';
import { renderFleet } from './docs-fleet.js';

export function docsTabs() {
    return [
        { sub: 'list', hash: '#/docs', label: 'Документи' },
        { sub: 'debts', hash: '#/docs/debts', label: 'Борги' },
        { sub: 'fleet', hash: '#/docs/fleet', label: 'Авто й водії' },
        { sub: 'requisites', hash: '#/docs/requisites', label: 'Реквізити' },
    ];
}

// Документ за id і видом: рахунок / акт — kp_doc_get, ТТН — kp_ttn_get.
async function fetchDoc(app, id, kind) {
    const { data, error } = await app.supabase.rpc(kind === 'ttn' ? 'kp_ttn_get' : 'kp_doc_get', kind === 'ttn' ? { p_id: id } : { p_doc: id });
    if (error) throw error;
    return data;
}

function exportError(error, kind) {
    if (error && error.message && /font|fetch|import/i.test(error.message)) return 'Не вдалося підготувати файл. Спробуйте ще раз.';
    return kind === 'ttn' ? ttnErrorText(error) : docErrorText(error);
}

// Excel за id: ті самі дані, що й PDF; модуль xlsx вантажиться лише по кнопці.
export function excelButton(app, id, kind, label = 'Excel', cls = 'btn btn-sm') {
    return h('button', {
        type: 'button', class: cls,
        onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                await downloadDocXlsx(await fetchDoc(app, id, kind));
            } catch (error) {
                toast(exportError(error, kind), 'error');
            } finally {
                button.disabled = false;
            }
        },
    }, label);
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

// PDF за id: документ з kp_doc_get / kp_ttn_get, підпис і печатка — зі Storage. ТТН — copies (1 або 3 примірники).
export function pdfButton(app, id, label = 'PDF', cls = 'btn btn-sm', kind = null, copies = () => 1) {
    return h('button', {
        type: 'button', class: cls,
        onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const data = await fetchDoc(app, id, kind);
                if (kind === 'ttn') await downloadTtnPdf(app, data, { copies: copies() });
                else await downloadDocPdf(app, data);
            } catch (error) {
                toast(exportError(error, kind), 'error');
            } finally {
                button.disabled = false;
            }
        },
    }, label);
}

// Анулювання з причиною: перше натискання показує поле причини, далі — підтвердження другим натисканням.
// ТТН — kp_ttn_cancel, рахунок / акт — kp_doc_cancel.
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
            const isTtn = doc.kind === 'ttn';
            const { error } = await app.supabase.rpc(isTtn ? 'kp_ttn_cancel' : 'kp_doc_cancel', isTtn ? { p_id: doc.id, p_reason: text } : { p_doc: doc.id, p_reason: text });
            if (error) {
                toast(isTtn ? ttnErrorText(error) : docErrorText(error), 'error');
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
        h('a', { class: 'btn btn-primary', href: '#/docs/new/ttn' + tail }, 'Створити ТТН'),
    ];
}

// ТТН у рядку загального списку (поля як у kp_doc_list; оплат і боргу немає).
export function ttnListRow(r) {
    return {
        ...r, kind: 'ttn', currency: 'UAH', total: r.total_amount, paid: null, debt: null, due_date: null,
        pay_status: r.status === 'cancelled' ? 'cancelled' : 'issued',
    };
}

// Статус фільтра → p_status для kp_ttn_list; null — ТТН у вибірку не потрапляють (оплати бувають лише в рахунків).
export function ttnStatusFilter(status) {
    if (!status) return { include: true, value: null };
    if (status === 'issued' || status === 'cancelled') return { include: true, value: status };
    return { include: false, value: null };
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
        h('option', { value: '' }, 'Усі документи'), h('option', { value: 'invoice' }, 'Рахунки'), h('option', { value: 'act' }, 'Акти'),
        h('option', { value: 'ttn' }, 'ТТН'));
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
        // Рахунки й акти — kp_doc_list, ТТН — kp_ttn_list (окрема таблиця 4b); «Усі документи» — обидва, за датою.
        const ttnFilter = ttnStatusFilter(status.value);
        const wantDocs = kind.value !== 'ttn';
        const wantTtn = (kind.value === '' || kind.value === 'ttn') && ttnFilter.include;
        const [docsRes, ttnRes] = await Promise.all([
            wantDocs ? app.supabase.rpc('kp_doc_list', {
                p_kind: kind.value || null, p_from: from.value, p_to: to.value, p_client: client.value || null, p_status: status.value || null,
            }) : { data: [] },
            wantTtn ? app.supabase.rpc('kp_ttn_list', { p_from: from.value, p_to: to.value, p_client: client.value || null, p_status: ttnFilter.value }) : { data: [] },
        ]);
        if (docsRes.error) return showError(app, list, docsRes.error);
        // Міграцію 4b ще не застосовано: у «Усіх документах» — без ТТН, у фільтрі «ТТН» — пояснення.
        if (ttnRes.error && (kind.value === 'ttn' || !isMissingFeature(ttnRes.error))) {
            if (kind.value === 'ttn' && isMissingFeature(ttnRes.error)) return clear(list, notice('ТТН ще не ввімкнено для вашої компанії (міграцію бази етапу 4b не застосовано).', 'info'));
            return showError(app, list, ttnRes.error);
        }
        const rows = [...(docsRes.data || []), ...(ttnRes.error ? [] : (ttnRes.data || []).map(ttnListRow))]
            .sort((a, b) => String(b.doc_date).localeCompare(String(a.doc_date)) || String(a.kind).localeCompare(String(b.kind)) || Number(b.number) - Number(a.number));
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
                    h('td', { 'data-label': '№', class: 'mono' }, h('a', { href: r.kind === 'ttn' ? '#/docs/ttn/' + r.id : '#/docs/' + r.id }, docNumberText(r))),
                    h('td', { 'data-label': 'Тип' }, DOC_KIND_LABELS[r.kind] || r.kind,
                        r.kind === 'ttn' && r.vehicle_reg ? h('span', { class: 'muted small' }, ' · ' + r.vehicle_reg) : null),
                    h('td', { 'data-label': 'Клієнт' }, h('a', { href: '#/clients/' + r.client_id }, r.client_name || '—')),
                    h('td', { 'data-label': 'Сума', class: 'mono' }, r.total === null || r.total === undefined ? '—' : h('b', null, fmtAmount(r.total, r.currency))),
                    h('td', { 'data-label': 'Оплачено', class: 'mono' }, r.kind === 'invoice' ? fmtAmount(r.paid, r.currency) : '—'),
                    h('td', { 'data-label': 'Борг', class: 'mono' }, r.debt === null || r.debt === undefined ? '—' : fmtAmount(r.debt, r.currency)),
                    h('td', { 'data-label': 'Строк' }, r.due_date ? fmtDate(r.due_date) : '—'),
                    h('td', { 'data-label': 'Статус' }, statusBadge(r.pay_status)),
                    h('td', { 'data-label': '' }, h('div', { class: 'actions' },
                        pdfButton(app, r.id, 'PDF', 'btn btn-sm', r.kind === 'ttn' ? 'ttn' : null),
                        excelButton(app, r.id, r.kind === 'ttn' ? 'ttn' : null),
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
    const current = sub === 'new' || sub === 'doc' || sub === 'ttn' ? 'list' : sub;
    let body;
    if (sub === 'new' && !access.canWrite) body = notice('Створювати документи можуть власник і логіст.', 'info');
    else if (sub === 'new' && route.kind === 'ttn') body = renderTtnForm(app, access, route);
    else if (sub === 'new') body = renderDocForm(app, access, route);
    else if (sub === 'doc') body = renderDocCard(app, access, route.id);
    else if (sub === 'ttn') body = renderTtnCard(app, access, route.id);
    else if (sub === 'fleet') body = renderFleet(app, access);
    else if (sub === 'debts') body = renderDebts(app, access);
    else if (sub === 'requisites') body = renderRequisites(app, access);
    else body = renderDocList(app, access);
    return h('section', { class: 'page kpr-page kpd-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Документи')),
        h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи документів' }, docsTabs().map((t) =>
            h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === current ? ' on' : ''), 'aria-current': t.sub === current ? 'page' : null }, t.label))),
        access.canWrite ? null : notice('Режим перегляду: директор бачить документи, ТТН, оплати, борги й авто, але не змінює їх.', 'info'),
        body);
}
