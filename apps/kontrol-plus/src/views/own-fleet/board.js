// Диспетчерська дошка «Власного парку»: канбан по статусах, список-реєстр, фільтри (дата, підрозділ, пріоритет), лічильники в шапці.
// Замовник підрозділу бачить той самий список, але лише своїх заявок (RLS), без дошки й фільтра підрозділу.
import { h, clear, notice, spinner } from '../../ui.js';
import {
    BOARD_COLUMNS, PRIORITIES, PRIORITY_LABELS, STATUS_LABELS, boardGroups, counters, filterRequests, fmtWhen, isOverdue, ownFleetErrorText, routeText,
} from '../../lib/own-fleet.js';
import { kyivDate } from '../../lib/format.js';
import { loadAll, nameOf, onRegistryChanged } from './data.js';

const VIEW_KEY = 'tc_kp_own_fleet_view';

function savedView() {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}
function saveView(view) {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* сховище заблоковане */ }
}

function priorityBadge(priority) {
    if (priority === 'normal') return null;
    return h('span', { class: 'kpof-badge kpof-prio-' + priority }, PRIORITY_LABELS[priority]);
}

function requestCard(r, ctx) {
    const overdue = isOverdue(r, ctx.now);
    return h('a', { class: 'kpof-card' + (overdue ? ' kpof-overdue' : '') + (r.priority === 'urgent' ? ' kpof-urgent' : ''), href: '#/own-fleet/request/' + r.id,
        'data-request': r.id },
    h('div', { class: 'kpof-card-top' }, h('b', null, '№ ' + r.number), priorityBadge(r.priority),
        overdue ? h('span', { class: 'kpof-badge kpof-late' }, 'Прострочена') : null),
    h('div', { class: 'kpof-card-cargo' }, r.cargo + (r.qty_t ? ' · ' + String(r.qty_t).replace('.', ',') + ' т' : '')),
    h('div', { class: 'kpof-card-route muted small' }, routeText(r, ctx.points)),
    h('div', { class: 'kpof-card-meta small' }, h('span', null, fmtWhen(r.wanted_at)), h('span', { class: 'muted' }, nameOf(ctx.units, r.unit_id))),
    r.vehicle_label ? h('div', { class: 'kpof-card-res small' }, r.vehicle_label + (r.trailer_label ? ' + ' + r.trailer_label : '') + ' · ' + (r.driver_name || '')) : null);
}

function board(groups, ctx) {
    const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 699px)').matches;
    return h('div', { class: 'kpof-board' }, BOARD_COLUMNS.map((status) => {
        const rows = groups[status];
        const col = h('details', { class: 'kpof-col kpof-col-' + status, open: narrow() ? (status === 'new' || status === 'accepted') : true },
            h('summary', { class: 'kpof-col-head', onclick: (event) => { if (!narrow()) event.preventDefault(); } },
                h('span', null, STATUS_LABELS[status] + (status === 'done' ? ' (сьогодні)' : '')), h('span', { class: 'kpof-count' }, String(rows.length))),
            h('div', { class: 'kpof-col-body' }, rows.length ? rows.map((r) => requestCard(r, ctx)) : h('p', { class: 'muted small kpof-empty' }, 'Немає заявок')));
        return col;
    }));
}

function registry(rows, ctx) {
    if (!rows.length) return h('p', { class: 'muted' }, 'Заявок за цими фільтрами немає.');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table kpof-table' },
        h('thead', null, h('tr', null, ['Заявка', 'Підрозділ', 'Вантаж', 'Маршрут', 'Бажаний час', 'Пріоритет', 'Статус', 'Авто / водій'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.slice().sort((a, b) => b.number - a.number).map((r) => h('tr', { class: isOverdue(r, ctx.now) ? 'kpof-overdue' : '' },
            h('td', { 'data-label': 'Заявка' }, h('a', { href: '#/own-fleet/request/' + r.id }, '№ ' + r.number)),
            h('td', { 'data-label': 'Підрозділ' }, nameOf(ctx.units, r.unit_id)),
            h('td', { 'data-label': 'Вантаж' }, r.cargo + (r.qty_t ? ' · ' + String(r.qty_t).replace('.', ',') + ' т' : '')),
            h('td', { 'data-label': 'Маршрут' }, routeText(r, ctx.points)),
            h('td', { 'data-label': 'Бажаний час' }, fmtWhen(r.wanted_at)),
            h('td', { 'data-label': 'Пріоритет' }, PRIORITY_LABELS[r.priority]),
            h('td', { 'data-label': 'Статус' }, STATUS_LABELS[r.status] + (r.status === 'cancelled' && r.cancel_reason ? ': ' + r.cancel_reason : '')),
            h('td', { 'data-label': 'Авто / водій' }, r.vehicle_label ? r.vehicle_label + ' · ' + (r.driver_name || '') : '—'))))));
}

