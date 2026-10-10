/* Present so that the page can be installed as an app. It caches nothing and
   answers nothing itself: a terminal is live or it is nothing, and a stale
   page of this product would be worse than no page. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
