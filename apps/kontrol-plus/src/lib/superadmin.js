// Кабінет суперадміна платформи (#/superadmin): довідник модулів, тексти помилок та чисті функції для відображення.
// Лише підказки інтерфейсу: усі перевірки робить база (sa_* RPC → is_platform_superadmin()).
export const AUDIT_PAGE = 50;
export const ORGS_PAGE = 25;

// Модулі платформи. Ключ = app_settings.key = organizations.features ->> key. Опис у таблиці app_settings не зберігається.
export const MODULES = [
    { key: 'own_fleet', label: 'Власний парк', desc: 'Підрозділи, точки, заявки на рейс, дошка диспетчера й замовники підрозділів.' },
];

export function moduleInfo(key) {
    return MODULES.find((m) => m.key === key) || { key, label: key, desc: 'Модуль без опису.' };
}

const ACTIONS = { 'setting.set': 'Глобальний перемикач', 'setting.create': 'Створено рядок перемикача', 'org.feature.set': 'Модуль компанії' };
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
    return keys.map((k) => YES(obj[k])).join(', ');
}
export function auditTarget(row) {
    if (row.target_type === 'app_setting') return moduleInfo(row.target_id).label;
    if (row.target_type === 'organization') {
        const keys = Object.keys(row.after || {});
        return 'Компанія ' + String(row.target_id || '').slice(0, 8) + (keys.length ? ' · ' + moduleInfo(keys[0]).label : '');
    }
    return String(row.target_id || '');
}

const BY_MESSAGE = [
    [/SUPERADMIN_REQUIRED/, 'Немає доступу: ця сторінка лише для адміністраторів платформи.'],
    [/SA_UNKNOWN_MODULE/, 'Невідомий модуль. Перемикати можна лише модулі платформи.'],
    [/SA_ALREADY_EXISTS/, 'Рядок перемикача вже існує. Оновіть сторінку.'],
    [/SA_ORG_NOT_FOUND/, 'Компанію не знайдено.'],
    [/SA_INVALID/, 'Некоректне значення.'],
];
export function superadminErrorText(error) {
    const message = String((error && (error.message || error.error_description)) || error || '');
    for (const [pattern, text] of BY_MESSAGE) if (pattern.test(message)) return text;
    return 'Не вдалося виконати дію. Спробуйте ще раз.';
}
