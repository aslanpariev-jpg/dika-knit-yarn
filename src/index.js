require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { prisma } = require('./db');
const routes = require('./routes');
const { startBot, startCron, stopBot } = require('./bot');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

app.use('/api', routes);

// Раздача собранного фронта (если есть).
// Ищем папку dist сначала в текущей директории, потом на уровень выше.
const possiblePaths = [
  path.join(process.cwd(), 'client', 'dist'),
  path.join(__dirname, '..', 'client', 'dist'),
  path.join(process.cwd(), 'dist'),
];

let clientDist = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    clientDist = p;
    console.log('✅ Найдена папка с фронтендом:', p);
    break;
  }
}

if (clientDist) {
  app.use(express.static(clientDist));
  // Отдаём index.html на любые GET-запросы, которые не начинаются с /api
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  console.log('❌ ВНИМАНИЕ: Папка client/dist не найдена!');
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  startBot();
  startCron();
});

// Graceful shutdown (важно для Render при редеплое)
async function shutdown(signal) {
  console.log(`[server] Получен ${signal}, завершаемся...`);
  try {
    stopBot();
  } catch (e) {
    console.error('[server] stopBot error:', e.message);
  }
  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch {}
    process.exit(0);
  });
  // Страховка, если что-то зависло
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));