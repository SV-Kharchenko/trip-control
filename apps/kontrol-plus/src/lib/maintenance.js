// ТО і вартість на км (етап 3b): чисті функції інтерфейсу. Джерело істини статусу — SQL (kp_maintenance_eval /
// kp_maintenance_status); тут — та сама формула лише для сортування, бейджа, текстів і тестів.
import { fmtNumber, fmtDate, num, kyivDate, daysBetween } from './format.js';

export const KM_WARN = 5000;
export const DAYS_WARN = 14;

const RANK_STATUS = ['unknown', 'ok', 'yellow', 'red'];

function kmRank(left) {
    if (left === null) return 0;
    return left <= 0 ? 3 : left <= KM_WARN ? 2 : 1;
}

function daysRank(left) {
    if (left === null) return 0;
    return left <= 0 ? 3 : left <= DAYS_WARN ? 2 : 1;
}

// «Що раніше»: гірший з вимірів. Межі включні (5000 км / 14 днів — yellow; 0 — red); вимір без значення
// ігнорується; обидва без значення — unknown. reason — вимір, що спрацював гірше (нічия — 'km').
export function maintenanceEval(leftKm, leftDays) {
    const km = kmRank(num(leftKm));
    const tm = daysRank(num(leftDays));
    return {
        status: RANK_STATUS[Math.max(km, tm)],
        reason: km === 0 && tm === 0 ? null : tm > km ? 'time' : 'km',
    };
}

export const STATUS_TEXT = { red: 'Протерміновано', yellow: 'Скоро', ok: 'Гаразд', unknown: 'Невідомо' };

// Проблемні зверху: red, потім yellow, потім ok / unknown; усередині — що ближче до терміну.
const ORDER = { red: 0, yellow: 1, ok: 2, unknown: 2 };
function urgency(row) {
    const km = num(row.left_km);
    const days = num(row.left_days);
    // Порівнюємо в «днях»: км переводимо грубо (≈ 500 км на день) лише для порядку всередині групи.
    const values = [km === null ? null : km / 500, days].filter((v) => v !== null);
    return values.length ? Math.min(...values) : Infinity;
}
export function sortMaintenance(rows) {
    return (rows || []).slice().sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
        || urgency(a) - urgency(b)
        || String(a.vehicle_label || '').localeCompare(String(b.vehicle_label || ''), 'uk')
        || String(a.type_name || '').localeCompare(String(b.type_name || ''), 'uk'));
}

// Бейдж вкладки «Ремонти»: кількість red, а без red — yellow; нуль — без бейджа.
export function maintenanceBadge(rows) {
    const list = rows || [];
    const red = list.filter((r) => r.status === 'red').length;
    if (red) return { count: red, kind: 'red' };
    const yellow = list.filter((r) => r.status === 'yellow').length;
    return yellow ? { count: yellow, kind: 'yellow' } : null;
}

export function badgeTitle(badge) {
    if (!badge) return '';
    return badge.kind === 'red' ? 'Протерміноване ТО: ' + badge.count : 'Скоро ТО: ' + badge.count;
}

export function intervalText(km, months) {
    const parts = [];
    if (num(km) !== null) parts.push(fmtNumber(km) + ' км');
    if (num(months) !== null) parts.push(num(months) + ' міс');
    return parts.join(' / ') || '—';
}

export function leftKmText(row) {
    const left = num(row.left_km);
    if (left === null) return num(row.interval_km) === null ? '—' : 'Вкажіть показник одометра';
    return left < 0 ? 'прострочено на ' + fmtNumber(-left) + ' км' : fmtNumber(left) + ' км';
}

export function leftDaysText(row) {
    const left = num(row.left_days);
    if (left === null) return '—';
    if (left < 0) return 'прострочено на ' + -left + ' дн';
    return left === 0 ? 'сьогодні' : left + ' дн';
}

export function lastText(row) {
    if (!row.last_on) return 'Вкажіть показник одометра';
    const km = num(row.last_km) === null ? '—' : fmtNumber(row.last_km) + ' км';
    return (row.last_source === 'start' ? 'Старт: ' : '') + fmtDate(row.last_on) + ' / ' + km;
}

