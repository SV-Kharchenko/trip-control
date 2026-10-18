// Доступ: ручне схвалення (profiles.is_approved) — постійний повний доступ;
// інакше повний доступ, доки оплачено (paid_until > зараз). Те саме рахує SQL current_is_approved().

export function hasPaidAccess(paidUntil, now = Date.now()) {
    if (!paidUntil) return false;
    const at = Date.parse(paidUntil);
    return Number.isFinite(at) && at > now;
}

export function isDemoAccess(profile, paidUntil, now = Date.now()) {
    return !((profile && profile.is_approved) || hasPaidAccess(paidUntil, now));
}

// paid_until організації для сервера. Таблиці ще може не бути (міграція не застосована) —
// тоді «не оплачено», без помилки: демо-режим лишається як був.
export async function loadPaidUntil(supabase, orgId) {
    if (!orgId) return null;
    try {
        const { data, error } = await supabase
            .from('org_subscriptions')
            .select('paid_until')
            .eq('org_id', orgId)
            .maybeSingle();
        if (error || !data) return null;
        return data.paid_until || null;
    } catch (e) {
        return null;
    }
}

const KYIV_DATE = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' });

export function formatKyivDate(at) {
    const d = new Date(at);
    return Number.isFinite(d.getTime()) ? KYIV_DATE.format(d) : '';
}

// Календарна дата в Києві як 'YYYY-MM-DD' (для нагадувань: крон плаває ±1 год).
export function kyivYmd(at) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(at));
    const get = (type) => parts.find((p) => p.type === type).value;
    return get('year') + '-' + get('month') + '-' + get('day');
}

export function addDaysYmd(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return t.toISOString().slice(0, 10);
}
