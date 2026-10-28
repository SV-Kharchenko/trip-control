// Спільний компонент «Автопарк / Причепи / Водії»: зверху пошук і кнопка «Додати …», під ними список ЛИШЕ для читання
// (без полів редагування в таблиці), клік по рядку відкриває картку об'єкта в компактному стилі 1С (підпис зліва, вузьке поле).
// Дані й збереження — у викликаючому view (cfg.load / cfg.renderCard), тут лише оболонка.
import { h, clear, spinner } from '../ui.js';

// Поле картки за специфікацією (lib/registry.js): { row, input }.
export function cardField(spec, value, { disabled = false, options = [] } = {}) {
    const id = 'kpc-' + spec.key;
    let input;
    if (spec.type === 'driver' || spec.type === 'vehicle' || spec.type === 'trailer' || spec.type === 'trailer_type') {
        input = h('select', { id, disabled }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
    } else {
        input = h('input', {
            id, type: spec.type === 'date' ? 'date' : 'text', maxlength: spec.maxlength, inputmode: spec.inputmode, placeholder: spec.placeholder,
            autocomplete: 'off', disabled, value: value === null || value === undefined ? '' : String(value),
        });
    }
    const hint = h('div', { class: 'hint', id: id + '-hint', 'aria-live': 'polite' });
    const box = h('span', { class: 'kpc-box kpc-w-' + (spec.width || 'm') }, input, spec.suffix ? h('em', { class: 'kpc-suffix' }, spec.suffix) : null);
    const row = h('div', { class: 'field kpc-row' },
        h('label', { for: id }, spec.label, spec.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), box, hint);
    return { row, input, hint };
}

// Підсвітка помилок валідації за ключами полів.
export function showFieldErrors(fields, errors) {
    for (const [key, f] of Object.entries(fields)) {
        const text = errors[key] || '';
        f.hint.textContent = text;
        f.hint.className = 'hint' + (text ? ' hint-error' : '');
        f.input.toggleAttribute('aria-invalid', Boolean(text));
    }
}

export function cardLayout({ title, fields, message, actions, back }) {
    return h('div', { class: 'card kpc' },
        h('div', { class: 'kpc-head' }, h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: back }, '← До списку'), h('h2', null, title)),
        h('div', { class: 'kpc-body' }, fields),
        message,
        h('div', { class: 'actions kpc-actions' }, actions));
}

export function renderRegistry(app, cfg) {
    const query = h('input', { type: 'text', id: cfg.id + '-q', placeholder: cfg.searchPlaceholder, autocomplete: 'off', 'aria-label': cfg.searchLabel });
    const clearBtn = h('button', { type: 'button', class: 'kpf-clear', 'aria-label': 'Очистити пошук', hidden: true }, '×');
    const addBtn = cfg.canAdd ? h('button', { type: 'button', class: 'btn btn-primary', id: cfg.id + '-add', onclick: () => openCard(null) }, cfg.addLabel) : null;
    const listBox = h('div', null, spinner());
    const listWrap = h('div', { class: 'kpg-list' },
        h('div', { class: 'kpf-filter kpg-bar' }, h('label', { for: cfg.id + '-q' }, cfg.searchLabel), h('span', { class: 'kpf-field' }, query, clearBtn), addBtn),
        listBox);
    const cardBox = h('div', { class: 'kpg-card', hidden: true });
    let rows = [];

    function drawList() {
        clearBtn.hidden = !query.value;
        const shown = rows.filter((r) => cfg.match(r, query.value));
        clear(listBox, h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table kpf-table kpg-table' },
            h('thead', null, h('tr', null, cfg.columns.map((c) => h('th', null, c.label)))),
            h('tbody', null, shown.length
                ? shown.map((r) => {
                    const open = () => openCard(r);
                    return h('tr', {
                        class: 'kpg-row' + (cfg.rowClass ? ' ' + (cfg.rowClass(r) || '') : ''), tabindex: '0', role: 'button', 'aria-label': 'Відкрити картку: ' + cfg.rowTitle(r),
                        onclick: open,
                        onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } },
                    }, cfg.columns.map((c) => h('td', { 'data-label': c.label, class: c.mono ? 'mono' : null }, c.cell(r))));
                })
                : h('tr', { class: 'kpf-none' }, h('td', { colspan: cfg.columns.length, class: 'muted' }, rows.length ? 'Нічого не знайдено' : cfg.emptyText))))));
    }

    async function load() {
        clear(listBox, spinner());
        try {
            rows = await cfg.load();
        } catch (error) {
            cfg.onError(listBox, error);
            return;
        }
        drawList();
    }

    function closeCard(reload) {
        cardBox.hidden = true;
        listWrap.hidden = false;
        clear(cardBox);
        if (reload) load();
        else drawList();
    }

    function openCard(row) {
        listWrap.hidden = true;
        cardBox.hidden = false;
        clear(cardBox, cfg.renderCard(row, { close: closeCard, back: () => closeCard(false) }));
        window.scrollTo(0, 0);
    }

    query.addEventListener('input', drawList);
    clearBtn.addEventListener('click', () => { query.value = ''; drawList(); query.focus(); });
    load();

    return h('section', { class: 'page kpr-page kpg-page' },
        h('div', { class: 'page-head' }, h('h1', null, cfg.title)),
        cfg.tabs || null,
        listWrap,
        cardBox);
}
