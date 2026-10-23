// Факт рейсу v2: фактичні доби, пробіг, оплачений простій і незаплановані витрати → перерахунок тим самим
// ядром, що й калькулятор (calculateTripFact з api/calculate.js; там же buildTripFact і POST /api/calculate?mode=fact). Зберігається в trip_actuals: деталі — у v2-стовпцях,
// revenue / costs / profit — підсумки для звіту план/факт, «Клієнтів», тижневого звіту та історії
// (planned_overhead = 0: накладні вже всередині costs).

export const FACT_VERSION = 'v2';
export const FACT_NOTE_MAX = 500;

const LIMITS = {
    tripDays: { min: 0, max: 365, positive: true, label: 'Фактичний час на ходку' },
    loadedKm: { min: 0, max: 1000000, label: 'Пробіг з вантажем' },
    emptyKm: { min: 0, max: 1000000, label: 'Пробіг порожнім' },
    paidIdleDays: { min: 0, max: 365, label: 'Оплачений простій' },
    idleRate: { min: 0, max: 10000000, label: 'Ставка простою' },
    extraCosts: { min: 0, max: 1000000000, label: 'Незаплановані витрати' }
};

// Поля, порожнє або незмінене значення яких означає «як у плані»: у розрахунок іде null, і ядро бере рівно
// планові доби / км кожного авто (без ділення на ходки й назад) — тож факт без змін = план до копійки.
const AS_PLAN = ['tripDays', 'loadedKm', 'emptyKm'];
const DECIMAL = /^-?\d+(?:[.,]\d+)?$/;

function blank(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// Лише число або рядок з десятковим числом (кома — теж роздільник, пробіли між розрядами можна).
// '0x10', '1e3', 'Infinity', масиви, обʼєкти, boolean — не число.
function parseNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return NaN;
    const text = value.trim().replace(/[\s\u00a0]+/g, '');
    return DECIMAL.test(text) ? Number(text.replace(',', '.')) : NaN;
}

function samePlan(n, plan) {
    return Math.abs(n - plan) <= 1e-9 * Math.max(1, Math.abs(plan));
}

// Порожнє поле → план (доби, км, ставка простою) або 0 (оплачений простій, витрати).
// value — те, що показуємо й зберігаємо (для «як у плані» — точне планове значення, без округлення);
// calc — те, що йде в розрахунок (null для «як у плані»).
export function normalizeTripFact(input, basis) {
    const src = input && typeof input === 'object' ? input : {};
    const defaults = {
        tripDays: basis.tripDays,
        loadedKm: basis.loadedKm,
        emptyKm: basis.emptyKm,
        paidIdleDays: 0,
        idleRate: basis.idleRate,
        extraCosts: 0
    };
    const value = {};
    const errors = [];
    Object.keys(LIMITS).forEach(function (key) {
        const rule = LIMITS[key];
        const n = blank(src[key]) ? defaults[key] : parseNumber(src[key]);
        if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.positive && !(n > 0))) {
            errors.push({ key, label: rule.label });
            return;
        }
        value[key] = n;
    });
    const rawNote = src.extraCostsNote;
    const note = blank(rawNote) ? '' : (typeof rawNote === 'string' ? rawNote.trim() : null);
    if (note === null || note.length > FACT_NOTE_MAX) errors.push({ key: 'extraCostsNote', label: 'Опис витрат' });
    value.extraCostsNote = note || '';
    if (errors.length) {
        return {
            status: 400,
            code: 'BAD_FACT',
            error: 'Перевірте: ' + errors.map(function (item) { return item.label; }).join(', '),
            fields: errors.map(function (item) { return item.key; })
        };
    }
    const calc = Object.assign({}, value);
    const asPlan = {};
    AS_PLAN.forEach(function (key) {
        asPlan[key] = samePlan(value[key], defaults[key]);
        if (asPlan[key]) {
            value[key] = defaults[key];
            calc[key] = null;
        }
    });
    return { value, calc, asPlan };
}

function totals(result) {
    const revenue = Math.round(Number(result.grossIncome) || 0);
    const profit = Math.round(Number(result.netProfit) || 0);
    return { revenue, costs: revenue - profit, profit };
}

function delta(fact, plan) {
    if (!Number.isFinite(plan) || !Number.isFinite(fact)) return { abs: null, pct: null };
    return { abs: fact - plan, pct: plan === 0 ? null : (fact - plan) / Math.abs(plan) * 100 };
}

// План / факт для редактора і рядок trip_actuals. core — { tripFactBasis, calculateTripFact } з api/calculate.js
// (модуль без імпортів, щоб не було циклу). stored — збережений план рейсу (calculations.revenue / profit
// або results.grossIncome / netProfit): з ним порівнюють звіти.
export function composeTripFact(core, inputs, input, stored) {
    const { tripFactBasis, calculateTripFact } = core;
    const basis = tripFactBasis(inputs);
    if (basis.status) return Object.assign({}, basis, { code: basis.code === 'MISSING_FIELDS' ? 'NO_INPUTS' : basis.code });
    const normalized = normalizeTripFact(input, basis);
    if (normalized.status) return normalized;
    const fact = normalized.value;
    const recomputed = calculateTripFact(inputs);
    if (recomputed.status) return recomputed;
    const actualResult = calculateTripFact(inputs, normalized.calc);
    if (actualResult.status) return actualResult;

    const now = totals(recomputed);
    const savedRevenue = stored && Number.isFinite(Number(stored.revenue)) && stored.revenue !== null ? Math.round(Number(stored.revenue)) : now.revenue;
    const savedProfit = stored && Number.isFinite(Number(stored.profit)) && stored.profit !== null ? Math.round(Number(stored.profit)) : now.profit;
    const plan = { revenue: savedRevenue, costs: savedRevenue - savedProfit, profit: savedProfit };
    const actual = totals(actualResult);
    const planKm = basis.loadedKm + basis.emptyKm;
    const factKm = fact.loadedKm + fact.emptyKm;
    const factDays = normalized.asPlan.tripDays ? basis.planDays : fact.tripDays * basis.tripsCount;
    return {
        basis,
        fact,
        asPlan: normalized.asPlan,
        plan,
        // Перерахунок плану за поточними формулами: якщо відрізняється від збереженого, різниця — не від факту.
        planNow: now,
        actual,
        deviation: {
            revenue: delta(actual.revenue, plan.revenue),
            costs: delta(actual.costs, plan.costs),
            profit: delta(actual.profit, plan.profit),
            days: { plan: basis.planDays, fact: factDays, abs: factDays - basis.planDays },
            km: { plan: planKm, fact: factKm, abs: factKm - planKm }
        },
        rows: actualResult.detailedRows || [],
        row: factRow(fact, actual)
    };
}

export function factRow(fact, actual) {
    return {
        fact_version: FACT_VERSION,
        fact_days: fact.tripDays,
        fact_loaded_km: fact.loadedKm,
        fact_empty_km: fact.emptyKm,
        paid_idle_days: fact.paidIdleDays,
        idle_rate: fact.idleRate,
        extra_costs: fact.extraCosts,
        extra_costs_note: fact.extraCostsNote || null,
        revenue: actual.revenue,
        costs: actual.costs,
        planned_overhead: 0,
        profit: actual.profit
    };
}
