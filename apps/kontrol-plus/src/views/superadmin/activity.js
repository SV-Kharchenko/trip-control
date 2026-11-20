// Вкладка «Активність» кабінету суперадміна: хто із зареєстрованих користувачів реально працює. Дані — лише sa_list_user_activity()
// (SECURITY DEFINER, перша перевірка is_platform_superadmin()); тут тільки відображення, фільтри й сортування на клієнті.
import { h, clear, notice, spinner } from '../../ui.js';
import { planLabel, superadminErrorText } from '../../lib/superadmin.js';
import {
    ACTIVITY_COLUMNS, ACTIVITY_STATUSES, DEFAULT_SORT, activityCounts, activityStatus, filterActivity, formatKyivStamp, nextSort, roleLabel, sortActivity, statusLabel, yesNo,
} from '../../lib/sa-activity.js';

const PAGE = 200;

export function renderActivity(app) {
    let rows = [];
    let filters = { status: '', q: '' };
    let sort = { ...DEFAULT_SORT };
    let shown = PAGE;
    const box = h('div', { class: 'kpsa-box', id: 'kpsa-activity' }, spinner());
    const counters = h('div', { class: 'kpsa-counters', role: 'group', 'aria-label': 'Фільтр за статусом' });
    const list = h('div', { class: 'kpsa-act-list' });
    const q = h('input', { type: 'search', placeholder: 'Email або компанія', 'aria-label': 'Пошук за email або компанією', maxlength: 80, class: 'kpsa-act-q',
        oninput: () => { filters = { ...filters, q: q.value }; shown = PAGE; drawList(); } });
    const sortSelect = h('select', { class: 'kpsa-sort-select', 'aria-label': 'Сортування', onchange: () => setSort({ key: sortSelect.value, dir: sortDir(sortSelect.value) }) },
        ACTIVITY_COLUMNS.map((c) => h('option', { value: c.key }, c.label)));
    const sortDirBtn = h('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'sort-dir', onclick: () => setSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }) }, '↓');
    const sortbar = h('div', { class: 'kpsa-sortbar' }, h('span', { class: 'muted small' }, 'Сортування'), sortSelect, sortDirBtn);
    const head = h('div', { class: 'kpsa-head kpsa-act kpsa-act-head', role: 'row' }, ACTIVITY_COLUMNS.map((c) => h('button', {
        type: 'button', class: 'kpsa-th', 'data-sort': c.key, onclick: () => setSort(nextSort(sort, c.key)),
    }, c.label, h('span', { class: 'kpsa-th-arrow', 'aria-hidden': 'true' }))), h('span', { class: 'kpsa-th kpsa-th-static' }, 'Статус'));

    const sortDir = (key) => (sort.key === key ? sort.dir : nextSort(sort, key).dir);
    function setSort(next) {
        sort = next;
        shown = PAGE;
        drawList();
    }

    function drawCounters() {
        const counts = activityCounts(rows);
        const chip = (key, label, count) => h('button', { type: 'button', class: 'kpsa-chip kpsa-chip-' + (key || 'all') + (filters.status === key ? ' is-on' : ''), 'data-status': key || 'all',
            'aria-pressed': String(filters.status === key), onclick: () => { filters = { ...filters, status: filters.status === key ? '' : key }; shown = PAGE; drawCounters(); drawList(); } },
        h('b', null, String(count)), ' ' + label);
        clear(counters, chip('', 'Усі', rows.length), ACTIVITY_STATUSES.map((s) => chip(s.key, s.label, counts[s.key])));
    }

    function rowEl(r, now) {
        const status = activityStatus(r, now);
        const cell = (label, ...children) => h('div', { class: 'kpsa-cell', 'data-label': label }, ...children);
        return h('div', { class: 'kpsa-row kpsa-act', role: 'listitem', 'data-user': r.user_id, 'data-status': status },
            h('div', { class: 'kpsa-main kpsa-act-email', 'data-label': 'Email' }, h('b', null, r.email || '—')),
            cell('Компанія', r.org_name || '—'),
            cell('Тариф', r.org_id ? planLabel(r.org_plan) : '—'),
            cell('Роль', roleLabel(r.org_role)),
            cell('Реєстрація', formatKyivStamp(r.registered_at)),
            cell('Пошта підтверджена', yesNo(r.email_confirmed_at)),
            cell('Останній вхід', formatKyivStamp(r.last_sign_in_at)),
            cell('За 7 днів', String(r.calcs_7d ?? 0)),
            cell('За 30 днів', String(r.calcs_30d ?? 0)),
            cell('Усього', String(r.calcs_total ?? 0)),
            cell('Остання дія', formatKyivStamp(r.last_activity_at)),
            h('div', { class: 'kpsa-cell', 'data-label': 'Статус' }, h('span', { class: 'kpsa-state kpsa-act-' + status, 'data-state': status }, statusLabel(status))));
    }

    function drawList() {
        const now = Date.now();
        const found = sortActivity(filterActivity(rows, filters, now), sort);
        const visible = found.slice(0, shown);
        sortSelect.value = sort.key;
        sortDirBtn.textContent = sort.dir === 'asc' ? '↑' : '↓';
        sortDirBtn.setAttribute('aria-label', sort.dir === 'asc' ? 'За зростанням' : 'За спаданням');
        for (const th of head.querySelectorAll('.kpsa-th[data-sort]')) {
            const on = th.getAttribute('data-sort') === sort.key;
            th.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
            th.querySelector('.kpsa-th-arrow').textContent = on ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
        }
        clear(list,
            h('div', { class: 'muted small kpsa-act-count', 'aria-live': 'polite' }, 'Показано ' + visible.length + ' з ' + rows.length + (found.length !== visible.length ? ' (знайдено ' + found.length + ')' : '')),
            visible.length ? h('div', { class: 'kpsa-list', role: 'list' }, visible.map((r) => rowEl(r, now))) : h('p', { class: 'muted' }, 'Нічого не знайдено.'),
            found.length > visible.length ? h('div', { class: 'kpsa-pager' }, h('button', { type: 'button', class: 'btn', 'data-act': 'more', onclick: () => { shown += PAGE; drawList(); } }, 'Показати ще')) : null);
    }

    async function load() {
        clear(box, spinner());
        const { data, error } = await app.supabase.rpc('sa_list_user_activity', { p_days: 30 });
        if (error) {
            clear(box, notice(superadminErrorText(error)), h('button', { type: 'button', class: 'btn', 'data-act': 'reload', onclick: load }, 'Повторити'));
            return;
        }
        rows = data || [];
        clear(box,
            h('div', { class: 'kpsa-act-bar' }, counters, h('button', { type: 'button', class: 'btn', 'data-act': 'reload', onclick: load }, 'Оновити')),
            h('div', { class: 'kpsa-search' }, q),
            sortbar, head, list);
        drawCounters();
        drawList();
    }

    load();
    return box;
}
