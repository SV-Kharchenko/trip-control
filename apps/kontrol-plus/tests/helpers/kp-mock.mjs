// Підміна Supabase й вигадані дані для браузерних перевірок і знімків екранів Контроль+ (без входу й без мережі). Лише тести.
export const UUID = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

export const client = {
    id: UUID(1), name: 'ТОВ «Агро-Південь»', legal_name: 'Товариство з обмеженою відповідальністю «Агро-Південь»', legal_form: 'tov', edrpou: '38475612', ipn: '384756126587',
    vat_payer: true, vat_number: '384756126587', iban: 'UA213223130000026007233566001', bank_name: 'АТ КБ «ПриватБанк»', legal_address: '65012, м. Одеса, вул. Хімічна, 14, оф. 3',
    postal_address: '65012, м. Одеса, а/с 77', signer_position: 'Директор', signer_name: 'Коваленко Олександр Петрович', contact_name: 'Марина Іваненко', phone: '+380487001122',
    email: 'office@agro-pivden.example', notes: 'Оплата за 5 банківських днів.', created_at: '2026-09-02T09:00:00Z', archived_at: null, contract_no: '12/2026', contract_date: '2026-09-05', payment_terms_days: 5,
};
export const requisites = { edrpou: '41234567', ipn: '412345678901', iban: 'UA903052992990004149123456789', vat_payer: true, default_vat_mode: 'net', default_currency: 'UAH', invoice_prefix: '', act_prefix: '' };
export const trips = [
    { calculation_id: UUID(21), trip_date: '2026-11-03', route_from: 'Одеса', route_to: 'Київ', price: 28400, price_source: 'fact' },
    { calculation_id: UUID(22), trip_date: '2026-11-05', route_from: 'Київ', route_to: 'Львів', price: 31200, price_source: 'plan' },
    { calculation_id: UUID(23), trip_date: '2026-11-07', route_from: 'Львів', route_to: 'Одеса', price: 36950, price_source: 'plan' },
];
export const ttn = {
    id: UUID(5), number: 7, number_text: '7', doc_date: '2026-11-03', status: 'issued', client_id: UUID(1), client_name: client.name, created_by_email: 'director@example.com',
    calculation_id: UUID(21), place_of_issue: 'м. Одеса', transport_kind: 'Внутрішні перевезення',
    vehicle: { make_model: 'MAN TGX 18.510', vehicle_type: 'Сідловий тягач', plate: 'BH 4821 CK', trailer_plate: 'BH 1177 XT', trailer_make_model: 'Schmitz SKO 24', trailer_type: 'Рефрижератор' },
    carrier: { name: 'ТОВ «Логістик-Т»', edrpou: '41234567' }, driver: { full_name: 'Бондаренко Ігор Васильович', license_no: 'ВХТ 123456' },
    shipper: { name: client.name, edrpou: client.edrpou }, consignee: { name: 'ТОВ «Фуд-Опт»', edrpou: '33445566' },
    load_point: 'м. Одеса, вул. Хімічна, 14', unload_point: 'м. Київ, вул. Складська, 2', received_by: 'Бондаренко І.В., водій',
    lines: [{ cargo_name: 'Яблука свіжі', unit: 'т', places: 22, price: 1290.5, amount: 28390.99, packaging: 'Ящики', gross_t: 21.8, docs: 'Накладна № 44' }],
    total: 28390.99, vat_amount: 4731.83, currency: 'UAH', operations: [],
};
export const docInvoice = {
    id: UUID(7), kind: 'invoice', number: 12, number_text: '12', doc_date: '2026-11-04', status: 'issued', pay_status: 'issued', client_id: UUID(1), client_name: client.name, currency: 'UAH',
    vat_rate: 20, vat_mode: 'net', subtotal: 28400, vat_amount: 5680, total: 34080, debt: 34080, due_date: '2026-11-09', created_by_email: 'director@example.com', payments: [], children: [],
    seller: { legal_name: 'ТОВ «Логістик-Т»', edrpou: '41234567', iban: requisites.iban, signer_name: 'Іваненко І.І.', signer_position: 'Директор' },
    buyer: { legal_name: client.legal_name, edrpou: client.edrpou, iban: client.iban },
    lines: [{ sort: 1, title: 'Послуги з перевезення вантажу за маршрутом Одеса — Київ, 03.11.2026', unit: 'послуга', qty: 1, price: 28400, amount: 28400 }],
};
export const vehicles = [{ id: UUID(31), label: 'BH 4821 CK', make_model: 'MAN TGX 18.510', vehicle_type: 'Сідловий тягач', length_m: 7.5, width_m: 2.55, height_m: 4, tare_t: 7.8, max_mass_t: 40,
    oscpv_on: '2027-02-10', kasko_on: '2027-01-15', green_card_on: '2026-12-20', inspection_on: '2026-12-01', tachograph_on: '2027-03-01', service_on: '2026-11-20', default_driver_id: UUID(41), default_trailer_id: UUID(51) }];
