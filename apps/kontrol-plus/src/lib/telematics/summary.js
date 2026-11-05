// Телематика: показники для таблиці «по авто за період» і тексти помилок. Чисті функції.

// Витрата, л на 100 км: лише коли є і пробіг (> 0), і пальне; інакше null.
export function litersPer100(km, fuel) {
    const k = Number(km);
    const f = Number(fuel);
    if (km === null || km === undefined || fuel === null || fuel === undefined || !Number.isFinite(k) || !Number.isFinite(f) || k <= 0) return null;
    return (f / k) * 100;
}

const nf = (digits) => new Intl.NumberFormat('uk-UA', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function fmtNum(value, digits = 1) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
    return nf(digits).format(Number(value));
}

// Хвилини → «3 г 05 хв».
export function fmtMinutes(value) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
    const m = Math.round(Number(value));
    return Math.floor(m / 60) + ' г ' + String(m % 60).padStart(2, '0') + ' хв';
}

// Рядок зведення tm_summary → рядок таблиці. vehicles: [{ id, label }]; units: [{ id, name }].
export function summaryRow(row, vehicles, units) {
    const vehicle = row.vehicle_id ? vehicles.find((v) => v.id === row.vehicle_id) : null;
    const unit = row.unit_id ? units.find((u) => u.id === row.unit_id) : null;
    return {
        key: row.ref + '|' + (row.vehicle_id || ''),
        ref: row.ref,
        label: vehicle ? vehicle.label : row.ref,
        mapped: Boolean(vehicle),
        unit: unit ? unit.name : '',
        days: Number(row.days || 0),
        mileage: row.mileage_km === null ? null : Number(row.mileage_km),
        fuel: row.fuel_used_l === null ? null : Number(row.fuel_used_l),
        l100: litersPer100(row.mileage_km, row.fuel_used_l),
        idle: row.idle_minutes === null ? null : Number(row.idle_minutes),
        engine: row.engine_hours === null ? null : Number(row.engine_hours),
        drainCount: Number(row.drain_count || 0),
        drainL: Number(row.drain_l || 0),
        refuelL: Number(row.refuel_l || 0),
    };
}

// Дата 'YYYY-MM-DD' зі зсувом у днях від сьогодні (локальний календар).
export function isoDaysAgo(days, now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const BY_MESSAGE = [
    [/TELEMATICS_FORBIDDEN/, 'Немає доступу до телематики. Розділ доступний директору, менеджеру й логісту.'],
    [/TELEMATICS_SOURCE_NOT_FOUND/, 'Джерело даних не знайдено. Оновіть сторінку.'],
    [/TELEMATICS_TOO_MANY_ROWS/, 'Понад 5000 рядків за раз. Розбийте файл на частини.'],
    [/TELEMATICS_VEHICLE_NOT_FOUND/, 'Авто не знайдено.'],
    [/TELEMATICS_UNIT_NOT_FOUND/, 'Підрозділ не знайдено.'],
    [/TELEMATICS_INVALID/, 'Некоректні дані.'],
];
export function telematicsErrorText(error) {
    const message = String((error && (error.message || error.error_description)) || error || '');
    for (const [pattern, text] of BY_MESSAGE) if (pattern.test(message)) return text;
    if (error && error.code === 'NOT_CONNECTED') return message;
    return 'Не вдалося виконати дію. Спробуйте ще раз.';
}
