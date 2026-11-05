// «Власний парк → Телематика → Імпорт»: файл звіту (.xlsx / .csv) розбирається в браузері й нікуди не надсилається;
// на сервер (RPC tm_import_*) йдуть лише розпізнані рядки. Попередній перегляд, мапінг колонок, шаблон мапінгу, звіт про імпорт.
import { h, clear, notice, toast } from '../../ui.js';
import { CsvError, parseCsv } from '../../lib/csv.js';
import { FIELDS, IMPORT_KINDS, MAX_IMPORT_ROWS, applyTemplate, buildFuelRows, buildReportRows, chunkByRef, missingRequired, partialImportText } from '../../lib/telematics/import.js';
import { XlsxError, decodeCsvBytes, readXlsx } from '../../lib/telematics/xlsx-read.js';
import { telematicsErrorText } from '../../lib/telematics/summary.js';

const NONE = '';
const PREVIEW_ROWS = 5;
const SHOWN_ERRORS = 50;

// Файл → { records } (перший запис — заголовки). Кидає CsvError / XlsxError з текстом для людини.
export async function readReportFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.xlsx$/i.test(file.name)) return readXlsx(bytes, { maxRows: MAX_IMPORT_ROWS });
    if (/\.csv$/i.test(file.name) || file.type === 'text/csv') return parseCsv(decodeCsvBytes(bytes), { maxBytes: 5 * 1024 * 1024, maxRows: MAX_IMPORT_ROWS });
    throw new CsvError('BAD_TYPE', 'Підтримуються файли .xlsx і .csv.');
}

