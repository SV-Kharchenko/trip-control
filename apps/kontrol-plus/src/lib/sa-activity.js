// Вкладка «Активність» кабінету суперадміна: чисті функції (статус за датами, лічильники, фільтри, сортування, формат дат).
// Дані дає sa_list_user_activity() (перевірка суперадміна — в базі). Тут лише відображення.
import { ROLE_LABELS } from './gate.js';

export const DAY_MS = 86400000;
export const ACTIVITY_STATUSES = [
    { key: 'active', label: 'Активний' },
    { key: 'fading', label: 'Згасає' },
    { key: 'inactive', label: 'Неактивний' },
    { key: 'never', label: 'Не входив' },
];

export function statusLabel(key) {
    return (ACTIVITY_STATUSES.find((s) => s.key === key) || {}).label || '—';
}

export function roleLabel(role) {
    return role ? ROLE_LABELS[role] || role : '—';
}

const ms = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? t : null;
};

// «Не входив» — порожній last_sign_in_at; інакше за last_activity_at: до 7 днів — «Активний», 8–30 — «Згасає», більше 30 — «Неактивний».
export function activityStatus(row, now = Date.now()) {
    if (ms(row && row.last_sign_in_at) === null) return 'never';
    const last = ms(row.last_activity_at) ?? ms(row.last_sign_in_at);
    const days = Math.floor((now - last) / DAY_MS);
    if (days <= 7) return 'active';
    if (days <= 30) return 'fading';
    return 'inactive';
}

export function activityCounts(rows, now = Date.now()) {
    const out = { active: 0, fading: 0, inactive: 0, never: 0 };
    for (const r of rows || []) out[activityStatus(r, now)] += 1;
    return out;
}

// filters: { status: '' | 'active' | …, q } — пошук за email або назвою компанії, без урахування регістру.
export function filterActivity(rows, filters, now = Date.now()) {
    const q = String((filters && filters.q) || '').trim().toLowerCase();
    const status = (filters && filters.status) || '';
    return (rows || []).filter((r) => {
        if (status && activityStatus(r, now) !== status) return false;
        if (!q) return true;
        return String(r.email || '').toLowerCase().includes(q) || String(r.org_name || '').toLowerCase().includes(q);
    });
}

export const ACTIVITY_COLUMNS = [
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'org_name', label: 'Компанія', type: 'text' },
    { key: 'org_plan', label: 'Тариф', type: 'text' },
    { key: 'org_role', label: 'Роль', type: 'text' },
    { key: 'registered_at', label: 'Реєстрація', type: 'date' },
    { key: 'email_confirmed_at', label: 'Пошта підтверджена', type: 'date' },
    { key: 'last_sign_in_at', label: 'Останній вхід', type: 'date' },
    { key: 'calcs_7d', label: 'Розрахунків за 7 днів', type: 'num' },
    { key: 'calcs_30d', label: 'Розрахунків за 30 днів', type: 'num' },
    { key: 'calcs_total', label: 'Розрахунків усього', type: 'num' },
    { key: 'last_activity_at', label: 'Остання дія', type: 'date' },
];
export const DEFAULT_SORT = { key: 'last_activity_at', dir: 'desc' };

// Сортування: порожні значення завжди в кінці (nulls last), у будь-якому напрямку. Стабільне: рівні — за email.
export function sortActivity(rows, sort = DEFAULT_SORT) {
    const col = ACTIVITY_COLUMNS.find((c) => c.key === sort.key) || ACTIVITY_COLUMNS[ACTIVITY_COLUMNS.length - 1];
    const sign = sort.dir === 'asc' ? 1 : -1;
    const value = (r) => {
        const v = r[col.key];
        if (v === null || v === undefined || v === '') return null;
        if (col.type === 'date') return ms(v);
        if (col.type === 'num') return Number(v);
        return col.key === 'org_role' ? roleLabel(v) : String(v);
    };
    return [...(rows || [])].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        if (x === null && y === null) return String(a.email || '').localeCompare(String(b.email || ''), 'uk');
        if (x === null) return 1;
        if (y === null) return -1;
        const c = typeof x === 'number' ? x - y : x.localeCompare(y, 'uk', { sensitivity: 'base' });
        return c !== 0 ? sign * c : String(a.email || '').localeCompare(String(b.email || ''), 'uk');
    });
}

// Клік по заголовку: той самий стовпець — міняє напрямок, інший — спершу «найновіше / найбільше» (date, num → desc), текст → asc.
export function nextSort(sort, key) {
    if (sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    const col = ACTIVITY_COLUMNS.find((c) => c.key === key);
    return { key, dir: col && col.type === 'text' ? 'asc' : 'desc' };
}

const KYIV = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// ДД.ММ.РРРР ГГ:ХХ за Києвом; порожнє значення — «—».
export function formatKyivStamp(iso) {
    const t = ms(iso);
    if (t === null) return '—';
    const p = Object.fromEntries(KYIV.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

export function yesNo(iso) {
    return ms(iso) === null ? 'ні' : 'так';
}
