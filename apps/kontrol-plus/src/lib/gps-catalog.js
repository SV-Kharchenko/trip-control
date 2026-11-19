// Каталог GPS для екрана карти: юніти (з типом і номером авто), групи та їх склад; вибір карти в localStorage.
// Дані — через RLS (gps_units(), gps_vehicles, gps_groups, gps_group_members): читають усі учасники організації.
// Чисті функції (пошук, нормалізація вибору, тіло запиту) тестуються без DOM.
import { KINDS, KIND_LABELS } from '../../lib/gps/kind.js';

export const SELECTION_KEY = 'kp.gps.selection.v1';
export const KIND_OPTIONS = [...KINDS.map((value) => ({ value, label: KIND_LABELS[value] })), { value: 'none', label: 'Не визначено' }];
const PAGE = 1000;
const MAX_IDS = 300;

export function emptySelection() {
    return { all: false, groupIds: [], unitIds: [], kinds: [] };
}

function storage() {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

const keyFor = (orgId, base = SELECTION_KEY) => base + ':' + String(orgId || '');

export function loadSelection(orgId, store = storage()) {
    try {
        const raw = store && store.getItem(keyFor(orgId));
        const v = raw ? JSON.parse(raw) : null;
        if (!v || typeof v !== 'object') return emptySelection();
        const list = (x) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string').slice(0, MAX_IDS) : []);
        return {
            all: v.all === true,
            groupIds: list(v.groupIds),
            unitIds: list(v.unitIds),
            kinds: list(v.kinds).filter((k) => KIND_OPTIONS.some((o) => o.value === k)),
        };
    } catch {
        return emptySelection();
    }
}

export function saveSelection(orgId, selection, store = storage()) {
    try {
        if (store) store.setItem(keyFor(orgId), JSON.stringify(selection));
    } catch {
        // Сховище недоступне (приватний режим) — вибір живе до перезавантаження.
    }
}

// Прибирає з вибору групи й юніти, яких уже нема в каталозі (видалена група, неактивний юніт).
export function pruneSelection(selection, catalog) {
    const groups = new Set((catalog.groups || []).map((g) => g.id));
    const units = new Set((catalog.units || []).map((u) => u.id));
    return {
        all: selection.all === true,
        groupIds: selection.groupIds.filter((id) => groups.has(id)),
        unitIds: selection.unitIds.filter((id) => units.has(id)),
        kinds: selection.kinds.slice(),
    };
}

// Тіло POST /api/gps/positions. Порожній вибір — без полів вибору (сервер покаже привʼязані авто).
export function selectionBody(selection, refresh) {
    const body = { refresh: Boolean(refresh) };
    if (selection.all) body.all = true;
    else {
        if (selection.groupIds.length) body.group_ids = selection.groupIds.slice(0, MAX_IDS);
        if (selection.unitIds.length) body.unit_ids = selection.unitIds.slice(0, MAX_IDS);
    }
    if (selection.kinds.length) body.kinds = selection.kinds.slice();
    return body;
}

// Ключ для пошуку: без регістру, пробілів, «_», «.», «-» і з латинськими двійниками кириличних літер (А/A, В/B, Е/E, І/I, К/K, М/M, Н/H, О/O, Р/P, С/C, Т/T, Х/X).
const TWINS = { 'а': 'a', 'в': 'b', 'е': 'e', 'і': 'i', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'х': 'x' };
export function normKey(s) {
    return String(s || '').toLowerCase().replace(/[\s_.\-–—]+/g, '').replace(/[авеікмнорстх]/g, (ch) => TWINS[ch]);
}
const plateKey = normKey;

// Пошук юнітів за назвою з Wialon і номером авто з Автопарку (без урахування регістру й роздільників).
export function searchUnits(units, query, limit = 30) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const qk = plateKey(q);
    const out = [];
    for (const u of units) {
        if (!u.active) continue;
        const name = String(u.name || '').toLowerCase();
        if (name.includes(q) || (qk && (plateKey(u.name).includes(qk) || plateKey(u.vehicle_label).includes(qk)))) {
            out.push(u);
            if (out.length >= limit) break;
        }
    }
    return out;
}

// --- Фільтри таблиці «Юніти й авто» (окремо від вибору на карті) ---
export const TABLE_FILTER_KEY = 'kp.gps.table.v1';
export const LINK_OPTIONS = [{ value: 'all', label: 'Усі' }, { value: 'linked', label: 'Прив’язані' }, { value: 'unlinked', label: 'Неприв’язані' }];
export const TABLE_PAGE = 200;

