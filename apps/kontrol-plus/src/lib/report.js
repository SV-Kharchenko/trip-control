// Звіт «План/факт»: чиста математика без DOM. Головне правило — план і факт поруч лише для ОДНІЄЇ бази: рейсів, по яких внесено факт.
// План усіх рейсів показується окремо («Усі рейси»). Джерело — report_plan_fact (plan_profit_with_fact, fact_profit, deviation_profit — по рейсах з фактом).
import { toCsv } from './csv.js';
import { num } from './format.js';

const SUM_KEYS = ['trips', 'trips_with_fact', 'plan_revenue', 'plan_costs', 'plan_profit', 'plan_profit_with_fact', 'fact_revenue', 'fact_costs', 'fact_profit', 'deviation_profit'];
const n0 = (v) => num(v) || 0;

// Підсумок: суми; відсоток — від |плану рейсів з фактом| (як у рядках на сервері).
export function totals(rows) {
    const total = { group_label: 'Разом' };
    for (const key of SUM_KEYS) total[key] = (rows || []).reduce((s, r) => s + n0(r[key]), 0);
    total.deviation_pct = devPct(total);
    return total;
}

export function devPct(row) {
    const base = n0(row.plan_profit_with_fact);
    return n0(row.trips_with_fact) > 0 && base !== 0 ? Math.round((n0(row.deviation_profit) / Math.abs(base)) * 1000) / 10 : null;
}

const hasFact = (row) => n0(row.trips_with_fact) > 0;

// Картки: одна база. null — «—». noFact: ще N рейсів без факту (план цих рейсів = план усіх мінус план з фактом).
export function reportCards(total) {
    const withFact = n0(total.trips_with_fact);
    const trips = n0(total.trips);
    const missing = Math.max(0, trips - withFact);
    const noFactPlan = n0(total.plan_profit) - n0(total.plan_profit_with_fact);
    return {
        hasFacts: withFact > 0,
        plan: withFact ? n0(total.plan_profit_with_fact) : null,
        fact: withFact ? n0(total.fact_profit) : null,
        deviation: withFact ? n0(total.deviation_profit) : null,
        pct: withFact ? devPct(total) : null,
        trips, withFact, missing,
        noFactPlan: missing ? noFactPlan : null,
        hint: withFact ? '' : 'Внесіть факт по рейсах, щоб побачити відхилення',
    };
}

export function noFactNote(cards, fmt) {
    if (!cards.missing) return '';
    const word = cards.missing === 1 ? 'рейс' : cards.missing >= 2 && cards.missing <= 4 ? 'рейси' : 'рейсів';
    return 'ще ' + cards.missing + ' ' + word + ' без факту, план ' + fmt(cards.noFactPlan);
}

// Колонки таблиці й CSV — один список. group — назва групи колонок (null — без групи).
export const COLUMNS = [
    { key: 'trips', label: 'Рейси (з фактом / усього)', priority: true, value: (r) => n0(r.trips_with_fact) + ' з ' + n0(r.trips), kind: 'text' },
    { key: 'plan_all', group: 'Усі рейси', label: 'План прибутку', value: (r) => n0(r.plan_profit), kind: 'money', optional: true },
    { key: 'plan_with_fact', group: 'Рейси з фактом', label: 'План прибутку', priority: true, value: (r) => (hasFact(r) ? n0(r.plan_profit_with_fact) : null), kind: 'money' },
    { key: 'fact', group: 'Рейси з фактом', label: 'Факт прибутку', priority: true, value: (r) => (hasFact(r) ? n0(r.fact_profit) : null), kind: 'money' },
    { key: 'deviation', group: 'Рейси з фактом', label: 'Відхилення', priority: true, value: (r) => (hasFact(r) ? n0(r.deviation_profit) : null), kind: 'signed' },
    { key: 'pct', group: 'Рейси з фактом', label: '%', priority: true, value: (r) => (hasFact(r) ? devPct(r) : null), kind: 'pct' },
];

export const columnTitle = (c) => (c.group ? c.group + ': ' + c.label : c.label);

// Заголовок CSV = назви колонок таблиці (з префіксом групи); числа без пробілів тисяч (десяткова кома — у csv.js).
export function reportCsv(rows, groupLabel, { withTotal } = {}) {
    const list = rows || [];
    const header = [groupLabel, ...COLUMNS.map(columnTitle)];
    const line = (r) => [r.group_label, ...COLUMNS.map((c) => c.value(r))];
    const body = list.map(line);
    if (withTotal === undefined ? list.length > 1 : withTotal) body.push(line(totals(list)));
    return toCsv(header, body);
}

// «Разом» потрібне лише коли рядків більше одного.
export const showTotal = (rows) => (rows || []).length > 1;

// Напрямки: усі рейси без шаблону → підказка, як групувати.
export const DIRECTION_HINT = 'Шаблонів маршрутів немає — збережіть рейс як шаблон, щоб групувати за напрямками';
export function directionHint(group, rows) {
    return group === 'direction' && (rows || []).length > 0 && rows.every((r) => r.group_key === 'none') ? DIRECTION_HINT : '';
}
