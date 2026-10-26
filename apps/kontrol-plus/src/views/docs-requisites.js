// Реквізити компанії (продавець у документах), префікси номерів, валюта й режим ПДВ за замовчуванням, підпис і печатка.
// Змінює лише власник; логіст і директор бачать реквізити для перевірки. Підпис / печатка — приватний бакет kp-doc-assets
// (PNG / JPEG ≤ 512 КБ, шлях <org>/(signature|stamp).(png|jpg)); перегляд — через data: URL (CSP без blob: в img-src).
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { LEGAL_FORMS } from '../lib/validate.js';
import {
    ASSET_BUCKET, CURRENCIES, VAT_MODES, assetPath, assetProblem, docErrorText, sniffImage, validateRequisites,
} from '../lib/docs.js';
import { showError } from './docs.js';

const FIELDS = [
    { section: 'Компанія' },
    { key: 'legal_name', label: 'Повна назва', required: true, maxlength: 300, wide: true, placeholder: 'ТОВ «Ваша компанія» / ФОП Прізвище Імʼя По батькові' },
    { key: 'legal_form', label: 'Форма', type: 'select', options: [{ value: '', label: '—' }, ...LEGAL_FORMS] },
    { key: 'edrpou', label: 'ЄДРПОУ', inputmode: 'numeric', maxlength: 8, mono: true },
    { key: 'ipn', label: 'ІПН / РНОКПП (ФОП)', inputmode: 'numeric', maxlength: 10, mono: true },
    { key: 'vat_payer', label: 'Платник ПДВ (20 %)', type: 'checkbox' },
    { key: 'vat_number', label: 'ІПН платника ПДВ', inputmode: 'numeric', maxlength: 12, mono: true },
    { section: 'Банк і адреса' },
    { key: 'iban', label: 'IBAN', maxlength: 40, mono: true, placeholder: 'UA00 0000 0000 0000 0000 0000 0000 0' },
    { key: 'bank_name', label: 'Банк', maxlength: 300 },
    { key: 'legal_address', label: 'Юридична адреса', type: 'textarea', maxlength: 500, wide: true },
    { key: 'doc_place', label: 'Місце складання актів і ТТН', maxlength: 200, placeholder: 'м. Київ' },
    { section: 'Підписант' },
    { key: 'signer_name', label: 'ПІБ підписанта', maxlength: 200 },
    { key: 'signer_position', label: 'Посада', maxlength: 200, placeholder: 'Директор' },
    { section: 'Нумерація і замовчування' },
    { key: 'invoice_prefix', label: 'Префікс рахунків', maxlength: 10, placeholder: 'напр. РФ-' },
    { key: 'act_prefix', label: 'Префікс актів', maxlength: 10, placeholder: 'напр. АКТ-' },
    { key: 'ttn_prefix', label: 'Префікс ТТН', maxlength: 10, placeholder: 'напр. ТТН-' },
    { key: 'default_currency', label: 'Валюта за замовчуванням', type: 'select', options: CURRENCIES.map((c) => ({ value: c, label: c })) },
    { key: 'default_vat_mode', label: 'Ціни в документах', type: 'select', options: VAT_MODES },
];

const ASSETS = [
    { kind: 'signature', label: 'Підпис', hint: 'Скан підпису на білому або прозорому тлі.' },
    { kind: 'stamp', label: 'Печатка', hint: 'Кругла печатка, краще PNG з прозорим тлом.' },
];

function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

// Збережені поля реквізитів без шляхів до файлів (kp_requisites_save замінює всі передані поля).
export function requisitesPayload(row) {
    const out = {};
    for (const f of FIELDS) if (f.key) out[f.key] = row ? row[f.key] ?? null : null;
    return out;
}