export function renderTelematicsImport(app, ctx) {
    // ctx: { sources, templates, ensureSource(kind), onImported() }
    const root = h('div', { class: 'kpt-import' });
    const state = { kind: 'reports', file: null, records: null, mapping: {}, idleUnit: 'min', defaultKind: 'drain', result: null, busy: false };
    const live = h('div', { 'aria-live': 'polite' });

    const kindSel = h('select', { id: 'kpt-kind', 'aria-label': 'Тип файлу', onchange: (e) => { state.kind = e.target.value; state.result = null; if (state.records) remap(); paint(); } },
        Object.entries(IMPORT_KINDS).map(([k, label]) => h('option', { value: k, selected: k === state.kind }, label)));
    const fileInput = h('input', { type: 'file', id: 'kpt-file', accept: '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'aria-label': 'Файл звіту',
        onchange: onFile });
    const body = h('div', { class: 'kpt-import-body' });

    function headers() { return state.records ? state.records.records[0].cells.map((c) => String(c ?? '').trim()) : []; }
    function template() { return (ctx.templates.find((t) => t.kind === state.kind) || {}).mapping || null; }
    function remap() { state.mapping = applyTemplate(state.kind, template(), headers()); }

    async function onFile() {
        const file = fileInput.files && fileInput.files[0];
        state.result = null;
        clear(live);
        if (!file) { state.records = null; paint(); return; }
        try {
            const parsed = await readReportFile(file);
            if (!parsed.records.length) throw new CsvError('EMPTY', 'У файлі немає даних.');
            state.file = file.name;
            state.records = parsed;
            remap();
        } catch (e) {
            state.records = null;
            clear(live, notice(e instanceof CsvError || e instanceof XlsxError ? e.message : 'Не вдалося прочитати файл.'));
        }
        paint();
    }

    function build() {
        const opts = state.kind === 'reports' ? { idleUnit: state.idleUnit } : { defaultKind: state.defaultKind };
        return (state.kind === 'reports' ? buildReportRows : buildFuelRows)(state.records.records, state.mapping, opts);
    }

    function mappingBlock() {
        const hs = headers();
        return h('div', { class: 'kpt-map', role: 'group', 'aria-label': 'Відповідність колонок' }, FIELDS[state.kind].map((f) => {
            const id = 'kpt-map-' + f.key;
            const sel = h('select', { id, onchange: (e) => { state.mapping = { ...state.mapping, [f.key]: e.target.value }; if (!e.target.value) delete state.mapping[f.key]; state.result = null; paint(); } },
                h('option', { value: NONE }, '— не використовувати —'),
                hs.map((name, i) => name ? h('option', { value: name, selected: state.mapping[f.key] === name }, name || 'Колонка ' + (i + 1)) : null));
            return h('div', { class: 'kpt-map-row' }, h('label', { for: id }, f.label + (f.required ? ' *' : '')), sel);
        }));
    }

    function previewBlock() {
        const hs = headers();
        const rows = state.records.records.slice(1, 1 + PREVIEW_ROWS);
        return h('div', { class: 'table-wrap kpt-preview' }, h('table', { class: 'table kpof-table', 'aria-label': 'Попередній перегляд файлу' },
            h('thead', null, h('tr', null, hs.map((name, i) => h('th', null, name || 'Колонка ' + (i + 1))))),
            h('tbody', null, rows.map((r) => h('tr', null, hs.map((name, i) => h('td', { 'data-label': name || 'Колонка ' + (i + 1) }, String(r.cells[i] ?? ''))))))));
    }

    async function saveTemplate() {
        const { error } = await app.supabase.rpc('tm_save_template', { p_kind: state.kind, p_mapping: state.mapping });
        if (error) { toast(telematicsErrorText(error), 'error'); return; }
        const kept = ctx.templates.filter((t) => t.kind !== state.kind);
        ctx.templates.splice(0, ctx.templates.length, ...kept, { kind: state.kind, mapping: { ...state.mapping } });
        toast('Шаблон мапінгу збережено');
    }

    async function runImport() {
        const missing = missingRequired(state.kind, state.mapping);
        if (missing.length) { clear(live, notice('Вкажіть колонки: ' + missing.join(', ') + '.')); return; }
        const built = build();
        if (!built.rows.length) { clear(live, notice(built.errors.length ? 'Жодного рядка не можна імпортувати — виправте файл.' : 'У файлі немає рядків з даними.')); state.result = { ...built, server: null }; paint(); return; }
        state.busy = true;
        paint();
        const sourceId = await ctx.ensureSource('file_import');
        let server = null;
        if (sourceId) {
            // Пачками: рядки одного авто лишаються разом. Якщо пачка впала посередині — кажемо, скільки вже імпортовано (повтор безпечний: upsert).
            const total = built.rows.length;
            const rpcName = state.kind === 'reports' ? 'tm_import_reports' : 'tm_import_fuel_events';
            const sum = { added: 0, updated: 0, skipped: 0, unmapped: 0 };
            let done = 0;
            let failed = null;
            for (const chunk of chunkByRef(built.rows)) {
                const { data, error } = await app.supabase.rpc(rpcName, { p_source: sourceId, p_rows: chunk });
                if (error) { failed = error; break; }
                for (const k of Object.keys(sum)) sum[k] += Number(data[k] || 0);
                done += chunk.length;
            }
            if (failed) clear(live, notice(partialImportText(done, total) + ' ' + telematicsErrorText(failed)));
            else clear(live);
            if (!failed || done > 0) { server = sum; ctx.onImported(); }
        }
        state.busy = false;
        if (server) state.result = { ...built, server };
        paint();
    }

    function resultBlock() {
        const r = state.result;
        if (!r) return null;
        const added = r.server ? r.server.added : 0;
        const updated = r.server ? r.server.updated : 0;
        const skipped = r.errors.length + r.empty + (r.server ? r.server.skipped : 0);
        const unmapped = r.server ? r.server.unmapped : 0;
        const stat = (label, n, cls) => h('span', { class: 'kpof-stat on ' + cls, 'data-stat': label }, h('b', null, String(n)), ' ' + label);
        return h('div', { class: 'kpt-result', role: 'status' },
            h('h3', { class: 'kpof-sub-h' }, 'Звіт по імпорту'),
            h('div', { class: 'kpof-stats' }, stat('додано', added, ''), stat('оновлено', updated, ''), stat('пропущено', skipped, skipped ? 'kpof-stat-late' : ''), stat('незмеплено', unmapped, unmapped ? 'kpof-stat-late' : '')),
            unmapped ? h('p', { class: 'muted small' }, 'Незмепленим авто зіставте техніку у вкладці «Зіставлення».') : null,
            r.errors.length ? h('div', { class: 'kpt-errors' },
                h('h3', { class: 'kpof-sub-h' }, 'Помилки в рядках (' + r.errors.length + ')'),
                h('ul', { class: 'kpt-error-list' }, r.errors.slice(0, SHOWN_ERRORS).map((e) => h('li', null, h('b', null, 'Рядок ' + e.line + ': '), e.message)),
                    r.errors.length > SHOWN_ERRORS ? h('li', { class: 'muted' }, '…і ще ' + (r.errors.length - SHOWN_ERRORS)) : null)) : null);
    }

    function paint() {
        if (!state.records) {
            clear(body, h('p', { class: 'muted' }, 'Оберіть файл звіту з Агроконтролю (.xlsx або .csv, до 5000 рядків). Файл розбирається у вашому браузері й нікуди не надсилається — на сервер йдуть лише розпізнані рядки.'));
            return;
        }
        const total = state.records.records.length - 1;
        const hasTemplate = Boolean(template());
        clear(body,
            h('p', { class: 'muted small' }, 'Файл «' + state.file + '»: ' + total + ' ' + (total === 1 ? 'рядок' : 'рядків') + (hasTemplate ? ' · застосовано збережений шаблон або підібрано за заголовками' : ' · колонки підібрано за заголовками')),
            previewBlock(),
            h('h3', { class: 'kpof-sub-h' }, 'Відповідність колонок'),
            mappingBlock(),
            state.kind === 'reports'
                ? h('div', { class: 'kpt-opt' }, h('label', { for: 'kpt-idle' }, 'Простій у файлі, якщо це число'),
                    h('select', { id: 'kpt-idle', onchange: (e) => { state.idleUnit = e.target.value; state.result = null; } }, h('option', { value: 'min', selected: state.idleUnit === 'min' }, 'хвилини'), h('option', { value: 'h', selected: state.idleUnit === 'h' }, 'години')))
                : h('div', { class: 'kpt-opt' }, h('label', { for: 'kpt-dk' }, 'Тип події, якщо в рядку не вказано'),
                    h('select', { id: 'kpt-dk', onchange: (e) => { state.defaultKind = e.target.value; state.result = null; } }, h('option', { value: 'drain', selected: state.defaultKind === 'drain' }, 'Злив'), h('option', { value: 'refuel', selected: state.defaultKind === 'refuel' }, 'Заправка'))),
            h('div', { class: 'kpof-actions kpt-import-actions' },
                h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'import', disabled: state.busy, onclick: runImport }, state.busy ? 'Імпорт…' : 'Імпортувати'),
                h('button', { type: 'button', class: 'btn', 'data-act': 'save-template', onclick: saveTemplate }, 'Зберегти шаблон мапінгу')),
            resultBlock());
    }

    paint();
    root.append(
        h('div', { class: 'kpt-import-top' },
            h('div', { class: 'kpt-opt' }, h('label', { for: 'kpt-kind' }, 'Тип файлу'), kindSel),
            h('div', { class: 'kpt-opt' }, h('label', { for: 'kpt-file' }, 'Файл'), fileInput)),
        live, body);
    return root;
}
