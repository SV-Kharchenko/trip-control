// Модуль «Власний парк» (етап 1): чиста логіка без DOM — доступ, статуси, дошка, лічильники, дозволені дії. Справжню перевірку прав
// роблять RLS і функції БД (*_own_fleet.sql); тут лише підказка інтерфейсу. Цей файл НЕ імпортується з основного бандла:
// його тягне лише lazy-чанк views/own-fleet/ і невеликий гейт у bridge.js (lib/own-fleet-gate.js).
import { kyivDate } from './format.js';

export const STATUSES = ['new', 'accepted', 'assigned', 'in_progress', 'done', 'cancelled'];
export const STATUS_LABELS = {
    new: 'Нова', accepted: 'Прийнята', assigned: 'Призначена', in_progress: 'У рейсі', done: 'Виконана', cancelled: 'Скасована',
};
// Колонки дошки: «Виконана» — лише за сьогодні; скасовані на дошці не показуються (є у списку).
export const BOARD_COLUMNS = ['new', 'accepted', 'assigned', 'in_progress', 'done'];
export const PRIORITIES = ['normal', 'high', 'urgent'];
export const PRIORITY_LABELS = { normal: 'Звичайний', high: 'Високий', urgent: 'Терміново' };
export const UNIT_KINDS = { agro: 'Агро', elevator: 'Елеватор', livestock: 'Тваринництво', warehouse: 'Склад', other: 'Інше' };
export const POINT_KINDS = { field: 'Поле', elevator: 'Елеватор', warehouse: 'Склад', farm: 'Ферма', other: 'Інше' };
export const OWN_FLEET_ROLE_LABELS = { owner: 'Директор', director: 'Менеджер', logist: 'Логіст', requester: 'Замовник підрозділу' };

export { ownFleetAccess, ownFleetOnly } from './own-fleet-gate.js';

export const isFinal = (status) => status === 'done' || status === 'cancelled';

// Прострочена: бажаний час минув, а рейс ще не почався (статус < in_progress).
export function isOverdue(request, now = Date.now()) {
    return ['new', 'accepted', 'assigned'].includes(request.status) && Date.parse(request.wanted_at) < now;
}

// Лічильники шапки: нові, термінові (активні з пріоритетом «Терміново»), прострочені.
export function counters(rows, now = Date.now()) {
    const list = rows || [];
    return {
        new: list.filter((r) => r.status === 'new').length,
        urgent: list.filter((r) => r.priority === 'urgent' && !isFinal(r.status)).length,
        overdue: list.filter((r) => isOverdue(r, now)).length,
    };
}

// Фільтри: date — РРРР-ММ-ДД (бажаний день за Києвом), unitId, priority. Порожнє значення — без обмеження.
export function filterRequests(rows, { date = '', unitId = '', priority = '' } = {}) {
    return (rows || []).filter((r) => (!unitId || r.unit_id === unitId) && (!priority || r.priority === priority)
        && (!date || kyivDate(new Date(r.wanted_at)) === date));
}