// Періоди вартості на км (Київ). custom — { from, to } з полів «Свій період».
export const PERIODS = [
    { value: 'month', label: 'Місяць' },
    { value: 'quarter', label: 'Квартал' },
    { value: 'year', label: 'Рік' },
    { value: 'custom', label: 'Свій період' },
];

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function periodRange(kind, today = kyivDate(), custom = null) {
    const [y, m] = today.split('-').map(Number);
    if (kind === 'quarter') {
        const first = Math.floor((m - 1) / 3) * 3 + 1;
        return { from: `${y}-${pad(first)}-01`, to: `${y}-${pad(first + 2)}-${pad(lastDay(y, first + 2))}` };
    }
    if (kind === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
    if (kind === 'custom' && custom) return { from: custom.from, to: custom.to };
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
}

// Помилка періоду або '' (сервер перевіряє так само: from ≤ to, менше 3 років).
export function periodError(range) {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    if (!range || !ok(range.from) || !ok(range.to)) return 'Вкажіть обидві дати.';
    if (range.from > range.to) return '«З» має бути не пізніше «по».';
    const [y, m, d] = range.from.split('-').map(Number);
    const limit = new Date(Date.UTC(y + 3, m - 1, d)).toISOString().slice(0, 10);
    if (range.to >= limit) return 'Період — менше 3 років.';
    return '';
}

export function periodDays(range) {
    return daysBetween(range.from, range.to) + 1;
}

export function costTotals(rows) {
    const sum = (key) => Math.round((rows || []).reduce((s, r) => s + (num(r[key]) || 0), 0) * 100) / 100;
    const cost = sum('cost');
    const km = Math.round((rows || []).reduce((s, r) => s + (num(r.km) || 0), 0) * 10) / 10;
    return { parts: sum('parts_cost'), service: sum('service_cost'), cost, km, perKm: km > 0 ? Math.round(cost / km * 100) / 100 : null };
}

export function perKmText(value) {
    const n = num(value);
    return n === null ? 'немає пробігу' : n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴/км';
}

export const COST_CSV_HEADER = ['Авто', 'Ремонтів', 'Запчастини, грн', 'СТО, грн', 'Витрати, грн', 'Км', 'Грн/км'];

export function costCsvRows(rows) {
    const t = costTotals(rows);
    return [
        ...(rows || []).map((r) => [r.vehicle_label, num(r.repairs_count), num(r.parts_cost), num(r.service_cost), num(r.cost), num(r.km), num(r.cost_per_km)]),
        ['Разом', (rows || []).reduce((s, r) => s + (num(r.repairs_count) || 0), 0), t.parts, t.service, t.cost, t.km, t.perKm],
    ];
}

// Форма типу ТО: назва 1–80, хоча б один інтервал (км 1–1 000 000, місяці 1–120).
export function validateTypeForm(form) {
    const errors = [];
    const name = String(form.name || '').trim();
    if (!name || name.length > 80) errors.push('Назва — від 1 до 80 символів.');
    const km = form.interval_km === '' || form.interval_km == null ? null : Number(form.interval_km);
    const months = form.interval_months === '' || form.interval_months == null ? null : Number(form.interval_months);
    if (km === null && months === null) errors.push('Вкажіть інтервал у км або в місяцях.');
    if (km !== null && !(Number.isInteger(km) && km >= 1 && km <= 1000000)) errors.push('Інтервал км — ціле число від 1 до 1 000 000.');
    if (months !== null && !(Number.isInteger(months) && months >= 1 && months <= 120)) errors.push('Інтервал місяців — від 1 до 120.');
    return errors;
}

// Копія kp_odometer_guard (джерело істини — SQL) для форми: бази — ручні показання й ремонти з історії
// kp_odometer_list (GPS базою не є). Нове значення не менше за найпізнішу базу з датою <= дати і не більше за
// найранішу базу з датою > дати; рівне — можна. Порядок у межах дати — created_at, далі id (як у SQL).
// Повертає null або { kind: 'prev' | 'next', km, read_on }.
export function odometerConflict(history, date, km) {
    const value = num(km);
    if (!date || value === null) return null;
    const key = (r) => String(r.read_on) + '|' + String(r.created_at || '') + '|' + String(r.id || '');
    const bases = (history || []).filter((r) => r.source === 'manual' || r.source === 'repair').slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const prev = bases.filter((r) => r.read_on <= date).pop();
    if (prev && value < Number(prev.odometer_km)) return { kind: 'prev', km: Number(prev.odometer_km), read_on: prev.read_on };
    const next = bases.find((r) => r.read_on > date);
    if (next && value > Number(next.odometer_km)) return { kind: 'next', km: Number(next.odometer_km), read_on: next.read_on };
    return null;
}

export const ODOMETER_SOURCE_TEXT = { manual: 'Вручну', gps: 'GPS', repair: 'Ремонт' };

// Показник одометра: ціле 0–10 000 000, дата не пізніше сьогодні (Київ).
export function validateOdometerForm(form, today = kyivDate()) {
    const errors = [];
    if (!form.vehicle_id) errors.push('Оберіть авто.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date || '') || form.date > today) errors.push('Дата — не пізніше сьогодні.');
    const km = form.km === '' || form.km == null ? NaN : Number(form.km);
    if (!(Number.isInteger(km) && km >= 0 && km <= 10000000)) errors.push('Показник — ціле число км.');
    return errors;
}
