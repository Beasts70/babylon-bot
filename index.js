const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TOKEN = process.env.TELEGRAM_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

// ── ПОЛЬЗОВАТЕЛИ ──────────────────────────────────────────
const USERS = {
  '5080699264': { prefix: 'user_5080699264', currency: '₽', locale: 'ru-RU' },
  '5472449463': { prefix: 'user_5472449463', currency: '€', locale: 'ru-RU' },
};
function getUser(chatId) { return USERS[String(chatId)]; }

// ── КАТЕГОРИИ ─────────────────────────────────────────────
const EXP_CATS = {
  еда:'food',кафе:'food',ресторан:'food',продукты:'food',обед:'food',
  ужин:'food',завтрак:'food',перекус:'food',
  такси:'transport',транспорт:'transport',метро:'transport',
  бензин:'transport',парковка:'transport',uber:'transport',
  аренда:'home',жильё:'home',коммуналка:'home',жилье:'home',
  здоровье:'health',аптека:'health',врач:'health',спорт:'health',
  развлечения:'fun',кино:'fun',игры:'fun',подписка:'fun',бар:'fun',
  одежда:'clothes',обувь:'clothes',
};
const EXP_CATS_RU = {
  food:'Еда',transport:'Транспорт',home:'Жильё',
  health:'Здоровье',fun:'Развлечения',clothes:'Одежда',other:'Прочее'
};

function guessSubcat(desc) {
  const d = desc.toLowerCase();
  for (const [k,v] of Object.entries(EXP_CATS)) if (d.includes(k)) return v;
  return 'other';
}
function monthKey(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function prevMonthKey() {
  const d = new Date();
  d.setMonth(d.getMonth()-1);
  return monthKey(d);
}
function todayStr() {
  return new Date().toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
}
function fmt(n, user) {
  return Math.round(n).toLocaleString(user.locale) + ' ' + user.currency;
}
function catLabel(c) {
  return {income:'Доход',save:'Себе',invest:'Инвестиции',expense:'Расход',goal:'Цель'}[c]||c;
}

async function sendMessage(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendDocument(chatId, filename, content, caption) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption||'');
  form.append('document', Buffer.from(content,'utf-8'), { filename });
  await fetch(`${API}/sendDocument`, { method:'POST', body:form });
}

// ── МЕНЮ ─────────────────────────────────────────────────
const MAIN_KB = [
  ['💰 Доход',         '💸 Расход'],
  ['🏦 Себе',          '📈 Инвестиции'],
  ['🎯 В счёт цели',   '↩️ Отмена'],
  ['📊 Баланс',        '📋 История'],
  ['🎯 Цели',          '📅 Прошлый месяц'],
  ['⚠️ Лимиты',       '🔁 Регулярные'],
  ['🔍 Поиск',         '❓ Помощь'],
];

const userState = {};

// ── ТОТАЛЫ ───────────────────────────────────────────────
async function getTotals(prefix, month) {
  const snap = await db.collection(`${prefix}_entries`).where('month','==',month||monthKey()).get();
  const entries = snap.docs.map(d=>d.data());
  return {
    income:   entries.filter(e=>e.cat==='income').reduce((s,e)=>s+e.amount,0),
    saved:    entries.filter(e=>e.cat==='save').reduce((s,e)=>s+e.amount,0),
    invested: entries.filter(e=>e.cat==='invest').reduce((s,e)=>s+e.amount,0),
    expense:  entries.filter(e=>e.cat==='expense').reduce((s,e)=>s+e.amount,0),
    goalPaid: entries.filter(e=>e.cat==='goal').reduce((s,e)=>s+e.amount,0),
    entries,
  };
}

