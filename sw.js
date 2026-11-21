/* SevIA SST 4.0 — service worker: abre o sistema sem internet.
 * Telas do sistema: rede primeiro (sempre a versão nova quando há sinal), cópia guardada quando não há.
 * Bibliotecas (versões fixas): cópia guardada primeiro. Dados e fotos (Supabase) nunca passam por aqui. */
var V = 'sevia-v2';
var LOCAL = ['/', '/login', '/config.js', '/sevia-supabase.js', '/manifest.webmanifest', '/icon-192.png'];
var CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/docx@9.8.1/dist/index.iife.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];
function guarda(c, req) {
  return fetch(req).then(function (r) { if (r && (r.ok || r.type === 'opaque') && !r.redirected) return c.put(req, r); }).catch(function () {});
}
self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(function (c) {
    return Promise.all(LOCAL.map(function (u) { return guarda(c, new Request(u, { cache: 'reload' })); })
      .concat(CDN.map(function (u) { return guarda(c, new Request(u, { mode: 'no-cors' })); })));
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (m) {
      var rede = fetch(req).then(function (r) {
        if (r && r.ok && !r.redirected) { var cp = r.clone(); caches.open(V).then(function (c) { c.put(req, cp); }); }
        return r;
      });
      if (!m) {
        return rede.catch(function () {
          if (req.mode === 'navigate') return caches.match(/login/.test(url.pathname) ? '/login' : '/');
          return Response.error();
        });
      }
      /* sinal fraco: depois de 4 s usa a cópia guardada; a versão nova continua baixando para a próxima vez */
      return Promise.race([rede, new Promise(function (res) { setTimeout(function () { res(m); }, 4000); })]).catch(function () { return m; });
    }));
    return;
  }
  if (CDN.indexOf(req.url) > -1) {
    e.respondWith(caches.match(req).then(function (m) {
      return m || fetch(req).then(function (r) { var cp = r.clone(); caches.open(V).then(function (c) { c.put(req, cp); }); return r; });
    }));
  }
});
