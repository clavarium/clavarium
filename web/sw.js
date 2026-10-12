/* Present so that the page can be installed as an app. It caches nothing and
   answers nothing itself: a terminal is live or it is nothing, and a stale
   page of this product would be worse than no page.

   It also shows what this installation tells the device (something waits
   for its owner), and opens the right place when that is touched. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
    let said = {};
    try { said = event.data.json(); } catch { /* shown with its bare title */ }
    const url = typeof said.url === 'string' && said.url.startsWith('/') ? said.url : '/';
    event.waitUntil(self.registration.showNotification(String(said.title ?? 'Clavarium'), { body: String(said.body ?? ''), icon: '/icon-192.png', badge: '/icon-192.png', tag: url, data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
    event.waitUntil((async () => {
        const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of open) { if ('focus' in client) { await client.focus(); if ('navigate' in client) await client.navigate(url).catch(() => {}); return; } }
        await self.clients.openWindow(url);
    })());
});
