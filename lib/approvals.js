// Погодження заявок: хто які переходи статусу має право робити. Одна правда для API (api/team.js) і тестів;
// у базі те саме примусово виконує тригер calculations_enforce_approval (міграція 20261113090000_request_registry.sql,
// раніше 20261027140559). Ролі: owner (у інтерфейсі «Директор»), director (org_directors Контроль+), logist.
//
//   draft | rejected -> pending   автор заявки (логіст) або owner
//   pending -> accepted | rejected   owner, director або логіст із правом (approvalMode = logist_can_accept І canAccept)
//   draft | rejected -> accepted     owner у режимі «Сам» (solo) і лише власну заявку; director; логіст із правом у team
//   accepted -> done                 автор, owner або director
//   accepted -> cancelled            owner, director або логіст із правом; причина обов'язкова
//   done -> cancelled заборонено; з cancelled нікуди не переходить
//   видалення: автор або owner, але не accepted / done / cancelled

export const APPROVAL_STATUSES = ['draft', 'pending', 'accepted', 'rejected', 'done', 'cancelled'];
// Реєстр заявок: accepted = «Активна/прийнята», done = виконана, cancelled = скасована.
export const REGISTRY_STATUSES = ['accepted', 'done', 'cancelled'];
export const APPROVAL_MODES = ['owner_only', 'logist_can_accept'];
export const DEFAULT_APPROVAL_MODE = 'owner_only';
export const REJECT_REASON_MAX = 500;
export const CANCEL_REASON_MAX = 500;

const forbid = (code, message) => ({ ok: false, status: 403, code, message });
const conflict = (code, message) => ({ ok: false, status: 409, code, message });
const invalid = (code, message) => ({ ok: false, status: 400, code, message });

export function normalizeApprovalMode(value) {
    return value === 'logist_can_accept' ? 'logist_can_accept' : DEFAULT_APPROVAL_MODE;
}

// Хто вирішує заявки: owner і director завжди; логіст лише в режимі logist_can_accept і з правом can_accept.
export function canDecide(ctx) {
    if (ctx.role === 'owner' || ctx.role === 'director') return true;
    return ctx.role === 'logist' && normalizeApprovalMode(ctx.approvalMode) === 'logist_can_accept' && ctx.canAccept === true;
}

// ctx: { role: 'owner' | 'director' | 'logist', isAuthor: boolean, soloMode: boolean, approvalMode?: string, canAccept?: boolean }
// opts: { reason } — причина скасування.
export function planTransition(ctx, from, to, opts = {}) {
    if (!APPROVAL_STATUSES.includes(from) || !APPROVAL_STATUSES.includes(to)) {
        return conflict('BAD_STATUS', 'Невідомий статус заявки.');
    }
    if (from === 'cancelled') return conflict('CANCELLED_FINAL', 'Скасована заявка більше не змінюється.');
    if (to === 'cancelled' && from === 'done') return forbid('DONE_LOCKED', 'Виконану заявку скасувати не можна.');
    const owner = ctx.role === 'owner';
    const director = ctx.role === 'director';
    const author = ctx.isAuthor === true;
    const solo = ctx.soloMode === true;
    if (to === 'pending' && (from === 'draft' || from === 'rejected')) {
        return author || owner ? { ok: true } : forbid('NOT_AUTHOR', 'Подати на погодження може лише автор заявки.');
    }
    if ((to === 'accepted' || to === 'rejected') && from === 'pending') {
        return canDecide(ctx) ? { ok: true } : forbid('OWNER_ONLY', 'Погоджувати чи відхиляти заявки може лише власник.');
    }
    if (to === 'accepted' && (from === 'draft' || from === 'rejected')) {
        const allowed = (owner && author && solo) || director || (canDecide(ctx) && ctx.role === 'logist' && !solo);
        return allowed ? { ok: true } : forbid('NOT_SUBMITTED', 'Заявка має спершу пройти погодження.');
    }
    if (to === 'done' && from === 'accepted') {
        return author || owner || director ? { ok: true } : forbid('NOT_AUTHOR', 'Немає прав змінювати цю заявку.');
    }
    if (to === 'cancelled' && from === 'accepted') {
        if (!canDecide(ctx)) return forbid('CANCEL_FORBIDDEN', 'Скасувати заявку може лише директор або логіст із правом приймати заявки.');
        if (!cleanCancelReason(opts.reason)) return invalid('CANCEL_REASON_REQUIRED', 'Вкажіть причину скасування.');
        return { ok: true };
    }
    return conflict('BAD_TRANSITION', 'Цей перехід статусу недоступний.');
}

export function planDelete(ctx, status) {
    if (status === 'accepted' || status === 'done' || status === 'cancelled') {
        return forbid('ACCEPTED_LOCKED', 'Прийняту заявку видалити не можна.');
    }
    if (ctx.isAuthor === true || ctx.role === 'owner') return { ok: true };
    return forbid('NOT_AUTHOR', 'Видалити заявку може лише її автор або власник.');
}

// Правити вміст заявки (маршрут, цифри) можна лише у чернетці й відхиленій; на погодженні, прийняту, виконану й скасовану зафіксовано.
export function planUpdate(ctx, status) {
    if (status !== 'draft' && status !== 'rejected') {
        return conflict('NOT_EDITABLE', 'Заявку на погодженні чи прийняту змінити не можна. Створіть новий розрахунок.');
    }
    if (ctx.isAuthor === true || ctx.role === 'owner') return { ok: true };
    return forbid('NOT_AUTHOR', 'Змінити заявку може лише її автор або власник.');
}

export function cleanRejectReason(value) {
    const text = String(value == null ? '' : value).trim();
    return text ? text.slice(0, REJECT_REASON_MAX) : null;
}

export function cleanCancelReason(value) {
    const text = String(value == null ? '' : value).trim();
    return text ? text.slice(0, CANCEL_REASON_MAX) : null;
}
