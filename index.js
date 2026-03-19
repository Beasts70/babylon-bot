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
  еда:'food',кафе:'food',ресторан:'food',продукты:'food',обед:'food',ужин:'food',завтрак:'food',перекус:'food',
  такси:'transport',транспорт:'transport',метро:'transport',бензин:'transport',парковка:'transport',uber:'transport',
  аренда:'home',жильё:'home',коммуналка:'home',жилье:'home',
  здоровье:'health',аптека:'health',врач:'health',спорт:'health',
  развлечения:'fun',кино:'fun',игры:'fun',подписка:'fun',бар:'fun',
  одежда:'clothes',обувь:'clothes',
};
const EXP_CATS_RU = {food:'Еда',transport:'Транспорт',home:'Жильё',health:'Здоровье',fun:'Развлечения',clothes:'Одежда',other:'Прочее'};

function guessSubcat(desc) {
  const d = desc.toLowerCase();
  for (const [k,v] of Object.entries(EXP_CATS)) if (d.includes(k)) return v;
  return 'other';
}

function monthKey(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
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

async function sendMessage(chatId, text, keyboard, opts) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', ...opts };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  else if (opts && opts.inline_keyboard) body.reply_markup = { inline_keyboard: opts.inline_keyboard };
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
  form.append('caption', caption || '');
  form.append('document', Buffer.from(content, 'utf-8'), { filename });
  await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
}

const userState = {};

// ── ГЛАВНОЕ МЕНЮ ──────────────────────────────────────────
const MAIN_KB = [
  ['💰 Доход', '💸 Расход'],
  ['🏦 Себе', '📈 Инвестиции'],
  ['📊 Баланс', '📋 История'],
  ['🎯 Цели', '🔁 Регулярные'],
  ['⚠️ Лимиты', '❓ Помощь'],
];

// ── ПОЛУЧИТЬ ТОТАЛЫ ───────────────────────────────────────
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

// ── ПРОВЕРКА ЛИМИТОВ ──────────────────────────────────────
async function checkLimits(prefix, user, chatId, newEntry) {
  if (newEntry.cat !== 'expense') return;
  const limSnap = await db.collection(`${prefix}_limits`).get();
  if (limSnap.empty) return;
  const limits = {};
  limSnap.docs.forEach(d => { limits[d.data().subcat] = d.data().amount; });

  const subcat = newEntry.subcat || 'other';
  if (!limits[subcat] && !limits['all']) return;

  // Считаем текущие расходы по категории за месяц
  const snap = await db.collection(`${prefix}_entries`)
    .where('month','==',monthKey())
    .where('cat','==','expense')
    .get();
  const total = snap.docs
    .filter(d => (d.data().subcat||'other') === subcat)
    .reduce((s,d) => s + d.data().amount, 0);

  const limit = limits[subcat];
  if (limit && total > limit) {
    const over = total - limit;
    await sendMessage(chatId,
      `⚠️ <b>Лимит превышен!</b>\n\n` +
      `Категория: ${EXP_CATS_RU[subcat]||subcat}\n` +
      `Лимит: ${fmt(limit,user)}\n` +
      `Потрачено: ${fmt(total,user)}\n` +
      `Превышение: <b>${fmt(over,user)}</b>`
    );
  } else if (limit && total > limit * 0.8) {
    const left = limit - total;
    await sendMessage(chatId,
      `🟡 <b>Внимание — лимит скоро исчерпан</b>\n\n` +
      `${EXP_CATS_RU[subcat]||subcat}: осталось <b>${fmt(left,user)}</b> из ${fmt(limit,user)}`
    );
  }
}

