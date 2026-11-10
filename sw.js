// Офлайн-кэш + пуш-уведомления (вибро на заблокированном экране).
// Кэш: сразу отдаём из кэша, в фоне обновляем — новая версия видна со следующего открытия.
const CACHE = 'practice-v7';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const PUSH_TEXT = {
  walk_end: { title: 'Ходьба окончена', body: 'Садись — сидячая часть' },
  end: { title: 'Практика окончена', body: 'Время благодарности' },
  test: { title: 'Проверка вибро', body: 'Уведомления работают' },
};
const PUSH_FALLBACK = { title: 'Практика', body: 'Следующий этап' };

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

// Пуш приходит без содержимого: какой это этап, спрашиваем у сервера.
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msg = PUSH_FALLBACK;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch('/api/push/last', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        if (r.ok) { const { tag } = await r.json(); msg = PUSH_TEXT[tag] || PUSH_FALLBACK; }
      }
    } catch (err) { /* без сети — общий текст */ }
    await self.registration.showNotification(msg.title, {
      body: msg.body, tag: 'practice', renotify: true, silent: false,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: [300, 150, 300, 150, 600],
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./');
  })());
});
