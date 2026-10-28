// «Статистика»: KPI-плитки за період (рейси, дохід, прибуток, км, дохід на км) і графік по місяцях з уже збережених
// розрахунків (статуси «Прийнята» / «Виконана»), у межах прав доступу користувача. Нових таблиць і RPC немає.
import { h, clear, spinner, notice, svgEl } from '../ui.js';
import { fmtMoney, kyivDate, monthRange } from '../lib/format.js';
import { errorText } from '../lib/errors.js';
import { CHART, byMonth, countedRows, monthsChartShapes, summarize } from '../lib/stats.js';

const COLUMNS = 'trip_date, created_at, distance_km, revenue, profit, status';

function tile(label, value, note) {
    return h('div', { class: 'card kps-tile' }, h('small', null, label), h('b', { class: 'mono' }, value), note ? h('span', { class: 'muted small' }, note) : null);
}

export function renderStats(app) {
    const range = monthRange(kyivDate());
    const from = h('input', { type: 'date', id: 'kps-from', value: range.from, 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', id: 'kps-to', value: range.to, 'aria-label': 'Період по' });
    const body = h('div', null, spinner());
    let rows = [];

    function draw() {
        if (!from.value || !to.value || from.value > to.value) {
            clear(body, notice('Перевірте період: «з» не пізніше «по».'));
            return;
        }
        const sum = summarize(countedRows(rows, from.value, to.value));
        const months = byMonth(rows, to.value, 6);
        const chart = h('div', { class: 'kps-chart' });
        chart.append(svgEl('svg', { viewBox: '0 0 ' + CHART.w + ' ' + CHART.h, role: 'img', 'aria-label': 'Дохід і прибуток по місяцях' },
            monthsChartShapes(months).map(([tag, attrs, text]) => svgEl(tag, attrs, text))));
        clear(body,
            h('div', { class: 'kps-tiles' },
                tile('Рейси', String(sum.trips)),
                tile('Дохід', fmtMoney(sum.revenue)),
                tile('Прибуток', fmtMoney(sum.profit)),
                tile('Кілометри', sum.km ? Math.round(sum.km).toLocaleString('uk-UA') + ' км' : '—'),
                tile('Дохід на км', sum.revenuePerKm === null ? '—' : String(sum.revenuePerKm).replace('.', ',') + ' грн/км')),
            h('div', { class: 'card kps-card' },
                h('h3', null, 'Дохід і прибуток по місяцях'),
                chart,
                h('p', { class: 'muted small' }, h('span', { class: 'kps-dot kps-gold' }), ' Дохід ', h('span', { class: 'kps-dot kps-green' }), ' Прибуток · останні 6 місяців до кінця періоду')),
            h('p', { class: 'muted small' }, 'Враховано розрахунки зі статусом «Прийнята» або «Виконана». Кілометри — з розрахунку (відстань), без подачі.'));
    }

    async function load() {
        clear(body, spinner());
        const since = new Date(Date.UTC(Number(to.value.slice(0, 4)) || new Date().getUTCFullYear(), (Number(to.value.slice(5, 7)) || 1) - 7, 1)).toISOString().slice(0, 10);
        const { data, error } = await app.supabase.from('calculations').select(COLUMNS).gte('created_at', since).order('created_at', { ascending: false }).limit(5000);
        if (error) {
            clear(body, notice(errorText(error)));
            return;
        }
        rows = data || [];
        draw();
    }

    from.addEventListener('change', draw);
    to.addEventListener('change', load);
    load();

    return h('section', { class: 'page kpr-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Статистика')),
        h('div', { class: 'toolbar kps-period' }, h('label', { for: 'kps-from' }, 'з'), from, h('label', { for: 'kps-to' }, 'по'), to),
        body);
}