export function emptyTableFilters() {
    return { groupIds: [], kinds: [], q: '', link: 'all' };
}

export function tableFiltersActive(f) {
    return f.groupIds.length > 0 || f.kinds.length > 0 || normKey(f.q) !== '' || f.link !== 'all';
}

export function loadTableFilters(orgId, store = storage()) {
    try {
        const raw = store && store.getItem(keyFor(orgId, TABLE_FILTER_KEY));
        const v = raw ? JSON.parse(raw) : null;
        if (!v || typeof v !== 'object') return emptyTableFilters();
        const list = (x) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string').slice(0, MAX_IDS) : []);
        return {
            groupIds: list(v.groupIds),
            kinds: list(v.kinds).filter((k) => KIND_OPTIONS.some((o) => o.value === k)),
            q: typeof v.q === 'string' ? v.q.slice(0, 60) : '',
            link: LINK_OPTIONS.some((o) => o.value === v.link) ? v.link : 'all',
        };
    } catch {
        return emptyTableFilters();
    }
}

export function saveTableFilters(orgId, filters, store = storage()) {
    try {
        if (store) store.setItem(keyFor(orgId, TABLE_FILTER_KEY), JSON.stringify(filters));
    } catch {
        // Сховище недоступне — фільтри живуть до перезавантаження.
    }
}

// Групи, яких уже немає в каталозі (видалена, змінена синхронізацією), з фільтра таблиці прибираємо.
export function pruneTableFilters(filters, catalog) {
    const groups = new Set((catalog.groups || []).map((g) => g.id));
    return { ...filters, groupIds: filters.groupIds.filter((id) => groups.has(id)), kinds: filters.kinds.slice() };
}

// Фільтр по вже завантажених юнітах. memberships — { unitId: [groupId, …] } з каталогу. Тип «none» = «Не визначено».
export function filterUnitRows(units, filters, memberships = {}) {
    const q = normKey(filters.q);
    const groups = new Set(filters.groupIds);
    const kinds = new Set(filters.kinds);
    return units.filter((u) => {
        if (groups.size && !(memberships[u.id] || []).some((id) => groups.has(id))) return false;
        if (kinds.size && !kinds.has(u.kind || 'none')) return false;
        if (filters.link === 'linked' && !u.vehicle_id) return false;
        if (filters.link === 'unlinked' && u.vehicle_id) return false;
        if (q && !normKey(u.name).includes(q) && !normKey(u.vehicle_label).includes(q)) return false;
        return true;
    });
}

export function unitTitle(u) {
    return (u.vehicle_label ? u.vehicle_label + ' · ' : '') + (u.name || '—');
}

async function fetchAll(build) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) return { data: null, error };
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return { data: rows, error: null };
    }
}

// → { units, groups, error }. groups[i].count — число активних юнітів у групі.
export async function fetchCatalog(supabase) {
    const [units, kinds, groups, members] = await Promise.all([
        supabase.rpc('gps_units'),
        fetchAll(() => supabase.from('gps_vehicles').select('id, kind, kind_manual').order('id', { ascending: true })),
        fetchAll(() => supabase.from('gps_groups').select('id, name, source').order('name', { ascending: true })),
        fetchAll(() => supabase.from('gps_group_members').select('group_id, gps_vehicle_id').order('group_id', { ascending: true }).order('gps_vehicle_id', { ascending: true })),
    ]);
    const error = units.error || kinds.error || groups.error || members.error;
    if (error) return { units: [], groups: [], memberships: {}, error };
    const kindOf = new Map(kinds.data.map((k) => [k.id, k]));
    const unitList = (units.data || []).map((u) => ({
        id: u.id, name: u.name, vehicle_id: u.vehicle_id, vehicle_label: u.vehicle_label, active: u.active,
        kind: (kindOf.get(u.id) || {}).kind || null, kind_manual: Boolean((kindOf.get(u.id) || {}).kind_manual),
    }));
    const active = new Set(unitList.filter((u) => u.active).map((u) => u.id));
    const counts = new Map();
    const memberships = {};
    for (const m of members.data) {
        (memberships[m.gps_vehicle_id] = memberships[m.gps_vehicle_id] || []).push(m.group_id);
        if (active.has(m.gps_vehicle_id)) counts.set(m.group_id, (counts.get(m.group_id) || 0) + 1);
    }
    return { units: unitList, groups: groups.data.map((g) => ({ id: g.id, name: g.name, source: g.source, count: counts.get(g.id) || 0 })), memberships, error: null };
}
