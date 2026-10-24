// Дані запрошень менеджера з ремонтів для API (клієнт Supabase зі service_role). Запис — лише RPC з міграції
// *_repairs_stock.sql (kp_repair_invite_*), з явною організацією. Помилки бази назовні — лише код (без деталей).
const INVITE_COLUMNS = 'id, org_id, email, expires_at, accepted_at, revoked_at, declined_at, created_at, last_sent_at';

function must({ data, error }, what) {
    if (error) {
        const err = new Error(String(error.message || what));
        err.code = error.code;
        throw err;
    }
    return data;
}

export function createRepairsStore(supabase) {
    return {
        async getUser(jwt) {
            const { data, error } = await supabase.auth.getUser(jwt);
            return error || !data ? null : data.user;
        },
        async getProfile(userId) {
            const data = must(await supabase.from('profiles').select('org_id, org_role, member_status, organizations(status, plan)')
                .eq('id', userId).maybeSingle(), 'profile');
            if (!data) return null;
            const org = data.organizations || {};
            return { org_id: data.org_id, org_role: data.org_role, member_status: data.member_status, org_status: org.status, org_plan: org.plan };
        },
        async directorOrg(userId) {
            const rows = must(await supabase.from('org_directors').select('org_id, created_at, organizations(plan, status)')
                .eq('user_id', userId).order('created_at', { ascending: true }).limit(10), 'directors') || [];
            const row = rows.find((r) => r.organizations && r.organizations.plan === 'control_plus' && r.organizations.status !== 'blocked');
            return row ? row.org_id : null;
        },
        async orgName(orgId) {
            const data = must(await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle(), 'org');
            return data ? data.name : null;
        },
        async listInvites(orgId) {
            return must(await supabase.from('repair_manager_invites').select(INVITE_COLUMNS).eq('org_id', orgId)
                .order('created_at', { ascending: false }).limit(50), 'invites') || [];
        },
        async getInvite(id) {
            return must(await supabase.from('repair_manager_invites').select(INVITE_COLUMNS).eq('id', id).maybeSingle(), 'invite');
        },
        async countManagers(orgId) {
            const { count, error } = await supabase.from('org_repair_handlers').select('user_id', { count: 'exact', head: true })
                .eq('org_id', orgId).eq('kind', 'repair_manager');
            if (error) throw new Error('managers');
            return count || 0;
        },
        async recentSends(orgId, sinceIso) {
            const { count, error } = await supabase.from('repair_manager_invites').select('id', { count: 'exact', head: true })
                .eq('org_id', orgId).gte('last_sent_at', sinceIso);
            if (error) throw new Error('recent sends');
            return count || 0;
        },
        async reserve({ orgId, inviteId, email, tokenHash, invitedBy, expiresAt }) {
            return must(await supabase.rpc('kp_repair_invite_reserve', {
                p_org: orgId, p_invite: inviteId, p_email: email, p_token_hash: tokenHash, p_invited_by: invitedBy, p_expires_at: expiresAt,
            }), 'reserve');
        },
        async revoke(orgId, id) {
            return must(await supabase.rpc('kp_repair_invite_revoke', { p_org: orgId, p_invite: id }), 'revoke');
        },
        async accept(hash, userId, email) {
            return must(await supabase.rpc('kp_repair_invite_accept', { p_token_hash: hash, p_user: userId, p_email: email }), 'accept');
        },
        async decline(hash, email) {
            return must(await supabase.rpc('kp_repair_invite_decline', { p_token_hash: hash, p_email: email }), 'decline');
        },
    };
}
