const express = require('express');
const { Prisma } = require('@prisma/client');
const { prisma } = require('./db');
const { validatePin, hashPin, verifyPin, signToken, auth, requireRole } = require('./auth');
const { getStock, getYarnStockAt, createOrderDeliveryMovements, createReceiptMovements } = require('./stock');

const router = express.Router();

// ───── AUTH ─────
router.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});

// Вход для вязальщиков (без PIN)
router.post('/login-knitter', async (req, res) => {
  const { userId } = req.body;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'KNITTER') return res.status(401).json({ error: 'Доступ только для вязальщиков' });

  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

// Вход для админа/грузчика по PIN
router.post('/login', async (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !validatePin(pin)) return res.status(400).json({ error: 'Нужен userId и PIN из 4 цифр' });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) return res.status(401).json({ error: 'Пользователь не найден' });
  const ok = await verifyPin(pin, user.pinHash);
  if (!ok) return res.status(401).json({ error: 'Неверный PIN' });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

router.get('/me', auth, (req, res) => {
  const { id, name, role } = req.user;
  res.json({ id, name, role });
});

// ───── YARNS ─────
// Список пряжи с остатками по локациям (для вязальщика и админа)
router.get('/yarns', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const yarns = await prisma.yarn.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      ...(q ? { OR: [
        { article: { contains: q, mode: 'insensitive' } },
        { color: { contains: q, mode: 'insensitive' } },
        { type: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    },
    orderBy: { article: 'asc' },
    take: 100,
  });

  const locations = await prisma.location.findMany();
  const locByType = Object.fromEntries(locations.map((l) => [l.type, l.id]));
  const grouped = await prisma.stockMovement.groupBy({
    by: ['yarnId', 'locationId'],
    _sum: { quantity: true },
  });
  const sumBy = (yarnId, type) => {
    const locId = locByType[type];
    const row = grouped.find((g) => g.yarnId === yarnId && g.locationId === locId);
    return row?._sum.quantity ?? new Prisma.Decimal(0);
  };

  res.json(yarns.map((y) => ({
    ...y,
    home: sumBy(y.id, 'HOME'),
    warehouse: sumBy(y.id, 'WAREHOUSE'),
    workshop: sumBy(y.id, 'WORKSHOP'),
  })));
});

router.get('/yarns/:id/stock', auth, async (req, res) => {
  const location = (req.query.location || '').toString();
  if (!['HOME', 'WAREHOUSE', 'WORKSHOP'].includes(location)) return res.status(400).json({ error: 'Неверная локация' });
  const qty = await getYarnStockAt(req.params.id, location);
  res.json({ quantity: qty });
});

// ───── STOCK ─────
router.get('/stock', async (_req, res) => {
  res.json(await getStock());
});

// ───── ORDERS (вязальщик) ─────
// Создать заказ
router.post('/orders', auth, requireRole('KNITTER', 'ADMIN'), async (req, res) => {
  const { items, note } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Нет позиций' });

  // Валидация позиций и остатков
  for (const it of items) {
    if (!it.yarnId || !it.quantity || !['HOME', 'WAREHOUSE', 'CITY_BUY'].includes(it.source)) {
      return res.status(400).json({ error: 'Неверная позиция' });
    }
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Количество > 0' });

    // Для HOME/WAREHOUSE проверяем остаток; для CITY_BUY — нет
    if (it.source === 'HOME' || it.source === 'WAREHOUSE') {
      const available = await getYarnStockAt(it.yarnId, it.source);
      if (new Prisma.Decimal(it.quantity).greaterThan(available)) {
        const yarn = await prisma.yarn.findUnique({ where: { id: it.yarnId } });
        return res.status(400).json({
          error: `На локации ${it.source} только ${available.toString()} ${yarn?.unit || ''} для «${yarn?.article || it.yarnId}». Уменьшите количество или купите в городе (CITY_BUY).`,
        });
      }
    }
  }

  const order = await prisma.order.create({
    data: {
      knitterId: req.user.id,
      note: note || null,
      items: {
        create: items.map((it) => ({
          yarnId: it.yarnId,
          quantity: new Prisma.Decimal(it.quantity),
          source: it.source,
        })),
      },
    },
    include: { items: { include: { yarn: true } } },
  });

  // Уведомление в Telegram-группу (не блокируем ответ, если бот не готов)
  try {
    const { notifyNewOrder } = require('./bot');
    await notifyNewOrder(order);
  } catch (e) {
    console.error('[orders] notifyNewOrder failed:', e.message);
  }

  res.status(201).json(order);
});

// Мои заказы
router.get('/orders/my', auth, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { knitterId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { items: { include: { yarn: true } } },
  });
  res.json(orders);
});

// Отменить заказ (вязальщик: только PENDING и < 10 мин; админ — через /admin/orders/:id/cancel)
router.post('/orders/:id/cancel', auth, async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status !== 'PENDING') return res.status(400).json({ error: 'Заказ уже не в статусе ожидания' });

  const isAdmin = req.user.role === 'ADMIN';
  if (!isAdmin) {
    if (order.knitterId !== req.user.id) return res.status(403).json({ error: 'Не ваш заказ' });
    const ageMin = (Date.now() - order.createdAt.getTime()) / 60000;
    if (ageMin > 10) return res.status(403).json({ error: 'Прошло 10 минут, отмена недоступна' });
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  try {
    const { notifyOrderCancelled } = require('./bot');
    await notifyOrderCancelled(updated, isAdmin ? 'администратором' : 'вязальщиком');
  } catch (e) {
    console.error('[orders] notifyOrderCancelled failed:', e.message);
  }

  res.json({ ok: true });
});

