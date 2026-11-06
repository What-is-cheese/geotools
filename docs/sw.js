// Keeps the app itself available offline. Downloaded maps and waypoints are in IndexedDB, not here.
// Bump VERSION when CDN changes. CDN must list the same URLs as waypoints.html.
var VERSION = 'v1', CACHE = 'geotools-' + VERSION, TIMEOUT = 5000;
var LOCAL = ['waypoints.html', 'offline-tiles.js', 'offline-store.js', 'offline-router.js', 'offline-sync.js'];
var CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.93.0/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl-shared.mjs',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl-worker.mjs',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.css',
  'https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js'
];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return c.addAll(LOCAL.concat(CDN.map(function(u){ return new Request(u, {mode:'cors'}); })));
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf('geotools-') === 0 && k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

// Network first, so updates arrive. A slow connection falls back to the cache after TIMEOUT.
function fresh(req, fallback){
  return caches.open(CACHE).then(function(c){
    return new Promise(function(ok, no){
      var settled = false;
      function useCache(){
        if(settled) return; settled = true;
        c.match(fallback || req, {ignoreSearch:true}).then(function(m){ return m ? ok(m) : no(new Error('not cached')); });
      }
      var t = setTimeout(useCache, TIMEOUT);
      fetch(req).then(function(r){
        clearTimeout(t);
        if(r.ok) c.put(fallback || req, r.clone());
        if(!settled){ settled = true; ok(r); }
      }, function(){ clearTimeout(t); useCache(); });
    });
  });
}

self.addEventListener('fetch', function(e){
  var req = e.request, url = new URL(req.url);
  if(req.method !== 'GET') return;
  var bare = url.origin + url.pathname;     // MapLibre adds ?v=... to its worker URL
  if(CDN.indexOf(bare) >= 0){
    e.respondWith(caches.match(bare).then(function(m){ return m || fetch(req); }));
    return;
  }
  if(url.origin !== self.location.origin) return;
  var file = url.pathname.split('/').pop();
  if(req.mode === 'navigate') e.respondWith(fresh(req, 'waypoints.html'));
  else if(LOCAL.indexOf(file) >= 0) e.respondWith(fresh(req));
});
