// Outbox for shared waypoint changes. Every change is queued on the device first, so online and offline edits take the same path.
// No schema change is needed to avoid overwriting other users: an update or delete only applies while the row still holds the
// value this device last saw (compare-and-swap). When it doesn't, the other user's change wins and a conflict is reported.
//   {uid, t:'insert', row}
//   {uid, t:'link', row:{id, from_id, to_id}}
//   {uid, t:'update', id, field, value, base}
//   {uid, t:'delete', id, base:{name, color}}
(function(root){
  var COLS = 'id,name,lat,lng,color';

  // Adds op to the queue, merging it with earlier changes to the same waypoint. Pure: returns a new array.
  function coalesce(queue, op){
    var q = queue.slice(), i;
    function find(fn){ for(var k = 0; k < q.length; k++) if(fn(q[k])) return k; return -1; }
    if(op.t === 'update'){
      i = find(function(o){ return o.t === 'insert' && o.row.id === op.id; });
      if(i >= 0){ var row = Object.assign({}, q[i].row); row[op.field] = op.value; q[i] = Object.assign({}, q[i], {row:row}); return q; }
      i = find(function(o){ return o.t === 'update' && o.id === op.id && o.field === op.field; });
      if(i < 0){ q.push(op); return q; }
      if(q[i].base === op.value) q.splice(i, 1);     // back to what the server has: nothing to send
      else q[i] = Object.assign({}, q[i], {value:op.value});
      return q;
    }
    if(op.t === 'delete'){
      var created = find(function(o){ return o.t === 'insert' && o.row.id === op.id; }) >= 0;
      var base = Object.assign({}, op.base);
      q.forEach(function(o){ if(o.t === 'update' && o.id === op.id) base[o.field] = o.base; });
      q = q.filter(function(o){
        if(o.t === 'insert' || o.t === 'update') return (o.id || o.row.id) !== op.id;
        return !(o.t === 'link' && (o.row.from_id === op.id || o.row.to_id === op.id));
      });
      if(!created) q.push(Object.assign({}, op, {base:base}));
      return q;
    }
    q.push(op);
    return q;
  }

  function transient(r){ return !r.status || r.status === 408 || r.status === 429 || r.status >= 500; }

  // opts: client() gives the Supabase client or null; load() and save(fn) read and atomically update the stored queue;
  // uid() makes ids; onChange() runs when the queue changes; onConflict(text) reports a change that was not applied.
  function create(opts){
    var queue = [], running = false, again = false, api;
    function change(fn){
      return opts.save(fn).then(function(q){ queue = q; opts.onChange(); });
    }
    function drop(op){ return change(function(q){ return (q || []).filter(function(o){ return o.uid !== op.uid; }); }); }

    // Resolves to true when the op is finished (applied, or rejected for good) and false to retry later.
    function run(op, db){
      if(op.t === 'insert' || op.t === 'link'){
        return db.from(op.t === 'insert' ? 'waypoints' : 'links').insert(op.row).then(function(r){
          if(!r.error || r.error.code === '23505') return true;     // 23505: already saved by another tab
          if(transient(r)) return false;
          if(op.t === 'link' && r.error.code === '23503') opts.onConflict('A line could not be saved because another user deleted one of its waypoints.');
          else opts.onConflict('A change could not be saved (' + r.error.message + ').');
          return true;
        });
      }
      var q = op.t === 'update'
        ? db.from('waypoints').update(field(op)).eq('id', op.id).eq(op.field, op.base).select('id')
        : db.from('waypoints').delete().eq('id', op.id).eq('name', op.base.name).eq('color', op.base.color).select('id');
      return q.then(function(r){
        if(r.error){
          if(transient(r)) return false;
          opts.onConflict('A change could not be saved (' + r.error.message + ').');
          return true;
        }
        if(r.data && r.data.length) return true;
        return db.from('waypoints').select(COLS).eq('id', op.id).maybeSingle().then(function(c){
          if(c.error) return transient(c) ? false : true;
          conflict(op, c.data);
          return true;
        });
      });
    }
    function field(op){ var o = {}; o[op.field] = op.value; return o; }
    function conflict(op, row){
      if(op.t === 'delete'){
        if(row) opts.onConflict('"' + row.name + '" was not deleted because another user changed it first.');
      } else if(!row) opts.onConflict('Your change to the ' + op.field + ' "' + op.base + '" was not saved because another user deleted that waypoint.');
      else if(row[op.field] !== op.value) opts.onConflict('Your ' + op.field + ' "' + op.value + '" was not saved because another user changed it to "' + row[op.field] + '" first.');
    }

    function drain(){
      var db = opts.client(); if(!db) return Promise.resolve();
      return opts.save(function(q){ return q || []; }).then(function(q){
        queue = q; opts.onChange();
        if(!q.length) return;
        return run(q[0], db).then(function(done){ if(done) return drop(q[0]).then(drain); }, function(){});   // a rejected call counts as offline
      });
    }
    function flush(){
      if(running){ again = true; return Promise.resolve(); }
      running = true;
      var work = root.navigator && navigator.locks ? navigator.locks.request('geotools-sync', drain) : drain();   // one tab at a time
      return work.then(finish, finish);
    }
    function finish(){
      running = false;
      if(again){ again = false; return flush(); }
    }
    api = {
      load:function(){ return opts.save(function(q){ return q || []; }).then(function(q){ queue = q; opts.onChange(); }); },
      add:function(op){
        op.uid = opts.uid();
        return change(function(q){ return coalesce(q || [], op); });
      },
      flush:flush,
      count:function(){ return queue.length; },
      // True if this waypoint has changes that have not reached the server.
      waiting:function(id){
        return queue.some(function(o){ return o.id === id || (o.row && (o.row.id === id)); });
      },
      created:function(id){ return queue.some(function(o){ return o.t === 'insert' && o.row.id === id; }); },
      links:function(){ return queue.filter(function(o){ return o.t === 'link'; }).map(function(o){ return o.row; }); },
      // A server row with this device's waiting changes on top, or null if it is waiting to be deleted.
      overlay:function(row){
        if(queue.some(function(o){ return o.t === 'delete' && o.id === row.id; })) return null;
        var out = Object.assign({}, row);
        queue.forEach(function(o){ if(o.t === 'update' && o.id === row.id) out[o.field] = o.value; });
        return out;
      }
    };
    return api;
  }

  var api = {create:create, coalesce:coalesce};
  if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.GeoSync = api;
})(this);
