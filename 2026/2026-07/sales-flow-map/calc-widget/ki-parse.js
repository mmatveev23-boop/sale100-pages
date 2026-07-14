/* Парсер кредитного отчёта «Скоринг Бюро» (экс-Эквифакс) — канонный формат КИ заказчика (решение 2026-07-14).
   Вход: текст PDF, склеенный pdf.js (items.join(' ') постранично). Выход: договоры, типы для конструктора виджета, сводка.
   Особенность потока pdf.js: колонка «вид обязательства» приходит пачками отдельно от строк таблицы,
   но в том же порядке, что записи, — сшиваем по индексу. Проверено на реальном отчёте 10.07.2026 (13/13, итог копейка в копейку). */
function parseSb(text){
  const num=s=>parseFloat(s.replace(/\s/g,''));
  const start=text.indexOf('Кредиты, займы, карты, поручительства');
  if(start<0) return null; /* не «Скоринг Бюро» — пусть пробует другой парсер */
  let end=text.indexOf('Закрытые кредиты, займы, карты', start);
  if(end<0) end=text.length;
  const sec=text.slice(start,end);
  const dm=text.match(/Отчёт от\s+(\d{1,2}\s+[а-яё]+\s+\d{4})/i);
  const KINDS=['Необеспеченный микрозаем','Обеспеченный микрозаем','Кредитная линия/карта','Овердрафт','Иной необеспеченный заем','Необеспеченный заем','Потребительский кредит','Автокредит','Ипотека','Иной обеспеченный заем','Обеспеченный заем','Лизинг'];
  const kindRe=new RegExp('('+KINDS.map(k=>k.replace(/[/]/g,'\\/')).join('|')+')','g');
  const kinds=[]; let km;
  while((km=kindRe.exec(sec))) kinds.push(km[1]);
  const rowRe=/(?:^|\s)(\d{1,2})\s+((?:МФО|Банк|Ипотечный агент|МКК|КПК|Лизинг)[:\s][^]*?)\s(\d{2}\.\d{2}\.\d{4})\s+([\d\s]+\.\d{2})\s*₽\s+(?:([\d\s]+\.\d{2})\s*₽|отсутствует)/g;
  const rows=[]; let m;
  while((m=rowRe.exec(sec))){
    rows.push({n:+m[1], lender:m[2].replace(/\s+/g,' ').trim().slice(0,90), opened:m[3], limit:num(m[4]), debt:m[5]?num(m[5]):0});
  }
  if(!rows.length) return null;
  rows.forEach((r,i)=>{r.kind=kinds[i]||'';});
  const typeOf=r=>{
    if(/Ипотека/.test(r.kind)) return 'mortgage';
    if(/^МФО/.test(r.lender)||/микрозаем/i.test(r.kind)) return 'mfo';
    if(/линия\/карта|Овердрафт/i.test(r.kind)) return 'card';
    if(/обеспеченный заем|Автокредит|Лизинг/i.test(r.kind)&&!/необеспеченный/i.test(r.kind)) return 'secured';
    return 'loan';
  };
  const types={loan:{amount:0,n:0},card:{amount:0,n:0},mfo:{amount:0,n:0},secured:{amount:0,n:0},mortgage:{amount:0,n:0}};
  rows.forEach(r=>{const k=typeOf(r);r.type=k;types[k].amount+=r.debt;types[k].n++;});
  const itog=sec.match(/Итого\s+([\d\s]+\.\d{2})/);
  const pm=text.match(/([\d\s]+\.\d{2})\s*₽\s+среднемесячный платёж/);
  const total=rows.reduce((s,r)=>s+r.debt,0);
  return {
    bureau:'Скоринг Бюро',
    date:dm?dm[1]:null,
    rows, types, total,
    count:rows.length,
    itogo:itog?num(itog[1]):null,          /* «Итого» из отчёта — сверка с total */
    avgMonthly:pm?num(pm[1]):null,          /* среднемесячный платёж из сводки (включая ипотеку) */
    ok:itog?Math.abs(total-num(itog[1]))<1:false,
  };
}
