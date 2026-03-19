const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TOKEN = process.env.TELEGRAM_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

// ── РАЗРЕШЁННЫЕ ПОЛЬЗОВАТЕЛИ ──────────────────────────────
// Каждый видит только свои данные — изолировано по Telegram ID
const ALLOWED_USERS = {
  '5080699264': 'user_5080699264',  // Арсен
  '5472449463': 'user_5472449463',  // Второй пользователь
};

// Возвращает префикс коллекции для конкретного пользователя
function getUserPrefix(chatId) {
  return ALLOWED_USERS[String(chatId)];
}

// ── КАТЕГОРИИ ─────────────────────────────────────────────
const EXP_CATS = {
  еда: 'food', кафе: 'food', ресторан: 'food', продукты: 'food',
  обед: 'food', ужин: 'food', завтрак: 'food', перекус: 'food',
  такси: 'transport', транспорт: 'transport', метро: 'transport',
  бензин: 'transport', парковка: 'transport', uber: 'transport',
  аренда: 'home', жильё: 'home', коммуналка: 'home', жилье: 'home',
  здоровье: 'health', аптека: 'health', врач: 'health', спорт: 'health',
  развлечения: 'fun', кино: 'fun', игры: 'fun', подписка: 'fun', бар: 'fun',
  одежда: 'clothes', обувь: 'clothes',
};

const EXP_CATS_RU = {
  food: 'Еда', transport: 'Транспорт', home: 'Жильё',
  health: 'Здоровье', fun: 'Развлечения', clothes: 'Одежда', other: 'Прочее',
};

function guessSubcat(desc) {
  const d = desc.toLowerCase();
  for (const [key, val] of Object.entries(EXP_CATS)) {
    if (d.includes(key)) return val;
  }
  return 'other';
}

function monthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function todayStr() {
  return new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function fmt(n, chatId) {
  const currency = String(chatId) === '5472449463' ? ' €' : ' ₽';
  return Math.round(n).toLocaleString('ru-RU') + currency;
}

function catLabel(c) {
  return { income: 'Доход', save: 'Себе', invest: 'Инвестиции', expense: 'Расход', goal: 'Цель' }[c] || c;
}

async function sendMessage(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: false };
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Состояние пользователей
const userState = {};

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  // Проверка доступа
  const userPrefix = getUserPrefix(chatId);
  if (!userPrefix) {
    await sendMessage(chatId, '🚫 У тебя нет доступа к этому боту.');
    return;
  }

  // Коллекции изолированы по пользователю
  const entriesCol = db.collection(`${userPrefix}_entries`);
  const goalsCol   = db.collection(`${userPrefix}_goals`);
  const settingsDoc = db.collection(`${userPrefix}_settings`).doc('main');

  // ── КОМАНДЫ ──────────────────────────────────────────────

  if (lower === '/start' || lower === 'меню' || lower === 'начало') {
    await sendMessage(chatId,
      `🏛 <b>Вавилонский учёт</b>\n\nКак добавить запись:\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — откладываю себе\n` +
      `<code>инвест 10000</code> — инвестиции\n\n` +
      `Или используй кнопки ниже:`,
      [
        ['💰 Доход', '💸 Расход'],
        ['🏦 Себе', '📈 Инвестиции'],
        ['📊 Баланс', '📋 История'],
        ['🎯 Цели', '❓ Помощь'],
      ]
    );
    return;
  }

  if (lower === '❓ помощь' || lower === '/help') {
    await sendMessage(chatId,
      `<b>Команды бота:</b>\n\n` +
      `<code>кофе 350</code> — расход\n` +
      `<code>+зарплата 150000</code> — доход\n` +
      `<code>себе 15000</code> — себе\n` +
      `<code>инвест etf 10000</code> — инвестиции\n\n` +
      `<b>Кнопки:</b>\n` +
      `📊 Баланс — итоги месяца\n` +
      `📋 История — последние 10 записей\n` +
      `🎯 Цели — прогресс накоплений\n\n` +
      `Все записи синхронизируются с веб-приложением.`
    );
    return;
  }

  if (lower === '📊 баланс' || lower === '/баланс' || lower === 'баланс') {
    const snap = await entriesCol.where('month', '==', monthKey()).get();
    const entries = snap.docs.map(d => d.data());
    const income   = entries.filter(e => e.cat === 'income').reduce((s, e) => s + e.amount, 0);
    const saved    = entries.filter(e => e.cat === 'save').reduce((s, e) => s + e.amount, 0);
    const invested = entries.filter(e => e.cat === 'invest').reduce((s, e) => s + e.amount, 0);
    const expense  = entries.filter(e => e.cat === 'expense').reduce((s, e) => s + e.amount, 0);
    const goalPaid = entries.filter(e => e.cat === 'goal').reduce((s, e) => s + e.amount, 0);
    const balance  = income - saved - invested - expense - goalPaid;

    const settingsSnap = await settingsDoc.get();
    const selfPct = settingsSnap.exists ? (settingsSnap.data().selfPct || 10) : 10;
    const target  = income * selfPct / 100;
    const savePct = income > 0 ? Math.round((saved / income) * 100) : 0;
    const expPct  = income > 0 ? Math.round((expense / income) * 100) : 0;
    const invPct  = income > 0 ? Math.round((invested / income) * 100) : 0;

    let score = 0;
    if (income > 0) {
      if (savePct >= selfPct) score += 40; else if (savePct >= selfPct * 0.7) score += 20; else if (savePct > 0) score += 10;
      if (expPct <= 70) score += 35; else if (expPct <= 80) score += 25; else if (expPct <= 90) score += 10;
      if (invPct >= 10) score += 25; else if (invPct > 0) score += 12;
    }
    let wisdom = '🟡 Ученик';
    if (score >= 85) wisdom = '🏆 Богатый вавилонянин';
    else if (score >= 60) wisdom = '💎 Зажиточный';
    else if (score >= 35) wisdom = '✅ Свободный человек';

    const monthName = new Date().toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
    await sendMessage(chatId,
      `📊 <b>Баланс за ${monthName}</b>\n\n` +
      `💰 Доход: <b>${fmt(income, chatId)}</b>\n` +
      `🏦 Себе — цель (${selfPct}%): <b>${fmt(target, chatId)}</b>\n` +
      `🏦 Откладываю факт: <b>${fmt(saved, chatId)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(invested, chatId)}</b> (${invPct}%)\n` +
      `💸 Расходы: <b>${fmt(expense, chatId)}</b> (${expPct}%)\n` +
      `━━━━━━━━━━━━━━\n` +
      `🟰 Баланс: <b>${fmt(balance, chatId)}</b>\n\n` +
      `${wisdom} — ${score}/100`
    );
    return;
  }

  if (lower === '📋 история' || lower === '/история' || lower === 'история') {
    const snap = await entriesCol.orderBy('ts', 'desc').limit(10).get();
    if (snap.empty) { await sendMessage(chatId, 'Записей пока нет.'); return; }
    const catEmoji = { income: '💰', save: '🏦', invest: '📈', expense: '💸', goal: '🎯' };
    const lines = snap.docs.map(d => {
      const e = d.data();
      const sign = (e.cat === 'expense' || e.cat === 'goal') ? '−' : '+';
      return `${catEmoji[e.cat] || '•'} ${e.desc} — <b>${sign}${fmt(e.amount)}</b> <i>${e.date || ''}</i>`;
    });
    await sendMessage(chatId, `📋 <b>Последние записи</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (lower === '🎯 цели' || lower === '/цели' || lower === 'цели') {
    const snap = await goalsCol.orderBy('ts', 'asc').get();
    if (snap.empty) { await sendMessage(chatId, '🎯 Целей пока нет. Добавь их в веб-приложении.'); return; }
    const lines = snap.docs.map(d => {
      const g = d.data();
      const s = g.saved || 0;
      const pct = Math.min(Math.round((s / g.target) * 100), 100);
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      return `🎯 <b>${g.name}</b>\n${bar} ${pct}%\n${fmt(s)} / ${fmt(g.target, chatId)}`;
    });
    await sendMessage(chatId, `🎯 <b>Цели накоплений</b>\n\n${lines.join('\n\n')}`);
    return;
  }

  // Кнопки категорий
  if (lower === '💰 доход')     { userState[chatId] = { cat: 'income' };  await sendMessage(chatId, '💰 Введи: <code>зарплата 150000</code>'); return; }
  if (lower === '💸 расход')    { userState[chatId] = { cat: 'expense' }; await sendMessage(chatId, '💸 Введи: <code>кофе 350</code>'); return; }
  if (lower === '🏦 себе')      { userState[chatId] = { cat: 'save' };    await sendMessage(chatId, '🏦 Введи сумму: <code>15000</code>'); return; }
  if (lower === '📈 инвестиции'){ userState[chatId] = { cat: 'invest' };  await sendMessage(chatId, '📈 Введи: <code>etf 10000</code>'); return; }

  // ── БЫСТРЫЙ ВВОД ─────────────────────────────────────────
  let cat = null;
  if (userState[chatId]) { cat = userState[chatId].cat; delete userState[chatId]; }

  const words = text.split(/\s+/);
  const numIdx = words.findIndex(w => /^\d+([.,]\d+)?$/.test(w));

  if (numIdx === -1) {
    await sendMessage(chatId,
      `Не понял. Попробуй:\n<code>кофе 350</code>\n<code>+зарплата 150000</code>\n<code>себе 15000</code>\n\nИли нажми /start`
    );
    return;
  }

  const amount = parseFloat(words[numIdx].replace(',', '.'));
  let desc = words.filter((_, i) => i !== numIdx).join(' ').replace(/^[+]/, '').trim();

  if (!cat) {
    if (text.startsWith('+'))                                    cat = 'income';
    else if (lower.startsWith('себе') || lower.startsWith('отложи')) cat = 'save';
    else if (lower.startsWith('инвест'))                         cat = 'invest';
    else                                                          cat = 'expense';
  }

  if (!desc) desc = catLabel(cat);
  // Убираем ключевые слова из описания
  desc = desc.replace(/^(себе|отложи|инвест)\s*/i, '').trim() || catLabel(cat);

  const entry = {
    desc,
    cat,
    amount,
    date: todayStr(),
    month: monthKey(),
    ts: Date.now(),
    source: 'telegram',
  };
  if (cat === 'expense') entry.subcat = guessSubcat(desc);

  await entriesCol.add(entry);

  const catNames = { income: '💰 Доход', save: '🏦 Себе', invest: '📈 Инвестиции', expense: '💸 Расход' };
  const sign = (cat === 'expense') ? '−' : '+';

  await sendMessage(chatId,
    `✅ <b>Записано</b>\n\n${catNames[cat]}: <b>${sign}${fmt(amount, chatId)}</b>\n📝 ${desc}\n\n<i>Напиши «баланс» чтобы проверить итоги.</i>`
  );
}

// ── WEBHOOK ───────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message || req.body.edited_message;
    if (msg) await handleMessage(msg);
  } catch (e) {
    console.error(e);
  }
});

app.get('/', (req, res) => res.send('Babylon Bot 🏛 is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
