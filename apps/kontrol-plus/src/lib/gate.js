// Гейт вкладок Контроль+ за відповіддю kp_context(). Лише підказка інтерфейсу: справжня перевірка — RLS і функції БД
// (CONTROL_PLUS_REQUIRED для org без plan = 'control_plus').
export const ROLE_LABELS = { owner: 'Власник', logist: 'Логіст', director: 'Директор (перегляд)' };

export function crmAccess(context) {
    if (!context) return 'paywall';
    return context.control_plus === true ? 'open' : 'paywall';
}

// Вкладка «GPS»: видно всім ролям організації на control_plus; керує власник; метадані підключення бачать власник
// і директор (як RLS gps_integrations); юніти й мапінг (перегляд) — усі.
export function gpsAccess(context) {
    const plan = Boolean(context && context.control_plus === true);
    const role = plan ? context.role : null;
    return {
        visible: plan,
        canManage: role === 'owner',
        seesIntegration: role === 'owner' || role === 'director',
    };
}

export function crmPermissions(context) {
    const role = context && context.control_plus === true ? context.role : null;
    return {
        canWrite: role === 'owner' || role === 'logist',
        canDelete: role === 'owner',
    };
}
