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

// Категории расходов
const EXP_CATS = {
  еда: 'food', кафе: 'food', ресторан: 'food', продукты: 'food', обед: 'food', ужин: 'food', завтрак: 'food',
  такси: 'transport', транспорт: 'transport', метро: 'transport', бензин: 'transport', парковка: 'transport',
  аренда: 'home', жильё: 'home', коммуналка: 'home', жилье: 'home',
  здоровье: 'health', аптека: 'health', врач: 'health', спорт: 'health',
  развлечения: 'fun', кино: 'fun', игры: 'fun', подписка: 'fun',
  одежда: 'clothes', обувь: 'clothes',
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

function fmt(n) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
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

// Состояние пользователей (для мультишагового ввода)
const userState = {};

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  // ── КОМАНДЫ ──────────────────────────────────────────────

  if (lower === '/start' || lower === 'начало' || lower === 'меню') {
    await sendMessage(chatId,
      `🏛 <b>Вавилонский учёт</b>\n\nКак добавить запись:\n<code>кофе 350</code> — расход\n<code>+зарплата 150000</code> — доход\n<code>себе 15000</code> — откладываю себе\n<code>инвест 10000</code> — инвестиции\n\nИли используй кнопки ниже:`,
      [
        ['💰 Доход', '💸 Расход'],
        ['🏦 Себе', '📈 Инвестиции'],
        ['📊 Баланс', '📋 История'],
      ]
    );
    return;
  }

  if (lower === '📊 баланс' || lower === '/баланс' || lower === 'баланс') {
    const snap = await db.collection('entries').where('month', '==', monthKey()).get();
    const entries = snap.docs.map(d => d.data());
    const income   = entries.filter(e => e.cat === 'income').reduce((s, e) => s + e.amount, 0);
    const saved    = entries.filter(e => e.cat === 'save').reduce((s, e) => s + e.amount, 0);
    const invested = entries.filter(e => e.cat === 'invest').reduce((s, e) => s + e.amount, 0);
    const expense  = entries.filter(e => e.cat === 'expense').reduce((s, e) => s + e.amount, 0);
    const goalPaid = entries.filter(e => e.cat === 'goal').reduce((s, e) => s + e.amount, 0);
    const balance  = income - saved - invested - expense - goalPaid;

    const settingsSnap = await db.collection('settings').doc('main').get();
    const selfPct = settingsSnap.exists ? (settingsSnap.data().selfPct || 10) : 10;
    const target = income * selfPct / 100;
    const savePct = income > 0 ? Math.round((saved / income) * 100) : 0;
    const expPct  = income > 0 ? Math.round((expense / income) * 100) : 0;

    let wisdom = '🟡 Ученик';
    let score = 0;
    if (income > 0) {
      if (savePct >= selfPct) score += 40; else if (savePct >= selfPct * 0.7) score += 20; else if (savePct > 0) score += 10;
      if (expPct <= 70) score += 35; else if (expPct <= 80) score += 25; else if (expPct <= 90) score += 10;
      const ip = income > 0 ? (invested / income) * 100 : 0;
      if (ip >= 10) score += 25; else if (ip > 0) score += 12;
    }
    if (score >= 85) wisdom = '🏆 Богатый вавилонянин';
    else if (score >= 60) wisdom = '💎 Зажиточный';
    else if (score >= 35) wisdom = '✅ Свободный человек';

    await sendMessage(chatId,
      `📊 <b>Баланс за ${new Date().toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}</b>\n\n` +
      `💰 Доход: <b>${fmt(income)}</b>\n` +
      `🏦 Себе (цель ${selfPct}%): <b>${fmt(target)}</b>\n` +
      `🏦 Откладываю факт: <b>${fmt(saved)}</b> (${savePct}%)\n` +
      `📈 Инвестиции: <b>${fmt(invested)}</b>\n` +
      `💸 Расходы: <b>${fmt(expense)}</b> (${expPct}%)\n` +
      `━━━━━━━━━━━━━━\n` +
      `🟰 Баланс: <b>${fmt(balance)}</b>\n\n` +
      `${wisdom} (${score}/100)`
    );
    return;
  }

  if (lower === '📋 история' || lower === '/история' || lower === 'история') {
    const snap = await db.collection('entries')
      .where('month', '==', monthKey())
      .orderBy('ts', 'desc')
      .limit(10)
      .get();
    if (snap.empty) { await sendMessage(chatId, 'Записей за этот месяц пока нет.'); return; }
    const catEmoji = { income: '💰', save: '🏦', invest: '📈', expense: '💸', goal: '🎯' };
    const lines = snap.docs.map(d => {
      const e = d.data();
      const sign = (e.cat === 'expense' || e.cat === 'goal') ? '−' : '+';
      return `${catEmoji[e.cat] || '•'} ${e.desc} — <b>${sign}${fmt(e.amount)}</b> <i>${e.date || ''}</i>`;
    });
    await sendMessage(chatId, `📋 <b>Последние 10 записей</b>\n\n${lines.join('\n')}`);
    return;
  }

  // Кнопки категорий — запускаем диалог
  if (lower === '💰 доход') { userState[chatId] = { cat: 'income' }; await sendMessage(chatId, '💰 Введи сумму и описание:\n<code>зарплата 150000</code>'); return; }
  if (lower === '💸 расход') { userState[chatId] = { cat: 'expense' }; await sendMessage(chatId, '💸 Введи сумму и описание:\n<code>кофе 350</code>'); return; }
  if (lower === '🏦 себе') { userState[chatId] = { cat: 'save' }; await sendMessage(chatId, '🏦 Введи сумму:\n<code>15000</code>'); return; }
  if (lower === '📈 инвестиции') { userState[chatId] = { cat: 'invest' }; await sendMessage(chatId, '📈 Введи сумму и описание:\n<code>etf 10000</code>'); return; }

  // ── БЫСТРЫЙ ВВОД ─────────────────────────────────────────
  // Форматы:
  // "кофе 350"           → расход
  // "+зарплата 150000"   → доход
  // "себе 15000"         → откладываю себе
  // "инвест etf 10000"   → инвестиции

  let cat = null, desc = '', amount = 0;

  // Проверяем состояние (после нажатия кнопки)
  if (userState[chatId]) {
    cat = userState[chatId].cat;
    delete userState[chatId];
  }

  // Парсим текст
  const words = text.split(/\s+/);
  const numIdx = words.findIndex(w => /^\d+([.,]\d+)?$/.test(w));

  if (numIdx === -1) {
    // Нет числа — показываем помощь
    await sendMessage(chatId, `Не понял. Попробуй:\n<code>кофе 350</code> — расход\n<code>+зарплата 150000</code> — доход\n<code>себе 15000</code> — откладываю\n<code>инвест 10000</code> — инвестиции\n\nИли нажми /start`);
    return;
  }

  amount = parseFloat(words[numIdx].replace(',', '.'));
  desc = words.filter((_, i) => i !== numIdx).join(' ').replace(/^[+\-]/, '').trim();
  if (!desc) desc = cat === 'income' ? 'Доход' : cat === 'save' ? 'Себе' : cat === 'invest' ? 'Инвестиции' : 'Расход';

  // Определяем категорию если не задана кнопкой
  if (!cat) {
    if (text.startsWith('+')) cat = 'income';
    else if (lower.startsWith('себе') || lower.startsWith('отложи')) cat = 'save';
    else if (lower.startsWith('инвест') || lower.startsWith('invest')) cat = 'invest';
    else cat = 'expense';
  }

  const entry = {
    desc: desc || catLabel(cat),
    cat,
    amount,
    date: todayStr(),
    month: monthKey(),
    ts: Date.now(),
    source: 'telegram',
  };

  if (cat === 'expense') entry.subcat = guessSubcat(desc);

  await db.collection('entries').add(entry);

  const catNames = { income: '💰 Доход', save: '🏦 Себе', invest: '📈 Инвестиции', expense: '💸 Расход' };
  const sign = (cat === 'expense') ? '−' : '+';

  await sendMessage(chatId,
    `✅ Записано\n\n${catNames[cat]}: <b>${sign}${fmt(amount)}</b>\n📝 ${entry.desc}\n\nНапиши «баланс» чтобы проверить итоги.`
  );
}

function catLabel(c) {
  return { income: 'Доход', save: 'Себе', invest: 'Инвестиции', expense: 'Расход', goal: 'Цель' }[c] || c;
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

app.get('/', (req, res) => res.send('Babylon Bot is running 🏛'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
