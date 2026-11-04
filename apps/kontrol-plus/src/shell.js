// Каркас CRM Контроль+ (PR 1 з 5): бокове меню, верхня панель і смуга тріалу навколо НАЯВНИХ розділів.
// Лише Контроль+ (<html data-app="kp">): на сайті trip-control.com mountShell() нічого не робить і не торкається DOM.
// Нової логіки розділів тут немає: пункти кличуть наявні перемикачі (див. shell-menu.js), старі вкладки лише ховаються CSS.
import { h } from './ui.js';
import { SHELL_GROUPS, SITE_BUTTONS, activeKey, counterText, isEditableTarget, parseCount, refreshesUnpaid, parseSidebarPref, roleLabel, sidebarKey } from './shell-menu.js';
import { shellIcon } from './shell-icons.js';
import { parseCrmHash, windowSpecOf } from './lib/route.js';
import { MOBILE_MAX, backFallback, isBackRoute, swipeAction } from './lib/mobile-core.js';

const SEARCH_SELECTORS = ['#registry-q', '#history-search', '#kp-crm input[type="search"]', '#main-app input[type="search"]'];

export function isKpApp(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    return !!(d && d.documentElement && d.documentElement.dataset && d.documentElement.dataset.app === 'kp');
}

// env: { supabase, document, window, storage } — усе, крім supabase, лише для тестів.
export function mountShell(env = {}) {
    const doc = env.document || (typeof document !== 'undefined' ? document : null);
    const win = env.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !isKpApp(doc)) return null;
    if (doc.getElementById('kp-shell-side')) return null;
    const body = doc.body;
    const supabase = env.supabase || null;
    const $ = (id) => doc.getElementById(id);
    const site = (name, ...args) => (typeof win[name] === 'function' ? win[name](...args) : null);
    const store = {
        get(key) { try { return (env.storage || win.localStorage).getItem(key); } catch { return null; } },
        set(key, value) { try { (env.storage || win.localStorage).setItem(key, value); } catch { /* приватний режим */ } },
    };

    const buttons = {};
    const counters = { registry: null, unpaid: null };
    const itemEls = [];
    const groupEls = [];
    let userId = null;

    // ---- бокове меню ----
    const nav = h('nav', { class: 'kp-shell-nav', 'aria-label': 'Розділи Контроль+' });
    for (const group of SHELL_GROUPS) {
        const els = group.items.map((item) => {
            const count = h('span', { class: 'kp-shell-count', hidden: true });
            const btn = h('button', {
                type: 'button', class: 'kp-shell-item' + (item.kind === 'soon' ? ' is-soon' : ''), title: item.label, 'data-key': item.key,
                'aria-disabled': item.kind === 'soon' ? 'true' : null,
                onclick: () => openItem(item),
            }, shellIcon(item.icon), h('span', { class: 'kp-shell-lb' }, item.label), item.kind === 'soon' ? h('span', { class: 'kp-shell-soon' }, 'скоро') : count);
            buttons[item.key] = btn;
            itemEls.push({ item, btn, count });
            return btn;
        });
        const box = h('div', { class: 'kp-shell-group', 'data-group': group.key }, h('div', { class: 'kp-shell-glabel' }, group.label), els);
        groupEls.push({ group, box });
        nav.append(box);
    }
    const collapseBtn = h('button', { type: 'button', class: 'kp-shell-collapse', title: 'Згорнути меню', 'aria-label': 'Згорнути меню', onclick: () => setCollapsed(!body.classList.contains('kp-shell-collapsed')) }, shellIcon('collapse'));
    const sideName = h('span', { class: 'kp-shell-side-name' });
    const sideRole = h('span', { class: 'kp-shell-side-role' });
    const side = h('aside', { id: 'kp-shell-side', class: 'kp-shell-side', 'aria-label': 'Меню Контроль+' },
        h('div', { class: 'kp-shell-brand' }, h('span', { class: 'kp-shell-logo' }, 'Контроль', h('b', null, '+')), collapseBtn),
        h('div', { class: 'kp-shell-side-who' }, sideName, sideRole),
        nav);

    // ---- верхня панель ----
    const searchBtn = h('button', { type: 'button', class: 'kp-shell-search', 'aria-label': 'Пошук (Ctrl+K)', onclick: onSearchClick },
        shellIcon('search'), h('span', { class: 'kp-shell-search-t' }, 'Пошук'), h('kbd', null, 'Ctrl K'));
    const companyEl = h('span', { class: 'kp-shell-company', title: 'Компанія' });
    const bellCount = h('span', { class: 'kp-shell-bell-n', hidden: true });
    const bell = h('button', { type: 'button', class: 'kp-shell-bell', title: 'Сповіщення', 'aria-label': 'Сповіщення', onclick: () => site('openCabinetTab', 'notifications') }, shellIcon('bell'), bellCount);
    const whoName = h('span', { class: 'kp-shell-who-name' });
    const whoRole = h('span', { class: 'kp-shell-who-role' });
    const who = h('div', { class: 'kp-shell-who' }, whoName, whoRole);
    // Телефон: пошук — іконка, що розгортається в поле; текст пересилається в поле пошуку поточного розділу.
    const searchIn = h('input', { type: 'search', class: 'kp-shell-search-in', 'aria-label': 'Пошук по розділу', placeholder: 'Пошук', autocomplete: 'off',
        oninput: () => forwardSearch(searchIn.value), onkeydown: (e) => { if (e.key === 'Escape') setSearchOpen(false); } });
    const searchX = h('button', { type: 'button', class: 'kp-shell-search-x', 'aria-label': 'Закрити пошук', onclick: () => setSearchOpen(false) }, '×');
    const burger = h('button', { type: 'button', class: 'kp-shell-burger', 'aria-label': 'Меню', 'aria-expanded': 'false', onclick: () => setMobile(!body.classList.contains('kp-shell-open')) }, shellIcon('burger'));
    const top = h('header', { id: 'kp-shell-top', class: 'kp-shell-top' }, burger, companyEl, searchBtn, searchIn, searchX, h('span', { class: 'kp-shell-grow' }), bell, who);
    // «← Назад» на повноекранних сторінках карток і форм (телефон): ті самі hash-маршрути, Back браузера працює.
    const backBtn = h('button', { type: 'button', class: 'kp-shell-back-btn', onclick: goBack }, '← Назад');
    const backBar = h('div', { id: 'kp-shell-back', class: 'kp-shell-back', hidden: true }, backBtn);
    const strip = h('div', { id: 'kp-shell-strip', class: 'kp-shell-strip' });
    const backdrop = h('div', { id: 'kp-shell-backdrop', class: 'kp-shell-backdrop', onclick: () => setMobile(false) });

    // Наявні вузли сайту переїжджають у каркас без змін (за ними шукають по id / класу): тема, перемикач виду й меню акаунта
    // (.tc-head-end) — у верхню панель, банер тріалу (#billing-banner, логіка #111) — у смугу над нею.
    const headEnd = doc.querySelector('.tc-head-end');
    if (headEnd) top.append(headEnd);
    const banner = $('billing-banner');
    if (banner) strip.append(banner);

    body.append(strip, side, top, backBar, backdrop);
    body.classList.add('kp-shell-on');
    body.classList.remove('kp-nav-on'); // відступи старого лівого меню більше не потрібні: меню тепер це каркас

    // ---- поведінка ----
    function isCabinetOpen() {
        const cab = $('cabinet-screen');
        return !!(cab && cab.style && cab.style.display === 'block');
    }

    function openItem(item) {
        if (item.kind === 'soon') return;
        const cabinetWasOpen = isCabinetOpen();
        if (item.kind === 'cabinet') {
            if (item.tab) site('openCabinetTab', item.tab);
            else site('openCabinet');
        } else {
            if (cabinetWasOpen) site('closeCabinet');
            if (item.kind === 'hash') {
                // Після closeCabinet міст ще прибирає свій hash (leave()) — ставимо новий уже після нього.
                if (cabinetWasOpen) win.setTimeout(() => { win.location.hash = item.hash; }, 0);
                else if (win.location.hash !== item.hash) win.location.hash = item.hash;
            } else {
                const target = $(SITE_BUTTONS[item.site]);
                if (target) target.click();
            }
        }
        setMobile(false);
        win.setTimeout(update, 0);
    }

    // Фокус на наявне поле пошуку поточного розділу. Немає поля — нічого не робимо (в інший розділ не переходимо).
    function focusSearch() {
        const sel = SEARCH_SELECTORS;
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        for (const s of sel) {
            const el = doc.querySelector(s);
            if (visible(el)) { el.focus(); if (typeof el.select === 'function') el.select(); return true; }
        }
        return false;
    }

    const narrow = () => (typeof win.matchMedia === 'function' ? !!win.matchMedia('(max-width: ' + MOBILE_MAX + 'px)').matches : (win.innerWidth || 1280) <= MOBILE_MAX);

    function setMobile(open) {
        body.classList.toggle('kp-shell-open', open);
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setSearchOpen(open) {
        body.classList.toggle('kp-shell-search-open', open);
        if (open) { setMobile(false); searchIn.focus(); } else { searchIn.value = ''; forwardSearch(''); }
    }
    function forwardSearch(text) {
        for (const s of SEARCH_SELECTORS) {
            const el = doc.querySelector(s);
            if (el && el !== searchIn && (el.offsetParent !== null || el.getClientRects().length > 0)) {
                el.value = text;
                el.dispatchEvent(new win.Event('input', { bubbles: true }));
                return true;
            }
        }
        return false;
    }
    function onSearchClick() {
        if (narrow()) setSearchOpen(!body.classList.contains('kp-shell-search-open'));
        else focusSearch();
    }

    // Назад: повернутись в історію; без історії (прямий захід за посиланням) — у список розділу.
    function goBack() {
        const fallback = backFallback(win.location.hash);
        if (win.history && win.history.length > 1) win.history.back();
        else win.location.hash = fallback;
    }
    function paintBack() {
        const on = narrow() && isBackRoute(win.location.hash);
        backBar.hidden = !on;
        body.classList.toggle('kp-shell-back-on', on);
    }

    // Свайп: вліво по відкритій шторці або по фону — закрити; вправо від лівого краю — відкрити.
    let touch = null;
    doc.addEventListener('touchstart', (e) => { const t = e.touches && e.touches[0]; touch = t ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
    doc.addEventListener('touchend', (e) => {
        const t = e.changedTouches && e.changedTouches[0];
        if (!touch || !t || !narrow()) { touch = null; return; }
        const act = swipeAction({ dx: t.clientX - touch.x, dy: t.clientY - touch.y, startX: touch.x, open: body.classList.contains('kp-shell-open') });
        touch = null;
        if (act === 'close') setMobile(false);
        else if (act === 'open') setMobile(true);
    }, { passive: true });

    function setCollapsed(on, persist = true) {
        body.classList.toggle('kp-shell-collapsed', on);
        collapseBtn.title = on ? 'Розгорнути меню' : 'Згорнути меню';
        collapseBtn.setAttribute('aria-label', collapseBtn.title);
        if (persist) store.set(sidebarKey(userId), on ? 'collapsed' : 'expanded');
    }

    async function loadUser() {
        if (!supabase || !supabase.auth || typeof supabase.auth.getSession !== 'function') return;
        try {
            const { data } = await supabase.auth.getSession();
            const id = data && data.session && data.session.user && data.session.user.id;
            if (id && id !== userId) {
                userId = id;
                setCollapsed(parseSidebarPref(store.get(sidebarKey(userId))) === 'collapsed', false);
            }
        } catch { /* лишається стан за замовчуванням */ }
    }

    // Неоплачені рахунки: легка RPC kp_unpaid_invoices_count (один count на сервері, а не вибірка документів). Оновлюється при вході
    // (подія tc:kp-context) і після дій, що міняють оплату / рахунки (див. refreshesUnpaid у shell-menu.js), без таймера й без залежності від
    // фонової перевірки вкладки «Документи». Без доступу (не Контроль+, немає ролі) RPC не кличемо.
    async function refreshUnpaid() {
        if (!supabase || typeof supabase.rpc !== 'function' || !win.tcKpRole) return;
        try {
            const { data, error } = await supabase.rpc('kp_unpaid_invoices_count');
            const n = Number(data);
            if (!error && data !== null && Number.isFinite(n)) { counters.unpaid = n; paintCounters(); }
        } catch { /* без лічильника */ }
    }

    // Після успішного виклику RPC зі списку оновлюємо лічильник. Обгортка не виконує запит удруге: вона лише підміняє then() побудовника.
    function watchRpc() {
        if (!supabase || typeof supabase.rpc !== 'function' || supabase.kpShellWatched) return;
        const original = supabase.rpc.bind(supabase);
        supabase.rpc = function rpc(name, ...rest) {
            const builder = original(name, ...rest);
            if (refreshesUnpaid(name) && builder && typeof builder.then === 'function') {
                const originalThen = builder.then.bind(builder);
                builder.then = (onFulfilled, onRejected) => originalThen((res) => {
                    if (!res || !res.error) win.setTimeout(refreshUnpaid, 0);
                    return onFulfilled ? onFulfilled(res) : res;
                }, onRejected);
            }
            return builder;
        };
        supabase.kpShellWatched = true;
    }

    function paintCounters() {
        for (const { item, count } of itemEls) {
            const text = item.counter ? counterText(counters[item.counter]) : '';
            count.textContent = text;
            count.hidden = !text;
        }
    }

    function paintAccess() {
        for (const { item, btn } of itemEls) {
            const old = item.access ? $('kp-nav-' + item.access) : null;
            btn.hidden = !!item.access && (!old || old.hidden);
        }
        for (const { box } of groupEls) box.hidden = Array.from(box.querySelectorAll('.kp-shell-item')).every((b) => b.hidden);
    }

    function paintActive() {
        // Hash вікна (картка документа, клієнт, заявка) не міняє розділ під ним: підсвітка лишається як була.
        if (windowSpecOf(parseCrmHash(win.location.hash), win.location.hash)) return;
        const cabTab = doc.querySelector('#cabinet-screen .cab-tab.active');
        const key = activeKey({
            hash: win.location.hash,
            studioView: body.getAttribute('data-studio-view'),
            cabinetOpen: isCabinetOpen(),
            cabinetTab: cabTab && cabTab.getAttribute('data-tab'),
        });
        for (const [k, btn] of Object.entries(buttons)) {
            btn.classList.toggle('on', k === key);
            if (k === key) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        }
    }

    function paintPeople() {
        const text = (id) => { const el = $(id); return el ? String(el.textContent || '').trim() : ''; };
        whoName.textContent = text('tc-menu-name') || text('tc-menu-email');
        whoRole.textContent = roleLabel(win.tcKpRole, text('tc-menu-role'));
        sideName.textContent = whoName.textContent;
        sideRole.textContent = whoRole.textContent;
        companyEl.textContent = win.tcKpOrgName || text('tc-menu-company') || '';
        companyEl.hidden = !companyEl.textContent;
        const unread = $('tc-menu-unread');
        const n = unread && !unread.hidden ? String(unread.textContent || '').trim() : '';
        bellCount.textContent = n;
        bellCount.hidden = !n;
    }

    function update() {
        pending = null;
        paintBack();
        paintAccess();
        paintActive();
        paintPeople();
        const reg = $('registry-count');
        counters.registry = reg ? parseCount(reg.textContent) : null;
        paintCounters();
        body.classList.toggle('kp-shell-strip-on', !!banner && !banner.hidden);
    }

    // Зміни DOM і кліки приходять пачками: перемальовуємо не частіше ніж раз на ~100 мс.
    let pending = null;
    function scheduleUpdate() {
        if (pending !== null) return;
        pending = win.setTimeout(update, 100);
    }

    win.addEventListener('hashchange', () => { setMobile(false); setSearchOpen(false); update(); });
    win.addEventListener('resize', paintBack);
    win.addEventListener('tc:cabinet-tab', scheduleUpdate);
    win.addEventListener('tc:kp-context', () => { loadUser(); update(); refreshUnpaid(); });
    doc.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'k') {
            // У полі введення Ctrl+K не перехоплюємо; на розділі без поля пошуку нічого не робимо (і не гасимо звичайну дію браузера).
            if (isEditableTarget(doc.activeElement)) return;
            if (focusSearch()) event.preventDefault();
        } else if (event.key === 'Escape' && body.classList.contains('kp-shell-open')) setMobile(false);
    });
    doc.addEventListener('click', scheduleUpdate);

    if (typeof win.MutationObserver === 'function' || typeof MutationObserver === 'function') {
        const Observer = win.MutationObserver || MutationObserver;
        const watch = (node, opts) => { if (node) new Observer(scheduleUpdate).observe(node, opts); };
        watch(body, { attributes: true, attributeFilter: ['data-studio-view'] });
        watch($('kp-nav-list'), { attributes: true, subtree: true, attributeFilter: ['hidden'] });
        watch($('cabinet-screen'), { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
        watch(banner, { attributes: true, attributeFilter: ['hidden'] });
        for (const id of ['tc-menu-name', 'tc-menu-email', 'tc-menu-role', 'tc-menu-company', 'tc-menu-unread', 'registry-count']) {
            watch($(id), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
        }
    }

    watchRpc();
    loadUser();
    update();
    return { update, scheduleUpdate, openItem, focusSearch, setCollapsed, refreshUnpaid };
}
