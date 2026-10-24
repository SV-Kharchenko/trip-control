// Підрозділ «Вартість на км» (етап 3b): витрати на ремонти (запчастини + СТО, без сторно) / км рейсів за період.
// Період — Місяць / Квартал / Рік / Свій (Київ), за замовчуванням поточний місяць. Рахує база (kp_repair_cost_per_km).
import { h, clear, spinner, notice, download } from '../ui.js';
import { fmtMoney, fmtNumber, fmtDate, kyivDate } from '../lib/format.js';
import { toCsv, csvFileName } from '../lib/csv.js';
import { repairErrorText } from '../lib/repairs.js';
import { PERIODS, periodRange, periodError, costTotals, perKmText, COST_CSV_HEADER, costCsvRows } from '../lib/maintenance.js';

export function costTable(rows) {
    const t = costTotals(rows);
    return h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Авто', 'Ремонтів', 'Запчастини', 'СТО', 'Витрати', 'Км', '₴/км'].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((r) => h('tr', null,
            h('td', { 'data-label': 'Авто' }, r.vehicle_label),
            h('td', { 'data-label': 'Ремонтів', class: 'mono' }, fmtNumber(r.repairs_count)),
            h('td', { 'data-label': 'Запчастини', class: 'mono' }, fmtMoney(r.parts_cost)),
            h('td', { 'data-label': 'СТО', class: 'mono' }, fmtMoney(r.service_cost)),
            h('td', { 'data-label': 'Витрати', class: 'mono' }, h('b', null, fmtMoney(r.cost))),
            h('td', { 'data-label': 'Км', class: 'mono' }, fmtNumber(r.km)),
            h('td', { 'data-label': '₴/км', class: 'mono' + (r.cost_per_km === null ? ' muted' : '') }, perKmText(r.cost_per_km))))),
        h('tfoot', null, h('tr', null,
            h('td', { 'data-label': '' }, h('b', null, 'Разом')),
            h('td', { 'data-label': 'Ремонтів', class: 'mono' }, fmtNumber(rows.reduce((s, r) => s + Number(r.repairs_count || 0), 0))),
            h('td', { 'data-label': 'Запчастини', class: 'mono' }, fmtMoney(t.parts)),
            h('td', { 'data-label': 'СТО', class: 'mono' }, fmtMoney(t.service)),
            h('td', { 'data-label': 'Витрати', class: 'mono' }, h('b', null, fmtMoney(t.cost))),
            h('td', { 'data-label': 'Км', class: 'mono' }, fmtNumber(t.km)),
            h('td', { 'data-label': '₴/км', class: 'mono' }, h('b', null, perKmText(t.perKm)))))));
}

export function renderCost(app) {
    let kind = 'month';
    let rows = [];
    const month = periodRange('month', kyivDate());
    const from = h('input', { type: 'date', value: month.from, 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', value: month.to, 'aria-label': 'Період по' });
    const custom = h('div', { class: 'toolbar', hidden: true }, from, to);
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Період' });
    const caption = h('p', { class: 'muted small' });
    const list = h('div', { class: 'list' });
    const exportBtn = h('button', { type: 'button', class: 'btn btn-ghost', disabled: true }, 'Експорт CSV');

    const range = () => periodRange(kind, kyivDate(), { from: from.value, to: to.value });

    function drawGroup() {
        clear(group, PERIODS.map((p) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(p.value === kind), class: p.value === kind ? 'is-on' : '',
            onclick: () => { kind = p.value; custom.hidden = kind !== 'custom'; drawGroup(); load(); },
        }, p.label)));
    }

    async function load() {
        const r = range();
        const problem = periodError(r);
        exportBtn.disabled = true;
        caption.textContent = r.from && r.to ? 'Період: ' + fmtDate(r.from) + ' — ' + fmtDate(r.to) : '';
        if (problem) return clear(list, notice(problem, 'info'));
        clear(list, spinner());
        const { data, error } = await app.supabase.rpc('kp_repair_cost_per_km', { p_from: r.from, p_to: r.to, p_vehicle: null });
        if (error) return clear(list, notice(repairErrorText(error)));
        rows = data || [];
        if (!rows.length) return clear(list, h('div', { class: 'empty' }, h('p', null, 'За цей період немає ні ремонтів, ні рейсів.')));
        exportBtn.disabled = false;
        clear(list, costTable(rows),
            h('p', { class: 'muted small' }, 'Витрати — запчастини (за собівартістю списання, без сторно) і СТО проведених ремонтів. '
                + 'Км — з прийнятих і виконаних рейсів (факт, якщо внесено, інакше план), частка авто — за його плановим пробігом.'));
    }

    exportBtn.addEventListener('click', () => {
        const r = range();
        download(csvFileName('vartist-km', r.from, r.to), toCsv(COST_CSV_HEADER, costCsvRows(rows)));
    });
    for (const el of [from, to]) el.addEventListener('change', load);
    drawGroup();
    load();
    return h('div', null, h('div', { class: 'toolbar' }, group, exportBtn), custom, caption, list);
}
