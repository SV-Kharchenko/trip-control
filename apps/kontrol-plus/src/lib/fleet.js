// Авто для ТТН (етап 4b): поля ТЗ (нові колонки fleet_vehicles) і строки ТО / страхування — та сама логіка підсвітки,
// що в картці авто сайту (fleetDocState в index.html): прострочено — червоний, до N днів — жовтий (N = 30 за замовчуванням).
import { parseNum } from './ttn.js';

export const FLEET_DOCS = [
    ['oscpv_on', 'ОСЦПВ'],
    ['kasko_on', 'КАСКО'],
    ['green_card_on', 'Зелена карта'],
    ['inspection_on', 'Техогляд'],
    ['tachograph_on', 'Тахограф'],
    ['service_on', 'ТО'],
];
export const FLEET_WARN_DAYS = 30;

export function daysLeft(expiresOn, today) {
    const exp = String(expiresOn || '').slice(0, 10);
    const now = String(today || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp) || !/^\d{4}-\d{2}-\d{2}$/.test(now)) return null;
    return Math.round((Date.parse(exp + 'T00:00:00Z') - Date.parse(now + 'T00:00:00Z')) / 86400000);
}

// 'empty' | 'overdue' | 'soon' | 'ok'.
export function docState(expiresOn, today, warnDays = FLEET_WARN_DAYS) {
    const days = daysLeft(expiresOn, today);
    if (days === null) return 'empty';
    if (days < 0) return 'overdue';
    if (days <= warnDays) return 'soon';
    return 'ok';
}

// Бейдж на згорнутому заголовку блоку «Додаткова інформація про ТО і Страхування»: кількість жовтих / червоних строків.
export function fleetBadge(vehicle, today, warnDays = FLEET_WARN_DAYS) {
    let overdue = 0;
    let soon = 0;
    for (const [key] of FLEET_DOCS) {
        const state = docState(vehicle && vehicle[key], today, warnDays);
        if (state === 'overdue') overdue += 1;
        else if (state === 'soon') soon += 1;
    }
    if (overdue) return { tone: 'overdue', count: overdue + soon, text: overdue + soon + (overdue ? ' · прострочено' : '') };
    if (soon) return { tone: 'soon', count: soon, text: soon + ' · скоро' };
    return null;
}

export const VEHICLE_TTN_FIELDS = ['vehicle_type', 'trailer_make_model', 'length_m', 'width_m', 'height_m', 'tare_t', 'max_mass_t', 'default_driver_id'];

// Поля ТЗ для kp_vehicle_save — ті самі межі, що CHECK-и fleet_vehicles: тексти ≤ 100 без керівних символів,
// габарити 0 < x ≤ 30 м, тара й макс. маса 0 < x ≤ 100 т, тара < макс. маси. → { data, errors }.
export function validateVehicleTtn(input) {
    const errors = {};
    const data = {};
    for (const key of ['vehicle_type', 'trailer_make_model']) {
        const text = String(input[key] == null ? '' : input[key]).trim();
        if (text.length > 100) errors[key] = 'До 100 символів';
        else if (/[\u0000-\u001F\u007F]/.test(text)) errors[key] = 'Без службових символів';
        data[key] = text || null;
    }
    for (const [key, max] of [['length_m', 30], ['width_m', 30], ['height_m', 30], ['tare_t', 100], ['max_mass_t', 100]]) {
        const n = parseNum(input[key]);
        if (n !== null && (Number.isNaN(n) || n <= 0 || n > max)) errors[key] = 'Більше 0, до ' + max + (max === 30 ? ' м' : ' т');
        data[key] = n === null || Number.isNaN(n) ? null : n;
    }
    if (!errors.tare_t && !errors.max_mass_t && data.tare_t !== null && data.max_mass_t !== null && data.tare_t >= data.max_mass_t) {
        errors.tare_t = 'Тара має бути меншою за максимально дозволену масу';
    }
    data.default_driver_id = input.default_driver_id || null;
    return { data, errors };
}

const DRIVER_LICENSE = /^[0-9A-ZА-ЯҐЄІЇ]{1,30}$/;

// Персональні дані водія (картка водія): телефон, паспорт, ІПН / РНОКПП (рівно 10 цифр), адреса. У ТТН не потрапляють.
// Ті самі правила, що в CHECK-обмеженнях і kp_driver_details_save (міграція 20261028100100).
export function validateDriverDetails(input) {
    const errors = {};
    const src = input || {};
    const phone = String(src.phone || '').replace(/[\s()\-]/g, '');
    const passport = String(src.passport || '').replace(/\s/g, '').toUpperCase();
    const ipn = String(src.ipn || '').replace(/\s/g, '');
    const address = String(src.address || '').replace(/\s+/g, ' ').trim();
    if (phone && !/^\+?[0-9]{10,15}$/.test(phone)) errors.phone = 'Телефон: 10–15 цифр, напр. +380671234567';
    if (passport && !/^([A-ZА-ЯІЇЄҐ]{2}[0-9]{6}|[0-9]{9})$/.test(passport)) errors.passport = 'Серія й номер: 2 літери + 6 цифр (АА123456) або ID-картка з 9 цифр';
    if (ipn && !/^[0-9]{10}$/.test(ipn)) errors.ipn = 'ІПН / РНОКПП — рівно 10 цифр';
    if (address.length > 300) errors.address = 'Адреса — до 300 символів';
    return { data: { phone: phone || null, passport: passport || null, ipn: ipn || null, address: address || null }, errors };
}

export function validateDriver(input) {
    const errors = {};
    const full_name = String(input.full_name || '').replace(/\s+/g, ' ').trim();
    const license_no = String(input.license_no || '').replace(/\s+/g, '').toUpperCase();
    if (!full_name) errors.full_name = 'Вкажіть ПІБ водія';
    else if (full_name.length > 200) errors.full_name = 'До 200 символів';
    if (license_no && !DRIVER_LICENSE.test(license_no)) errors.license_no = 'Серія й номер посвідчення: літери й цифри, до 30';
    return { data: { full_name, license_no: license_no || null }, errors };
}
