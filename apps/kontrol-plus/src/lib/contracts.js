// Договори контрагента: чисті функції для форми й завантаження (перевірки дублюють правила бази / бакета kp-contracts).
import { fmtDate } from './format.js';

export const CONTRACT_BUCKET = 'kp-contracts';
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;
export const MAX_SIG_BYTES = 1024 * 1024;
export const SIGNED_URL_SECONDS = 600;
export const CONTRACT_STATUS = { draft: 'чернетка', signed: 'підписано', sent: 'надіслано' };
const SCAN_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
}

// Скан: PDF / JPG / PNG до 10 МБ. → текст помилки або null.
export function scanProblem(file) {
    if (!file || !file.name) return 'Оберіть файл.';
    const ext = extOf(file.name);
    if (!SCAN_TYPES[ext]) return 'Підходять лише PDF, JPG або PNG.';
    if (!(file.size > 0)) return 'Файл порожній.';
    if (file.size > MAX_SCAN_BYTES) return 'Файл більший за 10 МБ.';
    return null;
}

export function sigProblem(file) {
    if (!file || !file.name) return 'Оберіть файл підпису.';
    if (extOf(file.name) !== 'p7s') return 'Потрібен файл відокремленого підпису з розширенням .p7s.';
    if (!(file.size > 0) || file.size > MAX_SIG_BYTES) return 'Файл підпису порожній або завеликий.';
    return null;
}

export function scanContentType(file) {
    return SCAN_TYPES[extOf(file.name)] || 'application/octet-stream';
}

// <org>/<contract>/<scan|sig>-<uuid>.<ext> — рівно те, що приймають політики storage і RPC.
export function contractPath(orgId, contractId, kind, ext, uuid) {
    return orgId + '/' + contractId + '/' + kind + '-' + uuid + '.' + (ext === 'jpeg' ? 'jpg' : ext);
}

export function contractLabel(c) {
    return 'Договір № ' + c.number + ' від ' + fmtDate(c.contract_date);
}

export function attachmentNames(c) {
    const out = [];
    const main = c.signed_path || c.file_path;
    if (main) out.push('dogovir_' + String(c.number || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) + '.' + extOf(main));
    if (c.sig_path && c.file_path) out.push('dogovir_' + String(c.number || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) + '.' + extOf(c.file_path) + '.p7s');
    return out;
}

export function contractErrorText(error) {
    const text = String((error && (error.message || error.error)) || error || '');
    if (/MEMBER_PERMISSION_DENIED/.test(text)) return 'Немає права на цю дію (потрібні «Договори» або «Підпис і печатка»). Зверніться до директора.';
    if (/CONTRACT_LOCKED/.test(text)) return 'Договір уже підписано — змінити його не можна.';
    if (/CONTRACT_FILE_MISSING/.test(text)) return 'Спершу завантажте скан договору.';
    if (/CONTRACT_FILE_TOO_BIG/.test(text)) return 'Файл більший за 10 МБ.';
    if (/CONTRACT_BAD|check constraint|invalid input/i.test(text)) return 'Перевірте номер, дату й строк договору.';
    if (/CLIENT_NOT_FOUND|CONTRACT_NOT_FOUND/.test(text)) return 'Договір або контрагента не знайдено.';
    if (/row-level security|42501/.test(text)) return 'Немає доступу до файлу (потрібне право «Договори»).';
    return text || 'Не вдалося виконати дію.';
}
