import { BLOCK_BAN_DURATION, userAccessStatus } from './account-block.js';

// Зміна статусу одного користувача: Повний доступ / Демо / Заблоковано.
// Спільна для адмінки «Клієнтська база» (api/admin.js) і Telegram-бота (api/telegram-webhook.js).
// supabase — клієнт із service role.

export const USER_STATUSES = ['full', 'demo', 'blocked'];
export const USER_STATUS_LABEL = { full: 'Повний доступ', demo: 'Демо', blocked: 'Заблоковано' };

export class UserStatusError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

export async function writeAudit(supabase, actor, action, entity, entityId, orgId, detail) {
    // Помилка аудиту не скасовує вже виконану дію. У лог — лише код, без деталей з БД.
    try {
        const { error } = await supabase.from('security_audit_log').insert({
            actor: actor || null,
            org_id: orgId || null,
            action,
            entity,
            entity_id: entityId || null,
            detail: detail || null
        });
        if (error) console.warn('audit insert failed', error.code);
    } catch (e) {
        console.warn('audit insert failed', e && e.code);
    }
}

// options: { userId, status, actor (uuid або null), source: 'admin' | 'telegram', detail }
export async function setUserStatus(supabase, options) {
    const userId = options && options.userId;
    const status = options && options.status;
    if (!userId) throw new UserStatusError('USER_ID_REQUIRED', 'user_id required', 400);
    if (!USER_STATUSES.includes(status)) throw new UserStatusError('BAD_STATUS', 'Невідомий статус.', 400);

    const { data: target } = await supabase
        .from('profiles')
        .select('id, org_id, role, is_approved')
        .eq('id', userId)
        .single();
    if (!target) throw new UserStatusError('NOT_FOUND', 'Профіль не знайдено', 404);
    if (target.role === 'admin') throw new UserStatusError('ADMIN_PROTECTED', 'Статус адміністратора не змінюється.', 400);

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

    const detail = Object.assign({ status, previous, source: options.source || 'admin' }, options.detail || {});
    await writeAudit(supabase, options.actor, 'set_user_status', 'profiles', userId, target.org_id, detail);
    return { ok: true, user_id: userId, org_id: target.org_id, status, previous };
}
