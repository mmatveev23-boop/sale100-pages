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
  /* колонки СБ: сумма/лимит · срочный основной долг · текущая просрочка — два последних НЕЗАВИСИМЫ
     (в отличие от НБКИ/ОКБ, где просрочка входит в задолженность): полный долг = срочный + просрочка.
     У глубоких МФО-просрочек срочный часто «отсутствует», весь долг сидит в третьей колонке
     (фидбек команды 15.07.2026: виджет видел 119 282,60 из 309 392,34). Третья колонка опциональна —
     старые/демо-отчёты без неё продолжают читаться */
  const rowRe=/(?:^|\s)(\d{1,2})\s+((?:МФО|Банк|Ипотечный агент|МКК|КПК|Лизинг)[:\s][^]*?)\s(\d{2}\.\d{2}\.\d{4})\s+([\d\s]+\.\d{2})\s*₽\s+(?:([\d\s]+\.\d{2})\s*₽|отсутствует)(?:\s+(?:([\d\s]+\.\d{2})\s*₽|отсутствует))?/g;
  const rows=[]; let m;
  while((m=rowRe.exec(sec))){
    const ovd=m[6]?num(m[6]):0;
    rows.push({n:+m[1], lender:m[2].replace(/\s+/g,' ').trim().slice(0,90), opened:m[3], limit:num(m[4]),
      debt:(m[5]?num(m[5]):0)+ovd, overdueAmt:ovd});
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
  const itog=sec.match(/Итого\s+([\d\s]+\.\d{2})(?:\s*₽)?(?:\s+(?:([\d\s]+\.\d{2})\s*₽|отсутствует))?/);
  const itogo=itog?num(itog[1])+(itog[2]?num(itog[2]):0):null; /* «Итого» двухколоночное: срочный + просрочка */
  const pm=text.match(/([\d\s]+\.\d{2})\s*₽\s+среднемесячный платёж/);
  const total=rows.reduce((s,r)=>s+r.debt,0);
  return {
    bureau:'Скоринг Бюро',
    date:dm?dm[1]:null,
    rows, types, total,
    count:rows.length,
    itogo,
    avgMonthly:pm?num(pm[1]):null,          /* среднемесячный платёж из сводки (включая ипотеку) */
    ok:itogo!=null?Math.abs(total-itogo)<1:false,
    hasOverdue:rows.some(r=>r.overdueAmt>0),
  };
}

/* ═══ Мульти-КИ (решение заказчика 2026-07-15): клиент может прислать ДВА отчёта разных бюро.
   Парсеры НБКИ и «Кредистории» (АО «ОКБ») + слияние с дедупликацией по УИД сделки
   (единый идентификатор договора одинаков во всех бюро — надёжнее любых эвристик по названиям).
   Проверено на реальной паре отчётов одного клиента: НБКИ 12.07.2026 (8 действующих, 309 891,47)
   + Кредистория 09.07.2026 (5 действующих, 265 112,52) → 9 уникальных, 4 дубля, 386 233,61. */

function kiTypeOf(lender,kind){
  const k=(kind||'')+'', l=(lender||'')+'';
  if(/Ипотек/i.test(k)) return 'mortgage';
  if(/микрозаем|микрозайм/i.test(k)||/МФО|МКК|МФК|ПКО/i.test(l)) return 'mfo';
  if(/карт|линия|Овердрафт/i.test(k)) return 'card';
  if(/Автокредит|Лизинг/i.test(k)||(/обеспеченн/i.test(k)&&!/необеспеченн/i.test(k))) return 'secured';
  return 'loan';
}
function kiBuildTypes(rows){
  const types={loan:{amount:0,n:0},card:{amount:0,n:0},mfo:{amount:0,n:0},secured:{amount:0,n:0},mortgage:{amount:0,n:0}};
  rows.forEach(r=>{const t=types[r.type]||types.loan;t.amount+=r.debt;t.n++;});
  return types;
}
const KI_MONTHS={'января':'01','февраля':'02','марта':'03','апреля':'04','мая':'05','июня':'06','июля':'07','августа':'08','сентября':'09','октября':'10','ноября':'11','декабря':'12'};

