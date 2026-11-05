// Значок «?» біля поля: коротка підказка по кліку / тапу й по фокусу з клавіатури. Повторний клік, Esc, клік поза або скрол закривають.
// Текст — лише через textContent. Кнопка за розміром контенту й не зсуває розмітку. Підказка при відкритті переїжджає в <body>
// окремим шаром (position: fixed, z-index --kp-z-dropdown), тож рядок, вікно й скрол її не обрізають і не перекривають; відкрита лише одна.
let seq = 0;
let current = null; // відкрита підказка: її закриває відкриття нової
const GAP = 6;
const EDGE = 8;
const SETTLE_MS = 250;

function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
}

// Межі, де підказка має лишитися: вікно браузера, а якщо «?» у вікні картки (.kp-win) — ще й воно (крім дуже вузьких вікон).
function bounds(btn, vw, vh) {
    const b = { left: EDGE, top: EDGE, right: vw - EDGE, bottom: vh - EDGE };
    const win = typeof btn.closest === 'function' ? btn.closest('.kp-win') : null;
    if (win && typeof win.getBoundingClientRect === 'function') {
        const w = win.getBoundingClientRect();
        const next = { left: Math.max(b.left, w.left + EDGE), top: Math.max(b.top, w.top + EDGE), right: Math.min(b.right, w.right - EDGE), bottom: Math.min(b.bottom, w.bottom - EDGE) };
        if (next.right - next.left >= 160 && next.bottom - next.top >= 80) return next;
    }
    return b;
}

export function placeHint(btn, pop) {
    if (typeof btn.getBoundingClientRect !== 'function' || typeof pop.getBoundingClientRect !== 'function') return;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
    if (!vw || !vh) return;
    const box = bounds(btn, vw, vh);
    const a = btn.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const w = r.width || 0;
    const h = r.height || 0;
    // Вертикаль: під «?», а якщо знизу тісно і зверху місця більше — над ним.
    const below = box.bottom - (a.bottom + GAP);
    const above = a.top - GAP - box.top;
    const up = h > below && above > below;
    let top = up ? a.top - GAP - h : a.bottom + GAP;
    top = Math.max(box.top, Math.min(top, box.bottom - h));
    // Горизонталь: від лівого краю «?»; біля правого краю підказка зсувається вліво.
    let left = a.left;
    if (left + w > box.right) left = a.right - w;
    left = Math.max(box.left, Math.min(left, box.right - w));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    pop.classList.toggle('kp-hint-up', up);
}

export function fieldHint(label, text) {
    seq += 1;
    const id = 'kp-hint-' + seq;
    const wrap = el('span', 'kp-hint');
    const btn = el('button', 'kp-hint-btn');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Підказка: ' + label);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-describedby', id);
    btn.textContent = '?';
    const pop = el('span', 'kp-hint-pop');
    pop.setAttribute('id', id);
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    pop.textContent = text;
    wrap.append(btn, pop);

    let isOpen = false;
    let openedAt = 0;
    const self = { close: () => close() };

    function onOutside(event) {
        if (!wrap.contains(event.target) && !pop.contains(event.target)) close();
    }

    function onKey(event) {
        if (event.key === 'Escape') {
            // Esc закриває лише підказку: вікно під нею (kp-windows) бачить defaultPrevented і не закривається.
            if (event.preventDefault) event.preventDefault();
            if (event.stopPropagation) event.stopPropagation();
            close();
            if (typeof btn.focus === 'function') btn.focus();
        }
    }

    function onScroll(event) {
        if (event && event.target && event.target !== document && pop.contains(event.target)) return;
        // Браузер сам докручує до «?» при фокусі / тапі: скрол одразу після відкриття лише переставляє підказку, а не закриває.
        if (Date.now() - openedAt < SETTLE_MS) placeHint(btn, pop);
        else close();
    }

    function open() {
        if (isOpen) return;
        if (current && current !== self) current.close();
        current = self;
        isOpen = true;
        openedAt = Date.now();
        document.body.append(pop);
        pop.style.left = '0px';
        pop.style.top = '0px';
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        placeHint(btn, pop);
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', close);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        if (current === self) current = null;
        pop.hidden = true;
        wrap.append(pop);
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', close);
    }

    btn.addEventListener('click', (event) => {
        if (event && event.preventDefault) event.preventDefault();
        if (isOpen) close();
        else open();
    });
    // Фокус з клавіатури (Tab) відкриває підказку; клік мишею / тап відкриває лише click, щоб не закрити його одразу.
    btn.addEventListener('focus', () => {
        let keyboard = false;
        try { keyboard = btn.matches(':focus-visible'); } catch { keyboard = false; }
        if (keyboard) open();
    });
    btn.addEventListener('blur', close);
    return wrap;
}

// Поле + значок «?» в одній клітинці (для рядків, де немає підписів).
export function withHint(control, label, text) {
    const cell = el('span', 'kp-hint-cell');
    cell.append(control, fieldHint(label, text));
    return cell;
}
