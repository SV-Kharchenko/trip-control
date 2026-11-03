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

// Тріал 7 днів (нові компанії): trial_ends_at — початок київської доби після 7-го дня. daysLeft — календарні дні
// за Києвом ВКЛЮЧНО з сьогоднішнім: у день реєстрації 7, в останній день 1. Нема trial_ends_at — тріалу немає.
export function trialInfo(trialEndsAt, now = Date.now()) {
    const end = Date.parse(trialEndsAt || '');
    if (!Number.isFinite(end)) return { has: false, active: false, expired: false, daysLeft: 0, lastDay: false };
    const active = end > now;
    const toDays = (ymd) => Date.parse(ymd + 'T00:00:00Z') / 86400000;
    const daysLeft = active ? Math.round(toDays(kyivYmd(end - 1)) - toDays(kyivYmd(now))) + 1 : 0;
    return { has: true, active, expired: !active, daysLeft, lastDay: active && daysLeft <= 1 };
}

// «Лише читання» (дзеркало SQL org_readonly): тріал був і скінчився, оплати й ручного повного доступу немає.
export function isReadOnlyAccess({ trialEndsAt, paidUntil, isApproved }, now = Date.now()) {
    return !isApproved && trialInfo(trialEndsAt, now).expired && !hasPaidAccess(paidUntil, now);
}

// Підписка організації для сервера. Таблиці або колонки тріалу ще може не бути (міграція не застосована) —
// тоді тріалу немає, без помилки: усе лишається як було.
async function loadSubscription(supabase, orgId) {
    if (!orgId) return null;
    try {
        let res = await supabase.from('org_subscriptions').select('paid_until, trial_ends_at').eq('org_id', orgId).maybeSingle();
        if (res.error) res = await supabase.from('org_subscriptions').select('paid_until').eq('org_id', orgId).maybeSingle();
        if (res.error || !res.data) return null;
        return { paid_until: res.data.paid_until || null, trial_ends_at: res.data.trial_ends_at || null };
    } catch (e) {
        return null;
    }
}

// «Доступ до»: пізніше з paid_until і trial_ends_at (активний тріал = повний доступ, як оплата).
export async function loadPaidUntil(supabase, orgId, now = Date.now()) {
    const sub = await loadSubscription(supabase, orgId);
    if (!sub) return null;
    const paid = Date.parse(sub.paid_until || '');
    const trial = Date.parse(sub.trial_ends_at || '');
    const best = Math.max(Number.isFinite(paid) ? paid : -Infinity, Number.isFinite(trial) ? trial : -Infinity);
    if (best === -Infinity) return null;
    return (Number.isFinite(paid) && paid === best ? sub.paid_until : sub.trial_ends_at) || null;
}

export async function isOrgReadOnly(supabase, orgId, profile, now = Date.now()) {
    if (profile && profile.is_approved) return false;
    const sub = await loadSubscription(supabase, orgId);
    if (!sub || !isReadOnlyAccess({ trialEndsAt: sub.trial_ends_at, paidUntil: sub.paid_until, isApproved: false }, now)) return false;
    // Як у SQL org_readonly: ручне схвалення будь-якого учасника компанії (is_approved) — постійний повний доступ.
    try {
        const { data } = await supabase.from('profiles').select('id').eq('org_id', orgId).eq('is_approved', true).limit(1);
        if (Array.isArray(data) && data.length) return false;
    } catch (e) { /* не знаємо — вважаємо «лише читання», БД перевірить ще раз */ }
    return true;
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
