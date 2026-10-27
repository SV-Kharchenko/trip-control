// Автопарк для поля «Фура» калькулятора. Сайт читає fleet_vehicles під RLS (org_id = current_org_id()): власник і логіст
// бачать весь парк компанії, а директор і менеджер ремонтів із чужої організації — порожній список. Для них (без нових RPC)
// беремо kp_vehicles_list() і викладаємо у ту саму структуру, що й loadFleetVehicles() сайту. Норм пального в цьому RPC
// немає — поля лишаються порожніми, калькулятор бере норми компанії.
export function kpVehiclesToSite(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: row.id,
        label: row.label,
        make_model: row.make_model ?? null,
        year_made: null,
        oscpv_on: row.oscpv_on ?? null,
        kasko_on: row.kasko_on ?? null,
        green_card_on: row.green_card_on ?? null,
        inspection_on: row.inspection_on ?? null,
        tachograph_on: row.tachograph_on ?? null,
        service_on: row.service_on ?? null,
        fuel_load: null,
        fuel_empty: null,
        adblue_on: null,
        adblue_consumption: null,
        trailer_plate: row.trailer_plate ?? null,
        trailer_type: row.trailer_type ?? null,
        payload_t: row.payload_t ?? null,
        vehicle_type: row.vehicle_type ?? null,
        trailer_make_model: row.trailer_make_model ?? null,
        length_m: row.length_m ?? null,
        width_m: row.width_m ?? null,
        height_m: row.height_m ?? null,
        tare_t: row.tare_t ?? null,
        max_mass_t: row.max_mass_t ?? null,
    }));
}

// Чи потрібен запасний шлях: сайт нічого не завантажив, а Контроль+ дає доступ до документів (owner / logist / director).
export function needsKpFleet(siteVehicles, context) {
    const empty = !Array.isArray(siteVehicles) || siteVehicles.length === 0;
    const role = context && context.control_plus === true ? context.role : null;
    return empty && (role === 'owner' || role === 'logist' || role === 'director');
}
