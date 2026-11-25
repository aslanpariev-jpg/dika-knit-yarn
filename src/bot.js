const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const { getStock } = require('./stock');
const { prisma } = require('./db');

// ──────────────── Discord (только отчёт по остаткам) ────────────────
const STOCK_CHANNEL = process.env.DISCORD_STOCK_CHANNEL_ID || '1562095560352211034';

let discordClient = null;
let discordReady = false;

function startDiscord() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.log('[discord] DISCORD_TOKEN не задан — отчёт по остаткам отключён');
    return;
  }
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
  discordClient.once('clientReady', () => {
    discordReady = true;
    console.log(`[discord] Готов: ${discordClient.user.tag}`);
  });
  discordClient.on('error', (e) => console.error('[discord] error', e));
  discordClient.login(token).catch((e) => console.error('[discord] login failed', e.message));
}

async function postStockReport() {
  if (!discordClient || !discordReady) throw new Error('Discord-бот не готов');
  const channel = await discordClient.channels.fetch(STOCK_CHANNEL).catch((err) => {
    throw new Error(`Не удалось найти канал ${STOCK_CHANNEL}: ${err.message}`);
  });
  if (!channel || !channel.isTextBased()) throw new Error('Канал не найден или не текстовый');

  const stock = await getStock();
  const rows = stock.filter((s) => Number(s.home) || Number(s.warehouse) || Number(s.workshop));

  const lines = rows.length
    ? rows.map((s) =>
        `${s.article}${s.color ? ' ' + s.color : ''} — Дом: ${Number(s.home)} | Склад: ${Number(s.warehouse)} | Цех: ${Number(s.workshop)} ${s.unit}`
      ).join('\n')
    : 'Все остатки нулевые';

  const date = new Date().toISOString().slice(0, 10);
  const buffer = Buffer.from(lines, 'utf8');
  const file = new AttachmentBuilder(buffer, { name: `stock_${date}.txt` });

  await channel.send({
    content: `📦 Остатки пряжи на ${date} (${rows.length} позиций)`,
    files: [file],
  });
  console.log('[discord] Отчёт отправлен .txt файлом');
}

// ──────────────── Telegram (заказы) ────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let TG_GROUP_ID = process.env.TELEGRAM_GROUP_ID || null;

let tgBot = null;
let pinnedMessageId = null;

// Получить ID группы (из памяти или из БД)
async function getGroupId() {
  if (TG_GROUP_ID) return TG_GROUP_ID;
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'telegram_group_id' } });
    if (setting?.value) {
      TG_GROUP_ID = setting.value;
      console.log(`[telegram] ID группы подхвачен из базы: ${TG_GROUP_ID}`);
      return TG_GROUP_ID;
    }
  } catch (e) {}
  return null;
}

// Сохранить ID группы в БД
async function saveGroupId(id) {
  TG_GROUP_ID = String(id);
  try {
    await prisma.setting.upsert({
      where: { key: 'telegram_group_id' },
      update: { value: TG_GROUP_ID },
      create: { key: 'telegram_group_id', value: TG_GROUP_ID },
    });
    console.log(`[telegram] ID группы сохранён в базу: ${TG_GROUP_ID}`);
  } catch (e) {
    console.error('[telegram] Ошибка сохранения ID группы:', e.message);
  }
}

