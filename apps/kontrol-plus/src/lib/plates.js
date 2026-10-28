// Держномер для фільтра «Автопарк»: без пробілів і дефісів, верхній регістр, схожа кирилиця -> латиниця (А В С Е І К М Н О Р Т Х).
const CYR_TO_LAT = { 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'І': 'I', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X' };

export function normPlate(value) {
    return String(value === null || value === undefined ? '' : value)
        .toUpperCase()
        .replace(/[\s\-‐-―]+/g, '')
        .replace(/[АВСЕІКМНОРТХ]/g, (ch) => CYR_TO_LAT[ch]);
}

// Збіг за підрядком; порожній запит показує все.
export function plateMatches(plate, query) {
    const q = normPlate(query);
    return !q || normPlate(plate).includes(q);
}
