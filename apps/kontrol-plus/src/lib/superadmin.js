// Кабінет суперадміна платформи (#/superadmin): довідник модулів, тексти помилок та чисті функції для відображення.
// Лише підказки інтерфейсу: усі перевірки робить база (sa_* RPC → is_platform_superadmin()).
export const AUDIT_PAGE = 50;
export const ORGS_PAGE = 25;

// Модулі платформи. Ключ = app_settings.key = organizations.features ->> key. Опис у таблиці app_settings не зберігається.
export const MODULES = [
    { key: 'own_fleet', label: 'Власний парк', desc: 'Підрозділи, точки, заявки на рейс, дошка диспетчера й замовники підрозділів.' },
    { key: 'agro', label: 'Park-Control', desc: 'Вхід в Park-Control із Контроль+ без повторного логіну.' },
];

export function moduleInfo(key) {
    return MODULES.find((m) => m.key === key) || { key, label: key, desc: 'Модуль без опису.' };
}

const ACTIONS = { 'setting.set': 'Глобальний перемикач', 'setting.create': 'Створено рядок перемикача', 'org.feature.set': 'Модуль компанії', 'org.plan.set': 'Тариф компанії', 'user.agro.set': 'Доступ до Park-Control (користувач)' };

// «Доступ до AGRO для користувачів» у картці компанії: перевизначення (null — як у компанії) і причина ефективного стану (agro_access_for).
export const AGRO_CHOICES = [['', 'Як у компанії'], ['true', 'Дозволено'], ['false', 'Заборонено']];
export function agroChoiceValue(override) {
    return override === true ? 'true' : override === false ? 'false' : '';
}
export function agroChoiceArg(value) {
    return value === 'true' ? true : value === 'false' ? false : null;
}
const AGRO_REASONS = {
    global_off: 'вимкнено глобально', user_blocked: 'користувача заблоковано', email_unconfirmed: 'пошту не підтверджено', no_org: 'немає компанії',
    org_blocked: 'компанію заблоковано', user_override: 'персональне налаштування', org: 'за прапорцем компанії',
};
export function agroEffectiveText(row) {
    const reason = AGRO_REASONS[row && row.reason] || '';
    return (row && row.allowed === true ? 'Доступ є' : 'Доступу немає') + (reason ? ' · ' + reason : '');
}
// Тариф компанії (organizations.plan): company = «Сайт», control_plus = «Контроль+». Оплата (org_subscriptions.paid_until) від тарифу не залежить.
export const PLANS = [{ key: 'company', label: 'Сайт' }, { key: 'control_plus', label: 'Контроль+' }];
export function planLabel(plan) {
    const found = PLANS.find((p) => p.key === plan);
    return found ? found.label : '—';
}
export const PLAN_MODULES_HINT = 'Модулі (Власний парк, Park-Control) працюють лише на тарифі Контроль+.';
// Текст підтвердження зміни тарифу: { title, text } для tcModal.
export function planConfirm(name, plan) {
    const n = '«' + (name || 'компанії') + '»';
    return plan === 'control_plus'
        ? { title: 'Увімкнути тариф Контроль+ для ' + n + '?', text: '' }
        : { title: 'Перевести ' + n + ' на тариф Сайт?', text: 'Розділи Контроль+ (клієнти, GPS, ремонти, документи, план/факт) стануть недоступні, дані не видаляються.' };
}
export function actionLabel(action) {
    return ACTIONS[action] || String(action || '');
}

// Стан модуля за app_settings: 'missing' (немає рядка = вимкнено), 'on', 'off'.
export function settingState(row) {
    if (!row) return 'missing';
    return row.enabled === true ? 'on' : 'off';
}

// Рядки блоку «Глобальні функції»: усі відомі модулі + будь-які інші ключі з app_settings.
export function settingRows(settings) {
    const byKey = new Map((settings || []).map((s) => [s.key, s]));
    const keys = [...MODULES.map((m) => m.key), ...[...byKey.keys()].filter((k) => !MODULES.some((m) => m.key === k)).sort()];
    return keys.map((key) => ({ ...moduleInfo(key), row: byKey.get(key) || null, state: settingState(byKey.get(key)) }));
}

// Прапорець компанії «увімкнено» — так само, як у базі (features ->> key = 'true'): булеве true або рядок "true".
export function featureOn(features, key) {
    const v = features && typeof features === 'object' ? features[key] : undefined;
    return v === true || v === 'true';
}

// Підказка в рядку компанії: прапорець увімкнено, а глобально модуль вимкнено (чи рядка немає).
export function orgModuleNote(orgOn, globalState) {
    if (orgOn && globalState !== 'on') return 'Не працює, бо вимкнено глобально.';
    if (!orgOn && globalState === 'on') return 'Глобально ввімкнено, для цієї компанії вимкнено.';
    return '';
}

export function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const YES = (v) => (v === true || v === 'true' ? 'увімкнено' : v === false || v === 'false' ? 'вимкнено' : '—');
// «було → стало» для запису журналу: {enabled:false} → «вимкнено», {own_fleet:true} → «увімкнено».
export function auditValue(obj) {
    if (!obj || typeof obj !== 'object') return '—';
    const keys = Object.keys(obj);
    if (!keys.length) return '—';
    if (keys.includes('plan')) return planLabel(obj.plan);
    return keys.map((k) => YES(obj[k])).join(', ');
}
export function auditTarget(row) {
    if (row.target_type === 'app_setting') return moduleInfo(row.target_id).label;
    if (row.target_type === 'user') return 'Користувач ' + String(row.target_id || '').slice(0, 8) + ' · Park-Control';
    if (row.target_type === 'organization') {
        const keys = Object.keys(row.after || {});
        return 'Компанія ' + String(row.target_id || '').slice(0, 8) + (keys.length ? ' · ' + (keys[0] === 'plan' ? 'Тариф' : moduleInfo(keys[0]).label) : '');
    }
    return String(row.target_id || '');
}

const BY_MESSAGE = [
    [/SUPERADMIN_REQUIRED/, 'Немає доступу: ця сторінка лише для адміністраторів платформи.'],
    [/SA_UNKNOWN_MODULE/, 'Невідомий модуль. Перемикати можна лише модулі платформи.'],
    [/SA_ALREADY_EXISTS/, 'Рядок перемикача вже існує. Оновіть сторінку.'],
    [/SA_ORG_NOT_FOUND/, 'Компанію не знайдено.'],
    [/SA_USER_NOT_FOUND/, 'Користувача не знайдено.'],
    [/SA_INVALID/, 'Некоректне значення.'],
];
export function superadminErrorText(error) {
    const message = String((error && (error.message || error.error_description)) || error || '');
    for (const [pattern, text] of BY_MESSAGE) if (pattern.test(message)) return text;
    return 'Не вдалося виконати дію. Спробуйте ще раз.';
}