// ── ОБРАБОТЧИК СООБЩЕНИЙ ──────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  const user = getUser(chatId);
  if (!user) { await sendMessage(chatId, '🚫 У тебя нет доступа к этому боту.'); return; }

  const { prefix } = user;
  const entriesCol = db.collection(`${prefix}_entries`);
  const goalsCol   = db.collection(`${prefix}_goals`);
  const limitsCol  = db.collection(`${prefix}_limits`);
  const recurCol   = db.collection(`${prefix}_recurring`);
  const settingsDoc = db.collection(`${prefix}_settings`).doc('main');

  // ── /start ────────────────────────────────────────────
  if (lower === '/start' || lower === 'меню' || lower === 'начало') {
    await sendMessage(chatId,
      `🏛 <b>Вавилонский учёт</b>\n\n` +
      `<b>Быстрый ввод:</b>\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю\n` +
      `<code>инвест 10000</code> — инвестиции\n\n` +
      `<b>Команды:</b>\n` +
      `/отмена — удалить последнюю запись\n` +
      `/pdf — отчёт за месяц\n` +
      `/лимит еда 5000 — установить лимит\n` +
      `/лимиты — посмотреть все лимиты\n` +
      `/каждый аренда 50000 — регулярный платёж`,
      MAIN_KB
    );
    return;
  }

  // ── /отмена ───────────────────────────────────────────
  if (lower === '/отмена' || lower === 'отмена') {
    const snap = await entriesCol.orderBy('ts','desc').limit(1).get();
    if (snap.empty) { await sendMessage(chatId, 'Нет записей для отмены.', MAIN_KB); return; }
    const last = snap.docs[0];
    const e = last.data();
    // Если это была цель — возвращаем сумму
    if (e.cat === 'goal' && e.goalId) {
      const g = await goalsCol.doc(e.goalId).get();
      if (g.exists) await goalsCol.doc(e.goalId).update({ saved: Math.max((g.data().saved||0)-e.amount, 0) });
    }
    await last.ref.delete();
    const sign = (e.cat==='expense'||e.cat==='goal')?'−':'+';
    await sendMessage(chatId,
      `↩️ <b>Отменено</b>\n\n${catLabel(e.cat)}: ${sign}${fmt(e.amount,user)}\n📝 ${e.desc}`,
      MAIN_KB
    );
    return;
  }

  // ── /pdf ──────────────────────────────────────────────
  if (lower === '/pdf' || lower === 'pdf') {
    const t = await getTotals(prefix);
    const settSnap = await settingsDoc.get();
    const selfPct = settSnap.exists ? (settSnap.data().selfPct||10) : 10;
    const target = t.income * selfPct / 100;
    const balance = t.income - t.saved - t.invested - t.expense - t.goalPaid;
    const savePct = t.income>0 ? Math.round((t.saved/t.income)*100) : 0;
    const expPct  = t.income>0 ? Math.round((t.expense/t.income)*100) : 0;
    const invPct  = t.income>0 ? Math.round((t.invested/t.income)*100) : 0;

    // Разбивка расходов по категориям
    const expBycat = {};
    t.entries.filter(e=>e.cat==='expense').forEach(e=>{
      const k = e.subcat||'other';
      expBycat[k] = (expBycat[k]||0) + e.amount;
    });
    const expLines = Object.entries(expBycat)
      .sort((a,b)=>b[1]-a[1])
      .map(([k,v])=>`  ${EXP_CATS_RU[k]||k}: ${fmt(v,user)}`)
      .join('\n');

    // Последние записи
    const lastEntries = t.entries
      .sort((a,b)=>(b.ts||0)-(a.ts||0))
      .slice(0,15)
      .map(e=>{
        const sign=(e.cat==='expense'||e.cat==='goal')?'-':'+';
        return `  ${e.date||''} | ${catLabel(e.cat).padEnd(12)} | ${sign}${fmt(e.amount,user).padStart(12)} | ${e.desc}`;
      }).join('\n');

    const now = new Date();
    const monthName = now.toLocaleString('ru-RU',{month:'long',year:'numeric'});

    const csv =
`ФИНАНСОВЫЙ ОТЧЁТ — ${monthName.toUpperCase()}
${'='.repeat(50)}

СВОДКА
------
Доход:              ${fmt(t.income,user)}
Себе (цель ${selfPct}%):   ${fmt(target,user)}
Откладываю факт:    ${fmt(t.saved,user)} (${savePct}%)
Инвестиции:         ${fmt(t.invested,user)} (${invPct}%)
Расходы:            ${fmt(t.expense,user)} (${expPct}%)
Баланс:             ${fmt(balance,user)}

РАСХОДЫ ПО КАТЕГОРИЯМ
---------------------
${expLines||'  Нет расходов'}

ЗАПИСИ
------
${lastEntries||'  Нет записей'}

${'='.repeat(50)}
Сгенерировано: ${new Date().toLocaleString('ru-RU')}
Законы Вавилона — финансовый учёт
`;

    await sendDocument(chatId, `отчёт_${monthKey()}.txt`, csv, `📄 Отчёт за ${monthName}`);
    return;
  }

  // ── ЛИМИТЫ ───────────────────────────────────────────
  if (lower.startsWith('/лимит ') || lower.startsWith('лимит ')) {
    // Формат: /лимит еда 5000
    const parts = text.replace(/^\/?(лимит)\s*/i,'').trim().split(/\s+/);
    const numIdx = parts.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
    if (numIdx === -1) { await sendMessage(chatId, 'Формат: <code>лимит еда 5000</code>', MAIN_KB); return; }
    const amount = parseFloat(parts[numIdx].replace(',','.'));
    const catWords = parts.filter((_,i)=>i!==numIdx).join(' ').toLowerCase();
    const subcat = EXP_CATS[catWords] || catWords || 'other';
    await limitsCol.doc(subcat).set({ subcat, amount, ts: Date.now() });
    await sendMessage(chatId,
      `✅ Лимит установлен\n\n${EXP_CATS_RU[subcat]||catWords}: <b>${fmt(amount,user)}</b> в месяц`,
      MAIN_KB
    );
    return;
  }

  if (lower === '/лимиты' || lower === '⚠️ лимиты' || lower === 'лимиты') {
    const snap = await limitsCol.get();
    if (snap.empty) { await sendMessage(chatId, 'Лимитов пока нет.\n\nУстанови: <code>лимит еда 5000</code>', MAIN_KB); return; }

    // Считаем текущие расходы за месяц
    const tSnap = await entriesCol.where('month','==',monthKey()).where('cat','==','expense').get();
    const spent = {};
    tSnap.docs.forEach(d=>{ const k=d.data().subcat||'other'; spent[k]=(spent[k]||0)+d.data().amount; });

    const lines = snap.docs.map(d=>{
      const { subcat, amount } = d.data();
      const s = spent[subcat]||0;
      const pct = Math.round((s/amount)*100);
      const bar = pct>=100?'🔴':pct>=80?'🟡':'🟢';
      return `${bar} ${EXP_CATS_RU[subcat]||subcat}: ${fmt(s,user)} / ${fmt(amount,user)} (${pct}%)`;
    });
    await sendMessage(chatId, `⚠️ <b>Лимиты за месяц</b>\n\n${lines.join('\n')}`, MAIN_KB);
    return;
  }

  // ── РЕГУЛЯРНЫЕ ПЛАТЕЖИ ────────────────────────────────
  if (lower.startsWith('/каждый ') || lower.startsWith('каждый ')) {
    // Формат: каждый аренда 50000
    const parts = text.replace(/^\/?(каждый)\s*/i,'').trim().split(/\s+/);
    const numIdx = parts.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
    if (numIdx === -1) { await sendMessage(chatId, 'Формат: <code>каждый аренда 50000</code>', MAIN_KB); return; }
    const amount = parseFloat(parts[numIdx].replace(',','.'));
    const desc = parts.filter((_,i)=>i!==numIdx).join(' ') || 'Регулярный платёж';
    const subcat = guessSubcat(desc);
    const id = `${desc}_${amount}`.replace(/\s+/g,'_');
    await recurCol.doc(id).set({ desc, amount, subcat, cat:'expense', ts:Date.now(), active:true });
    await sendMessage(chatId,
      `🔁 <b>Регулярный платёж добавлен</b>\n\n📝 ${desc}: <b>${fmt(amount,user)}</b>\nСписывается автоматически 1-го числа каждого месяца`,
      MAIN_KB
    );
    return;
  }

  if (lower === '🔁 регулярные' || lower === '/регулярные' || lower === 'регулярные') {
    const snap = await recurCol.where('active','==',true).get();
    if (snap.empty) { await sendMessage(chatId, 'Регулярных платежей нет.\n\nДобавь: <code>каждый аренда 50000</code>', MAIN_KB); return; }
    const lines = snap.docs.map(d=>`🔁 ${d.data().desc}: <b>${fmt(d.data().amount,user)}</b>`);
    await sendMessage(chatId, `🔁 <b>Регулярные платежи</b>\n\n${lines.join('\n')}\n\n<i>Списываются 1-го числа каждого месяца</i>`, MAIN_KB);
    return;
  }

  // ── БАЛАНС ────────────────────────────────────────────
  if (lower === '📊 баланс' || lower === '/баланс' || lower === 'баланс') {
    const t = await getTotals(prefix);
    const settSnap = await settingsDoc.get();
    const selfPct = settSnap.exists ? (settSnap.data().selfPct||10) : 10;
    const target  = t.income * selfPct / 100;
    const balance = t.income - t.saved - t.invested - t.expense - t.goalPaid;
    const savePct = t.income>0 ? Math.round((t.saved/t.income)*100) : 0;
    const expPct  = t.income>0 ? Math.round((t.expense/t.income)*100) : 0;
    const invPct  = t.income>0 ? Math.round((t.invested/t.income)*100) : 0;

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

    const monthName = new Date().toLocaleString('ru-RU',{month:'long',year:'numeric'});
    await sendMessage(chatId,
      `📊 <b>Баланс за ${monthName}</b>\n\n` +
      `💰 Доход: <b>${fmt(t.income,user)}</b>\n` +
      `🏦 Себе — цель (${selfPct}%): <b>${fmt(target,user)}</b>\n` +
      `🏦 Откладываю факт: <b>${fmt(t.saved,user)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(t.invested,user)}</b> (${invPct}%)\n` +
      `💸 Расходы: <b>${fmt(t.expense,user)}</b> (${expPct}%)\n` +
      `━━━━━━━━━━━━━━\n` +
      `🟰 Баланс: <b>${fmt(balance,user)}</b>\n\n` +
      `${wisdom} — ${score}/100\n\n` +
      `<i>Напиши /pdf чтобы получить полный отчёт</i>`,
      MAIN_KB
    );
    return;
  }

  // ── ИСТОРИЯ ───────────────────────────────────────────
  if (lower === '📋 история' || lower === '/история' || lower === 'история') {
    const snap = await entriesCol.orderBy('ts','desc').limit(10).get();
    if (snap.empty) { await sendMessage(chatId, 'Записей пока нет.', MAIN_KB); return; }
    const catEmoji = {income:'💰',save:'🏦',invest:'📈',expense:'💸',goal:'🎯'};
    const lines = snap.docs.map(d=>{
      const e=d.data();
      const sign=(e.cat==='expense'||e.cat==='goal')?'−':'+';
      return `${catEmoji[e.cat]||'•'} ${e.desc} — <b>${sign}${fmt(e.amount,user)}</b> <i>${e.date||''}</i>`;
    });
    await sendMessage(chatId,
      `📋 <b>Последние записи</b>\n\n${lines.join('\n')}\n\n<i>/отмена — удалить последнюю</i>`,
      MAIN_KB
    );
    return;
  }

  // ── ЦЕЛИ ─────────────────────────────────────────────
  if (lower === '🎯 цели' || lower === '/цели' || lower === 'цели') {
    const snap = await goalsCol.orderBy('ts','asc').get();
    if (snap.empty) { await sendMessage(chatId, '🎯 Целей пока нет. Добавь их в веб-приложении.', MAIN_KB); return; }
    const lines = snap.docs.map(d=>{
      const g=d.data(); const s=g.saved||0;
      const pct=Math.min(Math.round((s/g.target)*100),100);
      const bar='█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
      return `🎯 <b>${g.name}</b>\n${bar} ${pct}%\n${fmt(s,user)} / ${fmt(g.target,user)}`;
    });
    await sendMessage(chatId, `🎯 <b>Цели накоплений</b>\n\n${lines.join('\n\n')}`, MAIN_KB);
    return;
  }

  // ── ПОМОЩЬ ───────────────────────────────────────────
  if (lower === '❓ помощь' || lower === '/help' || lower === 'помощь') {
    await sendMessage(chatId,
      `<b>Быстрый ввод:</b>\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю\n` +
      `<code>инвест etf 10000</code> — инвестиции\n\n` +
      `<b>Команды:</b>\n` +
      `/отмена — удалить последнюю запись\n` +
      `/pdf — отчёт за месяц текстом\n\n` +
      `<b>Лимиты:</b>\n` +
      `<code>лимит еда 5000</code> — лимит на категорию\n` +
      `/лимиты — посмотреть все лимиты\n\n` +
      `<b>Регулярные платежи:</b>\n` +
      `<code>каждый аренда 50000</code> — списывается 1-го числа\n` +
      `/регулярные — список регулярных платежей`,
      MAIN_KB
    );
    return;
  }

  // Кнопки категорий
  if (lower==='💰 доход')     {userState[chatId]={cat:'income'};  await sendMessage(chatId,'💰 <code>зарплата 150000</code>',MAIN_KB);return;}
  if (lower==='💸 расход')    {userState[chatId]={cat:'expense'}; await sendMessage(chatId,'💸 <code>кофе 350</code>',MAIN_KB);return;}
  if (lower==='🏦 себе')      {userState[chatId]={cat:'save'};    await sendMessage(chatId,'🏦 Сумма: <code>15000</code>',MAIN_KB);return;}
  if (lower==='📈 инвестиции'){userState[chatId]={cat:'invest'};  await sendMessage(chatId,'📈 <code>etf 10000</code>',MAIN_KB);return;}

  // ── БЫСТРЫЙ ВВОД ─────────────────────────────────────
  let cat = null;
  if (userState[chatId]) { cat=userState[chatId].cat; delete userState[chatId]; }

  const words = text.split(/\s+/);
  const numIdx = words.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));

  if (numIdx === -1) {
    await sendMessage(chatId,
      `Не понял. Попробуй:\n<code>кофе 350</code>\n<code>+зарплата 150000</code>\n<code>себе 15000</code>\n\nИли нажми /start`,
      MAIN_KB
    );
    return;
  }

  const amount = parseFloat(words[numIdx].replace(',','.'));
  let desc = words.filter((_,i)=>i!==numIdx).join(' ').replace(/^[+]/,'').trim();

  if (!cat) {
    if (text.startsWith('+'))                                         cat='income';
    else if (lower.startsWith('себе')||lower.startsWith('отложи'))    cat='save';
    else if (lower.startsWith('инвест'))                              cat='invest';
    else                                                               cat='expense';
  }

  desc = desc.replace(/^(себе|отложи|инвест)\s*/i,'').trim() || catLabel(cat);

  const entry = { desc, cat, amount, date:todayStr(), month:monthKey(), ts:Date.now(), source:'telegram' };
  if (cat==='expense') entry.subcat = guessSubcat(desc);

  await entriesCol.add(entry);

  const catNames = {income:'💰 Доход',save:'🏦 Себе',invest:'📈 Инвестиции',expense:'💸 Расход'};
  const sign = (cat==='expense')?'−':'+';

  await sendMessage(chatId,
    `✅ <b>Записано</b>\n\n${catNames[cat]}: <b>${sign}${fmt(amount,user)}</b>\n📝 ${desc}\n\n<i>/отмена если ошибся</i>`,
    MAIN_KB
  );

  // Проверяем лимиты
  await checkLimits(prefix, user, chatId, entry);
}

// ── ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ───────────────────────────────────
async function sendWeeklyReports() {
  for (const [chatId, user] of Object.entries(USERS)) {
    try {
      const t = await getTotals(user.prefix);
      if (t.income === 0 && t.expense === 0) continue;

      const balance = t.income - t.saved - t.invested - t.expense - t.goalPaid;
      const expPct = t.income>0 ? Math.round((t.expense/t.income)*100) : 0;
      const savePct = t.income>0 ? Math.round((t.saved/t.income)*100) : 0;

      // Разбивка расходов
      const expBycat = {};
      t.entries.filter(e=>e.cat==='expense').forEach(e=>{
        const k=e.subcat||'other'; expBycat[k]=(expBycat[k]||0)+e.amount;
      });
      const top3 = Object.entries(expBycat).sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([k,v])=>`  ${EXP_CATS_RU[k]||k}: ${fmt(v,user)}`).join('\n');

      const monthName = new Date().toLocaleString('ru-RU',{month:'long'});

      await sendMessage(chatId,
        `📅 <b>Еженедельный отчёт — ${monthName}</b>\n\n` +
        `💰 Доход: <b>${fmt(t.income,user)}</b>\n` +
        `🏦 Откладываю: <b>${fmt(t.saved,user)}</b> (${savePct}%)\n` +
        `💸 Расходы: <b>${fmt(t.expense,user)}</b> (${expPct}%)\n` +
        `🟰 Баланс: <b>${fmt(balance,user)}</b>\n\n` +
        `<b>Топ расходов:</b>\n${top3||'  Нет расходов'}\n\n` +
        `<i>«Золото копится у того, кто откладывает не менее десятой части заработанного.»</i>`
      );
    } catch(e) { console.error('Weekly report error:', e); }
  }
}

