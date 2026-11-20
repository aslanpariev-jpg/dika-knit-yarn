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
const TG_GROUP_ID = process.env.TELEGRAM_GROUP_ID; // ID группы грузчиков (например, -1001234567890)

let tgBot = null;
let pinnedMessageId = null; // ID закреплённого сообщения с выбором грузчика

function isConfigured() {
  return Boolean(TG_TOKEN && TG_GROUP_ID);
}

function startTelegram() {
  if (!TG_TOKEN) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запущен');
    return;
  }
  tgBot = new Telegraf(TG_TOKEN);

  // /start в личке — просто подсказка
  tgBot.start((ctx) => {
    ctx.reply(
      'Привет! Я бот учёта пряжи.\n\n' +
      'Если ты грузчик — выбери себя в закреплённом сообщении в группе грузчиков.'
    );
  });

  // /bind — ручная привязка (на случай, если закреплённое сообщение устарело)
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
    await ctx.editMessageText(
      `Закреплённое сообщение\n\n` +
      `Выбери себя, чтобы получать заказы:\n\n` +
      loadersListText(await prisma.user.findMany({ where: { role: 'LOADER', active: true }, orderBy: { name: 'asc' } })),
      Markup.inlineKeyboard(
        (await prisma.user.findMany({ where: { role: 'LOADER', active: true }, orderBy: { name: 'asc' } }))
          .map((u) => Markup.button.callback(u.name, `bind:${u.id}`)),
        { columns: 2 }
      )
    ).catch(() => {});
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

    // Привозить можно только после "Привезти"
    if (!order.assignedLoaderId) {
      return ctx.answerCbQuery('Сначала нажми «Привезти»', { show_alert: true });
    }

    // Транзакция: движения + статус
    const { createOrderDeliveryMovements } = require('./stock');
    const updated = await prisma.$transaction(async (tx) => {
      await createOrderDeliveryMovements(tx, order.id, order.items);
      return tx.order.update({
        where: { id: order.id },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(),
          deliveredById: loader.id,
        },
        include: { items: { include: { yarn: true } }, knitter: true },
      });
    });

    await ctx.answerCbQuery('Доставлено!');
    await ctx.editMessageText(
      renderOrderText(updated, `✅ Доставлено (${loader.name})`),
      undefined
    ).catch(() => {});
  });

  // Запуск + установка закреплённого сообщения при старте
  tgBot.launch()
    .then(() => {
      console.log('[telegram] Бот запущен');
      ensurePinnedMessage().catch((e) => console.error('[telegram] pinned failed:', e.message));
    })
    .catch((e) => console.error('[telegram] launch failed:', e.message));

  process.once('SIGINT', () => tgBot.stop('SIGINT'));
  process.once('SIGTERM', () => tgBot.stop('SIGTERM'));
}

function loadersListText(loaders) {
  return loaders.map((u) => `• ${u.name}${u.telegramChatId ? ' ✅' : ''}`).join('\n');
}

async function ensurePinnedMessage() {
  if (!tgBot || !TG_GROUP_ID) return;
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
    const msg = await tgBot.telegram.sendMessage(TG_GROUP_ID, text, keyboard);
    await tgBot.telegram.pinChatMessage(TG_GROUP_ID, msg.message_id, { disable_notification: true });
    pinnedMessageId = msg.message_id;
    console.log('[telegram] Закреплённое сообщение установлено');
  } catch (e) {
    console.error('[telegram] ensurePinnedMessage:', e.message);
  }
}

// Обновить закреплённое сообщение (после сброса привязки админом)
async function refreshLoaderKeyboard() {
  if (!tgBot || !TG_GROUP_ID || !pinnedMessageId) return;
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
    await tgBot.telegram.editMessageText(TG_GROUP_ID, pinnedMessageId, undefined, text, keyboard);
  } catch (e) {
    // Если сообщение нельзя редактировать — пересоздадим
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

// Уведомление о новом заказе
async function notifyNewOrder(order) {
  if (!tgBot || !TG_GROUP_ID) return;
  const full = await prisma.order.findUnique({
    where: { id: order.id },
    include: { items: { include: { yarn: true } }, knitter: true },
  });
  if (!full) return;

  await tgBot.telegram.sendMessage(
    TG_GROUP_ID,
    renderOrderText(full, 'Ожидает грузчика'),
    orderKeyboard(full)
  );
}

// Уведомление об отмене
async function notifyOrderCancelled(order, byWhom) {
  if (!tgBot || !TG_GROUP_ID) return;
  const full = await prisma.order.findUnique({
    where: { id: order.id },
    include: { items: { include: { yarn: true } }, knitter: true },
  });
  if (!full) return;

  await tgBot.telegram.sendMessage(
    TG_GROUP_ID,
    renderOrderText(full, `❌ Отменён ${byWhom || ''}`.trim())
  );
}

// ──────────────── Cron ────────────────
function startCron() {
  // Discord-отчёт в 09:00 МСК
  cron.schedule('0 9 * * *', () => {
    postStockReport().catch((e) => console.error('[cron] report failed', e.message));
  }, { timezone: 'Europe/Moscow' });

  // Напоминания о PENDING-заказах каждые 10 минут (только в течение первого часа)
  cron.schedule('*/10 * * * *', () => {
    remindPendingOrders().catch((e) => console.error('[cron] remind failed', e.message));
  }, { timezone: 'Europe/Moscow' });

  console.log('[cron] Discord-отчёт: 09:00 Europe/Moscow');
  console.log('[cron] Telegram-напоминания: каждые 10 минут');
}

async function remindPendingOrders() {
  if (!tgBot || !TG_GROUP_ID) return;
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);

  const pending = await prisma.order.findMany({
    where: { status: 'PENDING', createdAt: { gte: oneHourAgo } },
    include: { items: { include: { yarn: true } }, knitter: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const order of pending) {
    try {
      await tgBot.telegram.sendMessage(
        TG_GROUP_ID,
        `⏰ Напоминание: заказ #${order.id.slice(-6)} всё ещё ожидает доставки\n\n` +
        renderOrderText(order, ''),
        orderKeyboard(order)
      );
    } catch (e) {
      console.error('[cron] remind send failed:', e.message);
    }
  }
}

// ──────────────── Публичный API ────────────────
function startBot() {
  startDiscord();
  startTelegram();
}
// ──────────────── Остановка ботов (graceful shutdown) ────────────────
function stopBot() {
  try {
    if (tgBot) {
      tgBot.stop('SIGTERM');
      console.log('[telegram] Бот остановлен');
    }
  } catch (e) {
    console.error('[telegram] stop error:', e.message);
  }
  try {
    if (discordClient) {
      discordClient.destroy();
      console.log('[discord] Клиент остановлен');
    }
  } catch (e) {
    console.error('[discord] stop error:', e.message);
  }
}
module.exports = {
  startBot,
  startCron,
  postStockReport,
  notifyNewOrder,
  notifyOrderCancelled,
  refreshLoaderKeyboard,
};