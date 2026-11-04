// Чисті функції менеджера вікон Контроль+ (PR 3 з 5): екранування, ключ і формат збереженого стану, межі, ліміт. Без DOM — їх перевіряють тести.

export const MAX_WINDOWS = 8;
export const MIN_WIDE = 900; // вужче — вікон і панелі задач немає, документ відкривається на всю сторінку
export const STORAGE_PREFIX = 'tc_kp_windows';
export const TASKBAR_H = 32;
export const MIN_W = 480; // найменший розмір вікна при зміні розміру за краї й кути
export const MIN_H = 320;
export const WIN_Z_BASE = 3040; // = --kp-z-win у kp-shell.css; вікна 3040…3047, вище лише панель задач, діалоги й тости

// Екранування для вставки в innerHTML (заголовки вікон і підписи панелі задач беруться з даних і шапок карток).
export function escHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// tc_kp_windows:<org>:<user> — sessionStorage; без пари (немає входу) ключа немає.
export function storageKey(org, user) {
    if (!org || !user) return null;
    return STORAGE_PREFIX + ':' + org + ':' + user;
}

// У сховищі: тип, id, «згорнуте», «розгорнуте» і розмір / позиція (x, y, w, h) — без вмісту, у порядку відкриття.
const num = (v) => typeof v === 'number' && Number.isFinite(v);
export function serializeWindows(list) {
    return JSON.stringify((list || []).map((w) => {
        const out = { type: w.type, id: w.id, minimized: !!w.minimized };
        if (w.maximized) out.max = true;
        if ([w.x, w.y, w.w, w.h].every(num)) Object.assign(out, { x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.w), h: Math.round(w.h) });
        return out;
    }));
}
const TYPES = ['doc', 'ttn', 'trip_sheet', 'form', 'client', 'client_form', 'request', 'vehicle', 'trailer', 'driver'];
export function parseWindows(raw) {
    let data = null;
    try { data = JSON.parse(raw || 'null'); } catch { data = null; }
    if (!Array.isArray(data)) return [];
    const seen = new Set();
    const out = [];
    for (const item of data) {
        if (!item || !TYPES.includes(item.type) || typeof item.id !== 'string' || item.id.length > 300) continue;
        const key = item.type + ':' + item.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = { type: item.type, id: item.id, minimized: item.minimized === true };
        if (item.max === true) entry.max = true;
        if ([item.x, item.y, item.w, item.h].every((v) => num(v) && Math.abs(v) <= 20000) && item.w > 0 && item.h > 0) Object.assign(entry, { x: item.x, y: item.y, w: item.w, h: item.h });
        out.push(entry);
        if (out.length >= MAX_WINDOWS) break;
    }
    return out;
}

// Вікно не виходить за межі робочої області (viewport без бокового меню, верхньої панелі й панелі задач).
export function clampPos(x, y, w, h, bounds) {
    const maxX = Math.max(bounds.left, bounds.right - w);
    const maxY = Math.max(bounds.top, bounds.bottom - h);
    return { x: Math.min(Math.max(x, bounds.left), maxX), y: Math.min(Math.max(y, bounds.top), maxY) };
}

// Розмір не менший за мінімум і не більший за робочу область; позиція в її межах.
export function clampRect(rect, bounds, min = { w: MIN_W, h: MIN_H }) {
    const availW = Math.max(1, bounds.right - bounds.left);
    const availH = Math.max(1, bounds.bottom - bounds.top);
    const w = Math.min(Math.max(rect.w, Math.min(min.w, availW)), availW);
    const h = Math.min(Math.max(rect.h, Math.min(min.h, availH)), availH);
    const pos = clampPos(rect.x, rect.y, w, h, bounds);
    return { x: pos.x, y: pos.y, w, h };
}