function startTelegram() {
  if (!TG_TOKEN) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запущен');
    return;
  }
  tgBot = new Telegraf(TG_TOKEN);

  // /start в личке остаётся обычным приветствием.
  tgBot.start((ctx) => {
    return ctx.reply('Привет! Я бот учёта пряжи. Если ты грузчик — выбери себя в сообщении бота в группе.');
  });

  // ─── КОМАНДА /setup ДЛЯ ГРУППЫ ───
  tgBot.command('setup', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return ctx.reply('Эту команду нужно выполнять в группе грузчиков.');
    }
    
    console.log(`[telegram] Получена команда /setup в группе ${ctx.chat.id}`);
    await saveGroupId(ctx.chat.id);
    
    await ctx.reply('⏳ Настраиваю группу...');
    await ensurePinnedMessage();
  });

  // Ловим любое сообщение в группе (на случай, если /setup не сработал)
  tgBot.on('message', async (ctx, next) => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const currentId = await getGroupId();
      if (!currentId || String(ctx.chat.id) !== String(currentId)) {
        console.log(`[telegram] Обнаружена новая группа! ID: ${ctx.chat.id}`);
        await saveGroupId(ctx.chat.id);
        await ensurePinnedMessage().catch((e) => console.error('[telegram] pinned failed:', e.message));
      }
    }
    return next();
  });

  // Приветствие каждого нового участника отдельным сообщением в группе (без закрепления).
  tgBot.on('new_chat_members', async (ctx) => {
    const groupId = await getGroupId();
    if (!groupId || String(ctx.chat.id) !== String(groupId)) return;

    const newcomers = ctx.message.new_chat_members.filter((member) => member.id !== ctx.botInfo.id);
    if (!newcomers.length) return;

    const loaders = await prisma.user.findMany({
      where: { role: 'LOADER', active: true },
      orderBy: { name: 'asc' },
    });
    if (!loaders.length) return;

    const keyboard = Markup.inlineKeyboard(
      loaders.map((u) => Markup.button.callback(u.name, `bind:${u.id}`)),
      { columns: 2 }
    );

    for (const member of newcomers) {
      const displayName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'новый участник';
      await ctx.telegram.sendMessage(
        groupId,
        `Добро пожаловать, ${displayName}! Если ты грузчик — нажми на своё имя, чтобы получать заказы:`,
        keyboard
      );
    }
  });

  // /bind — ручная привязка
  tgBot.command('bind', async (ctx) => {
    const loaders = await prisma.user.findMany({
      where: { role: 'LOADER', active: true },
      orderBy: { name: 'asc' },
    });
    if (!loaders.length) return ctx.reply('Нет активных грузчиков.');
    const buttons = loaders.map((u) => Markup.button.callback(u.name, `bind:${u.id}`));
    await ctx.reply('Выбери себя:', Markup.inlineKeyboard(buttons, { columns: 2 }));
  });

  // Callback: выбор грузчика
  tgBot.action(/^bind:(.+)$/, async (ctx) => {
    const userId = ctx.match[1];
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'LOADER' || !user.active) {
      return ctx.answerCbQuery('Грузчик не найден');
    }
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: String(ctx.from.id) },
    });
    await ctx.answerCbQuery(`Ты привязан как ${user.name}`);
    await refreshLoaderKeyboard().catch(() => {});
  });

  // Callback: Привезти
  tgBot.action(/^take:(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const loader = await prisma.user.findFirst({
      where: { telegramChatId: String(ctx.from.id), role: 'LOADER', active: true },
    });
    if (!loader) return ctx.answerCbQuery('Сначала выбери себя в закреплённом сообщении', { show_alert: true });

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { yarn: true } } } });
    if (!order || order.status !== 'PENDING') return ctx.answerCbQuery('Заказ уже неактуален', { show_alert: true });
    if (order.assignedLoaderId && order.assignedLoaderId !== loader.id) {
      return ctx.answerCbQuery('Заказ уже взял другой грузчик', { show_alert: true });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { assignedLoaderId: loader.id, assignedAt: new Date() },
      include: { items: { include: { yarn: true } }, knitter: true },
    });

    await ctx.answerCbQuery('Ты взял заказ');
    await ctx.editMessageText(
      renderOrderText(updated, `🚚 Заказ взял ${loader.name}`),
      orderKeyboard(updated)
    ).catch(() => {});
  });

  // Callback: Отказаться
  tgBot.action(/^decline:(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const loader = await prisma.user.findFirst({
      where: { telegramChatId: String(ctx.from.id), role: 'LOADER', active: true },
    });
    if (!loader) return ctx.answerCbQuery('Сначала выбери себя в закреплённом сообщении', { show_alert: true });

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== 'PENDING') return ctx.answerCbQuery('Заказ уже неактуален', { show_alert: true });
    if (order.assignedLoaderId !== loader.id) return ctx.answerCbQuery('Это не твой заказ', { show_alert: true });

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { assignedLoaderId: null, assignedAt: null },
      include: { items: { include: { yarn: true } }, knitter: true },
    });

    await ctx.answerCbQuery('Ты отказался от заказа');
    await ctx.editMessageText(
      renderOrderText(updated, `↩️ ${loader.name} отказался от заказа`),
      orderKeyboard(updated)
    ).catch(() => {});
  });

  // Callback: Привёз
  tgBot.action(/^deliver:(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const loader = await prisma.user.findFirst({
      where: { telegramChatId: String(ctx.from.id), role: 'LOADER', active: true },
    });
    if (!loader) return ctx.answerCbQuery('Сначала выбери себя в закреплённом сообщении', { show_alert: true });

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { yarn: true } }, knitter: true },
    });
    if (!order || order.status !== 'PENDING') return ctx.answerCbQuery('Заказ уже неактуален', { show_alert: true });
    if (!order.assignedLoaderId) return ctx.answerCbQuery('Сначала нажми «Привезти»', { show_alert: true });

    const { createOrderDeliveryMovements } = require('./stock');
    const updated = await prisma.$transaction(async (tx) => {
      await createOrderDeliveryMovements(tx, order.id, order.items);
      return tx.order.update({
        where: { id: order.id },
        data: { status: 'DELIVERED', deliveredAt: new Date(), deliveredById: loader.id },
        include: { items: { include: { yarn: true } }, knitter: true },
      });
    });

    await ctx.answerCbQuery('Доставлено!');
    await deleteOrderTelegramMessages(order.id, ctx.chat.id, ctx.callbackQuery.message.message_id);
  });

  // Запуск
  tgBot.launch()
    .then(async () => {
      console.log('[telegram] Бот запущен');
      const id = await getGroupId();
      if (id) {
        ensurePinnedMessage().catch((e) => console.error('[telegram] pinned failed:', e.message));
      } else {
        console.log('[telegram] Ожидаю команду /setup в группе или любое сообщение...');
      }
    })
    .catch((e) => console.error('[telegram] launch failed:', e.message));

  process.once('SIGINT', () => tgBot.stop('SIGINT'));
  process.once('SIGTERM', () => tgBot.stop('SIGTERM'));
}

