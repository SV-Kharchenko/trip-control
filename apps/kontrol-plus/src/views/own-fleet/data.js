// «Власний парк»: читання даних через Supabase-клієнт застосунку. Доступ обмежує RLS (*_own_fleet.sql): замовник бачить лише свої
// підрозділи, спільні точки й заявки свого підрозділу; персонал — усе в організації.
export async function loadAll(app) {
    const sb = app.supabase;
    const [requests, units, points] = await Promise.all([
        sb.from('fleet_requests').select('*').order('wanted_at', { ascending: true }).limit(1000),
        sb.from('org_units').select('*').order('name', { ascending: true }).limit(500),
        sb.from('org_points').select('*').order('name', { ascending: true }).limit(2000),
    ]);
    const error = requests.error || units.error || points.error;
    return { error, requests: requests.data || [], units: units.data || [], points: points.data || [] };
}

// Довідники авто / причепів / водіїв для призначення (лише персонал: замовнику RLS їх не віддає).
export async function loadResources(app) {
    const sb = app.supabase;
    const [vehicles, trailers, drivers] = await Promise.all([
        sb.rpc('kp_vehicles_list'),
        sb.rpc('kp_trailers_list'),
        sb.rpc('kp_driver_list', { p_active_only: true }),
    ]);
    return {
        error: vehicles.error || drivers.error,
        vehicles: (vehicles.data || []).map((v) => ({ id: v.id, label: v.label + (v.make_model ? ' · ' + v.make_model : '') })),
        trailers: (trailers.data || []).map((t) => ({ id: t.id, label: t.plate + (t.make_model ? ' · ' + t.make_model : '') })),
        drivers: (drivers.data || []).map((d) => ({ id: d.id, label: d.full_name })),
    };
}

export function nameOf(list, id, fallback = '—') {
    const row = id ? list.find((x) => x.id === id) : null;
    return row ? row.name : fallback;
}

// Слухає закриття вікон карток (kp:registry-changed) і перечитує розділ; повертає функцію відписки.
export function onRegistryChanged(app, reload) {
    const handler = () => { reload(); };
    window.addEventListener('kp:registry-changed', handler);
    const off = () => window.removeEventListener('kp:registry-changed', handler);
    if (typeof app.onCleanup === 'function') app.onCleanup(off);
    return off;
}