/* НБКИ: строки берём из «Сводки по кредитной истории» (таблица действующих с УИД),
   вид сделки — из детальных блоков («// Договор … — Необеспеченный микрозаем», рядом «УИД договора») */
function parseNbki(text){
  const num=s=>parseFloat(String(s).replace(/\s/g,'').replace(',','.'));
  const sIdx=text.search(/Сводка по кредитной истории\s+В сводке содержится/);
  if(sIdx<0) return null;
  /* конец не режем: форма строки действующих уникальна (после RUB идут два числа и дни),
     закрытые/переуступленные/детальные блоки под regex не попадают */
  const sec=text.slice(sIdx);
  const rowRe=/(\d{1,2})\.\s+(.+?)\s+—\s+Договор[^У]{0,80}?УИД:\s*([0-9a-fа-яё-]{10,})\s+(\d{2}\.\d{2}\.\d{4})\s+([\d\s]+,\d{2})\s+RUB\s+([\d\s]+,\d{2})\s+([\d\s]+,\d{2})\s+(\d+)\s+(Была|Не было)/g;
  const rows=[]; let m;
  while((m=rowRe.exec(sec))){
    rows.push({n:+m[1],lender:m[2].replace(/\s+/g,' ').trim().slice(0,90),uid:m[3].toLowerCase(),opened:m[4],
      limit:num(m[5]),debt:num(m[6]),overdueAmt:num(m[7]),days:+m[8],kind:''});
  }
  if(!rows.length) return null;
  /* вид сделки из детальных блоков — привязка по УИД */
  const kinds=[]; const hdRe=/\d{1,2}\.\s[^]{2,90}?\/\/\s*Договор[^—]{0,60}—\s*([А-Яа-яё() -]{3,45})/g;
  let h; while((h=hdRe.exec(text))) kinds.push({pos:h.index,kind:h[1].trim()});
  const uidRe=/УИД договора\s+([0-9a-fа-яё-]{10,})/g;
  let u; const kindByUid={};
  while((u=uidRe.exec(text))){
    let best=null; for(const k of kinds){ if(k.pos<u.index) best=k; else break; }
    if(best) kindByUid[u[1].toLowerCase()]=best.kind;
  }
  rows.forEach(r=>{r.kind=kindByUid[r.uid]||'';r.type=kiTypeOf(r.lender,r.kind);});
  const itog=text.match(/Текущая задолженность\s+([\d\s]+,\d{2})\s*RUB/);
  const dm=text.match(/Сформирован\s+(\d{2}\.\d{2}\.\d{4})/);
  const total=rows.reduce((s,r)=>s+r.debt,0);
  return {bureau:'НБКИ',date:dm?dm[1]:null,rows,types:kiBuildTypes(rows),total,count:rows.length,
    itogo:itog?num(itog[1]):null,avgMonthly:null,
    ok:itog?Math.abs(total-num(itog[1]))<1:false,
    hasOverdue:rows.some(r=>r.overdueAmt>0)};
}

/* «Кредистория» (АО «ОКБ»): суммы из сводной таблицы раздела «ДЕЙСТВУЮЩИЕ КРЕДИТНЫЕ ДОГОВОРЫ»,
   УИД и дата сделки — из детальных блоков того же раздела, привязка ПО НОМЕРУ блока
   (не по порядку: у поручительства свой блок, он сдвинул бы индексы).
   Проверено на двух реальных отчётах: 09.07.2026 «Дмитрий» (7 долгов из 8 строк: виды с «ёлочками»
   «Кредит «овердрафт» (…)», статусы «Была просрочка по …», поручительство ВТБ) и 09.07.2026 (5/265 112,52). */
