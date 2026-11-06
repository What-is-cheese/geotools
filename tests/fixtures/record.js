// Records the small set of real OpenFreeMap files the tests replay. Run by hand: node tests/fixtures/record.js
// Fetches about 30 files, well inside OpenFreeMap's offline limits. Tests never touch the network.
const fs = require('fs'), path = require('path');
const T = require('../../docs/offline-tiles.js');
const UA = {headers: {'User-Agent': 'GeoTools-test-fixture-recorder'}};
const dir = __dirname;
async function save(url, file) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
(async () => {
  const tj = await (await fetch('https://tiles.openfreemap.org/planet', UA)).json();
  fs.writeFileSync(dir + '/tilejson.json', JSON.stringify({tiles: tj.tiles}));
  const style = await (await fetch('https://tiles.openfreemap.org/styles/liberty', UA)).json();
  fs.writeFileSync(dir + '/style.json', JSON.stringify(style));
  for (const x of ['.json', '.png', '@2x.json', '@2x.png']) await save(style.sprite + x, dir + '/sprites/sprite' + x);
  for (const f of ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'])
    await save('https://tiles.openfreemap.org/fonts/' + encodeURIComponent(f) + '/0-255.pbf', dir + '/fonts/' + f + '.pbf');
  for (const k of T.list({s: 55.67, w: 12.56, n: 55.68, e: 12.58}, 14))
    await save(tj.tiles[0].replace('{z}/{x}/{y}', k), dir + '/tiles/' + k.replace(/\//g, '-') + '.pbf');
})();