// ───── ИЗМЕНЕНИЕ ПРЯЖИ В ЦЕХУ (вязальщик) ─────
router.post('/workshop/adjust', auth, requireRole('KNITTER', 'ADMIN'), async (req, res) => {
  const { yarnId, delta } = req.body;
  if (!yarnId || delta === 0) return res.status(400).json({ error: 'Неверные данные' });

  try {
    const workshop = await prisma.location.findUniqueOrThrow({ where: { type: 'WORKSHOP' } });
    await prisma.stockMovement.create({
      data: {
        yarnId,
        locationId: workshop.id,
        quantity: new Prisma.Decimal(delta),
        reason: `Корректировка вязальщиком: ${delta > 0 ? 'добавил' : 'списал'}`,
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ───── ADMIN ─────
const admin = express.Router();
admin.use(auth, requireRole('ADMIN'));

admin.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, role: true, active: true,
      lastLoginAt: true, createdAt: true, telegramChatId: true,
    },
  });
  res.json(users);
});

admin.post('/users', async (req, res) => {
  const { name, pin, role } = req.body;
  if (!name || !validatePin(pin) || !['LOADER', 'KNITTER', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Неверные данные' });
  }
  const user = await prisma.user.create({ data: { name, pinHash: await hashPin(pin), role } });
  res.status(201).json({ id: user.id, name: user.name, role: user.role });
});

admin.post('/users/:id/pin', async (req, res) => {
  const { pin } = req.body;
  if (!validatePin(pin)) return res.status(400).json({ error: 'PIN 4 цифры' });
  await prisma.user.update({
    where: { id: req.params.id },
    data: { pinHash: await hashPin(pin), tokenVersion: { increment: 1 } },
  });
  res.json({ ok: true });
});

admin.post('/users/:id/deactivate', async (req, res) => {
  await prisma.user.update({
    where: { id: req.params.id },
    data: { active: false, tokenVersion: { increment: 1 } },
  });
  res.json({ ok: true });
});

// Сброс привязки Telegram
admin.post('/users/:id/reset-telegram', async (req, res) => {
  await prisma.user.update({
    where: { id: req.params.id },
    data: { telegramChatId: null },
  });
  try {
    const { refreshLoaderKeyboard } = require('./bot');
    await refreshLoaderKeyboard();
  } catch (e) {
    console.error('[admin] refreshLoaderKeyboard failed:', e.message);
  }
  res.json({ ok: true });
});

admin.post('/yarns', async (req, res) => {
  const { article, type, color, composition, thickness, unit } = req.body;
  if (!article) return res.status(400).json({ error: 'Нужен артикул' });
  const yarn = await prisma.yarn.create({
    data: {
      article,
      type: type || null,
      color: color || null,
      composition: composition || null,
      thickness: thickness || null,
      unit: unit || 'меш',
      status: 'ACTIVE',
    },
  });
  res.status(201).json(yarn);
});

admin.put('/yarns/:id', async (req, res) => {
  const { article, type } = req.body;
  try {
    const dataToUpdate = {};
    if (article) dataToUpdate.article = article;
    if (type !== undefined) dataToUpdate.type = type;
    if (Object.keys(dataToUpdate).length === 0) return res.status(400).json({ error: 'Нет данных для обновления' });

    const updated = await prisma.yarn.update({ where: { id: req.params.id }, data: dataToUpdate });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Такая пряжа уже есть' });
    res.status(500).json({ error: e.message });
  }
});

admin.delete('/yarns/:id', async (req, res) => {
  try {
    await prisma.yarn.update({ where: { id: req.params.id }, data: { status: 'ARCHIVED' } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

admin.post('/receipts', async (req, res) => {
  const { locationType, items, note } = req.body;
  if (!['HOME', 'WAREHOUSE', 'WORKSHOP'].includes(locationType)) return res.status(400).json({ error: 'Неверная локация' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Нет позиций' });
  const location = await prisma.location.findUnique({ where: { type: locationType } });
  if (!location) return res.status(400).json({ error: 'Локация не найдена' });

  const receipt = await prisma.$transaction(async (tx) => {
    const created = await tx.receipt.create({
      data: {
        adminId: req.user.id,
        locationId: location.id,
        note: note || null,
        items: { create: items.map((it) => ({ yarnId: it.yarnId, quantity: new Prisma.Decimal(it.quantity) })) },
      },
      include: { items: { include: { yarn: true } } },
    });
    await createReceiptMovements(tx, created.id, location.id, created.items);
    return created;
  });
  res.status(201).json(receipt);
});

// Все заказы (для админа)
admin.get('/orders', async (req, res) => {
  const { status } = req.query;
  const where = {};
  if (status && ['PENDING', 'DELIVERED', 'CANCELLED'].includes(status)) where.status = status;

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      items: { include: { yarn: true } },
      knitter: { select: { id: true, name: true } },
      assignedLoader: { select: { id: true, name: true } },
      deliveredBy: { select: { id: true, name: true } },
    },
  });

  const now = Date.now();
  res.json(orders.map((o) => ({
    ...o,
    overdue: o.status === 'PENDING' && (now - new Date(o.createdAt).getTime()) > 60 * 60 * 1000,
  })));
});

// Отменить любой заказ (админ)
admin.post('/orders/:id/cancel', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status === 'DELIVERED') return res.status(400).json({ error: 'Заказ уже доставлен' });
  if (order.status === 'CANCELLED') return res.status(400).json({ error: 'Уже отменён' });

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  try {
    const { notifyOrderCancelled } = require('./bot');
    await notifyOrderCancelled(updated, 'администратором');
  } catch (e) {
    console.error('[admin] notifyOrderCancelled failed:', e.message);
  }
  res.json({ ok: true });
});

admin.post('/reports/stock', async (_req, res) => {
  try {
    const { postStockReport } = require('./bot');
    await postStockReport();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.use('/admin', admin);

module.exports = router;