// Доступ до даних GPS для API (клієнт Supabase з service_role). Токен проходить лише через RPC gps_store_token /
// gps_read_token (Supabase Vault). Помилки бази не прокидаємо назовні з деталями: лише загальна помилка.
// Методи карти (2c) — лише service_role і завжди з явним фільтром org_id.
import { addDays } from './map.js';

const INTEGRATION_COLUMNS = 'id, org_id, provider, host_kind, api_host, token_secret_id, token_hint, status, provider_account, '
    + 'units_total, consecutive_failures, last_checked_at, last_ok_at, last_error_code, last_error_at, lock_until';
const UNIT_MAP_COLUMNS = 'id, name, vehicle_id, external_id, active, last_pos_at, last_lat, last_lon, last_speed, last_course, kind, kind_manual';
// PostgREST: id у фільтрі in.(…) іде в URL, тож великі списки діляться на пачки.
const ID_CHUNK = 100;
const chunk = (list, size = ID_CHUNK) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
// Значення для фільтра or() PostgREST — у лапках (час містить ':' і '.').
const quoted = (value) => '"' + String(value).replace(/"/g, '') + '"';

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
        // Атомарно: upsert підключення + секрет у Vault (RPC gps_connect, одна транзакція). Повертає рядок без токена.
        async connect({ orgId, provider, hostKind, apiHost, account, unitsTotal, token, userId }) {
            const data = must(await supabase.rpc('gps_connect', {
                p_org: orgId, p_provider: provider, p_host_kind: hostKind, p_api_host: apiHost,
                p_account: account, p_units: unitsTotal, p_token: token, p_user: userId,
            }), 'connect');
            const row = Array.isArray(data) ? data[0] : data;
            if (!row) throw new Error('gps store: connect');
            return row;
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
            return must(await supabase.from('gps_vehicles').select('id, external_id, name, vehicle_id, active, kind, kind_manual')
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
        // Директор Контроль+: організація на control_plus (не заблокована), де користувач — директор (як kp_org_id()).
        async directorOrg(userId) {
            const rows = must(await supabase.from('org_directors').select('org_id, created_at, organizations(plan, status)')
                .eq('user_id', userId).order('created_at', { ascending: true }).limit(10), 'directors') || [];
            const row = rows.find((r) => r.organizations && r.organizations.plan === 'control_plus' && r.organizations.status !== 'blocked');
            return row ? row.org_id : null;
        },
        // Лок оновлення карти (2c): атомарно бере gps_integrations.lock_until, лише якщо він вільний або минув.
        // Порожній результат — лок зайнятий іншим запитом / інстансом.
        async claimRefresh(integrationId, orgId, nowIso, untilIso) {
            const data = must(await supabase.from('gps_integrations').update({ lock_until: untilIso })
                .eq('id', integrationId).eq('org_id', orgId)
                .or('lock_until.is.null,lock_until.lt.' + quoted(nowIso))
                .select('id'), 'claim refresh');
            return Array.isArray(data) && data.length > 0;
        },
        // Привʼязані активні юніти організації (лише вони йдуть у Wialon і на карту).
        async mappedUnits(orgId) {
            return must(await supabase.from('gps_vehicles').select(UNIT_MAP_COLUMNS)
                .eq('org_id', orgId).eq('active', true).not('vehicle_id', 'is', null).limit(5000), 'mapped units') || [];
        },
        // Вибір карти: активні юніти організації — усі (all) або члени груп і/або окремі юніти; лише kinds — усі активні цього типу;
        // без нічого — привʼязані.
        // Тип (kinds) фільтрує вже вибране; 'none' — тип невизначено. Усі запити з явним org_id.
        async selectedUnits(orgId, { all, groupIds = [], unitIds = [], kinds = [] }) {
            const base = () => supabase.from('gps_vehicles').select(UNIT_MAP_COLUMNS).eq('org_id', orgId).eq('active', true);
            let rows;
            if (all) {
                rows = must(await base().limit(5000), 'selected units') || [];
            } else if (groupIds.length || unitIds.length) {
                const ids = new Set(unitIds);
                for (const part of chunk(groupIds)) {
                    const members = must(await supabase.from('gps_group_members').select('gps_vehicle_id')
                        .eq('org_id', orgId).in('group_id', part).limit(5000), 'group members') || [];
                    for (const m of members) ids.add(m.gps_vehicle_id);
                }
                rows = [];
                for (const part of chunk([...ids])) rows.push(...(must(await base().in('id', part).limit(5000), 'selected units') || []));
            } else if (kinds.length) {
                // Лише тип (без груп і юнітів): усі активні юніти цих типів, привʼязані чи ні.
                rows = must(await base().limit(5000), 'selected units') || [];
            } else {
                rows = must(await base().not('vehicle_id', 'is', null).limit(5000), 'selected units') || [];
            }
            if (!kinds.length) return rows;
            return rows.filter((u) => kinds.includes(u.kind || 'none'));
        },
        // Дзеркало груп Wialon (RPC gps_sync_groups, одна транзакція; ручні групи не чіпає). groups: [{ external_id, name, units: [external_id] }].
        async syncGroups(integrationId, groups) {
            const data = must(await supabase.rpc('gps_sync_groups', { p_integration: integrationId, p_groups: groups }), 'sync groups');
            return (Array.isArray(data) ? data[0] : data) || {};
        },
        // Точки без дублів (unique gps_vehicle_id + recorded_at): наявні не перезаписуються.
        async insertPositions(rows) {
            if (!rows.length) return;
            must(await supabase.from('gps_positions')
                .upsert(rows, { onConflict: 'gps_vehicle_id,recorded_at', ignoreDuplicates: true }), 'insert positions');
        },
        // last_* юніта — лише якщо точка новіша за збережену (старіша точка не відкочує останню позицію).
        // Масово: RPC gps_update_last_positions (один UPDATE … FROM на пачку, не більше 500 рядків), а не запит на кожен юніт.
        async updateLastPositions(orgId, updates) {
            for (const part of chunk(updates, 500)) {
                must(await supabase.rpc('gps_update_last_positions', { p_org: orgId, p_rows: part }), 'update last positions');
            }
        },
        // Прийняті заявки авто організації, що могли початися не пізніше сьогодні (вікно точно рахує lib/gps/map.js).
        // Клієнт — з calculation_clients → clients.name, інакше calculations.client_name.
        async currentOrders(orgId, vehicleIds, today) {
            const rows = must(await supabase.from('calc_vehicles')
                .select('calc_id, vehicle_id, calculations!inner(id, org_id, status, trip_date, trip_days, route_from, route_to, client_name)')
                .in('vehicle_id', vehicleIds)
                .eq('calculations.org_id', orgId)
                .eq('calculations.status', 'accepted')
                .lte('calculations.trip_date', today)
                .gte('calculations.trip_date', addDays(today, -400))
                .limit(5000), 'orders') || [];
            const own = rows.filter((r) => r.calculations && r.calculations.org_id === orgId);
            const ids = [...new Set(own.map((r) => r.calc_id))];
            const links = ids.length
                ? must(await supabase.from('calculation_clients').select('calculation_id, clients(name)')
                    .eq('org_id', orgId).in('calculation_id', ids).limit(5000), 'order clients') || []
                : [];
            const clientOf = new Map(links.map((l) => [l.calculation_id, l.clients && l.clients.name]));
            return own.map((r) => ({
                vehicle_id: r.vehicle_id,
                calculation_id: r.calc_id,
                status: r.calculations.status,
                trip_date: r.calculations.trip_date,
                trip_days: r.calculations.trip_days,
                route_from: r.calculations.route_from,
                route_to: r.calculations.route_to,
                client_name: clientOf.get(r.calc_id) || r.calculations.client_name || null,
            }));
        },
    };
}
