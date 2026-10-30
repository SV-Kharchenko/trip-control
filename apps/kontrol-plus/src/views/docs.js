// Вкладка «Документи» (етапи 4a, 4b): підвкладки Усі · Договори · ТТН / Подорожній лист · Акти · Інше (список рахунків, актів і ТТН, створення, картка).
// «Борги» живуть у «План/факт», «Авто й водії» — в «Автопарку» і «Водіях», «Реквізити» — у «Реквізитах компанії». Права — з kp_context(): пишуть owner / logist, анулює й змінює
// реквізити лише owner, директор — перегляд. Кнопки без права приховані, але база однаково перевіряє кожну дію.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, kyivDate, monthRange, daysBetween } from '../lib/format.js';
import {
    DOC_KIND_LABELS, PAY_STATUS_LABELS, docStatusKey, docStatusLabel, docsAccess, docErrorText, docNumberText, fmtAmount, isMissingFeature,
} from '../lib/docs.js';
import { ttnErrorText } from '../lib/ttn.js';
import { tsErrorText } from '../lib/trip-sheet.js';
import { downloadDocPdf, downloadDocXlsx, downloadTripSheetPdf, downloadTtnPdf } from '../lib/docs-pdf-client.js';
import { isPlanError } from '../lib/errors.js';
import { renderDocForm } from './docs-form.js';
import { renderDocCard } from './docs-card.js';
import { renderTtnForm } from './docs-ttn-form.js';
import { renderTtnCard } from './docs-ttn-card.js';
import { renderTripSheetForm } from './docs-ts-form.js';
import { renderTripSheetCard } from './docs-ts-card.js';
import { requestPicker } from './docs-request-picker.js';
import { TAB_DOC_KIND, filterRows } from '../lib/docs-requests.js';

export function docsTabs() {
    return [
        { key: 'all', hash: '#/docs', label: 'Усі' },
        { key: 'contracts', hash: '#/docs/tab/contracts', label: 'Договори' },
        { key: 'ttn', hash: '#/docs/tab/ttn', label: 'ТТН' },
        { key: 'acts', hash: '#/docs/tab/acts', label: 'Акти' },
        { key: 'invoices', hash: '#/docs/tab/invoices', label: 'Рахунки' },
        { key: 'trip_sheets', hash: '#/docs/tab/trip_sheets', label: 'Подорожні листи' },
        { key: 'other', hash: '#/docs/tab/other', label: 'Інше' },
    ];
}

// Кожна вкладка показує свій вид документів: ТТН, акти, рахунки, подорожні листи (вкладка «Усі» — усі разом).
const TAB_KIND = TAB_DOC_KIND;
const EMPTY_TABS = {
    contracts: ['Договорів ще немає', 'Договір із клієнтом з’явиться тут і підтягне реквізити компанії.'],
    other: ['Тут будуть інші файли', 'Довіреності, страхові поліси, сканкопії — усе, що не потрапляє в інші вкладки.'],
};

// Документ за id і видом: рахунок / акт — kp_doc_get, ТТН — kp_ttn_get, подорожній лист — kp_trip_sheet_get.
async function fetchDoc(app, id, kind) {
    const fn = kind === 'ttn' ? 'kp_ttn_get' : kind === 'trip_sheet' ? 'kp_trip_sheet_get' : 'kp_doc_get';
    const { data, error } = await app.supabase.rpc(fn, kind === 'ttn' || kind === 'trip_sheet' ? { p_id: id } : { p_doc: id });
    if (error) throw error;
    return data;
}

