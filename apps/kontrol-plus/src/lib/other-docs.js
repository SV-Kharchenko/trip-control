// «Документи» → «Інше»: чисті функції форми й завантаження (перевірки дублюють правила бакета kp-other-docs і RPC kp_other_save).
export const OTHER_BUCKET = 'kp-other-docs';
export const MAX_OTHER_BYTES = 10 * 1024 * 1024;
export const OTHER_URL_SECONDS = 600;
export const OTHER_CATEGORIES = [
    ['power_of_attorney', 'Довіреність'],
    ['insurance', 'Страховка'],
    ['other', 'Інше'],
];
export const OTHER_CATEGORY_LABELS = Object.fromEntries(OTHER_CATEGORIES);
export const OTHER_TYPES = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const OTHER_ACCEPT = Object.keys(OTHER_TYPES).map((e) => '.' + e).join(',');

export function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
}

// → текст помилки або null.
export function otherFileProblem(file) {
    if (!file || !file.name) return 'Оберіть файл.';
    if (!OTHER_TYPES[extOf(file.name)]) return 'Підходять PDF, JPG, PNG, Word або Excel.';
    if (!(file.size > 0)) return 'Файл порожній.';
    if (file.size > MAX_OTHER_BYTES) return 'Файл більший за 10 МБ.';
    return null;
}

export function otherContentType(file) {
    return OTHER_TYPES[extOf(file.name)] || 'application/octet-stream';
}

// <org>/<документ>/file-<uuid>.<ext> — рівно те, що приймають політики storage і kp_other_save.
export function otherPath(orgId, docId, ext, uuid) {
    return orgId + '/' + docId + '/file-' + uuid + '.' + (ext === 'jpeg' ? 'jpg' : ext);
}

export function otherErrorText(error) {
    const text = String((error && (error.message || error.error)) || error || '');
    if (/OTHER_FILE_TOO_BIG/.test(text)) return 'Файл більший за 10 МБ.';
    if (/OTHER_FILE_MISSING/.test(text)) return 'Файл не завантажився. Спробуйте ще раз.';
    if (/OTHER_FILE_BAD/.test(text)) return 'Недопустимий файл.';
    if (/OTHER_LINK_NOT_FOUND/.test(text)) return 'Клієнта, авто, водія чи заявку не знайдено.';
    if (/OTHER_CANCELLED/.test(text)) return 'Документ анульовано.';
    if (/OTHER_REASON/.test(text)) return 'Вкажіть причину анулювання (до 500 символів).';
    if (/OTHER_FILE_STILL_THERE/.test(text)) return 'Не вдалося видалити файл зі сховища. Спробуйте ще раз.';
    if (/OTHER_NOT_FOUND/.test(text)) return 'Документ не знайдено.';
    if (/OTHER_BAD|check constraint|invalid input/i.test(text)) return 'Перевірте назву, дату й строк дії.';
    if (/KP_FORBIDDEN|row-level security|42501/.test(text)) return 'Немає права на цю дію.';
    return text || 'Не вдалося виконати дію.';
}

export function contractCancelErrorText(error) {
    const text = String((error && (error.message || error.error)) || error || '');
    if (/CONTRACT_REASON/.test(text)) return 'Вкажіть причину анулювання (до 500 символів).';
    if (/CONTRACT_ALREADY_CANCELLED/.test(text)) return 'Договір уже анульовано.';
    if (/CONTRACT_NOT_FOUND/.test(text)) return 'Договір не знайдено.';
    if (/KP_FORBIDDEN|42501/.test(text)) return 'Анулювати договір може лише директор.';
    return text || 'Не вдалося анулювати договір.';
}
