// Менеджер вікон Контроль+ (PR 3 з 5): заявка, документи, картка клієнта відкриваються вікном ПОВЕРХ розділу (розділ не перемальовується).
// Лише Контроль+ (<html data-app="kp">) і ширина ≥ 900px; на сайті createWindowManager() повертає null і нічого не робить.
// Вміст вікна будує викликач (bridge.js) наявними рендерами; тут — рамка: шапка (заголовок, згорнути / розгорнути / закрити), перетягування,
// ліміт 8, дедуплікація за ключем, панель задач (~32px), підтвердження закриття «брудної» форми (лише якщо користувач справді щось змінив),
// зміна розміру за 4 краї й 4 кути, розмір і позиція у sessionStorage, Back закриває верхнє вікно.
import { h } from './ui.js';
import { shellIcon } from './shell-icons.js';
import {
    MAX_WINDOWS, MIN_WIDE, TASKBAR_H, WIN_Z_BASE, backTarget, clampPos, clampRect, cleanTitle, escHtml, formSnapshot, iconFor, initialRect, parseWindows, resizeRect,
    serializeWindows, shortLabel, storageKey,
} from './lib/windows-core.js';

// Вікна з полями введення: для них діє перевірка «є незбережені зміни».
const FORM_TYPES = ['form', 'client_form', 'vehicle', 'trailer', 'driver'];
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function isKpApp(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    return !!(d && d.documentElement && d.documentElement.dataset && d.documentElement.dataset.app === 'kp');
}

