// Документи «на основі заявки»: адреса форми, попередження про повтор, маршрут із варіантом директора, фільтри вкладок.
import { DOC_KIND_LABELS } from './docs.js';

export const REQUEST_DOC_KINDS = ['ttn', 'act', 'invoice', 'trip_sheet'];

// Адреса форми створення документа з заявки. Рахунок / акт потребують клієнта заявки, ТТН і подорожній лист беруть його з заявки самі.
export function requestDocHash(kind, calcId, clientId = null) {
    if (!REQUEST_DOC_KINDS.includes(kind) || !calcId) return null;
    if (kind === 'invoice' || kind === 'act') return clientId ? '#/docs/new/' + kind + '/' + clientId + '/' + calcId : '#/docs/new/' + kind + '/calc/' + calcId;
    return '#/docs/new/' + kind + '/calc/' + calcId;
}

const KIND_NOUN = { ttn: 'ТТН', act: 'акт', invoice: 'рахунок', trip_sheet: 'подорожній лист' };

// Документи заявки (kp_calc_documents) одного виду, не анульовані: текст попередження «вже є акт № …, створити ще?» або ''.
export function duplicateWarning(kind, docs) {
    const same = (docs || []).filter((d) => d.kind === kind && d.status !== 'cancelled');
    if (!same.length) return '';
    const list = same.map((d) => '№ ' + d.number_text).join(', ');
    return 'Вже є ' + KIND_NOUN[kind] + ' ' + list + '. Створити ще один?';
}

// Маршрут для підстановки: якщо директор вибрав варіант при погодженні — його км і подача, а не варіант логіста.
// Сервер перераховує inputs.dist під вибір директора; тут це лише страховка, якщо в approved_variant км інші.
export function withApprovedVariant(pre) {
    if (!pre || !pre.route || !pre.route.approved_variant) return pre;
    const v = pre.route.approved_variant;
    const km = Number(v.km);
    if (!Number.isFinite(km) || km <= 0) return pre;
    const route = { ...pre.route, dist_km: Math.round(km), variant_source: 'director' };
    const feed = Number(v.podachaKm);
    if (v.podachaKm !== undefined && v.podachaKm !== null && Number.isFinite(feed) && feed >= 0) route.feed_km = Math.round(feed);
    return { ...pre, route };
}

// Рядок вибору заявки: «20.10 · Прийнята заявка · Луцьк — Одеса · Клієнт».
export function requestOptionLabel(r, fmtDate) {
    const route = [r.route_from, r.route_to].filter(Boolean).join(' — ');
    return [r.trip_date ? fmtDate(r.trip_date) : null, r.name || null, route || null, r.client_name || null].filter(Boolean).join(' · ') || 'Заявка';
}

// Вкладки розділу «Документи»: ключ → вид документа у списку та кнопка створення.
export const TAB_DOC_KIND = { ttn: 'ttn', acts: 'act', invoices: 'invoice', trip_sheets: 'trip_sheet' };

// Фільтри вкладки (клієнтські): номер (частина номера з префіксом) і авто / водій (для ТТН та подорожніх листів).
export function filterRows(rows, { number = '', vehicle = '' } = {}) {
    const n = String(number || '').trim().toLowerCase();
    const v = String(vehicle || '').trim().toLowerCase();
    return (rows || []).filter((r) => {
        if (n && !String(r.number_text || (r.prefix || '') + (r.number || '')).toLowerCase().includes(n)) return false;
        if (v && !(String(r.vehicle_reg || '') + ' ' + String(r.driver_name || '')).toLowerCase().includes(v)) return false;
        return true;
    });
}

export const docKindNoun = (kind) => KIND_NOUN[kind] || DOC_KIND_LABELS[kind] || kind;
