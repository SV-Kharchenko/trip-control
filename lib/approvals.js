// Погодження заявок: хто які переходи статусу має право робити. Одна правда для API (api/team.js) і тестів;
// у базі те саме примусово виконує тригер calculations_enforce_approval (міграція 20261027140559).
//
//   draft | rejected -> pending   автор заявки (логіст) або власник
//   pending -> accepted | rejected   лише власник (директор)
//   draft | rejected -> accepted     лише власник у режимі «Сам» (solo) і лише власну заявку
//   accepted -> done                 автор або власник
//   видалення: автор або власник, але не accepted / done

export const APPROVAL_STATUSES = ['draft', 'pending', 'accepted', 'rejected', 'done'];
export const REJECT_REASON_MAX = 500;

const forbid = (code, message) => ({ ok: false, status: 403, code, message });
const conflict = (code, message) => ({ ok: false, status: 409, code, message });

// ctx: { role: 'owner' | 'logist', isAuthor: boolean, soloMode: boolean }
export function planTransition(ctx, from, to) {
    if (!APPROVAL_STATUSES.includes(from) || !APPROVAL_STATUSES.includes(to)) {
        return conflict('BAD_STATUS', 'Невідомий статус заявки.');
    }
    const owner = ctx.role === 'owner';
    const author = ctx.isAuthor === true;
    if (to === 'pending' && (from === 'draft' || from === 'rejected')) {
        return author || owner ? { ok: true } : forbid('NOT_AUTHOR', 'Подати на погодження може лише автор заявки.');
    }
    if ((to === 'accepted' || to === 'rejected') && from === 'pending') {
        return owner ? { ok: true } : forbid('OWNER_ONLY', 'Погоджувати чи відхиляти заявки може лише власник.');
    }
    if (to === 'accepted' && (from === 'draft' || from === 'rejected')) {
        return owner && author && ctx.soloMode === true
            ? { ok: true }
            : forbid('NOT_SUBMITTED', 'Заявка має спершу пройти погодження.');
    }
    if (to === 'done' && from === 'accepted') {
        return author || owner ? { ok: true } : forbid('NOT_AUTHOR', 'Немає прав змінювати цю заявку.');
    }
    return conflict('BAD_TRANSITION', 'Цей перехід статусу недоступний.');
}

export function planDelete(ctx, status) {
    if (status === 'accepted' || status === 'done') {
        return forbid('ACCEPTED_LOCKED', 'Прийняту заявку видалити не можна.');
    }
    if (ctx.isAuthor === true || ctx.role === 'owner') return { ok: true };
    return forbid('NOT_AUTHOR', 'Видалити заявку може лише її автор або власник.');
}

export function cleanRejectReason(value) {
    const text = String(value == null ? '' : value).trim();
    return text ? text.slice(0, REJECT_REASON_MAX) : null;
}
