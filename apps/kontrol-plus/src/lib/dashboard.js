// Дашборд «Контроль+» (PR 4 з 5): чисті функції без DOM — період, попередній період, агрегація виручки по днях (Київ),
// порівняння, списки «останні заявки» й «документи без акта / підпису». Малює це views/dashboard.js.
import { daysBetween, fmtMoney, kyivDate, shiftDate } from './format.js';
import { docsAccess } from './docs.js';
import { crmPermissions } from './gate.js';

export const PERIOD_KEY = 'kp.dashboard.period';
export const PERIODS = [
    { value: 'today', label: 'Сьогодні' },
    { value: 'week', label: 'Тиждень' },
    { value: 'month', label: 'Місяць' },
    { value: 'custom', label: 'Свій' },
];
export const MAX_CUSTOM_DAYS = 366;
export const PAGE_SIZE = 200;       // ліміт registry_list на сервері
export const MAX_PAGES = 5;         // до 1000 заявок на графік; більше — «агреговано за перші N»
export const LIST_ROWS = 6;

// Єдиний перелік RPC, які викликає дашборд (тест порівнює з реальними викликами у views/dashboard.js).
export const DASHBOARD_RPCS = ['registry_totals', 'registry_list', 'registry_documents', 'kp_client_debts', 'kp_unpaid_invoices_count'];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
    && new Date(Date.parse(s + 'T00:00:00Z')).toISOString().slice(0, 10) === s;

// Фінансові картки (дебіторка, прострочені, документи) — тим ролям, яким їх уже показують «Документи» / «Борги» (owner, logist, director);
// створення — як скрізь у Контроль+: owner і logist. Директор (перегляд) і тариф без Контроль+ — лише читання.
export function dashboardAccess(context) {
    return { finance: docsAccess(context).visible, canWrite: crmPermissions(context).canWrite };
}

// Збережений вибір: { kind, from, to } (from / to — лише для 'custom'). Сміття → «Місяць».
export function normalizePeriod(raw) {
    let src = raw;
    if (typeof raw === 'string') {
        try { src = JSON.parse(raw); } catch { src = null; }
    }
    const kind = src && PERIODS.some((p) => p.value === src.kind) ? src.kind : 'month';
    if (kind !== 'custom') return { kind };
    if (validDate(src.from) && validDate(src.to) && src.from <= src.to && daysBetween(src.from, src.to) < MAX_CUSTOM_DAYS) return { kind, from: src.from, to: src.to };
    return { kind: 'month' };
}

export function readPeriod(storage) {
    try { return normalizePeriod(storage && storage.getItem(PERIOD_KEY)); } catch { return { kind: 'month' }; }
}
export function writePeriod(storage, sel) {
    try { if (storage) storage.setItem(PERIOD_KEY, JSON.stringify(normalizePeriod(sel))); } catch { /* приватний режим */ }
}

// Межі періоду (включно) у київських датах. Тиждень — останні 7 днів, місяць — з 1-го числа до сьогодні.
export function periodRange(sel, today = kyivDate()) {
    const p = normalizePeriod(sel);
    if (p.kind === 'today') return { from: today, to: today };
    if (p.kind === 'week') return { from: shiftDate(today, -6), to: today };
    if (p.kind === 'custom') return { from: p.from, to: p.to };
    return { from: today.slice(0, 8) + '01', to: today };
}

// Попередній період тієї ж довжини, що закінчується за день до початку поточного.
export function prevRange(range) {
    const n = daysBetween(range.from, range.to) + 1;
    return { from: shiftDate(range.from, -n), to: shiftDate(range.from, -1) };
}

// Вісь графіка не йде далі за сьогодні (Київ): майбутніх днів немає. null — період цілком у майбутньому.
export function clampToToday(range, today = kyivDate()) {
    if (range.from > today) return null;
    return { from: range.from, to: range.to > today ? today : range.to };
}

