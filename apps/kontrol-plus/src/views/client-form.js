import { h, clear, spinner, notice, toast } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { LEGAL_FORMS, validateClient } from '../lib/validate.js';

const FIELDS = [
    { section: 'Основне' },
    { key: 'name', label: 'Назва (як у списку)', required: true, maxlength: 200 },
    { key: 'legal_form', label: 'Форма', type: 'select' },
    { key: 'legal_name', label: 'Повна юридична назва', placeholder: 'ТОВ «Зерно Трейд» / ФОП Петренко Іван Іванович' },
    { section: 'Коди та податки' },
    { key: 'edrpou', label: 'ЄДРПОУ (ТОВ)', inputmode: 'numeric', maxlength: 8, mono: true, forms: ['tov', 'other', ''] },
    { key: 'ipn', label: 'ІПН / РНОКПП (ФОП)', inputmode: 'numeric', maxlength: 10, mono: true, forms: ['fop', 'other', ''] },
    { key: 'vat_payer', label: 'Платник ПДВ', type: 'checkbox' },
    { key: 'vat_number', label: 'ІПН платника ПДВ', inputmode: 'numeric', maxlength: 12, mono: true },
    { section: 'Банк' },
    { key: 'iban', label: 'IBAN', placeholder: 'UA00 0000 0000 0000 0000 0000 0000 0', maxlength: 40, mono: true },
    { key: 'bank_name', label: 'Банк' },
    { section: 'Адреси' },
    { key: 'legal_address', label: 'Юридична адреса', type: 'textarea' },
    { key: 'postal_address', label: 'Поштова адреса', type: 'textarea' },
    { section: 'Підписант і контакт' },
    { key: 'signer_name', label: 'Підписант (ПІБ)' },
    { key: 'signer_position', label: 'Посада підписанта', placeholder: 'Директор' },
    { key: 'contact_name', label: 'Контактна особа' },
    { key: 'phone', label: 'Телефон', type: 'tel', autocomplete: 'off' },
    { key: 'email', label: 'Email', type: 'email', autocomplete: 'off' },
    { section: 'Нотатки' },
    { key: 'notes', label: 'Нотатки', type: 'textarea', maxlength: 4000 },
];

const COLUMNS = FIELDS.filter((f) => f.key).map((f) => f.key);

export function renderClientForm(app, clientId) {
    const body = h('div', null, spinner());
    const page = h('section', { class: 'page narrow' },
        h('a', { class: 'back', href: clientId ? '#/clients/' + clientId : '#/clients' }, '← Назад'),
        h('h1', null, clientId ? 'Редагувати клієнта' : 'Новий клієнт'),
        body);

    if (!app.canWrite) {
        clear(body, notice('Директор має доступ лише на перегляд.', 'info'));
        return page;
    }
    if (!clientId) {
        clear(body, buildForm(app, null, {}));
        return page;
    }
    app.supabase.from('clients').select(COLUMNS.join(', ')).eq('id', clientId).maybeSingle().then(({ data, error }) => {
        if (error && isPlanError(error)) return app.onPlanLost();
        if (error || !data) {
            clear(body, notice(error ? errorText(error) : 'Клієнта не знайдено.'));
            return;
        }
        clear(body, buildForm(app, clientId, data));
    });
    return page;
}

