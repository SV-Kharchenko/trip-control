// Карта GPS (етап 2c): чисті функції — дата за Києвом, поточна заявка авто, «немає сигналу», читач readMap.
// readMap лише читає gps_vehicles.last_* (+ авто, + заявки). Звідки там дані — оновлення карти (2c) чи збирач (2b) —
// йому байдуже, тож 2b його не змінює.

export const NO_SIGNAL_MIN = 30;

const KYIV_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });

// Поточна дата в Europe/Kyiv як 'YYYY-MM-DD'.
export function kyivDate(now = new Date()) {
    return KYIV_DATE.format(now);
}

export function addDays(isoDate, days) {
    const [y, m, d] = String(isoDate).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Тривалість рейсу в добах: ceil(trip_days); null / 0 / мінус / не число — 1 доба.
export function tripDuration(tripDays) {
    const n = Number(tripDays);
    return tripDays !== null && tripDays !== undefined && tripDays !== '' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : 1;
}

// Вікно заявки: trip_date <= today < trip_date + тривалість + 1 доба запасу.
export function inOrderWindow(order, today) {
    if (!order || !/^\d{4}-\d{2}-\d{2}$/.test(String(order.trip_date || ''))) return false;
    return order.trip_date <= today && today < addDays(order.trip_date, tripDuration(order.trip_days) + 1);
}

// Поточна заявка авто: лише 'accepted' (done — рейс уже завершено, тож не поточна навіть у вікні); з кількох —
// найпізніша, що вже почалась; решта — more_orders.
export function currentOrder(orders, today) {
    const active = (orders || [])
        .filter((o) => o && o.status === 'accepted' && inOrderWindow(o, today))
        .sort((a, b) => (a.trip_date === b.trip_date ? String(a.calculation_id).localeCompare(String(b.calculation_id)) : a.trip_date < b.trip_date ? 1 : -1));
    if (!active.length) return { order: null, more_orders: 0 };
    const o = active[0];
    return {
        order: {
            calculation_id: o.calculation_id,
            trip_date: o.trip_date,
            route_from: o.route_from ?? null,
            route_to: o.route_to ?? null,
            client_name: o.client_name ?? null,
        },
        more_orders: active.length - 1,
    };
}

export function isNoSignal(lastPosAt, now = new Date()) {
    const t = Date.parse(lastPosAt || '');
    if (!Number.isFinite(t)) return true;
    return now.getTime() - t > NO_SIGNAL_MIN * 60000;
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Відповідь карти. Лише привʼязані активні юніти своєї організації; без external_id, api_host, токена.
export function buildMapVehicles(units, fleet, orders, now) {
    const today = kyivDate(now);
    const labels = new Map((fleet || []).map((v) => [v.id, v.label]));
    const byVehicle = new Map();
    for (const o of orders || []) {
        if (!byVehicle.has(o.vehicle_id)) byVehicle.set(o.vehicle_id, []);
        byVehicle.get(o.vehicle_id).push(o);
    }
    return (units || [])
        .filter((u) => u && u.active && u.vehicle_id)
        .map((u) => {
            const { order, more_orders } = currentOrder(byVehicle.get(u.vehicle_id), today);
            const lat = num(u.last_lat);
            const lon = num(u.last_lon);
            return {
                gps_vehicle_id: u.id,
                vehicle_id: u.vehicle_id,
                plate: labels.get(u.vehicle_id) || null,
                unit_name: u.name || null,
                lat: lat !== null && lon !== null ? lat : null,
                lon: lat !== null && lon !== null ? lon : null,
                speed: num(u.last_speed),
                course: num(u.last_course),
                last_pos_at: u.last_pos_at || null,
                no_signal: isNoSignal(u.last_pos_at, now),
                order,
                more_orders,
            };
        });
}

export async function readMap(store, orgId, now = new Date()) {
    const units = await store.mappedUnits(orgId);
    const vehicleIds = [...new Set(units.map((u) => u.vehicle_id).filter(Boolean))];
    const [fleet, orders] = await Promise.all([
        store.fleetVehicles(orgId),
        vehicleIds.length ? store.currentOrders(orgId, vehicleIds, kyivDate(now)) : Promise.resolve([]),
    ]);
    return buildMapVehicles(units, fleet, orders, now);
}
