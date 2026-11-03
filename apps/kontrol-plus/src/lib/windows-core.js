// Чисті функції менеджера вікон Контроль+ (PR 3 з 5): екранування, ключ і формат збереженого стану, межі, ліміт. Без DOM — їх перевіряють тести.

export const MAX_WINDOWS = 8;
export const MIN_WIDE = 900; // вужче — вікон і панелі задач немає, документ відкривається на всю сторінку
export const STORAGE_PREFIX = 'tc_kp_windows';
export const TASKBAR_H = 32;

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

// У сховищі лише тип, id і «згорнуте» (без позицій і вмісту), у порядку відкриття.
export function serializeWindows(list) {
    return JSON.stringify((list || []).map((w) => ({ type: w.type, id: w.id, minimized: !!w.minimized })));
}
const TYPES = ['doc', 'ttn', 'trip_sheet', 'form', 'client', 'client_form', 'request'];
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
        out.push({ type: item.type, id: item.id, minimized: item.minimized === true });
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
    return { ttn: 'ttn', trip_sheet: 'trip_sheets', form: 'contracts', client: 'clients', client_form: 'clients', request: 'registry' }[type] || 'contracts';
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
