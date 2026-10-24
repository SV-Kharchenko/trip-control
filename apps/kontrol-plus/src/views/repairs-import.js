// Імпорт початкових залишків з CSV: «Файл → Перевірка (помилкові рядки червоним, фільтр «лише помилки») → Імпортувати».
// Лише CSV UTF-8 (Excel → Зберегти як → CSV UTF-8); .xlsx не розбираємо. Перевірку й запис робить kp_parts_import.
import { h, clear, spinner, notice } from '../ui.js';
import { fmtMoneyCents, fmtNumber } from '../lib/format.js';
import { buildImportRows, CSV_MAX_BYTES, CsvError } from '../lib/csv.js';
import { repairErrorText, importStatusLabel } from '../lib/repairs.js';

export function importCanCommit(result) {
    return Boolean(result && result.summary && result.summary.errors === 0 && result.summary.total > 0);
}

export function renderImport(app, { onDone } = {}) {
    const state = { rows: [], result: null };
    const file = h('input', { id: 'kpr-i-file', type: 'file', accept: '.csv,text/csv' });
    const onlyErrors = h('input', { id: 'kpr-i-errors', type: 'checkbox' });
    const preview = h('div', { 'aria-live': 'polite' });
    const commit = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, 'Імпортувати');

    function draw() {
        const result = state.result;
        if (!result) return;
        const byLine = new Map((result.rows || []).map((r) => [r.line, r]));
        const rows = state.rows.filter((r) => !onlyErrors.checked || (byLine.get(r.line) || {}).status === 'error');
        commit.disabled = !importCanCommit(result);
        const s = result.summary;
        clear(preview,
            h('p', { class: s.errors ? 'notice notice-error' : 'notice notice-info' },
                'Рядків: ' + s.total + ' · нових запчастин: ' + s.new_parts + ' · приходів до наявних: ' + s.receipts_existing + ' · помилок: ' + s.errors
                + (s.errors ? '. Виправте файл і завантажте ще раз — імпорт можливий лише без помилок.' : '.')),
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Рядок', 'Назва', 'Артикул', 'Кількість', 'Ціна', 'Результат'].map((t) => h('th', null, t)))),
                h('tbody', null, rows.map((r) => {
                    const check = byLine.get(r.line) || { status: 'error', errors: [] };
                    return h('tr', { class: check.status === 'error' ? 'kpr-error-row' : '' },
                        h('td', { 'data-label': 'Рядок', class: 'mono' }, String(r.line)),
                        h('td', { 'data-label': 'Назва' }, r.name || '—'),
                        h('td', { 'data-label': 'Артикул', class: 'mono' }, r.article || '—'),
                        h('td', { 'data-label': 'Кількість', class: 'mono' }, /^\d/.test(r.qty) ? fmtNumber(r.qty) + (r.unit ? ' ' + r.unit : '') : r.qty || '—'),
                        h('td', { 'data-label': 'Ціна', class: 'mono' }, /^\d/.test(r.unit_price) ? fmtMoneyCents(r.unit_price) : r.unit_price || '—'),
                        h('td', { 'data-label': 'Результат' }, importStatusLabel(check.status),
                            (check.errors || []).length ? h('div', { class: 'hint hint-error' }, check.errors.join('; ')) : null));
                })))));
    }

    file.addEventListener('change', async () => {
        state.result = null;
        commit.disabled = true;
        const f = file.files && file.files[0];
        if (!f) return;
        if (f.size > CSV_MAX_BYTES) {
            clear(preview, notice('Файл більший за 1 МБ.'));
            return;
        }
        if (/\.xlsx?$/i.test(f.name)) {
            clear(preview, notice('Потрібен CSV: в Excel — «Файл → Зберегти як → CSV UTF-8 (розділювач-кома)».'));
            return;
        }
        clear(preview, spinner('Перевіряємо файл…'));
        try {
            state.rows = buildImportRows(await f.text()).rows;
        } catch (error) {
            clear(preview, notice(error instanceof CsvError ? error.message : 'Не вдалося прочитати файл.'));
            return;
        }
        const { data, error } = await app.supabase.rpc('kp_parts_import', { p_rows: state.rows, p_commit: false });
        if (error) {
            clear(preview, notice(repairErrorText(error)));
            return;
        }
        state.result = data;
        draw();
    });
    onlyErrors.addEventListener('change', draw);
    commit.addEventListener('click', async () => {
        if (!importCanCommit(state.result)) return;
        commit.disabled = true;
        const { error } = await app.supabase.rpc('kp_parts_import', { p_rows: state.rows, p_commit: true });
        if (error) {
            commit.disabled = false;
            clear(preview, notice(repairErrorText(error)));
            return;
        }
        if (onDone) onDone();
    });

    return h('div', { class: 'card kpr-import' },
        h('h3', null, 'Імпорт початкових залишків (CSV)'),
        h('p', { class: 'muted small' }, 'Excel → «Файл → Зберегти як → CSV UTF-8». Колонки: Назва, Артикул, Одиниця, Кількість, Ціна за одиницю, Дата, Постачальник, Примітка '
            + '(порядок — будь-який; обовʼязкові — Назва, Кількість, Ціна). До 2000 рядків і 1 МБ. Наявний артикул — прихід до наявної запчастини.'),
        h('div', { class: 'toolbar' }, h('label', { for: 'kpr-i-file', class: 'kpr-label' }, 'Файл CSV'), file,
            h('label', { class: 'check', for: 'kpr-i-errors' }, onlyErrors, ' Лише помилки'), commit),
        preview);
}
