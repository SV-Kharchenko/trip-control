import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_ACTIVE_MEMBERS = 20;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEAM_ROLES = new Set(['owner', 'manager', 'logist']);
const INVITE_ROLES = new Set(['manager', 'logist']);

export class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function tokenHash(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}

export function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

export function siteUrl() {
    const configured = String(process.env.SITE_URL || 'https://trip-control.com').trim();
    try {
        return new URL(configured).origin;
    } catch {
        return 'https://trip-control.com';
    }
}

async function requireUser(req, options = {}) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Необхідна авторизація.');
    }

    const token = authHeader.slice('Bearer '.length);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
        throw new HttpError(401, 'BAD_TOKEN', 'Недійсний токен.');
    }

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, email, org_id, org_role, member_status, organizations(id, name, status, work_mode)')
        .eq('id', user.id)
        .single();

    if (profileError || !profile || !profile.org_id) {
        throw new HttpError(403, 'NO_PROFILE', 'Профіль користувача не знайдено.');
    }
    if (profile.member_status !== 'active' && options.allowDisabled !== true) {
        throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
    }
    if (!profile.organizations || profile.organizations.status === 'blocked') {
        throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
    }

    return { user, profile };
}

function requireOwner(actor) {
    if (actor.profile.org_role !== 'owner') {
        throw new HttpError(403, 'OWNER_ONLY', 'Ця дія доступна лише власнику.');
    }
}

function requireOrgAdmin(actor) {
    if (!['owner', 'manager'].includes(actor.profile.org_role)) {
        throw new HttpError(403, 'ORG_ADMIN_ONLY', 'Ця дія доступна власнику або менеджеру.');
    }
}

export function canInviteRole(actorRole, invitedRole) {
    return actorRole === 'owner'
        ? INVITE_ROLES.has(invitedRole)
        : actorRole === 'manager' && invitedRole === 'logist';
}

export function canManageMember(actorRole, targetRole) {
    return actorRole === 'owner' || (actorRole === 'manager' && targetRole === 'logist');
}

export function inviteRpcHttpError(message) {
    const text = String(message || '');
    if (text.includes('INVITE_NOT_ACTIVE')) {
        return new HttpError(404, 'INVITE_NOT_ACTIVE', 'Запрошення не знайдено або воно вже використане.');
    }
    if (text.includes('INVITE_EXPIRED')) {
        return new HttpError(410, 'INVITE_EXPIRED', 'Термін дії запрошення минув.');
    }
    if (text.includes('INVITE_EMAIL_MISMATCH')) {
        return new HttpError(403, 'INVITE_EMAIL_MISMATCH', 'Запрошення призначене для іншого email.');
    }
    if (text.includes('INVITE_ORG_BLOCKED')) {
        return new HttpError(403, 'INVITE_ORG_BLOCKED', 'Компанія недоступна.');
    }
    if (text.includes('ACCOUNT_ALREADY_IN_ORG')) {
        return new HttpError(
            409,
            'ACCOUNT_ALREADY_IN_ORG',
            'Акаунт уже належить іншій компанії з даними. Використайте інший email.'
        );
    }
    if (text.includes('MEMBER_LIMIT')) {
        return new HttpError(409, 'MEMBER_LIMIT', `Технічний ліміт — ${MAX_ACTIVE_MEMBERS} активних учасників.`);
    }
    return null;
}

async function audit(actorId, orgId, action, entity, entityId, detail = null) {
    const { error } = await supabase.from('security_audit_log').insert({
        actor: actorId,
        org_id: orgId,
        action,
        entity,
        entity_id: entityId || null,
        detail
    });
    if (error) console.warn('team audit failed:', error.message);
}

async function activeMemberCount(orgId, excludeUserId = null) {
    let query = supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('member_status', 'active');
    if (excludeUserId) query = query.neq('id', excludeUserId);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
}

