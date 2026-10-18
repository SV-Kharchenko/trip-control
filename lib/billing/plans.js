// Тарифи організації. Сума рахується ТІЛЬКИ тут, з коду плану; ціну від клієнта не приймаємо.
// Кожна оплата — окремий рахунок, без автосписань.

export const PLANS = Object.freeze({
    month: Object.freeze({ code: 'month', label: '1 місяць', uah: 250, minor: 25000, months: 1, basketCode: 'TC-MONTH' }),
    year: Object.freeze({ code: 'year', label: '1 рік', uah: 2500, minor: 250000, months: 12, basketCode: 'TC-YEAR' })
});

export const PROVIDERS = Object.freeze(['mono', 'wayforpay']);
export const PROVIDER_LABEL = Object.freeze({ mono: 'plata by mono', wayforpay: 'WayForPay' });
export const CURRENCY = 'UAH';
export const MONO_CCY = 980;

export function planFor(code) {
    return Object.prototype.hasOwnProperty.call(PLANS, code) ? PLANS[code] : null;
}

// Назва послуги в рахунку й чеку ПРРО.
export function productName(plan) {
    return 'Доступ до онлайн-сервісу Trip Control — тариф ' + plan.label;
}

export function paymentDestination(plan) {
    return 'Доступ до сервісу Trip Control, ' + plan.label;
}

// Сума для WayForPay — рядок, однаковий у запиті й у підписі.
export function wayforpayAmount(plan) {
    return String(plan.uah);
}

export function publicPrices() {
    return Object.values(PLANS).map((plan) => ({ plan: plan.code, label: plan.label, uah: plan.uah }));
}

// Те саме, що робить Postgres (timestamptz + interval '1 month' у UTC): кінець місяця «прилипає»
// до останнього дня (31.01 + 1 міс = 28/29.02). Для відображення й тестів; зараховує лише SQL.
export function addMonthsUtc(date, months) {
    const d = new Date(date);
    const day = d.getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1,
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target;
}

// Нове «оплачено до»: від max(зараз, поточне paid_until) + 1 місяць / 1 рік.
export function extendPaidUntil(paidUntil, planCode, now = Date.now()) {
    const plan = planFor(planCode);
    if (!plan) throw new Error('Unknown plan');
    const current = paidUntil ? Date.parse(paidUntil) : NaN;
    const base = Number.isFinite(current) && current > now ? current : now;
    return { from: new Date(base), to: addMonthsUtc(base, plan.months) };
}
