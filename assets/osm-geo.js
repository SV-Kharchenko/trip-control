/* Адреси й відстань за OpenStreetMap для лендингу й демо-акаунтів.
   Браузер ходить лише на наш /api/poi?mode=geocode|route (проксі Photon / OSRM, без ключів), ніколи напряму.
   OSM_GEO = false вимикає підказки й відстань: лишається ручне введення км. Платні акаунти — Google, тут не задіяні. */
(function () {
  'use strict';
  var OSM_GEO = true;
  var MIN_CHARS = 3;
  var DEBOUNCE_MS = 300;
  var cache = new Map();

  // Той самий ключ CDN-кешу, що й на сервері: trim + один пробіл + нижній регістр; координати — 4 знаки.
  function normalizeQuery(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function roundCoord(value) {
    return (Math.round(Number(value) * 10000) / 10000).toFixed(4).replace(/\.?0+$/, '');
  }
  function pointParam(point) {
    return roundCoord(point.lat) + ',' + roundCoord(point.lon);
  }
  function parsePoint(value) {
    var parts = String(value || '').split(',');
    var lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    return parts.length === 2 && isFinite(lat) && isFinite(lon) ? { lat: lat, lon: lon } : null;
  }
  function getJson(url, signal) {
    return fetch(url, signal ? { signal: signal } : undefined).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) {
          var err = new Error((body && body.error) || ('HTTP ' + r.status));
          err.code = (body && body.code) || 'GEO_UNAVAILABLE';
          throw err;
        }
        return body;
      });
    });
  }

  function geocode(q, signal) {
    var key = normalizeQuery(q);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return getJson('/api/poi?mode=geocode&q=' + encodeURIComponent(key), signal).then(function (body) {
      var items = body && Array.isArray(body.items) ? body.items : [];
      cache.set(key, items);
      return items;
    });
  }

  // { from, to, base? } — точки { lat, lon } → { km, podacha_km? }
  function route(points) {
    var url = '/api/poi?mode=route&from=' + pointParam(points.from) + '&to=' + pointParam(points.to);
    if (points.base) url += '&base=' + pointParam(points.base);
    return getJson(url);
  }

  // Комбобокс: <input role="combobox"> + <ul role="listbox">; ↑/↓/Enter/Esc, мінімум 3 символи, debounce 300 мс.
  // onPick(item) — обрано підказку; onEdit() — текст змінено вручну (координати вже не відповідають).
  function attachAutocomplete(opts) {
    var input = opts.input, list = opts.list;
    var timer = null, ctrl = null, items = [], active = -1;
    var idBase = list.id || ('tc-ac-' + Math.random().toString(36).slice(2));
    function close() {
      list.hidden = true; list.innerHTML = ''; items = []; active = -1;
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    }
    function highlight(i) {
      active = i;
      [].forEach.call(list.children, function (li, k) {
        li.classList.toggle('on', k === i); li.setAttribute('aria-selected', String(k === i));
      });
      var li = i >= 0 ? list.querySelector('#' + idBase + '-opt-' + i) : null;
      if (li) { input.setAttribute('aria-activedescendant', li.id); if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function choose(i) {
      var it = items[i]; if (!it) return;
      input.value = it.label;
      close();
      opts.onPick(it);
    }
    function render(msg) {
      list.innerHTML = '';
      if (msg) {
        var m = document.createElement('li'); m.className = 'tc-ac-msg'; m.setAttribute('role', 'presentation');
        m.textContent = msg; list.appendChild(m);
      }
      items.forEach(function (it, i) {
        var li = document.createElement('li');
        li.id = idBase + '-opt-' + i; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
        var b = document.createElement('b'); b.textContent = it.name; li.appendChild(b);
        var sub = it.label.indexOf(it.name + ', ') === 0 ? it.label.slice(it.name.length + 2) : '';
        if (sub) { var sm = document.createElement('small'); sm.textContent = sub; li.appendChild(sm); }
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = !list.children.length;
      input.setAttribute('aria-expanded', String(!list.hidden));
      active = -1;
    }
    function search(q) {
      if (ctrl) ctrl.abort();
      ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      geocode(q, ctrl ? ctrl.signal : undefined).then(function (found) {
        if (normalizeQuery(input.value) !== normalizeQuery(q)) return;
        items = found;
        render(items.length ? '' : 'Нічого не знайшли, спробуй інакше');
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        items = []; render('Підказки недоступні, введи відстань вручну');
      });
    }
    input.addEventListener('input', function () {
      if (opts.onEdit) opts.onEdit();
      var q = input.value.trim();
      clearTimeout(timer);
      if (!OSM_GEO || q.length < MIN_CHARS) { if (ctrl) ctrl.abort(); close(); return; }
      timer = setTimeout(function () { search(q); }, DEBOUNCE_MS);
    });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      var n = items.length;
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); highlight((active + 1) % n); }
      else if (e.key === 'ArrowUp' && n) { e.preventDefault(); highlight(active <= 0 ? n - 1 : active - 1); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopPropagation(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') close();
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    return { close: close };
  }

  window.TcOsmGeo = {
    enabled: OSM_GEO,
    attachAutocomplete: attachAutocomplete,
    route: route,
    parsePoint: parsePoint,
    pointParam: pointParam,
    normalizeQuery: normalizeQuery,
    ATTRIBUTION: '© OpenStreetMap contributors',
    HINT: 'Відстань за OpenStreetMap, можна виправити',
    FAIL: 'Не вдалося визначити відстань — введи вручну, км'
  };
})();
