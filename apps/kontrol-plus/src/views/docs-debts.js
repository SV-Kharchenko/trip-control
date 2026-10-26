// «Борги клієнтів»: активні рахунки на дату (за замовчуванням — сьогодні за Києвом). Окремий рядок на кожну валюту
// клієнта; прострочено — строк оплати минув, а борг лишився. Сортування — за прострочкою, боргом, днями або назвою.
import { h, clear, spinner } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { debtTotals, fmtAmount, sortDebts } from '../lib/docs.js';
import { showError } from './docs.js';

const SORTS = [
    { value: 'overdue', label: 'Прострочка' },
    { value: 'debt', label: 'Борг' },
    { value: 'days', label: 'Днів прострочки' },
    { value: 'name', label: 'Клієнт' },
];

export function renderDebts(app) {
    const onDate = h('input', { type: 'date', value: kyivDate(), 'aria-label': 'Борги на дату' });
    const sort = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Сортування' });
    const onlyDebt = h('input', { type: 'checkbox', id: 'kpd-only-debt', checked: true });
    const list = h('div', { class: 'list' }, spinner());
    let current = 'overdue';
    let rows = [];

    function drawSort() {
        clear(sort, SORTS.map((s) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(s.value === current), class: s.value === current ? 'is-on' : '',
            onclick: () => { current = s.value; drawSort(); draw(); },
        }, s.label)));
    }

    function draw() {
        const visible = sortDebts(rows.filter((r) => !onlyDebt.checked || Number(r.debt) > 0), current);
        if (!visible.length) {
            clear(list, h('p', { class: 'muted empty' }, rows.length ? 'Боргів немає — усі рахунки оплачено.' : 'Активних рахунків ще немає.'));
            return;
        }
        const totals = debtTotals(visible);
        clear(list, h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table kpd-debts' },
            h('thead', null, h('tr', null, ['Клієнт', 'Валюта', 'Рахунків', 'Виставлено', 'Оплачено', 'Борг', 'Прострочено', 'Найстаріша прострочка'].map((t) => h('th', null, t)))),
            h('tbody', null, visible.map((r) => h('tr', { class: Number(r.overdue) > 0 ? 'kpr-row-red' : '' },
                h('td', { 'data-label': 'Клієнт' }, h('a', { href: '#/clients/' + r.client_id }, r.client_name)),
                h('td', { 'data-label': 'Валюта' }, r.currency),
                h('td', { 'data-label': 'Рахунків', class: 'mono' }, String(r.invoices)),
                h('td', { 'data-label': 'Виставлено', class: 'mono' }, fmtAmount(r.invoiced, r.currency)),
                h('td', { 'data-label': 'Оплачено', class: 'mono' }, fmtAmount(r.paid, r.currency)),
                h('td', { 'data-label': 'Борг', class: 'mono' }, h('b', null, fmtAmount(r.debt, r.currency))),
                h('td', { 'data-label': 'Прострочено', class: 'mono' + (Number(r.overdue) > 0 ? ' neg' : '') }, Number(r.overdue) > 0 ? fmtAmount(r.overdue, r.currency) : '—'),
                h('td', { 'data-label': 'Найстаріша прострочка' }, r.oldest_due ? fmtDate(r.oldest_due) + ' (' + r.overdue_days + ' дн.)' : '—')))),
            h('tfoot', null, Object.entries(totals).map(([cur, t]) => h('tr', null,
                h('td', { 'data-label': '' }, 'Разом, ' + cur), h('td', { 'data-label': 'Валюта' }, cur), h('td', { 'data-label': '' }, ''),
                h('td', { 'data-label': 'Виставлено', class: 'mono' }, fmtAmount(t.invoiced, cur)),
                h('td', { 'data-label': 'Оплачено', class: 'mono' }, fmtAmount(t.paid, cur)),
                h('td', { 'data-label': 'Борг', class: 'mono' }, fmtAmount(t.debt, cur)),
                h('td', { 'data-label': 'Прострочено', class: 'mono' }, fmtAmount(t.overdue, cur)),
                h('td', { 'data-label': '' }, '')))))));
    }

    async function load() {
        clear(list, spinner());
        const { data, error } = await app.supabase.rpc('kp_client_debts', { p_on: onDate.value || null });
        if (error) return showError(app, list, error);
        rows = data || [];
        draw();
    }

    onDate.addEventListener('change', load);
    onlyDebt.addEventListener('change', draw);
    drawSort();
    load();
    return h('div', null,
        h('div', { class: 'toolbar' }, h('label', null, 'На дату ', onDate), sort,
            h('label', { class: 'check', for: 'kpd-only-debt' }, onlyDebt, ' Лише з боргом')),
        list,
        h('p', { class: 'muted small' }, 'Рахуються активні (не анульовані) рахунки й оплати до обраної дати. Суми різних валют не додаються.'));
}