function exportError(error, kind) {
    if (error && error.message && /font|fetch|import/i.test(error.message)) return 'Не вдалося підготувати файл. Спробуйте ще раз.';
    if (kind === 'trip_sheet') return tsErrorText(error);
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

// Для актів: «Створено» / «Підписано» / «Анульовано»; для рахунків і ТТН — статус оплати як було.
export function statusBadge(status, kind = null, signed = false) {
    return h('span', { class: 'kpd-st kpd-st-' + docStatusKey(kind, status, signed) }, docStatusLabel(kind, status, signed));
}

// Які з актів підписані (kp_doc_signed); без міграції — порожньо.
export async function signedActs(app, rows) {
    const ids = (rows || []).filter((r) => r.kind === 'act').map((r) => r.id);
    if (!ids.length) return new Set();
    try {
        const { data, error } = await app.supabase.rpc('kp_doc_signed', { p_ids: ids });
        return error ? new Set() : new Set(data || []);
    } catch {
        return new Set();
    }
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
                else if (kind === 'trip_sheet') await downloadTripSheetPdf(data);
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
            const isTs = doc.kind === 'trip_sheet';
            const { error } = await app.supabase.rpc(isTtn ? 'kp_ttn_cancel' : isTs ? 'kp_trip_sheet_cancel' : 'kp_doc_cancel', isTtn || isTs ? { p_id: doc.id, p_reason: text } : { p_doc: doc.id, p_reason: text });
            if (error) {
                toast(isTtn ? ttnErrorText(error) : isTs ? tsErrorText(error) : docErrorText(error), 'error');
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
        h('a', { class: 'btn btn-primary', href: '#/docs/new/trip_sheet' }, 'Створити подорожній лист'),
    ];
}

// ТТН у рядку загального списку (поля як у kp_doc_list; оплат і боргу немає).
export function ttnListRow(r) {
    return {
        ...r, kind: 'ttn', currency: 'UAH', total: r.total_amount, paid: null, debt: null, due_date: null,
        pay_status: r.status === 'cancelled' ? 'cancelled' : 'issued',
    };
}

// Подорожній лист у рядку загального списку (суми, оплат і боргу немає).
export function tsListRow(r) {
    return { ...r, kind: 'trip_sheet', currency: 'UAH', total: null, paid: null, debt: null, due_date: null, pay_status: r.status };
}

// Статус фільтра → p_status для kp_trip_sheet_list: issued | closed | cancelled; решта (оплати) подорожніх листів не стосуються.
export function tsStatusFilter(status) {
    if (!status) return { include: true, value: null };
    if (status === 'issued' || status === 'closed' || status === 'cancelled') return { include: true, value: status };
    return { include: false, value: null };
}

// Статус фільтра → p_status для kp_ttn_list; null — ТТН у вибірку не потрапляють (оплати бувають лише в рахунків).
export function ttnStatusFilter(status) {
    if (!status) return { include: true, value: null };
    if (status === 'issued' || status === 'cancelled') return { include: true, value: status };
    return { include: false, value: null };
}

// Кнопка створення за вкладкою «Документів»: на кожній вкладці — лише свій вид (рахунок, акт, ТТН, подорожній лист), на решті їх немає.
export function createButtonsFor(tab) {
    const all = createButtons();
    const index = { invoices: 0, acts: 1, ttn: 2, trip_sheets: 3 }[tab];
    return index === undefined ? [] : [all[index]];
}

export { createButtons };

const STATUS_FILTERS = [
    { value: '', label: 'Усі статуси' },
    { value: 'unpaid', label: 'Неоплачені' },
    { value: 'issued', label: PAY_STATUS_LABELS.issued },
    { value: 'closed', label: 'Закрито (подорожній лист)' },
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

// Компактне inline-поле фільтра: підпис зліва, поле за змістом.
const labeled = (text, control) => h('label', { class: 'kpd-f' }, h('span', null, text), control);

function renderDocList(app, access, presetKind = '', tab = '') {
    const range = monthRange(kyivDate());
    const from = h('input', { type: 'date', value: range.from, 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', value: range.to, 'aria-label': 'Період по' });
    const kind = h('select', { 'aria-label': 'Тип документа' },
        h('option', { value: '' }, 'Усі документи'), h('option', { value: 'invoice' }, 'Рахунки'), h('option', { value: 'act' }, 'Акти'),
        h('option', { value: 'ttn' }, 'ТТН'), h('option', { value: 'trip_sheet' }, 'Подорожні листи'),
        h('option', { value: 'ttn_group' }, 'ТТН і подорожні листи'));
    kind.value = presetKind;
    const number = h('input', { type: 'search', placeholder: '№', 'aria-label': 'Номер документа', size: 8 });
    const vehicle = h('input', { type: 'search', placeholder: 'Авто / водій', 'aria-label': 'Авто або водій', size: 12 });
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
        const tsFilter = tsStatusFilter(status.value);
        const wantDocs = !['ttn', 'trip_sheet', 'ttn_group'].includes(kind.value);
        const wantTtn = ['', 'ttn', 'ttn_group'].includes(kind.value) && ttnFilter.include;
        const wantTs = ['', 'trip_sheet', 'ttn_group'].includes(kind.value) && tsFilter.include;
        const [docsRes, ttnRes, tsRes] = await Promise.all([
            wantDocs ? app.supabase.rpc('kp_doc_list', {
                p_kind: kind.value || null, p_from: from.value, p_to: to.value, p_client: client.value || null, p_status: status.value || null,
            }) : { data: [] },
            wantTtn ? app.supabase.rpc('kp_ttn_list', { p_from: from.value, p_to: to.value, p_client: client.value || null, p_status: ttnFilter.value }) : { data: [] },
            wantTs && !client.value ? app.supabase.rpc('kp_trip_sheet_list', { p_from: from.value, p_to: to.value, p_status: tsFilter.value }) : { data: [] },
        ]);
        if (docsRes.error) return showError(app, list, docsRes.error);
        // Міграцію 4b ще не застосовано: у «Усіх документах» — без ТТН, у фільтрі «ТТН» — пояснення.
        if (ttnRes.error && (kind.value === 'ttn' || !isMissingFeature(ttnRes.error))) {
            if (kind.value === 'ttn' && isMissingFeature(ttnRes.error)) return clear(list, notice('ТТН ще не ввімкнено для вашої компанії (міграцію бази етапу 4b не застосовано).', 'info'));
            return showError(app, list, ttnRes.error);
        }
        // Міграції подорожніх листів ще немає: у «Усіх» їх просто не видно, у фільтрі «Подорожні листи» — пояснення.
        if (tsRes.error && (kind.value === 'trip_sheet' || !isMissingFeature(tsRes.error))) {
            if (kind.value === 'trip_sheet' && isMissingFeature(tsRes.error)) return clear(list, notice('Подорожні листи ще не ввімкнено для вашої компанії (міграцію бази не застосовано).', 'info'));
            return showError(app, list, tsRes.error);
        }
        const rows = filterRows([...(docsRes.data || []), ...(ttnRes.error ? [] : (ttnRes.data || []).map(ttnListRow)), ...(tsRes.error ? [] : (tsRes.data || []).map(tsListRow))],
            { number: number.value, vehicle: vehicle.value })
            .sort((a, b) => String(b.doc_date).localeCompare(String(a.doc_date)) || String(a.kind).localeCompare(String(b.kind)) || Number(b.number) - Number(a.number));
        if (!rows.length) {
            clear(list, h('div', { class: 'empty' }, h('p', null, 'За цей період документів немає.'),
                access.canWrite && createButtonsFor(tab).length ? h('p', { class: 'muted small' }, 'Створіть документ кнопками вгорі.') : null));
            return;
        }
        const totals = listTotals(rows);
        const signed = await signedActs(app, rows);
        clear(list,
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Дата', '№', 'Тип', 'Клієнт', 'Сума', 'Оплачено', 'Борг', 'Строк', 'Статус', ''].map((t) => h('th', null, t)))),
                h('tbody', null, rows.map((r) => h('tr', { class: r.status === 'cancelled' ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Дата' }, fmtDate(r.doc_date)),
                    h('td', { 'data-label': '№', class: 'mono' }, h('a', { href: r.kind === 'ttn' ? '#/docs/ttn/' + r.id : r.kind === 'trip_sheet' ? '#/docs/trip_sheet/' + r.id : '#/docs/' + r.id }, docNumberText(r))),
                    h('td', { 'data-label': 'Тип' }, r.kind === 'act' ? h('span', { class: 'kpd-kind kpd-kind-act' }, 'Акт')
                        : r.kind === 'trip_sheet' ? h('span', { class: 'kpd-kind kpd-kind-ts' }, 'Подорожній') : (DOC_KIND_LABELS[r.kind] || r.kind),
                        (r.kind === 'ttn' || r.kind === 'trip_sheet') && r.vehicle_reg ? h('span', { class: 'muted small' }, ' · ' + r.vehicle_reg) : null),
                    h('td', { 'data-label': 'Клієнт' }, h('a', { href: '#/clients/' + r.client_id }, r.client_name || '—')),
                    h('td', { 'data-label': 'Сума', class: 'mono' }, r.total === null || r.total === undefined ? '—' : h('b', null, fmtAmount(r.total, r.currency))),
                    h('td', { 'data-label': 'Оплачено', class: 'mono' }, r.kind === 'invoice' ? fmtAmount(r.paid, r.currency) : '—'),
                    h('td', { 'data-label': 'Борг', class: 'mono' }, r.debt === null || r.debt === undefined ? '—' : fmtAmount(r.debt, r.currency)),
                    h('td', { 'data-label': 'Строк' }, r.due_date ? fmtDate(r.due_date) : '—'),
                    h('td', { 'data-label': 'Статус' }, statusBadge(r.pay_status, r.kind, signed.has(r.id))),
                    h('td', { 'data-label': '' }, h('div', { class: 'actions' },
                        pdfButton(app, r.id, 'PDF', 'btn btn-sm', r.kind === 'ttn' || r.kind === 'trip_sheet' ? r.kind : null),
                        excelButton(app, r.id, r.kind === 'ttn' || r.kind === 'trip_sheet' ? r.kind : null),
                        access.isOwner && r.status === 'issued' ? cancelControl(app, r, load) : null))))))),
            Object.keys(totals).length
                ? h('p', { class: 'muted small' }, 'Активні рахунки у списку: ', Object.entries(totals).map(([cur, t], i) => [
                    i ? ' · ' : '', h('b', null, fmtAmount(t.total, cur)), ', борг ', h('b', null, fmtAmount(t.debt, cur))]))
                : null);
    }

    for (const el of [from, to, kind, status, client]) el.addEventListener('change', load);
    for (const el of [number, vehicle]) el.addEventListener('input', () => { clearTimeout(el.timer); el.timer = setTimeout(load, 250); });
    loadClients().then(load, load);
    return h('div', null,
        h('div', { class: 'toolbar kpd-filters' }, labeled('Період з', from), labeled('по', to), presetKind ? null : labeled('Тип', kind), labeled('Статус', status), labeled('Клієнт', client),
            labeled('Номер', number), ['ttn', 'trip_sheet'].includes(presetKind) ? labeled('Авто / водій', vehicle) : null),
        access.canWrite && createButtonsFor(tab).length ? h('div', { class: 'toolbar' }, createButtonsFor(tab), requestPicker(app, presetKind, { compact: true })) : null,
        list);
}

export function renderDocs(app, route) {
    const access = docsAccess(app.context);
    const sub = route.sub || 'list';
    // Картки й форми ТТН / подорожнього листа лежать у підвкладці «ТТН / Подорожній лист», а не в «Усі».
    const cardTab = { ttn: 'ttn', trip_sheet: 'trip_sheets', act: 'acts', invoice: 'invoices' }[sub === 'new' ? route.kind : sub];
    const currentKey = route.tab || cardTab || 'all';
    let body;
    if (sub === 'new' && !access.canWrite) body = notice('Створювати документи можуть власник і логіст.', 'info');
    else if (sub === 'new' && route.kind === 'ttn') body = renderTtnForm(app, access, route);
    else if (sub === 'new' && route.kind === 'trip_sheet') body = renderTripSheetForm(app, access, route);
    else if (sub === 'new') body = renderDocForm(app, access, route);
    else if (sub === 'doc') body = renderDocCard(app, access, route.id);
    else if (sub === 'ttn') body = renderTtnCard(app, access, route.id);
    else if (sub === 'trip_sheet') body = renderTripSheetCard(app, access, route.id);
    else if (EMPTY_TABS[route.tab]) body = h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', null, EMPTY_TABS[route.tab][0]), h('p', { class: 'muted' }, EMPTY_TABS[route.tab][1])));
    else body = renderDocList(app, access, TAB_KIND[route.tab] || '', route.tab || '');
    return h('section', { class: 'page kpr-page kpd-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Документи')),
        h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи документів' }, docsTabs().map((t) =>
            h('a', { href: t.hash, class: 'kpr-tab' + (t.key === currentKey ? ' on' : ''), 'aria-current': t.key === currentKey ? 'page' : null }, t.label))),
        access.canWrite ? null : notice('Режим перегляду: директор бачить документи, ТТН, оплати, борги й авто, але не змінює їх.', 'info'),
        body);
}
