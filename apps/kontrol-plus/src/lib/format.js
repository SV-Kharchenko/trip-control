const money = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

export function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function fmtMoney(value) {
    const n = num(value);
    return n === null ? '—' : money.format(n) + ' ₴';
}

// Гроші з копійками (ціна одиниці, середня собівартість).
const money2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtMoneyCents(value) {
    const n = num(value);
    return n === null ? '—' : money2.format(n) + ' ₴';
}

export function fmtNumber(value) {
    const n = num(value);
    return n === null ? '—' : number.format(n);
}

export function fmtPct(value) {
    const n = num(value);
    return n === null ? '—' : (n > 0 ? '+' : '') + number.format(n) + '%';
}

export function fmtDate(value) {
    if (!value) return '—';
    const [y, m, d] = String(value).slice(0, 10).split('-');
    return d && m && y ? `${d}.${m}.${y}` : String(value);
}

export const STATUS_LABELS = {
    draft: 'Чернетка',
    proposed: 'Запропоновано',
    accepted: 'Прийнято',
    rejected: 'Відхилено',
    done: 'Виконано',
};

// Дата YYYY-MM-DD у київському часі (так само рахує trip_date на сервері).
export function kyivDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function monthRange(today = kyivDate()) {
    const [y, m] = today.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

export function daysBetween(from, to) {
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}
