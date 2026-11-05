// Адаптер телематики (Агроконтроль): лише читання звітів. Інтерфейс однаковий для всіх джерел:
//   adapter.kind                       — 'agrocontrol_mock' | 'agrocontrol_api'
//   adapter.fetchReports({ from, to })     → Promise<[{ date, ref, mileage_km, fuel_used_l, idle_minutes, engine_hours, raw }]>
//   adapter.fetchFuelEvents({ from, to })  → Promise<[{ ts, ref, kind: 'refuel' | 'drain', liters, location, raw }]>
// from / to — дати 'YYYY-MM-DD' включно. Результат йде у RPC tm_import_reports / tm_import_fuel_events (вони ж і нормалізують номери).
// ctx: { orgId, vehicles: [{ id, label }] } — авто організації (для тестових даних).
import { createAgrocontrolApi } from './agrocontrol-api.js';
import { createAgrocontrolMock } from './agrocontrol-mock.js';

export const SOURCE_KINDS = {
    agrocontrol_mock: 'Агроконтроль (тестові дані)',
    agrocontrol_api: 'Агроконтроль (API)',
    file_import: 'Файли звітів',
};

// Кнопка «Синхронізувати (тестові дані)» — лише для тестового джерела.
export function canSyncMock(source) {
    return Boolean(source && source.kind === 'agrocontrol_mock');
}

export function createAdapter(kind, ctx) {
    if (kind === 'agrocontrol_mock') return createAgrocontrolMock(ctx);
    if (kind === 'agrocontrol_api') return createAgrocontrolApi(ctx);
    throw new Error('Для цього джерела синхронізації немає. Завантажте файл звіту.');
}
