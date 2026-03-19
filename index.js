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

// ── КОНФИГ ────────────────────────────────────────────────
const TRIAL_DAYS = 7;
const PRICE_RUB  = 299;
const PRICE_EUR  = 3.99;
const ADMIN_IDS  = ['5080699264']; // Арсен — бесплатный доступ навсегда
const APP_URL    = 'https://roaring-pegasus-df74bc.netlify.app';
const BOT_USERNAME = process.env.BOT_USERNAME || 'babylon_finance_bot';
const REF_BONUS_DAYS = 30; // бонус за реферала (дней)

// ── ВАЛЮТЫ ────────────────────────────────────────────────
const CURRENCIES = {
  rub: { symbol: '₽', name: 'Рубли (₽)',   locale: 'ru-RU' },
  eur: { symbol: '€', name: 'Евро (€)',     locale: 'ru-RU' },
  usd: { symbol: '$', name: 'Доллары ($)',  locale: 'ru-RU' },
  uah: { symbol: '₴', name: 'Гривны (₴)',  locale: 'ru-RU' },
  amd: { symbol: '֏', name: 'Армянский драм (֏)', locale: 'ru-RU' },
  kzt: { symbol: '₸', name: 'Тенге (₸)',   locale: 'ru-RU' },
};

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
  food:'Еда', transport:'Транспорт', home:'Жильё',
  health:'Здоровье', fun:'Развлечения', clothes:'Одежда', other:'Прочее'
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
  const d = new Date(); d.setMonth(d.getMonth()-1); return monthKey(d);
}
function todayStr() {
  return new Date().toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
}
function fmt(n, cur) {
  return Math.round(n).toLocaleString('ru-RU') + ' ' + cur.symbol;
}
function catLabel(c) {
  return {income:'Доход',save:'Себе',invest:'Инвестиции',expense:'Расход',goal:'Цель'}[c]||c;
}