// ──────────────── Вспомогательные функции ────────────────
function loadersListText(loaders) {
  return loaders.map((u) => `• ${u.name}${u.telegramChatId ? ' ✅' : ''}`).join('\n');
}

async function ensurePinnedMessage() {
  if (!tgBot) return;
  const groupId = await getGroupId();
  if (!groupId) {
    console.log('[telegram] ensurePinnedMessage: ID группы не известен.');
    return;
  }

  const loaders = await prisma.user.findMany({
    where: { role: 'LOADER', active: true },
    orderBy: { name: 'asc' },
  });
  
  if (!loaders.length) {
    console.log('[telegram] ensurePinnedMessage: В базе нет активных грузчиков (LOADER).');
    return;
  }

  const text =
    `👷 Выбор грузчика\n\n` +
    `Нажми на своё имя, чтобы получать заказы. ✅ — уже привязан.\n\n` +
    loadersListText(loaders);

  const keyboard = Markup.inlineKeyboard(
    loaders.map((u) => Markup.button.callback(u.name, `bind:${u.id}`)),
    { columns: 2 }
  );

  try {
    const msg = await tgBot.telegram.sendMessage(groupId, text, keyboard);
    await tgBot.telegram.pinChatMessage(groupId, msg.message_id, { disable_notification: true });
    pinnedMessageId = msg.message_id;
    console.log('[telegram] Закреплённое сообщение установлено');
  } catch (e) {
    console.error('[telegram] Ошибка при закреплении (pinned failed):', e.message);
  }
}

async function refreshLoaderKeyboard() {
  if (!tgBot) return;
  const groupId = await getGroupId();
  if (!groupId || !pinnedMessageId) return;

  const loaders = await prisma.user.findMany({
    where: { role: 'LOADER', active: true },
    orderBy: { name: 'asc' },
  });
  if (!loaders.length) return;

  const text =
    `👷 Выбор грузчика\n\n` +
    `Нажми на своё имя, чтобы получать заказы. ✅ — уже привязан.\n\n` +
    loadersListText(loaders);
  const keyboard = Markup.inlineKeyboard(
    loaders.map((u) => Markup.button.callback(u.name, `bind:${u.id}`)),
    { columns: 2 }
  );
  try {
    await tgBot.telegram.editMessageText(groupId, pinnedMessageId, undefined, text, keyboard);
  } catch (e) {
    await ensurePinnedMessage().catch(() => {});
  }
}

function renderOrderText(order, statusLine) {
  const sourceLabel = { HOME: 'из дома', WAREHOUSE: 'со склада', CITY_BUY: 'купить в городе' };
  const items = order.items.map((it) => {
    const y = it.yarn;
    return `• ${y.article}${y.color ? ' ' + y.color : ''} — ${Number(it.quantity)} ${y.unit} (${sourceLabel[it.source]})`;
  }).join('\n');

  return (
    `🆕 Заказ #${order.id.slice(-6)}\n` +
    `👤 Вязальщик: ${order.knitter?.name || '—'}\n\n` +
    `${items}\n\n` +
    `${statusLine || ''}`
  );
}

