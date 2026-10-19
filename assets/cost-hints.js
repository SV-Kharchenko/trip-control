/* Підказки до річних накладних (кабінет → «Витратна частина» і крок 5 панелі на лендингу).
   Тексти — лише тут, в одному об'єкті. Однакові для ФОП і ТОВ. Формули не змінюють (api/calculate.js:
   кожна сума ділиться на кількість авто × 300 робочих днів і множиться на дні рейсу). */
(function () {
  'use strict';
  var COST_HINTS = {
    intro: 'Усі суми в цьому блоці — річні, на весь парк. Ми поділимо їх на кількість авто й 300 робочих днів і віднесемо на дні рейсу. Паливо, ТО, шини, водія, дороги й податок з виручки сюди не вносьте — їх уже пораховано',
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

  function toggle(button) {
    var panel = document.getElementById(button.getAttribute('aria-controls'));
    if (!panel) return;
    var open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (e) {
      var button = e.target && e.target.closest ? e.target.closest('.tc-hint-btn') : null;
      if (!button) return;
      e.preventDefault();
      toggle(button);
    });
  }

  window.TcCostHints = {
    intro: COST_HINTS.intro,
    fields: COST_HINTS.fields,
    ids: COST_HINTS.ids,
    button: hintButton,
    text: hintText,
    toggle: toggle
  };
})();
