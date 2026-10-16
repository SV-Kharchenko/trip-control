import { createClient } from '@supabase/supabase-js';
import { BLOCK_BAN_DURATION, userAccessStatus, userIsBlocked } from '../lib/account-block.js';

/**
 * Admin CRM API — лише platform admin (profiles.role = 'admin').
 * Approve / block через service_role (клієнтські тригери блокують self-approve).
 *
 * GET  /api/admin — список клієнтів (org + профіль + PII + email)
 * POST /api/admin — { action, ... }
 *   set_approved: { user_id, approved: bool }
 *   set_user_status: { user_id, status: 'full'|'demo'|'blocked' } — блок одного юзера (бан у Auth), не всієї org
 *   set_org_status: { org_id, status: 'active'|'blocked' }
 */
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAdmin(req, res) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Необхідна авторизація.' });
        return null;
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
        res.status(401).json({ error: 'Недійсний токен.' });
        return null;
    }
    const { data: profile } = await supabase
        .from('profiles')
        .select('id, role, org_id')
        .eq('id', user.id)
        .single();
    if (!profile || profile.role !== 'admin') {
        res.status(403).json({ error: 'Лише для адміністратора.' });
        return null;
    }
    return { user, profile };
}

async function audit(actor, action, entity, entityId, orgId, detail) {
    try {
        await supabase.from('security_audit_log').insert({
            actor,
            org_id: orgId || null,
            action,
            entity,
            entity_id: entityId || null,
            detail: detail || null
        });
    } catch (e) {
        console.warn('audit insert failed', e);
    }
}

export default async function handler(req, res) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    try {
        if (req.method === 'GET') {
            const [{ data: orgs }, { data: profiles }, { data: cps }, usersRes] = await Promise.all([
                supabase.from('organizations').select('id, name, status, default_tax_mode').order('name'),
                supabase.from('profiles').select('id, org_id, is_approved, role'),
                supabase.from('org_company_profiles').select('*'),
                supabase.auth.admin.listUsers({ perPage: 200 })
            ]);
            const emailById = {};
            const authById = {};
            (usersRes.data?.users || []).forEach(u => { emailById[u.id] = u.email || ''; authById[u.id] = u; });
            const cpByOrg = {};
            (cps || []).forEach(r => { cpByOrg[r.org_id] = r; });
            const profilesByOrg = {};
            (profiles || []).forEach(p => {
                if (!profilesByOrg[p.org_id]) profilesByOrg[p.org_id] = [];
                profilesByOrg[p.org_id].push({
                    id: p.id,
                    email: emailById[p.id] || '',
                    is_approved: !!p.is_approved,
                    blocked: userIsBlocked(authById[p.id]),
                    status: userAccessStatus(authById[p.id], p),
                    role: p.role
                });
            });
            const clients = (orgs || []).map(o => ({
                org_id: o.id,
                name: o.name,
                status: o.status,
                tax: o.default_tax_mode,
                profile: cpByOrg[o.id] || null,
                users: profilesByOrg[o.id] || []
            }));
            const { data: auditRows } = await supabase
                .from('security_audit_log')
                .select('id, at, actor, org_id, action, entity, entity_id, detail')
                .order('at', { ascending: false })
                .limit(40);
            return res.status(200).json({ clients, audit: auditRows || [] });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            const action = body.action;

            if (action === 'set_approved') {
                const userId = body.user_id;
                const approved = !!body.approved;
                if (!userId) return res.status(400).json({ error: 'user_id required' });
                const { data: target } = await supabase
                    .from('profiles')
                    .select('id, org_id')
                    .eq('id', userId)
                    .single();
                if (!target) return res.status(404).json({ error: 'Профіль не знайдено' });
                const { error } = await supabase
                    .from('profiles')
                    .update({ is_approved: approved })
                    .eq('id', userId);
                if (error) throw error;
                await audit(admin.user.id, approved ? 'approve_user' : 'revoke_user', 'profiles', userId, target.org_id, { approved });
                return res.status(200).json({ ok: true, user_id: userId, approved });
            }

            if (action === 'set_user_status') {
                const userId = body.user_id;
                const status = body.status;
                if (!userId) return res.status(400).json({ error: 'user_id required' });
                if (!['full', 'demo', 'blocked'].includes(status)) {
                    return res.status(400).json({ error: 'Невідомий статус.' });
                }
                const { data: target } = await supabase
                    .from('profiles')
                    .select('id, org_id, role, is_approved')
                    .eq('id', userId)
                    .single();
                if (!target) return res.status(404).json({ error: 'Профіль не знайдено' });
                if (target.role === 'admin') return res.status(400).json({ error: 'Статус адміністратора не змінюється.' });
                const { data: authData, error: authReadError } = await supabase.auth.admin.getUserById(userId);
                if (authReadError) throw authReadError;
                const previous = userAccessStatus(authData && authData.user, target);
                if (status === 'blocked') {
                    const { error: banError } = await supabase.auth.admin.updateUserById(userId, { ban_duration: BLOCK_BAN_DURATION });
                    if (banError) throw banError;
                } else {
                    if (previous === 'blocked') {
                        const { error: unbanError } = await supabase.auth.admin.updateUserById(userId, { ban_duration: 'none' });
                        if (unbanError) throw unbanError;
                    }
                    const approved = status === 'full';
                    if (!!target.is_approved !== approved) {
                        const { error } = await supabase
                            .from('profiles')
                            .update({ is_approved: approved })
                            .eq('id', userId);
                        if (error) throw error;
                    }
                }
                await audit(admin.user.id, 'set_user_status', 'profiles', userId, target.org_id, { status, previous });
                return res.status(200).json({ ok: true, user_id: userId, status, previous });
            }

            if (action === 'set_org_status') {
                const orgId = body.org_id;
                const status = body.status === 'blocked' ? 'blocked' : 'active';
                if (!orgId) return res.status(400).json({ error: 'org_id required' });
                const { error } = await supabase
                    .from('organizations')
                    .update({ status })
                    .eq('id', orgId);
                if (error) throw error;
                await audit(admin.user.id, 'set_org_status', 'organizations', orgId, orgId, { status });
                return res.status(200).json({ ok: true, org_id: orgId, status });
            }

            return res.status(400).json({ error: 'Unknown action' });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });
    } catch (e) {
        console.error('admin api', e);
        return res.status(500).json({ error: e.message || 'Admin API error' });
    }
}
