/* Сторінки /kontrol-plus і /park-control: перемикач теми та форма заявки (наявний POST /api/kp-lead).
   Атрибути форми: data-lead-endpoint — адреса, data-lead-prefix — позначка продукту на початку коментаря. */
(function () {
  var root = document.documentElement;
  var themeBtn = document.getElementById('kp-theme');
  function label() { if (themeBtn) themeBtn.textContent = root.getAttribute('data-theme') === 'dark' ? 'Light' : 'Dark'; }
  if (themeBtn) {
    label();
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', next === 'dark' ? '#0E1117' : '#F4EFE4');
      try { localStorage.setItem('tc_theme', next); } catch (e) {}
      label();
    });
  }

  var form = document.getElementById('kp-form');
  if (!form) return;
  var statusEl = document.getElementById('kp-status');
  var submit = document.getElementById('kp-submit');
  var endpoint = form.getAttribute('data-lead-endpoint') || '/api/kp-lead';
  var prefix = form.getAttribute('data-lead-prefix') || '';
  function setErrors(errors) {
    form.querySelectorAll('[data-err]').forEach(function (el) { el.textContent = (errors && errors[el.getAttribute('data-err')]) || ''; });
  }
  function localErrors(d) {
    var e = {};
    if (!d.name) e.name = 'Вкажіть ім’я.';
    if (!d.company) e.company = 'Вкажіть компанію.';
    var digits = d.phone.replace(/\D/g, '');
    if (!d.phone || digits.length < 9 || digits.length > 15) e.phone = 'Вкажіть коректний телефон.';
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) e.email = 'Некоректний email.';
    if (d.vehicles && !/^\d+$/.test(d.vehicles)) e.vehicles = 'Кількість машин — ціле число.';
    if (!d.consent) e.consent = 'Потрібна згода з політикою конфіденційності.';
    return e;
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = form.elements;
    var data = {
      name: f.name.value.trim(), company: f.company.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(),
      vehicles: f.vehicles.value.trim(), comment: f.comment.value.trim(), website: f.website.value, consent: f.consent.checked
    };
    var errors = localErrors(data);
    setErrors(errors);
    statusEl.textContent = ''; statusEl.className = 'kp-status';
    if (Object.keys(errors).length) { statusEl.textContent = 'Перевірте виділені поля.'; statusEl.className = 'kp-status is-error'; return; }
    if (prefix) data.comment = (prefix + (data.comment ? '\n' + data.comment : '')).slice(0, 2000);
    submit.disabled = true;
    fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.ok) {
          form.hidden = true;
          document.getElementById('kp-thanks').hidden = false;
          return;
        }
        if (res.body && res.body.errors) setErrors(res.body.errors);
        statusEl.textContent = res.status === 429 ? 'Забагато спроб. Спробуйте за хвилину.' : (res.body && res.body.error) || 'Не вдалося надіслати. Спробуйте ще раз.';
        statusEl.className = 'kp-status is-error';
        submit.disabled = false;
      })
      .catch(function () {
        statusEl.textContent = 'Немає звʼязку. Спробуйте ще раз або напишіть на support@trip-control.com.';
        statusEl.className = 'kp-status is-error';
        submit.disabled = false;
      });
  });
})();
