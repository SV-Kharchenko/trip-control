// Внутрішні коди помилок GPS-провайдерів → людський текст українською. Тексти не містять токена, адрес чи тіл
// відповідей провайдера: лише код.
export class GpsError extends Error {
    constructor(code, reason) {
        super(code);
        this.name = 'GpsError';
        this.code = code;
        // Технічна причина для тестів (без токена, без адрес); у відповіді клієнту не йде.
        if (reason) this.reason = reason;
    }
}

export const GPS_MESSAGES = {
    invalid_session: 'Сесія Wialon завершилась. Спробуйте ще раз.',
    bad_params: 'Wialon не прийняв запит. Спробуйте пізніше або напишіть у підтримку.',
    access_denied: 'У користувача Wialon немає прав на перегляд обʼєктів.',
    invalid_token: 'Токен Wialon недійсний або відкликаний. Створіть новий токен.',
    auth_unavailable: 'Сервер авторизації Wialon зараз недоступний. Спробуйте пізніше.',
    rate_limited: 'Wialon тимчасово обмежив запити. Спробуйте за хвилину.',
    network: 'Не вдалося зʼєднатися із сервером Wialon. Перевірте адресу й доступність сервера з інтернету.',
    tls: 'Сертифікат сервера Wialon недійсний. Потрібен дійсний сертифікат (самопідписаний не підтримується).',
    unsafe_host: 'Цю адресу сервера не можна використати. Потрібна публічна адреса https:// з доменним імʼям.',
    provider_error: 'Wialon повернув помилку. Спробуйте пізніше.',
};

export function gpsMessage(code) {
    return GPS_MESSAGES[code] || GPS_MESSAGES.provider_error;
}

// Коди, після яких підключення позначаємо як проблему з доступом (error_auth), а не тимчасову (error).
export const AUTH_CODES = new Set(['invalid_token', 'access_denied']);
