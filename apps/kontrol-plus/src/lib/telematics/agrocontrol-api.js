// Агроконтроль, справжнє API — заглушка. Реального API й токена ще немає, адреси тут не вигадуємо.
// TODO(Агроконтроль): коли з'являться документація й доступ — читання ТІЛЬКИ звітів (пробіг, пальне, простої, заправки / зливи), на сервері
// (api/*), а токен брати зі змінної середовища / секрету, ім'я якого лежить у telematics_sources.api_secret_name. У браузер токен не передавати.
export const API_NOT_CONNECTED = 'API Агроконтролю ще не підключено.';

export class AgrocontrolNotConnected extends Error {
    constructor() {
        super(API_NOT_CONNECTED);
        this.code = 'NOT_CONNECTED';
    }
}

export function createAgrocontrolApi() {
    return {
        kind: 'agrocontrol_api',
        async fetchReports() { throw new AgrocontrolNotConnected(); },
        async fetchFuelEvents() { throw new AgrocontrolNotConnected(); },
    };
}