// Єдиний формат сум дашборда: як у KPI — пробіли тисяч, без копійок, «₴»; інша валюта — той самий формат із кодом.
export function fmtSum(value, currency = 'UAH') {
    const base = fmtMoney(value);
    return !currency || currency === 'UAH' ? base : base.replace(/\s*₴$/, '') + ' ' + currency;
}

// День заявки: той самий вираз, що в registry_list на сервері — дата рейсу, інакше дата рішення, інакше створення (за Києвом).
export function rowDay(row) {
    if (!row) return null;
    if (typeof row.trip_date === 'string' && validDate(row.trip_date.slice(0, 10))) return row.trip_date.slice(0, 10);
    for (const key of ['decided_at', 'created_at']) {
        const t = row[key] ? new Date(row[key]) : null;
        if (t && !Number.isNaN(t.getTime())) return kyivDate(t);
    }
    return null;
}

const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

// Виручка по днях: скасовані не рахуються, дні без заявок — нулі. Понад 92 дні — тижні (з понеділка). Значення — план виручки
// (поле revenue), тому сума збігається з registry_totals.revenue. Повертає { days: [{ date, label, revenue, count }], total, count }.
export function aggregateByDay(rows, fullRange, today = kyivDate()) {
    const range = clampToToday(fullRange, today);
    if (!range) return { days: [], total: 0, count: 0, weekly: false };
    const span = daysBetween(range.from, range.to) + 1;
    const weekly = span > 92;
    const startOf = (iso) => {
        if (!weekly) return iso;
        const dow = (new Date(Date.parse(iso + 'T00:00:00Z')).getUTCDay() + 6) % 7;
        return shiftDate(iso, -dow);
    };
    const buckets = new Map();
    for (let d = range.from; d <= range.to; d = shiftDate(d, weekly ? 7 : 1)) {
        const key = startOf(d);
        if (!buckets.has(key)) buckets.set(key, { date: key, revenue: 0, count: 0 });
    }
    let total = 0;
    let count = 0;
    for (const row of rows || []) {
        if (!row || row.status === 'cancelled') continue;
        const day = rowDay(row);
        if (!day || day < range.from || day > range.to) continue;
        const bucket = buckets.get(startOf(day));
        if (!bucket) continue;
        bucket.revenue += money(row.revenue);
        bucket.count += 1;
        total += money(row.revenue);
        count += 1;
    }
    return { days: [...buckets.values()], total, count, weekly };
}