// access — ownFleetAccess(); mode: 'board' | 'list'.
export function renderBoard(app, access, mode) {
    const root = h('div', { class: 'kpof-board-page' }, spinner());
    const filters = { date: '', unitId: '', priority: '' };
    let data = null;

    function paint() {
        const now = Date.now();
        const rows = filterRequests(data.requests, filters);
        const ctx = { now, units: data.units, points: data.points };
        const c = counters(data.requests, now);
        const stat = (label, n, cls, title) => h('span', { class: 'kpof-stat ' + cls + (n ? ' on' : ''), title }, h('b', null, String(n)), ' ' + label);
        const unitSel = h('select', { 'aria-label': 'Підрозділ', onchange: (e) => { filters.unitId = e.target.value; paint(); } },
            h('option', { value: '' }, 'Усі підрозділи'), data.units.filter((u) => !u.archived).map((u) => h('option', { value: u.id, selected: u.id === filters.unitId }, u.name)));
        const prioSel = h('select', { 'aria-label': 'Пріоритет', onchange: (e) => { filters.priority = e.target.value; paint(); } },
            h('option', { value: '' }, 'Будь-який пріоритет'), PRIORITIES.map((p) => h('option', { value: p, selected: p === filters.priority }, PRIORITY_LABELS[p])));
        const date = h('input', { type: 'date', 'aria-label': 'Бажана дата', value: filters.date, onchange: (e) => { filters.date = e.target.value; paint(); } });
        const modeBtn = (key, label) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === key), class: mode === key ? 'is-on' : '',
            onclick: () => { if (mode === key) return; mode = key; saveView(key); paint(); } }, label);
        const groups = boardGroups(data.requests, filters, now);
        clear(root,
            h('div', { class: 'kpof-head' },
                h('div', { class: 'kpof-stats', 'aria-label': 'Лічильники' },
                    stat('нових', c.new, 'kpof-stat-new', 'Заявки зі статусом «Нова»'), stat('термінових', c.urgent, 'kpof-stat-urgent', 'Активні з пріоритетом «Терміново»'),
                    stat('прострочених', c.overdue, 'kpof-stat-late', 'Бажаний час минув, а рейс ще не почався')),
                h('div', { class: 'kpof-actions' },
                    h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Вигляд' }, modeBtn('board', 'Дошка'), modeBtn('list', 'Список')),
                    h('a', { class: 'btn btn-primary', href: '#/own-fleet/request/new' }, '+ Нова заявка'),
                    h('button', { type: 'button', class: 'btn', onclick: load }, 'Оновити'))),
            h('div', { class: 'kpof-filters' }, date, unitSel, prioSel,
                filters.date || filters.unitId || filters.priority
                    ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { filters.date = ''; filters.unitId = ''; filters.priority = ''; paint(); } }, 'Скинути')
                    : null),
            mode === 'board' ? board(groups, ctx) : registry(rows, ctx));
    }

    async function load() {
        const result = await loadAll(app);
        if (result.error) {
            clear(root, notice(ownFleetErrorText(result.error)));
            return;
        }
        data = result;
        paint();
    }

    onRegistryChanged(app, load);
    mode = mode || savedView();
    load();
    return root;
}

// Замовник підрозділу: «Власний парк → Заявки» свого підрозділу.
export function renderRequesterList(app, access) {
    const root = h('div', { class: 'kpof-board-page' }, spinner());
    let data = null;
    function paint() {
        const ctx = { now: Date.now(), units: data.units, points: data.points };
        const c = counters(data.requests, ctx.now);
        clear(root,
            h('div', { class: 'kpof-head' },
                h('div', { class: 'kpof-stats' }, h('span', { class: 'kpof-stat' + (c.new ? ' on' : '') }, h('b', null, String(c.new)), ' нових'),
                    h('span', { class: 'kpof-stat' + (c.overdue ? ' on kpof-stat-late' : '') }, h('b', null, String(c.overdue)), ' прострочених')),
                h('div', { class: 'kpof-actions' }, data.units.length
                    ? h('a', { class: 'btn btn-primary', href: '#/own-fleet/request/new' }, '+ Нова заявка') : null,
                h('button', { type: 'button', class: 'btn', onclick: load }, 'Оновити'))),
            data.units.length ? null : notice('Вас ще не додано до жодного підрозділу. Зверніться до директора компанії.', 'info'),
            registry(data.requests, ctx));
    }
    async function load() {
        const result = await loadAll(app);
        if (result.error) { clear(root, notice(ownFleetErrorText(result.error))); return; }
        data = result;
        paint();
    }
    onRegistryChanged(app, load);
    load();
    return root;
}

export const todayKyiv = () => kyivDate();
