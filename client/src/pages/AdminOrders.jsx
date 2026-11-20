import { useEffect, useState } from 'react';
import { api } from '../api.js';

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

const STATUS_COLOR = {
  PENDING: 'text-blue-600 bg-blue-50',
  DELIVERED: 'text-green-600 bg-green-50',
  CANCELLED: 'text-red-600 bg-red-50',
};

export default function AdminOrders() {
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.adminOrders(filter || undefined);
      setOrders(data);
    } catch (e) {
      alert('Ошибка: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter]);

  const cancelOrder = async (id) => {
    if (!confirm('Отменить заказ?')) return;
    try {
      await api.adminCancelOrder(id);
      setMsg('Заказ отменён');
      setTimeout(() => setMsg(''), 2000);
      await load();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  };

  const canCancel = (o) => o.status === 'PENDING';

  return (
    <div className="p-4 max-w-3xl mx-auto pb-16">
      <h1 className="text-2xl font-bold text-gray-800 mb-4">📦 Заказы</h1>

      {msg && (
        <div className="mb-4 text-green-600 text-center font-medium bg-green-50 py-2 rounded-lg">
          {msg}
        </div>
      )}

      {/* Фильтр по статусу */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { v: '', l: 'Все' },
          { v: 'PENDING', l: 'В ожидании' },
          { v: 'DELIVERED', l: 'Доставлено' },
          { v: 'CANCELLED', l: 'Отменено' },
        ].map(({ v, l }) => (
          <button
            key={v || 'all'}
            onClick={() => setFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
              filter === v
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300'
            }`}
          >
            {l}
          </button>
        ))}
        <button
          onClick={load}
          className="ml-auto px-3 py-1.5 rounded-lg text-sm font-medium border bg-white text-gray-700 border-gray-300"
        >
          Обновить
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-8">Загрузка...</div>
      ) : orders.length === 0 ? (
        <div className="text-center text-gray-500 py-8">Заказов нет</div>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => (
            <div
              key={o.id}
              className={`bg-white rounded-lg border p-4 ${
                o.overdue ? 'border-red-400 bg-red-50/30' : ''
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-semibold text-gray-800">
                    #{o.id.slice(-6)}
                    {o.overdue && (
                      <span className="ml-2 text-xs text-red-600 font-medium">
                        ⚠️ просрочен (&gt;1 ч)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(o.createdAt).toLocaleString('ru-RU')}
                  </div>
                </div>
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${STATUS_COLOR[o.status] || 'bg-gray-50 text-gray-600'}`}
                >
                  {STATUS_LABEL[o.status] || o.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-2">
                <div>
                  <span className="text-gray-500">Вязальщик:</span>{' '}
                  <span className="text-gray-800">{o.knitter?.name || '—'}</span>
                </div>
                <div>
                  <span className="text-gray-500">Грузчик:</span>{' '}
                  <span className="text-gray-800">
                    {o.deliveredBy?.name || o.assignedLoader?.name || '—'}
                  </span>
                </div>
              </div>

              <ul className="text-sm text-gray-700 space-y-0.5 mb-2">
                {o.items.map((it) => (
                  <li key={it.id}>
                    • {it.yarn.article}{it.yarn.color ? ` ${it.yarn.color}` : ''} — {Number(it.quantity)} {it.yarn.unit}
                    <span className="text-gray-500"> ({SOURCE_LABEL[it.source]})</span>
                  </li>
                ))}
              </ul>

              {o.note && (
                <div className="text-xs text-gray-500 mb-2">💬 {o.note}</div>
              )}

              <div className="flex gap-3 text-xs text-gray-500">
                {o.assignedAt && (
                  <span>Взял: {new Date(o.assignedAt).toLocaleString('ru-RU')}</span>
                )}
                {o.deliveredAt && (
                  <span>Доставлено: {new Date(o.deliveredAt).toLocaleString('ru-RU')}</span>
                )}
                {o.cancelledAt && (
                  <span>Отменён: {new Date(o.cancelledAt).toLocaleString('ru-RU')}</span>
                )}
              </div>

              {canCancel(o) && (
                <button
                  onClick={() => cancelOrder(o.id)}
                  className="mt-3 text-xs text-red-600 font-medium"
                >
                  Отменить заказ
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}