// env: { document, window, storage, confirm(opts) → Promise<{ ok }>, notify(text) }
export function createWindowManager(env = {}) {
    const doc = env.document || (typeof document !== 'undefined' ? document : null);
    const win = env.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !isKpApp(doc)) return null;
    const body = doc.body;
    const storage = env.storage || null;
    const confirmClose = env.confirm || (() => Promise.resolve({ ok: true }));
    const notify = env.notify || (() => {});
    const $ = (id) => doc.getElementById(id);

    const wins = new Map(); // key → окно (порядок вставки = порядок відкриття)
    let zorder = [];        // ключі від нижнього до верхнього
    let scope = null;       // ключ sessionStorage поточної пари компанія / користувач
    let silent = false;     // без запису в сховище (масове закриття при зміні пари)
    let lastHash = win.location ? win.location.hash : '';
    let counter = 0;

    const taskbar = h('div', { id: 'kp-taskbar', class: 'kp-taskbar', role: 'toolbar', 'aria-label': 'Відкриті вікна', hidden: true });
    body.append(taskbar);

    function wide() {
        if (typeof win.matchMedia === 'function') return !!win.matchMedia('(min-width: ' + MIN_WIDE + 'px)').matches;
        return (win.innerWidth || 0) >= MIN_WIDE;
    }

    // Робоча область: правіше бокового меню, нижче верхньої панелі (і смуги тріалу), вище панелі задач.
    function bounds() {
        const side = $('kp-shell-side');
        const top = $('kp-shell-top');
        const left = side && side.offsetWidth ? side.offsetWidth : 0;
        const topEdge = top && top.getBoundingClientRect ? Math.round(top.getBoundingClientRect().bottom) : 52;
        return { left, top: topEdge || 52, right: win.innerWidth || 1280, bottom: (win.innerHeight || 800) - TASKBAR_H };
    }

    function persist() {
        if (silent || !scope || !storage) return;
        try { storage.setItem(scope, serializeWindows([...wins.values()])); } catch { /* приватний режим */ }
    }

    function topKey() {
        for (let i = zorder.length - 1; i >= 0; i -= 1) if (!wins.get(zorder[i]).minimized) return zorder[i];
        return null;
    }

    function paint() {
        zorder.forEach((key, i) => {
            const w = wins.get(key);
            w.el.style.zIndex = String(WIN_Z_BASE + i);
        });
        const active = topKey();
        for (const w of wins.values()) {
            w.el.hidden = w.minimized;
            w.el.classList.toggle('is-active', w.key === active);
            w.el.classList.toggle('is-max', w.maximized);
            w.task.classList.toggle('on', w.key === active);
            w.task.classList.toggle('is-min', w.minimized);
            w.task.setAttribute('aria-pressed', w.key === active ? 'true' : 'false');
        }
        taskbar.hidden = wins.size === 0;
        body.classList.toggle('kp-win-open', wins.size > 0);
    }

    function paintTitle(w) {
        w.titleEl.innerHTML = escHtml(w.title);
        w.el.setAttribute('aria-label', w.title);
        w.task.title = w.title;
        w.taskLabel.innerHTML = escHtml(shortLabel(w.title));
        const name = iconFor(w.type, w.title);
        w.iconSlot.replaceChildren(shellIcon(name));
        w.taskIcon.replaceChildren(shellIcon(name));
    }

    function focus(key) {
        const w = wins.get(key);
        if (!w) return false;
        w.minimized = false;
        zorder = zorder.filter((k) => k !== key).concat(key);
        paint();
        persist();
        return true;
    }

    function minimize(key) {
        const w = wins.get(key);
        if (!w) return;
        w.minimized = true;
        paint();
        persist();
    }

    // Клік по кнопці панелі задач: згорнуте → розгорнути, активне → згорнути, неактивне → на передній план.
    function taskClick(key) {
        const w = wins.get(key);
        if (!w) return;
        if (w.minimized) focus(key);
        else if (topKey() === key) minimize(key);
        else focus(key);
    }

    function toggleMax(key) {
        const w = wins.get(key);
        if (!w) return;
        w.maximized = !w.maximized;
        paintMax(w);
        applyRect(w);
        paint();
        focus(key);
        persist();
    }

    function paintMax(w) {
        w.maxBtn.setAttribute('aria-label', w.maximized ? 'Відновити розмір' : 'Розгорнути');
        w.maxBtn.title = w.maxBtn.getAttribute('aria-label');
    }

    // «Брудна» форма: користувач справді змінив значення відносно стану після відкриття й автозаповнення (знімок полів), а не просто торкнувся форми.
    function isDirty(w) {
        if (w.manualDirty) return true;
        if (!w.edited) return false;
        if (w.baseline === null || w.baseline === undefined) return true; // знімка немає (вміст без полів у DOM) — вважаємо змінами
        return formSnapshot(w.bodyEl) !== w.baseline;
    }

    function applyRect(w) {
        const s = w.el.style;
        if (w.maximized) { s.left = ''; s.top = ''; s.width = ''; s.height = ''; return; }
        s.left = w.x + 'px';
        s.top = w.y + 'px';
        s.width = w.w + 'px';
        s.height = w.h + 'px';
    }

    function restoreHash(w) {
        if (!w.viaHash || !win.location || win.location.hash !== w.hash || !win.history) return;
        const base = (win.location.pathname || '') + (win.location.search || '');
        try { win.history.replaceState(null, '', base + (w.prevHash || '')); } catch { /* file:// */ }
        lastHash = w.prevHash || '';
    }

    // force — без підтвердження (збереження вдалося, заміна вікна, масове закриття).
    async function close(key, opts = {}) {
        const w = wins.get(key);
        if (!w) return false;
        if (isDirty(w) && !opts.force) {
            const answer = await confirmClose({ title: 'Закрити вікно?', text: 'У формі «' + w.title + '» є незбережені зміни. Закрити без збереження?', confirmText: 'Закрити', danger: true });
            if (!answer || !answer.ok) return false;
        }
        if (!wins.has(key)) return false;
        restoreHash(w);
        wins.delete(key);
        zorder = zorder.filter((k) => k !== key);
        for (const fn of w.cleanups.splice(0)) { try { fn(); } catch { /* прибирання не має ламати закриття */ } }
        if (w.observer && typeof w.observer.disconnect === 'function') w.observer.disconnect();
        w.el.remove();
        w.task.remove();
        paint();
        persist();
        return true;
    }

    async function closeAll(opts = {}) {
        const keys = [...wins.keys()];
        const was = silent;
        if (opts.silent) silent = true;
        for (const key of keys) await close(key, { force: true });
        silent = was;
    }

    function startDrag(w, event) {
        if (w.maximized || (event.button !== undefined && event.button !== 0)) return;
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button')) return;
        focus(w.key);
        const startX = event.clientX;
        const startY = event.clientY;
        const baseX = w.x;
        const baseY = w.y;
        const move = (e) => {
            const pos = clampPos(baseX + (e.clientX - startX), baseY + (e.clientY - startY), w.w, w.h, bounds());
            w.x = pos.x;
            w.y = pos.y;
            applyRect(w);
        };
        const up = () => { win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); persist(); };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', up);
    }

    // Зміна розміру за край або кут (dir: n, s, e, w, ne, nw, se, sw). Розгорнуте вікно не змінює розмір.
    function startResize(w, dir, event) {
        if (w.maximized || (event.button !== undefined && event.button !== 0)) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        focus(w.key);
        const start = { x: w.x, y: w.y, w: w.w, h: w.h };
        const startX = event.clientX;
        const startY = event.clientY;
        const move = (e) => {
            Object.assign(w, resizeRect(start, dir, e.clientX - startX, e.clientY - startY, bounds()));
            applyRect(w);
        };
        const up = () => { win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); persist(); };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', up);
    }

    // Вікно без вмісту: build(container, ctl) монтує вміст (може бути async). Повертає { ok, win } або { ok: false, reason }.
    function open(spec) {
        if (!wide()) return { ok: false, reason: 'narrow' };
        const existing = wins.get(spec.key);
        if (existing) {
            focus(spec.key);
            return { ok: true, win: existing, existing: true };
        }
        if (wins.size >= MAX_WINDOWS) {
            notify('Відкрито максимум ' + MAX_WINDOWS + ' вікон. Закрийте одне з них.');
            return { ok: false, reason: 'limit' };
        }
        counter += 1;
        const rect = spec.rect ? clampRect(spec.rect, bounds()) : initialRect(bounds(), wins.size);
        const w = {
            key: spec.key, type: spec.type, id: spec.id, title: spec.title || '', hash: spec.hash || null, prevHash: spec.prevHash || '', viaHash: !!spec.viaHash,
            minimized: !!spec.minimized, maximized: !!spec.maximized, manualDirty: false, edited: false, baseline: undefined, cleanups: [], observer: null, ...rect, seq: counter,
            get dirty() { return isDirty(this); },
            set dirty(value) { this.manualDirty = !!value; },
        };
        const isForm = FORM_TYPES.includes(spec.type);
        w.iconSlot = h('span', { class: 'kp-win-ic' });
        w.titleEl = h('span', { class: 'kp-win-title' });
        w.minBtn = h('button', { type: 'button', class: 'kp-win-btn', title: 'Згорнути', 'aria-label': 'Згорнути', onclick: () => minimize(w.key) }, '–');
        w.maxBtn = h('button', { type: 'button', class: 'kp-win-btn', title: 'Розгорнути', 'aria-label': 'Розгорнути', onclick: () => toggleMax(w.key) }, '▢');
        w.closeBtn = h('button', { type: 'button', class: 'kp-win-btn is-close', title: 'Закрити', 'aria-label': 'Закрити', onclick: () => close(w.key) }, '×');
        const head = h('header', { class: 'kp-win-head', onpointerdown: (e) => startDrag(w, e), ondblclick: (e) => { if (!(e.target && e.target.closest && e.target.closest('button'))) toggleMax(w.key); } },
            w.iconSlot, w.titleEl, h('span', { class: 'kp-win-btns' }, w.minBtn, w.maxBtn, w.closeBtn));
        w.bodyEl = h('div', { class: 'kp-win-body' });
        const handles = RESIZE_DIRS.map((dir) => h('span', { class: 'kp-win-rs kp-rs-' + dir, 'data-dir': dir, 'aria-hidden': 'true', onpointerdown: (e) => startResize(w, dir, e) }));
        w.el = h('section', { class: 'kp-win', role: 'dialog', 'aria-modal': 'false', 'data-key': w.key, onpointerdown: () => { if (topKey() !== w.key) focus(w.key); } }, head, w.bodyEl, handles);
        w.taskLabel = h('span', { class: 'kp-task-lb' });
        w.taskIcon = h('span', { class: 'kp-task-ic' });
        w.task = h('button', {
            type: 'button', class: 'kp-task', 'data-key': w.key, 'aria-pressed': 'false', onclick: () => taskClick(w.key),
            onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); close(w.key); } },
            onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
        }, w.taskIcon, w.taskLabel);
        wins.set(w.key, w);
        zorder.push(w.key);
        paintTitle(w);
        paintMax(w);
        applyRect(w);
        body.append(w.el);
        taskbar.append(w.task);
        if (isForm) {
            const trusted = (e) => !(e && e.isTrusted === false); // подія від скрипта (автозаповнення) — не дія користувача
            // Знімок полів беремо перед першою дією користувача (клік / клавіша): до цього форма могла автозаповнитися.
            const takeBase = (e) => {
                if (!trusted(e) || w.edited || w.baseline !== undefined) return;
                w.baseline = formSnapshot(w.bodyEl);
            };
            const onEdit = (e) => {
                const t = e && e.target;
                const tag = t && String(t.tagName || '').toUpperCase();
                if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
                if (!trusted(e)) { if (!w.edited && w.baseline !== undefined) w.baseline = formSnapshot(w.bodyEl); return; }
                if (w.baseline === undefined) w.baseline = null;
                w.edited = true;
            };
            for (const type of ['pointerdown', 'keydown', 'beforeinput']) w.bodyEl.addEventListener(type, takeBase, true);
            w.bodyEl.addEventListener('input', onEdit);
            w.bodyEl.addEventListener('change', onEdit);
        }
        const ctl = {
            key: w.key,
            setTitle(text) { const t = cleanTitle(text); if (t && t !== w.title) { w.title = t; paintTitle(w); } },
            setDirty(value) { w.manualDirty = !!value; },
            close: (o) => close(w.key, o),
            onClose(fn) { w.cleanups.push(fn); },
            // Заголовок із першого h1 / h2, який зʼявиться у вмісті (картки малюються асинхронно).
            titleFrom(el) {
                const read = () => { const hd = el.querySelector && el.querySelector('h1, h2'); if (hd && hd.textContent) ctl.setTitle(hd.textContent); };
                read();
                const Observer = win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
                if (Observer && !w.observer) { w.observer = new Observer(read); w.observer.observe(el, { childList: true, subtree: true, characterData: true }); }
            },
        };
        w.ctl = ctl;
        paint();
        persist();
        Promise.resolve().then(() => spec.build(w.bodyEl, ctl)).catch(() => {
            w.bodyEl.replaceChildren(h('p', { class: 'kp-win-error' }, 'Не вдалося відкрити вікно. Закрийте його й спробуйте ще раз.'));
        });
        return { ok: true, win: w };
    }

    // Звʼязок із hash-навігацією. hash — новий hash, spec — { type, id, key, title, build } вікна для нього або null.
    // true — подію опрацьовано (вікно відкрито / сфокусовано / закрито Back-ом), розділ під вікнами перемальовувати не треба.
    function handleHash(hash, spec) {
        const prev = lastHash;
        lastHash = hash;
        if (!wide()) return false;
        const back = backTarget([...zorder].map((k) => wins.get(k)), prev, hash);
        if (back) {
            const target = wins.get(back.key);
            close(back.key, { force: false }).then((closed) => {
                if (!closed && target && wins.has(target.key) && win.location) {
                    // Користувач лишив «брудну» форму: повертаємо hash вікна, щоб адреса відповідала відкритому вікну.
                    lastHash = target.hash;
                    try { win.history.replaceState(null, '', (win.location.pathname || '') + (win.location.search || '') + target.hash); } catch { /* file:// */ }
                }
            });
            if (spec && wins.has(spec.key)) focus(spec.key);
            return true;
        }
        if (!spec) return false;
        const res = open({ ...spec, hash, prevHash: prev, viaHash: true });
        if (res.ok && res.existing) {
            const w = wins.get(spec.key);
            if (w && !w.viaHash) { w.viaHash = true; w.hash = hash; w.prevHash = prev; }
            return true;
        }
        if (!res.ok) {
            if (res.reason === 'limit' && win.history) {
                try { win.history.replaceState(null, '', (win.location.pathname || '') + (win.location.search || '') + prev); } catch { /* file:// */ }
                lastHash = prev;
                return true;
            }
            return false;
        }
        return true;
    }

    // Пара компанія / користувач: інша пара → усі вікна закриваються (без запису), зберігається список нової пари і відновлюється.
    async function setScope(org, user, resolve) {
        const next = storageKey(org, user);
        if (next === scope) return;
        await closeAll({ silent: true });
        scope = next;
        if (!next || !storage || typeof resolve !== 'function') return;
        let raw = null;
        try { raw = storage.getItem(next); } catch { raw = null; }
        const items = parseWindows(raw);
        for (const item of items) {
            const spec = await resolve(item);
            if (spec) {
                const rect = item.w ? { x: item.x, y: item.y, w: item.w, h: item.h } : undefined;
                open({ ...spec, minimized: item.minimized, maximized: item.max === true, rect });
            }
        }
        paint();
        persist();
    }

    // Вікно браузера змінилось: вікна лишаються в межах робочої області.
    win.addEventListener('resize', () => {
        for (const w of wins.values()) {
            if (w.maximized) continue;
            Object.assign(w, clampRect(w, bounds()));
            applyRect(w);
        }
        persist();
    });

    doc.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (typeof doc.querySelector === 'function' && doc.querySelector('.tc-modal')) return; // діалог закривається сам
        const key = topKey();
        if (key) close(key);
    });

    return {
        enabled: wide, open, focus, close, closeAll, minimize, taskClick, toggleMax, handleHash, setScope,
        count: () => wins.size,
        list: () => [...wins.values()].map((w) => ({ key: w.key, type: w.type, id: w.id, title: w.title, minimized: w.minimized, dirty: isDirty(w), maximized: w.maximized, x: w.x, y: w.y, w: w.w, h: w.h })),
        active: topKey,
        get: (key) => wins.get(key) || null,
        taskbar,
    };
}
