const {test, expect, chromium} = require('@playwright/test');
const os = require('os'), fs = require('fs'), path = require('path');
const {SECRET, install, open, drawArea, download, mapColors, setNetwork, POINTS} = require('./helpers');

let fake;
test.beforeEach(async ({context, page}) => {
  fake = await install(context, {points: POINTS});
  page.on('dialog', d => d.accept());
  await open(page);
  await expect(page.locator('#list li')).toHaveCount(2);
});
test.afterEach(() => { expect(fake.blocked).toEqual([]); });

const offline = async (context, page) => {
  await setNetwork(context, fake, false);
  await expect(page.locator('#netStatus')).toContainText('Offline');
};
const reloadOffline = async (context, page) => {
  await setNetwork(context, fake, false);
  await page.reload();
  await expect(page.locator('#netStatus')).toContainText('Offline');
  await expect(page.locator('#list li')).toHaveCount(2);
};
const selectInList = (page, name) => page.locator('#list button', {hasText: name}).click();
async function planRoute(page, rmode, mode = 'foot') {
  await page.selectOption('#rModeSel', rmode);
  await page.selectOption('#rMode', mode);
  const sel = page.locator('#rPlan select');
  await sel.first().selectOption({label: 'North'});
  await page.locator('#rPlan select').last().selectOption({label: 'South'});
  await page.click('#rCreate');
}

test.describe('downloading', () => {
  test('rectangle, size estimate, detail level, then progress and saving', async ({page}) => {
    await drawArea(page);
    await expect(page.locator('#dlEst')).toContainText(/\d+ map tiles, about [\d.]+ (KB|MB)/);
    const at14 = parseInt(await page.locator('#dlEst').textContent());
    await page.selectOption('#dlZoom', '12');
    await expect(page.locator('#dlEst')).toContainText('about');
    expect(parseInt(await page.locator('#dlEst').textContent())).toBeLessThan(at14);
    await page.selectOption('#dlZoom', '14');
    await expect(page.locator('#dlEst')).toContainText('about');

    fake.tileDelay = 250;
    await page.fill('#dlName', 'Harbour');
    await page.click('#dlStart');
    await expect(page.locator('#dlProg')).toBeVisible();
    await expect(page.locator('#dlProgText')).toContainText(/\d+ of \d+ map tiles/);
    await expect(page.locator('#msg')).toContainText('"Harbour" was downloaded', {timeout: 30000});
    expect(fake.maxInFlight).toBeLessThanOrEqual(4);
    await expect(page.locator('#areaList')).toContainText('Routing data: Downloaded');
    await expect(page.locator('#areaList')).toContainText('Obstacle data: Downloaded');
    await expect(page.locator('#areaList')).toContainText('Download size:');
    await expect(page.locator('#storeInfo')).toContainText('Available storage:');
    await expect(page.locator('#dlBox')).toBeHidden();
  });

  test('an area over the tile limit cannot be started', async ({page}) => {
    for (let i = 0; i < 4; i++) { await page.click('.leaflet-control-zoom-out'); await page.waitForTimeout(350); }
    await drawArea(page);
    await expect(page.locator('#dlEst')).toContainText('The limit is 50.0 MB');     // size limit first
    await expect(page.locator('#dlStart')).toBeDisabled();
    await page.click('#dlCancel');
    for (let i = 0; i < 2; i++) { await page.click('.leaflet-control-zoom-out'); await page.waitForTimeout(350); }
    await drawArea(page);
    await expect(page.locator('#dlEst')).toContainText('The limit is 3000');
    await expect(page.locator('#dlStart')).toBeDisabled();
  });

  test('a wide area explains that routing data is left out', async ({page}) => {
    for (let i = 0; i < 4; i++) { await page.click('.leaflet-control-zoom-out'); await page.waitForTimeout(350); }
    await drawArea(page, [0.02, 0.02], [0.98, 0.98]);
    await page.selectOption('#dlZoom', '10');
    await expect(page.locator('#dlGeoNote')).toContainText('Routing and obstacle data can only');
    await expect(page.locator('#dlRoads')).toBeDisabled();
  });

  test('cancelling removes the partial download', async ({page}) => {
    await drawArea(page);
    await expect(page.locator('#dlEst')).toContainText('about');
    fake.tileDelay = 300;
    await page.click('#dlStart');
    await expect(page.locator('#dlProgText')).toContainText('of');
    await page.click('#dlCancel');
    await expect(page.locator('#msg')).toContainText('cancelled');
    await expect(page.locator('#areaList')).toContainText('No downloaded maps');
    const left = await page.evaluate(() => GeoStore.all('tiles').then(t => t.length));
    expect(left).toBe(0);
  });

  test('failed Overpass data keeps the tiles and can be retried', async ({page}) => {
    fake.overpass = 'busy';
    await download(page);
    await expect(page.locator('#msg')).toContainText('routing or obstacle data was not');
    await expect(page.locator('#areaList')).toContainText('Map: Downloaded');
    await expect(page.locator('#areaList')).toContainText('Routing data: Failed');
    expect(fake.overpassCalls).toBe(8);     // 4 tries each
    fake.overpass = 'ok';
    await page.getByRole('button', {name: 'Download map again'}).click();
    await expect(page.locator('#areaList')).toContainText('Routing data: Downloaded', {timeout: 30000});
  });

  test('a failed retry does not lose routing data that was already good', async ({page}) => {
    await download(page);
    fake.overpass = 'busy';
    const calls = fake.overpassCalls;
    await page.getByRole('button', {name: 'Download map again'}).click();
    await expect.poll(() => fake.overpassCalls, {timeout: 30000}).toBe(calls + 8);
    await expect(page.locator('#dlBox')).toBeHidden({timeout: 30000});
    await expect(page.locator('#areaList')).toContainText('Routing data: Downloaded');
  });

  test('several areas; deleting one keeps tiles shared with the other', async ({page}) => {
    await download(page, 'One');
    await page.click('.leaflet-control-zoom-in'); await page.waitForTimeout(350);
    await download(page, 'Two');
    await expect(page.locator('#areaList > li')).toHaveCount(2);
    const before = await page.evaluate(() => GeoStore.all('tiles').then(t => t.filter(x => x.a.length === 2).length));
    expect(before).toBeGreaterThan(0);
    await page.locator('#areaList > li', {hasText: 'Two'}).getByText('Delete downloaded map').click();
    await expect(page.locator('#areaList > li')).toHaveCount(1);
    const tiles = await page.evaluate(() => GeoStore.all('tiles'));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every(t => t.a.length === 1)).toBe(true);
    await page.getByText('Delete downloaded map').click();
    await expect(page.locator('#areaList')).toContainText('No downloaded maps');
    expect(await page.evaluate(() => GeoStore.all('tiles').then(t => t.length))).toBe(0);
    expect(await page.evaluate(() => GeoStore.all('geo').then(t => t.length))).toBe(0);
  });
});