async function listTeam(actor) {
    const orgId = actor.profile.org_id;
    const [{ data: members, error: membersError }, usersResult, settingsResult] = await Promise.all([
        supabase
            .from('profiles')
            .select('id, email, org_role, member_status, created_at')
            .eq('org_id', orgId)
            .order('created_at'),
        supabase.auth.admin.listUsers({ page: 1, perPage: 200 }),
        supabase
            .from('company_settings')
            .select('settings')
            .eq('org_id', orgId)
            .maybeSingle()
    ]);
    if (membersError) throw membersError;
    if (usersResult.error) throw usersResult.error;
    if (settingsResult.error) throw settingsResult.error;

    const authById = new Map(
        (usersResult.data?.users || []).map(user => [user.id, user])
    );
    const result = (members || []).map(member => {
        const authUser = authById.get(member.id);
        return {
            ...member,
            email: member.email || authUser?.email || '',
            last_sign_in_at: authUser?.last_sign_in_at || null
        };
    });

    let invites = [];
    if (['owner', 'manager'].includes(actor.profile.org_role)) {
        const { data, error } = await supabase
            .from('org_invites')
            .select('id, email, org_role, expires_at, accepted_at, revoked_at, created_at')
            .eq('org_id', orgId)
            .is('accepted_at', null)
            .is('revoked_at', null)
            .order('created_at', { ascending: false });
        if (error) throw error;
        invites = data || [];
    }

    return {
        organization: {
            id: actor.profile.organizations.id,
            name: actor.profile.organizations.name,
            work_mode: actor.profile.organizations.work_mode || 'solo'
        },
        actor: {
            id: actor.user.id,
            org_role: actor.profile.org_role,
            member_status: actor.profile.member_status
        },
        logists_see_all: settingsResult.data?.settings?.logists_see_all === true,
        members: result,
        invites
    };
}

async function inviteMember(actor, body) {
    requireOrgAdmin(actor);
    const orgId = actor.profile.org_id;
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.org_role || 'logist');

    if (!validEmail(email)) {
        throw new HttpError(400, 'BAD_EMAIL', 'Вкажіть коректний email.');
    }
    if (!INVITE_ROLES.has(role)) {
        throw new HttpError(400, 'BAD_ROLE', 'Запросити можна менеджера або логіста.');
    }
    if (!canInviteRole(actor.profile.org_role, role)) {
        throw new HttpError(403, 'MANAGER_INVITES_LOGISTS', 'Менеджер може запрошувати лише логістів.');
    }

    const members = await activeMemberCount(orgId);
    if (members >= MAX_ACTIVE_MEMBERS) {
        throw new HttpError(409, 'MEMBER_LIMIT', `Технічний ліміт — ${MAX_ACTIVE_MEMBERS} активних учасників.`);
    }

    const { data: existingMember, error: existingMemberError } = await supabase
        .from('profiles')
        .select('id, member_status')
        .eq('org_id', orgId)
        .eq('email', email)
        .maybeSingle();
    if (existingMemberError) throw existingMemberError;
    if (existingMember?.member_status === 'active') {
        throw new HttpError(409, 'ALREADY_MEMBER', 'Цей користувач уже в команді.');
    }

    const enablingTeam = (actor.profile.organizations.work_mode || 'solo') === 'solo';
    if (enablingTeam) {
        requireOwner(actor);
        if (body.enable_team !== true) {
            throw new HttpError(409, 'TEAM_MODE_REQUIRED', 'Спочатку підтвердьте командний режим.');
        }
    }

    const { data: pendingInvite, error: pendingError } = await supabase
        .from('org_invites')
        .select('id, org_role')
        .eq('org_id', orgId)
        .eq('email', email)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .maybeSingle();
    if (pendingError) throw pendingError;
    if (pendingInvite && !canManageMember(actor.profile.org_role, pendingInvite.org_role)) {
        throw new HttpError(403, 'INVITE_ROLE_PROTECTED', 'Менеджер не може замінити запрошення власника.');
    }
    if (pendingInvite) {
        const { error: revokeError } = await supabase
            .from('org_invites')
            .update({ revoked_at: new Date().toISOString() })
            .eq('id', pendingInvite.id)
            .is('accepted_at', null)
            .is('revoked_at', null);
        if (revokeError) throw revokeError;
    }

    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const { data: invite, error: inviteError } = await supabase
        .from('org_invites')
        .insert({
            org_id: orgId,
            email,
            org_role: role,
            token_hash: tokenHash(rawToken),
            invited_by: actor.user.id,
            expires_at: expiresAt
        })
        .select('id')
        .single();
    if (inviteError) throw inviteError;

    const inviteUrl = `${siteUrl()}/?team_invite=${encodeURIComponent(rawToken)}`;
    const { error: deliveryError } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: inviteUrl,
        data: { trip_control_invite: true }
    });

    let delivery = 'email';
    if (deliveryError) {
        const message = String(deliveryError.message || '').toLowerCase();
        if (message.includes('already') || message.includes('registered') || message.includes('exists')) {
            delivery = 'existing_user_link';
        } else {
            await supabase.from('org_invites').delete().eq('id', invite.id);
            throw new HttpError(502, 'INVITE_DELIVERY_FAILED', 'Не вдалося надіслати запрошення.');
        }
    }

    if (enablingTeam) {
        const { error: modeError } = await supabase
            .from('organizations')
            .update({ work_mode: 'team' })
            .eq('id', orgId);
        if (modeError) {
            await supabase.from('org_invites').delete().eq('id', invite.id);
            throw modeError;
        }
        await audit(actor.user.id, orgId, 'set_work_mode', 'organizations', orgId, {
            old: 'solo',
            new: 'team',
            reason: 'first_invite'
        });
        actor.profile.organizations.work_mode = 'team';
    }

    await audit(actor.user.id, orgId, 'invite_member', 'org_invites', invite.id, {
        email,
        org_role: role,
        delivery
    });

    return {
        ok: true,
        invite_id: invite.id,
        expires_at: expiresAt,
        delivery,
        invite_url: inviteUrl,
        work_mode: actor.profile.organizations.work_mode
    };
}

