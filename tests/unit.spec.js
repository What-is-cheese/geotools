const {test, expect} = require('@playwright/test');
const L = require('../docs/sync-link.js'), T = require('../docs/offline-tiles.js'), R = require('../docs/offline-router.js'), S = require('../docs/offline-sync.js');

test.describe('invite link', () => {
  const config = {url: 'https://x.supabase.co', key: 'k'};
  test('the right key unlocks the details', async () => {
    const key = L.newKey();
    expect(await L.decrypt(await L.encrypt(config, key), key)).toEqual(config);
  });
  test('a wrong key is rejected', async () => {
    await expect(L.decrypt(await L.encrypt(config, L.newKey()), L.newKey())).rejects.toBeTruthy();
  });
  test('changed data is rejected', async () => {
    const key = L.newKey(), blob = await L.encrypt(config, key);
    await expect(L.decrypt(blob.slice(0, 20) + (blob[20] === 'A' ? 'B' : 'A') + blob.slice(21), key)).rejects.toBeTruthy();
  });
  test('the stored text does not show the details', async () => {
    expect(await L.encrypt(config, L.newKey())).not.toContain('supabase');
  });
  test('keys are random and 256 bits', () => {
    const a = L.newKey();
    expect(a).not.toBe(L.newKey());
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
  });
});

test.describe('tiles', () => {
  const bb = {s: 55.67, w: 12.56, n: 55.68, e: 12.58};
  test('finds the known tile for Copenhagen', () => {
    const r = T.range(bb, 14);
    expect([r.x0, r.y1]).toEqual([8763, 5128]);
  });
  test('count matches list', () => { expect(T.count(bb, 13)).toBe(T.list(bb, 13).length); });
  test('sample is spread and bounded', () => {
    const keys = [...Array(100).keys()].map(String), s = T.sample(keys, 6);
    expect(s).toHaveLength(6); expect(new Set(s).size).toBe(6);
    expect(T.sample(['a'], 6)).toEqual(['a']);
  });
  test('limits match the OpenFreeMap terms', () => {
    expect(T.LIMITS).toEqual({tiles: 3000, bytes: 50*1024*1024, parallel: 4});
  });
});

test.describe('outbox merging', () => {
  const ins = {t: 'insert', row: {id: 'a', name: 'x', color: 'red'}}, up = (field, value, base) => ({t: 'update', id: 'b', field, value, base});
  test('editing a waypoint that is not saved yet changes the insert', () => {
    const q = S.coalesce([ins], {t: 'update', id: 'a', field: 'name', value: 'y', base: 'x'});
    expect(q).toHaveLength(1); expect(q[0].row.name).toBe('y');
  });
  test('two edits keep the first base', () => {
    const q = S.coalesce([up('name', 'n1', 'orig')], up('name', 'n2', 'n1'));
    expect(q).toEqual([{...up('name', 'n2', 'orig')}]);
  });
  test('editing back to the original cancels the change', () => {
    expect(S.coalesce([up('name', 'n1', 'orig')], up('name', 'orig', 'n1'))).toEqual([]);
  });
  test('deleting an unsaved waypoint removes it and its line', () => {
    const link = {t: 'link', row: {id: 'l', from_id: 'z', to_id: 'a'}};
    expect(S.coalesce([ins, link], {t: 'delete', id: 'a', base: {name: 'x', color: 'red'}})).toEqual([]);
  });
  test('delete uses the server values, not the local edit', () => {
    const q = S.coalesce([up('name', 'local', 'server')], {t: 'delete', id: 'b', base: {name: 'local', color: 'red'}});
    expect(q).toHaveLength(1); expect(q[0].base).toEqual({name: 'server', color: 'red'});
  });
});

test.describe('router', () => {
  // A-B-C is a long main road; A-D-C is a slightly longer trail. E-F is an isolated fragment.
  const way = (n, g, t) => ({n, g: g.flat(), t});
  const A = [55, 12], B = [55.01, 12], C = [55.02, 12], D = [55.01, 12.002], E = [55.0101, 12.0003], F = [55.0102, 12.0003];
  const ways = [way([1, 2, 3], [A, B, C], {highway: 'primary'}), way([1, 4, 3], [A, D, C], {highway: 'path'}), way([5, 6], [E, F], {highway: 'residential'})];
  const pt = ([lat, lng]) => ({lat, lng});
  const route = (profile, w = ways) => R.route(R.build(w, profile), [pt(A), pt(C)], 500, 1.4);
  const usesTrail = r => r.line.some(p => p[1] === D[1]);

  test('normal foot routing takes the shortest way', () => { expect(usesTrail(route('foot'))).toBe(false); });
  test('crazy routing prefers the trail', () => { expect(usesTrail(route('crazy-foot'))).toBe(true); });
  test('cars cannot use a path', () => { expect(usesTrail(route('car'))).toBe(false); });
  test('private ways are not used', () => {
    const w = [way([1, 2, 3], [A, B, C], {highway: 'residential', access: 'private'}), ways[1]];
    expect(usesTrail(route('foot', w))).toBe(true);
  });
  test('one-way streets apply to cars but not walkers', () => {
    const w = [way([1, 2, 3], [C, B, A], {highway: 'residential', oneway: 'yes'})];
    expect(route('car', w).error).toBe('noroute');
    expect(route('foot', w).error).toBeUndefined();
  });
  test('points never snap to an isolated fragment', () => {
    const r = R.route(R.build(ways, 'foot'), [pt(E), pt(C)], 500, 1.4);
    expect(r.error).toBeUndefined(); expect(r.distance).toBeGreaterThan(1000);
  });
  test('a point far from any road is reported', () => {
    expect(R.route(R.build(ways, 'foot'), [{lat: 56, lng: 12}, pt(C)], 500, 1.4)).toEqual({error: 'snap', point: 0});
  });
  test('compact drops unusable ways and tags', () => {
    const c = R.compact([{type: 'way', nodes: [1, 2], geometry: [{lat: 1, lon: 2}, {lat: 3, lon: 4}], tags: {highway: 'path', name: 'x'}}, {type: 'node'}]);
    expect(c).toEqual([{n: [1, 2], g: [1, 2, 3, 4], t: {highway: 'path'}}]);
  });
});
