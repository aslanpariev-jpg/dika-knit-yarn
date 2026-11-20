import { useEffect, useState, useMemo } from 'react';
import { api, clearAuth } from '../api.js';

const YARN_TYPES = [
  'норка', 'мираль', 'вискоза', 'букле', 'аванде', 
  'ангора', 'объемка', 'блэк', 'вискоза поетка', 
  'п/шерсть', 'хлопок'
];

export default function KnitterHome() {
  const [stock, setStock] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  
  // Состояния для корзины
  const [cart, setCart] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Загрузка остатков
  const loadStock = async () => {
    try {
      const data = await api.getStock();
      setStock(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStock(); }, []);

  // Уведомление
  const flash = (text) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  // Группировка и фильтрация
  const groupedAndFiltered = useMemo(() => {
    const filtered = stock.filter(item => {
      const text = `${item.article} ${item.color || ''} ${item.type || ''}`.toLowerCase();
      return text.includes(search.toLowerCase());
    });

    const groups = {};
    filtered.forEach(item => {
      const categoryName = item.type && item.type.trim() !== '' ? item.type.trim() : 'Без категории';
      if (!groups[categoryName]) groups[categoryName] = [];
      groups[categoryName].push(item);
    });

    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  }, [stock, search]);

  // Общая статистика
  const totalStats = useMemo(() => {
    return stock.reduce((acc, item) => {
      acc.home += Number(item.home);
      acc.warehouse += Number(item.warehouse);
      acc.workshop += Number(item.workshop);
      acc.total += Number(item.home) + Number(item.warehouse) + Number(item.workshop);
      return acc;
    }, { home: 0, warehouse: 0, workshop: 0, total: 0 });
  }, [stock]);

  // --- ЛОГИКА ЗАКАЗА ---
  
  // Установить источник и количество
  const setCartItem = (yarnId, source, maxAvailable) => {
    setCart(prev => {
      const current = prev[yarnId];
      // Если кликнули на ту же локацию - снимаем выбор
      if (current && current.source === source) {
        const copy = { ...prev };
        delete copy[yarnId];
        return copy;
      }
      
      // Выбрали новую локацию - ставим 1 шт (или максимум, если остаток 1)
      let initialQty = 1;
      if (source !== 'CITY_BUY' && maxAvailable < 1) initialQty = 0;
      
      return {
        ...prev,
        [yarnId]: { source, quantity: initialQty }
      };
    });
  };

  // Изменение количества
  const updateQty = (yarnId, val, maxAvailable) => {
    let num = Number(val);
    if (isNaN(num) || num < 0) num = 0;
    if (maxAvailable !== Infinity && num > maxAvailable) num = maxAvailable;
    
    setCart(prev => ({
      ...prev,
      [yarnId]: { ...prev[yarnId], quantity: num }
    }));
  };

  // Отмена (снять выбор)
  const cancelItem = (yarnId) => {
    setCart(prev => {
      const copy = { ...prev };
      delete copy[yarnId];
      return copy;
    });
  };

  // Отправка заказа
  const submitOrder = async () => {
    const itemsToOrder = Object.entries(cart)
      .filter(([_, v]) => Number(v.quantity) > 0)
      .map(([yarnId, v]) => ({
        yarnId,
        quantity: Number(v.quantity),
        source: v.source
      }));

    if (itemsToOrder.length === 0) {
      alert('Выберите хотя бы одну позицию');
      return;
    }

    setSubmitting(true);
    try {
      await api.createOrder(itemsToOrder);
      setCart({});
      flash('Заказ создан! Грузчики уведомлены.');
      await loadStock();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const activeOrdersCount = Object.values(cart).filter(v => v.quantity > 0).length;

  if (loading) return <div className="p-8 text-center text-gray-500">Загрузка...</div>;

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8 font-sans pb-24">
      <div className="max-w-6xl mx-auto">
        
        {/* Шапка */}
        <div className="mb-6 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Заказ пряжи</h1>
            <p className="text-gray-500 text-sm mt-1">Выберите локацию галочкой и укажите количество</p>
          </div>
          
          <div className="flex gap-2 w-full md:w-auto items-center">
            <div className="relative flex-1 md:w-96">
              <input 
                type="text" 
                placeholder="Поиск..." 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 shadow-sm focus:border-blue-500 outline-none"
              />
              <svg className="w-5 h-5 text-gray-400 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
              </svg>
            </div>
            <button onClick={() => { clearAuth(); window.location.reload(); }} className="text-sm text-red-600 font-medium px-3 py-2 border rounded-xl bg-white shadow-sm">
              Выйти
            </button>
          </div>
        </div>

        {msg && (
          <div className="mb-6 text-green-700 bg-green-50 border border-green-200 text-center font-medium py-3 rounded-xl">
            {msg}
          </div>
        )}

        {/* Статистика */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8 flex flex-wrap gap-8 items-center justify-between">
          <div>
            <p className="text-sm text-gray-500 mb-1">Всего в наличии</p>
            <p className="text-3xl font-bold text-gray-800">{totalStats.total} <span className="text-lg font-normal text-gray-500">меш</span></p>
          </div>
          <div className="flex gap-8 text-sm">
            <div className="text-center"><p className="text-gray-500 mb-1">Дом</p><p className="font-semibold text-lg text-gray-800">{totalStats.home}</p></div>
            <div className="text-center"><p className="text-gray-500 mb-1">Склад</p><p className="font-semibold text-lg text-blue-600">{totalStats.warehouse}</p></div>
            <div className="text-center"><p className="text-gray-500 mb-1">Цех</p><p className="font-semibold text-lg text-green-600">{totalStats.workshop}</p></div>
          </div>
        </div>

        {/* Таблицы */}
        <div className="space-y-6">
          {groupedAndFiltered.map(([categoryName, items]) => (
            <div key={categoryName} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              
              <div className="bg-slate-50 px-5 py-4 border-b border-gray-200 flex justify-between items-center">
                <h2 className="font-bold text-gray-800 text-lg flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                  {categoryName}
                </h2>
                <span className="text-sm text-gray-500 font-medium">
                  Итого: {items.reduce((sum, i) => sum + Number(i.home) + Number(i.warehouse) + Number(i.workshop), 0)} меш
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-gray-600">
                  <thead className="bg-white border-b border-gray-100 text-xs uppercase text-gray-400">
                    <tr>
                      <th className="px-5 py-3 font-medium">Наименование</th>
                      
                      {/* Заголовки локаций с выбором */}
                      <th className="px-2 py-3 font-medium text-center w-24 text-blue-600 bg-blue-50/30">Дом</th>
                      <th className="px-2 py-3 font-medium text-center w-24 text-blue-600 bg-blue-50/30">Склад</th>
                      <th className="px-2 py-3 font-medium text-center w-24 text-blue-600 bg-blue-50/30">Город (купить)</th>
                      
                      <th className="px-5 py-3 font-medium text-center w-32">Кол-во</th>
                      <th className="px-5 py-3 font-medium text-center w-24">Действие</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.map((item) => {
                      const inCart = cart[item.yarnId];
                      const selectedSource = inCart?.source;
                      
                      const maxAvailable = selectedSource === 'CITY_BUY' 
                        ? Infinity 
                        : Number(item[selectedSource?.toLowerCase() || 'home']);

                      return (
                        <tr key={item.yarnId} className={`transition-colors ${inCart ? 'bg-blue-50/20' : 'hover:bg-gray-50'}`}>
                          <td className="px-5 py-3">
                            <div className="font-medium text-gray-800">{item.article}</div>
                            {item.color && <div className="text-xs text-gray-500">{item.color}</div>}
                          </td>
                          
                          {/* Чекбоксы локаций */}
                          <td className="px-2 py-3 text-center border-l border-gray-100">
                            <label className="cursor-pointer flex flex-col items-center justify-center">
                              <input 
                                type="checkbox" 
                                checked={selectedSource === 'HOME'}
                                onChange={() => setCartItem(item.yarnId, 'HOME', Number(item.home))}
                                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                                disabled={Number(item.home) === 0}
                              />
                              <span className={`text-xs mt-1 ${Number(item.home) === 0 ? 'text-gray-300' : 'text-gray-500'}`}>{Number(item.home)}</span>
                            </label>
                          </td>
                          
                          <td className="px-2 py-3 text-center border-l border-gray-100 bg-blue-50/10">
                            <label className="cursor-pointer flex flex-col items-center justify-center">
                              <input 
                                type="checkbox" 
                                checked={selectedSource === 'WAREHOUSE'}
                                onChange={() => setCartItem(item.yarnId, 'WAREHOUSE', Number(item.warehouse))}
                                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                                disabled={Number(item.warehouse) === 0}
                              />
                              <span className={`text-xs mt-1 ${Number(item.warehouse) === 0 ? 'text-gray-300' : 'text-gray-500'}`}>{Number(item.warehouse)}</span>
                            </label>
                          </td>
                          
                          <td className="px-2 py-3 text-center border-l border-gray-100">
                            <label className="cursor-pointer flex flex-col items-center justify-center">
                              <input 
                                type="checkbox" 
                                checked={selectedSource === 'CITY_BUY'}
                                onChange={() => setCartItem(item.yarnId, 'CITY_BUY', Infinity)}
                                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                              />
                              <span className="text-xs mt-1 text-gray-500">∞</span>
                            </label>
                          </td>

                          {/* Ввод количества */}
                          <td className="px-3 py-3 text-center border-l border-gray-100">
                            {inCart ? (
                              <input 
                                type="number"
                                min="1"
                                max={maxAvailable === Infinity ? undefined : maxAvailable}
                                value={inCart.quantity}
                                onChange={(e) => updateQty(item.yarnId, e.target.value, maxAvailable)}
                                className="w-16 text-center font-bold text-gray-800 border-b-2 border-blue-400 focus:border-blue-600 outline-none bg-transparent"
                              />
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>

                          {/* Кнопка действия */}
                          <td className="px-3 py-3 text-center border-l border-gray-100">
                            {inCart ? (
                              <button 
                                onClick={() => cancelItem(item.yarnId)}
                                className="text-xs text-red-600 font-medium px-2 py-1 border border-red-200 rounded hover:bg-red-50"
                              >
                                Отменить
                              </button>
                            ) : (
                              <span className="text-xs text-gray-400">Выберите</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Плавающая панель заказа */}
      {activeOrdersCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] p-4 z-50">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div>
              <div className="font-semibold text-gray-800">Выбрано позиций: {activeOrdersCount}</div>
              <div className="text-sm text-gray-500">
                Общее количество: {Object.values(cart).reduce((sum, v) => sum + Number(v.quantity), 0)} меш
              </div>
            </div>
            <button 
              onClick={submitOrder}
              disabled={submitting}
              className="bg-blue-600 text-white px-8 py-3 rounded-xl font-semibold shadow-sm hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Отправка...' : 'Заказать'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