const byWanted = (a, b) => Date.parse(a.wanted_at) - Date.parse(b.wanted_at) || a.number - b.number;
const byPriority = (a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || byWanted(a, b);

// Колонки дошки: у кожній термінові вище; «Виконана» — лише закриті сьогодні (за Києвом).
export function boardGroups(rows, filters = {}, now = Date.now()) {
    const today = kyivDate(new Date(now));
    const out = Object.fromEntries(BOARD_COLUMNS.map((s) => [s, []]));
    for (const r of filterRequests(rows, filters)) {
        if (!(r.status in out)) continue;
        if (r.status === 'done' && !(r.done_at && kyivDate(new Date(r.done_at)) === today)) continue;
        out[r.status].push(r);
    }
    for (const s of BOARD_COLUMNS) out[s].sort(s === 'done' ? byWanted : byPriority);
    return out;
}

// Дії над заявкою для ролі — дзеркало правил fleet_request_transition / fleet_request_assign на сервері.
export function nextActions(request, role, userId) {
    if (!request || isFinal(request.status)) return [];
    if (role === 'requester') {
        return request.status === 'new' && request.created_by === userId ? [{ to: 'cancelled', label: 'Скасувати заявку', needsReason: true, danger: true }] : [];
    }
    if (!['owner', 'director', 'logist'].includes(role)) return [];
    const out = [];
    if (request.status === 'new') out.push({ to: 'accepted', label: 'Прийняти' });
    if (request.status === 'accepted') out.push({ to: 'assigned', label: 'Призначити авто й водія', assign: true });
    if (request.status === 'assigned') {
        out.push({ to: 'in_progress', label: 'Почати рейс' });
        out.push({ to: 'assigned', label: 'Змінити призначення', assign: true });
        out.push({ to: 'accepted', label: 'Зняти призначення' });
    }
    if (request.status === 'in_progress') out.push({ to: 'done', label: 'Завершити' });
    out.push({ to: 'cancelled', label: 'Скасувати', needsReason: true, danger: true });
    return out;
}

export function routeText(request, points = []) {
    const name = (id, text) => {
        const p = id ? points.find((x) => x.id === id) : null;
        return p ? p.name : text || '—';
    };
    return name(request.from_point_id, request.from_text) + ' → ' + name(request.to_point_id, request.to_text);
}

const BY_CODE = [
    [/OWN_FLEET_FORBIDDEN|FLEET_REQUEST_FORBIDDEN/, 'Недостатньо прав для цієї дії.'],
    [/FLEET_REQUEST_NOT_FOUND/, 'Заявку не знайдено. Оновіть дошку.'],
    [/FLEET_REQUEST_BAD_TRANSITION/, 'Цей перехід статусу недоступний: заявка вже змінилась. Оновіть дошку.'],
    [/FLEET_REQUEST_REASON_REQUIRED/, 'Вкажіть причину скасування.'],
    [/FLEET_REQUEST_USE_ASSIGN/, 'Авто й водія призначайте кнопкою «Призначити».'],
    [/FLEET_REQUEST_BAD_ASSIGNMENT/, 'Оберіть авто та водія з вашого автопарку (причіп — за потреби).'],
    [/FLEET_REQUEST_TRAILER_ARCHIVED/, 'Причіп в архіві: оберіть активний причіп.'],
    [/FLEET_REQUEST_BAD_TRIP/, 'Подорожній лист не знайдено або він належить іншій компанії.'],
    [/REQUESTER_WORKS_ELSEWHERE/, 'Цей акаунт уже працює в іншій компанії. Запросіть замовника на іншу пошту.'],
    [/REQUESTER_IS_MEMBER/, 'Ця людина вже учасник або менеджер компанії — замовником підрозділу бути не може.'],
    [/FLEET_REQUEST_BAD_POINT/, 'Ця точка недоступна для вашого підрозділу.'],
    [/FLEET_REQUEST_INVALID/, 'Перевірте бажаний час і пріоритет.'],
    [/OWN_FLEET_UNIT_NOT_IN_ORG/, 'Підрозділ не знайдено або він в архіві.'],
    [/OWN_FLEET_RESPONSIBLE_NOT_MEMBER/, 'Відповідальний має бути учасником компанії.'],
    [/REQUESTER_LIMIT/, 'Досягнуто ліміт замовників підрозділів (30, разом із відкритими запрошеннями).'],
    [/REQUESTER_INVITE_NOT_FOUND/, 'Запрошення не знайдено або строк дії минув.'],
    [/REQUESTER_INVITE_USED/, 'Запрошення вже прийнято.'],
    [/INVITE_EMAIL_MISMATCH/, 'Запрошення надіслано на іншу пошту.'],
    [/org_units_name_uq/, 'Підрозділ з такою назвою вже є.'],
    [/violates check constraint/, 'Перевірте заповнені поля.'],
];
export function ownFleetErrorText(error) {
    const text = String((error && (error.message || error.code)) || '');
    const hit = BY_CODE.find(([re]) => re.test(text));
    return hit ? hit[1] : 'Не вдалося виконати дію. Спробуйте ще раз.';
}

// Час для людини: «04.11 14:30» за Києвом.
export function fmtWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const parts = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return g('day') + '.' + g('month') + ' ' + g('hour') + ':' + g('minute');
}

// <input type="datetime-local"> ↔ ISO (локальний час браузера).
export function toLocalInput(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
export function fromLocalInput(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
