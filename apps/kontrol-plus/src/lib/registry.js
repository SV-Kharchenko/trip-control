// Автопарк і Водії — один шаблон: пошук + «Додати», список лише для читання, картка по кліку. Тут — чисті дані шаблону
// (специфікації полів карток, пошук), без DOM; відображення — views/registry.js.

export const FLEET_TRAILER_TYPES = ['зерновоз', 'рефрижератор', 'тент', 'цистерна'];

// Пошук водіїв — ТІЛЬКИ за ПІБ: нижній регістр, зайві пробіли й апострофи не заважають.
export function normName(value) {
    return String(value === null || value === undefined ? '' : value)
        .toLowerCase()
        .replace(/[’'`ʼ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function driverMatches(fullName, query) {
    const q = normName(query);
    return !q || normName(fullName).includes(q);
}

// width: s 110 | m 150 | ph 170 | l 220 | xl 300 | xxl 360 (px, див. .kpc у crm.css).
export const VEHICLE_FIELDS = [
    { key: 'label', label: 'Держномер', width: 'm', maxlength: 40, required: true, owner: true, placeholder: 'AA 0000 XX', hint: 'Державний номер автомобіля, як у техпаспорті. Має бути унікальним в автопарку.' },
    { key: 'make_model', label: 'Марка / модель', width: 'l', maxlength: 80, owner: true, hint: 'Марка і модель, напр. DAF XF 480.' },
    { key: 'vehicle_type', label: 'Тип ТЗ', width: 'l', maxlength: 100, placeholder: 'напр. тягач сідловий', hint: 'Тип транспортного засобу: тягач сідловий, бортовий, рефрижератор.' },
    { section: 'Для ТТН' },
    { key: 'length_m', label: 'Довжина автопоїзда', width: 's', suffix: 'м', inputmode: 'decimal', hint: 'Довжина автопоїзда (авто з причепом), м. Потрапляє в ТТН.' },
    { key: 'width_m', label: 'Ширина', width: 's', suffix: 'м', inputmode: 'decimal', hint: 'Ширина автопоїзда, м. Потрапляє в ТТН.' },
    { key: 'height_m', label: 'Висота', width: 's', suffix: 'м', inputmode: 'decimal', hint: 'Висота автопоїзда, м. Потрапляє в ТТН.' },
    { key: 'tare_t', label: 'Тара', width: 's', suffix: 'т', inputmode: 'decimal', hint: 'Власна маса порожнього авто за техпаспортом, т.' },
    { key: 'max_mass_t', label: 'Макс. дозволена маса', width: 's', suffix: 'т', inputmode: 'decimal', hint: 'Максимально дозволена повна маса за техпаспортом, т.' },
    { key: 'default_driver_id', label: 'Водій за замовчуванням', width: 'l', type: 'driver', hint: 'Водій, який підставляється в документи для цього авто.' },
    { key: 'default_trailer_id', label: 'Причіп за замовчуванням', width: 'l', type: 'trailer', owner: true, hint: 'Причіп, який зазвичай ходить з цим авто. Підставляється в документи.' },
    { section: 'Строки ТО й страхування' },
    { key: 'oscpv_on', label: 'ОСЦПВ до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої діє поліс ОСЦПВ.' },
    { key: 'kasko_on', label: 'КАСКО до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої діє поліс КАСКО.' },
    { key: 'green_card_on', label: 'Зелена карта до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої діє «Зелена карта» (міжнародне страхування).' },
    { key: 'inspection_on', label: 'Техогляд до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої дійсний технічний огляд.' },
    { key: 'tachograph_on', label: 'Тахограф до', width: 'm', type: 'date', owner: true, hint: 'Дата наступного калібрування (повірки) тахографа.' },
    { key: 'service_on', label: 'ТО до', width: 'm', type: 'date', owner: true, hint: 'Дата наступного планового ТО.' },
];

export const TRAILER_FIELDS = [
    { key: 'plate', label: 'Номер причепа', width: 'm', maxlength: 40, required: true, owner: true, placeholder: 'AA 0000 XX', hint: 'Державний номер причепа, як у техпаспорті.' },
    { key: 'type', label: 'Тип причепа', width: 'm', type: 'trailer_type', owner: true },
    { key: 'make_model', label: 'Марка / модель', width: 'l', maxlength: 100 },
    { key: 'capacity_t', label: 'Вантажопідйомність', width: 's', suffix: 'т', inputmode: 'decimal', hint: 'Вантажопідйомність причепа, т.' },
    { key: 'volume_m3', label: 'Обʼєм', width: 's', suffix: 'м³', inputmode: 'decimal', hint: 'Обʼєм кузова причепа, м³.' },
    { section: 'Строки ТО й страхування' },
    { key: 'oscpv_on', label: 'ОСЦПВ до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої діє поліс ОСЦПВ (якщо причіп застраховано окремо).' },
    { key: 'kasko_on', label: 'КАСКО до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої діє поліс КАСКО.' },
    { key: 'green_card_on', label: 'Зелена карта до', width: 'm', type: 'date', owner: true, hint: 'Дата, до якої діє «Зелена карта» (міжнародне страхування).' },
];

export const DRIVER_FIELDS = [
    { key: 'full_name', label: 'ПІБ', width: 'xl', maxlength: 200, required: true, placeholder: 'Прізвище Імʼя По батькові' },
    { key: 'license_no', label: 'Посвідчення', width: 'm', maxlength: 30, placeholder: 'серія й номер', hint: 'Серія й номер посвідчення водія. Потрапляє в ТТН і подорожній лист.' },
    { section: 'Особисті дані (лише директор змінює; у ТТН не потрапляють)' },
    { key: 'phone', label: 'Телефон', width: 'ph', maxlength: 25, details: true, inputmode: 'tel', placeholder: '+380…' },
    { key: 'passport', label: 'Паспорт (серія / номер)', width: 'm', maxlength: 12, details: true, placeholder: 'АА123456 або 9 цифр' },
    { key: 'ipn', label: 'ІПН / РНОКПП', width: 'm', maxlength: 10, details: true, inputmode: 'numeric', placeholder: '10 цифр' },
    { key: 'address', label: 'Адреса', width: 'xxl', maxlength: 300, details: true },
];

export const numText = (value) => (value === null || value === undefined || value === '' ? '' : String(value).replace('.', ','));
