// Гейт вкладок Контроль+ за відповіддю kp_context(). Лише підказка інтерфейсу: справжня перевірка — RLS і функції БД
// (CONTROL_PLUS_REQUIRED для org без plan = 'control_plus').
export const ROLE_LABELS = { owner: 'Власник', logist: 'Логіст', director: 'Директор (перегляд)' };

export function crmAccess(context) {
    if (!context) return 'paywall';
    return context.control_plus === true ? 'open' : 'paywall';
}

export function crmPermissions(context) {
    const role = context && context.control_plus === true ? context.role : null;
    return {
        canWrite: role === 'owner' || role === 'logist',
        canDelete: role === 'owner',
    };
}
