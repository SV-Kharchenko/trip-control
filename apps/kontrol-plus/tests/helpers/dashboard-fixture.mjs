// Фейковий supabase.rpc для дашборда: фіксовані дані, журнал викликів, затримка й збої за іменем RPC. Працює і в node-тестах, і в браузері
// (harness-сторінка вантажить цей модуль зі статичного сервера), тому без node-імпортів.
export const TODAY = '2026-11-18';
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

export function makeRows(count = 14) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const day = 1 + (i % 18);
        rows.push({
            id: uuid(i + 1), registry_no: 'Р-' + String(1000 - i), status: i % 7 === 6 ? 'cancelled' : i % 3 === 0 ? 'done' : 'accepted', user_id: uuid(900),
            name: 'Рейс ' + i, client_name: i % 2 ? 'ТОВ «Агросвіт»' : 'ФОП Шевченко Тарас Григорович', trip_date: '2026-11-' + String(day).padStart(2, '0'),
            route_from: 'Київ', route_to: 'Одеса', distance_km: 480, revenue: 24000 + i * 1500, profit: 6000 + i * 300, fact_revenue: null, fact_profit: null,
            decided_at: '2026-11-0' + (1 + (i % 9)) + 'T09:00:00Z', cancelled_at: null, cancel_reason: null, created_at: '2026-11-01T08:00:00Z', total_count: count,
        });
    }
    return rows;
}

export function makeFixture({ role = 'owner', fail = [], delay = 0, rows = makeRows(), plan = true } = {}) {
    const calls = [];
    const live = rows.filter((r) => r.status !== 'cancelled');
    const sum = (list, key) => list.reduce((s, r) => s + Number(r[key] || 0), 0);
    const rpc = async (name, args) => {
        calls.push({ name, args });
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (fail.includes(name)) return { data: null, error: { code: '500', message: 'boom ' + name } };
        if (name === 'registry_totals') {
            const statuses = args.p_filters && args.p_filters.status;
            const isPrev = args.p_filters && args.p_filters.to && args.p_filters.to < '2026-11-01';
            if (isPrev) return { data: [{ total_count: 8, cancelled_count: 1, revenue: 150000, profit_plan: 30000, profit_fact: 32000, distance_km: 3000, fact_count: 4 }], error: null };
            if (statuses) return { data: [{ total_count: rows.filter((r) => r.status === 'accepted').length, cancelled_count: 0, revenue: 0, profit_plan: 0, profit_fact: 0, distance_km: 0, fact_count: 0 }], error: null };
            return { data: [{ total_count: rows.length, cancelled_count: rows.length - live.length, revenue: sum(live, 'revenue'), profit_plan: sum(live, 'profit'), profit_fact: sum(live, 'profit') + 900, distance_km: 6000, fact_count: 3 }], error: null };
        }
        if (name === 'registry_list') return { data: rows.slice(args.p_offset, args.p_offset + args.p_limit), error: null };
        if (name === 'registry_documents') {
            return { data: args.p_calcs.map((id, i) => ({
                calculation_id: id, client_id: uuid(500 + i), contract_id: i % 2 ? uuid(700) : null, contract_no: '1', contract_date: '2026-01-01', contract_status: i % 4 === 1 ? 'draft' : 'signed',
                docs: i % 3 === 0 ? [] : [{ id: uuid(800 + i), kind: 'act', number: 'А-' + i, status: 'issued', paid: false, total: 1, currency: 'UAH' }],
            })), error: null };
        }
        if (name === 'kp_client_debts') {
            const prev = args.p_on && args.p_on < '2026-11-01';
            return { data: [
                { client_id: uuid(501), client_name: 'ТОВ «Агросвіт»', currency: 'UAH', invoices: 3, invoiced: 90000, paid: 30000, debt: prev ? 40000 : 60000, overdue: prev ? 0 : 45000, overdue_invoices: 2, oldest_due: '2026-10-01', overdue_days: 48 },
                { client_id: uuid(502), client_name: 'ФОП Шевченко Тарас Григорович', currency: 'UAH', invoices: 1, invoiced: 10000, paid: 0, debt: 10000, overdue: 10000, overdue_invoices: 1, oldest_due: '2026-11-10', overdue_days: 8 },
            ], error: null };
        }
        if (name === 'kp_unpaid_invoices_count') return { data: 4, error: null };
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function ' + name } };
    };
    const context = plan ? { control_plus: true, role, org_id: uuid(1), org_name: 'Агросвіт' } : { control_plus: false, role: null };
    return { rpc, calls, context };
}