// ── РЕГУЛЯРНЫЕ ПЛАТЕЖИ — 1-е ЧИСЛО ───────────────────────
async function processRecurringPayments() {
  for (const [chatId, user] of Object.entries(USERS)) {
    try {
      const snap = await db.collection(`${user.prefix}_recurring`).where('active','==',true).get();
      if (snap.empty) continue;
      const col = db.collection(`${user.prefix}_entries`);
      const lines = [];
      for (const doc of snap.docs) {
        const r = doc.data();
        await col.add({
          desc: r.desc, cat: r.cat||'expense', amount: r.amount,
          subcat: r.subcat||'other', date: todayStr(),
          month: monthKey(), ts: Date.now(), source: 'recurring',
        });
        lines.push(`🔁 ${r.desc}: ${fmt(r.amount,user)}`);
      }
      if (lines.length) {
        await sendMessage(chatId,
          `🔁 <b>Регулярные платежи списаны</b>\n\n${lines.join('\n')}\n\n<i>Начало нового месяца — не забудь отложить себе!</i>`
        );
      }
    } catch(e) { console.error('Recurring error:', e); }
  }
}

// ── ПЛАНИРОВЩИК ───────────────────────────────────────────
function startScheduler() {
  setInterval(async () => {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), d = now.getDate(), dow = now.getDay();
    // Еженедельный отчёт — воскресенье 19:00
    if (dow===0 && h===19 && m===0) await sendWeeklyReports();
    // Регулярные платежи — 1-е число каждого месяца 09:00
    if (d===1 && h===9 && m===0) await processRecurringPayments();
  }, 60000); // каждую минуту
}

// ── WEBHOOK ───────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message || req.body.edited_message;
    if (msg) await handleMessage(msg);
  } catch(e) { console.error(e); }
});

app.get('/', (req,res) => res.send('Babylon Bot 🏛 v2 is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
  startScheduler();
});
