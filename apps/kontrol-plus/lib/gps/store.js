// Доступ до даних GPS для API (клієнт Supabase з service_role). Токен проходить лише через RPC gps_store_token /
// gps_read_token (Supabase Vault). Помилки бази не прокидаємо назовні з деталями: лише загальна помилка.
const INTEGRATION_COLUMNS = 'id, org_id, provider, host_kind, api_host, token_secret_id, token_hint, status, provider_account, '
    + 'units_total, consecutive_failures, last_checked_at, last_ok_at, last_error_code, last_error_at';

function must({ data, error }, what) {
    if (error) throw new Error('gps store: ' + what);
    return data;
}

export function createSupabaseStore(supabase) {
    return {
        async getUser(jwt) {
            const { data, error } = await supabase.auth.getUser(jwt);
            return error || !data ? null : data.user;
        },
        async getProfile(userId) {
            const data = must(await supabase.from('profiles')
                .select('org_id, org_role, member_status, organizations(status, plan)')
                .eq('id', userId)
                .maybeSingle(), 'profile');
            if (!data) return null;
            const org = data.organizations || {};
            return { org_id: data.org_id, org_role: data.org_role, member_status: data.member_status, org_status: org.status, org_plan: org.plan };
        },
        async getIntegration(orgId, provider) {
            return must(await supabase.from('gps_integrations').select(INTEGRATION_COLUMNS)
                .eq('org_id', orgId).eq('provider', provider).maybeSingle(), 'integration');
        },
        async insertIntegration(row) {
            return must(await supabase.from('gps_integrations').insert(row).select(INTEGRATION_COLUMNS).single(), 'insert integration');
        },
        async updateIntegration(id, patch) {
            return must(await supabase.from('gps_integrations').update(patch).eq('id', id).select(INTEGRATION_COLUMNS).single(), 'update integration');
        },
        async storeToken(id, token) {
            return must(await supabase.rpc('gps_store_token', { p_integration: id, p_token: token }), 'store token');
        },
        async readToken(id) {
            return must(await supabase.rpc('gps_read_token', { p_integration: id }), 'read token');
        },
        async deleteToken(id) {
            return must(await supabase.rpc('gps_delete_token', { p_integration: id }), 'delete token');
        },
        async listUnits(integrationId) {
            return must(await supabase.from('gps_vehicles').select('id, external_id, name, vehicle_id, active')
                .eq('integration_id', integrationId).order('name', { ascending: true }).limit(5000), 'units') || [];
        },
        // Upsert лише цих колонок: vehicle_id (мапінг) і first_seen_at не перезаписуються.
        async upsertUnits(rows) {
            must(await supabase.from('gps_vehicles').upsert(rows, { onConflict: 'integration_id,external_id' }), 'upsert units');
        },
        async deactivateUnits(integrationId, ids) {
            must(await supabase.from('gps_vehicles').update({ active: false }).eq('integration_id', integrationId).in('id', ids), 'deactivate units');
        },
        async fleetVehicles(orgId) {
            return must(await supabase.from('fleet_vehicles').select('id, label').eq('org_id', orgId).limit(1000), 'fleet') || [];
        },
    };
}