test.describe('offline use', () => {
  test('the app opens with no network and draws the downloaded map', async ({context, page}) => {
    await download(page);
    await reloadOffline(context, page);
    await expect(page.locator('#map canvas')).toHaveCount(1, {timeout: 15000});
    await expect.poll(() => mapColors(page, [0, 0.4]), {timeout: 20000}).toBeGreaterThan(200);    // both sides drawn, not just the first tile
    await expect.poll(() => mapColors(page, [0.6, 1]), {timeout: 20000}).toBeGreaterThan(200);
    await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenFreeMap');
    await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
    await expect(page.locator('#list')).toContainText('North');
    await expect(page.locator('#list')).toContainText('55.678500, 12.565000');
    expect(await page.locator('.pt').count()).toBe(2);
    expect(await page.locator('.pt').first().getAttribute('style')).toContain('background');
    // zoom and pan
    await page.click('.leaflet-control-zoom-in');
    await page.waitForTimeout(600);
    const b = await page.locator('#map').boundingBox();
    await page.mouse.move(b.x + 200, b.y + 200); await page.mouse.down();
    await page.mouse.move(b.x + 120, b.y + 140, {steps: 4}); await page.mouse.up();
    await expect.poll(() => mapColors(page), {timeout: 20000}).toBeGreaterThan(200);
  });

  test('going offline while open switches the map without a reload', async ({context, page}) => {
    await download(page);
    await offline(context, page);
    await expect(page.locator('#map canvas')).toHaveCount(1, {timeout: 15000});
    await setNetwork(context, fake, true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#netStatus')).toContainText('Online');
    await expect(page.locator('#map canvas')).toHaveCount(0);
  });

  test('offline with no downloads says so', async ({context, page}) => {
    await reloadOffline(context, page);
    await expect(page.locator('#netStatus')).toContainText('No downloaded maps');
    await page.click('#dlBtn');
    await expect(page.locator('#msg')).toContainText('needs an internet connection');
  });

  test('Bird Mode needs no downloaded data', async ({context, page}) => {
    await reloadOffline(context, page);
    await planRoute(page, 'bird');
    await expect(page.locator('#rInfo')).toContainText('Distance:');
  });

  test('Crazy and Normal modes route from downloaded data', async ({context, page}) => {
    await download(page);
    await reloadOffline(context, page);
    await planRoute(page, 'crazy');
    await expect(page.locator('#rInfo')).toContainText('Calculated offline');
    await expect(page.locator('#rErr')).toHaveText('');
    await planRoute(page, 'normal', 'car');
    await expect(page.locator('#rInfo')).toContainText('Calculated offline');
    await expect(page.locator('#rErr')).toHaveText('');
  });

  test('Avoid Obstacles routes around downloaded obstacles', async ({context, page}) => {
    await download(page);
    await reloadOffline(context, page);
    await planRoute(page, 'avoid');
    await expect(page.locator('#rInfo')).toContainText('Distance:');
    await expect(page.locator('#rErr')).toHaveText('');
  });

  test('routing without downloaded data gives a clear message', async ({context, page}) => {
    await page.click('#dlBtn'); await page.click('#dlCancel');
    await drawArea(page);
    await page.uncheck('#dlRoads'); await page.uncheck('#dlObst');
    await page.fill('#dlName', 'TilesOnly');
    await expect(page.locator('#dlEst')).toContainText('about');
    await page.click('#dlStart');
    await expect(page.locator('#msg')).toContainText('was downloaded');
    await reloadOffline(context, page);
    await planRoute(page, 'crazy');
    await expect(page.locator('#rErr')).toContainText('needs routing data');
    await page.selectOption('#rModeSel', 'avoid');
    await page.click('#rCreate');
    await expect(page.locator('#rErr')).toContainText('needs obstacle data');
  });
});

test.describe('offline changes', () => {
  async function addFromLocation(context, page, name) {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({latitude: 55.675, longitude: 12.57});
    await page.click('#gpsBtn');
    await page.fill('#gpsName', name);
    await page.click('#gpsForm button[type=submit]');
  }
  async function rename(page, from, to) {
    await selectInList(page, from);
    await page.getByRole('button', {name: 'Edit name'}).click();
    await page.fill('#eName', to);
    await page.click('#editForm button[type=submit]');
  }
  const back = async (context, page) => {
    await expect(page.locator('#netStatus')).toContainText('waiting to synchronize');
    await setNetwork(context, fake, true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#netStatus')).toContainText('All synchronized');
  };

  test('new, renamed and recolored waypoints wait, then sync', async ({context, page}) => {
    await offline(context, page);
    await addFromLocation(context, page, 'Camp');
    await rename(page, 'North', 'Peak');
    await page.getByRole('button', {name: 'Change color'}).click();
    await page.selectOption('#cColor', 'green');
    await page.click('#colorForm button[type=submit]');
    await expect(page.locator('#netStatus')).toContainText('3 waiting to synchronize');
    await expect(page.locator('#list')).toContainText('Camp');
    await expect(page.locator('#list li', {hasText: 'Peak'})).toContainText('waiting to synchronize');
    await expect(page.locator('#selInfo')).toContainText('Waiting to synchronize');
    expect(fake.restWrites).toBe(0);

    await back(context, page);
    await expect(page.locator('#list')).not.toContainText('waiting');
    const db = fake.db.waypoints;
    expect(db.map(p => p.name).sort()).toEqual(['Camp', 'Peak', 'South']);
    expect(db.find(p => p.name === 'Peak').color).toBe('green');
  });

  test('offline changes survive closing the page before they sync', async ({context, page}) => {
    await offline(context, page);
    await rename(page, 'South', 'Harbor');
    await expect(page.locator('#netStatus')).toContainText('1 waiting');
    await page.reload();
    await expect(page.locator('#netStatus')).toContainText('1 waiting');
    await expect(page.locator('#list')).toContainText('Harbor');
    await back(context, page);
    expect(fake.db.waypoints.map(p => p.name)).toContain('Harbor');
  });

  test('another user edit is not overwritten', async ({context, page}) => {
    await offline(context, page);
    await rename(page, 'North', 'Mine');
    fake.db.waypoints.find(p => p.name === 'North').name = 'Theirs';
    await back(context, page);
    await expect(page.locator('#syncNotes')).toContainText('Your name "Mine" was not saved');
    await expect(page.locator('#syncNotes')).toContainText('Theirs');
    await expect(page.locator('#list')).toContainText('Theirs');
    expect(fake.db.waypoints.map(p => p.name)).toContain('Theirs');
    expect(fake.db.waypoints.map(p => p.name)).not.toContain('Mine');
  });

  test('different fields changed by two users both survive', async ({context, page}) => {
    await offline(context, page);
    await rename(page, 'North', 'Mine');
    fake.db.waypoints.find(p => p.name === 'North').color = 'purple';
    await back(context, page);
    await expect(page.locator('#syncNotes li')).toHaveCount(0);
    const row = fake.db.waypoints.find(p => p.id === POINTS[0].id);
    expect([row.name, row.color]).toEqual(['Mine', 'purple']);
  });

  test('editing a waypoint another user deleted reports it', async ({context, page}) => {
    await offline(context, page);
    await rename(page, 'North', 'Mine');
    fake.db.waypoints = fake.db.waypoints.filter(p => p.name !== 'North');
    await back(context, page);
    await expect(page.locator('#syncNotes')).toContainText('deleted');
    await expect(page.locator('#list')).not.toContainText('Mine');
  });

  test('an offline delete does not remove a waypoint someone else changed', async ({context, page}) => {
    await offline(context, page);
    await selectInList(page, 'North');
    await page.getByRole('button', {name: 'Delete'}).click();
    await expect(page.locator('#list li')).toHaveCount(1);
    fake.db.waypoints.find(p => p.name === 'North').name = 'Renamed';
    await back(context, page);
    await expect(page.locator('#syncNotes')).toContainText('was not deleted');
    await expect(page.locator('#list')).toContainText('Renamed');
  });

  test('a new waypoint and its line sync in order', async ({context, page}) => {
    await offline(context, page);
    await selectInList(page, 'North');
    await page.getByRole('button', {name: 'Create Point From This Waypoint'}).click();
    await page.fill('#fName', 'Bearing');
    await page.fill('#fDist', '100');
    await page.fill('#fBrg', '90');
    await page.click('#fromForm button[type=submit]');
    await expect(page.locator('#netStatus')).toContainText('2 waiting');
    await back(context, page);
    expect(fake.db.links).toHaveLength(1);
    expect(fake.db.links[0].from_id).toBe(POINTS[0].id);
  });

  test('online edits still reach the database straight away', async ({page}) => {
    await rename(page, 'North', 'Quick');
    await expect.poll(() => fake.db.waypoints.map(p => p.name)).toContain('Quick');
    await expect(page.locator('#netStatus')).toContainText('All synchronized');
  });
});

test.describe('invite link', () => {
  test('the key leaves the address bar and is remembered for the next visit', async ({page}) => {
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain(SECRET);
    await page.goto('/waypoints.html');
    await expect(page.locator('#list li')).toHaveCount(2);
    await expect(page.locator('#netStatus')).not.toContainText('locked');
  });

  test('the shipped page holds no database details', () => {
    const dir = path.join(__dirname, '..', 'docs');
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text).not.toMatch(/sb_publishable_|\.supabase\.co/);
    }
  });
});

