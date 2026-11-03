import { h, clear, spinner, notice, download } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { csvFileName } from '../lib/csv.js';
import { COLUMNS, columnTitle, directionHint, noFactNote, reportCards, reportCsv, showTotal, totals } from '../lib/report.js';
import { fmtMoney, fmtPct, num, kyivDate, monthRange, daysBetween } from '../lib/format.js';

export const GROUPS = [
    { value: 'logist', label: 'Логісти' },
    { value: 'vehicle', label: 'Авто' },
    { value: 'client', label: 'Клієнти' },
    { value: 'direction', label: 'Напрямки (шаблони)' },
];

export { totals, reportCsv };

export const REPORT_TABS = [
    { sub: 'main', hash: '#/report', label: 'План/факт' },
    { sub: 'debts', hash: '#/report/debts', label: 'Борги' },
];

export function reportTabs(current) {
    return h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи звіту' }, REPORT_TABS.map((t) =>
        h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === current ? ' on' : ''), 'aria-current': t.sub === current ? 'page' : null }, t.label)));
}

// sub = 'debts': підвкладка «Борги» (екран боргів клієнтів передає міст, щоб звіт не тягнув чанк документів).
export function renderReport(app, sub = 'main', debtsView = null) {
    if (sub === 'debts') {
        return h('section', { class: 'page kpr-page kp-report' },
            h('div', { class: 'page-head' }, h('h1', null, 'План/факт')),
            reportTabs('debts'),
            debtsView);
    }
    const saved = readPrefs();
    const range = monthRange(kyivDate());
    const from = h('input', { type: 'date', id: 'r-from', value: saved.from || range.from });
    const to = h('input', { type: 'date', id: 'r-to', value: saved.to || range.to });
    const group = h('div', { class: 'kpd-periods kpq-groups', role: 'radiogroup', 'aria-label': 'Групування' });
    let current = GROUPS.some((g) => g.value === saved.group) ? saved.group : 'logist';
    const result = h('div', null);
    const exportBtn = h('button', { type: 'button', class: 'btn btn-ghost', disabled: true }, 'Експорт CSV');
    let rows = [];

    function drawGroups() {
        clear(group, GROUPS.map((g) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(g.value === current),
            class: 'kpd-chip' + (g.value === current ? ' is-on' : ''),
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
        const cards = reportCards(total);
        const note = noFactNote(cards, fmtMoney);
        const dash = () => h('b', { class: 'kpq-mono' }, '—');
        const card = (label, value, cls) => h('div', { class: 'stat kpq-card' }, h('div', { class: 'stat-label' }, label),
            h('div', { class: 'stat-value kpq-mono' + (cls ? ' ' + cls : '') }, value));
        const cell = (c, r) => {
            const v = c.value(r);
            const label = columnTitle(c);
            if (v === null || v === undefined) return h('td', { 'data-label': label, class: 'kpq-mono' + (c.optional ? ' kpq-all' : '') }, '—');
            if (c.kind === 'text') return h('td', { 'data-label': label, class: 'kpq-mono' }, v);
            const text = c.kind === 'pct' ? fmtPct(v) : c.kind === 'signed' && v > 0 ? '+' + fmtMoney(v) : fmtMoney(v);
            const sign = c.kind === 'signed' || c.kind === 'pct' ? signClass(v) : null;
            return h('td', { 'data-label': label, class: 'kpq-mono' + (c.optional ? ' kpq-all' : '') + (sign ? ' ' + sign : '') }, text);
        };
        const body = [];
        for (const r of rows) {
            const factual = num(r.trips_with_fact) > 0;
            const detail = h('tr', { class: 'kpq-detail', hidden: true },
                h('td', { colspan: COLUMNS.length + 1 }, 'Факт по рейсах з фактом: дохід ', h('b', { class: 'kpq-mono' }, fmtMoney(r.fact_revenue)),
                    ' · витрати ', h('b', { class: 'kpq-mono' }, fmtMoney(r.fact_costs)), ' (включно із запланованими накладними)'));
            const toggle = factual ? h('button', {
                type: 'button', class: 'kpq-exp', 'aria-expanded': 'false', 'aria-label': 'Показати дохід і витрати факту',
                onclick: (e) => { const open = detail.hidden; detail.hidden = !open; e.currentTarget.setAttribute('aria-expanded', String(open)); },
            }, '▸') : null;
            body.push(h('tr', { class: r.group_key === 'none' ? 'is-none' : '' },
                h('th', { scope: 'row', class: 'text', 'data-label': groupLabel }, toggle, h('span', { class: 'kpq-name' }, r.group_label)),
                COLUMNS.map((c) => cell(c, r))), detail);
        }
        const groups = [];
        for (const c of COLUMNS) {
            const last = groups[groups.length - 1];
            if (c.group && last && last.group === c.group) last.span += 1;
            else groups.push({ group: c.group || null, span: 1, optional: Boolean(c.optional), plain: c.group ? null : c });
        }
        const head1 = h('tr', null, h('th', { class: 'text', rowspan: 2, scope: 'col' }, groupLabel),
            groups.map((g) => (g.group ? h('th', { colspan: g.span, scope: 'colgroup', class: 'kpq-grp' + (g.optional ? ' kpq-all' : '') }, g.group)
                : h('th', { rowspan: 2, scope: 'col' }, g.plain.label))));
        const head2 = h('tr', null, COLUMNS.filter((c) => c.group).map((c) => h('th', { scope: 'col', class: c.optional ? 'kpq-all' : '' }, c.label)));
        const foot = showTotal(rows) ? h('tfoot', null, h('tr', null, h('th', { scope: 'row', class: 'text', 'data-label': groupLabel }, 'Разом'), COLUMNS.map((c) => cell(c, total)))) : null;
        const dirHint = directionHint(current, rows);
        clear(result,
            h('div', { class: 'kpq-cards' },
                card('План (рейси з фактом)', cards.hasFacts ? fmtMoney(cards.plan) : dash()),
                card('Факт', cards.hasFacts ? fmtMoney(cards.fact) : dash()),
                card('Відхилення', cards.hasFacts ? h('span', null, (cards.deviation > 0 ? '+' : '') + fmtMoney(cards.deviation), ' · ', fmtPct(cards.pct)) : dash(),
                    cards.hasFacts ? signClass(cards.deviation) : null)),
            cards.hasFacts ? null : h('p', { class: 'muted small kpq-note' }, cards.hint),
            note ? h('p', { class: 'muted small kpq-note' }, note) : null,
            dirHint ? h('p', { class: 'notice notice-info kpq-hint' }, dirHint) : null,
            h('div', { class: 'table-wrap kpq-wrap' }, h('table', { class: 'table table-num report kpq' },
                h('thead', null, head1, head2), h('tbody', null, body), foot)),
            h('p', { class: 'muted small' },
                'План і факт порівнюються лише по рейсах «Прийнято» / «Виконано» з внесеним фактом; план решти рейсів — окремо, у колонці «Усі рейси». ',
                'Відхилення = факт мінус план цих же рейсів. Витрати факту включають заплановані накладні. Дохід і витрати факту — у розгортанні рядка (▸).',
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

    return h('section', { class: 'page kp-report' },
        h('div', { class: 'page-head' }, h('h1', null, 'План/факт'), exportBtn),
        reportTabs('main'),
        h('div', { class: 'toolbar' },
            h('div', { class: 'dates' }, h('label', { for: 'r-from' }, 'З'), from, h('label', { for: 'r-to' }, 'по'), to),
            h('div', { class: 'quick' },
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setPeriod('month') }, 'Цей місяць'),
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setPeriod('prev') }, 'Минулий'),
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setPeriod('year') }, 'З початку року'))),
        group,
        result);
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
