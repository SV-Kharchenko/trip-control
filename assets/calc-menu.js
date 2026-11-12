/* Ліве меню «Розрахунку рейсу»: пункти-секції з рядком-підсумком, активна секція в localStorage (tc.calc.section).
   Логіку розрахунку, поля й валідацію не чіпає: бере готові блоки (.tc-acc-row) з index.html і лише показує один із них.
   Чисті функції (підсумки, ключ секції, сусідній пункт) винесено окремо, щоб їх можна було перевірити без браузера. */
(function (root) {
  'use strict';
  var STORAGE_KEY = 'tc.calc.section';
  var DEFAULT_KEY = 'route';

  function svg(body) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  var SECTIONS = [
    { key: 'route', short: 'Маршрут', name: 'Маршрут', sub: 'Звідки, куди, відстань і тариф', icon: svg('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16"/>') },
    { key: 'fuel', short: 'Пальне', name: 'Пальне', sub: 'Сезон, ціна, норми витрати, AdBlue', icon: svg('<path d="M4 20V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14"/><path d="M3 20h12"/><path d="M14 9h2.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 9h4"/>') },
    { key: 'extras', short: 'Параметри', name: 'Додаткові параметри', sub: 'Форма розрахунку, причіп, простій', icon: svg('<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/>') },
    { key: 'costs', short: 'Витрати', name: 'Витрати', sub: 'Водій, ТО, шини, накладні', icon: svg('<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><path d="M16 14.5h2"/>') },
    { key: 'recent', short: 'Останні', name: 'Останні маршрути', sub: 'Підставити маршрут із історії', icon: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4.5l3 1.8"/>') },
    { key: 'vehicle', short: 'ТЗ', name: 'ТЗ', sub: 'Авто з картки: норми й маса', icon: svg('<path d="M2.5 16.5V7.5a1.5 1.5 0 0 1 1.5-1.5h9v10.5"/><path d="M13 9.5h4l3.5 3.5v3.5H13"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>') }
  ];

  function keys() { return SECTIONS.map(function (s) { return s.key; }); }
  function sectionMeta(key) {
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].key === key) return SECTIONS[i];
    return SECTIONS[0];
  }
  function normalizeKey(key) { return keys().indexOf(key) >= 0 ? key : DEFAULT_KEY; }

  function readKey(storage) {
    try { return normalizeKey(storage && storage.getItem(STORAGE_KEY)); } catch (e) { return DEFAULT_KEY; }
  }
  function writeKey(storage, key) {
    try { if (storage) storage.setItem(STORAGE_KEY, normalizeKey(key)); } catch (e) { /* приватний режим: секція просто не запамʼятається */ }
  }
  // ↑/↓ по колу; Home/End — крайні.
  function stepKey(list, current, delta) {
    var at = list.indexOf(current);
    if (at < 0) return list[0];
    return list[(at + delta + list.length) % list.length];
  }

  function cityOf(text) { return String(text == null ? '' : text).split(',')[0].trim(); }
  function kmText(km) {
    var n = Number(km);
    return n > 0 ? new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/ /g, ' ') + ' км' : '';
  }
  // «Житомир → Одеса · 575 км»; порожньо — «Не задано».
  function routeSummary(from, to, km) {
    var a = cityOf(from);
    var b = cityOf(to);
    var dist = kmText(km);
    var path = a && b ? a + ' → ' + b : (a || b || '');
    if (path && dist) return path + ' · ' + dist;
    return path || dist || 'Не задано';
  }
  function recentSummary(count) {
    var n = Number(count) || 0;
    return n > 0 ? n + ' збережені' : 'Немає';
  }
  // Одне авто — його назва; кілька — «N авто»; нічого не вибрано — увесь парк.
  function vehicleSummary(labels) {
    var list = (labels || []).map(function (l) { return String(l || '').trim(); }).filter(Boolean);
    if (!list.length) return 'Весь автопарк';
    return list.length === 1 ? list[0] : list.length + ' авто';
  }
  // «Немає …» вимагає родового відмінка: «пробіг між ТО» → «пробігу між ТО».
  var GENITIVE = { 'пробіг між ТО': 'пробігу між ТО', 'ресурс шини': 'ресурсу шини' };
  function costsSummary(total, missing) {
    if (missing && missing.length) return 'Немає ' + missing.map(function (m) { return GENITIVE[m] || m; }).join(', ');
    var n = Number(total);
    return n > 0 ? 'з витратної частини · ' + new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/ /g, ' ') + ' грн' : 'з витратної частини компанії';
  }

  // mount({ doc, storage, host, rows, summary(key), hasError(key), show(key, on), onSelect(key, meta), actions: [Element] })
  function mount(opts) {
    var doc = opts.doc;
    var old = doc.getElementById('tc-calc-nav');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var nav = doc.createElement('nav');
    nav.id = 'tc-calc-nav';
    nav.className = 'tc-nav';
    nav.setAttribute('aria-label', 'Розрахунок рейсу');
    var title = doc.createElement('div');
    title.className = 'tc-nav-title';
    title.textContent = 'Розрахунок';
    var list = doc.createElement('div');
    list.className = 'tc-nav-list';
    var actions = doc.createElement('div');
    actions.className = 'tc-nav-actions';
    (opts.actions || []).forEach(function (btn) { if (btn) actions.appendChild(btn); });
    nav.appendChild(title);
    nav.appendChild(list);
    nav.appendChild(actions);

    var items = {};
    var order = [];
    SECTIONS.forEach(function (sec) {
      if (!opts.rows[sec.key]) return;
      order.push(sec.key);
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'tc-nav-item';
      btn.setAttribute('data-key', sec.key);
      btn.setAttribute('aria-controls', opts.rows[sec.key].id || '');
      btn.innerHTML = '<span class="tc-nav-ico">' + sec.icon + '</span>'
        + '<span class="tc-nav-text"><b class="tc-nav-name"></b><small class="tc-nav-sum"></small></span>'
        + '<i class="tc-nav-dot" hidden><span class="visually-hidden">Є незаповнені поля</span></i>'
        + '<span class="tc-nav-tip" role="tooltip"><b></b><small></small></span>';
      var nameEl = btn.querySelector('.tc-nav-name');
      nameEl.textContent = sec.name;
      nameEl.setAttribute('data-short', sec.short || sec.name);
      btn.setAttribute('aria-label', sec.name);
      btn.title = sec.name;
      btn.querySelector('.tc-nav-tip b').textContent = sec.name;
      btn.addEventListener('click', function () { api.select(sec.key); });
      list.appendChild(btn);
      items[sec.key] = btn;
    });

    list.addEventListener('keydown', function (event) {
      var key = event.key;
      var target = event.target && event.target.closest ? event.target.closest('.tc-nav-item') : null;
      if (!target || !(key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End')) return;
      event.preventDefault();
      var current = target.getAttribute('data-key');
      var next = key === 'Home' ? order[0] : key === 'End' ? order[order.length - 1] : stepKey(order, current, key === 'ArrowDown' ? 1 : -1);
      if (items[next]) items[next].focus();
    });

    // ≤900px пункти — горизонтальна смуга: класи is-scroll-l/r вмикають fade по краях, активна вкладка підкручується в зону видимості.
    function updateFade() {
      var max = list.scrollWidth - list.clientWidth;
      list.classList.toggle('is-scroll-l', max > 1 && list.scrollLeft > 1);
      list.classList.toggle('is-scroll-r', max > 1 && list.scrollLeft < max - 1);
    }
    function revealActive(item) {
      if (!item || list.scrollWidth <= list.clientWidth) { updateFade(); return; }
      var left = item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2;
      list.scrollLeft = Math.max(0, left);
      updateFade();
    }
    list.addEventListener('scroll', updateFade);
    if (doc.defaultView && doc.defaultView.addEventListener) doc.defaultView.addEventListener('resize', updateFade);

    var active = null;
    var api = {
      nav: nav,
      keys: order,
      active: function () { return active; },
      select: function (key, silent) {
        var next = order.indexOf(key) >= 0 ? key : (order.indexOf(DEFAULT_KEY) >= 0 ? DEFAULT_KEY : order[0]);
        order.forEach(function (k) {
          var on = k === next;
          if (opts.show) opts.show(k, on);
          if (on) items[k].setAttribute('aria-current', 'page');
          else items[k].removeAttribute('aria-current');
        });
        active = next;
        revealActive(items[next]);
        if (!silent) writeKey(opts.storage, next);
        if (opts.onSelect) opts.onSelect(next, sectionMeta(next));
      },
      refresh: function () {
        order.forEach(function (k) {
          var text = opts.summary ? String(opts.summary(k) || '') : '';
          var item = items[k];
          var sum = item.querySelector('.tc-nav-sum');
          if (sum.textContent !== text) sum.textContent = text;
          var tip = item.querySelector('.tc-nav-tip small');
          if (tip.textContent !== text) tip.textContent = text;
          sum.title = text;
          var bad0 = !!(opts.hasError && opts.hasError(k));
          var sec0 = sectionMeta(k);
          item.title = sec0.name + (text ? ' — ' + text : '');
          item.setAttribute('aria-label', sec0.name + (text ? ': ' + text : '') + (bad0 ? '. Є незаповнені поля' : ''));
          var bad = !!(opts.hasError && opts.hasError(k));
          item.classList.toggle('has-error', bad);
          item.querySelector('.tc-nav-dot').hidden = !bad;
        });
      }
    };

    if (opts.host) opts.host.insertBefore(nav, opts.host.firstChild);
    api.select(readKey(opts.storage), true);
    api.refresh();
    return api;
  }

  // ---- висота колонок ----
  var ROOM_GAP = 16;
  var ROOM_MIN = 360;
  // Висота рядка колонок: від його верху (або липкого верху, коли сторінку прокручено) до низу вікна мінус відступ.
  function roomHeight(viewportH, colsTop, stickyTop, gap) {
    var top = Math.max(Number(colsTop) || 0, Number(stickyTop) || 0);
    var g = gap == null ? ROOM_GAP : gap;
    return Math.max(ROOM_MIN, Math.round(Number(viewportH) - top - g));
  }
  var WATCH = ['#main-app', '#sticky-top', '#tc-kpi-bar', '#studio-columns', '#demo-banner', '#billing-banner', '#onboard-banner', '.kp-shell-strip', '#kp-shell-top'];
  // Одна функція для сайту й Контроль+: пише --lm-room (меню, панель і мапа однієї висоти). Перераховує на resize, scroll і зміну розмірів
  // сторінки (демо-банер, банер «Налаштування», згортання меню CRM) через ResizeObserver; на ≤900px змінну прибирає (там висоти з CSS).
  function bindHeight(win, doc) {
    var root = doc.documentElement;
    var raf = 0;
    function schedule() {
      if (raf) return;
      raf = 1;
      win.requestAnimationFrame(function () { raf = 0; measure(); });
    }
    function measure() {
      var cols = doc.getElementById('studio-columns');
      if (!cols) return null;
      if (win.innerWidth <= 900) { root.style.removeProperty('--lm-room'); return null; }
      var nav = doc.getElementById('tc-calc-nav');
      var sticky = nav && win.getComputedStyle ? parseFloat(win.getComputedStyle(nav).top) || 0 : 0;
      var h = roomHeight(win.innerHeight, cols.getBoundingClientRect().top, sticky, ROOM_GAP);
      root.style.setProperty('--lm-room', h + 'px');
      return h;
    }
    var seen = [];
    var ro = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
    function observeAll() {
      if (!ro) return;
      WATCH.forEach(function (sel) {
        var el = doc.querySelector(sel);
        if (el && seen.indexOf(el) < 0) { seen.push(el); ro.observe(el); }
      });
    }
    observeAll();
    if (ro && doc.body) ro.observe(doc.body);
    win.addEventListener('resize', schedule);
    win.addEventListener('scroll', schedule, { passive: true });
    var mo = null;
    if (win.MutationObserver && doc.body) {
      // Банери з'являються/зникають (hidden, клас), каркас Контроль+ додає вузли: нові спостерігаємо й міряємо наново.
      mo = new win.MutationObserver(function () { observeAll(); schedule(); });
      mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    }
    measure();
    return { measure: measure, disconnect: function () { if (ro) ro.disconnect(); if (mo) mo.disconnect(); win.removeEventListener('resize', schedule); win.removeEventListener('scroll', schedule); } };
  }

  var lib = {
    roomHeight: roomHeight,
    bindHeight: bindHeight,
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_KEY: DEFAULT_KEY,
    SECTIONS: SECTIONS,
    keys: keys,
    sectionMeta: sectionMeta,
    normalizeKey: normalizeKey,
    readKey: readKey,
    writeKey: writeKey,
    stepKey: stepKey,
    cityOf: cityOf,
    routeSummary: routeSummary,
    recentSummary: recentSummary,
    vehicleSummary: vehicleSummary,
    costsSummary: costsSummary,
    mount: mount
  };
  root.TCCalcMenu = lib;
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
})(typeof window !== 'undefined' ? window : globalThis);