export function renderRequisites(app, access) {
    const box = h('div', null, spinner());

    async function load() {
        const { data, error } = await app.supabase.rpc('kp_requisites_get');
        if (error) return showError(app, box, error);
        const row = (data || [])[0] || null;
        clear(box,
            access.isOwner ? buildForm(row) : readOnly(row),
            h('h2', { class: 'section-title' }, 'Підпис і печатка'),
            h('p', { class: 'muted small' }, 'Вбудовуються лише в PDF вашої сторони і лише якщо завантажені. PNG або JPEG до 512 КБ.'),
            h('div', { class: 'grid-2' }, ASSETS.map((a) => assetCard(a, row))));
    }

    function readOnly(row) {
        if (!row) return notice('Реквізити компанії ще не заповнено. Заповнює власник компанії.', 'info');
        const dd = (label, value, mono) => h('div', { class: 'kv' }, h('dt', null, label), h('dd', { class: mono ? 'mono' : null }, value || '—'));
        return h('div', { class: 'card' }, h('dl', null,
            dd('Повна назва', row.legal_name), dd('ЄДРПОУ', row.edrpou, true), dd('ІПН / РНОКПП', row.ipn, true),
            dd('ПДВ', row.vat_payer ? 'Платник ПДВ' + (row.vat_number ? ', ІПН ' + row.vat_number : '') : 'Не платник'),
            dd('IBAN', row.iban, true), dd('Банк', row.bank_name), dd('Адреса', row.legal_address), dd('Місце складання', row.doc_place),
            dd('Підписант', [row.signer_position, row.signer_name].filter(Boolean).join(' ')),
            dd('Префікси', [row.invoice_prefix && 'рахунки ' + row.invoice_prefix, row.act_prefix && 'акти ' + row.act_prefix, row.ttn_prefix && 'ТТН ' + row.ttn_prefix].filter(Boolean).join(', ')),
            dd('За замовчуванням', row.default_currency + ', ' + ((VAT_MODES.find((m) => m.value === row.default_vat_mode) || {}).label || ''))));
    }

    function buildForm(row) {
        const inputs = {};
        const hints = {};
        const message = h('div', { 'aria-live': 'polite' });
        const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти реквізити');
        const initial = row || { default_currency: 'UAH', default_vat_mode: 'net' };
        const rows = FIELDS.map((f) => {
            if (f.section) return h('h2', { class: 'form-section' }, f.section);
            const id = 'q-' + f.key;
            let input;
            if (f.type === 'select') {
                input = h('select', { id }, f.options.map((o) => h('option', { value: o.value, selected: (initial[f.key] || '') === o.value }, o.label)));
            } else if (f.type === 'textarea') {
                input = h('textarea', { id, rows: 2, maxlength: f.maxlength });
                input.value = initial[f.key] || '';
            } else if (f.type === 'checkbox') {
                input = h('input', { id, type: 'checkbox', checked: Boolean(initial[f.key]) });
            } else {
                input = h('input', { id, type: 'text', maxlength: f.maxlength, inputmode: f.inputmode, placeholder: f.placeholder, autocomplete: 'off',
                    required: f.required, class: f.mono ? 'mono' : null, value: initial[f.key] || '' });
            }
            inputs[f.key] = input;
            hints[f.key] = h('div', { class: 'hint', id: id + '-hint', 'aria-live': 'polite' });
            input.setAttribute('aria-describedby', id + '-hint');
            if (f.type === 'checkbox') return h('div', { class: 'field field-check' }, h('label', { for: id }, input, ' ', f.label), hints[f.key]);
            return h('div', { class: 'field' + (f.wide ? ' kpr-wide' : '') },
                h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), input, hints[f.key]);
        });
        const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        const show = (result) => {
            for (const key of Object.keys(hints)) {
                const text = result.errors[key] || result.warnings[key] || '';
                hints[key].textContent = text;
                hints[key].className = 'hint' + (result.errors[key] ? ' hint-error' : result.warnings[key] ? ' hint-warn' : '');
                inputs[key].toggleAttribute('aria-invalid', Boolean(result.errors[key]));
            }
        };
        const form = h('form', {
            class: 'card form', novalidate: true,
            oninput: () => show(validateRequisites(values())),
            onsubmit: async (event) => {
                event.preventDefault();
                clear(message);
                const result = validateRequisites(values());
                show(result);
                if (Object.keys(result.errors).length) return clear(message, notice('Виправте поля, позначені червоним.'));
                submit.disabled = true;
                const data = result.data;
                const { error } = await app.supabase.rpc('kp_requisites_save', { p_data: data });
                submit.disabled = false;
                if (error) return clear(message, notice(docErrorText(error)));
                toast('Реквізити збережено');
                load();
            },
        }, rows, message, h('div', { class: 'actions' }, submit));
        if (row) show(validateRequisites(values()));
        return form;
    }

    function assetCard(asset, row) {
        const path = row ? row[asset.kind + '_path'] : null;
        const preview = h('div', { class: 'kpd-asset-preview' }, path ? spinner('Завантажуємо…') : h('span', { class: 'muted' }, 'Не завантажено'));
        const status = h('div', { 'aria-live': 'polite' });
        if (path) {
            app.supabase.storage.from(ASSET_BUCKET).download(path).then(async ({ data, error }) => {
                if (error || !data) return clear(preview, h('span', { class: 'muted' }, 'Файл недоступний — завантажте ще раз.'));
                clear(preview, h('img', { src: await readDataUrl(data), alt: asset.label + ' компанії' }));
            }, () => clear(preview, h('span', { class: 'muted' }, 'Файл недоступний.')));
        }
        const file = h('input', { type: 'file', accept: 'image/png,image/jpeg', 'aria-label': 'Файл: ' + asset.label.toLowerCase() });
        file.addEventListener('change', async () => {
            const picked = file.files && file.files[0];
            file.value = '';
            if (!picked) return;
            const head = new Uint8Array(await picked.slice(0, 16).arrayBuffer());
            const problem = assetProblem({ type: picked.type, size: picked.size, bytes: head });
            if (problem) return clear(status, notice(problem));
            const target = assetPath(app.context.org_id, asset.kind, sniffImage(head));
            clear(status, spinner('Завантажуємо файл…'));
            const { error } = await app.supabase.storage.from(ASSET_BUCKET).upload(target, picked, { upsert: true, contentType: picked.type, cacheControl: '0' });
            if (error) return clear(status, notice('Не вдалося завантажити файл: перевірте формат і розмір (PNG / JPEG до 512 КБ).'));
            const { error: saveError } = await app.supabase.rpc('kp_requisites_save', { p_data: { ...requisitesPayload(row), [asset.kind + '_path']: target } });
            if (saveError) return clear(status, notice(docErrorText(saveError)));
            if (path && path !== target) await app.supabase.storage.from(ASSET_BUCKET).remove([path]);
            toast(asset.label + ' збережено');
            load();
        });
        const remove = async () => {
            const { error } = await app.supabase.rpc('kp_requisites_save', { p_data: { ...requisitesPayload(row), [asset.kind + '_path']: null } });
            if (error) return toast(docErrorText(error), 'error');
            await app.supabase.storage.from(ASSET_BUCKET).remove([path]);
            toast(asset.label + ' видалено');
            load();
        };
        return h('div', { class: 'card kpd-asset' },
            h('h3', null, asset.label),
            preview,
            h('p', { class: 'hint' }, asset.hint),
            access.isOwner && row ? h('div', { class: 'actions' },
                h('label', { class: 'btn btn-sm kpd-file' }, file, path ? 'Замінити' : 'Завантажити'),
                path ? confirmButton('Видалити', 'Точно видалити?', remove, 'btn btn-sm btn-danger') : null) : null,
            access.isOwner && !row ? h('p', { class: 'muted small' }, 'Спершу збережіть реквізити.') : null,
            status);
    }

    load();
    return box;
}
