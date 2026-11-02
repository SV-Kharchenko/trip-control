// Значок «?» біля поля: коротка підказка по кліку / тапу й по фокусу з клавіатури. Повторний клік, Esc або клік поза закривають.
// Текст — лише через textContent. Кнопка за розміром контенту, поповер абсолютний і не зсуває розмітку рядка;
// біля краю екрана поповер зсувається всередину (мобільний), а внизу — відкривається вгору.
let seq = 0;

function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
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

    function place() {
        pop.style.transform = '';
        pop.classList.remove('kp-hint-up');
        if (typeof pop.getBoundingClientRect !== 'function') return;
        const r = pop.getBoundingClientRect();
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
        if (vw) {
            let shift = 0;
            if (r.right > vw - 8) shift = vw - 8 - r.right;
            if (r.left + shift < 8) shift = 8 - r.left;
            if (shift) pop.style.transform = 'translateX(' + Math.round(shift) + 'px)';
        }
        if (vh && r.bottom > vh - 8 && r.top > r.height + 16) pop.classList.add('kp-hint-up');
    }

    function onOutside(event) {
        if (!wrap.contains(event.target)) close();
    }

    function onKey(event) {
        if (event.key === 'Escape') {
            close();
            if (typeof btn.focus === 'function') btn.focus();
        }
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        place();
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
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
