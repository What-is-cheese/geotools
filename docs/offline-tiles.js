// Tile arithmetic and OpenFreeMap's offline download limits. No DOM or network use.
(function(root){
  // https://openfreemap.org/tos/ allows offline downloads of at most 3,000 tiles or 50 MB, with at most 4 parallel requests.
  var LIMITS = {tiles:3000, bytes:50*1024*1024, parallel:4};
  var ZMIN = 5;   // lowest zoom stored, so a downloaded area still shows when zoomed out

  function lngX(lng, z){ return Math.floor((lng + 180)/360*Math.pow(2, z)); }
  function latY(lat, z){
    var r = lat*Math.PI/180, n = Math.pow(2, z);
    return Math.floor((1 - Math.log(Math.tan(r) + 1/Math.cos(r))/Math.PI)/2*n);
  }
  function clamp(v, max){ return Math.max(0, Math.min(max, v)); }
  // bb is {s, w, n, e} in degrees.
  function range(bb, z){
    var max = Math.pow(2, z) - 1;
    return {x0:clamp(lngX(bb.w, z), max), x1:clamp(lngX(bb.e, z), max), y0:clamp(latY(bb.n, z), max), y1:clamp(latY(bb.s, z), max)};
  }
  function count(bb, zmax){
    var c = 0;
    for(var z = ZMIN; z <= zmax; z++){ var r = range(bb, z); c += (r.x1 - r.x0 + 1)*(r.y1 - r.y0 + 1); }
    return c;
  }
  // Every tile of the area as "z/x/y". Call count() first: this allocates one string per tile.
  function list(bb, zmax){
    var out = [];
    for(var z = ZMIN; z <= zmax; z++){
      var r = range(bb, z);
      for(var x = r.x0; x <= r.x1; x++) for(var y = r.y0; y <= r.y1; y++) out.push(z + '/' + x + '/' + y);
    }
    return out;
  }
  // Up to n keys spread evenly over the list, used to estimate the download size.
  function sample(keys, n){
    if(keys.length <= n) return keys.slice();
    var out = [];
    for(var i = 0; i < n; i++) out.push(keys[Math.floor((i + 0.5)*keys.length/n)]);
    return out;
  }
  // Width and height in meters.
  function sizeOf(bb){
    var c = Math.cos((bb.s + bb.n)/2*Math.PI/180);
    return {w:(bb.e - bb.w)*c*111320, h:(bb.n - bb.s)*111132};
  }

  var api = {LIMITS:LIMITS, ZMIN:ZMIN, range:range, count:count, list:list, sample:sample, sizeOf:sizeOf};
  if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.GeoTiles = api;
})(this);
