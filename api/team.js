import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { USER_BLOCKED_ERROR, userIsBlocked } from '../lib/account-block.js';
import { buildInviteEmail, joinedMessage, sendInviteEmail } from '../lib/invite-mail.js';
import { sendTelegram, statusKeyboard } from '../lib/signup-notify.js';
import { cleanRejectReason, planDelete, planTransition } from '../lib/approvals.js';
import { recalculateRequest } from './calculate.js';

// Logist seats only. The owner is a fourth person and does not consume one.
const MAX_TEAM_SEATS = 3;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEAM_ROLES = new Set(['owner', 'logist']);
// Права логіста (колонки org_member_permissions.can_*). Рядка немає = значення за замовчуванням: усе, крім підпису.
// Право перевіряє БАЗА (member_can у тригерах і RPC); тут лише керування ними і показ у «Команді».
export const MEMBER_PERMISSIONS = ['acts', 'sign', 'fleet', 'clients', 'contracts'];
export const DEFAULT_MEMBER_PERMISSIONS = { acts: true, sign: false, fleet: true, clients: true, contracts: true };
const ALL_PERMISSIONS = { acts: true, sign: true, fleet: true, clients: true, contracts: true };
const NOTIFICATIONS_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_ROLES = new Set(['logist']);
// «Команда» shows invites from the last 30 days, newest first.
const INVITE_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_HISTORY_LIMIT = 20;
const INVITE_COLUMNS = 'id, org_id, email, org_role, expires_at, accepted_at, revoked_at, declined_at, created_at, invited_by';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Invite id from a signed v2 link, or null. The signature is checked against the row later.
export function signedInviteId(token) {
    const text = String(token || '');
    if (text.length < 32 || text.length > 512) return null;
    const parts = text.split('.');
    if (parts.length !== 3 || parts[0] !== 'v2' || !UUID_RE.test(parts[1]) || !parts[2]) return null;
    return parts[1].toLowerCase();
}