// Зміна розміру за край / кут: dir — будь-яка комбінація n, s, e, w («se», «w», «nw»…); dx, dy — зсув курсора від початку жесту.
// Протилежний край стоїть на місці, розмір не менший за мінімум і не виходить за робочу область.
export function resizeRect(start, dir, dx, dy, bounds, min = { w: MIN_W, h: MIN_H }) {
    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;
    const minW = Math.min(min.w, Math.max(1, bounds.right - bounds.left));
    const minH = Math.min(min.h, Math.max(1, bounds.bottom - bounds.top));
    if (dir.includes('e')) right = Math.min(Math.max(right + dx, left + minW), bounds.right);
    if (dir.includes('w')) left = Math.max(Math.min(left + dx, right - minW), bounds.left);
    if (dir.includes('s')) bottom = Math.min(Math.max(bottom + dy, top + minH), bounds.bottom);
    if (dir.includes('n')) top = Math.max(Math.min(top + dy, bottom - minH), bounds.top);
    return { x: left, y: top, w: right - left, h: bottom - top };
}

// Знімок значень полів форми: «брудна» форма — лише якщо знімок відрізняється від того, що був до першої дії користувача
// (після відкриття й автозаповнення). null — у контейнері немає querySelectorAll (тест без DOM).
export function formSnapshot(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const parts = [];
    for (const el of root.querySelectorAll('input, select, textarea')) {
        const type = String(el.type || '').toLowerCase();
        if (type === 'file' || type === 'button' || type === 'submit' || type === 'search') continue; // пошук і фільтри не є даними форми
        if (typeof el.closest === 'function' && el.closest('[data-no-dirty]')) continue; // вибір рейсів, фільтри періоду
        parts.push((type === 'checkbox' || type === 'radio') ? (el.checked ? '1' : '0') : String(el.value === undefined ? '' : el.value));
    }
    return parts.join('');
}

// Початковий розмір і зсув каскадом (n — номер вікна).
export function initialRect(bounds, n) {
    const availW = bounds.right - bounds.left;
    const availH = bounds.bottom - bounds.top;
    const w = Math.max(320, Math.min(940, availW - 48));
    const h = Math.max(260, Math.min(Math.round(availH * 0.86), availH - 24));
    const step = (n % 6) * 28;
    const pos = clampPos(bounds.left + 24 + step, bounds.top + 12 + step, w, h, bounds);
    return { x: pos.x, y: pos.y, w, h };
}

// Короткий підпис для панелі задач: «№ 7» з заголовка «Рахунок № 7 від …», інакше початок заголовка.
export function shortLabel(title) {
    const t = String(title || '').trim();
    const m = /^(.*?)\s*№\s*(\S+)/.exec(t);
    if (m) return (m[1] ? m[1] + ' ' : '') + '№ ' + m[2];
    return t.length > 24 ? t.slice(0, 23) + '…' : t;
}

// Заголовок із першого h1 / h2 вмісту: «Рахунок № 7 від 12.11.2026 …» → «Рахунок № 7».
export function cleanTitle(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const cut = t.split(' від ')[0].trim();
    return (cut.length > 60 ? cut.slice(0, 59) + '…' : cut);
}

// Який значок показувати: за типом вікна, для документів — за словом у заголовку.
export function iconFor(type, title) {
    if (type === 'doc') return /^Акт/i.test(String(title || '')) ? 'acts' : 'invoices';
    return { ttn: 'ttn', trip_sheet: 'trip_sheets', form: 'contracts', client: 'clients', client_form: 'clients', request: 'registry', vehicle: 'fleet', trailer: 'fleet', driver: 'drivers' }[type] || 'contracts';
}

// Back: яке з відкритих через hash вікон закривається, коли hash став H. Вікно закривається, якщо воно відкрите з hash, який ми щойно залишили
// (prev), а H — hash, що був до нього (prevHash). Шукаємо найвище таке вікно.
export function backTarget(stack, prev, hash) {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
        const w = stack[i];
        if (w.viaHash && w.hash === prev && w.prevHash === hash && w.hash !== hash) return w;
    }
    return null;
}
