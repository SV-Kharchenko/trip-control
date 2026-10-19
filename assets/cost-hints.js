/* Підказки до річних накладних (кабінет → «Витратна частина» і крок 5 панелі на лендингу).
   Тексти — лише тут, в одному об'єкті. Однакові для ФОП і ТОВ. Формули не змінюють.
   «?» відкриває текст кліком / тапом; Esc або клік поза підказкою її закриває. Стилі — assets/cost-hints.css. */
(function () {
  'use strict';
  var COST_HINTS = {
    intro: 'Усі суми в цьому блоці — річні, на весь парк. Паливо, ТО, шини, водія, дороги й податок з виручки сюди не вносьте — вони рахуються в окремих полях.',
    fields: {
      admin: 'Річна сума: бухгалтер чи аутсорс, зарплата диспетчера або логіста, офіс і оренда, зв\'язок та інтернет офісу, банк і РКО, CRM і програми, канцтовари',
      otherOperating: 'Річна сума: стоянки й охоронювані майданчики, страховки (ОСЦПВ, КАСКО, CMR), тахограф і калібрування, GPS-трекінг, телефони водіїв, ліцензії й дозволи, техогляд, мийка',
      otherExpenses: 'Річна сума: фіксовані податки й внески (наприклад, ЄСВ ФОП за себе, транспортний податок), штрафи, юристи, реклама, біржі вантажів (Lardi, Della), членські внески. Податок з виручки рейсу сюди не вносьте',
      repair: 'Річна сума: позапланові ремонти поза ТО — ходова, електрика, кузов і причіп, евакуатор, шиномонтаж',
      amort: 'Річна сума: вартість авто й причепа, поділена на кількість років, які ви плануєте їх експлуатувати',
      fin: 'Річна сума: відсотки за кредитом чи лізингом і банківські комісії. Тіло кредиту не вносьте'
    },
    // id полів у формі (той самий id у калькуляторі й name у панелі лендингу) → ключ підказки
    ids: {
      'overhead-amort': 'amort',
      'overhead-admin': 'admin',
      'overhead-other-op': 'otherOperating',
      'overhead-other': 'otherExpenses',
      'overhead-repair': 'repair',
      'overhead-fin': 'fin'
    }
  };

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Кнопка «?» біля підпису; текст — окремим блоком під полем (hintText), відкривається кліком / тапом.
  function hintButton(key, idPrefix, label) {
    return '<button type="button" class="tc-hint-btn" aria-expanded="false" aria-controls="' + idPrefix + key
      + '" aria-label="Підказка: ' + esc(label || '') + '">?</button>';
  }
  function hintText(key, idPrefix) {
    return '<p class="tc-hint-text" id="' + idPrefix + key + '" hidden>' + esc(COST_HINTS.fields[key]) + '</p>';
  }

  function setOpen(button, open) {
    var panel = document.getElementById(button.getAttribute('aria-controls'));
    if (!panel) return false;
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    return true;
  }
  function toggle(button) {
    setOpen(button, button.getAttribute('aria-expanded') !== 'true');
  }
  function openButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('.tc-hint-btn[aria-expanded="true"]'));
  }
  // Закриває всі відкриті підказки; повертає закриті кнопки (для повернення фокусу).
  function closeAll() {
    return openButtons().filter(function (button) { return setOpen(button, false); });
  }
  function onClick(e) {
    var target = e.target && e.target.closest ? e.target : null;
    var button = target ? target.closest('.tc-hint-btn') : null;
    if (button) {
      e.preventDefault();
      toggle(button);
      return;
    }
    // Клік поза «?» і поза текстом підказки закриває всі підказки.
    if (!target || !target.closest('.tc-hint-text')) closeAll();
  }
  // Esc: закриває відкриту підказку й зупиняє подію (діалог «Спробувати розрахунок» лишається відкритим),
  // фокус — назад на її «?». Слухаємо у фазі перехоплення, щоб спрацювати раніше за Esc панелі.
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    var active = document.activeElement;
    var current = active && active.closest ? active.closest('.tc-hint-btn') : null;
    var closed = closeAll();
    if (!closed.length) return;
    e.preventDefault();
    e.stopPropagation();
    var focusTo = current && closed.indexOf(current) >= 0 ? current : closed[closed.length - 1];
    if (focusTo && focusTo.focus) focusTo.focus();
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown, true);
  }

  window.TcCostHints = {
    intro: COST_HINTS.intro,
    fields: COST_HINTS.fields,
    ids: COST_HINTS.ids,
    button: hintButton,
    text: hintText,
    toggle: toggle,
    closeAll: closeAll,
    onClick: onClick,
    onKeydown: onKeydown
  };
})();