function buildForm(app, clientId, initial) {
    const inputs = {};
    const hints = {};
    const message = h('div', { 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, clientId ? 'Зберегти' : 'Додати клієнта');

    const rows = FIELDS.map((f) => {
        if (f.section) return h('h2', { class: 'form-section' }, f.section);
        const id = 'f-' + f.key;
        let input;
        if (f.type === 'select') {
            input = h('select', { id, name: f.key },
                h('option', { value: '' }, '—'),
                LEGAL_FORMS.map((o) => h('option', { value: o.value, selected: initial[f.key] === o.value }, o.label)));
        } else if (f.type === 'textarea') {
            input = h('textarea', { id, name: f.key, rows: 2, maxlength: f.maxlength });
            input.value = initial[f.key] || '';
        } else if (f.type === 'checkbox') {
            input = h('input', { id, name: f.key, type: 'checkbox', checked: Boolean(initial[f.key]) });
        } else {
            input = h('input', {
                id, name: f.key, type: f.type || 'text', required: f.required, maxlength: f.maxlength,
                inputmode: f.inputmode, placeholder: f.placeholder, autocomplete: f.autocomplete || 'off',
                class: f.mono ? 'mono' : null, value: initial[f.key] || '',
            });
        }
        inputs[f.key] = input;
        hints[f.key] = h('div', { class: 'hint', id: id + '-hint', 'aria-live': 'polite' });
        input.setAttribute('aria-describedby', id + '-hint');
        if (f.type === 'checkbox') {
            return h('div', { class: 'field field-check', dataset: { key: f.key } }, h('label', { for: id }, input, ' ', f.label), hints[f.key]);
        }
        return h('div', { class: 'field', dataset: { key: f.key } },
            h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
            input, hints[f.key]);
    });

    function values() {
        const out = {};
        for (const [key, input] of Object.entries(inputs)) out[key] = input.type === 'checkbox' ? input.checked : input.value;
        return out;
    }

    function showChecks(result) {
        for (const key of Object.keys(hints)) {
            const text = result.errors[key] || result.warnings[key] || '';
            hints[key].textContent = text;
            hints[key].className = 'hint' + (result.errors[key] ? ' hint-error' : result.warnings[key] ? ' hint-warn' : '');
            inputs[key].toggleAttribute('aria-invalid', Boolean(result.errors[key]));
        }
    }

    // Поля ЄДРПОУ / ІПН — підказкою за формою (обидва лишаються доступними для «Інша форма»).
    function syncForm() {
        const form = inputs.legal_form.value;
        for (const f of FIELDS) {
            if (!f.forms) continue;
            const row = rowsByKey[f.key];
            row.classList.toggle('is-dim', !f.forms.includes(form) && !inputs[f.key].value);
        }
        rowsByKey.vat_number.classList.toggle('is-dim', !inputs.vat_payer.checked && !inputs.vat_number.value);
    }

    const form = h('form', {
        class: 'card form', novalidate: true,
        oninput: () => { showChecks(validateClient(values())); syncForm(); },
        onsubmit: async (event) => {
            event.preventDefault();
            message.replaceChildren();
            const result = validateClient(values());
            showChecks(result);
            if (Object.keys(result.errors).length) {
                message.append(notice('Виправте поля, позначені червоним.'));
                const first = Object.keys(result.errors)[0];
                if (inputs[first]) inputs[first].focus();
                return;
            }
            submit.disabled = true;
            const query = clientId
                ? app.supabase.from('clients').update(result.data).eq('id', clientId).select('id')
                : app.supabase.from('clients').insert(Object.assign({ org_id: app.context.org_id }, result.data)).select('id');
            const { data, error } = await query;
            submit.disabled = false;
            if (error) {
                if (isPlanError(error)) return app.onPlanLost();
                message.append(notice(errorText(error)));
                return;
            }
            if (!data || !data.length) {
                message.append(notice('Зміни не збережено: недостатньо прав.'));
                return;
            }
            toast(clientId ? 'Збережено' : 'Клієнта додано');
            app.go('#/clients/' + data[0].id);
        },
    }, rows, message, h('div', { class: 'actions' }, submit,
        h('a', { class: 'btn btn-ghost', href: clientId ? '#/clients/' + clientId : '#/clients' }, 'Скасувати')));

    const rowsByKey = Object.fromEntries([...form.querySelectorAll('.field')].map((row) => [row.dataset.key, row]));
    syncForm();
    if (clientId) showChecks(validateClient(values()));
    return form;
}
