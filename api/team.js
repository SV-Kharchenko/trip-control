import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { USER_BLOCKED_ERROR, userIsBlocked } from '../lib/account-block.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Logist seats only. The owner is a fourth person and does not consume one.
const MAX_TEAM_SEATS = 3;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEAM_ROLES = new Set(['owner', 'logist']);
const INVITE_ROLES = new Set(['logist']);

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

function inviteSigningPayload(invite) {
    return [
        invite.id,
        String(invite.email || '').trim().toLowerCase(),
        invite.org_role,
        invite.expires_at
    ].join('|');
}

function inviteSigningSecret(secret) {
    const value = secret === undefined ? process.env.INVITE_SIGNING_SECRET : secret;
    if (!value) {
        throw new HttpError(500, 'INVITE_SECRET_MISSING', 'Не налаштовано INVITE_SIGNING_SECRET.');
    }
    return String(value);
}

export function inviteSignature(invite, secret) {
    return createHmac('sha256', inviteSigningSecret(secret))
        .update(inviteSigningPayload(invite))
        .digest('base64url');
}

export function signedInviteToken(invite, secret) {
    return `v2.${invite.id}.${inviteSignature(invite, secret)}`;
}

export function signedInviteTokenIsValid(token, invite, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v2' || parts[1] !== invite.id) return false;
    const actual = Buffer.from(parts[2]);
    const expected = Buffer.from(inviteSignature(invite, secret));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
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

export function inviteUrl(invite) {
    return `${siteUrl()}/?team_invite=${encodeURIComponent(signedInviteToken(invite))}`;
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
    if (userIsBlocked(user)) {
        throw new HttpError(403, USER_BLOCKED_ERROR.code, USER_BLOCKED_ERROR.error);
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

export function canInviteRole(actorRole, invitedRole) {
    return actorRole === 'owner' && INVITE_ROLES.has(invitedRole);
}

// True when turning someone into an active logist would pass the seat cap.
// Already-active logists do not consume a second seat.
export function activationExceedsLogistCap({ activeLogists, pendingInvites, wasActiveLogist }) {
    if (wasActiveLogist) return false;
    const active = Number(activeLogists) || 0;
    const pending = Number(pendingInvites) || 0;
    return active + pending >= MAX_TEAM_SEATS;
}

// Invite creates and resends share one bucket: 10 audited actions per org per hour.
export const INVITE_RATE_LIMIT = 10;
const INVITE_RATE_WINDOW_MS = 60 * 60 * 1000;

export function inviteActionRateLimited(recentActions, limit = INVITE_RATE_LIMIT) {
    return (Number(recentActions) || 0) >= limit;
}

export function secondActiveOwnerBlocked(otherActiveOwners) {
    return (Number(otherActiveOwners) || 0) >= 1;
}

function profileWriteError(error, ownerMessage) {
    const mapped = inviteRpcHttpError(error && error.message);
    if (mapped) return mapped;
    if (String(error && error.message || '').includes('LAST_ACTIVE_OWNER')) {
        return new HttpError(409, 'LAST_ACTIVE_OWNER', ownerMessage);
    }
    if (String(error && error.message || '').includes('SECOND_ACTIVE_OWNER')) {
        return new HttpError(409, 'SECOND_ACTIVE_OWNER', 'У компанії вже є активний власник.');
    }
    return null;
}

export function canManageMember(actorRole, targetRole) {
    return actorRole === 'owner' && TEAM_ROLES.has(targetRole);
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
        return new HttpError(409, 'MEMBER_LIMIT', `Можна мати лише ${MAX_TEAM_SEATS} логістів, включно з активними запрошеннями.`);
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

async function activeOwnerCount(orgId, excludeUserId = null) {
    let query = supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('member_status', 'active')
        .eq('org_role', 'owner');
    if (excludeUserId) query = query.neq('id', excludeUserId);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
}

async function assertInviteRate(orgId) {
    const since = new Date(Date.now() - INVITE_RATE_WINDOW_MS).toISOString();
    const { count, error } = await supabase
        .from('security_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .in('action', ['invite_member', 'resend_invite'])
        .gte('at', since);
    if (error) throw error;
    if (inviteActionRateLimited(count)) {
        throw new HttpError(429, 'INVITE_RATE_LIMIT', 'Забагато запрошень за останню годину. Спробуйте пізніше.');
    }
}

async function activeLogistCount(orgId, excludeUserId = null) {
    let query = supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('member_status', 'active')
        .eq('org_role', 'logist');
    if (excludeUserId) query = query.neq('id', excludeUserId);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
}

async function pendingInviteCount(orgId, excludeInviteId = null) {
    let query = supabase
        .from('org_invites')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString());
    if (excludeInviteId) query = query.neq('id', excludeInviteId);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
}

async function teamSeatUsage(orgId, excludeInviteId = null) {
    const [logists, pending] = await Promise.all([
        activeLogistCount(orgId),
        pendingInviteCount(orgId, excludeInviteId)
    ]);
    return { logists, pending, used: logists + pending, limit: MAX_TEAM_SEATS };
}

async function listTeam(actor) {
    const orgId = actor.profile.org_id;
    const [{ data: members, error: membersError }, usersResult, settingsResult, seats] = await Promise.all([
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
            .maybeSingle(),
        teamSeatUsage(orgId)
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
    if (actor.profile.org_role === 'owner') {
        const { data, error } = await supabase
            .from('org_invites')
            .select('id, email, org_role, expires_at, accepted_at, revoked_at, created_at')
            .eq('org_id', orgId)
            .is('accepted_at', null)
            .is('revoked_at', null)
            .order('created_at', { ascending: false });
        if (error) throw error;
        invites = (data || []).map(invite => ({
            ...invite,
            invite_url: inviteUrl(invite)
        }));
    }

    const activeOwnerCount = result.filter(member =>
        member.org_role === 'owner' && member.member_status === 'active'
    ).length;

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
        active_owner_count: activeOwnerCount,
        seats,
        members: result,
        invites
    };
}

async function deliverInvite(email, url) {
    const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: url,
        data: { trip_control_invite: true }
    });
    if (!error) return 'email';

    const message = String(error.message || '').toLowerCase();
    if (message.includes('already') || message.includes('registered') || message.includes('exists')) {
        const { error: resendError } = await supabase.auth.resend({
            type: 'signup',
            email,
            options: { emailRedirectTo: url }
        });
        return resendError ? 'existing_user_link' : 'email_resend';
    }
    return 'manual_link';
}

async function inviteMember(actor, body) {
    requireOwner(actor);
    const orgId = actor.profile.org_id;
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.org_role || 'logist');

    if (!validEmail(email)) {
        throw new HttpError(400, 'BAD_EMAIL', 'Вкажіть коректний email.');
    }
    if (!INVITE_ROLES.has(role)) {
        throw new HttpError(400, 'BAD_ROLE', 'Запросити можна лише логіста.');
    }
    if (!canInviteRole(actor.profile.org_role, role)) {
        throw new HttpError(403, 'OWNER_ONLY', 'Запрошення доступні лише власнику.');
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
    if (pendingInvite) {
        const { error: revokeError } = await supabase
            .from('org_invites')
            .update({ revoked_at: new Date().toISOString() })
            .eq('id', pendingInvite.id)
            .is('accepted_at', null)
            .is('revoked_at', null);
        if (revokeError) throw revokeError;
    }

    const seats = await teamSeatUsage(orgId);
    if (seats.used >= seats.limit) {
        throw new HttpError(409, 'MEMBER_LIMIT', `Уже зайнято ${seats.used} з ${seats.limit} логістів.`);
    }
    await assertInviteRate(orgId);

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
        .select('id, email, org_role, expires_at')
        .single();
    if (inviteError) {
        const mapped = inviteRpcHttpError(inviteError.message);
        if (mapped) throw mapped;
        throw inviteError;
    }

    const url = inviteUrl(invite);
    const delivery = await deliverInvite(email, url);

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
        expires_at: invite.expires_at,
        delivery,
        invite_url: url,
        work_mode: actor.profile.organizations.work_mode
    };
}

async function acceptInvite(actor, body) {
    const token = String(body.token || '');
    if (token.length < 32 || token.length > 512) {
        throw new HttpError(400, 'BAD_INVITE_TOKEN', 'Некоректне посилання запрошення.');
    }

    let hash;
    if (token.startsWith('v2.')) {
        const inviteId = token.split('.')[1] || '';
        const { data: invite, error: inviteError } = await supabase
            .from('org_invites')
            .select('id, email, org_role, expires_at, token_hash')
            .eq('id', inviteId)
            .maybeSingle();
        if (inviteError) throw inviteError;
        if (!invite || !signedInviteTokenIsValid(token, invite)) {
            throw new HttpError(400, 'BAD_INVITE_TOKEN', 'Некоректне посилання запрошення.');
        }
        hash = invite.token_hash;
    } else {
        hash = tokenHash(token);
    }

    const { data, error } = await supabase
        .rpc('accept_org_invite', {
            p_token_hash: hash,
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

    if (role === 'owner' && target.member_status === 'active' && target.org_role !== 'owner') {
        const others = await activeOwnerCount(actor.profile.org_id, userId);
        if (secondActiveOwnerBlocked(others)) {
            throw new HttpError(409, 'SECOND_ACTIVE_OWNER', 'У компанії вже є активний власник.');
        }
    }

    const wasActiveLogist = target.org_role === 'logist' && target.member_status === 'active';
    const becomesActiveLogist = role === 'logist' && target.member_status === 'active';
    if (becomesActiveLogist) {
        const seats = await teamSeatUsage(actor.profile.org_id);
        if (activationExceedsLogistCap({
            activeLogists: seats.logists,
            pendingInvites: seats.pending,
            wasActiveLogist
        })) {
            throw new HttpError(409, 'MEMBER_LIMIT', `Уже зайнято ${seats.used} з ${seats.limit} логістів.`);
        }
    }

    const { error } = await supabase
        .from('profiles')
        .update({ org_role: role })
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id);
    if (error) {
        const mapped = profileWriteError(error, 'Не можна понизити останнього активного власника.');
        if (mapped) throw mapped;
        throw error;
    }

    await audit(actor.user.id, actor.profile.org_id, 'change_member_role', 'profiles', userId, {
        old: target.org_role,
        new: role
    });
    return { ok: true, user_id: userId, org_role: role };
}

async function disableMember(actor, body) {
    requireOwner(actor);
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
    const update = supabase
        .from('profiles')
        .update({ member_status: 'disabled' })
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id);
    const { data: disabled, error } = await update
        .select('id')
        .maybeSingle();
    if (error) {
        const mapped = profileWriteError(error, 'Не можна відключити останнього активного власника.');
        if (mapped) throw mapped;
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

async function enableMember(actor, body) {
    requireOwner(actor);
    const userId = String(body.user_id || '');
    if (!userId || userId === actor.user.id) {
        throw new HttpError(400, 'BAD_ENABLE_TARGET', 'Некоректний учасник.');
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
    if (target.member_status === 'active') {
        return { ok: true, user_id: userId, member_status: 'active' };
    }

    if (target.org_role === 'owner') {
        const others = await activeOwnerCount(actor.profile.org_id, userId);
        if (secondActiveOwnerBlocked(others)) {
            throw new HttpError(409, 'SECOND_ACTIVE_OWNER', 'У компанії вже є активний власник.');
        }
    }

    if (target.org_role === 'logist') {
        const seats = await teamSeatUsage(actor.profile.org_id);
        if (activationExceedsLogistCap({
            activeLogists: seats.logists,
            pendingInvites: seats.pending,
            wasActiveLogist: false
        })) {
            throw new HttpError(409, 'MEMBER_LIMIT', `Уже зайнято ${seats.used} з ${seats.limit} логістів.`);
        }
    }

    const { data: enabled, error } = await supabase
        .from('profiles')
        .update({ member_status: 'active' })
        .eq('id', userId)
        .eq('org_id', actor.profile.org_id)
        .eq('member_status', 'disabled')
        .select('id')
        .maybeSingle();
    if (error) {
        const mapped = profileWriteError(error, 'Не можна увімкнути цього учасника.');
        if (mapped) throw mapped;
        throw error;
    }
    if (!enabled) {
        throw new HttpError(409, 'MEMBER_ROLE_CHANGED', 'Статус учасника вже змінився. Оновіть список команди.');
    }

    await audit(actor.user.id, actor.profile.org_id, 'enable_member', 'profiles', userId, {
        org_role: target.org_role
    });
    return { ok: true, user_id: userId, member_status: 'active' };
}

async function revokeInvite(actor, body) {
    requireOwner(actor);
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

async function resendInvite(actor, body) {
    requireOwner(actor);
    const inviteId = String(body.invite_id || '');
    const { data: existing, error: existingError } = await supabase
        .from('org_invites')
        .select('id, email, org_role')
        .eq('id', inviteId)
        .eq('org_id', actor.profile.org_id)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .single();
    if (existingError || !existing) {
        throw new HttpError(404, 'INVITE_NOT_FOUND', 'Активне запрошення не знайдено.');
    }

    const seats = await teamSeatUsage(actor.profile.org_id, inviteId);
    if (seats.used >= seats.limit) {
        throw new HttpError(409, 'MEMBER_LIMIT', `Уже зайнято ${seats.used} з ${seats.limit} логістів.`);
    }
    await assertInviteRate(actor.profile.org_id);

    const now = new Date();
    const { data: invite, error } = await supabase
        .from('org_invites')
        .update({
            token_hash: tokenHash(randomBytes(32).toString('base64url')),
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + INVITE_TTL_MS).toISOString()
        })
        .eq('id', inviteId)
        .eq('org_id', actor.profile.org_id)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .select('id, email, org_role, expires_at')
        .maybeSingle();
    if (error) {
        const mapped = inviteRpcHttpError(error.message);
        if (mapped) throw mapped;
        throw error;
    }
    if (!invite) {
        throw new HttpError(409, 'INVITE_CHANGED', 'Запрошення вже прийнято або відкликано.');
    }

    const url = inviteUrl(invite);
    const delivery = await deliverInvite(invite.email, url);
    await audit(actor.user.id, actor.profile.org_id, 'resend_invite', 'org_invites', invite.id, {
        delivery,
        expires_at: invite.expires_at
    });
    return {
        ok: true,
        invite_id: invite.id,
        expires_at: invite.expires_at,
        delivery,
        invite_url: url
    };
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
        else if (action === 'enable') result = await enableMember(actor, body);
        else if (action === 'revoke') result = await revokeInvite(actor, body);
        else if (action === 'resend') result = await resendInvite(actor, body);
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