// ▲ / ▼ у відсотках до попереднього періоду; null — порівнювати нема з чим (попередній 0 / невідомо).
export function delta(current, previous) {
    const cur = Number(current);
    const prev = Number(previous);
    if (current === null || current === undefined || previous === null || previous === undefined) return null;
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
    const pct = Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
    return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

export function fmtDelta(d) {
    if (!d) return '';
    const sign = d.dir === 'up' ? '▲ +' : d.dir === 'down' ? '▼ −' : '● ';
    return sign + String(Math.abs(d.pct)).replace('.', ',') + '%';
}

// Фільтри registry_*: період; директор Контроль+ (org_directors) читає свою компанію явним org_id — так само, як реєстр сайту.
export function registryFilters(context, range, extra) {
    const out = { ...(extra || {}) };
    if (range) { out.from = range.from; out.to = range.to; }
    if (context && context.role === 'director' && typeof context.org_id === 'string' && context.org_id) out.org_id = context.org_id;
    return out;
}

// Останні заявки: сервер вже сортує за номером реєстру (новіші першими); скасовані пропускаємо.
export function recentRequests(rows, limit = LIST_ROWS) {
    return (rows || []).filter((r) => r && r.status !== 'cancelled').slice(0, limit);
}

// Борги з простроченням: найбільше днів прострочки першими. Валюти не змішуються — кожен рядок у своїй.
export function overdueDebts(rows, limit = LIST_ROWS) {
    return (rows || []).filter((r) => Number(r.overdue) > 0)
        .sort((a, b) => (Number(b.overdue_days) || 0) - (Number(a.overdue_days) || 0) || Number(b.overdue) - Number(a.overdue))
        .slice(0, limit);
}

// Сума по валютах: { UAH: { debt, overdue, invoices } }. Суми різних валют не додаються.
export function sumDebts(rows) {
    const out = {};
    for (const r of rows || []) {
        const cur = r.currency || 'UAH';
        const slot = out[cur] || (out[cur] = { debt: 0, overdue: 0, invoices: 0 });
        slot.debt += money(r.debt);
        slot.overdue += money(r.overdue);
        slot.invoices += Number(r.invoices) || 0;
    }
    return out;
}

// Основна валюта картки: гривня, якщо є; інакше перша. null — боргів немає.
export function mainCurrency(sums) {
    const keys = Object.keys(sums || {});
    if (!keys.length) return null;
    return keys.includes('UAH') ? 'UAH' : keys[0];
}

// Документи заявок періоду (registry_documents.docs = [{ kind, status, paid… }]): виконана / прийнята заявка без чинного акта
// або з договором, що ще не підписаний (contract_status ≠ signed). Підпис акта сервер у цій RPC не віддає — лише договір.
export function docGaps(requests, docRows, limit = LIST_ROWS) {
    const byCalc = new Map((docRows || []).map((d) => [d.calculation_id, d]));
    const out = [];
    for (const req of requests || []) {
        if (!req || req.status === 'cancelled') continue;
        const info = byCalc.get(req.id);
        if (!info) continue; // документів заявки логіст не бачить / сервер не відповів — не вигадуємо
        const docs = Array.isArray(info.docs) ? info.docs : [];
        const hasAct = docs.some((d) => d.kind === 'act' && d.status !== 'cancelled');
        const problems = [];
        if (!hasAct && req.status === 'done') problems.push('немає акта');
        if (info.contract_id && info.contract_status !== 'signed') problems.push('договір не підписано');
        if (problems.length) out.push({ request: req, problems });
        if (out.length >= limit) break;
    }
    return out;
}

// Геометрія стовпчиків (viewBox ширина × висота): чисто, щоб перевірити тестом без DOM.
export function chartGeometry(days, { width = 640, height = 200, padLeft = 44, padRight = 8, padTop = 10, padBottom = 24 } = {}) {
    const n = Math.max(1, days.length);
    const max = Math.max(0, ...days.map((d) => d.revenue));
    const top = niceCeil(max);
    const innerW = width - padLeft - padRight;
    const innerH = height - padTop - padBottom;
    const slot = innerW / n;
    const barW = Math.max(1, Math.min(28, slot * 0.7));
    const bars = days.map((d, i) => {
        const h = top > 0 ? (d.revenue / top) * innerH : 0;
        return { ...d, x: round(padLeft + slot * i + (slot - barW) / 2), y: round(padTop + innerH - h), w: round(barW), h: round(h), cx: round(padLeft + slot * i + slot / 2) };
    });
    const ticks = [0, 0.5, 1].map((f) => ({ value: top * f, y: round(padTop + innerH - innerH * f) }));
    // Підписи осі дат: не частіше ніж раз на ~56 одиниць ширини.
    const every = Math.max(1, Math.ceil(56 / slot));
    const labels = bars.filter((_, i) => i % every === 0 || i === bars.length - 1).filter((b, i, arr) => i === arr.length - 1 || arr[arr.length - 1].cx - b.cx >= 40)
        .map((b) => ({ date: b.date, x: b.cx }));
    return { width, height, padLeft, padTop, innerH, top, bars, ticks, labels, axisY: round(padTop + innerH) };
}
const round = (v) => Math.round(v * 100) / 100;

// «Гарний» верх осі: 1, 2, 2.5, 5 × 10^k.
export function niceCeil(value) {
    if (!(value > 0)) return 0;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    const f = value / exp;
    const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return step * exp;
}

// Скорочена сума для осі: 12 500 → «12,5 тис», 1 200 000 → «1,2 млн».
export function fmtShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const f = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
    if (a >= 1e6) return f(n / 1e6) + ' млн';
    if (a >= 1e3) return f(n / 1e3) + ' тис';
    return String(Math.round(n));
}