// sent / accepted / declined / expired / revoked.
export function inviteStatus(invite, now = Date.now()) {
    if (!invite) return 'revoked';
    if (invite.accepted_at) return 'accepted';
    if (invite.revoked_at) return 'revoked';
    if (invite.declined_at) return 'declined';
    if (!(Date.parse(invite.expires_at) > now)) return 'expired';
    return 'sent';
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

export const OLD_ORG_HAS_DATA_MESSAGE = 'У вашому акаунті вже є дані: розрахунки, автопарк, налаштування або інші учасники. ' +
    'Щоб їх не втратити, приєднатися цим акаунтом не можна. Попросіть власника надіслати запрошення на інший email.';

export function inviteRpcHttpError(message) {
    const text = String(message || '');
    if (text.includes('INVITE_NOT_ACTIVE')) {
        return new HttpError(404, 'INVITE_NOT_ACTIVE', 'Запрошення не знайдено або воно вже використане.');
    }
    if (text.includes('INVITE_DECLINED')) {
        return new HttpError(409, 'INVITE_DECLINED', 'Запрошення відхилено. Попросіть власника надіслати нове.');
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
    if (text.includes('OLD_ORG_HAS_DATA')) {
        return new HttpError(409, 'OLD_ORG_HAS_DATA', OLD_ORG_HAS_DATA_MESSAGE);
    }
    if (text.includes('ACCOUNT_ALREADY_IN_ORG')) {
        return new HttpError(409, 'ACCOUNT_ALREADY_IN_ORG', OLD_ORG_HAS_DATA_MESSAGE);
    }
    if (text.includes('MEMBER_LIMIT')) {
        return new HttpError(409, 'MEMBER_LIMIT', `Можна мати лише ${MAX_TEAM_SEATS} логістів, включно з активними запрошеннями.`);
    }
    return null;
}

const STATUS_ERRORS = {
    accepted: () => new HttpError(404, 'INVITE_NOT_ACTIVE', 'Запрошення вже прийнято.'),
    revoked: () => new HttpError(404, 'INVITE_NOT_ACTIVE', 'Запрошення скасовано власником.'),
    declined: () => new HttpError(409, 'INVITE_DECLINED', 'Запрошення відхилено. Попросіть власника надіслати нове.'),
    expired: () => new HttpError(410, 'INVITE_EXPIRED', 'Термін дії запрошення минув. Попросіть власника надіслати нове.')
};

const BAD_LINK = () => new HttpError(400, 'BAD_INVITE_TOKEN', 'Посилання запрошення недійсне або застаріле. Попросіть власника надіслати нове.');

// Everything that touches Supabase, mail or Telegram. deps: { supabase, fetch, env }.
export function createTeamService(deps) {
    const supabase = deps.supabase;
    const env = deps.env || {};
    const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());

    async function requireUser(req, options = {}) {
        const authHeader = req.headers && req.headers.authorization;
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
        const since = new Date(now() - INVITE_RATE_WINDOW_MS).toISOString();
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

    // A pending invite holds a seat until it is accepted, declined, revoked or expires.
    async function pendingInviteCount(orgId, excludeInviteId = null) {
        let query = supabase
            .from('org_invites')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .is('accepted_at', null)
            .is('revoked_at', null)
            .is('declined_at', null)
            .gt('expires_at', new Date(now()).toISOString());
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

    async function emailsById(ids) {
        const unique = Array.from(new Set((ids || []).filter(Boolean)));
        if (!unique.length) return new Map();
        const { data, error } = await supabase
            .from('profiles')
            .select('id, email')
            .in('id', unique);
        if (error) throw error;
        return new Map((data || []).map(row => [row.id, row.email || '']));
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
        const permissionRows = await loadPermissionRows(orgId);
        const result = (members || []).map(member => {
            const authUser = authById.get(member.id);
            const visible = actor.profile.org_role === 'owner' || member.id === actor.user.id;
            return {
                ...member,
                email: member.email || authUser?.email || '',
                last_sign_in_at: authUser?.last_sign_in_at || null,
                ...(visible ? { permissions: permissionsOf(member, permissionRows) } : {})
            };
        });

        let invites = [];
        if (actor.profile.org_role === 'owner') {
            const { data, error } = await supabase
                .from('org_invites')
                .select('id, email, org_role, expires_at, accepted_at, revoked_at, declined_at, created_at')
                .eq('org_id', orgId)
                .is('revoked_at', null)
                .gte('created_at', new Date(now() - INVITE_HISTORY_MS).toISOString())
                .order('created_at', { ascending: false })
                .limit(INVITE_HISTORY_LIMIT);
            if (error) throw error;
            invites = (data || []).map(invite => {
                const status = inviteStatus(invite, now());
                // Accepted invites keep their row for history but no longer need a link.
                return {
                    ...invite,
                    status,
                    invite_url: status === 'accepted' ? '' : inviteUrl(invite)
                };
            });
        }

        const activeOwners = result.filter(member =>
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
            active_owner_count: activeOwners,
            seats,
            members: result,
            invites
        };
    }

    // Own letter through Resend for every invite, new or existing account.
    // On failure the owner still has the link in «Команда».
    async function deliverInvite(invite, url, actor) {
        const message = buildInviteEmail({
            orgName: actor.profile.organizations.name,
            inviterEmail: actor.profile.email || actor.user.email || '',
            url,
            expiresAt: invite.expires_at
        });
        try {
            await sendInviteEmail(invite.email, message, { fetch: deps.fetch, env, timeoutMs: deps.mailTimeoutMs });
            return 'email';
        } catch (error) {
            console.warn('invite mail failed:', error && error.code);
            return 'manual_link';
        }
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
        if (enablingTeam && body.enable_team !== true) {
            throw new HttpError(409, 'TEAM_MODE_REQUIRED', 'Спочатку підтвердьте командний режим.');
        }

        // A new invite to the same email replaces the old one (sent, expired or declined).
        const { data: pendingInvite, error: pendingError } = await supabase
            .from('org_invites')
            .select('id, org_role')
            .eq('org_id', orgId)
            .eq('email', email)
            .is('accepted_at', null)
            .is('revoked_at', null)
            .maybeSingle();
        if (pendingError) throw pendingError;

        // Seats and rate first: a refused invite leaves the old one working.
        // The invite being replaced does not hold a second seat.
        const seats = await teamSeatUsage(orgId, pendingInvite ? pendingInvite.id : null);
        if (seats.used >= seats.limit) {
            throw new HttpError(409, 'MEMBER_LIMIT', `Уже зайнято ${seats.used} з ${seats.limit} логістів.`);
        }
        await assertInviteRate(orgId);

        if (pendingInvite) {
            const { error: revokeError } = await supabase
                .from('org_invites')
                .update({ revoked_at: new Date(now()).toISOString() })
                .eq('id', pendingInvite.id)
                .is('accepted_at', null)
                .is('revoked_at', null);
            if (revokeError) throw revokeError;
        }

        const rawToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now() + INVITE_TTL_MS).toISOString();
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

        const url = inviteUrl(invite);
        const delivery = await deliverInvite(invite, url, actor);

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

    async function loadSignedInvite(token) {
        const id = signedInviteId(token);
        if (!id) throw BAD_LINK();
        const { data: invite, error } = await supabase
            .from('org_invites')
            .select(INVITE_COLUMNS + ', token_hash, organizations(name, status)')
            .eq('id', id)
            .maybeSingle();
        if (error) throw error;
        if (!invite || !signedInviteTokenIsValid(token, invite)) throw BAD_LINK();
        return invite;
    }

    // No login: what the invite screen needs before sign-in or sign-up.
    async function inviteInfo(body) {
        const invite = await loadSignedInvite(body.token);
        const org = invite.organizations || {};
        let status = inviteStatus(invite, now());
        if (status === 'sent' && org.status === 'blocked') status = 'unavailable';
        const [inviters, existing] = await Promise.all([
            emailsById([invite.invited_by]),
            supabase
                .from('profiles')
                .select('id')
                .eq('email', String(invite.email || '').toLowerCase())
                .limit(1)
        ]);
        if (existing.error) throw existing.error;
        return {
            invite_id: invite.id,
            email: invite.email,
            org_name: org.name || '',
            inviter_email: inviters.get(invite.invited_by) || '',
            status,
            expires_at: invite.expires_at,
            account_exists: (existing.data || []).length > 0
        };
    }

    // Active invites for the signed-in, confirmed email (self-registered before opening the link).
    async function myInvites(actor) {
        const email = String(actor.user.email || '').trim().toLowerCase();
        if (!email || !actor.user.email_confirmed_at) return { invites: [] };
        const { data, error } = await supabase
            .from('org_invites')
            .select(INVITE_COLUMNS + ', organizations(name, status)')
            .eq('email', email)
            .is('accepted_at', null)
            .is('revoked_at', null)
            .is('declined_at', null)
            .gt('expires_at', new Date(now()).toISOString())
            .neq('org_id', actor.profile.org_id)
            .order('created_at', { ascending: false });
        if (error) throw error;
        const rows = (data || []).filter(invite => !invite.organizations || invite.organizations.status !== 'blocked');
        const inviters = await emailsById(rows.map(invite => invite.invited_by));
        return {
            invites: rows.map(invite => ({
                invite_id: invite.id,
                token: signedInviteToken(invite),
                email: invite.email,
                org_name: (invite.organizations && invite.organizations.name) || '',
                inviter_email: inviters.get(invite.invited_by) || '',
                expires_at: invite.expires_at
            }))
        };
    }

    async function notifyJoined(actor, orgId) {
        try {
            const { data: org } = await supabase
                .from('organizations')
                .select('name')
                .eq('id', orgId)
                .maybeSingle();
            await sendTelegram(joinedMessage({ email: actor.user.email, orgName: org && org.name }), {
                fetch: deps.fetch,
                env,
                replyMarkup: statusKeyboard(actor.user.id),
                timeoutMs: 3000
            });
        } catch (error) {
            console.warn('join notify failed:', error && error.code);
        }
    }

    async function acceptInvite(actor, body) {
        if (!actor.user.email_confirmed_at) {
            throw new HttpError(403, 'EMAIL_NOT_CONFIRMED', 'Спочатку підтвердьте email за посиланням з листа.');
        }
        const token = String(body.token || '');
        if (token.length < 32 || token.length > 512) {
            throw new HttpError(400, 'BAD_INVITE_TOKEN', 'Некоректне посилання запрошення.');
        }

        let hash;
        if (token.startsWith('v2.')) {
            const invite = await loadSignedInvite(token);
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

        if (data.org_id !== actor.profile.org_id || actor.profile.member_status !== 'active') {
            await notifyJoined(actor, data.org_id);
        }
        return { ok: true, org_id: data.org_id, org_role: data.org_role };
    }

    async function declineInvite(actor, body) {
        const invite = await loadSignedInvite(body.token);
        const email = String(actor.user.email || '').trim().toLowerCase();
        if (email !== String(invite.email || '').trim().toLowerCase()) {
            throw new HttpError(403, 'INVITE_EMAIL_MISMATCH', 'Запрошення призначене для іншого email.');
        }
        const status = inviteStatus(invite, now());
        if (STATUS_ERRORS[status]) throw STATUS_ERRORS[status]();

        const { data: declined, error } = await supabase
            .from('org_invites')
            .update({ declined_at: new Date(now()).toISOString() })
            .eq('id', invite.id)
            .is('accepted_at', null)
            .is('revoked_at', null)
            .is('declined_at', null)
            .select('id')
            .maybeSingle();
        if (error) throw error;
        if (!declined) {
            throw new HttpError(409, 'INVITE_CHANGED', 'Запрошення вже прийнято або відкликано.');
        }
        await audit(actor.user.id, invite.org_id, 'decline_invite', 'org_invites', invite.id, { email });
        return { ok: true, invite_id: invite.id };
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
            .update({ revoked_at: new Date(now()).toISOString() })
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

    // Works for sent, expired and declined invites: new link, new 7 days, new letter.
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

        const at = new Date(now());
        const { data: invite, error } = await supabase
            .from('org_invites')
            .update({
                token_hash: tokenHash(randomBytes(32).toString('base64url')),
                created_at: at.toISOString(),
                expires_at: new Date(at.getTime() + INVITE_TTL_MS).toISOString(),
                declined_at: null
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
        const delivery = await deliverInvite(invite, url, actor);
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

    // ---- Погодження заявок (календар «Заявки»). Роль перевіряється тут і тригером бази. ----
    async function loadCalculation(actor, id) {
        const calcId = String(id || '');
        if (!UUID_RE.test(calcId)) throw new HttpError(400, 'BAD_CALC_ID', 'Некоректна заявка.');
        const { data, error } = await supabase
            .from('calculations')
            .select('id, org_id, user_id, status, inputs, results')
            .eq('id', calcId)
            .eq('org_id', actor.profile.org_id)
            .maybeSingle();
        if (error) throw error;
        if (!data) throw new HttpError(404, 'CALC_NOT_FOUND', 'Заявку не знайдено.');
        return data;
    }

    function approvalContext(actor, calc) {
        return {
            role: actor.profile.org_role,
            isAuthor: calc.user_id === actor.user.id,
            soloMode: (actor.profile.organizations && actor.profile.organizations.work_mode) === 'solo'
        };
    }

    function denyFrom(plan) {
        return new HttpError(plan.status, plan.code, plan.message);
    }

    async function moveCalculation(actor, calc, to, extra = {}) {
        const plan = planTransition(approvalContext(actor, calc), calc.status, to);
        if (!plan.ok) throw denyFrom(plan);
        const stamp = new Date(now()).toISOString();
        const patch = { status: to, ...extra };
        if (to === 'pending') Object.assign(patch, { submitted_at: stamp, decided_by: null, decided_at: null, reject_reason: null });
        if (to === 'accepted' || to === 'rejected') {
            patch.decided_by = actor.user.id;
            patch.decided_at = stamp;
        }
        // .eq('status', ...) не дає двом рішенням затертись: хто встиг першим, той і вирішив.
        const { data, error } = await supabase
            .from('calculations')
            .update(patch)
            .eq('id', calc.id)
            .eq('org_id', actor.profile.org_id)
            .eq('status', calc.status)
            .select('id, status')
            .maybeSingle();
        if (error) {
            if (String(error.code) === '42501' || String(error.message || '').includes('APPROVAL_FORBIDDEN')) {
                throw new HttpError(403, 'APPROVAL_FORBIDDEN', 'Немає прав на цю зміну статусу.');
            }
            throw error;
        }
        if (!data) throw new HttpError(409, 'STATUS_CHANGED', 'Статус заявки вже змінився. Оновіть сторінку.');
        await audit(actor.user.id, actor.profile.org_id, 'calc_' + to, 'calculations', calc.id, { from: calc.status, to });
        return { ok: true, id: calc.id, status: data.status };
    }

    async function submitCalc(actor, body) {
        const calc = await loadCalculation(actor, body.id);
        return moveCalculation(actor, calc, 'pending');
    }

    // Погоджений директором варіант маршруту. Заявка зберігає всі варіанти Google (inputs.routeVariants, їх км зафіксовані
    // під час розрахунку логіста) і вибір логіста (inputs.routeVariant.index). Від клієнта приходить лише номер варіанта:
    // км беруться зі збереженого варіанта, а вся заявка (пальне, AdBlue, витрати, прибуток) перераховується тією самою
    // функцією, що й POST /api/calculate. Збережені цифри прибутку з routeVariants і results не використовуються.
    // У approved_variant лишаються обидва набори: варіант логіста й погоджений. Стара заявка без варіантів погоджується як раніше.
    const APPROVED_RESULT_KEYS = ['grossIncome', 'marginalIncome', 'ebitda', 'netProfit', 'profitabilityPct', 'fuelAndAdblueTotal'];

    async function loadCalcVehicles(calc, actor) {
        const { data, error } = await supabase.from('calc_vehicles').select('calc_id, vehicle_id, tonnage, snapshot').eq('calc_id', calc.id);
        // До міграції calc_vehicles таблиці немає: тоді авто беремо з inputs.vehicles, якщо вони там є.
        if (error || !Array.isArray(data)) return [];
        return data.map((row) => {
            const snap = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {};
            return { ...(snap.resolved || {}), id: row.vehicle_id, label: snap.label || 'Авто', tonnage: Number(row.tonnage), snapshot: snap };
        });
    }

    function variantKm(variant) {
        const main = Number(variant.mainKm !== undefined ? variant.mainKm : variant.km);
        const podacha = Number(variant.podachaKm) || 0;
        return main > 0 && podacha >= 0 ? { dist: main, podachaDist: podacha } : null;
    }

    function variantSummary(variant, km, results) {
        const out = { index: variant.index, km: km.dist, minutes: variant.minutes, podachaKm: km.podachaDist, summary: variant.summary || '' };
        for (const key of APPROVED_RESULT_KEYS) if (results[key] !== undefined) out[key] = results[key];
        return out;
    }

    async function approvedRoutePatch(calc, rawIndex, actor) {
        const inputs = calc.inputs && typeof calc.inputs === 'object' ? calc.inputs : {};
        const variants = Array.isArray(inputs.routeVariants) ? inputs.routeVariants : [];
        if (!variants.length) return {};
        const logistIndex = inputs.routeVariant && Number.isInteger(inputs.routeVariant.index) ? inputs.routeVariant.index : 0;
        const asked = rawIndex === undefined || rawIndex === null ? logistIndex : rawIndex;
        const find = (index) => (Number.isInteger(index) ? variants.find((item) => item && item.index === index) : null);
        const chosen = find(asked);
        const logist = find(logistIndex);
        if (!chosen || !logist) throw new HttpError(400, 'BAD_VARIANT', 'Такого варіанта маршруту в заявці немає.');
        const chosenKm = variantKm(chosen);
        const logistKm = variantKm(logist);
        // Варіант логіста мав дати ті самі км, що лежать у розрахунку заявки: інакше збережені варіанти не відповідають їй.
        const sameKm = logistKm && logistKm.dist === Number(inputs.dist) && logistKm.podachaDist === (Number(inputs.podachaDist) || 0);
        if (!chosenKm || !sameKm) throw new HttpError(400, 'BAD_VARIANT', 'Збережені варіанти маршруту не збігаються з розрахунком заявки.');

        const vehicles = await loadCalcVehicles(calc, actor);
        const run = (km) => {
            const done = recalculateRequest({ ...inputs, ...km }, vehicles.length ? vehicles : inputs.vehicles);
            if (!done.result) throw new HttpError(400, 'RECALC_FAILED', done.error || 'Не вдалося перерахувати заявку.');
            return done.result;
        };
        const logistResults = run(logistKm);
        const chosenResults = chosen.index === logist.index ? logistResults : run(chosenKm);

        const logistSummary = variantSummary(logist, logistKm, logistResults);
        const approvedSummary = variantSummary(chosen, chosenKm, chosenResults);
        const oldResults = calc.results && typeof calc.results === 'object' ? calc.results : {};
        return {
            approved_variant: {
                ...approvedSummary,
                logistIndex: logist.index,
                logist: logistSummary,
                approved: approvedSummary,
                decidedBy: actor.user.id,
                decidedAt: new Date(now()).toISOString()
            },
            inputs: { ...inputs, dist: chosenKm.dist, podachaDist: chosenKm.podachaDist },
            results: { ...oldResults, ...chosenResults, dist: chosenKm.dist, podachaDist: chosenKm.podachaDist }
        };
    }

    async function decideCalc(actor, body) {
        const decision = String(body.decision || '');
        if (decision !== 'accepted' && decision !== 'rejected') {
            throw new HttpError(400, 'BAD_DECISION', 'Невідоме рішення.');
        }
        const calc = await loadCalculation(actor, body.id);
        const extra = decision === 'rejected' ? { reject_reason: cleanRejectReason(body.reason) } : { reject_reason: null };
        if (decision === 'accepted') Object.assign(extra, await approvedRoutePatch(calc, body.variantIndex, actor));
        return moveCalculation(actor, calc, decision, extra);
    }

    async function completeCalc(actor, body) {
        const calc = await loadCalculation(actor, body.id);
        return moveCalculation(actor, calc, 'done');
    }

    async function deleteCalc(actor, body) {
        const calc = await loadCalculation(actor, body.id);
        const plan = planDelete(approvalContext(actor, calc), calc.status);
        if (!plan.ok) throw denyFrom(plan);
        const { data, error } = await supabase
            .from('calculations')
            .delete()
            .eq('id', calc.id)
            .eq('org_id', actor.profile.org_id)
            .not('status', 'in', '(accepted,done)')
            .select('id');
        if (error) throw error;
        if (!data || !data.length) throw new HttpError(409, 'STATUS_CHANGED', 'Статус заявки вже змінився. Оновіть сторінку.');
        await audit(actor.user.id, actor.profile.org_id, 'calc_deleted', 'calculations', calc.id, { status: calc.status });
        return { ok: true, id: calc.id };
    }

    async function loadPermissionRows(orgId) {
        const { data, error } = await supabase
            .from('org_member_permissions')
            .select('user_id, can_acts, can_sign, can_fleet, can_clients, can_contracts')
            .eq('org_id', orgId);
        // До міграції таблиці немає: показуємо значення за замовчуванням.
        if (error) return new Map();
        return new Map((data || []).map(row => [row.user_id, row]));
    }

    function permissionsOf(member, rows) {
        if (member.org_role === 'owner') return { ...ALL_PERMISSIONS };
        const row = rows.get(member.id);
        if (!row) return { ...DEFAULT_MEMBER_PERMISSIONS };
        const out = {};
        for (const key of MEMBER_PERMISSIONS) out[key] = row['can_' + key] === true;
        return out;
    }

    // Права логіста змінює лише директор. Це лише запис: перевірку виконує база (member_can у тригерах/RPC).
    async function setPermissions(actor, body) {
        requireOwner(actor);
        const userId = String(body.user_id || '');
        if (!UUID_PATTERN.test(userId)) throw new HttpError(400, 'BAD_MEMBER', 'Некоректний учасник.');
        const patch = body.permissions;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new HttpError(400, 'BAD_PERMISSIONS', 'Не вказано права.');
        }
        const keys = Object.keys(patch);
        if (!keys.length || keys.some(key => !MEMBER_PERMISSIONS.includes(key) || typeof patch[key] !== 'boolean')) {
            throw new HttpError(400, 'BAD_PERMISSIONS', 'Невідоме право або значення не true/false.');
        }
        const { data: target, error: targetError } = await supabase
            .from('profiles')
            .select('id, org_role, member_status')
            .eq('id', userId)
            .eq('org_id', actor.profile.org_id)
            .maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Учасника не знайдено.');
        if (target.org_role !== 'logist') {
            throw new HttpError(400, 'OWNER_ALL_RIGHTS', 'Директор має всі права завжди.');
        }
        const rows = await loadPermissionRows(actor.profile.org_id);
        const next = { ...permissionsOf(target, rows), ...patch };
        const { error } = await supabase
            .from('org_member_permissions')
            .upsert({
                org_id: actor.profile.org_id,
                user_id: userId,
                can_acts: next.acts,
                can_sign: next.sign,
                can_fleet: next.fleet,
                can_clients: next.clients,
                can_contracts: next.contracts,
                updated_by: actor.user.id,
                updated_at: new Date(now()).toISOString()
            }, { onConflict: 'org_id,user_id' });
        if (error) throw error;
        await audit(actor.user.id, actor.profile.org_id, 'set_member_permissions', 'profiles', userId, { permissions: next });
        return { ok: true, user_id: userId, permissions: next };
    }

    // Сповіщення директору (пишуться тригерами бази). Список + лічильник непрочитаних.
    async function listNotifications(actor, body) {
        requireOwner(actor);
        const orgId = actor.profile.org_id;
        const limit = Math.max(1, Math.min(NOTIFICATIONS_LIMIT, Number(body && body.limit) || 50));
        const { data, error } = await supabase
            .from('org_notifications')
            .select('id, kind, ref_kind, ref_id, actor_id, meta, created_at, read_at')
            .eq('org_id', orgId)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) {
            // До міграції таблиці немає: порожній список замість помилки.
            if (/org_notifications|relation|schema cache|42P01|PGRST205/i.test(String(error.message || error.code || ''))) {
                return { items: [], unread: 0 };
            }
            throw error;
        }
        const { data: unreadRows, error: unreadError } = await supabase
            .from('org_notifications')
            .select('id')
            .eq('org_id', orgId)
            .is('read_at', null)
            .limit(1000);
        if (unreadError) throw unreadError;
        const actorIds = [...new Set((data || []).map(item => item.actor_id).filter(Boolean))];
        const emails = new Map();
        if (actorIds.length) {
            const { data: people } = await supabase.from('profiles').select('id, email').in('id', actorIds).eq('org_id', orgId);
            for (const person of people || []) emails.set(person.id, person.email || '');
        }
        return {
            items: (data || []).map(item => ({ ...item, actor_email: emails.get(item.actor_id) || '' })),
            unread: (unreadRows || []).length
        };
    }

    async function markNotificationsRead(actor, body) {
        requireOwner(actor);
        const all = body && body.all === true;
        const ids = Array.isArray(body && body.ids) ? body.ids : [];
        if (!all && (!ids.length || ids.length > NOTIFICATIONS_LIMIT || ids.some(id => !UUID_PATTERN.test(String(id))))) {
            throw new HttpError(400, 'BAD_NOTIFICATIONS', 'Не вказано сповіщення.');
        }
        let query = supabase
            .from('org_notifications')
            .update({ read_at: new Date(now()).toISOString(), read_by: actor.user.id })
            .eq('org_id', actor.profile.org_id)
            .is('read_at', null);
        if (!all) query = query.in('id', ids);
        const { data, error } = await query.select('id');
        if (error) throw error;
        return { ok: true, marked: (data || []).length };
    }

    return {
        requireUser,
        setPermissions,
        listNotifications,
        markNotificationsRead,
        submitCalc,
        decideCalc,
        completeCalc,
        deleteCalc,
        listTeam,
        inviteMember,
        inviteInfo,
        myInvites,
        acceptInvite,
        declineInvite,
        changeRole,
        disableMember,
        enableMember,
        revokeInvite,
        resendInvite,
        setWorkMode,
        setVisibility
    };
}

// Actions a disabled member may still call: they concern joining another company.
const INVITEE_ACTIONS = new Set(['accept', 'decline', 'my_invites']);

export function createTeamHandler(deps) {
    const service = createTeamService(deps);
    return async function handler(req, res) {
        try {
            const body = req.body || {};
            const action = String(body.action || '');

            // Invite screen before sign-in: needs only the signed link.
            if (req.method === 'POST' && action === 'invite_info') {
                return res.status(200).json(await service.inviteInfo(body));
            }

            const actor = await service.requireUser(req, {
                allowDisabled: req.method === 'POST' && INVITEE_ACTIONS.has(action)
            });

            if (req.method === 'GET') {
                return res.status(200).json(await service.listTeam(actor));
            }
            if (req.method !== 'POST') {
                return res.status(405).json({ error: 'Method Not Allowed' });
            }

            let result;
            if (action === 'invite') result = await service.inviteMember(actor, body);
            else if (action === 'accept') result = await service.acceptInvite(actor, body);
            else if (action === 'decline') result = await service.declineInvite(actor, body);
            else if (action === 'my_invites') result = await service.myInvites(actor);
            else if (action === 'change_role') result = await service.changeRole(actor, body);
            else if (action === 'disable') result = await service.disableMember(actor, body);
            else if (action === 'enable') result = await service.enableMember(actor, body);
            else if (action === 'revoke') result = await service.revokeInvite(actor, body);
            else if (action === 'resend') result = await service.resendInvite(actor, body);
            else if (action === 'set_work_mode') result = await service.setWorkMode(actor, body);
            else if (action === 'set_logists_see_all') result = await service.setVisibility(actor, body);
            else if (action === 'set_permissions') result = await service.setPermissions(actor, body);
            else if (action === 'notifications') result = await service.listNotifications(actor, body);
            else if (action === 'notifications_read') result = await service.markNotificationsRead(actor, body);
            else if (action === 'calc_submit') result = await service.submitCalc(actor, body);
            else if (action === 'calc_decide') result = await service.decideCalc(actor, body);
            else if (action === 'calc_complete') result = await service.completeCalc(actor, body);
            else if (action === 'calc_delete') result = await service.deleteCalc(actor, body);
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
    };
}

export default createTeamHandler({
    supabase: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY),
    fetch: (...args) => fetch(...args),
    env: process.env
});
