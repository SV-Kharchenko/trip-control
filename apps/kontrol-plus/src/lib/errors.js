// Коди помилок з міграцій Контроль+ і типові помилки Postgres / Supabase Auth → зрозумілий текст.
import { fmtDate, fmtNumber } from './format.js';

// Показник одометра поза межами сусідніх баз (kp_odometer_guard, етап 3b): межа — 'prev' (попередня база, нове
// значення менше) або 'next' (наступна база, нове значення більше — вставка «в минуле»).
export function odometerDecreaseText(km, readOn, kind = 'prev') {
    const at = ' (' + fmtNumber(km) + ' км на ' + fmtDate(readOn) + ')';
    return kind === 'next' ? 'Показник одометра більший за наступний' + at : 'Показник одометра менший за попередній' + at;
}

// ODOMETER_DECREASE з бази: DETAIL 'км|РРРР-ММ-ДД', HINT 'prev' / 'next'.
export function odometerErrorText(error) {
    if (!error || !/ODOMETER_DECREASE/.test(String(error.message || ''))) return null;
    const [km, readOn] = String(error.details || '').split('|');
    return km && readOn ? odometerDecreaseText(km, readOn, error.hint === 'next' ? 'next' : 'prev') : 'Показник одометра менший за попередній.';
}

const BY_MESSAGE = [
    [/CONTROL_PLUS_REQUIRED/, 'Цей розділ доступний у тарифі Контроль+.'],
    [/CLIENT_NOT_FOUND/, 'Клієнта не знайдено або він належить іншій організації.'],
    [/CLIENT_LINK_FORBIDDEN/, 'Привʼязати можна лише власний рейс (власник — будь-який рейс організації).'],
    [/CLIENT_LINK_ORG_MISMATCH/, 'Рейс і клієнт мають бути з однієї організації.'],
    [/CLIENT_ORG_IMMUTABLE/, 'Клієнта не можна перенести в іншу організацію.'],
    [/BAD_PERIOD/, 'Перевірте період: «з» не пізніше «по», не довше двох років.'],
    [/BAD_GROUP/, 'Невідоме групування звіту.'],
    [/GPS_MAP_FORBIDDEN/, 'Привʼязку юнітів до авто змінює лише власник компанії.'],
    [/GPS_VEHICLE_TAKEN|gps_vehicles_integration_vehicle_uidx/, 'Це авто вже привʼязане до іншого юніта.'],
    [/GPS_VEHICLE_NOT_FOUND|GPS_VEHICLE_ORG_MISMATCH/, 'Авто не знайдено в автопарку вашої компанії.'],
    [/GPS_UNIT_NOT_FOUND/, 'Юніт не знайдено. Оновіть список юнітів.'],
    [/clients_org_edrpou_uidx/, 'Клієнт з таким ЄДРПОУ вже є.'],
    [/clients_org_ipn_uidx/, 'Клієнт з таким ІПН вже є.'],
    [/Invalid login credentials/i, 'Невірний email або пароль.'],
    [/Email not confirmed/i, 'Email ще не підтверджено — відкрийте лист від Trip Control.'],
    [/User is banned|banned/i, 'Акаунт заблоковано. Звʼяжіться з підтримкою Trip Control.'],
    [/Failed to fetch|NetworkError|Load failed/i, 'Немає зʼєднання з сервером. Перевірте інтернет.'],
];

const BY_CODE = {
    '42501': 'Недостатньо прав для цієї дії.',
    '23505': 'Такий запис уже існує.',
    '23514': 'Дані не пройшли перевірку формату.',
    '23503': 'Повʼязаний запис не знайдено.',
    'PGRST301': 'Сесія завершилась — увійдіть ще раз.',
};

export function errorText(error) {
    if (!error) return '';
    const message = String(error.message || error.error_description || error);
    const odometer = odometerErrorText(error);
    if (odometer) return odometer;
    for (const [pattern, text] of BY_MESSAGE) if (pattern.test(message)) return text;
    if (error.code && BY_CODE[error.code]) return BY_CODE[error.code];
    return 'Не вдалося виконати дію. Спробуйте ще раз.';
}

// Помилка «немає тарифу» — показуємо екран Контроль+ замість повідомлення.
export function isPlanError(error) {
    return Boolean(error && /CONTROL_PLUS_REQUIRED/.test(String(error.message || '')));
}
