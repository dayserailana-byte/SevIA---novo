/* Service worker mínimo: permite instalar o app. Não guarda dados em cache (sempre online). */
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(){});
