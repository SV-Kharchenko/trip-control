// Мобільні доповнення Контроль+ (PR 5 з 5): на вузькому екрані (< 700px) дії рядка-картки ховаються в меню «⋯», а фільтри розділу — у висувну
// панель «Фільтри (N)». Лише Контроль+ (<html data-app="kp">); на сайті не підключається. Розмітку розділів не міняє: вузли лише переносяться
// (їхні обробники лишаються), на ширшому екрані все повертається на місце. Реєстр заявок сайту має власну панель фільтрів — її не чіпаємо.
import { CARDS_MAX, filterCount } from './lib/mobile-core.js';

// Контейнери дій у картках: реєстр заявок (сайт) і таблиці розділів Контроль+.
const ACTIONS = '.tc-history-cards .tc-history-actions, .kpr-cards td > .actions, .kpr-cards td[data-label=""]';
// Панелі фільтрів розділів Контроль+ (форми й «Рейси клієнта» — не фільтри).
const FILTERS = '.kpd-filters, .kpr-page .toolbar:not(.kpd-trips-filter), .kp-report .toolbar';

export function mountMobile(env = {}) {
    const doc = env.document || (typeof document !== 'undefined' ? document : null);
    const win = env.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !doc.documentElement || doc.documentElement.dataset.app !== 'kp') return null;
    const mq = typeof win.matchMedia === 'function' ? win.matchMedia('(max-width: ' + CARDS_MAX + 'px)') : null;
    const narrow = () => (mq ? mq.matches : (win.innerWidth || 1280) <= CARDS_MAX);
    const controls = (box) => [...box.querySelectorAll('input, select, textarea')].filter((el) => el.type !== 'hidden');

    // ----- дії рядка → «⋯» -----
    function wrapActions(box) {
        if (box.dataset.kpMore === '1') return;
        const items = [...box.children].filter((el) => el.matches('button, a'));
        if (items.length < 2) return;
        box.dataset.kpMore = '1';
        const menu = doc.createElement('div');
        menu.className = 'kp-more-menu';
        menu.hidden = true;
        menu.setAttribute('role', 'menu');
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'kp-more-btn';
        btn.setAttribute('aria-label', 'Дії');
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '⋯';
        const toggle = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); box.classList.toggle('kp-more-open', open); };
        btn.addEventListener('click', (event) => { event.stopPropagation(); const open = menu.hidden; closeAll(); toggle(open); });
        menu.addEventListener('click', () => toggle(false), true); // у фазі перехоплення: обробники кнопок реєстру зупиняють спливання
        box._kpItems = items;
        for (const el of items) menu.append(el);
        box.append(btn, menu);
        box.classList.add('kp-more');
    }
    function unwrapActions(box) {
        if (box.dataset.kpMore !== '1') return;
        const menu = box.querySelector(':scope > .kp-more-menu');
        const btn = box.querySelector(':scope > .kp-more-btn');
        for (const el of box._kpItems || []) box.insertBefore(el, btn);
        if (menu) menu.remove();
        if (btn) btn.remove();
        box.classList.remove('kp-more', 'kp-more-open');
        delete box.dataset.kpMore;
    }
    function closeAll() {
        for (const m of doc.querySelectorAll('.kp-more-menu')) {
            m.hidden = true;
            const box = m.parentElement;
            if (box) { box.classList.remove('kp-more-open'); const b = box.querySelector(':scope > .kp-more-btn'); if (b) b.setAttribute('aria-expanded', 'false'); }
        }
    }
    doc.addEventListener('click', closeAll);
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

    // ----- фільтри → «Фільтри (N)» -----
    function wrapFilters(box) {
        if (box.dataset.kpFlt === '1') return;
        const list = controls(box);
        if (list.length < 2) return;
        box.dataset.kpFlt = '1';
        const initial = list.map((el) => ({ el, value: el.value, checked: el.checked }));
        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.className = 'kp-flt-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        const paint = () => {
            const n = filterCount(controls(box).map((el) => {
                const was = initial.find((x) => x.el === el);
                return { type: el.type, value: el.value, initial: was ? was.value : '', checked: el.checked, initialChecked: was ? was.checked : false };
            }));
            toggle.textContent = 'Фільтри' + (n ? ' (' + n + ')' : '');
        };
        toggle.addEventListener('click', () => { const open = !box.classList.contains('is-open'); box.classList.toggle('is-open', open); toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); });
        box.addEventListener('input', paint);
        box.addEventListener('change', paint);
        box.classList.add('kp-flt');
        box.parentNode.insertBefore(toggle, box);
        box._kpToggle = toggle;
        paint();
    }
    function unwrapFilters(box) {
        if (box.dataset.kpFlt !== '1') return;
        if (box._kpToggle) box._kpToggle.remove();
        box.classList.remove('kp-flt', 'is-open');
        delete box.dataset.kpFlt;
    }

    let queued = false;
    function apply() {
        queued = false;
        const on = narrow();
        for (const box of doc.querySelectorAll(ACTIONS)) (on ? wrapActions : unwrapActions)(box);
        for (const box of doc.querySelectorAll(FILTERS)) (on ? wrapFilters : unwrapFilters)(box);
        if (!on) for (const box of doc.querySelectorAll('[data-kp-more="1"]')) unwrapActions(box);
        if (!on) for (const box of doc.querySelectorAll('[data-kp-flt="1"]')) unwrapFilters(box);
    }
    function schedule() {
        if (queued) return;
        queued = true;
        (win.requestAnimationFrame || ((fn) => win.setTimeout(fn, 16)))(apply);
    }
    const Observer = win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (Observer) {
        const watch = (node) => { if (node) new Observer(schedule).observe(node, { childList: true, subtree: true }); };
        watch(doc.getElementById('main-app'));
        watch(doc.getElementById('kp-crm'));
    }
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
    else win.addEventListener('resize', schedule);
    apply();
    return { apply, closeAll };
}