function parseCredistory(text){
  const num=s=>parseFloat(String(s).replace(/\s/g,'').replace(',','.'));
  if(!/АО «ОКБ»|кредистория/i.test(text)) return null;
  const idx=text.search(/ДЕЙСТВУЮЩИЕ КРЕДИТНЫЕ ДОГОВОРЫ\s+Информация/);
  if(idx<0) return null;
  let end=text.indexOf('ЗАКРЫТЫЕ КРЕДИТНЫЕ ДОГОВОРЫ',idx); if(end<0) end=text.length;
  const sec=text.slice(idx,end);
  const tblEnd=sec.indexOf('Внимательно проверьте');
  const tbl=tblEnd>0?sec.slice(0,tblEnd):sec.slice(0,6000);
  /* строка таблицы: № · «кредитор + вид» · 3 суммы «N р.» · статус. Запрет « р.» внутри имени
     держит границу строки — имя не может перепрыгнуть суммы соседней записи (иначе при незнакомом
     статусе regex склеивал кредитора одной строки с долгом другой) */
  const rowRe=/(?:^|\s)(\d{1,2})\s+((?:(?!\s?р\.)[^])+?)\s+([\d\s]+(?:,\d+)?)\s*р\.\s+([\d\s]+(?:,\d+)?)\s*р\.\s+([\d\s]+(?:,\d+)?)\s*р\.\s+(Без просрочек|(?:Была\s+п|П)росрочка(?:\s+(?:с|по))?\s+\d{2}\.\d{2}\.\d{4})/g;
  const all=[]; let m;
  while((m=rowRe.exec(tbl))){
    const src=m[2].replace(/\s+/g,' ').trim();
    let lender=src, kind='', guarantee=false;
    const dv=src.match(/^(.*?)\s+Договор\s[^-]{0,40}?-\s+(.+)$/);
    if(dv){ lender=dv[1]; kind=dv[2]; }
    else{ const pv=src.match(/^(.*?)\s+Поручительство\s/); if(pv){ lender=pv[1]; guarantee=true; } }
    all.push({n:+m[1],lender:lender.slice(0,90),kind:kind.trim(),guarantee,
      limit:num(m[3]),debt:num(m[4]),overdueAmt:num(m[5]),uid:'',opened:'',
      status:m[6]});
  }
  const rows=all.filter(r=>!r.guarantee); /* поручительство — не долг клиента: «Итого» отчёта его не считает */
  if(!rows.length) return null;
  /* якоря детальных блоков: «N. <первое слово кредитора>» (включая поручительства — их блоки
     не должны отдавать свой УИД соседям) → раскладка УИД/дат по номеру записи */
  const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const hd=[];
  for(const r of all){
    const w=r.lender.split(' ')[0]||''; if(!w) continue;
    const hm=new RegExp('(?:^|\\s)'+r.n+'\\.\\s+'+esc(w)).exec(sec);
    if(hm) hd.push({n:r.n,pos:hm.index});
  }
  hd.sort((a,b)=>a.pos-b.pos);
  const uidRe=/Идентификатор сделки\s+([0-9a-fа-яё-]{10,})/g;
  const dateRe=/Дата совершения сделки\s+(\d{1,2}) ([а-яё]+) (\d{4})/g;
  const fmtDate=x=>('0'+x[1]).slice(-2)+'.'+(KI_MONTHS[x[2]]||'01')+'.'+x[3];
  if(hd.length){
    const byN=(re,fmt)=>{ const out={}; let x;
      while((x=re.exec(sec))){ let best=null; for(const b of hd){ if(b.pos<x.index) best=b; else break; }
        if(best&&out[best.n]===undefined) out[best.n]=fmt(x); }
      return out; };
    const uidByN=byN(uidRe,x=>x[1].toLowerCase());
    const dateByN=byN(dateRe,fmtDate);
    rows.forEach(r=>{r.uid=uidByN[r.n]||'';r.opened=dateByN[r.n]||'';});
  }else{
    /* якорей нет (нестандартная вёрстка) — деградация до привязки по порядку */
    const uids=[]; let u; while((u=uidRe.exec(sec))) uids.push(u[1].toLowerCase());
    const dates=[]; let d; while((d=dateRe.exec(sec))) dates.push(fmtDate(d));
    rows.forEach((r,i)=>{r.uid=uids[i]||'';r.opened=dates[i]||'';});
  }
  rows.forEach((r,i)=>{r.n=i+1;r.type=kiTypeOf(r.lender,r.kind);}); /* сквозная нумерация: без дырок после выброса поручительств */
  const itog=text.match(/([\d\s]+,\d{2})\s*р\.\s+Задолженности по обязательствам/);
  const dm=text.match(/на (\d{1,2}) ([а-яё]+) (\d{4}) года/);
  const total=rows.reduce((s,r)=>s+r.debt,0);
  return {bureau:'ОКБ (Кредистория)',date:dm?('0'+dm[1]).slice(-2)+'.'+(KI_MONTHS[dm[2]]||'01')+'.'+dm[3]:null,
    rows,types:kiBuildTypes(rows),total,count:rows.length,
    itogo:itog?num(itog[1]):null,avgMonthly:null,
    ok:itog?Math.abs(total-num(itog[1]))<1:false,
    /* просрочка = только текущая («Просрочка с …» или сумма>0); «Была просрочка по …» — прошлая, закрытая */
    hasOverdue:rows.some(r=>r.overdueAmt>0||/^Просрочка/.test(r.status||''))};
}

