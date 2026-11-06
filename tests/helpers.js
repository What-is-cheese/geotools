// Test harness. Nothing here reaches the network: every non-local request is answered from fixtures, and a request
// that has no answer is recorded in fake.blocked so a test can fail on it. The real shared database is never touched.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), fix = path.join(__dirname, 'fixtures'), nm = path.join(root, 'node_modules');
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*, authorization, apikey, content-type, prefer, x-client-info, accept-profile, content-profile', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS,HEAD'};
const CDN = {
  'leaflet.min.css': 'leaflet/dist/leaflet.css', 'leaflet.min.js': 'leaflet/dist/leaflet.js', 'supabase.min.js': '@supabase/supabase-js/dist/umd/supabase.js',
  'maplibre-gl.mjs': 'maplibre-gl/dist/maplibre-gl.mjs', 'maplibre-gl-shared.mjs': 'maplibre-gl/dist/maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs': 'maplibre-gl/dist/maplibre-gl-worker.mjs', 'maplibre-gl.css': 'maplibre-gl/dist/maplibre-gl.css', 'leaflet-maplibre-gl.js': '@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js'
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A small street grid around 55.675, 12.57: nodes every 0.002 degrees, plus one trail and one building that blocks the middle.
function overpassRoads() {
  const els = [], id = (r, c) => 1000 + r*20 + c, la = r => 55.665 + r*0.002, lo = c => 12.55 + c*0.002;
  for (let r = 0; r < 12; r++) for (let d = 0; d < 2; d++) {
    const cells = [...Array(20).keys()].map(c => d ? [c, r] : [r, c]).filter(([a, b]) => a < 12 && b < 20);
    els.push({type: 'way', id: 1 + r*2 + d, tags: {highway: 'residential'}, nodes: cells.map(([a, b]) => id(a, b)), geometry: cells.map(([a, b]) => ({lat: la(a), lon: lo(b)}))});
  }
  return els;
}
function overpassObstacles() {
  const b = [[55.6745, 12.5695], [55.6745, 12.5725], [55.6755, 12.5725], [55.6755, 12.5695], [55.6745, 12.5695]];
  return [{type: 'way', id: 9001, tags: {building: 'yes'}, bounds: {minlat: 55.6745, minlon: 12.5695, maxlat: 55.6755, maxlon: 12.5725}, geometry: b.map(([lat, lon]) => ({lat, lon}))}];
}

function parse(url) {
  const u = new URL(url), eq = [], table = u.pathname.split('/').pop();
  u.searchParams.forEach((v, k) => { if (v.startsWith('eq.')) eq.push([k, v.slice(3).replace(/^"(.*)"$/, '$1')]); });
  return {table, eq, wantsRows: u.searchParams.has('select')};
}

async function install(context, opts = {}) {
  const fake = {
    db: {waypoints: (opts.points || []).map(p => ({...p})), links: []},
    blocked: [], tileRequests: 0, inFlight: 0, maxInFlight: 0, overpass: 'ok', overpassCalls: 0, tileDelay: 0, userAgents: new Set(), restWrites: 0
  };
  const match = (row, eq) => eq.every(([k, v]) => String(row[k]) === v);
  async function rest(route) {
    const q = route.request(), m = q.method(), {table, eq} = parse(q.url()), t = fake.db[table];
    const json = (status, body) => route.fulfill({status, headers: {...CORS, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    if (m === 'OPTIONS') return route.fulfill({status: 204, headers: CORS});
    if (!t) return json(404, {message: 'no table'});
    if (m === 'GET') return json(200, t.filter(r => match(r, eq)));
    fake.restWrites++;
    if (m === 'POST') {
      for (const r of [].concat(q.postDataJSON())) {
        if (t.some(x => x.id === r.id)) return json(409, {code: '23505', message: 'duplicate key'});
        if (table === 'links' && !(fake.db.waypoints.some(p => p.id === r.from_id) && fake.db.waypoints.some(p => p.id === r.to_id))) return json(409, {code: '23503', message: 'foreign key'});
        t.push(r);
      }
      return json(201, []);
    }
    const hit = t.filter(r => match(r, eq));
    if (m === 'PATCH') hit.forEach(r => Object.assign(r, q.postDataJSON()));
    if (m === 'DELETE') {
      fake.db[table] = t.filter(r => !hit.includes(r));
      if (table === 'waypoints') fake.db.links = fake.db.links.filter(l => !hit.some(h => h.id === l.from_id || h.id === l.to_id));
    }
    return json(200, hit);
  }
  async function ofm(route) {
    const u = new URL(route.request().url()), p = u.pathname, send = (body, type) => route.fulfill({status: 200, headers: {...CORS, 'content-type': type}, body});
    if (p === '/planet') return send(fs.readFileSync(fix + '/tilejson.json'), 'application/json');
    if (p.startsWith('/styles/')) return send(fs.readFileSync(fix + '/style.json'), 'application/json');
    if (p.startsWith('/sprites/')) {
      const name = 'sprite' + p.slice(p.lastIndexOf('/') + 1).replace(/^[^.@]*/, '');
      return send(fs.readFileSync(fix + '/sprites/' + name), name.endsWith('png') ? 'image/png' : 'application/json');
    }
    if (p.startsWith('/fonts/')) {
      const part = p.split('/'), file = fix + '/fonts/' + decodeURIComponent(part[2]) + '.pbf';
      return part[3] === '0-255.pbf' ? send(fs.readFileSync(file), 'application/x-protobuf') : route.fulfill({status: 404, headers: CORS});
    }
    const m = p.match(/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (m) {
      fake.tileRequests++; fake.inFlight++; fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
      if (fake.tileDelay) await new Promise(r => setTimeout(r, fake.tileDelay));
      else await new Promise(r => setTimeout(r, 15));
      fake.inFlight--;
      const file = `${fix}/tiles/${m[1]}-${m[2]}-${m[3]}.pbf`;
      return send(fs.readFileSync(fs.existsSync(file) ? file : fix + '/tiles/14-8763-5127.pbf'), 'application/x-protobuf').catch(() => {});
    }
    return route.fulfill({status: 404, headers: CORS});
  }
  await context.route(/^https?:\/\/(?!localhost)/, route => {
    if (fake.offline) return route.abort('internetdisconnected');
    const q = route.request(), u = new URL(q.url()), file = u.pathname.split('/').pop();
    if (u.hostname.endsWith('supabase.co')) {
      if (u.pathname.startsWith('/rest/')) return rest(route);
      return route.fulfill({status: 200, headers: CORS, body: '{}'});
    }
    if (u.hostname === 'tiles.openfreemap.org') return ofm(route);
    if (u.hostname.endsWith('tile.openstreetmap.org')) return route.fulfill({status: 200, headers: CORS, contentType: 'image/png', body: PNG});
    if (u.hostname === 'overpass-api.de') {
      fake.overpassCalls++;
      if (fake.overpass !== 'ok') return route.fulfill({status: 504, headers: CORS, body: 'busy'});
      const body = q.postData() || '', els = body.includes('building') ? overpassObstacles() : overpassRoads();
      return route.fulfill({status: 200, headers: {...CORS, 'content-type': 'application/json'}, body: JSON.stringify({elements: els})});
    }
    if (CDN[file]) return route.fulfill({status: 200, headers: CORS, contentType: file.endsWith('css') ? 'text/css' : 'application/javascript', body: fs.readFileSync(path.join(nm, CDN[file]))});
    fake.blocked.push(q.url());
    return route.abort();
  });
  // Minimal Phoenix channel, enough for supabase-js to report SUBSCRIBED.
  fake.sockets = [];
  await context.routeWebSocket(/supabase\.co\/realtime/, ws => {
    fake.sockets.push(ws);
    ws.onMessage(raw => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(raw);    // Phoenix v2 messages are arrays
      if (event === 'phx_join') {
        const cfg = (payload.config.postgres_changes || []).map((c, i) => ({...c, id: i + 1}));
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', {status: 'ok', response: {postgres_changes: cfg}}]));
        ws.send(JSON.stringify([joinRef, null, topic, 'system', {status: 'ok', extension: 'postgres_changes', channel: topic, message: 'subscribed'}]));
      } else ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', {status: 'ok', response: {}}]));
    });
  });
  return fake;
}

const POINTS = [
  {id: '11111111-1111-4111-8111-111111111111', name: 'North', lat: 55.6785, lng: 12.565, color: 'red'},
  {id: '22222222-2222-4222-8222-222222222222', name: 'South', lat: 55.671, lng: 12.575, color: 'blue'}
];

async function open(page, url = '/waypoints.html') {
  await page.addInitScript(() => {     // shortens the Overpass retry delays (5, 15, 45 s)
    const st = window.setTimeout;
    window.setTimeout = (fn, ms, ...a) => st(fn, [5000, 15000, 45000].includes(ms) ? 5 : ms, ...a);
  });
  await page.goto(url);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForFunction(() => document.getElementById('netStatus').textContent.includes('Connection'));
}
// Drags a rectangle over the middle of the map.
async function drawArea(page, from = [0.15, 0.15], to = [0.85, 0.85]) {
  await page.click('#dlBtn');
  const b = await page.locator('#map').boundingBox();
  await page.mouse.move(b.x + b.width*from[0], b.y + b.height*from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width*to[0], b.y + b.height*to[1], {steps: 5});
  await page.mouse.up();
}
async function download(page, name = 'Harbour') {
  await drawArea(page);
  await page.fill('#dlName', name);
  await page.waitForFunction(() => /about/.test(document.getElementById('dlEst').textContent) && !document.getElementById('dlStart').disabled);
  await page.click('#dlStart');
  await page.waitForFunction(n => document.getElementById('msg').textContent.includes(n), name, {timeout: 40000});
}
// Number of distinct colors in one part of the map, proving that something was actually drawn there.
// part is [from, to] as fractions of the map width.
async function mapColors(page, part = [0, 1]) {
  const b = await page.locator('#map').boundingBox();
  const shot = await page.screenshot({animations: 'disabled', clip: {x: b.x + b.width*part[0], y: b.y, width: b.width*(part[1] - part[0]), height: b.height}});
  return page.evaluate(async b64 => {
    const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data, seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(d[i] << 16 | d[i+1] << 8 | d[i+2]);
    return seen.size;
  }, shot.toString('base64'));
}
async function setNetwork(context, fake, on) {
  fake.offline = !on;
  await context.setOffline(!on);
  if (!on) fake.sockets.splice(0).forEach(ws => ws.close().catch(() => {}));
}
module.exports = {install, open, drawArea, download, mapColors, setNetwork, POINTS};
