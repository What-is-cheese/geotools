# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

GeoTools is a single-page waypoint map and route navigator. The app is `docs/waypoints.html` plus the small classic scripts beside it (`offline-*.js`) and the service worker (`sw.js`). There is no build step or linter. Leaflet, supabase-js and MapLibre load from CDNs at pinned versions; `package.json` exists only for the tests.

GitHub Pages serves `docs/` from `main` at https://what-is-cheese.github.io/geotools/, so pushing to `main` deploys. `docs/index.md` is only a link to the app.

## Running locally

```sh
python3 -m http.server 8000 --directory docs
# open http://localhost:8000/waypoints.html
```

The GPS features need a secure context (the code checks `window.isSecureContext`), so use `localhost` or HTTPS.

With an invite link, the local page talks to the real shared Supabase database, so creating, editing, or deleting waypoints while testing by hand changes live data for all users.

## Private sync

`SYNC_CONFIG` in `waypoints.html` is the Supabase URL and key, encrypted with AES-256-GCM (`docs/sync-link.js`). The invite link holds the decryption key after `#k=`, which browsers don't send to servers. The page stores the key in `localStorage` and removes it from the address bar. `node tools/sync-link.js <page url>` encrypts the details and prints a new link; each run invalidates older links. Never commit the plain values or an invite link. Anyone with a link has full database access, and the browser can read the plain values once unlocked, so this only protects against people without a link.

## Tests

```sh
npm install
npx playwright install chromium
npm test                                    # everything
npx playwright test tests/unit.spec.js      # one file
npx playwright test -g "not overwritten"    # one test by name
```

Tests never reach the network or the real database. `tests/helpers.js` swaps a test `SYNC_CONFIG` into the page and answers every external host from fixtures and fakes Supabase, including its realtime socket, and tests fail on any request it doesn't recognise. `tests/fixtures/record.js` re-records the OpenFreeMap fixtures by hand. New logic should go in a module that loads in Node, so it can be unit tested without a browser; moving more of `waypoints.html` out this way is a long-term goal.

Check the offline map by looking at a screenshot as well, because it draws gradually with software rendering. A service worker bug only shows up with the network really off, so use `setNetwork` in tests rather than testing online.

## Architecture

The script is one IIFE with no modules, divided by `// ---- Section` comments. It's written in ES5 style (`var`, `function`, promise chains); match that when editing.

**State and persistence.** There are two stores with different scopes:
- Waypoints and links live in Supabase and are shared by all users. The client has them in `data.points` and `data.links`, with a copy in IndexedDB for offline use. Writes never go straight to Supabase: they update local state, then go through the outbox with `queueChange()`.
- The route plan (`plan`: `start`, `via`, `end`, `mode`, `rmode`) is per-user and stored in `localStorage` under `waypoint-map.plan.v1`.

**Sync.** `connect()` subscribes to `postgres_changes` on `waypoints` and `links`, then calls `loadAll()` once subscribed. Realtime events go through `upsertPoint()` and `removePoint()`, which must stay idempotent because a client also receives echoes of its own writes. Another user can delete a waypoint at any moment, so `removePoint()` also purges it from the plan and stops navigation if needed.

**Database schema** (inferred from the queries; `supabase-setup.sql`, mentioned in code comments, is not in the repo):
- `waypoints(id, name, lat, lng, color)`
- `links(id, from_id, to_id)`, where deleting a waypoint cascades to its links on the database side

The client maps `from_id`/`to_id` to `from`/`to` in `data.links`.

**Outbox** (`offline-sync.js`). Online and offline edits take the same path and survive a reload. The waypoint tables have no version column, so updates and deletes are compare-and-swap: they only apply while the row still holds the value this device last saw, and otherwise the other user's change wins and `onConflict` reports it. `upsertPoint` and `loadAll` overlay waiting changes on server rows.

**Offline maps.** OSM's tile servers forbid downloading for offline use, so online uses OSM raster tiles and offline uses OpenFreeMap vector tiles, drawn by MapLibre inside Leaflet (loaded only when needed). Never add prefetching against `tile.openstreetmap.org`. OpenFreeMap's terms cap a download at 3,000 tiles or 50 MB with 4 parallel requests (`GeoTiles.LIMITS`). MapLibre reads tiles, fonts and sprites from IndexedDB through the `geotiles://` protocol, and the stored style is rewritten to use it. `sw.js` only caches the app itself; its `CDN` list must match the URLs in `waypoints.html`, and `VERSION` must be bumped when that list changes.

Tiles, routing data and obstacle data are separate downloads with separate status on each area. Routing and obstacle data come from Overpass, which is often busy, so a failure there must never cost the area its tiles.

**Routing.** `computeRoute(pts)` dispatches on `plan.rmode` and is used by both route planning and live navigation:

| `rmode` | Function | Backend |
|---|---|---|
| `normal` | `fetchRoute` | OSRM at `routing.openstreetmap.de`, with `plan.mode` as the profile (car, bike, foot) |
| `bird` | `birdRoute` | None; synchronous geodesic lines using Vincenty |
| `crazy` | `crazyRoute` | BRouter at `brouter.de` with trail profiles |
| `avoid` | `avoidRoute` | Overpass obstacles, rasterized to a grid, then A* and path straightening |

Each returns a promise for `{distance, duration, line}`, where `line` is `[lat, lng]` pairs. `birdRoute` is the exception: it returns the object directly and `computeRoute` wraps it in a promise. Optional fields drive the UI: `legs` and `bird` show per-leg bearings, `walk` labels times as walking at 5 km/h, and `note` shows a message. A new route mode needs an entry in `RMODES` and a branch in `computeRoute`. Offline, `normal` and `crazy` use `localRoute` (A* over downloaded ways in `offline-router.js`) and `avoid` uses obstacles saved with the area; all the points must fall inside one area.

`avoid` limits legs to 5 km and the total area to about 20 km, and it caches the last Overpass response in `obs`. All of the third-party services are public and shared, so avoid adding extra requests. `onPos` throttles rerouting with `MIN_GAP`, `MOVE_M`, and `OFF_M`.

**Navigation.** `nav` holds the live session and is `null` when idle. `onPos` advances through `nav.targets` on arrival and decides when to reroute. `calcNav` allows one request at a time, using `nav.busy` and `nav.pending`. `planToken` discards stale plan results, and `nav !== n` does the same for navigation.

**Geodesy.** `destination` (Vincenty direct) and `inverse` (Vincenty inverse) use WGS-84. `hav` is a cheaper spherical distance for arrival checks. Code that handles longitude must account for the antimeridian; see `normLng`, `dlng`, and the unwrapping in `drawLines` and `birdRoute`.

**Rendering.** `select()` and the `render*()` functions rebuild their DOM from state rather than patching it. User-supplied names must go through `esc()` before being put into `innerHTML`.
