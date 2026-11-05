// Запасний вимикач модулів на фронті: env KP_DISABLED_FEATURES (через кому) доходить сюди через /api/config → window.TC_CONFIG.disabledFeatures.
// Гасить модуль без міграції; надійний вимикач — app_settings у БД (feature_enabled, див. docs/STAGING.md). Приклад: featureDisabled('own_fleet').
export function featureDisabled(key, config) {
    const cfg = config === undefined ? (typeof window !== 'undefined' ? window.TC_CONFIG : null) : config;
    const list = cfg && Array.isArray(cfg.disabledFeatures) ? cfg.disabledFeatures : [];
    return list.includes(String(key || '').toLowerCase());
}
