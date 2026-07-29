/* ═══ ПОПАП МЕНЕДЖЕРА: рендер + поведение ═══
   Один модуль на две поверхности: popup.html (как всплывает в amoCRM) и
   <dialog> на странице разбора. Данные — только из verdict.js (общий источник).
   Требует: tokens.css, popup.css, verdict.js. Классические скрипты (работает с file://). */

var POPUP_ACW_SECONDS = 12 * 60; // авто-приём оценки: линия не встаёт, если менеджер не нажал

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Демо-состояния: канон промта даёт три исхода попапа (обычный / продолжение / отказ) */
var POPUP_STATES = [
  { key: 'normal',  label: 'Обычный' },
  { key: 'partial', label: 'Продолжение' },
  { key: 'refusal', label: 'Отказ' }
];

var REFUSAL_DEMO = {
  quote: 'Не звоните мне больше, я ничего не буду оформлять',
  note: 'демо: реплика из другого звонка — в этом отказа не было'
};
var PARTIAL_DEMO = { when: 'завтра, 11:00' };

function renderPopup(root, opts) {
  opts = opts || {};
  var state = opts.state || 'normal';
  var totals = computeTotals(VERDICT);
  var acw = POPUP_ACW_SECONDS;
  var timerId = null;
  var acted = false;

  function missingChips(limit) {
    return totals.missing.slice(0, limit || 99).map(function (k) {
      var g = GATE_LABELS[k];
      var short = g.label.split(/[(,]/)[0].trim();
      return '<span class="chip' + (g.critical ? ' crit' : '') + '">' + esc(g.n + ' · ' + short) + '</span>';
    }).join('');
  }

  function headHTML() {
    var st = POPUP_STATES.map(function (s) {
      return '<button type="button" data-state="' + s.key + '" aria-pressed="' + (s.key === state) + '">' + esc(s.label) + '</button>';
    }).join('');
    return '' +
      '<div class="pop-top">' +
        '<div class="row">' +
          '<div>' +
            '<div class="who">' + esc(CALL.client) + ' · ' + esc(CALL.time) + ' · ' + mmss(CALL.duration_s) + '</div>' +
            '<div class="meta">Оценка ИИ ' + esc(CALL.prompt_version) + ' · сделка #' + esc(CALL.lead_id) + ' · <span class="demo-tag">ДЕМО-ЗВОНОК</span></div>' +
          '</div>' +
          '<button type="button" class="pop-later" data-act="later">Позже</button>' +
        '</div>' +
        '<div class="pop-states" role="group" aria-label="Состояние попапа (демо)">' + st + '</div>' +
      '</div>';
  }

  function scoreHTML() {
    var segs = totals.parts.map(function (p) {
      var pct = Math.round(p.val / p.max * 100);
      var cls = p.val === 0 ? ' zero' : (pct < 70 ? ' part' : '');
      return '<div class="seg' + cls + '" style="flex:' + p.max + '" title="' + esc(p.label + ': ' + p.val + ' из ' + p.max) + '"><i style="width:' + pct + '%"></i></div>';
    }).join('');
    var legend = totals.parts.map(function (p, i) {
      var nm = SCORE_PARTS[i].short || p.label;
      return '<span style="flex:' + p.max + '">' + esc(nm) + ' <b>' + p.val + '</b></span>';
    }).join('');
    return '' +
      '<div>' +
        '<div class="pop-score">' +
          '<div class="big num">' + totals.score + '</div><div class="of">/ 100</div>' +
          '<div class="goal">до цели <b class="num">' + (THRESHOLDS.target - totals.score) + ' баллов</b>порог без штрафа ' + THRESHOLDS.floor + '</div>' +
        '</div>' +
        '<div class="bar">' + segs + '</div>' +
        '<div class="bar-legend">' + legend + '</div>' +
      '</div>';
  }

  function gateHTML() {
    if (totals.gatePassed) {
      return '<div class="plate good"><div class="h"><span class="ic">✓</span>Консультация состоялась — гейт ' +
        totals.collected + '/16</div><p>Лид закреплён за тобой, окна ответственности пошли.</p></div>';
    }
    return '<div class="plate bad"><div class="h"><span class="ic">✕</span>Консультация НЕ состоялась — собрано ' +
      totals.collected + ' из 16</div><p>Пустой лид не закрепляется: добери пункты в следующем звонке.</p>' +
      '<div class="chips">' + missingChips() + '</div></div>';
  }

  function lockHTML() {
    var lc = VERDICT.lead_check;
    if (lc.normal_lead && !lc.valid_close_reason) {
      return '<div class="plate flat"><div class="h"><span class="ic">🔒</span>Этот лид закрыть нельзя</div>' +
        '<p>Клиент живой и наш, оснований для закрытия в записи нет. Закроешь — лид вернётся в работу, тебе придёт разбор.</p>' +
        '<q>«' + esc(lc.interest_signals[0]) + '»</q></div>';
    }
    return '<div class="plate gray"><div class="h"><span class="ic">🔓</span>Право закрыть есть</div><p>' +
      esc(lc.close_reason_quote || 'Основание зафиксировано в записи.') + '</p></div>';
  }

  function complianceHTML() {
    if (!VERDICT.compliance_flags.length) return '';
    var f = VERDICT.compliance_flags[0];
    return '<div class="plate warn"><div class="h"><span class="ic">⚠</span>Красная линия · класс ' + f.class_id + ': ' + esc(f.class) + '</div>' +
      '<p>Так предлагать нельзя. Балл не режем, но флаг ушёл РОПу.</p>' +
      '<q>«' + esc(f.quote) + '»</q></div>';
  }

  function mainErrorHTML() {
    return '<div class="pop-main"><div class="lbl">ГЛАВНОЕ</div>' +
      '<div class="txt">Имущество и сделки за 3 года не спрошены — цена названа раньше, чем проверены критичные для суда риски.</div></div>';
  }

  function todoHTML() {
    var steps = VERDICT.next_best_action.replace(/^Завтра в звонке:\s*/, '').split(/\(\d\)\s*/).filter(function (s) { return s.trim(); });
    var li = steps.map(function (s, i) {
      return '<li><b>' + (i + 1) + '</b><span>' + esc(s.replace(/;\s*$/, '').replace(/\.\s*$/, '')) + '</span></li>';
    }).join('');
    return '<div><div class="note-h">Что сделать в следующем звонке</div><ul class="todo">' + li + '</ul></div>';
  }

  function noteHTML() {
    return '<div><div class="note-h">Примечание в карточку<span>«Согласен» без правок — запишется как есть</span></div>' +
      '<textarea class="note" spellcheck="false">' + esc(NOTE_DRAFT) + '</textarea></div>';
  }

  function footHTML() {
    return '' +
      '<div class="pop-foot">' +
        '<button type="button" class="btn btn-primary" data-act="ack">Согласен · записать</button>' +
        '<button type="button" class="btn btn-ghost" data-act="dispute">Не согласен</button>' +
        '<div class="timer">примется сама через <b class="num" data-timer>' + mmss(acw) + '</b></div>' +
        (opts.onFull ? '<button type="button" class="full" data-act="full">Открыть полный разбор звонка →</button>' : '') +
      '</div>';
  }

  function bodyNormal() {
    return '<div class="pop-body">' +
      scoreHTML() + gateHTML() + mainErrorHTML() + lockHTML() + complianceHTML() + todoHTML() + noteHTML() +
      '<div class="dispute" hidden>' +
        '<div class="h">С чем не согласен?</div>' +
        '<div class="sub">Отметь пункт и напиши, что не так — уйдёт РОПу на разбор. Таймкод подставится сам.</div>' +
        '<div class="chips" data-dispute-chips>' +
          '<button type="button" class="chip pick" aria-pressed="false">Гейт 9 · имущество</button>' +
          '<button type="button" class="chip pick" aria-pressed="false">Гейт 10 · сделки</button>' +
          '<button type="button" class="chip pick" aria-pressed="false">Возражение «подумаю»</button>' +
          '<button type="button" class="chip pick" aria-pressed="false">Лестница 4.4</button>' +
          '<button type="button" class="chip pick" aria-pressed="false">Комплаенс класс 4</button>' +
        '</div>' +
        '<textarea placeholder="Что именно не так — обязательно" spellcheck="false"></textarea>' +
        '<div class="err">Нужен и пункт, и комментарий — иначе РОПу нечего разбирать.</div>' +
        '<div class="acts"><button type="button" class="btn btn-primary btn-sm" data-act="dispute-send">Отправить РОПу</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="dispute-cancel">Отмена</button></div>' +
      '</div>' +
    '</div>' + footHTML();
  }

  function bodyPartial() {
    return '<div class="pop-body">' +
      '<div class="plate flat"><div class="h"><span class="ic">⏸</span>Консультация не завершена — вердикта пока нет</div>' +
      '<p>Собрано <b>' + totals.collected + ' из 16</b>. Продолжение: <b>' + esc(PARTIAL_DEMO.when) + '</b>. Балл, рейтинг и жизни не считаются — оценка придёт одна, на завершающем звонке.</p>' +
      '<div class="chips">' + missingChips() + '</div></div>' +
      '<div><div class="note-h">Добери в продолжении</div><ul class="todo">' +
        '<li><b>1</b><span>Имущество и залоги — критично для суда</span></li>' +
        '<li><b>2</b><span>Сделки с имуществом за 3 года</span></li>' +
        '<li><b>3</b><span>Прошлые консультации у конкурентов</span></li>' +
      '</ul></div>' +
      noteHTML() +
    '</div>' +
    '<div class="pop-foot">' +
      '<button type="button" class="btn btn-primary" data-act="ack">Понятно</button>' +
      '<div class="timer">закроется само через <b class="num" data-timer>' + mmss(acw) + '</b></div>' +
      (opts.onFull ? '<button type="button" class="full" data-act="full">Открыть, что уже собрано →</button>' : '') +
    '</div>';
  }

  function bodyRefusal() {
    return '<div class="pop-body">' +
      '<div class="plate gray"><div class="h"><span class="ic">🔓</span>Отказ — право закрыть есть</div>' +
      '<p>Клиент потребовал прекратить контакт. Звонок вне рейтинга и жизней: отказ клиента — не твоя вина. Лид уходит в «Закрытые (отказ)» без возврата и повторного обзвона.</p>' +
      '<q>«' + esc(REFUSAL_DEMO.quote) + '» <span style="font-style:normal;opacity:.7">(' + esc(REFUSAL_DEMO.note) + ')</span></q></div>' +
      '<div class="plate warn"><div class="h"><span class="ic">⚠</span>Что проверяется в таком звонке</div>' +
      '<p>Только корректность завершения и комплаенс. Продолжишь давить после отказа — уйдёт флаг РОПу.</p></div>' +
      noteHTML() +
    '</div>' +
    '<div class="pop-foot">' +
      '<button type="button" class="btn btn-primary" data-act="ack">Закрыть с причиной «отказ»</button>' +
      '<button type="button" class="btn btn-ghost" data-act="dispute">Это не отказ</button>' +
      '<div class="timer">на старте каждый отказ<b>подтверждает РОП</b></div>' +
    '</div>';
  }

  function doneHTML(kind) {
    var map = {
      ack: { ic: '✓', t: 'Оценка принята, примечание записано', p: 'Конвейер выдаёт следующую задачу. Разбор звонка остался в «Моих звонках».' },
      auto: { ic: '⏱', t: 'Оценка принята автоматически', p: 'Ты не успел ответить — линия не ждёт. Разбор остался в «Моих звонках», спор можно открыть оттуда.' },
      dispute: { ic: '⚑', t: 'Спор отправлен РОПу', p: 'Разбор будет с человеком. Балл пересчитается, если РОП согласится с тобой.' },
      later: { ic: '→', t: 'Отложено', p: 'Попап вернётся после текущей задачи. Через ' + mmss(acw) + ' оценка примется сама.' },
      close: { ic: '✓', t: 'Лид закрыт с причиной «отказ»', p: 'Цитата клиента легла в карточку основанием. Повторный обзвон по этому лиду запрещён (DNC).' }
    };
    var d = map[kind] || map.ack;
    return '<div class="pop-done"><div class="ic">' + d.ic + '</div><div><b>' + esc(d.t) + '</b><p>' + esc(d.p) + '</p></div></div>';
  }

  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  function finish(kind) {
    acted = true;
    stopTimer();
    var pop = root.querySelector('.pop');
    pop.querySelector('.pop-body').remove();
    var foot = pop.querySelector('.pop-foot');
    if (foot) foot.remove();
    pop.insertAdjacentHTML('beforeend', doneHTML(kind));
    if (opts.onFinish) opts.onFinish(kind);
  }

  function startTimer() {
    stopTimer();
    var el = root.querySelector('[data-timer]');
    if (!el) return;
    timerId = setInterval(function () {
      acw--;
      var e = root.querySelector('[data-timer]');
      if (!e) { stopTimer(); return; }
      e.textContent = mmss(Math.max(acw, 0));
      if (acw <= 0 && !acted) finish(state === 'normal' ? 'auto' : 'ack');
    }, 1000);
  }

  /* кромка тает только пока внизу есть непрочитанное */
  function updateScrollMask() {
    var b = root.querySelector('.pop-body');
    if (!b) return;
    var overflows = b.scrollHeight - b.clientHeight > 4;
    var atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 4;
    b.setAttribute('data-scrollable', overflows && !atBottom ? '1' : '0');
  }

  function draw() {
    var body = state === 'partial' ? bodyPartial() : state === 'refusal' ? bodyRefusal() : bodyNormal();
    root.innerHTML = '<div class="pop">' + headHTML() + body + '</div>';
    acted = false;
    startTimer();
    var b = root.querySelector('.pop-body');
    if (b) b.addEventListener('scroll', updateScrollMask);
    updateScrollMask();
  }

  root.addEventListener('click', function (e) {
    var stBtn = e.target.closest('[data-state]');
    if (stBtn) { state = stBtn.getAttribute('data-state'); acw = POPUP_ACW_SECONDS; draw(); return; }

    var pick = e.target.closest('.chip.pick');
    if (pick) {
      pick.setAttribute('aria-pressed', pick.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      root.querySelector('.dispute').classList.remove('invalid');
      return;
    }

    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    if (act === 'ack') { finish(state === 'refusal' ? 'close' : 'ack'); return; }
    if (act === 'later') {
      if (opts.onClose) { stopTimer(); opts.onClose(); } else finish('later');
      return;
    }
    if (act === 'full') { if (opts.onFull) opts.onFull(); return; }

    if (act === 'dispute') {
      var d = root.querySelector('.dispute');
      if (!d) return;
      d.hidden = false;
      root.querySelector('[data-act="ack"]').disabled = true;
      btn.disabled = true;
      d.querySelector('textarea').focus();
      return;
    }
    if (act === 'dispute-cancel') {
      var dd = root.querySelector('.dispute');
      dd.hidden = true; dd.classList.remove('invalid');
      root.querySelector('[data-act="ack"]').disabled = false;
      root.querySelector('[data-act="dispute"]').disabled = false;
      return;
    }
    if (act === 'dispute-send') {
      var box = root.querySelector('.dispute');
      var hasChip = !!box.querySelector('.chip.pick[aria-pressed="true"]');
      var text = box.querySelector('textarea').value.trim();
      if (!hasChip || text.length < 3) { box.classList.add('invalid'); return; }
      finish('dispute');
      return;
    }
  });

  draw();
  return { destroy: stopTimer, redraw: draw };
}
