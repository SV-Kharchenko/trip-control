// Агроконтроль (provider = 'agrocontrol') — лише каркас клієнта. Інтеграція НЕ підключена: справжніх адрес, методів і
// формату відповідей тут немає, тож кожен метод чесно повертає / кидає код not_configured. Токен доступу зберігається
// у Vault так само, як для Wialon (gps_connect → gps_store_token), у браузер не віддається і сюди потрапляє лише з
// сервера. Мережевих викликів цей файл не робить.
//
// TODO(agrocontrol): коли буде документація API Агроконтролю —
//   1) connect/test: перевірка токена методом авторизації провайдера → { ok, account, unitsTotal };
//   2) units: список обʼєктів (+ групи, якщо є) → [{ externalId, name }];
//   3) positions: останні позиції вибраних обʼєктів з бюджетом часу, як у providers/wialon.js;
//   4) прибрати not_configured і додати домен у allowlist safe-host.js.
import { GpsError } from '../errors.js';

export const AGROCONTROL_NOT_CONFIGURED = 'not_configured';

function notConfigured() {
    return new GpsError(AGROCONTROL_NOT_CONFIGURED, 'agrocontrol_stub');
}

export function createAgrocontrolProvider() {
    const refuse = () => ({ ok: false, code: AGROCONTROL_NOT_CONFIGURED });
    return {
        id: 'agrocontrol',
        configured: false,
        // connect / test: токен не перевіряється нікуди.
        connect: async () => refuse(),
        test: async () => refuse(),
        validateCredentials: async () => refuse(),
        // units / positions: явна помилка, а не порожній список (щоб не видати «0 юнітів» за правду).
        units: async () => { throw notConfigured(); },
        listUnits: async () => { throw notConfigured(); },
        positions: async () => { throw notConfigured(); },
        fetchPositions: async () => { throw notConfigured(); },
    };
}
