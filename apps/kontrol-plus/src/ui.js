// Мінімальний DOM-хелпер. Текст завжди йде через textContent — жодного innerHTML з даними користувачів.
export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    append(el, children);
    return el;
}

// SVG-елемент (createElementNS; у тестовому DOM без нього — звичайний createElement). Лише setAttribute / текст.
export function svgEl(tag, attrs, ...children) {
    const el = typeof document.createElementNS === 'function' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) continue;
        el.setAttribute(key, String(value));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(el, child);
        else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

export function clear(el, ...children) {
    el.replaceChildren();
    append(el, children);
    return el;
}

export function spinner(text = 'Завантаження…') {
    return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), text);
}

export function notice(text, kind = 'error') {
    return h('div', { class: 'notice notice-' + kind, role: kind === 'error' ? 'alert' : 'status' }, text);
}

let toastTimer;
export function toast(text, kind = 'ok') {
    let box = document.getElementById('kp-toast');
    if (!box) {
        box = h('div', { id: 'kp-toast', role: 'status', 'aria-live': 'polite' });
        (document.getElementById('kp-crm') || document.body).append(box);
    }
    box.className = 'toast toast-' + kind + ' is-on';
    box.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('is-on'), 3200);
}

// Кнопка з підтвердженням другим натисканням (без window.confirm).
export function confirmButton(label, confirmLabel, onConfirm, cls = 'btn btn-danger') {
    let armed = false;
    let timer;
    const button = h('button', {
        type: 'button',
        class: cls,
        onclick: async () => {
            if (!armed) {
                armed = true;
                button.textContent = confirmLabel;
                button.classList.add('is-armed');
                timer = setTimeout(() => {
                    armed = false;
                    button.textContent = label;
                    button.classList.remove('is-armed');
                }, 4000);
                return;
            }
            clearTimeout(timer);
            button.disabled = true;
            try {
                await onConfirm();
            } finally {
                button.disabled = false;
                armed = false;
                button.textContent = label;
                button.classList.remove('is-armed');
            }
        },
    }, label);
    return button;
}

export function download(fileName, text, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = h('a', { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