/* распознать любой поддерживаемый отчёт */
function parseAnyKi(text){
  const sb=parseSb(text);
  if(sb){ sb.rows.forEach(r=>{r.uid=r.uid||'';}); sb.hasOverdue=sb.hasOverdue||false; return sb; }
  return parseNbki(text)||parseCredistory(text);
}

/* слияние 1..N отчётов. Дубль договора = совпадение УИД сделки (железный ключ, одинаков во всех бюро)
   ИЛИ совпадение даты открытия + (суммы обязательства ИЛИ «ядра» имени кредитора) — для отчётов без УИД
   в строках (Скоринг Бюро). При дубле побеждает более свежий отчёт, долг берём больший (консервативно). */
function mergeKiReports(reports){
  const parseDate=s=>{const m=String(s||'').match(/(\d{2})\.(\d{2})\.(\d{4})/);return m?+(m[3]+m[2]+m[1]):0;};
  const STOP={'ООО':1,'ПАО':1,'БАНК':1,'БАНКА':1,'МКК':1,'МФК':1,'МФО':1,'ПКО':1,'КПК':1,'ЛИЗИНГ':1,'АГЕНТ':1,'ИПОТЕЧНЫЙ':1,'РАНЕЕ':1};
  const core=s=>String(s||'').toUpperCase().replace(/[«»"'().,:]/g,' ').split(/\s+/).filter(w=>w.length>3&&!STOP[w]).sort().join(' ');
  const sorted=[...reports].sort((a,b)=>parseDate(a.date)-parseDate(b.date));
  const entries=[]; let dupes=0;
  const sameDeal=(a,b)=>{
    if(a.uid&&b.uid) return a.uid===b.uid;
    if(!a.opened||!b.opened||a.opened!==b.opened) return a.uid&&b.uid?false:(a.uid===b.uid&&!!a.uid);
    if(a.limit>0&&b.limit>0&&Math.abs(a.limit-b.limit)<=1) return true;
    const ca=core(a.lender),cb=core(b.lender);
    return !!ca&&(ca===cb||ca.indexOf(cb)>=0||cb.indexOf(ca)>=0);
  };
  for(const rep of sorted){
    for(const row of rep.rows){
      const hit=entries.find(e=>sameDeal(e,row));
      if(hit){
        dupes++;
        hit.debt=Math.max(hit.debt,row.debt);
        hit.uid=hit.uid||row.uid; hit.opened=hit.opened||row.opened;
        hit.kind=row.kind||hit.kind; hit.lender=row.lender||hit.lender;
        hit.type=row.type||hit.type; hit.overdueAmt=Math.max(hit.overdueAmt||0,row.overdueAmt||0);
      }else entries.push({...row});
    }
  }
  const rows=entries.sort((a,b)=>b.debt-a.debt).map((r,i)=>({...r,n:i+1}));
  const total=rows.reduce((s,r)=>s+r.debt,0);
  return {
    bureau:sorted.map(r=>r.bureau).join(' + '),
    date:(sorted[sorted.length-1]||{}).date||null, /* самая свежая дата — для «отчёт от X» */
    srcLabel:sorted.map(r=>r.bureau+' от '+(r.date||'—')).join(' и '),
    rows,types:kiBuildTypes(rows),total,count:rows.length,
    itogo:null,avgMonthly:sorted.map(r=>r.avgMonthly).filter(Boolean).pop()||null,
    ok:sorted.every(r=>r.ok),
    hasOverdue:sorted.some(r=>r.hasOverdue),
    dupes,sources:sorted.map(r=>({bureau:r.bureau,date:r.date,count:r.count,total:r.total,ok:r.ok}))
  };
}
