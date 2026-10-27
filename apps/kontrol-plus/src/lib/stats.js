// «Статистика»: підсумки за період і по місяцях з розрахунків, що вже збережені в базі (accepted / done).
// Рядок: { trip_date, created_at, distance_km, revenue, profit, status }.
export const COUNTED_STATUSES = ['accepted', 'done'];

const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

export function rowDate(row) {
    return String((row && (row.trip_date || row.created_at)) || '').slice(0, 10);
}

export function countedRows(rows, from, to) {
    return (rows || []).filter((r) => {
        if (!COUNTED_STATUSES.includes(r.status)) return false;
        const d = rowDate(r);
        return d && (!from || d >= from) && (!to || d <= to);
    });
}

export function summarize(rows) {
    const out = { trips: 0, revenue: 0, profit: 0, km: 0, revenuePerKm: null };
    for (const r of rows || []) {
        out.trips += 1;
        out.revenue += num(r.revenue);
        out.profit += num(r.profit);
        out.km += num(r.distance_km);
    }
    out.revenuePerKm = out.km > 0 ? Math.round((out.revenue / out.km) * 100) / 100 : null;
    return out;
}

// Останні `count` місяців до місяця дати `end` (YYYY-MM-DD) включно: [{ key: 'YYYY-MM', revenue, profit, trips }].
export function byMonth(rows, end, count = 6) {
    const [y, m] = String(end).slice(0, 7).split('-').map(Number);
    const months = [];
    for (let i = count - 1; i >= 0; i -= 1) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        months.push({ key: d.toISOString().slice(0, 7), revenue: 0, profit: 0, trips: 0 });
    }
    const index = Object.fromEntries(months.map((x) => [x.key, x]));
    for (const r of rows || []) {
        if (!COUNTED_STATUSES.includes(r.status)) continue;
        const bucket = index[rowDate(r).slice(0, 7)];
        if (!bucket) continue;
        bucket.trips += 1;
        bucket.revenue += num(r.revenue);
        bucket.profit += num(r.profit);
    }
    return months;
}

const MONTHS = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
export function monthLabel(key) {
    const month = Number(String(key).slice(5, 7));
    return MONTHS[month - 1] || key;
}

// Прості стовпчики дохід / прибуток: опис фігур [тег, атрибути, текст?] (малює view через createElementNS).
export const CHART = { w: 420, h: 190 };
export function monthsChartShapes(months) {
    const { w, h } = CHART;
    const left = 12;
    const bottom = 24;
    const top = 12;
    const max = Math.max(1, ...months.map((x) => Math.max(x.revenue, x.profit, 0)));
    const slot = (w - left * 2) / Math.max(1, months.length);
    const bar = Math.min(26, slot / 2.6);
    const y = (v) => top + (h - top - bottom) * (1 - Math.max(0, v) / max);
    const base = h - bottom;
    const f = (n) => Number(n.toFixed(1));
    const shapes = [['line', { x1: left, y1: base, x2: w - left, y2: base, stroke: 'var(--border)' }]];
    months.forEach((x, i) => {
        const cx = left + slot * i + slot / 2;
        shapes.push(['rect', { x: f(cx - bar - 1), y: f(y(x.revenue)), width: f(bar), height: f(base - y(x.revenue)), rx: 3, fill: 'var(--gold)' }]);
        shapes.push(['rect', { x: f(cx + 1), y: f(y(x.profit)), width: f(bar), height: f(base - y(x.profit)), rx: 3, fill: 'var(--positive)' }]);
        shapes.push(['text', { x: f(cx), y: h - 7, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, monthLabel(x.key)]);
    });
    return shapes;
}