// ── TELEGRAM API ──────────────────────────────────────────
async function sendMessage(chatId, text, keyboard, extra) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', ...extra };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  const r = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendInvoice(chatId, cur) {
  const isRub = cur.symbol === '₽';
  const body = {
    chat_id: chatId,
    title: '🏛 Вавилонский учёт — Подписка',
    description: `Полный доступ на 30 дней. Цели, лимиты, отчёты, история без ограничений.`,
    payload: `sub_${chatId}_${Date.now()}`,
    currency: isRub ? 'RUB' : 'EUR',
    prices: isRub
      ? [{ label: 'Подписка 1 месяц', amount: PRICE_RUB * 100 }]
      : [{ label: 'Subscription 1 month', amount: Math.round(PRICE_EUR * 100) }],
    provider_token: '', // Telegram Stars — не нужен токен
  };
  await fetch(`${API}/sendInvoice`, {
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

// ── ПОЛЬЗОВАТЕЛИ ─────────────────────────────────────────
async function getUser(chatId) {
  const ref = db.collection('users').doc(String(chatId));
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

async function createUser(chatId, telegramData, referredBy) {
  const now = Date.now();
  const extraDays = referredBy ? REF_BONUS_DAYS : 0;
  const user = {
    chatId: String(chatId),
    name: telegramData.first_name || 'Пользователь',
    username: telegramData.username || '',
    currency: 'rub',
    prefix: `user_${chatId}`,
    createdAt: now,
    trialEnd: now + (TRIAL_DAYS + extraDays) * 24 * 60 * 60 * 1000,
    isPaid: false,
    paidUntil: null,
    isAdmin: ADMIN_IDS.includes(String(chatId)),
    referredBy: referredBy || null,
    referralCount: 0,
  };
  await db.collection('users').doc(String(chatId)).set(user);

  // Начисляем бонус пригласившему
  if (referredBy) {
    const refDoc = await db.collection('users').doc(String(referredBy)).get();
    if (refDoc.exists) {
      const refUser = refDoc.data();
      const newCount = (refUser.referralCount || 0) + 1;
      // Продлеваем его доступ на REF_BONUS_DAYS
      let newEnd;
      if (refUser.isPaid && refUser.paidUntil && refUser.paidUntil > Date.now()) {
        newEnd = refUser.paidUntil + REF_BONUS_DAYS * 24 * 60 * 60 * 1000;
        await db.collection('users').doc(String(referredBy)).update({ paidUntil: newEnd, referralCount: newCount });
      } else {
        newEnd = Math.max(refUser.trialEnd, Date.now()) + REF_BONUS_DAYS * 24 * 60 * 60 * 1000;
        await db.collection('users').doc(String(referredBy)).update({ trialEnd: newEnd, referralCount: newCount });
      }
      // Уведомляем пригласившего
      await sendMessage(String(referredBy),
        '🎉 <b>Твой реферал зарегистрировался!</b>\n\n' +
        '<b>' + (telegramData.first_name || 'Новый пользователь') + '</b> присоединился по твоей ссылке.\n\n' +
        '🎁 Тебе начислено <b>' + REF_BONUS_DAYS + ' дней</b> бесплатного доступа!'
      );
    }
  }

  return user;
}

async function updateUser(chatId, data) {
  await db.collection('users').doc(String(chatId)).update(data);
}

function isActive(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.isVip) return true;
  if (user.isPaid && user.paidUntil && Date.now() < user.paidUntil) return true;
  if (Date.now() < user.trialEnd) return true;
  return false;
}

function trialDaysLeft(user) {
  const ms = user.trialEnd - Date.now();
  return Math.max(0, Math.ceil(ms / (24*60*60*1000)));
}

function getCurrency(user) {
  return CURRENCIES[user.currency] || CURRENCIES.rub;
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
  ['🤝 Реферал',        '💳 Подписка'],
];

const CURRENCY_KB = [
  ['🇷🇺 Рубли (₽)',   '🇪🇺 Евро (€)'],
  ['🇺🇸 Доллары ($)', '🇺🇦 Гривны (₴)'],
  ['🇦🇲 Драм (֏)',    '🇰🇿 Тенге (₸)'],
];

const CURRENCY_MAP = {
  '🇷🇺 рубли (₽)':   'rub',
  '🇪🇺 евро (€)':     'eur',
  '🇺🇸 доллары ($)':  'usd',
  '🇺🇦 гривны (₴)':  'uah',
  '🇦🇲 драм (֏)':    'amd',
  '🇰🇿 тенге (₸)':   'kzt',
};

const userState = {};

// ── ПЕЙВОЛ ───────────────────────────────────────────────
async function sendPaywall(chatId, user) {
  const cur = getCurrency(user);
  const price = cur.symbol === '₽' ? `${PRICE_RUB}₽` : `${PRICE_EUR}€`;
  await sendMessage(chatId,
    `⏰ <b>Пробный период закончился</b>\n\n` +
    `Ты использовал 7 бесплатных дней.\n\n` +
    `Чтобы продолжить пользоваться ботом, оформи подписку:\n\n` +
    `🏛 <b>Вавилонский учёт</b>\n` +
    `${price}/месяц — полный доступ\n\n` +
    `✅ Неограниченные записи\n` +
    `✅ Цели, лимиты, регулярные платежи\n` +
    `✅ Еженедельные отчёты\n` +
    `✅ Веб-приложение\n` +
    `✅ Советы Аркада`,
    null,
    { reply_markup: { inline_keyboard: [[
      { text: `💳 Оплатить ${price}/мес`, callback_data: 'pay' }
    ]]}}
  );
}

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
async function checkLimits(prefix, cur, chatId, entry) {
  if (entry.cat !== 'expense') return;
  const limSnap = await db.collection(`${prefix}_limits`).get();
  if (limSnap.empty) return;
  const limits = {};
  limSnap.docs.forEach(d=>{ limits[d.data().subcat]=d.data().amount; });
  const subcat = entry.subcat||'other';
  if (!limits[subcat]) return;
  const snap = await db.collection(`${prefix}_entries`)
    .where('month','==',monthKey()).where('cat','==','expense').get();
  const total = snap.docs.filter(d=>(d.data().subcat||'other')===subcat).reduce((s,d)=>s+d.data().amount,0);
  const limit = limits[subcat];
  if (total > limit) {
    await sendMessage(chatId, `⚠️ <b>Лимит превышен!</b>\n${EXP_CATS_RU[subcat]||subcat}: ${fmt(total,cur)} / ${fmt(limit,cur)}`);
  } else if (total > limit*0.8) {
    await sendMessage(chatId, `🟡 Осталось по лимиту <b>${EXP_CATS_RU[subcat]||subcat}</b>: ${fmt(limit-total,cur)}`);
  }
}

// ── СТАТУС ПОДПИСКИ ───────────────────────────────────────
function statusMsg(user) {
  if (user.isAdmin) return '👑 Администратор';
  if (user.isVip) return '⭐️ VIP — пожизненный доступ';
  if (user.isPaid && user.paidUntil) {
    const days = Math.ceil((user.paidUntil - Date.now()) / (24*60*60*1000));
    return `✅ Подписка активна — ${days} дн.`;
  }
  const left = trialDaysLeft(user);
  return left > 0 ? `🎁 Пробный период — ${left} дн.` : '❌ Подписка не активна';
}

// ── ОБРАБОТЧИК СООБЩЕНИЙ ─────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text||'').trim();
  const lower = text.toLowerCase();

  // Загружаем или создаём пользователя
  let user = await getUser(chatId);

  // /start — регистрация или приветствие
  if (lower === '/start' || lower === 'меню' || lower === 'начало') {
    if (!user) {
      // Новый пользователь — проверяем реферальный код
      // Формат: /start ref_CHATID
      let referredBy = null;
      const startParam = text.replace('/start', '').trim();
      if (startParam.startsWith('ref_')) {
        const refId = startParam.replace('ref_', '');
        if (refId !== chatId && /^\d+$/.test(refId)) {
          const refSnap = await db.collection('users').doc(refId).get();
          if (refSnap.exists) referredBy = refId;
        }
      }
      user = await createUser(chatId, msg.from, referredBy);
      await sendMessage(chatId,
        `🏛 <b>Добро пожаловать в Вавилонский учёт!</b>\n\n` +
        `Я помогу тебе контролировать финансы по принципам книги\n«Самый богатый человек в Вавилоне».\n\n` +
        `📱 Записывай расходы прямо здесь\n` +
        '🌐 <a href="' + APP_URL + '?id=' + chatId + '">Веб-приложение</a> — графики, цели, прогноз\n' +
        `🎯 Цели, лимиты, отчёты\n\n` +
        `<b>Выбери валюту:</b>`,
        CURRENCY_KB
      );
      userState[chatId] = { mode: 'choose_currency' };
      return;
    }

    if (!isActive(user)) { await sendPaywall(chatId, user); return; }

    const cur = getCurrency(user);
    const statusLine = user.isAdmin ? '' : `\n<i>${statusMsg(user)}</i>`;
    await sendMessage(chatId,
      `🏛 <b>Вавилонский учёт</b>${statusLine}\n\n` +
      `<b>Быстрый ввод:</b>\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю\n` +
      `<code>инвест 10000</code> — инвестиции\n\n` +
      '🌐 <a href="' + APP_URL + '?id=' + chatId + '">Открыть веб-приложение →</a>',
      MAIN_KB
    );
    return;
  }

  // Выбор валюты при регистрации
  if (userState[chatId]?.mode === 'choose_currency') {
    const currCode = CURRENCY_MAP[lower];
    if (!currCode) {
      await sendMessage(chatId, 'Выбери валюту из списка:', CURRENCY_KB);
      return;
    }
    delete userState[chatId];
    await updateUser(chatId, { currency: currCode });
    user = await getUser(chatId);
    const cur = getCurrency(user);

    await sendMessage(chatId,
      `✅ Отлично! Валюта — <b>${cur.name}</b>\n\n` +
      `🎁 У тебя <b>${TRIAL_DAYS} дней бесплатного доступа</b>.\n\n` +
      `Как записывать:\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю\n` +
      `<code>инвест 10000</code> — инвестиции\n\n` +
      `<i>«Часть всего, что зарабатываешь, — твоя и должна остаться у тебя.»</i>`,
      MAIN_KB
    );
    return;
  }

  // Если пользователя нет — предлагаем start
  if (!user) {
    await sendMessage(chatId, 'Напиши /start чтобы начать.');
    return;
  }

  // Проверка доступа
  if (!isActive(user)) {
    await sendPaywall(chatId, user);
    return;
  }

  const cur = getCurrency(user);
  const { prefix } = user;
  const entriesCol  = db.collection(`${prefix}_entries`);
  const goalsCol    = db.collection(`${prefix}_goals`);
  const limitsCol   = db.collection(`${prefix}_limits`);
  const recurCol    = db.collection(`${prefix}_recurring`);
  const settingsDoc = db.collection(`${prefix}_settings`).doc('main');


  // ── ADMIN: /vip ───────────────────────────────────────
  if (lower.startsWith('/vip ') && user.isAdmin) {
    const targetId = text.slice(5).trim();
    const targetRef = db.collection('users').doc(targetId);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      await sendMessage(chatId, '❌ Пользователь ' + targetId + ' не найден.', MAIN_KB);
      return;
    }
    await targetRef.update({ isVip: true, isPaid: false, paidUntil: null });
    const t = targetSnap.data();
    await sendMessage(chatId, '⭐️ Пользователь <b>' + (t.name||targetId) + '</b> (@' + (t.username||'—') + ') получил пожизненный доступ.', MAIN_KB);
    await sendMessage(targetId, '⭐️ <b>Поздравляем!</b>\n\nТебе выдан пожизненный бесплатный доступ к Вавилонскому учёту.\n\n<i>«Богатство приходит к тому, кто его заслуживает.»</i>', MAIN_KB);
    return;
  }

  // ── ADMIN: /revoke ────────────────────────────────────
  if (lower.startsWith('/revoke ') && user.isAdmin) {
    const targetId = text.slice(8).trim();
    const targetRef = db.collection('users').doc(targetId);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      await sendMessage(chatId, '❌ Пользователь ' + targetId + ' не найден.', MAIN_KB);
      return;
    }
    await targetRef.update({ isVip: false });
    const t = targetSnap.data();
    await sendMessage(chatId, '✅ VIP доступ у <b>' + (t.name||targetId) + '</b> отозван.', MAIN_KB);
    return;
  }

  // ── ADMIN: /users ─────────────────────────────────────
  if (lower === '/users' && user.isAdmin) {
    const snap = await db.collection('users').orderBy('createdAt','desc').limit(20).get();
    if (snap.empty) { await sendMessage(chatId, 'Пользователей пока нет.', MAIN_KB); return; }
    const lines = snap.docs.map(d => {
      const u = d.data();
      let status = '❌';
      if (u.isAdmin) status = '👑';
      else if (u.isVip) status = '⭐️';
      else if (u.isPaid && u.paidUntil && Date.now() < u.paidUntil) status = '✅';
      else if (Date.now() < u.trialEnd) {
        const left = Math.ceil((u.trialEnd - Date.now()) / (24*60*60*1000));
        status = '🎁' + left + 'д';
      }
      return status + ' <b>' + (u.name||'—') + '</b> (@' + (u.username||'—') + ') — ' + u.chatId;
    });
    await sendMessage(chatId, '👥 <b>Пользователи</b> (' + snap.size + ')\n\n' + lines.join('\n'), MAIN_KB);
    return;
  }



  // /ref — реферальная ссылка
  if (lower === '/ref' || lower === 'реферал' || lower === '/реферал' || lower === '🤝 реферал') {
    const refLink = 'https://t.me/' + BOT_USERNAME + '?start=ref_' + chatId;
    const refCount = user.referralCount || 0;
    const bonusTotal = refCount * REF_BONUS_DAYS;
    await sendMessage(chatId,
      '🤝 <b>Реферальная программа</b>\n\n' +
      'Поделись ссылкой с другом — вы <b>оба</b> получите ' + REF_BONUS_DAYS + ' дней бесплатно:\n\n' +
      '<code>' + refLink + '</code>\n\n' +
      '📊 Твоя статистика:\n' +
      '👥 Приглашено: <b>' + refCount + '</b> чел.\n' +
      '🎁 Заработано: <b>' + bonusTotal + '</b> дней\n\n' +
      '<i>Нажми на ссылку чтобы скопировать и отправить другу</i>',
      MAIN_KB
    );
    return;
  }

  // /app — персональная ссылка
  if (lower === '/app' || lower === 'приложение') {
    await sendMessage(chatId,
      '🌐 <b>Твоё веб-приложение</b>\n\n' +
      'Нажми на ссылку — войдёшь автоматически:\n\n' +
      '<a href="' + APP_URL + '?id=' + chatId + '">' + APP_URL + '?id=' + chatId + '</a>\n\n' +
      '📱 На iPhone: открой в Safari → Поделиться → На экран домой',
      MAIN_KB
    );
    return;
  }

  // ── /подписка / статус ────────────────────────────────
  if (lower === '/подписка' || lower === 'подписка' || lower === '/status' || lower === '💳 подписка') {
    const price = cur.symbol === '₽' ? `${PRICE_RUB}₽` : `${PRICE_EUR}€`;
    await sendMessage(chatId,
      `💳 <b>Подписка</b>\n\n${statusMsg(user)}\n\nСтоимость: <b>${price}/месяц</b>`,
      MAIN_KB,
      { reply_markup: { inline_keyboard: [[
        { text: `💳 Оплатить ${price}/мес`, callback_data: 'pay' }
      ]]}}
    );
    return;
  }

  // ── /валюта ───────────────────────────────────────────
  if (lower === '/валюта' || lower === 'валюта') {
    userState[chatId] = { mode: 'choose_currency' };
    await sendMessage(chatId, 'Выбери новую валюту:', CURRENCY_KB);
    return;
  }

  // ── ↩️ ОТМЕНА ─────────────────────────────────────────
  if (lower === '↩️ отмена' || lower === '/отмена' || lower === 'отмена') {
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
    await sendMessage(chatId,`↩️ <b>Отменено</b>\n\n${catLabel(e.cat)}: ${sign}${fmt(e.amount,cur)}\n📝 ${e.desc}`,MAIN_KB);
    return;
  }

  // ── 🔍 ПОИСК ─────────────────────────────────────────
  if (lower==='🔍 поиск'||lower==='/поиск') {
    userState[chatId]={mode:'search'};
    await sendMessage(chatId,'🔍 Введи слово для поиска:',MAIN_KB);
    return;
  }
  if (lower.startsWith('поиск ')||userState[chatId]?.mode==='search') {
    const query = lower.startsWith('поиск ') ? text.slice(6).trim() : text.trim();
    delete userState[chatId];
    if (!query) { await sendMessage(chatId,'Укажи слово: <code>поиск кофе</code>',MAIN_KB); return; }
    const snap = await entriesCol.orderBy('ts','desc').limit(200).get();
    const found = snap.docs.map(d=>d.data()).filter(e=>e.desc&&e.desc.toLowerCase().includes(query.toLowerCase()));
    if (!found.length) { await sendMessage(chatId,`🔍 По запросу «${query}» ничего не найдено.`,MAIN_KB); return; }
    const catEmoji={income:'💰',save:'🏦',invest:'📈',expense:'💸',goal:'🎯'};
    const lines = found.slice(0,10).map(e=>{
      const sign=(e.cat==='expense'||e.cat==='goal')?'−':'+';
      return `${catEmoji[e.cat]||'•'} ${e.desc} — <b>${sign}${fmt(e.amount,cur)}</b> <i>${e.date||''}</i>`;
    });
    const total = found.filter(e=>e.cat==='expense'||e.cat==='goal').reduce((s,e)=>s+e.amount,0);
    await sendMessage(chatId,
      `🔍 <b>«${query}»</b> — ${found.length} записей\n\n${lines.join('\n')}${found.length>10?`\n<i>...и ещё ${found.length-10}</i>`:''}\n\nИтого расходов: <b>${fmt(total,cur)}</b>`,
      MAIN_KB
    );
    return;
  }

  // ── 📊 БАЛАНС ─────────────────────────────────────────
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
    const subLine = user.isAdmin ? '' : `\n\n<i>${statusMsg(user)}</i>`;
    await sendMessage(chatId,
      `📊 <b>Баланс за ${monthName}</b>\n\n` +
      `💰 Доход: <b>${fmt(t.income,cur)}</b>\n` +
      `🏦 Себе — цель (${selfPct}%): <b>${fmt(target,cur)}</b>\n` +
      `🏦 Откладываю факт: <b>${fmt(t.saved,cur)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(t.invested,cur)}</b> (${invPct}%)\n` +
      `💸 Расходы: <b>${fmt(t.expense,cur)}</b> (${expPct}%)\n` +
      `━━━━━━━━━━━━━━\n` +
      `🟰 Баланс: <b>${fmt(balance,cur)}</b>\n\n` +
      `${wisdom} — ${score}/100${subLine}`,
      MAIN_KB
    );
    return;
  }

  // ── 📋 ИСТОРИЯ ────────────────────────────────────────
  if (lower==='📋 история'||lower==='/история'||lower==='история') {
    const snap = await entriesCol.orderBy('ts','desc').limit(10).get();
    if (snap.empty) { await sendMessage(chatId,'Записей пока нет.',MAIN_KB); return; }
    const catEmoji={income:'💰',save:'🏦',invest:'📈',expense:'💸',goal:'🎯'};
    const lines = snap.docs.map(d=>{
      const e=d.data(),sign=(e.cat==='expense'||e.cat==='goal')?'−':'+';
      return `${catEmoji[e.cat]||'•'} ${e.desc} — <b>${sign}${fmt(e.amount,cur)}</b> <i>${e.date||''}</i>`;
    });
    await sendMessage(chatId,`📋 <b>Последние записи</b>\n\n${lines.join('\n')}`,MAIN_KB);
    return;
  }

  // ── 📅 ПРОШЛЫЙ МЕСЯЦ ─────────────────────────────────
  if (lower==='📅 прошлый месяц'||lower==='/прошлый') {
    const t = await getTotals(prefix, prevMonthKey());
    const balance = t.income-t.saved-t.invested-t.expense-t.goalPaid;
    const savePct = t.income>0?Math.round((t.saved/t.income)*100):0;
    const expPct  = t.income>0?Math.round((t.expense/t.income)*100):0;
    const prevDate = new Date(); prevDate.setMonth(prevDate.getMonth()-1);
    const monthName = prevDate.toLocaleString('ru-RU',{month:'long',year:'numeric'});
    const expBycat={};
    t.entries.filter(e=>e.cat==='expense').forEach(e=>{const k=e.subcat||'other';expBycat[k]=(expBycat[k]||0)+e.amount;});
    const expLines = Object.entries(expBycat).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${EXP_CATS_RU[k]||k}: ${fmt(v,cur)}`).join('\n');
    await sendMessage(chatId,
      `📅 <b>Итоги за ${monthName}</b>\n\n` +
      `💰 Доход: <b>${fmt(t.income,cur)}</b>\n` +
      `🏦 Откладывал: <b>${fmt(t.saved,cur)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(t.invested,cur)}</b>\n` +
      `💸 Расходы: <b>${fmt(t.expense,cur)}</b> (${expPct}%)\n` +
      `🟰 Баланс: <b>${fmt(balance,cur)}</b>\n\n` +
      `<b>По категориям:</b>\n${expLines||'  Нет расходов'}`,
      MAIN_KB
    );
    return;
  }

  // ── 🎯 ЦЕЛИ ──────────────────────────────────────────
  if (lower==='🎯 цели'||lower==='/цели'||lower==='цели') {
    const snap = await goalsCol.orderBy('ts','asc').get();
    if (snap.empty) { await sendMessage(chatId,'Целей пока нет.',MAIN_KB); return; }
    const lines = snap.docs.map(d=>{
      const g=d.data(),s=g.saved||0,pct=Math.min(Math.round((s/g.target)*100),100);
      const bar='█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
      return `🎯 <b>${g.name}</b>\n${bar} ${pct}%\n${fmt(s,cur)} / ${fmt(g.target,cur)}`;
    });
    await sendMessage(chatId,`🎯 <b>Цели накоплений</b>\n\n${lines.join('\n\n')}`,MAIN_KB);
    return;
  }

  // ── 🎯 В СЧЁТ ЦЕЛИ ───────────────────────────────────
  if (lower==='🎯 в счёт цели') {
    const gsnap = await goalsCol.orderBy('ts','asc').get();
    if (gsnap.empty) { await sendMessage(chatId,'Целей пока нет.',MAIN_KB); return; }
    const gkb = gsnap.docs.map(d=>[d.data().name]);
    gkb.push(['Отмена']);
    userState[chatId] = { mode:'goal_select', glist: gsnap.docs.map(d=>({id:d.id,...d.data()})) };
    await sendMessage(chatId,'🎯 Выбери цель:',gkb);
    return;
  }
  if (userState[chatId] && userState[chatId].mode==='goal_select') {
    if (lower==='отмена') { delete userState[chatId]; await sendMessage(chatId,'Отменено.',MAIN_KB); return; }
    const chosen = userState[chatId].glist.find(g=>g.name.toLowerCase()===lower);
    if (!chosen) { await sendMessage(chatId,'Выбери из списка.'); return; }
    userState[chatId] = { mode:'goal_amount', goal: chosen };
    await sendMessage(chatId,'Цель: '+chosen.name+'\nНакоплено: '+fmt(chosen.saved||0,cur)+' / '+fmt(chosen.target,cur)+'\nВведи сумму:');
    return;
  }
  if (userState[chatId] && userState[chatId].mode==='goal_amount') {
    const gamt = parseFloat(text.replace(',','.'));
    if (isNaN(gamt)||gamt<=0) { await sendMessage(chatId,'Введи сумму числом.'); return; }
    const ggoal = userState[chatId].goal;
    delete userState[chatId];
    const gnewSaved = Math.min((ggoal.saved||0)+gamt, ggoal.target);
    await goalsCol.doc(ggoal.id).update({saved: gnewSaved});
    const gentry = {desc:'В счёт цели: '+ggoal.name,cat:'goal',goalId:ggoal.id,amount:gamt,date:todayStr(),month:monthKey(),ts:Date.now(),source:'telegram'};
    await entriesCol.add(gentry);
    const gleft = ggoal.target - gnewSaved;
    const gpct = Math.min(Math.round((gnewSaved/ggoal.target)*100),100);
    const gbar = '█'.repeat(Math.round(gpct/10))+'░'.repeat(10-Math.round(gpct/10));
    await sendMessage(chatId,'✅ Записано!\n\nЦель: '+ggoal.name+'\n['+gbar+'] '+gpct+'%\n'+fmt(gnewSaved,cur)+' / '+fmt(ggoal.target,cur)+'\n'+(gleft>0?'Осталось: '+fmt(gleft,cur):'🏆 Цель достигнута!'),MAIN_KB);
    return;
  }

  // ── ⚠️ ЛИМИТЫ ────────────────────────────────────────
  if (lower.startsWith('лимит ')) {
    const parts=text.slice(6).trim().split(/\s+/);
    const numIdx=parts.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
    if (numIdx===-1) { await sendMessage(chatId,'Формат: <code>лимит еда 5000</code>',MAIN_KB); return; }
    const amount=parseFloat(parts[numIdx].replace(',','.'));
    const catWords=parts.filter((_,i)=>i!==numIdx).join(' ').toLowerCase();
    const subcat=EXP_CATS[catWords]||catWords||'other';
    await limitsCol.doc(subcat).set({subcat,amount,ts:Date.now()});
    await sendMessage(chatId,'✅ Лимит: '+(EXP_CATS_RU[subcat]||catWords)+' — '+fmt(amount,cur)+'/мес',MAIN_KB);
    return;
  }
  if (lower==='⚠️ лимиты'||lower==='лимиты') {
    const snap=await limitsCol.get();
    if (snap.empty) { await sendMessage(chatId,'Лимитов нет.\nУстанови: <code>лимит еда 5000</code>',MAIN_KB); return; }
    const tSnap=await entriesCol.where('month','==',monthKey()).where('cat','==','expense').get();
    const spent={};
    tSnap.docs.forEach(d=>{const k=d.data().subcat||'other';spent[k]=(spent[k]||0)+d.data().amount;});
    const lines=snap.docs.map(d=>{
      const {subcat,amount}=d.data(),s=spent[subcat]||0,pct=Math.round((s/amount)*100);
      return (pct>=100?'🔴':pct>=80?'🟡':'🟢')+' '+(EXP_CATS_RU[subcat]||subcat)+': '+fmt(s,cur)+' / '+fmt(amount,cur)+' ('+pct+'%)';
    });
    await sendMessage(chatId,'⚠️ <b>Лимиты</b>\n\n'+lines.join('\n'),MAIN_KB);
    return;
  }

  // ── 🔁 РЕГУЛЯРНЫЕ ────────────────────────────────────
  if (lower.startsWith('каждый ')) {
    const parts=text.slice(7).trim().split(/\s+/);
    const numIdx=parts.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
    if (numIdx===-1) { await sendMessage(chatId,'Формат: <code>каждый аренда 50000</code>',MAIN_KB); return; }
    const amount=parseFloat(parts[numIdx].replace(',','.'));
    const desc=parts.filter((_,i)=>i!==numIdx).join(' ')||'Регулярный платёж';
    const id=desc.replace(/\s+/g,'_')+'_'+amount;
    await recurCol.doc(id).set({desc,amount,subcat:guessSubcat(desc),cat:'expense',ts:Date.now(),active:true});
    await sendMessage(chatId,'🔁 Регулярный: <b>'+desc+' '+fmt(amount,cur)+'</b>\nСписывается 1-го числа',MAIN_KB);
    return;
  }
  if (lower==='🔁 регулярные'||lower==='регулярные') {
    const snap=await recurCol.where('active','==',true).get();
    if (snap.empty) { await sendMessage(chatId,'Регулярных нет.\n<code>каждый аренда 50000</code>',MAIN_KB); return; }
    const lines=snap.docs.map(d=>'🔁 '+d.data().desc+': <b>'+fmt(d.data().amount,cur)+'</b>');
    await sendMessage(chatId,'🔁 <b>Регулярные платежи</b>\n\n'+lines.join('\n'),MAIN_KB);
    return;
  }

  // ── /pdf ─────────────────────────────────────────────
  if (lower==='/pdf'||lower==='pdf') {
    const t=await getTotals(prefix);
    const settSnap=await settingsDoc.get();
    const selfPct=settSnap.exists?(settSnap.data().selfPct||10):10;
    const balance=t.income-t.saved-t.invested-t.expense-t.goalPaid;
    const expBycat={};
    t.entries.filter(e=>e.cat==='expense').forEach(e=>{const k=e.subcat||'other';expBycat[k]=(expBycat[k]||0)+e.amount;});
    const expLines=Object.entries(expBycat).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'  '+(EXP_CATS_RU[k]||k)+': '+fmt(v,cur)).join('\n');
    const lastEntries=t.entries.sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,20)
      .map(e=>'  '+(e.date||'')+' | '+catLabel(e.cat).padEnd(12)+' | '+((e.cat==='expense'||e.cat==='goal')?'-':'+')+fmt(e.amount,cur).padStart(12)+' | '+e.desc).join('\n');
    const monthName=new Date().toLocaleString('ru-RU',{month:'long',year:'numeric'});
    const txt='ФИНАНСОВЫЙ ОТЧЁТ — '+monthName.toUpperCase()+'\n'+'='.repeat(50)+'\n\nСВОДКА\n------\nДоход:           '+fmt(t.income,cur)+'\nСебе ('+selfPct+'%):     '+fmt(t.income*selfPct/100,cur)+'\nОткладываю:      '+fmt(t.saved,cur)+'\nРасходы:         '+fmt(t.expense,cur)+'\nБаланс:          '+fmt(balance,cur)+'\n\nРАСХОДЫ ПО КАТЕГОРИЯМ\n---------------------\n'+(expLines||'  Нет')+'\n\nЗАПИСИ\n------\n'+(lastEntries||'  Нет')+'\n\n'+'='.repeat(50)+'\n'+new Date().toLocaleString('ru-RU')+'\n';
    await sendDocument(chatId,'отчёт_'+monthKey()+'.txt',txt,'📄 Отчёт за '+monthName);
    return;
  }

  // ── ❓ ПОМОЩЬ ─────────────────────────────────────────
  if (lower==='❓ помощь'||lower==='/help'||lower==='помощь') {
    const price = cur.symbol==='₽' ? `${PRICE_RUB}₽` : `${PRICE_EUR}€`;
    await sendMessage(chatId,
      '<b>Быстрый ввод:</b>\n'+
      '<code>кофе 350</code> — расход\n'+
      '<code>+зарплата 150000</code> — доход\n'+
      '<code>себе 15000</code> — откладываю\n'+
      '<code>инвест 10000</code> — инвестиции\n\n'+
      '<b>Команды:</b>\n'+
      '↩️ Отмена — удалить последнюю запись\n'+
      '🔍 Поиск — найти записи по слову\n'+
      '/pdf — отчёт за текущий месяц\n'+
      '/валюта — сменить валюту\n'+
      '/подписка — статус и оплата\n'+
      '/app — открыть веб-приложение\n'+
      '/ref — реферальная ссылка\n\n'+
      '<b>Лимиты:</b> <code>лимит еда 5000</code>\n'+
      '<b>Регулярные:</b> <code>каждый аренда 50000</code>\n\n'+
      '<i>Подписка: '+price+'/месяц</i>',
      MAIN_KB
    );
    return;
  }

  // Кнопки категорий
  if(lower==='💰 доход')     {userState[chatId]={cat:'income'};  await sendMessage(chatId,'💰 <code>зарплата 150000</code>',MAIN_KB);return;}
  if(lower==='💸 расход')    {userState[chatId]={cat:'expense'}; await sendMessage(chatId,'💸 <code>кофе 350</code>',MAIN_KB);return;}
  if(lower==='🏦 себе')      {userState[chatId]={cat:'save'};    await sendMessage(chatId,'🏦 Сумма: <code>15000</code>',MAIN_KB);return;}
  if(lower==='📈 инвестиции'){userState[chatId]={cat:'invest'};  await sendMessage(chatId,'📈 <code>etf 10000</code>',MAIN_KB);return;}

  // ── БЫСТРЫЙ ВВОД ─────────────────────────────────────
  let cat=null;
  if(userState[chatId]&&userState[chatId].cat){cat=userState[chatId].cat;delete userState[chatId];}
  const words=text.split(/\s+/);
  const numIdx=words.findIndex(w=>/^\d+([.,]\d+)?$/.test(w));
  if(numIdx===-1){
    await sendMessage(chatId,'Не понял.\n<code>кофе 350</code> — расход\n<code>+зарплата 150000</code> — доход\n\nИли /start',MAIN_KB);
    return;
  }
  const amount=parseFloat(words[numIdx].replace(',','.'));
  let desc=words.filter((_,i)=>i!==numIdx).join(' ').replace(/^[+]/,'').trim();
  if(!cat){
    if(text.startsWith('+'))                                         cat='income';
    else if(lower.startsWith('себе')||lower.startsWith('отложи'))    cat='save';
    else if(lower.startsWith('инвест'))                              cat='invest';
    else                                                              cat='expense';
  }
  desc=desc.replace(/^(себе|отложи|инвест)\s*/i,'').trim()||catLabel(cat);
  const entry={desc,cat,amount,date:todayStr(),month:monthKey(),ts:Date.now(),source:'telegram'};
  if(cat==='expense') entry.subcat=guessSubcat(desc);
  await entriesCol.add(entry);
  const catNames={income:'💰 Доход',save:'🏦 Себе',invest:'📈 Инвестиции',expense:'💸 Расход'};
  const sign=(cat==='expense')?'−':'+';
  await sendMessage(chatId,'✅ <b>Записано</b>\n\n'+catNames[cat]+': <b>'+sign+fmt(amount,cur)+'</b>\n📝 '+desc,MAIN_KB);
  await checkLimits(prefix,cur,chatId,entry);
}

// ── CALLBACK (кнопка оплаты) ─────────────────────────────
async function handleCallback(query) {
  const chatId = String(query.message.chat.id);
  await fetch(`${API}/answerCallbackQuery`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: query.id }),
  });
  if (query.data === 'pay') {
    const user = await getUser(chatId);
    if (!user) return;
    await sendInvoice(chatId, getCurrency(user));
  }
}

// ── ПЛАТЁЖ ПОДТВЕРЖДЁН ───────────────────────────────────
async function handlePreCheckout(query) {
  await fetch(`${API}/answerPreCheckoutQuery`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ pre_checkout_query_id: query.id, ok: true }),
  });
}

async function handleSuccessfulPayment(msg) {
  const chatId = String(msg.chat.id);
  const paidUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await updateUser(chatId, { isPaid: true, paidUntil });
  await sendMessage(chatId,
    '✅ <b>Оплата получена!</b>\n\nПодписка активна на 30 дней.\n\n🌐 <a href="https://roaring-pegasus-df74bc.netlify.app">Открыть веб-приложение</a>\n\n<i>«Золото приходит охотно и в возрастающем количестве к человеку, который откладывает не менее одной десятой своего заработка.»</i>',
    MAIN_KB
  );
}

// ── ПЛАНИРОВЩИК ───────────────────────────────────────────
async function sendWeeklyReports() {
  const usersSnap = await db.collection('users').get();
  for (const doc of usersSnap.docs) {
    const user = doc.data();
    if (!isActive(user)) continue;
    try {
      const cur = getCurrency(user);
      const t = await getTotals(user.prefix);
      if (t.income===0&&t.expense===0) continue;
      const balance=t.income-t.saved-t.invested-t.expense-t.goalPaid;
      const savePct=t.income>0?Math.round((t.saved/t.income)*100):0;
      const expPct=t.income>0?Math.round((t.expense/t.income)*100):0;
      const expBycat={};
      t.entries.filter(e=>e.cat==='expense').forEach(e=>{const k=e.subcat||'other';expBycat[k]=(expBycat[k]||0)+e.amount;});
      const top3=Object.entries(expBycat).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>'  '+(EXP_CATS_RU[k]||k)+': '+fmt(v,cur)).join('\n');
      await sendMessage(user.chatId,
        '📅 <b>Еженедельный отчёт</b>\n\n'+
        '💰 Доход: <b>'+fmt(t.income,cur)+'</b>\n'+
        '🏦 Откладываю: <b>'+fmt(t.saved,cur)+'</b> ('+savePct+'%)\n'+
        '💸 Расходы: <b>'+fmt(t.expense,cur)+'</b> ('+expPct+'%)\n'+
        '🟰 Баланс: <b>'+fmt(balance,cur)+'</b>\n\n'+
        '<b>Топ расходов:</b>\n'+(top3||'  Нет')+'\n\n'+
        '<i>«Золото копится у того, кто откладывает не менее десятой части.»</i>'
      );
    } catch(e) { console.error('weekly error', user.chatId, e.message); }
  }
}

async function checkTrialReminders() {
  const usersSnap = await db.collection('users').where('isPaid','==',false).get();
  for (const doc of usersSnap.docs) {
    const user = doc.data();
    if (user.isAdmin) continue;
    const daysLeft = trialDaysLeft(user);
    if (daysLeft === 3 || daysLeft === 1) {
      const cur = getCurrency(user);
      const price = cur.symbol==='₽' ? PRICE_RUB+'₽' : PRICE_EUR+'€';
      await sendMessage(user.chatId,
        '⏰ <b>Пробный период заканчивается!</b>\n\n'+
        'Осталось <b>'+daysLeft+' '+( daysLeft===1?'день':'дня')+'</b>.\n\n'+
        'Оформи подписку чтобы не потерять доступ к своим данным.',
        null,
        { reply_markup: { inline_keyboard: [[{ text:'💳 Оплатить '+price+'/мес', callback_data:'pay' }]]}}
      );
    }
  }
}

async function processRecurring() {
  const usersSnap = await db.collection('users').get();
  for (const doc of usersSnap.docs) {
    const user = doc.data();
    if (!isActive(user)) continue;
    try {
      const cur = getCurrency(user);
      const snap = await db.collection(user.prefix+'_recurring').where('active','==',true).get();
      if (snap.empty) continue;
      const lines=[];
      for (const d of snap.docs) {
        const r=d.data();
        await db.collection(user.prefix+'_entries').add({desc:r.desc,cat:'expense',amount:r.amount,subcat:r.subcat||'other',date:todayStr(),month:monthKey(),ts:Date.now(),source:'recurring'});
        lines.push('🔁 '+r.desc+': '+fmt(r.amount,cur));
      }
      if (lines.length) await sendMessage(user.chatId,'🔁 <b>Регулярные платежи списаны</b>\n\n'+lines.join('\n'));
    } catch(e) { console.error('recurring error', user.chatId, e.message); }
  }
}

async function checkSaveReminders() {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const daysLeft = daysInMonth - now.getDate();
  if (daysLeft > 3) return;
  const usersSnap = await db.collection('users').get();
  for (const doc of usersSnap.docs) {
    const user = doc.data();
    if (!isActive(user)) continue;
    try {
      const snap = await db.collection(user.prefix+'_entries').where('month','==',monthKey()).where('cat','==','save').get();
      if (snap.empty) {
        await sendMessage(user.chatId,
          '🔔 <b>Аркад напоминает</b>\n\nДо конца месяца '+daysLeft+(daysLeft===1?' день':' дня')+'.\n\nТы ещё не отложил себе. Сделай это сейчас.\n\n<i>«Часть всего, что зарабатываешь, — твоя и должна остаться у тебя.»</i>'
        );
      }
    } catch(e) { console.error('reminder error', user.chatId, e.message); }
  }
}

function startScheduler() {
  setInterval(async()=>{
    const now=new Date();
    const h=now.getHours(),m=now.getMinutes(),d=now.getDate(),dow=now.getDay();
    if(dow===0&&h===19&&m===0) await sendWeeklyReports();
    if(d===1&&h===9&&m===0)    await processRecurring();
    if(h===10&&m===0)          await checkSaveReminders();
    if(h===12&&m===0)          await checkTrialReminders();
  },60000);
}

// ── WEBHOOK ───────────────────────────────────────────────
app.post('/webhook', async (req,res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.message) {
      if (body.message.successful_payment) await handleSuccessfulPayment(body.message);
      else await handleMessage(body.message);
    }
    if (body.edited_message) await handleMessage(body.edited_message);
    if (body.callback_query) await handleCallback(body.callback_query);
    if (body.pre_checkout_query) await handlePreCheckout(body.pre_checkout_query);
  } catch(e) { console.error(e); }
});

app.get('/',(req,res)=>res.send('Babylon Bot 🏛 v4 — Production'));

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>{ console.log('Bot v4 on port '+PORT); startScheduler(); });
