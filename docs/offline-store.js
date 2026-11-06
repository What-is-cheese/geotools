// IndexedDB storage for downloaded maps and offline waypoint data.
//   tiles: {k:'z/x/y', d:ArrayBuffer, a:[area ids]}  a tile shared by overlapping areas is stored once
//   areas: {id, name, bb, zmax, status, bytes, tiles, roads, obstacles, date}
//   geo:   {k:'<area id>:roads' | '<area id>:obstacles', d:...}
//   kv:    {k, v}  style, sprites, fonts, cached waypoints and the sync outbox
(function(root){
  var DB = 'geotools-offline', dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise(function(ok, no){
      var q = indexedDB.open(DB, 1);
      q.onupgradeneeded = function(){
        var d = q.result;
        d.createObjectStore('tiles', {keyPath:'k'}).createIndex('area', 'a', {multiEntry:true});
        d.createObjectStore('areas', {keyPath:'id'});
        d.createObjectStore('geo', {keyPath:'k'});
        d.createObjectStore('kv', {keyPath:'k'});
      };
      q.onsuccess = function(){ ok(q.result); };
      q.onerror = function(){ dbp = null; no(q.error); };
    });
    return dbp;
  }
  // Runs fn(store, tx) in one transaction. The promise gives fn's result once the transaction has committed.
  function tx(names, mode, fn){
    return open().then(function(d){
      return new Promise(function(ok, no){
        var t = d.transaction(names, mode), out;
        t.oncomplete = function(){ ok(out && 'result' in out ? out.result : out); };
        t.onerror = t.onabort = function(){ no(t.error); };
        out = fn(t.objectStore(names), t);
      });
    });
  }
  function get(name, key){ return tx(name, 'readonly', function(s){ return s.get(key); }); }
  function put(name, value){ return tx(name, 'readwrite', function(s){ s.put(value); }); }
  function del(name, key){ return tx(name, 'readwrite', function(s){ s.delete(key); }); }
  function all(name){ return tx(name, 'readonly', function(s){ return s.getAll(); }); }

  function getKV(k){ return get('kv', k).then(function(r){ return r ? r.v : undefined; }); }
  function setKV(k, v){ return put('kv', {k:k, v:v}); }
  // Atomic read-modify-write, safe when several tabs are open. fn receives the value and returns the new one.
  function updateKV(k, fn){
    var next;
    return tx('kv', 'readwrite', function(s){
      var q = s.get(k);
      q.onsuccess = function(){ next = fn(q.result ? q.result.v : undefined); s.put({k:k, v:next}); };
    }).then(function(){ return next; });
  }

  function putTile(k, d, areaId){
    return tx('tiles', 'readwrite', function(s){
      var q = s.get(k);
      q.onsuccess = function(){
        var a = q.result ? q.result.a : [];
        if(a.indexOf(areaId) < 0) a.push(areaId);
        s.put({k:k, d:d, a:a});
      };
    });
  }
  function getTile(k){ return get('tiles', k).then(function(r){ return r ? r.d : null; }); }
  // Removes the area and its data. Tiles that another area also uses stay.
  function deleteArea(id){
    return tx('tiles', 'readwrite', function(s){
      s.index('area').openCursor(IDBKeyRange.only(id)).onsuccess = function(e){
        var c = e.target.result; if(!c) return;
        var r = c.value; r.a = r.a.filter(function(x){ return x !== id; });
        if(r.a.length) c.update(r); else c.delete();
        c.continue();
      };
    }).then(function(){ return del('geo', id + ':roads'); })
      .then(function(){ return del('geo', id + ':obstacles'); })
      .then(function(){ return del('areas', id); });
  }

  root.GeoStore = {get:get, put:put, del:del, all:all, getKV:getKV, setKV:setKV, updateKV:updateKV,
    putTile:putTile, getTile:getTile, deleteArea:deleteArea};
})(this);
