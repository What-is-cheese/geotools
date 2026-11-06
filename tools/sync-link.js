// Encrypts the Supabase details into docs/waypoints.html and prints the invite link. Run it yourself; the output is a secret.
//   node tools/sync-link.js https://what-is-cheese.github.io/geotools/waypoints.html
// Every run makes a new key, so older invite links stop working.
const fs = require('fs'), path = require('path'), readline = require('readline');
const link = require('../docs/sync-link.js');
const page = path.join(__dirname, '..', 'docs', 'waypoints.html');
(async () => {
  const site = process.argv[2] || 'http://localhost:8000/waypoints.html';
  const lines = readline.createInterface({input: process.stdin})[Symbol.asyncIterator]();
  const ask = async text => { process.stdout.write(text); const r = await lines.next(); return (r.value || '').trim(); };
  const url = await ask('Supabase project URL: ');
  const key = await ask('Supabase publishable key: ');
  if (!/^https:\/\//.test(url) || !key) throw new Error('Both values are required.');
  const secret = link.newKey(), blob = await link.encrypt({url, key}, secret);
  const html = fs.readFileSync(page, 'utf8'), next = html.replace(/var SYNC_CONFIG = '[^']*';/, `var SYNC_CONFIG = '${blob}';`);
  if (next === html) throw new Error('SYNC_CONFIG was not found in waypoints.html.');
  fs.writeFileSync(page, next);
  process.stdin.pause();
  console.log('\nUpdated docs/waypoints.html. Commit and deploy it, then share this link privately:\n\n' + site + '#k=' + secret + '\n');
})().catch(e => { console.error(e.message); process.exit(1); });