// ── ПРОВЕРКА ЛИМИТОВ ─────────────────────────────────────
async function checkLimits(prefix, user, chatId, newEntry) {
  if (newEntry.cat !== 'expense') return;
  const limSnap = await db.collection(`${prefix}_limits`).get();
  if (limSnap.empty) return;
  const limits = {};
  limSnap.docs.forEach(d=>{ limits[d.data().subcat]=d.data().amount; });
  const subcat = newEntry.subcat||'other';
  if (!limits[subcat]) return;
  const snap = await db.collection(`${prefix}_entries`)
    .where('month','==',monthKey()).where('cat','==','expense').get();
  const total = snap.docs.filter(d=>(d.data().subcat||'other')===subcat).reduce((s,d)=>s+d.data().amount,0);
  const limit = limits[subcat];
  if (total > limit) {
    await sendMessage(chatId,
      `⚠️ <b>Лимит превышен!</b>\n${EXP_CATS_RU[subcat]||subcat}: ${fmt(total,user)} / ${fmt(limit,user)}\nПревышение: <b>${fmt(total-limit,user)}</b>`
    );
  } else if (total > limit*0.8) {
    await sendMessage(chatId,
      `🟡 Осталось по лимиту <b>${EXP_CATS_RU[subcat]||subcat}</b>: ${fmt(limit-total,user)}`
    );
  }
}

