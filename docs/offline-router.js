// Offline routing: A* over a road and path network downloaded from OpenStreetMap. No DOM or network use.
(function(root){
  var KEEP = ['highway','oneway','oneway:bicycle','junction','access','foot','bicycle','vehicle','motor_vehicle','motorcar'];
  var NEVER = /^(proposed|construction|abandoned|razed|raceway|platform|bus_guideway|escape|rest_area|services)$/;
  var MOTORWAY = /^motorway/, FAST = /^(motorway|trunk)/;
  var CAR_KMH = {motorway:110, motorway_link:60, trunk:90, trunk_link:50, primary:70, primary_link:40, secondary:60, secondary_link:40,
    tertiary:50, tertiary_link:30, unclassified:40, residential:30, living_street:10, service:15, track:15};
  var TRAIL = /^(path|track|footway|bridleway|cycleway)$/;

  // profile: kind decides which ways are legal, kmh gives the speed, prefer scales the cost so a way is chosen more or less readily.
  var PROFILES = {
    car:{kind:'motorcar', oneway:true, kmh:function(h){ return CAR_KMH[h]; }, prefer:function(){ return 1; }},
    bike:{kind:'bicycle', oneway:true, kmh:function(h){ return h === 'footway' || h === 'steps' ? 6 : 16; }, prefer:function(){ return 1; }},
    foot:{kind:'foot', oneway:false, kmh:function(){ return 5; }, prefer:function(){ return 1; }},
    'crazy-bike':{kind:'bicycle', oneway:true, kmh:function(h){ return h === 'steps' ? 0 : 14; }, prefer:trails},
    'crazy-foot':{kind:'foot', oneway:false, kmh:function(){ return 4; }, prefer:trails}
  };
  function trails(h){
    if(TRAIL.test(h)) return 0.6;
    if(/^(primary|trunk)/.test(h)) return 4;
    if(/^secondary/.test(h)) return 2.5;
    return /^tertiary/.test(h) ? 1.5 : 1;
  }
  function allowed(t, p){
    var h = t.highway;
    if(!h || NEVER.test(h)) return false;
    if(p.kind === 'motorcar'){
      if(!CAR_KMH[h]) return false;
    } else if(MOTORWAY.test(h) || (p.kind === 'foot' && FAST.test(h))) return false;
    var own = t[p.kind];
    if(p.kind === 'motorcar') own = t.motorcar || t.motor_vehicle || t.vehicle;
    if(p.kind === 'bicycle') own = t.bicycle || t.vehicle;
    if(own) return own !== 'no' && own !== 'private';
    return t.access !== 'no' && t.access !== 'private';
  }

  // Reduces Overpass ways ("out body geom") to what routing needs, to keep the stored data small.
  function compact(elements){
    return elements.filter(function(e){ return e.type === 'way' && e.nodes && e.geometry && e.geometry.length === e.nodes.length; }).map(function(e){
      var t = {}, g = [];
      KEEP.forEach(function(k){ if(e.tags && e.tags[k] !== undefined) t[k] = e.tags[k]; });
      e.geometry.forEach(function(q){ g.push(+q.lat.toFixed(6), +q.lon.toFixed(6)); });
      return {n:e.nodes, g:g, t:t};
    });
  }

  function dist(alat, alng, blat, blng){
    var R = 6371008.8, r = Math.PI/180, dLa = (blat-alat)*r, dLo = (blng-alng)*r;
    var x = Math.sin(dLa/2)*Math.sin(dLa/2) + Math.cos(alat*r)*Math.cos(blat*r)*Math.sin(dLo/2)*Math.sin(dLo/2);
    return 2*R*Math.asin(Math.sqrt(x));
  }

  // Graph for one profile. adj[i] is a flat list: to, cost, meters, seconds, ...
  function build(ways, name){
    var p = PROFILES[name], index = new Map(), lat = [], lng = [], adj = [], maxRate = 0;
    function node(id, la, lo){
      var i = index.get(id);
      if(i === undefined){ i = lat.length; index.set(id, i); lat.push(la); lng.push(lo); adj.push([]); }
      return i;
    }
    ways.forEach(function(w){
      var t = w.t, h = t.highway; if(!allowed(t, p)) return;
      var kmh = p.kmh(h); if(!kmh) return;
      var ms = kmh/3.6, pref = p.prefer(h), rate = ms/pref, ow = t.oneway, fwd = true, back = true;
      if(p.oneway && !(p.kind === 'bicycle' && t['oneway:bicycle'] === 'no')){
        if(ow === 'yes' || ow === '1' || ow === 'true' || t.junction === 'roundabout' || (p.kind === 'motorcar' && MOTORWAY.test(h) && ow !== 'no')) back = false;
        if(ow === '-1') fwd = false;
      }
      if(rate > maxRate) maxRate = rate;
      var prev = -1;
      for(var k = 0; k < w.n.length; k++){
        var cur = node(w.n[k], w.g[2*k], w.g[2*k+1]);
        if(prev >= 0 && prev !== cur){
          var m = dist(lat[prev], lng[prev], lat[cur], lng[cur]), s = m/ms, c = m/rate;
          if(fwd) adj[prev].push(cur, c, m, s);
          if(back) adj[cur].push(prev, c, m, s);
        }
        prev = cur;
      }
    });
    return {lat:lat, lng:lng, adj:adj, maxRate:maxRate, main:mainComponent(adj)};
  }

  // Marks the largest connected network, so a point never snaps to an isolated fragment at the edge of the data.
  function mainComponent(adj){
    var n = adj.length, comp = new Int32Array(n).fill(-1), rev = adj.map(function(){ return []; }), best = -1, bestSize = 0, i, k;
    for(i = 0; i < n; i++) for(k = 0; k < adj[i].length; k += 4) rev[adj[i][k]].push(i);
    for(i = 0; i < n; i++){
      if(comp[i] >= 0) continue;
      var stack = [i], size = 0; comp[i] = i;
      while(stack.length){
        var v = stack.pop(); size++;
        for(k = 0; k < adj[v].length; k += 4){ var w = adj[v][k]; if(comp[w] < 0){ comp[w] = i; stack.push(w); } }
        for(k = 0; k < rev[v].length; k++){ var u = rev[v][k]; if(comp[u] < 0){ comp[u] = i; stack.push(u); } }
      }
      if(size > bestSize){ bestSize = size; best = i; }
    }
    var main = new Uint8Array(n);
    for(i = 0; i < n; i++) if(comp[i] === best) main[i] = 1;
    return main;
  }

  function nearest(g, q){
    var best = -1, bd = Infinity;
    for(var i = 0; i < g.lat.length; i++){
      if(!g.main[i]) continue;
      var d = dist(q.lat, q.lng, g.lat[i], g.lng[i]);
      if(d < bd){ bd = d; best = i; }
    }
    return {i:best, d:bd};
  }

  function search(g, s, t){
    var n = g.lat.length, G = new Float64Array(n).fill(Infinity), P = new Int32Array(n).fill(-1), done = new Uint8Array(n), hf = [], hi = [];
    function h(i){ return dist(g.lat[i], g.lng[i], g.lat[t], g.lng[t])/g.maxRate; }
    function sw(a, b){ var v = hf[a]; hf[a] = hf[b]; hf[b] = v; v = hi[a]; hi[a] = hi[b]; hi[b] = v; }
    function push(i, f){ var k = hf.length; hf.push(f); hi.push(i); while(k > 0){ var q = (k-1) >> 1; if(hf[q] <= hf[k]) break; sw(q, k); k = q; } }
    function pop(){
      var top = hi[0], lf = hf.pop(), li = hi.pop();
      if(hf.length){ hf[0] = lf; hi[0] = li; var k = 0;
        for(;;){ var l = 2*k+1, r = l+1, m = k; if(l < hf.length && hf[l] < hf[m]) m = l; if(r < hf.length && hf[r] < hf[m]) m = r; if(m === k) break; sw(m, k); k = m; } }
      return top;
    }
    G[s] = 0; push(s, h(s));
    while(hf.length){
      var i = pop(); if(done[i]) continue; done[i] = 1; if(i === t) break;
      var a = g.adj[i];
      for(var k = 0; k < a.length; k += 4){
        var j = a[k], ng = G[i] + a[k+1];
        if(ng < G[j]){ G[j] = ng; P[j] = i; push(j, ng + h(j)); }
      }
    }
    if(!done[t]) return null;
    var path = []; for(var v = t; v !== -1; v = P[v]) path.push(v);
    return path.reverse();
  }

  // pts: [{lat, lng}, ...], visited in order. Returns {distance, duration, line} or {error, point}; point is the index of the
  // waypoint the error concerns. maxSnap is how far (m) a point may lie from the network.
  function route(g, pts, maxSnap, walkMs){
    if(!g.lat.length) return {error:'empty'};
    var ends = [], line = [], meters = 0, secs = 0, i;
    for(i = 0; i < pts.length; i++){
      var e = nearest(g, pts[i]);
      if(e.i < 0 || e.d > maxSnap) return {error:'snap', point:i};
      ends.push(e);
    }
    for(i = 0; i < pts.length - 1; i++){
      var a = ends[i], b = ends[i+1], path = search(g, a.i, b.i);
      if(!path) return {error:'noroute', point:i};
      line.push([pts[i].lat, pts[i].lng]);
      meters += a.d + b.d; secs += (a.d + b.d)/walkMs;
      for(var k = 0; k < path.length; k++){
        var v = path[k]; line.push([g.lat[v], g.lng[v]]);
        if(k + 1 < path.length){
          var ed = g.adj[v];
          for(var q = 0; q < ed.length; q += 4) if(ed[q] === path[k+1]){ meters += ed[q+2]; secs += ed[q+3]; break; }
        }
      }
    }
    var last = pts[pts.length-1]; line.push([last.lat, last.lng]);
    return {distance:meters, duration:secs, line:line};
  }

  var api = {compact:compact, build:build, route:route, PROFILES:PROFILES};
  if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.GeoRouter = api;
})(this);
