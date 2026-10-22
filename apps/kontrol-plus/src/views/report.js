import { h, clear, spinner, notice, download } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { toCsv, csvFileName } from '../lib/csv.js';
import { fmtMoney, fmtPct, num, kyivDate, monthRange, daysBetween } from '../lib/format.js';

export const GROUPS = [
    { value: 'logist', label: 'Логісти' },
    { value: 'vehicle', label: 'Авто' },
    { value: 'client', label: 'Клієнти' },
    { value: 'direction', label: 'Напрямки (шаблони)' },
];

const COLUMNS = [
    { key: 'trips', label: 'Рейсів', type: 'int' },
    { key: 'trips_with_fact', label: 'З фактом', type: 'int' },
    { key: 'plan_revenue', label: 'План: дохід' },
    { key: 'plan_costs', label: 'План: витрати' },
    { key: 'plan_profit', label: 'План: прибуток' },
    { key: 'fact_revenue', label: 'Факт: дохід' },
    { key: 'fact_costs', label: 'Факт: витрати' },
    { key: 'fact_profit', label: 'Факт: прибуток' },
    { key: 'deviation_profit', label: 'Відхилення прибутку' },
    { key: 'deviation_pct', label: 'Відхилення, %', type: 'pct' },
];

// Підсумок: суми; відсоток — від плану рейсів, що мають факт (як у рядках на сервері).
export function totals(rows) {
    const total = { group_label: 'Разом' };
    for (const c of COLUMNS) if (c.type !== 'pct') total[c.key] = rows.reduce((s, r) => s + (num(r[c.key]) || 0), 0);
    const base = rows.reduce((s, r) => s + (num(r.plan_profit_with_fact) || 0), 0);
    total.deviation_pct = total.trips_with_fact && base !== 0 ? Math.round((total.deviation_profit / Math.abs(base)) * 1000) / 10 : null;
    return total;
}

export function reportCsv(rows, groupLabel) {
    const header = [groupLabel, ...COLUMNS.map((c) => c.label)];
    const line = (r) => [r.group_label, ...COLUMNS.map((c) => num(r[c.key]))];
    return toCsv(header, [...rows.map(line), line(totals(rows))]);
}