function orderKeyboard(order) {
  if (order.status !== 'PENDING') return undefined;
  if (!order.assignedLoaderId) {
    return Markup.inlineKeyboard([Markup.button.callback('🚚 Привезти', `take:${order.id}`)]);
  }
  return Markup.inlineKeyboard([
    Markup.button.callback('✅ Привёз', `deliver:${order.id}`),
    Markup.button.callback('↩️ Отказаться', `decline:${order.id}`),
  ]);
}

async function notifyNewOrder(order) {
  if (!tgBot) return;
  const groupId = await getGroupId();
  if (!groupId) {
    console.log('[telegram] Не могу отправить заказ: ID группы ещё не известен. Выполните /setup в группе.');
    return;
  }
  const full = await prisma.order.findUnique({
    where: { id: order.id },
    include: { items: { include: { yarn: true } }, knitter: true },
  });
  if (!full) return;

  const message = await tgBot.telegram.sendMessage(
    groupId,
    renderOrderText(full, 'Ожидает грузчика'),
    orderKeyboard(full)
  );
  await saveOrderTelegramMessage(full.id, groupId, message);
}

async function notifyOrderCancelled(order, byWhom) {
  if (!tgBot) return;
  const groupId = await getGroupId();
  if (!groupId) return;

  const full = await prisma.order.findUnique({
    where: { id: order.id },
    include: { items: { include: { yarn: true } }, knitter: true },
  });
  if (!full) return;

  await tgBot.telegram.sendMessage(
    groupId,
    renderOrderText(full, `❌ Отменён ${byWhom || ''}`.trim())
  );
}

// ──────────────── Cron ────────────────
function startCron() {
  cron.schedule('0 9 * * *', () => {
    postStockReport().catch((e) => console.error('[cron] report failed', e.message));
  }, { timezone: 'Europe/Moscow' });

  cron.schedule('*/30 * * * *', () => {
    remindPendingOrders().catch((e) => console.error('[cron] remind failed', e.message));
  }, { timezone: 'Europe/Moscow' });

  console.log('[cron] Discord-отчёт: 09:00 Europe/Moscow');
  console.log('[cron] Telegram-напоминания: каждые 30 минут, пока заказ не доставлен');
}

async function remindPendingOrders() {
  if (!tgBot) return;
  const groupId = await getGroupId();
  if (!groupId) return;

  const pending = await prisma.order.findMany({
    where: { status: 'PENDING' },
    include: { items: { include: { yarn: true } }, knitter: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const order of pending) {
    try {
      const message = await tgBot.telegram.sendMessage(
        groupId,
        `⏰ Напоминание: заказ #${order.id.slice(-6)} всё ещё ожидает доставки\n\n` +
        renderOrderText(order, ''),
        orderKeyboard(order)
      );
      await saveOrderTelegramMessage(order.id, groupId, message);
    } catch (e) {
      console.error('[cron] remind send failed:', e.message);
    }
  }
}

async function saveOrderTelegramMessage(orderId, chatId, message) {
  await prisma.telegramOrderMessage.create({
    data: { orderId, chatId: String(chatId), messageId: message.message_id },
  });
}

async function deleteOrderTelegramMessages(orderId, currentChatId, currentMessageId) {
  if (!tgBot) return;

  const savedMessages = await prisma.telegramOrderMessage.findMany({ where: { orderId } });
  const messages = new Map(savedMessages.map((message) => [
    `${message.chatId}:${message.messageId}`,
    { chatId: message.chatId, messageId: message.messageId },
  ]));
  messages.set(`${currentChatId}:${currentMessageId}`, {
    chatId: String(currentChatId),
    messageId: currentMessageId,
  });

  for (const message of messages.values()) {
    try {
      await tgBot.telegram.deleteMessage(message.chatId, message.messageId);
    } catch (e) {
      console.error(`[telegram] Не удалось удалить сообщение заказа ${orderId} (${message.messageId}):`, e.message);
    }
  }

  await prisma.telegramOrderMessage.deleteMany({ where: { orderId } });
}

// ──────────────── Публичный API ────────────────
function startBot() {
  startDiscord();
  startTelegram();
}

function stopBot() {
  try {
    if (tgBot) { tgBot.stop('SIGTERM'); console.log('[telegram] Бот остановлен'); }
  } catch (e) { console.error('[telegram] stop error:', e.message); }
  try {
    if (discordClient) { discordClient.destroy(); console.log('[discord] Клиент остановлен'); }
  } catch (e) { console.error('[discord] stop error:', e.message); }
}

module.exports = {
  startBot,
  stopBot,
  startCron,
  postStockReport,
  notifyNewOrder,
  notifyOrderCancelled,
  refreshLoaderKeyboard,
};
