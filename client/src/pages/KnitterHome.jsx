import { useEffect, useState } from 'react';
import { api, clearAuth } from '../api.js';

const SOURCE_LABEL = {
  HOME: 'Из дома',
  WAREHOUSE: 'Со склада',
  CITY_BUY: 'Купить в городе',
};

const STATUS_LABEL = {
  PENDING: 'В ожидании',
  DELIVERED: 'Доставлено',
  CANCELLED: 'Отменено',
};

function fmt(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num : 0;
}

export default function KnitterHome() {
  const [stock, setStock] = useState([]);
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // Корзина: { [yarnId]: { yarn, quantity, source } }
  const [cart, setCart] = useState({});
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ─── Загрузка ───
  const loadStock = async () => {
    try {
      const data = await api.getStock();
      setStock(data);
    } catch (e) {
      console.error(e);
    }
  };
  const loadOrders = async () => {
    try {
      const data = await api.getMyOrders();
      setOrders(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    (async () => {
      await Promise.all([loadStock(), loadOrders()]);
      setLoading(false);
    })();
  }, []);

  const flash = (text) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 2500);
  };

  // ─── Работа с корзиной ───
  const addToCart = (item) => {
    setCart((c) => ({
      ...c,
      [item.yarnId]: {
        yarn: item,
        quantity: c[item.yarnId]?.quantity ?? 1,
        source: c[item.yarnId]?.source ?? 'WAREHOUSE',
      },
    }));
  };

  const updateCart = (yarnId, patch) => {
    setCart((c) => ({
      ...c,
      [yarnId]: { ...c[yarnId], ...patch },
    }));
  };

  const removeFromCart = (yarnId) => {
    setCart((c) => {
      const copy = { ...c };
      delete copy[yarnId];
      return copy;
    });
  };

  // Для позиции: доступно по выбранному источнику
  const availableFor = (yarnId, source) => {
    const item = stock.find((s) => s.yarnId === yarnId);
    if (!item) return 0;
    if (source === 'HOME') return fmt(item.home);
    if (source === 'WAREHOUSE') return fmt(item.warehouse);
    return Infinity; // CITY_BUY — без ограничений
  };

  // Максимум, который можно ввести
  const maxFor = (yarnId, source) => {
    if (source === 'CITY_BUY') return undefined;
    return availableFor(yarnId, source);
  };

  const cartItems = Object.entries(cart);
  const cartCount = cartItems.length;

  const submitOrder = async () => {
    if (!cartItems.length) return;
    // Валидация на клиенте
    for (const [yarnId, entry] of cartItems) {
      const qty = Number(entry.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        alert(`Введите количество > 0 для «${entry.yarn.article}»`);
        return;
      }
      if (entry.source !== 'CITY_BUY') {
        const max = maxFor(yarnId, entry.source);
        if (qty > max) {
          alert(`«${entry.yarn.article}»: на локации «${SOURCE_LABEL[entry.source]}» только ${max}. Уменьшите или выберите «Купить в городе».`);
          return;
        }
      }
    }

    setSubmitting(true);
    try {
      await api.createOrder(
        cartItems.map(([yarnId, e]) => ({
          yarnId,
          quantity: e.quantity,
          source: e.source,
        })),
        note
      );
      setCart({});
      setNote('');
      flash('Заказ создан! Грузчики уведомлены.');
      await Promise.all([loadStock(), loadOrders()]);
    } catch (e) {
      alert('Ошибка: ' + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelOrder = async (orderId) => {
    if (!confirm('Отменить заказ?')) return;
    try {
      await api.cancelOrder(orderId);
      flash('Заказ отменён');
      await Promise.all([loadStock(), loadOrders()]);
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  };

  const canCancel = (o) => {
    if (o.status !== 'PENDING') return false;
    const ageMin = (Date.now() - new Date(o.createdAt).getTime()) / 60000;
    return ageMin <= 10;
  };

  const filtered = stock.filter((item) =>
    `${item.article} ${item.color || ''}`.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div className="p-8 text-center text-gray-500">Загрузка...</div>;

  return (
    <div className="p-4 max-w-md mx-auto pb-32">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🧵 Пряжа</h1>
        <button
          onClick={() => { clearAuth(); window.location.reload(); }}
          className="text-sm text-red-600 font-medium"
        >
          Выйти
        </button>
      </div>

      {msg && (
        <div className="mb-4 text-green-600 text-center font-medium bg-green-50 py-2 rounded-lg">
          {msg}
        </div>
      )}

      <input
        type="text"
        placeholder="Поиск пряжи..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-4 py-3 rounded-xl border border-gray-300 mb-6 focus:border-blue-500 outline-none"
      />

      {/* ─── Список пряжи ─── */}
      <div className="space-y-4 mb-8">
        {filtered.map((item) => {
          const inCart = cart[item.yarnId];
          return (
            <div key={item.yarnId} className="bg-white rounded-xl p-4 border shadow-sm">
              <div className="mb-2">
                <div className="font-bold text-gray-800 text-lg">{item.article}</div>
                {item.color && <div className="text-sm text-gray-500">{item.color}</div>}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">Дом</div>
                  <div className="font-semibold text-gray-800">{fmt(item.home)}</div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">Склад</div>
                  <div className="font-semibold text-gray-800">{fmt(item.warehouse)}</div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">Цех</div>
                  <div className="font-semibold text-gray-800">{fmt(item.workshop)}</div>
                </div>
              </div>
              {!inCart ? (
                <button
                  onClick={() => addToCart(item)}
                  className="w-full py-2 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700"
                >
                  + Добавить в заказ
                </button>
              ) : (
                <button
                  onClick={() => removeFromCart(item.yarnId)}
                  className="w-full py-2 rounded-lg bg-gray-200 text-gray-700 font-medium active:bg-gray-300"
                >
                  Убрать из заказа
                </button>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="text-center py-10 text-gray-500">Пряжа не найдена</div>
        )}
      </div>

      {/* ─── Корзина (фиксированная снизу) ─── */}
      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg p-4 z-20">
          <div className="max-w-md mx-auto">
            <div className="font-semibold mb-2 text-gray-800">Заказ ({cartCount})</div>
            <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
              {cartItems.map(([yarnId, entry]) => {
                const max = maxFor(yarnId, entry.source);
                return (
                  <div key={yarnId} className="bg-gray-50 rounded-lg p-2">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium truncate mr-2">{entry.yarn.article}</span>
                      <button
                        onClick={() => removeFromCart(yarnId)}
                        className="text-red-600 text-xs"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={entry.source}
                        onChange={(e) => {
                          const source = e.target.value;
                          const newMax = maxFor(yarnId, source);
                          const newQty = newMax !== undefined
                            ? Math.min(Number(entry.quantity) || 1, newMax)
                            : (Number(entry.quantity) || 1);
                          updateCart(yarnId, { source, quantity: newQty });
                        }}
                        className="flex-1 text-sm border rounded px-2 py-1 bg-white"
                      >
                        <option value="HOME">Из дома</option>
                        <option value="WAREHOUSE">Со склада</option>
                        <option value="CITY_BUY">Купить в городе</option>
                      </select>
                      <input
                        type="number"
                        min="1"
                        max={max === undefined ? undefined : max}
                        value={entry.quantity}
                        onChange={(e) => {
                          let v = Number(e.target.value);
                          if (max !== undefined && v > max) v = max;
                          updateCart(yarnId, { quantity: v });
                        }}
                        className="w-20 text-center border rounded px-2 py-1 text-sm"
                      />
                      <span className="text-xs text-gray-500">
                        {max === undefined ? '∞' : `до ${max}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <textarea
              placeholder="Комментарий к заказу (необязательно)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="w-full text-sm border rounded px-2 py-1 mb-2"
            />
            <button
              onClick={submitOrder}
              disabled={submitting}
              className="w-full py-3 rounded-lg bg-green-600 text-white font-semibold active:bg-green-700 disabled:opacity-50"
            >
              {submitting ? 'Отправка...' : `Заказать (${cartCount})`}
            </button>
          </div>
        </div>
      )}

      {/* ─── Мои заказы ─── */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Мои заказы</h2>
        {orders.length === 0 && (
          <div className="text-sm text-gray-500">Пока нет заказов</div>
        )}
        <div className="space-y-3">
          {orders.map((o) => (
            <div key={o.id} className="bg-white rounded-lg border p-3">
              <div className="flex justify-between items-center mb-1">
                <div className="text-sm font-semibold text-gray-800">
                  #{o.id.slice(-6)}
                </div>
                <div className={`text-xs font-medium ${
                  o.status === 'DELIVERED' ? 'text-green-600'
                  : o.status === 'CANCELLED' ? 'text-red-600'
                  : 'text-blue-600'
                }`}>
                  {STATUS_LABEL[o.status] || o.status}
                </div>
              </div>
              <div className="text-xs text-gray-500 mb-2">
                {new Date(o.createdAt).toLocaleString('ru-RU')}
              </div>
              <ul className="text-sm text-gray-700 space-y-0.5 mb-2">
                {o.items.map((it) => (
                  <li key={it.id}>
                    {it.yarn.article} — {Number(it.quantity)} {it.yarn.unit}
                    <span className="text-gray-500"> ({SOURCE_LABEL[it.source]})</span>
                  </li>
                ))}
              </ul>
              {canCancel(o) && (
                <button
                  onClick={() => cancelOrder(o.id)}
                  className="text-xs text-red-600 font-medium"
                >
                  Отменить (доступно 10 мин)
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}