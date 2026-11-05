// Гейт модуля «Власний парк» за відповіддю own_fleet_context() (рядок { org_id, role, unit_ids } або порожньо, якщо прапорця own_fleet
// в організації немає чи доступу немає). Лише підказка інтерфейсу: справжню перевірку роблять RLS і функції БД (*_own_fleet.sql).
// Файл крихітний і лежить в основному бандлі; сам модуль (views/own-fleet/) вантажиться lazy і тільки з прапорцем.
export function ownFleetAccess(context) {
    const role = context && context.org_id ? context.role : null;
    const isRequester = role === 'requester';
    return {
        enabled: Boolean(role),
        role,
        isRequester,
        canManage: role === 'owner' || role === 'director' || role === 'logist',
        unitIds: isRequester && Array.isArray(context.unit_ids) ? context.unit_ids : [],
    };
}

// Замовник підрозділу без власного Контроль+: бачить лише «Власний парк» (як repairsOnly у відповідального за ремонти).
export function ownFleetOnly(access, kpContext) {
    return Boolean(access && access.isRequester && !(kpContext && kpContext.control_plus === true));
}