export function renderReport(app) {
    const saved = readPrefs();
    const range = monthRange(kyivDate());
    const from = h('input', { type: 'date', id: 'r-from', value: saved.from || range.from });
    const to = h('input', { type: 'date', id: 'r-to', value: saved.to || range.to });
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Групування' });
    let current = GROUPS.some((g) => g.value === saved.group) ? saved.group : 'logist';
    const result = h('div', null);
    const exportBtn = h('button', { type: 'button', class: 'btn btn-ghost', disabled: true }, 'Експорт CSV');
    let rows = [];

    function drawGroups() {
        clear(group, GROUPS.map((g) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(g.value === current),
            class: g.value === current ? 'is-on' : '',
            onclick: () => { current = g.value; drawGroups(); load(); },
        }, g.label)));
    }

    function setPeriod(kind) {
        const today = kyivDate();
        if (kind === 'month') Object.assign(range, monthRange(today));
        if (kind === 'prev') {
            const [y, m] = today.split('-').map(Number);
            const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
            Object.assign(range, monthRange(prev));
        }
        if (kind === 'year') Object.assign(range, { from: today.slice(0, 4) + '-01-01', to: today });
        from.value = range.from;
        to.value = range.to;
        load();
    }

    async function load() {
        exportBtn.disabled = true;
        if (!from.value || !to.value || from.value > to.value || daysBetween(from.value, to.value) > 731) {
            clear(result, notice('Перевірте період: «з» не пізніше «по», не довше двох років.'));
            return;
        }
        writePrefs({ from: from.value, to: to.value, group: current });
        clear(result, spinner('Рахуємо…'));
        const { data, error } = await app.supabase.rpc('report_plan_fact', { p_from: from.value, p_to: to.value, p_group: current });
        if (error) {
            if (isPlanError(error)) return app.onPlanLost();
            clear(result, notice(errorText(error)));
            return;
        }
        rows = data || [];
        draw();
    }

    function draw() {
        const groupLabel = GROUPS.find((g) => g.value === current).label;
        if (!rows.length) {
            clear(result, h('p', { class: 'muted empty' }, 'За період немає прийнятих чи виконаних рейсів.'));
            return;
        }
        exportBtn.disabled = false;
        const total = totals(rows);
        const cellFor = (r, c) => {
            const v = r[c.key];
            if (c.type === 'int') return h('td', null, String(num(v) || 0));
            if (c.type === 'pct') return h('td', { class: signClass(v) }, fmtPct(v));
            const cls = c.key === 'deviation_profit' ? signClass(r.trips_with_fact ? v : null) : null;
            return h('td', { class: cls }, c.key.startsWith('fact_') && !num(r.trips_with_fact) ? '—' : fmtMoney(v));
        };
        clear(result,
            h('div', { class: 'stats' },
                stat('Рейсів', `${total.trips} (з фактом ${total.trips_with_fact})`),
                stat('План: прибуток', fmtMoney(total.plan_profit)),
                stat('Факт: прибуток', total.trips_with_fact ? fmtMoney(total.fact_profit) : '—'),
                stat('Відхилення', total.trips_with_fact ? fmtMoney(total.deviation_profit) + ' · ' + fmtPct(total.deviation_pct) : '—')),
            h('div', { class: 'table-wrap' }, h('table', { class: 'table table-num report' },
                h('thead', null, h('tr', null, h('th', { class: 'text' }, groupLabel), COLUMNS.map((c) => h('th', null, c.label)))),
                h('tbody', null, rows.map((r) => h('tr', { class: r.group_key === 'none' ? 'is-none' : '' },
                    h('th', { scope: 'row', class: 'text' }, r.group_label), COLUMNS.map((c) => cellFor(r, c))))),
                h('tfoot', null, h('tr', null, h('th', { scope: 'row', class: 'text' }, 'Разом'), COLUMNS.map((c) => cellFor(total, c)))))),
            h('p', { class: 'muted small' },
                'Рейси зі статусом «Прийнято» або «Виконано» з датою рейсу в періоді. Відхилення — лише по рейсах з внесеним фактом: ',
                'факт прибутку мінус план цих же рейсів. Витрати факту включають заплановані накладні.',
                current === 'vehicle' ? ' Рейс з кількома авто ділиться між ними пропорційно тоннажу (без тоннажу — порівну).' : '',
                current === 'direction' ? ' Напрямок — шаблон маршруту з такою ж назвою, як у рейсу (копії рейсів теж); інші — «Без шаблону».' : ''));
    }

    exportBtn.addEventListener('click', () => {
        const groupLabel = GROUPS.find((g) => g.value === current).label;
        download(csvFileName('plan-fakt_' + current, from.value, to.value), reportCsv(rows, groupLabel));
    });
    from.addEventListener('change', load);
    to.addEventListener('change', load);
    drawGroups();
    load();

    return h('section', { class: 'page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Звіт план/факт'), exportBtn),
        h('div', { class: 'toolbar' },
            h('label', { for: 'r-from' }, 'З'), from, h('label', { for: 'r-to' }, 'по'), to,
            h('div', { class: 'quick' },
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setPeriod('month') }, 'Цей місяць'),
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setPeriod('prev') }, 'Минулий'),
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setPeriod('year') }, 'З початку року'))),
        group,
        result);
}

function stat(label, value) {
    return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(value)));
}

function signClass(value) {
    const n = num(value);
    if (n === null || n === 0) return null;
    return n > 0 ? 'pos' : 'neg';
}

// Період і групування — лише зручність цього браузера.
function readPrefs() {
    try {
        return JSON.parse(localStorage.getItem('kp-report') || '{}') || {};
    } catch {
        return {};
    }
}

function writePrefs(prefs) {
    try {
        localStorage.setItem('kp-report', JSON.stringify(prefs));
    } catch {
        // приватний режим / заблоковане сховище — не страшно
    }
}