// ── ОБРАБОТЧИК ───────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text||'').trim();
  const lower = text.toLowerCase();

  const user = getUser(chatId);
  if (!user) { await sendMessage(chatId,'🚫 У тебя нет доступа к этому боту.'); return; }

  const { prefix } = user;
  const entriesCol  = db.collection(`${prefix}_entries`);
  const goalsCol    = db.collection(`${prefix}_goals`);
  const limitsCol   = db.collection(`${prefix}_limits`);
  const recurCol    = db.collection(`${prefix}_recurring`);
  const settingsDoc = db.collection(`${prefix}_settings`).doc('main');

  // /start
  if (lower==='/start'||lower==='меню'||lower==='начало') {
    await sendMessage(chatId,
      `🏛 <b>Вавилонский учёт</b>\n\n` +
      `<b>Быстрый ввод:</b>\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю\n` +
      `<code>инвест 10000</code> — инвестиции\n` +
      `<code>поиск кофе</code> — найти записи\n` +
      `<code>конвертер 5000</code> — перевести в валюту`,
      MAIN_KB
    );
    return;
  }

  // ↩️ ОТМЕНА
  if (lower==='↩️ отмена'||lower==='/отмена'||lower==='отмена') {
    const snap = await entriesCol.orderBy('ts','desc').limit(1).get();
    if (snap.empty) { await sendMessage(chatId,'Нет записей для отмены.',MAIN_KB); return; }
    const last = snap.docs[0];
    const e = last.data();
    if (e.cat==='goal'&&e.goalId) {
      const g = await goalsCol.doc(e.goalId).get();
      if (g.exists) await goalsCol.doc(e.goalId).update({saved:Math.max((g.data().saved||0)-e.amount,0)});
    }
    await last.ref.delete();
    const sign=(e.cat==='expense'||e.cat==='goal')?'−':'+';
    await sendMessage(chatId,
      `↩️ <b>Отменено</b>\n\n${catLabel(e.cat)}: ${sign}${fmt(e.amount,user)}\n📝 ${e.desc}`,
      MAIN_KB
    );
    return;
  }

  // 🔍 ПОИСК
  if (lower==='🔍 поиск'||lower==='/поиск') {
    userState[chatId]={mode:'search'};
    await sendMessage(chatId,'🔍 Введи слово для поиска:',MAIN_KB);
    return;
  }
  if (lower.startsWith('поиск ')||userState[chatId]?.mode==='search') {
    const query = lower.startsWith('поиск ') ? text.slice(6).trim() : text.trim();
    delete userState[chatId];
    if (!query) { await sendMessage(chatId,'Укажи слово: <code>поиск кофе</code>',MAIN_KB); return; }
    const snap = await entriesCol.orderBy('ts','desc').limit(100).get();
    const found = snap.docs.map(d=>d.data()).filter(e=>e.desc&&e.desc.toLowerCase().includes(query.toLowerCase()));
    if (!found.length) { await sendMessage(chatId,`🔍 По запросу «${query}» ничего не найдено.`,MAIN_KB); return; }
    const catEmoji={income:'💰',save:'🏦',invest:'📈',expense:'💸',goal:'🎯'};
    const lines = found.slice(0,10).map(e=>{
      const sign=(e.cat==='expense'||e.cat==='goal')?'−':'+';
      return `${catEmoji[e.cat]||'•'} ${e.desc} — <b>${sign}${fmt(e.amount,user)}</b> <i>${e.date||''}</i>`;
    });
    const total = found.reduce((s,e)=>(e.cat==='expense'||e.cat==='goal')?s+e.amount:s,0);
    await sendMessage(chatId,
      `🔍 <b>«${query}»</b> — найдено ${found.length} записей\n\n${lines.join('\n')}${found.length>10?`\n<i>...и ещё ${found.length-10}</i>`:''}\n\nИтого расходов: <b>${fmt(total,user)}</b>`,
      MAIN_KB
    );
    return;
  }

  // 📅 ПРОШЛЫЙ МЕСЯЦ
  if (lower==='📅 прошлый месяц'||lower==='/прошлый'||lower==='прошлый месяц') {
    const pm = prevMonthKey();
    const t = await getTotals(prefix, pm);
    const settSnap = await settingsDoc.get();
    const selfPct = settSnap.exists?(settSnap.data().selfPct||10):10;
    const balance = t.income-t.saved-t.invested-t.expense-t.goalPaid;
    const savePct = t.income>0?Math.round((t.saved/t.income)*100):0;
    const expPct  = t.income>0?Math.round((t.expense/t.income)*100):0;
    const prevDate = new Date(); prevDate.setMonth(prevDate.getMonth()-1);
    const monthName = prevDate.toLocaleString('ru-RU',{month:'long',year:'numeric'});

    // Разбивка расходов
    const expBycat={};
    t.entries.filter(e=>e.cat==='expense').forEach(e=>{const k=e.subcat||'other';expBycat[k]=(expBycat[k]||0)+e.amount;});
    const expLines = Object.entries(expBycat).sort((a,b)=>b[1]-a[1])
      .map(([k,v])=>`  ${EXP_CATS_RU[k]||k}: ${fmt(v,user)}`).join('\n');

    await sendMessage(chatId,
      `📅 <b>Итоги за ${monthName}</b>\n\n` +
      `💰 Доход: <b>${fmt(t.income,user)}</b>\n` +
      `🏦 Откладывал: <b>${fmt(t.saved,user)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(t.invested,user)}</b>\n` +
      `💸 Расходы: <b>${fmt(t.expense,user)}</b> (${expPct}%)\n` +
      `🟰 Баланс: <b>${fmt(balance,user)}</b>\n\n` +
      `<b>Расходы по категориям:</b>\n${expLines||'  Нет расходов'}`,
      MAIN_KB
    );
    return;
  }

  // 📊 БАЛАНС
  if (lower==='📊 баланс'||lower==='/баланс'||lower==='баланс') {
    const t = await getTotals(prefix);
    const settSnap = await settingsDoc.get();
    const selfPct = settSnap.exists?(settSnap.data().selfPct||10):10;
    const target  = t.income*selfPct/100;
    const balance = t.income-t.saved-t.invested-t.expense-t.goalPaid;
    const savePct = t.income>0?Math.round((t.saved/t.income)*100):0;
    const expPct  = t.income>0?Math.round((t.expense/t.income)*100):0;
    const invPct  = t.income>0?Math.round((t.invested/t.income)*100):0;
    let score=0;
    if(t.income>0){
      if(savePct>=selfPct)score+=40;else if(savePct>=selfPct*.7)score+=20;else if(savePct>0)score+=10;
      if(expPct<=70)score+=35;else if(expPct<=80)score+=25;else if(expPct<=90)score+=10;
      if(invPct>=10)score+=25;else if(invPct>0)score+=12;
    }
    let wisdom='🟡 Ученик';
    if(score>=85)wisdom='🏆 Богатый вавилонянин';
    else if(score>=60)wisdom='💎 Зажиточный';
    else if(score>=35)wisdom='✅ Свободный человек';
    const monthName=new Date().toLocaleString('ru-RU',{month:'long',year:'numeric'});
    await sendMessage(chatId,
      `📊 <b>Баланс за ${monthName}</b>\n\n` +
      `💰 Доход: <b>${fmt(t.income,user)}</b>\n` +
      `🏦 Себе — цель (${selfPct}%): <b>${fmt(target,user)}</b>\n` +
      `🏦 Откладываю факт: <b>${fmt(t.saved,user)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(t.invested,user)}</b> (${invPct}%)\n` +
      `💸 Расходы: <b>${fmt(t.expense,user)}</b> (${expPct}%)\n` +
      `━━━━━━━━━━━━━━\n` +
      `🟰 Баланс: <b>${fmt(balance,user)}</b>\n\n` +
      `${wisdom} — ${score}/100`,
      MAIN_KB
    );
    return;
  }

  // 📋 ИСТОРИЯ
  if (lower==='📋 история'||lower==='/история'||lower==='история') {
    const snap = await entriesCol.orderBy('ts','desc').limit(10).get();
    if (snap.empty) { await sendMessage(chatId,'Записей пока нет.',MAIN_KB); return; }
    const catEmoji={income:'💰',save:'🏦',invest:'📈',expense:'💸',goal:'🎯'};
    const lines = snap.docs.map(d=>{
      const e=d.data(),sign=(e.cat==='expense'||e.cat==='goal')?'−':'+';
      return `${catEmoji[e.cat]||'•'} ${e.desc} — <b>${sign}${fmt(e.amount,user)}</b> <i>${e.date||''}</i>`;
    });
    await sendMessage(chatId,`📋 <b>Последние записи</b>\n\n${lines.join('\n')}`,MAIN_KB);
    return;
  }

  // 🎯 ЦЕЛИ
  if (lower==='🎯 цели'||lower==='/цели'||lower==='цели') {
    const snap = await goalsCol.orderBy('ts','asc').get();
    if (snap.empty) { await sendMessage(chatId,'🎯 Целей пока нет. Добавь в веб-приложении.',MAIN_KB); return; }
    const lines = snap.docs.map(d=>{
      const g=d.data(),s=g.saved||0,pct=Math.min(Math.round((s/g.target)*100),100);
      const bar='█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
      return `🎯 <b>${g.name}</b>\n${bar} ${pct}%\n${fmt(s,user)} / ${fmt(g.target,user)}`;
    });
    await sendMessage(chatId,`🎯 <b>Цели накоплений</b>\n\n${lines.join('\n\n')}`,MAIN_KB);
    return;
  }

  // ⚠️ ЛИМИТЫ
  if (lower.startsWith('/лимит ')||lower.startsWith('лимит ')) {
    const parts=text.replace(/^\/?(лимит)\s*/i,'').trim().split(/\s+/);
    const numIdx=parts.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
    if(numIdx===-1){await sendMessage(chatId,'Формат: <code>лимит еда 5000</code>',MAIN_KB);return;}
    const amount=parseFloat(parts[numIdx].replace(',','.'));
    const catWords=parts.filter((_,i)=>i!==numIdx).join(' ').toLowerCase();
    const subcat=EXP_CATS[catWords]||catWords||'other';
    await limitsCol.doc(subcat).set({subcat,amount,ts:Date.now()});
    await sendMessage(chatId,`✅ Лимит: ${EXP_CATS_RU[subcat]||catWords} — <b>${fmt(amount,user)}</b>/мес`,MAIN_KB);
    return;
  }
  if (lower==='⚠️ лимиты'||lower==='/лимиты'||lower==='лимиты') {
    const snap=await limitsCol.get();
    if(snap.empty){await sendMessage(chatId,'Лимитов нет.\nУстанови: <code>лимит еда 5000</code>',MAIN_KB);return;}
    const tSnap=await entriesCol.where('month','==',monthKey()).where('cat','==','expense').get();
    const spent={};
    tSnap.docs.forEach(d=>{const k=d.data().subcat||'other';spent[k]=(spent[k]||0)+d.data().amount;});
    const lines=snap.docs.map(d=>{
      const{subcat,amount}=d.data(),s=spent[subcat]||0,pct=Math.round((s/amount)*100);
      const bar=pct>=100?'🔴':pct>=80?'🟡':'🟢';
      return `${bar} ${EXP_CATS_RU[subcat]||subcat}: ${fmt(s,user)} / ${fmt(amount,user)} (${pct}%)`;
    });
    await sendMessage(chatId,`⚠️ <b>Лимиты</b>\n\n${lines.join('\n')}`,MAIN_KB);
    return;
  }

  // 🔁 РЕГУЛЯРНЫЕ
  if (lower.startsWith('/каждый ')||lower.startsWith('каждый ')) {
    const parts=text.replace(/^\/?(каждый)\s*/i,'').trim().split(/\s+/);
    const numIdx=parts.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
    if(numIdx===-1){await sendMessage(chatId,'Формат: <code>каждый аренда 50000</code>',MAIN_KB);return;}
    const amount=parseFloat(parts[numIdx].replace(',','.'));
    const desc=parts.filter((_,i)=>i!==numIdx).join(' ')||'Регулярный платёж';
    const id=`${desc}_${amount}`.replace(/\s+/g,'_');
    await recurCol.doc(id).set({desc,amount,subcat:guessSubcat(desc),cat:'expense',ts:Date.now(),active:true});
    await sendMessage(chatId,`🔁 Регулярный платёж: <b>${desc} ${fmt(amount,user)}</b>\nСписывается 1-го числа`,MAIN_KB);
    return;
  }
  if (lower==='🔁 регулярные'||lower==='/регулярные'||lower==='регулярные') {
    const snap=await recurCol.where('active','==',true).get();
    if(snap.empty){await sendMessage(chatId,'Регулярных нет.\nДобавь: <code>каждый аренда 50000</code>',MAIN_KB);return;}
    const lines=snap.docs.map(d=>`🔁 ${d.data().desc}: <b>${fmt(d.data().amount,user)}</b>`);
    await sendMessage(chatId,`🔁 <b>Регулярные платежи</b>\n\n${lines.join('\n')}`,MAIN_KB);
    return;
  }

  // /pdf
  if (lower==='/pdf'||lower==='pdf') {
    const t=await getTotals(prefix);
    const settSnap=await settingsDoc.get();
    const selfPct=settSnap.exists?(settSnap.data().selfPct||10):10;
    const balance=t.income-t.saved-t.invested-t.expense-t.goalPaid;
    const savePct=t.income>0?Math.round((t.saved/t.income)*100):0;
    const expPct=t.income>0?Math.round((t.expense/t.income)*100):0;
    const expBycat={};
    t.entries.filter(e=>e.cat==='expense').forEach(e=>{const k=e.subcat||'other';expBycat[k]=(expBycat[k]||0)+e.amount;});
    const expLines=Object.entries(expBycat).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${EXP_CATS_RU[k]||k}: ${fmt(v,user)}`).join('\n');
    const lastEntries=t.entries.sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,15)
      .map(e=>{const sign=(e.cat==='expense'||e.cat==='goal')?'-':'+';return `  ${e.date||''} | ${catLabel(e.cat).padEnd(12)} | ${sign}${fmt(e.amount,user).padStart(14)} | ${e.desc}`;}).join('\n');
    const monthName=new Date().toLocaleString('ru-RU',{month:'long',year:'numeric'});
    const csv=`ФИНАНСОВЫЙ ОТЧЁТ — ${monthName.toUpperCase()}\n${'='.repeat(50)}\n\nСВОДКА\n------\nДоход:           ${fmt(t.income,user)}\nСебе (${selfPct}%):     ${fmt(t.income*selfPct/100,user)}\nОткладываю факт: ${fmt(t.saved,user)} (${savePct}%)\nРасходы:         ${fmt(t.expense,user)} (${expPct}%)\nБаланс:          ${fmt(balance,user)}\n\nРАСХОДЫ ПО КАТЕГОРИЯМ\n---------------------\n${expLines||'  Нет расходов'}\n\nЗАПИСИ\n------\n${lastEntries||'  Нет записей'}\n\n${'='.repeat(50)}\n${new Date().toLocaleString('ru-RU')}\n`;
    await sendDocument(chatId,`отчёт_${monthKey()}.txt`,csv,`📄 Отчёт за ${monthName}`);
    return;
  }

  // ❓ ПОМОЩЬ
  if (lower==='❓ помощь'||lower==='/help'||lower==='помощь') {
    await sendMessage(chatId,
      `<b>Быстрый ввод:</b>\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю\n` +
      `<code>инвест 10000</code> — инвестиции\n\n` +
      `<b>Команды:</b>\n` +
      `↩️ Отмена — удалить последнюю запись\n` +
      `🔍 Поиск — найти записи по слову\n` +
      `💱 Конвертер — перевести рубли в валюту\n` +
      `📅 Прошлый месяц — итоги прошлого месяца\n` +
      `/pdf — отчёт за текущий месяц\n\n` +
      `<b>Лимиты:</b>\n` +
      `<code>лимит еда 5000</code> — лимит на категорию\n\n` +
      `<b>Регулярные:</b>\n` +
      `<code>каждый аренда 50000</code> — авто-платёж 1-го числа`,
      MAIN_KB
    );
    return;
  }

  // Кнопки ввода
  if(lower==='💰 доход')     {userState[chatId]={cat:'income'};  await sendMessage(chatId,'💰 <code>зарплата 150000</code>',MAIN_KB);return;}
  if(lower==='💸 расход')    {userState[chatId]={cat:'expense'}; await sendMessage(chatId,'💸 <code>кофе 350</code>',MAIN_KB);return;}
  if(lower==='🏦 себе')      {userState[chatId]={cat:'save'};    await sendMessage(chatId,'🏦 Сумма: <code>15000</code>',MAIN_KB);return;}
  if(lower==='📈 инвестиции'){userState[chatId]={cat:'invest'};  await sendMessage(chatId,'📈 <code>etf 10000</code>',MAIN_KB);return;}

  // ЦЕЛЬ
  if(lower==='🎯 в счёт цели') {
    const gsnap = await goalsCol.orderBy('ts','asc').get();
    if(gsnap.empty){ await sendMessage(chatId,'Целей пока нет. Добавь в веб-приложении.',MAIN_KB); return; }
    const gkb = gsnap.docs.map(d=>[d.data().name]);
    gkb.push(['Отмена']);
    userState[chatId] = { mode:'goal_select', glist: gsnap.docs.map(d=>({id:d.id,...d.data()})) };
    await sendMessage(chatId,'Выбери цель:',gkb);
    return;
  }

  if(userState[chatId] && userState[chatId].mode==='goal_select') {
    if(lower==='отмена'){ delete userState[chatId]; await sendMessage(chatId,'Отменено.',MAIN_KB); return; }
    const glist = userState[chatId].glist;
    const chosen = glist.find(function(g){ return g.name.toLowerCase()===lower; });
    if(!chosen){ await sendMessage(chatId,'Выбери из списка.'); return; }
    userState[chatId] = { mode:'goal_amount', goal: chosen };
    const gsaved = chosen.saved||0;
    await sendMessage(chatId,'Цель: '+chosen.name+'\nНакоплено: '+fmt(gsaved,user)+' / '+fmt(chosen.target,user)+'\nВведи сумму:');
    return;
  }

  if(userState[chatId] && userState[chatId].mode==='goal_amount') {
    const gamt = parseFloat(text.replace(',','.'));
    if(isNaN(gamt)||gamt<=0){ await sendMessage(chatId,'Введи сумму числом.'); return; }
    const ggoal = userState[chatId].goal;
    delete userState[chatId];
    const gnewSaved = Math.min((ggoal.saved||0)+gamt, ggoal.target);
    await goalsCol.doc(ggoal.id).update({saved: gnewSaved});
    const gentry = {desc:'В счёт цели: '+ggoal.name, cat:'goal', goalId:ggoal.id, amount:gamt, date:todayStr(), month:monthKey(), ts:Date.now(), source:'telegram'};
    await entriesCol.add(gentry);
    const gleft = ggoal.target - gnewSaved;
    const gpct = Math.min(Math.round((gnewSaved/ggoal.target)*100),100);
    const gbar = ''.padStart(Math.round(gpct/10),'|')+''.padStart(10-Math.round(gpct/10),'.');
    const gmsg = 'Записано!\n\nЦель: '+ggoal.name+'\n['+gbar+'] '+gpct+'%\n'+fmt(gnewSaved,user)+' / '+fmt(ggoal.target,user)+'\n'+(gleft>0?'Осталось: '+fmt(gleft,user):'Цель достигнута!');
    await sendMessage(chatId, gmsg, MAIN_KB);
    return;
  }

    // ── БЫСТРЫЙ ВВОД ─────────────────────────────────────
  let cat=null;
  if(userState[chatId]){cat=userState[chatId].cat;delete userState[chatId];}
  const words=text.split(/\s+/);
  const numIdx=words.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
  if(numIdx===-1){
    await sendMessage(chatId,`Не понял. Попробуй:\n<code>кофе 350</code>\n<code>+зарплата 150000</code>\n\nИли нажми /start`,MAIN_KB);
    return;
  }
  const amount=parseFloat(words[numIdx].replace(',','.'));
  let desc=words.filter((_,i)=>i!==numIdx).join(' ').replace(/^[+]/,'').trim();
  if(!cat){
    if(text.startsWith('+'))                                          cat='income';
    else if(lower.startsWith('себе')||lower.startsWith('отложи'))     cat='save';
    else if(lower.startsWith('инвест'))                               cat='invest';
    else                                                               cat='expense';
  }
  desc=desc.replace(/^(себе|отложи|инвест)\s*/i,'').trim()||catLabel(cat);
  const entry={desc,cat,amount,date:todayStr(),month:monthKey(),ts:Date.now(),source:'telegram'};
  if(cat==='expense') entry.subcat=guessSubcat(desc);
  await entriesCol.add(entry);
  const catNames={income:'💰 Доход',save:'🏦 Себе',invest:'📈 Инвестиции',expense:'💸 Расход'};
  const sign=(cat==='expense')?'−':'+';
  await sendMessage(chatId,`✅ <b>Записано</b>\n\n${catNames[cat]}: <b>${sign}${fmt(amount,user)}</b>\n📝 ${desc}`,MAIN_KB);
  await checkLimits(prefix,user,chatId,entry);
}

// ── ПЛАНИРОВЩИК ───────────────────────────────────────────
async function sendWeeklyReports() {
  for(const[chatId,user] of Object.entries(USERS)){
    try{
      const t=await getTotals(user.prefix);
      if(t.income===0&&t.expense===0) continue;
      const balance=t.income-t.saved-t.invested-t.expense-t.goalPaid;
      const savePct=t.income>0?Math.round((t.saved/t.income)*100):0;
      const expPct=t.income>0?Math.round((t.expense/t.income)*100):0;
      const expBycat={};
      t.entries.filter(e=>e.cat==='expense').forEach(e=>{const k=e.subcat||'other';expBycat[k]=(expBycat[k]||0)+e.amount;});
      const top3=Object.entries(expBycat).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`  ${EXP_CATS_RU[k]||k}: ${fmt(v,user)}`).join('\n');
      const monthName=new Date().toLocaleString('ru-RU',{month:'long'});
      await sendMessage(chatId,
        `📅 <b>Еженедельный отчёт — ${monthName}</b>\n\n` +
        `💰 Доход: <b>${fmt(t.income,user)}</b>\n` +
        `🏦 Откладываю: <b>${fmt(t.saved,user)}</b> (${savePct}%)\n` +
        `💸 Расходы: <b>${fmt(t.expense,user)}</b> (${expPct}%)\n` +
        `🟰 Баланс: <b>${fmt(balance,user)}</b>\n\n` +
        `<b>Топ расходов:</b>\n${top3||'  Нет расходов'}\n\n` +
        `<i>«Золото копится у того, кто откладывает не менее десятой части.»</i>`
      );
    }catch(e){console.error('Weekly error:',e);}
  }
}

async function checkSaveReminders() {
  const now=new Date();
  const daysInMonth=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const daysLeft=daysInMonth-now.getDate();
  if(daysLeft>3) return; // Только последние 3 дня месяца
  for(const[chatId,user] of Object.entries(USERS)){
    try{
      const snap=await db.collection(`${user.prefix}_entries`)
        .where('month','==',monthKey()).where('cat','==','save').get();
      if(snap.empty){
        await sendMessage(chatId,
          `🔔 <b>Аркад напоминает</b>\n\nДо конца месяца ${daysLeft} ${daysLeft===1?'день':'дня'}.\n\n` +
          `Ты ещё не отложил себе в этом месяце. Первый закон Вавилона гласит: заплати себе первым.\n\n` +
          `<i>«Часть всего, что зарабатываешь, — твоя и должна остаться у тебя.»</i>`
        );
      }
    }catch(e){console.error('Reminder error:',e);}
  }
}

async function processRecurringPayments() {
  for(const[chatId,user] of Object.entries(USERS)){
    try{
      const snap=await db.collection(`${user.prefix}_recurring`).where('active','==',true).get();
      if(snap.empty) continue;
      const col=db.collection(`${user.prefix}_entries`);
      const lines=[];
      for(const doc of snap.docs){
        const r=doc.data();
        await col.add({desc:r.desc,cat:r.cat||'expense',amount:r.amount,subcat:r.subcat||'other',date:todayStr(),month:monthKey(),ts:Date.now(),source:'recurring'});
        lines.push(`🔁 ${r.desc}: ${fmt(r.amount,user)}`);
      }
      if(lines.length) await sendMessage(chatId,`🔁 <b>Регулярные платежи списаны</b>\n\n${lines.join('\n')}\n\n<i>Не забудь отложить себе!</i>`);
    }catch(e){console.error('Recurring error:',e);}
  }
}

function startScheduler() {
  setInterval(async()=>{
    const now=new Date();
    const h=now.getHours(),m=now.getMinutes(),d=now.getDate(),dow=now.getDay();
    if(dow===0&&h===19&&m===0) await sendWeeklyReports();        // Воскресенье 19:00
    if(d===1&&h===9&&m===0)    await processRecurringPayments(); // 1-е число 09:00
    if(h===10&&m===0)          await checkSaveReminders();       // Каждый день 10:00
  },60000);
}

// ── WEBHOOK ───────────────────────────────────────────────
app.post('/webhook',async(req,res)=>{
  res.sendStatus(200);
  try{ const msg=req.body.message||req.body.edited_message; if(msg) await handleMessage(msg); }
  catch(e){ console.error(e); }
});
app.get('/',(req,res)=>res.send('Babylon Bot 🏛 v3'));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{ console.log(`Bot v3 on port ${PORT}`); startScheduler(); });