async function acceptInvite(actor, body) {
    const rawToken = String(body.token || '');
    if (rawToken.length < 32) {
        throw new HttpError(400, 'BAD_INVITE_TOKEN', 'Некоректне посилання запрошення.');
    }

    const { data, error } = await supabase
        .rpc('accept_org_invite', {
            p_token_hash: tokenHash(rawToken),
            p_user_id: actor.user.id,
            p_email: actor.user.email || ''
        })
        .single();

    if (error) {
        const mapped = inviteRpcHttpError(error.message);
        if (mapped) throw mapped;
        throw error;
    }

    return { ok: true, org_id: data.org_id, org_role: data.org_role };
}

async function changeRole(actor, body) {
    requireOwner(actor);
    const userId = String(body.user_id || '');
    const role = String(body.org_role || '');
    if (!userId || !TEAM_ROLES.has(role)) {
        throw new HttpError(400, 'BAD_ROLE_CHANGE', 'Некоректний користувач або роль.');
    }

    const { data: target, error: targetError } = await supabase
        .from('profiles')
        .select('id, org_role, member_status')
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id)
        .single();
    if (targetError || !target) {
        throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Учасника не знайдено.');
    }

    const { error } = await supabase
        .from('profiles')
        .update({ org_role: role })
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id);
    if (error) {
        if (String(error.message).includes('LAST_ACTIVE_OWNER')) {
            throw new HttpError(409, 'LAST_ACTIVE_OWNER', 'Не можна понизити останнього активного власника.');
        }
        throw error;
    }

    await audit(actor.user.id, actor.profile.org_id, 'change_member_role', 'profiles', userId, {
        old: target.org_role,
        new: role
    });
    return { ok: true, user_id: userId, org_role: role };
}

async function disableMember(actor, body) {
    requireOrgAdmin(actor);
    const userId = String(body.user_id || '');
    if (!userId || userId === actor.user.id) {
        throw new HttpError(400, 'BAD_DISABLE_TARGET', 'Не можна відключити власний поточний доступ.');
    }

    const { data: target, error: targetError } = await supabase
        .from('profiles')
        .select('id, org_role, member_status')
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id)
        .single();
    if (targetError || !target) {
        throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Учасника не знайдено.');
    }
    if (!canManageMember(actor.profile.org_role, target.org_role)) {
        throw new HttpError(403, 'MANAGER_DISABLES_LOGISTS', 'Менеджер може відключати лише логістів.');
    }

    let update = supabase
        .from('profiles')
        .update({ member_status: 'disabled' })
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id);
    if (actor.profile.org_role === 'manager') {
        update = update.eq('org_role', 'logist');
    }
    const { data: disabled, error } = await update
        .select('id')
        .maybeSingle();
    if (error) {
        if (String(error.message).includes('LAST_ACTIVE_OWNER')) {
            throw new HttpError(409, 'LAST_ACTIVE_OWNER', 'Не можна відключити останнього активного власника.');
        }
        throw error;
    }
    if (!disabled) {
        throw new HttpError(409, 'MEMBER_ROLE_CHANGED', 'Роль учасника вже змінилася. Оновіть список команди.');
    }

    await audit(actor.user.id, actor.profile.org_id, 'disable_member', 'profiles', userId, {
        org_role: target.org_role
    });
    return { ok: true, user_id: userId };
}

