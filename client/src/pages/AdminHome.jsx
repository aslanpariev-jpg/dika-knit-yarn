import { Link } from 'react-router-dom';

export default function AdminHome() {
  const links = [
    { to: '/admin/users', title: 'Пользователи', desc: 'Грузчики, вязальщики, PIN, Telegram' },
    { to: '/admin/yarns', title: 'Пряжа', desc: 'Справочник артикулов' },
    { to: '/admin/stock', title: 'Остатки и приход', desc: 'Приход на дом/склад, отчёт в Discord' },
    { to: '/admin/orders', title: 'Заказы', desc: 'Что заказали вязальщики, статусы доставки' },
  ];
  return (
    <div className="p-4 max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-4">Админ</h1>
      <div className="space-y-3">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="block bg-white rounded-xl p-4 border active:bg-gray-50"
          >
            <div className="font-semibold text-gray-800">{l.title}</div>
            <div className="text-sm text-gray-500 mt-1">{l.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}