// Блок конкретного користувача (не всієї компанії) — бан у Supabase Auth (banned_until).
// Забанений не може увійти; API додатково відхиляє запити з ще чинним токеном.
export const BLOCK_BAN_DURATION = '876000h'; // ~100 років = «доки адмін не розблокує»

export function userIsBlocked(user, now = Date.now()) {
    const until = user && user.banned_until;
    if (!until) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && at > now;
}

export function userAccessStatus(user, profile, now = Date.now()) {
    if (userIsBlocked(user, now)) return 'blocked';
    return profile && profile.is_approved ? 'full' : 'demo';
}

export const USER_BLOCKED_ERROR = {
    code: 'USER_BLOCKED',
    error: 'Акаунт заблоковано, зверніться в підтримку.'
};