test.describe('without a valid invite link', () => {
  test.use({storageState: undefined});
  test('no link: locked, and the database is never contacted', async ({browser}) => {
    const ctx = await browser.newContext(), f = await install(ctx, {points: POINTS}), p = await ctx.newPage();
    await p.goto('/waypoints.html');
    await expect(p.locator('#netStatus')).toContainText('open your invite link');
    await expect(p.locator('#list')).toContainText('No waypoints yet');
    await p.waitForTimeout(500);
    expect(f.supabaseCalls).toBe(0);
    await ctx.close();
  });

  test('a wrong link: rejected and not remembered', async ({browser}) => {
    const ctx = await browser.newContext(), f = await install(ctx, {points: POINTS}), p = await ctx.newPage();
    await p.goto('/waypoints.html#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(p.locator('#netStatus')).toContainText('not valid');
    expect(await p.evaluate(() => localStorage.getItem('waypoint-map.sync-key.v1'))).toBeNull();
    expect(f.supabaseCalls).toBe(0);
    await ctx.close();
  });
});

test('downloaded maps remain after the browser is closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geotools-'));
  const launch = () => chromium.launchPersistentContext(dir, {baseURL: 'http://localhost:8123', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']});
  let ctx = await launch();
  let f = await install(ctx, {points: POINTS});
  let page = await ctx.newPage();
  await open(page);
  await expect(page.locator('#list li')).toHaveCount(2);
  await download(page);
  await ctx.close();

  ctx = await launch();
  f = await install(ctx, {points: POINTS});
  f.offline = true;
  await ctx.setOffline(true);
  page = await ctx.newPage();
  await page.goto('/waypoints.html');
  await expect(page.locator('#netStatus')).toContainText('Offline');
  await expect(page.locator('#areaList')).toContainText('Harbour');
  await expect(page.locator('#list li')).toHaveCount(2);
  await expect(page.locator('#map canvas')).toHaveCount(1, {timeout: 15000});
  await ctx.close();
  fs.rmSync(dir, {recursive: true, force: true});
});
