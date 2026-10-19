/* Лендинг trip-control.com: навігація, приклад, тарифи й панель «Спробувати розрахунок».
   Панель — лише форма, валідація як у застосунку і чернетка в localStorage (tc_draft_trip).
   У браузері гостя нічого не рахуємо і сервер розрахунку не викликаємо: після «Розрахувати» — замок і реєстрація.
   Адреси й відстань — через наш /api/poi (OpenStreetMap), див. assets/osm-geo.js. */
(function () {
  'use strict';
  var DRAFT_KEY = 'tc_draft_trip';
  var STEPS = 5;
  var STEP_TITLES = ['', 'Маршрут', 'Вантаж і тариф', 'Пальне', 'Додатково', 'Норми авто'];
  // Як REQUIRED_FIELDS у застосунку: значення має бути більше 0 (обсяг не потрібен для разового рейсу).
  var REQUIRED = [['dist', 'Відстань'], ['volume', 'Обсяг'], ['norm-weight', 'Норма завантаження'], ['cars-count', 'Кількість авто'],
    ['days-per-trip', 'Днів на рейс'], ['rate', 'Ставка'], ['fuel-load', 'Витрата з вантажем'], ['fuel-empty', 'Витрата порожнім'],
    ['fuel-price', 'Ціна палива'], ['total-fleet', 'Авто в парку'], ['to-period', 'Пробіг між ТО'], ['tire-mileage', 'Ресурс шин']];

  function num(value) {
    return parseFloat(String(value == null ? '' : value).replace(',', '.'));
  }
  // Кнопки кроку: «Назад» з кроку 2, «Далі» на 1–4, «Розрахувати» лише на 5.
  function stepButtons(step) {
    return { backHidden: step === 1, nextHidden: step === STEPS, calcHidden: step !== STEPS };
  }
  function missingRequired(values, oneOff) {
    return REQUIRED.filter(function (pair) {
      return !(oneOff && pair[0] === 'volume') && !(num(values[pair[0]]) > 0);
    });
  }
  // Значення з чернетки для поля: старі нулі в полях з data-zero показуємо порожніми.
  function draftValue(value, zeroBlank) {
    var v = value == null ? '' : String(value);
    return zeroBlank && v.trim() !== '' && num(v) === 0 ? '' : v;
  }
  window.TcLanding = { DRAFT_KEY: DRAFT_KEY, REQUIRED: REQUIRED, stepButtons: stepButtons, missingRequired: missingRequired, draftValue: draftValue };

  var root = document.getElementById('landing-screen');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || root).querySelectorAll(sel)); };
  var geo = window.TcOsmGeo && window.TcOsmGeo.enabled ? window.TcOsmGeo : null;

  // ---- Шапка: бургер, якорі ----
  var burger = $('lp-burger'), mnav = $('lp-mnav');
  function setNav(open) { if (!burger) return; burger.setAttribute('aria-expanded', String(open)); mnav.hidden = !open; }
  if (burger) burger.addEventListener('click', function () { setNav(mnav.hidden); });
  $$('a[href^="#"]').forEach(function (a) {
    if (a.hasAttribute('data-auth') || a.hasAttribute('data-try')) return;
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      var target = id ? document.getElementById(id) : null;
      if (!target || !root.contains(target)) return;
      e.preventDefault();
      setNav(false);
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ---- Вхід / реєстрація: існуюча форма застосунку ----
  $$('[data-auth]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      setNav(false); hideLock();
      if (!panel.hidden) closeTry(true);
      if (typeof window.openAuthFromLanding === 'function') window.openAuthFromLanding(el.getAttribute('data-auth'));
    });
  });

  // ---- FAQ: одне відкрите питання ----
  $$('.lp-faq details').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) $$('.lp-faq details').forEach(function (o) { if (o !== d) o.open = false; });
    });
  });

  // ---- Приклад: сірі поля → підказка про реєстрацію; розкриття каскаду ----
  var lock = $('lp-lock-toast'), lockTimer = null;
  function showLock() { if (!lock) return; lock.classList.add('lp-show'); clearTimeout(lockTimer); lockTimer = setTimeout(hideLock, 6000); }
  function hideLock() { if (!lock) return; lock.classList.remove('lp-show'); clearTimeout(lockTimer); }
  if ($('lp-ex-fields')) $('lp-ex-fields').addEventListener('click', showLock);
  $$('[data-close-lock]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); hideLock(); }); });
  $$('.lp-casc-x').forEach(function (b) {
    b.addEventListener('click', function () {
      var det = document.getElementById(b.getAttribute('aria-controls'));
      var open = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(open)); det.hidden = !open;
    });
  });

  // ---- Тарифи: місяць / рік (lib/billing/plans.js: 250 грн / 2 500 грн) ----
  var PLANS = {
    month: { name: 'Місяць', amt: '250', unit: 'грн / міс', save: '' },
    year: { name: 'Рік', amt: '2 500', unit: 'грн / рік', save: '2 місяці в подарунок: 2 500 грн замість 3 000 грн' }
  };
  $$('.lp-bill-toggle button').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = PLANS[b.getAttribute('data-period')];
      $$('.lp-bill-toggle button').forEach(function (o) { var on = o === b; o.classList.toggle('lp-on', on); o.setAttribute('aria-selected', String(on)); });
      $('lp-plan-name').textContent = p.name; $('lp-plan-amt').textContent = p.amt;
      $('lp-plan-unit').textContent = p.unit; $('lp-plan-save').textContent = p.save;
    });
  });

  // ---- Панель «Спробувати розрахунок» ----
  var panel = $('try-panel');
  var form = $('try-form');
  var field = function (id) { return $('t-' + id); };
  var step = 1, lastFocus = null;

  function showStep(n, focusTab) {
    step = Math.max(1, Math.min(STEPS, n));
    for (var i = 1; i <= STEPS; i++) {
      var on = i === step, tab = $('t-tab-' + i);
      $('t-panel-' + i).hidden = !on;
      tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1;
    }
    $('t-step-title').textContent = STEP_TITLES[step];
    $('t-step-kicker').textContent = 'Крок ' + step + ' з ' + STEPS;
    var buttons = stepButtons(step);
    $('t-back').hidden = buttons.backHidden; $('t-next').hidden = buttons.nextHidden; $('t-calc').hidden = buttons.calcHidden;
    var t = $('t-tab-' + step);
    if (focusTab) t.focus();
    if (t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $$('.lp-t-tab', panel).forEach(function (tab) {
    tab.addEventListener('click', function () { showStep(parseInt(tab.getAttribute('data-step'), 10)); });
  });
  panel.querySelector('.lp-t-tabs').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); showStep(step + 1, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); showStep(step - 1, true); }
  });
  $('t-back').addEventListener('click', function () { showStep(step - 1); });
  $('t-next').addEventListener('click', function () { showStep(step + 1); });

  // Підказки до річних накладних (крок 5) — ті самі тексти, що й у кабінеті (assets/cost-hints.js).
  function addCostHints() {
    var hints = window.TcCostHints;
    if (!hints) return;
    Object.keys(hints.ids).forEach(function (id) {
      var key = hints.ids[id], input = field(id);
      var row = input ? input.closest('.lp-form-row') : null;
      var label = row ? row.querySelector('label') : null;
      if (!label || row.querySelector('.tc-hint-btn')) return;
      var head = document.createElement('span');
      head.className = 'lp-hint-head';
      label.parentNode.insertBefore(head, label);
      head.appendChild(label);
      head.insertAdjacentHTML('beforeend', hints.button(key, 'lp-hint-', label.textContent));
      row.insertAdjacentHTML('afterend', hints.text(key, 'lp-hint-'));
    });
    var group = $$('.lp-t-group', panel).filter(function (g) { return /накладні/.test(g.textContent); })[0];
    if (group && !$('lp-cost-intro')) {
      group.insertAdjacentHTML('afterend', '<p class="lp-t-note" id="lp-cost-intro"></p>');
      $('lp-cost-intro').textContent = hints.intro;
    }
  }
  addCostHints();

  // Поля, що з'являються залежно від вибору (як у застосунку)
  function syncVisibility() {
    var trailer = field('trailer-type').value, pay = field('driver-pay-mode').value, adblue = field('adblue-enable').value;
    $$('[data-show]', panel).forEach(function (row) {
      var k = row.getAttribute('data-show');
      row.hidden = !((k === 'ref' && trailer === 'рефрижератор') || (k === 'wash' && trailer === 'цистерна') ||
        (k === 'adblue' && adblue === 'on') || (k === 'km' && pay === 'km') || (k === 'pct' && pay === 'pct'));
    });
    $('t-round-box').hidden = field('round-trip-enable').value !== 'on';
    $('t-extras-box').hidden = field('extras-enable').value !== 'on';
    var c = field('contract-currency').value, unit = c === 'UAH' ? 'грн' : c;
    $('t-rate-unit').textContent = unit + '/т'; $('t-rt-unit').textContent = unit + '/т'; $('t-idle-unit').textContent = unit + '/доба';
    ['t-u-toll', 't-u-border', 't-u-broker', 't-u-green', 't-u-ferry'].forEach(function (id) { $(id).textContent = unit; });
    $('t-fx-note').textContent = c === 'UAH'
      ? 'Розцінка, простій, зворотний вантаж і супутні витрати. Решта витрат компанії лишається в гривні.'
      : 'Розцінка, простій, зворотний вантаж і супутні витрати в ' + c + ' за курсом НБУ. Решта витрат компанії лишається в гривні.';
  }

  // Чернетка
  function saveDraft() {
    var data = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) data[el.name] = el.value; });
    data._step = step;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) { /* приватний режим */ }
  }
  function loadDraft() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') return false;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !Object.prototype.hasOwnProperty.call(data, el.name)) return;
      var v = String(data[el.name] == null ? '' : data[el.name]);
      if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) return;
      var value = draftValue(v, el.hasAttribute('data-zero'));
      // «ТО та шини» мають значення за замовчуванням: порожнє з чернетки його не стирає.
      if (value.trim() === '' && el.hasAttribute('data-default')) value = el.getAttribute('data-default');
      el.value = value;
    });
    if (data._step) step = parseInt(data._step, 10) || 1;
    return true;
  }

  // Валідація як у застосунку: підсвічені поля + підказка зі списком
  function formValues() {
    var values = {};
    REQUIRED.forEach(function (pair) { values[pair[0]] = field(pair[0]).value; });
    return values;
  }
  function missingFields() {
    return missingRequired(formValues(), field('return-mode').value === 'разовий');
  }
  function stepOf(input) { var p = input.closest('.lp-t-panel'); return p ? parseInt(p.id.replace('t-panel-', ''), 10) : 0; }
  function markInvalid(missing) {
    $$('.lp-tc-invalid', panel).forEach(function (r) { r.classList.remove('lp-tc-invalid'); });
    $$('[aria-invalid]', panel).forEach(function (el) { el.removeAttribute('aria-invalid'); });
    $$('.lp-t-tab.lp-is-invalid', panel).forEach(function (t) { t.classList.remove('lp-is-invalid'); });
    missing.forEach(function (pair) {
      var input = field(pair[0]); input.setAttribute('aria-invalid', 'true');
      input.closest('.lp-form-row').classList.add('lp-tc-invalid');
      $('t-tab-' + stepOf(input)).classList.add('lp-is-invalid');
    });
    var hint = $('t-hint');
    hint.textContent = '';
    if (!missing.length) { hint.hidden = true; return; }
    hint.appendChild(document.createTextNode('⚠️ Підсвічено поля, без яких рахувати не можна: '));
    missing.forEach(function (pair, i) {
      if (i) hint.appendChild(document.createTextNode(', '));
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'lp-link-btn'; b.setAttribute('data-goto', pair[0]); b.textContent = pair[1];
      hint.appendChild(b);
    });
    hint.appendChild(document.createTextNode('.'));
    hint.hidden = false;
  }
  $('t-hint').addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto]'); if (!b) return;
    var input = field(b.getAttribute('data-goto')); showStep(stepOf(input)); input.focus();
  });

  function setResult(locked) {
    $('res-empty').hidden = locked; $('res-locked').hidden = !locked;
  }
  form.addEventListener('input', function (e) {
    saveDraft();
    var row = e.target.closest('.lp-form-row');
    if (row && row.classList.contains('lp-tc-invalid') && num(e.target.value) > 0) {
      markInvalid(missingFields().filter(function (pair) { return field(pair[0]).closest('.lp-form-row').classList.contains('lp-tc-invalid'); }));
    }
    setResult(false);
  });
  form.addEventListener('change', function () { syncVisibility(); saveDraft(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (step < STEPS) { showStep(step + 1); return; } // Enter на кроках 1–4 працює як «Далі»
    var missing = missingFields();
    markInvalid(missing);
    if (missing.length) {
      setResult(false);
      var first = field(missing[0][0]); showStep(stepOf(first)); first.focus();
      return;
    }
    saveDraft();
    setResult(true);
    var res = $('try-res');
    if (res.scrollIntoView) res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function openTry() {
    lastFocus = document.activeElement;
    setNav(false); hideLock();
    loadDraft(); syncVisibility(); showStep(step);
    panel.hidden = false; document.body.classList.add('lp-try-open');
    $('t-tab-' + step).focus();
  }
  function closeTry(silent) {
    panel.hidden = true; document.body.classList.remove('lp-try-open');
    if (!silent && lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $$('[data-try]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); openTry(); });
  });
  panel.querySelector('[data-try-close]').addEventListener('click', function () { closeTry(); });
  panel.addEventListener('click', function (e) { if (e.target === panel) closeTry(); });
  // Фокус не виходить за межі діалогу
  panel.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var items = $$('button, input, select, a[href]', panel).filter(function (el) {
      return !el.disabled && el.offsetParent !== null && el.tabIndex !== -1;
    });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.documentElement.getAttribute('data-screen') !== 'landing') return;
    if (!panel.hidden) closeTry();
    else { hideLock(); setNav(false); }
  });

  // ---- Адреси й відстань (OpenStreetMap через /api/poi) ----
  var routeSeq = 0;
  function setStatus(text, tone) {
    var el = $('t-route-status'); el.textContent = text || '';
    el.className = 'lp-t-route-status' + (tone ? ' lp-is-' + tone : '');
  }
  function coordsOf(id) { return geo ? geo.parsePoint(field(id + '-coords').value) : null; }
  function setNumber(id, km) {
    var el = field(id); el.value = String(km);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function recomputeRoute() {
    var a = coordsOf('osm-from'), b = coordsOf('osm-to'), base = coordsOf('osm-base');
    if (!geo || !a || !b) return;
    var seq = ++routeSeq;
    setStatus('Рахую відстань…', 'wait');
    geo.route({ from: a, to: b, base: base }).then(function (r) {
      if (seq !== routeSeq) return;
      var parts = [];
      setNumber('dist', r.km); parts.push('Відстань за дорогами: ' + r.km + ' км');
      if (base && r.podacha_km != null) { setNumber('podacha-dist', r.podacha_km); parts.push('Подача: ' + r.podacha_km + ' км'); }
      setStatus(parts.join(' · '), 'ok');
    }).catch(function () {
      if (seq !== routeSeq) return;
      setStatus(geo.FAIL, 'err');
    });
  }
  ['osm-base', 'osm-from', 'osm-to'].forEach(function (id) {
    var input = field(id), coords = field(id + '-coords'), list = $('t-' + id + '-list');
    if (!geo) {
      input.removeAttribute('role'); input.removeAttribute('aria-autocomplete');
      input.removeAttribute('aria-expanded'); input.removeAttribute('aria-controls');
      return;
    }
    geo.attachAutocomplete({
      input: input,
      list: list,
      onEdit: function () { coords.value = ''; },
      onPick: function (item) {
        coords.value = item.lat + ',' + item.lon;
        saveDraft(); setResult(false);
        recomputeRoute();
      }
    });
  });
  $('t-swap').addEventListener('click', function () {
    var a = field('osm-from'), b = field('osm-to'), ac = field('osm-from-coords'), bc = field('osm-to-coords');
    var t = a.value; a.value = b.value; b.value = t;
    t = ac.value; ac.value = bc.value; bc.value = t;
    saveDraft(); setResult(false);
    recomputeRoute();
  });
  if (!geo) {
    $$('.lp-osm-only', panel).forEach(function (el) { el.hidden = true; });
  }

  loadDraft(); syncVisibility(); showStep(step);
})();
