// Ремонти і склад (етап 3a): чисті функції інтерфейсу — доступ за роллю, підсумки ремонту, перевірка форми,
// тексти помилок і статусів. Права однаково перевіряє база (kp_repairs_can_write і функції запису).
import { num } from './format.js';

export const REPAIR_ROLE_LABELS = {
    owner: 'Власник',
    director: 'Директор',
    logist: 'Логіст',
    repair_manager: 'Менеджер з ремонтів',
};

// rctx — kp_repairs_context(), kpctx — kp_context().
export function repairsAccess(rctx, kpctx) {
    const visible = Boolean(rctx && rctx.org_id);
    const role = visible ? rctx.role || null : null;
    return {
        visible,
        role,
        canWrite: visible && rctx.can_write === true,
        canManage: visible && rctx.can_manage_handlers === true,
        // Менеджер з ремонтів без власного Контроль+: лише вкладка «Ремонти», без «Клієнтів», «Звіту», «GPS» і без екрана тарифу.
        repairsOnly: visible && !(kpctx && kpctx.control_plus === true),
    };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Підсумок форми: запчастини за поточною середньою (як спише сервер), СТО, разом.
export function repairTotals(lines, partsById, serviceCost) {
    let parts = 0;
    for (const line of lines || []) {
        const part = partsById.get(line.part_id);
        const qty = num(line.qty);
        if (part && qty !== null && qty > 0) parts += round2(qty * Number(part.avg_cost || 0));
    }
    const service = Math.max(0, num(serviceCost) || 0);
    return { parts: round2(parts), service: round2(service), total: round2(parts + service) };
}

// Помилки форми ремонту (клієнтська перевірка; сервер перевіряє ще раз, усе або нічого).
export function validateRepairForm(form, partsById, today) {
    const errors = [];
    if (!form.vehicle_id) errors.push({ field: 'vehicle', text: 'Оберіть авто.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date || '') || form.date > today) errors.push({ field: 'date', text: 'Дата ремонту — не пізніше сьогодні.' });
    const odometer = form.odometer === '' || form.odometer === null || form.odometer === undefined ? null : Number(form.odometer);
    if (odometer !== null && (!Number.isInteger(odometer) || odometer < 0 || odometer > 10000000)) errors.push({ field: 'odometer', text: 'Одометр — ціле число км.' });
    const works = String(form.works || '').trim();
    if (!works) errors.push({ field: 'works', text: 'Опишіть роботи.' });
    else if (works.length > 2000) errors.push({ field: 'works', text: 'Опис робіт — до 2000 символів.' });
    if (String(form.provider || '').trim().length > 200) errors.push({ field: 'provider', text: 'Назва СТО — до 200 символів.' });
    const service = form.service_cost === '' || form.service_cost === null || form.service_cost === undefined ? 0 : num(form.service_cost);
    if (service === null || service < 0) errors.push({ field: 'service_cost', text: 'Вартість СТО — число від 0.' });
    const need = new Map();
    (form.lines || []).forEach((line, i) => {
        if (!line.part_id && (line.qty === '' || line.qty === undefined)) return;
        const part = partsById.get(line.part_id);
        const qty = num(line.qty);
        if (!part) errors.push({ field: 'line-' + i, text: 'Рядок ' + (i + 1) + ': оберіть запчастину.' });
        else if (qty === null || qty <= 0) errors.push({ field: 'line-' + i, text: 'Рядок ' + (i + 1) + ': кількість більше 0.' });
        else need.set(part.id, (need.get(part.id) || 0) + qty);
    });
    for (const [id, qty] of need) {
        const part = partsById.get(id);
        if (qty > Number(part.qty)) errors.push({ field: 'stock', text: 'Не вистачає на складі: ' + part.name + ' (є ' + Number(part.qty) + ' ' + (part.unit || '') + ').' });
    }
    if (!works && !need.size && !service) errors.push({ field: 'empty', text: 'Ремонт порожній.' });
    return errors;
}

// Рядки запчастин для kp_repair_post.
export function repairPartsPayload(lines) {
    return (lines || []).filter((l) => l.part_id && num(l.qty) > 0).map((l) => ({ part_id: l.part_id, qty: num(l.qty) }));
}

const REPAIR_ERRORS = [
    [/REPAIRS_FORBIDDEN/, 'Немає права вносити ремонти. Попросіть власника призначити вас відповідальним.'],
    [/REPAIR_VOID_EXPIRED/, 'Минуло 24 години — сторнувати може лише власник або директор.'],
    [/REPAIR_ALREADY_VOID/, 'Ремонт уже сторновано.'],
    [/RECEIPT_ALREADY_USED/, 'Запчастини з цього приходу вже використано — сторно неможливе. Зробіть коригування.'],
    [/RECEIPT_ALREADY_REVERSED/, 'Прихід уже сторновано.'],
    [/PART_ARTICLE_EXISTS/, 'Запчастина з таким артикулом уже є.'],
    [/PARTS_LIMIT/, 'Досягнуто ліміту 5000 запчастин.'],
    [/PART_NOT_FOUND/, 'Запчастину не знайдено. Оновіть сторінку.'],
    [/REPAIR_VEHICLE_NOT_FOUND/, 'Авто не знайдено в автопарку вашої компанії.'],
    [/REPAIR_WORKS/, 'Опишіть роботи (до 2000 символів).'],
    [/BAD_DATE/, 'Перевірте дату.'],
    [/IMPORT_HAS_ERRORS/, 'У файлі є помилкові рядки — нічого не імпортовано.'],
    [/IMPORT_TOO_LARGE/, 'Понад 2000 рядків. Розбийте файл на частини.'],
    [/REPAIR_MANAGER_LIMIT/, 'Уже 2 менеджери з ремонтів (разом із чинними запрошеннями).'],
    [/REPAIR_HANDLER_NOT_LOGIST/, 'Призначити можна лише активного логіста компанії.'],
    [/REPAIR_HANDLER_EXISTS/, 'Цю людину вже призначено.'],
    [/ADJUST_REASON/, 'Вкажіть причину коригування.'],
    [/CONTROL_PLUS_REQUIRED/, 'Розділ доступний у тарифі Контроль+.'],
    [/Failed to fetch|NetworkError|Load failed/i, 'Немає зʼєднання з сервером. Перевірте інтернет.'],
];

export function repairErrorText(error) {
    if (!error) return '';
    const message = String(error.message || error.error || error);
    if (/STOCK_INSUFFICIENT/.test(message)) {
        return 'Не вистачає на складі' + (error.details ? ': ' + String(error.details).slice(0, 200) : '') + '. Нічого не списано.';
    }
    for (const [pattern, text] of REPAIR_ERRORS) if (pattern.test(message)) return text;
    if (error.code === '42501') return 'Недостатньо прав для цієї дії.';
    return 'Не вдалося виконати дію. Спробуйте ще раз.';
}

export const INVITE_STATUS_LABELS = {
    sent: 'надіслано',
    expired: 'прострочено',
    declined: 'відхилено',
    revoked: 'скасовано',
    accepted: 'прийнято',
};

export function seatsText(seats) {
    if (!seats) return '';
    return 'Менеджерів з ремонтів: ' + seats.used + ' з ' + seats.limit + (seats.pending ? ' (з них очікують: ' + seats.pending + ')' : '');
}

export function importStatusLabel(status) {
    return status === 'new_part' ? 'Нова запчастина' : status === 'receipt_existing' ? 'Прихід до наявної' : 'Помилка';
}

export function stockValue(part) {
    return round2(Number(part.qty || 0) * Number(part.avg_cost || 0));
}
