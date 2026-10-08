import { createClient } from '@supabase/supabase-js';

/**
 * Платіжний webhook: єдиний шлях зміни is_approved / plan ззовні.
 * Клієнт НЕ може self-approve (див. protect_profile_privileges у SQL).
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   BILLING_WEBHOOK_SECRET — спільний секрет з платіжкою (header X-Billing-Secret)
 *
 * Body (JSON):
 *   { "event": "subscription.active"|"subscription.canceled"|"subscription.past_due",
 *     "org_id": "<uuid>",           // обов'язково
 *     "user_id": "<uuid>",          // опційно — конкретний профіль
 *     "plan": "pro"|"basic"|null }
 */
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

function authorized(req) {
    const expected = process.env.BILLING_WEBHOOK_SECRET;
    if (!expected) return false;
    const got = req.headers['x-billing-secret']
        || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return got && got === expected;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    if (!authorized(req)) {
        return res.status(401).json({ error: 'Unauthorized webhook' });
    }

    const body = req.body || {};
    const event = String(body.event || '');
    const orgId = body.org_id;
    const userId = body.user_id || null;
    const plan = body.plan != null ? String(body.plan) : null;

    if (!orgId) {
        return res.status(400).json({ error: 'org_id required' });
    }

    let approved = null;
    let orgStatus = null;
    if (event === 'subscription.active') {
        approved = true;
        orgStatus = 'active';
    } else if (event === 'subscription.canceled' || event === 'subscription.past_due') {
        approved = false;
        if (event === 'subscription.canceled') orgStatus = 'blocked';
    } else {
        return res.status(400).json({ error: 'Unknown event', event });
    }

    try {
        const orgPatch = {};
        if (orgStatus) orgPatch.status = orgStatus;
        if (plan !== null) orgPatch.plan = plan;
        if (Object.keys(orgPatch).length) {
            const { error: orgErr } = await supabase
                .from('organizations')
                .update(orgPatch)
                .eq('id', orgId);
            if (orgErr) {
                // plan column may not exist yet — retry without plan
                if (orgPatch.plan !== undefined && /plan/i.test(orgErr.message || '')) {
                    delete orgPatch.plan;
                    if (Object.keys(orgPatch).length) {
                        const { error: orgErr2 } = await supabase
                            .from('organizations')
                            .update(orgPatch)
                            .eq('id', orgId);
                        if (orgErr2) throw orgErr2;
                    }
                } else {
                    throw orgErr;
                }
            }
        }

        let profileQuery = supabase
            .from('profiles')
            .update({ is_approved: approved })
            .eq('org_id', orgId);
        if (userId) profileQuery = profileQuery.eq('id', userId);
        const { error: profErr } = await profileQuery;
        if (profErr) throw profErr;

        await supabase.rpc('write_security_audit', {
            p_action: event,
            p_entity: 'billing',
            p_entity_id: orgId,
            p_org_id: orgId,
            p_detail: { approved, plan, user_id: userId }
        }).catch(() => {});

        return res.status(200).json({ ok: true, event, org_id: orgId, approved });
    } catch (e) {
        console.error('billing-webhook', e);
        return res.status(500).json({ error: e.message || 'Webhook failed' });
    }
}
