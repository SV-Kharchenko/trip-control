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

// Графік у реальних пікселях: ширина = ширина контейнера, висота фіксована ~240, шрифти 12px не масштабуються (viewBox = розмір SVG).
export const CHART = { w: 640, h: 240, font: 12 };

// Коротке значення над стовпчиком: 128 тис / 1,3 млн.
export function compactMoney(value) {
    const n = Math.round(Number(value) || 0);
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + ' млн';
    if (abs >= 1000) return Math.round(n / 1000) + ' тис';
    return String(n);
}

// Опис фігур [тег, атрибути, текст?]: малює view через createElementNS.
export function monthsChartShapes(months, w = CHART.w, h = CHART.h) {
    const font = CHART.font;
    const left = 12;
    const bottom = 26;
    const top = 22; // місце під значення над найвищим стовпчиком
    const max = Math.max(1, ...months.map((x) => Math.max(x.revenue, x.profit, 0)));
    const slot = (w - left * 2) / Math.max(1, months.length);
    const bar = Math.max(8, Math.min(46, slot / 2.3));
    const y = (v) => top + (h - top - bottom) * (1 - Math.max(0, v) / max);
    const base = h - bottom;
    const f = (n) => Number(n.toFixed(1));
    const labelled = bar >= 30;
    const shapes = [['line', { x1: left, y1: base, x2: w - left, y2: base, stroke: 'var(--border)' }]];
    months.forEach((x, i) => {
        const cx = left + slot * i + slot / 2;
        [['revenue', cx - bar - 1, 'var(--gold)'], ['profit', cx + 1, 'var(--positive)']].forEach(([key, bx, fill]) => {
            const v = Math.max(0, x[key]);
            shapes.push(['rect', { x: f(bx), y: f(y(v)), width: f(bar), height: f(base - y(v)), rx: 3, fill }]);
            if (labelled && v > 0) shapes.push(['text', { x: f(bx + bar / 2), y: f(y(v) - 4), 'text-anchor': 'middle', 'font-size': font, fill: 'var(--text)' }, compactMoney(x[key])]);
        });
        shapes.push(['text', { x: f(cx), y: h - 8, 'text-anchor': 'middle', 'font-size': font, fill: 'var(--muted)' }, monthLabel(x.key)]);
    });
    return shapes;
}
