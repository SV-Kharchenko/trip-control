import { createClient } from '@supabase/supabase-js';
import { userAccessStatus, userIsBlocked } from '../lib/account-block.js';
import { setUserStatus, UserStatusError, writeAudit } from '../lib/user-status.js';
import { createBillingService } from '../lib/billing/service.js';
import { createSupabaseStore } from '../lib/billing/store.js';

/**
 * Admin CRM API — лише platform admin (profiles.role = 'admin').
 * Approve / block через service_role (клієнтські тригери блокують self-approve).
 *
 * GET  /api/admin — список клієнтів (org + профіль + PII + email)
 * POST /api/admin — { action, ... }
 *   set_approved: { user_id, approved: bool }
 *   set_user_status: { user_id, status: 'full'|'demo'|'blocked' } — блок одного юзера (бан у Auth), не всієї org
 *   set_org_status: { org_id, status: 'active'|'blocked' } — блок також зупиняє автопродовження (REMOVE у WayForPay)
 *   cancel_auto_renew: { org_id } — скасування автопродовження за запитом клієнта (листом)
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

// Та сама логіка автопродовження, що й у /api/billing (REMOVE, RemovePending, алерти).
const billing = createBillingService({ store: createSupabaseStore(supabase), fetch: globalThis.fetch, env: process.env });

// Автопродовження по компаніях для CRM; без міграції 20261020200000_auto_renew.sql — порожньо.
async function autoRenewByOrg() {
    const { data, error } = await supabase
        .from('org_subscriptions')
        .select('org_id, auto_renew, regular_status, next_charge_at')
        .or('auto_renew.eq.true,regular_status.eq.RemovePending');
    if (error) return {};
    const out = {};
    (data || []).forEach(r => {
        out[r.org_id] = { enabled: !!r.auto_renew, removing: r.regular_status === 'RemovePending', next_charge_at: r.next_charge_at || null };
    });
    return out;
}

// { removed } / { pending } / { none } → коротка відповідь адміну.
function autoRenewResult(result) {
    if (result.removed) return 'removed';
    if (result.pending) return 'pending';
    return 'none';
}

function audit(actor, action, entity, entityId, orgId, detail) {
    return writeAudit(supabase, actor, action, entity, entityId, orgId, detail);
}

export default async function handler(req, res) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    try {
        if (req.method === 'GET') {
            const [{ data: orgs }, { data: profiles }, { data: cps }, usersRes, autoRenew] = await Promise.all([
                supabase.from('organizations').select('id, name, status, default_tax_mode').order('name'),
                supabase.from('profiles').select('id, org_id, is_approved, role'),
                supabase.from('org_company_profiles').select('*'),
                supabase.auth.admin.listUsers({ perPage: 200 }),
                autoRenewByOrg()
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
                users: profilesByOrg[o.id] || [],
                auto_renew: autoRenew[o.id] || null
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
                // Та сама логіка, що й у Telegram-бота: lib/user-status.js.
                try {
                    const result = await setUserStatus(supabase, {
                        userId: body.user_id,
                        status: body.status,
                        actor: admin.user.id,
                        source: 'admin'
                    });
                    return res.status(200).json({ ok: true, user_id: result.user_id, status: result.status, previous: result.previous });
                } catch (e) {
                    if (e instanceof UserStatusError) return res.status(e.httpStatus).json({ error: e.message });
                    throw e;
                }
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
                // Заблоковану компанію не списуємо: REMOVE регулярки (не підтверджено — RemovePending, крон повторить).
                let autoRenewStop = 'none';
                if (status === 'blocked') {
                    try {
                        autoRenewStop = autoRenewResult(await billing.orgBlocked(orgId));
                    } catch (e) {
                        autoRenewStop = 'error';
                        console.warn('admin: auto-renew stop on block failed', e && e.code);
                    }
                }
                await audit(admin.user.id, 'set_org_status', 'organizations', orgId, orgId, { status, auto_renew: autoRenewStop });
                return res.status(200).json({ ok: true, org_id: orgId, status, auto_renew: autoRenewStop });
            }

            if (action === 'cancel_auto_renew') {
                const orgId = body.org_id;
                if (!orgId) return res.status(400).json({ error: 'org_id required' });
                const result = autoRenewResult(await billing.adminCancelAutoRenew(orgId));
                await audit(admin.user.id, 'cancel_auto_renew', 'org_subscriptions', orgId, orgId, { result });
                return res.status(200).json({ ok: true, org_id: orgId, auto_renew: result });
            }

            return res.status(400).json({ error: 'Unknown action' });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });
    } catch (e) {
        console.error('admin api', e);
        return res.status(500).json({ error: e.message || 'Admin API error' });
    }
}
