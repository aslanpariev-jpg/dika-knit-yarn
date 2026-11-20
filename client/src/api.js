const BASE = '/api';
const getToken = () => localStorage.getItem('token') || '';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    console.error('Ответ сервера:', data);
    throw new Error(data?.error || `Ошибка ${res.status}`);
  }
  return data;
}

export const api = {
  // auth
  getUsers: () => request('/users'),
  login: (userId, pin) => request('/login', { method: 'POST', body: JSON.stringify({ userId, pin }) }),
  loginKnitter: (userId) => request('/login-knitter', { method: 'POST', body: JSON.stringify({ userId }) }),
  me: () => request('/me'),

  // stock / yarns
  getStock: () => request('/stock'),
  getYarns: (q = '') => request(`/yarns?q=${encodeURIComponent(q)}`),

  // заказы вязальщика
  createOrder: (items, note) => request('/orders', { method: 'POST', body: JSON.stringify({ items, note }) }),
  getMyOrders: () => request('/orders/my'),
  cancelOrder: (id) => request(`/orders/${id}/cancel`, { method: 'POST' }),

  // корректировка в цеху
  adjustWorkshop: (yarnId, delta) => request('/workshop/adjust', { method: 'POST', body: JSON.stringify({ yarnId, delta }) }),

  // админ: пользователи
  adminUsers: () => request('/admin/users'),
  adminCreateUser: (body) => request('/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  adminResetPin: (id, pin) => request(`/admin/users/${id}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }),
  adminDeactivate: (id) => request(`/admin/users/${id}/deactivate`, { method: 'POST' }),
  adminResetTelegram: (id) => request(`/admin/users/${id}/reset-telegram`, { method: 'POST' }),

  // админ: пряжа
  adminCreateYarn: (body) => request('/admin/yarns', { method: 'POST', body: JSON.stringify(body) }),
  adminUpdateYarn: (id, body) => request(`/admin/yarns/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  adminUpdateYarnType: (id, type) => request(`/admin/yarns/${id}`, { method: 'PUT', body: JSON.stringify({ type }) }),
  adminDeleteYarn: (id) => request(`/admin/yarns/${id}`, { method: 'DELETE' }),

  // админ: приходы, заказы, отчёты
  adminReceipt: (body) => request('/admin/receipts', { method: 'POST', body: JSON.stringify(body) }),
  adminOrders: (status) => request(`/admin/orders${status ? `?status=${status}` : ''}`),
  adminCancelOrder: (id) => request(`/admin/orders/${id}/cancel`, { method: 'POST' }),
  adminReport: () => request('/admin/reports/stock', { method: 'POST' }),
};

export function saveAuth(token, user) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}
export function clearAuth() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}
export function getUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}