export const drivers = [{ id: UUID(41), full_name: 'Бондаренко Ігор Васильович', license_no: 'ВХТ 123456', active: true }];
export const trailers = [{ id: UUID(51), plate: 'BH 1177 XT', make_model: 'Schmitz SKO 24', type: 'Рефрижератор', capacity_t: 22, volume_m3: 86, active: true, vehicle_ids: [UUID(31)], vehicle_labels: ['BH 4821 CK'], oscpv_on: '2027-02-10' }];
export const repairRows = [
    { id: UUID(61), repair_date: '2026-11-02', vehicle_id: UUID(31), vehicle_label: 'BH 4821 CK', odometer_km: 412300, works: 'Заміна масла і фільтрів', provider: 'СТО «Дизель»', service_cost: 1800, parts_cost: 3400, total: 5200, status: 'posted', can_void: true, parts: [{ part_id: UUID(71), name: 'Масло 10W40', unit: 'л', qty: 30, unit_cost: 113.33, total: 3400 }] },
    { id: UUID(62), repair_date: '2026-10-28', vehicle_id: UUID(31), vehicle_label: 'BH 4821 CK', odometer_km: 411000, works: 'Заміна гальмівних колодок (помилковий запис)', provider: null, service_cost: 0, parts_cost: 6100, total: 6100, status: 'void', can_void: false, parts: [{ part_id: UUID(72), name: 'Колодки гальмівні', unit: 'компл', qty: 2, unit_cost: 3050, total: 6100 }] },
    { id: UUID(63), repair_date: '2026-10-20', vehicle_id: UUID(31), vehicle_label: 'BH 4821 CK', odometer_km: 409000, works: 'Діагностика підвіски', provider: 'СТО «Дизель»', service_cost: 900, parts_cost: 0, total: 900, status: 'posted', can_void: false, parts: [] },
];

function builder(table) {
    const result = () => {
        if (table === 'clients') return [client];
        if (table === 'calculation_clients') return [];
        return [];
    };
    const chain = {};
    for (const m of ['select', 'order', 'limit', 'eq', 'neq', 'in', 'gte', 'lte', 'is', 'not', 'or', 'ilike']) chain[m] = () => chain;
    chain.maybeSingle = () => Promise.resolve({ data: table === 'clients' ? client : null, error: null });
    chain.single = () => Promise.resolve({ data: table === 'clients' ? client : null, error: null });
    chain.then = (res, rej) => Promise.resolve({ data: result(), error: null }).then(res, rej);
    return chain;
}
export const supabase = {
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }) },
    from: builder,
    rpc(name) {
        const ok = (data) => Promise.resolve({ data, error: null });
        switch (name) {
            case 'kp_requisites_get': return ok([requisites]);
            case 'kp_doc_next_number': return ok(13);
            case 'kp_doc_trips_for_client': return ok(trips);
            case 'kp_doc_list': return ok([]);
            case 'kp_client_debts': return ok([]);
            case 'kp_doc_get': return ok(docInvoice);
            case 'kp_ttn_get': return ok(ttn);
            case 'kp_vehicles_list': return ok(vehicles);
            case 'kp_driver_list': return ok(drivers);
            case 'kp_trailers_list': return ok(trailers);
            case 'kp_repairs_list': return ok(repairRows.map((r) => ({ ...r })));
            case 'repair_unstorno': {
                const row = repairRows.find((r) => r.id === arguments[1].p_repair_id);
                (globalThis.__rpcCalls = globalThis.__rpcCalls || []).push([name, arguments[1]]);
                if (globalThis.__unstornoError) return Promise.resolve({ data: null, error: { message: globalThis.__unstornoError } });
                if (!row || row.status !== 'void') return Promise.resolve({ data: null, error: { message: 'REPAIR_NOT_VOID' } });
                row.status = 'posted';
                return ok('posted');
            }
            case 'kp_repair_vehicles': return ok([{ id: UUID(31), label: 'BH 4821 CK' }]);
            default: return ok([]);
        }
    },
};
export const app = {
    auth: undefined,
    supabase, context: { org_id: UUID(9), org_name: 'ТОВ «Логістик-Т»', role: 'owner', control_plus: true }, user: { id: UUID(8) }, canWrite: true, canDelete: true,
    go: () => {}, onCleanup: () => {}, onPlanLost: () => {}, openSite: () => {}, closeWindow: () => Promise.resolve(),
};
export const access = { visible: true, canWrite: true, isOwner: true };