async function revokeInvite(actor, body) {
    requireOrgAdmin(actor);
    const inviteId = String(body.invite_id || '');
    const { data: invite, error: inviteError } = await supabase
        .from('org_invites')
        .select('id, org_role')
        .eq('id', inviteId)
        .eq('org_id', actor.profile.org_id)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .single();
    if (inviteError || !invite) {
        throw new HttpError(404, 'INVITE_NOT_FOUND', 'Активне запрошення не знайдено.');
    }
    if (!canManageMember(actor.profile.org_role, invite.org_role)) {
        throw new HttpError(403, 'MANAGER_REVOKES_LOGISTS', 'Менеджер може відкликати лише запрошення логістів.');
    }

    const { data: revoked, error } = await supabase
        .from('org_invites')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', inviteId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();
    if (error) throw error;
    if (!revoked) {
        throw new HttpError(409, 'INVITE_CHANGED', 'Запрошення вже прийнято або відкликано.');
    }

    await audit(actor.user.id, actor.profile.org_id, 'revoke_invite', 'org_invites', inviteId);
    return { ok: true, invite_id: inviteId };
}

async function setWorkMode(actor, body) {
    requireOwner(actor);
    const mode = String(body.work_mode || '');
    if (!['solo', 'team'].includes(mode)) {
        throw new HttpError(400, 'BAD_WORK_MODE', 'Некоректний режим роботи.');
    }
    const previous = actor.profile.organizations.work_mode || 'solo';
    if (mode === previous) return { ok: true, work_mode: mode };

    const { error } = await supabase
        .from('organizations')
        .update({ work_mode: mode })
        .eq('id', actor.profile.org_id);
    if (error) {
        if (String(error.message).includes('SOLO_HAS_ACTIVE_MEMBERS')) {
            throw new HttpError(409, 'SOLO_HAS_ACTIVE_MEMBERS', 'Спочатку відключіть інших активних учасників.');
        }
        throw error;
    }
    await audit(actor.user.id, actor.profile.org_id, 'set_work_mode', 'organizations', actor.profile.org_id, {
        old: previous,
        new: mode
    });
    return { ok: true, work_mode: mode };
}

async function setVisibility(actor, body) {
    requireOwner(actor);
    const enabled = body.logists_see_all === true;
    const { error } = await supabase.rpc('set_logists_visibility', {
        p_org_id: actor.profile.org_id,
        p_enabled: enabled
    });
    if (error) throw error;

    await audit(actor.user.id, actor.profile.org_id, 'set_logists_visibility', 'company_settings', actor.profile.org_id, {
        logists_see_all: enabled
    });
    return { ok: true, logists_see_all: enabled };
}

export default async function handler(req, res) {
    try {
        const body = req.body || {};
        const action = String(body.action || '');
        const actor = await requireUser(req, {
            allowDisabled: req.method === 'POST' && action === 'accept'
        });

        if (req.method === 'GET') {
            return res.status(200).json(await listTeam(actor));
        }
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        let result;
        if (action === 'invite') result = await inviteMember(actor, body);
        else if (action === 'accept') result = await acceptInvite(actor, body);
        else if (action === 'change_role') result = await changeRole(actor, body);
        else if (action === 'disable') result = await disableMember(actor, body);
        else if (action === 'revoke') result = await revokeInvite(actor, body);
        else if (action === 'set_work_mode') result = await setWorkMode(actor, body);
        else if (action === 'set_logists_see_all') result = await setVisibility(actor, body);
        else throw new HttpError(400, 'UNKNOWN_ACTION', 'Невідома дія.');

        return res.status(200).json(result);
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'TEAM_API_ERROR';
        if (status >= 500) console.error('team api:', error);
        return res.status(status).json({
            code,
            error: error instanceof HttpError ? error.message : 'Не вдалося виконати дію з командою.'
        });
    }
}
