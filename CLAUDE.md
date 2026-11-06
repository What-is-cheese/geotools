# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

GeoTools is a single-page waypoint map and route navigator. All of the app (HTML, CSS, JS) lives in `docs/waypoints.html`. There is no build step, package manager, linter, or test suite. Leaflet and supabase-js load from CDNs at pinned versions.

GitHub Pages serves `docs/` from `main` at https://what-is-cheese.github.io/geotools/, so pushing to `main` deploys. `docs/index.md` is only a link to the app.

## Running locally

```sh
python3 -m http.server 8000 --directory docs
# open http://localhost:8000/waypoints.html
```

The GPS features need a secure context (the code checks `window.isSecureContext`), so use `localhost` or HTTPS.

The local page talks to the real shared Supabase database, so creating, editing, or deleting waypoints while testing changes live data for all users.

## Architecture

The script is one IIFE with no modules, divided by `// ---- Section` comments. It's written in ES5 style (`var`, `function`, promise chains); match that when editing.

**State and persistence.** There are two stores with different scopes:
- Waypoints and links live in Supabase and are shared by all users. The client has them in `data.points` and `data.links`. The app writes optimistically: it updates local state first, then `dbWrite()` shows an error and runs an optional undo if the write fails.
- The route plan (`plan`: `start`, `via`, `end`, `mode`, `rmode`) is per-user and stored in `localStorage` under `waypoint-map.plan.v1`.

**Sync.** `connect()` subscribes to `postgres_changes` on `waypoints` and `links`, then calls `loadAll()` once subscribed. Realtime events go through `upsertPoint()` and `removePoint()`, which must stay idempotent because a client also receives echoes of its own writes. Another user can delete a waypoint at any moment, so `removePoint()` also purges it from the plan and stops navigation if needed.

**Database schema** (inferred from the queries; `supabase-setup.sql`, mentioned in code comments, is not in the repo):
- `waypoints(id, name, lat, lng, color)`
- `links(id, from_id, to_id)`, where deleting a waypoint cascades to its links on the database side

The client maps `from_id`/`to_id` to `from`/`to` in `data.links`.

**Routing.** `computeRoute(pts)` dispatches on `plan.rmode` and is used by both route planning and live navigation:

| `rmode` | Function | Backend |
|---|---|---|
| `normal` | `fetchRoute` | OSRM at `routing.openstreetmap.de`, with `plan.mode` as the profile (car, bike, foot) |
| `bird` | `birdRoute` | None; synchronous geodesic lines using Vincenty |
| `crazy` | `crazyRoute` | BRouter at `brouter.de` with trail profiles |
| `avoid` | `avoidRoute` | Overpass obstacles, rasterized to a grid, then A* and path straightening |

Each returns a promise for `{distance, duration, line}`, where `line` is `[lat, lng]` pairs. `birdRoute` is the exception: it returns the object directly and `computeRoute` wraps it in a promise. Optional fields drive the UI: `legs` and `bird` show per-leg bearings, `walk` labels times as walking at 5 km/h, and `note` shows a message. A new route mode needs an entry in `RMODES` and a branch in `computeRoute`.

`avoid` limits legs to 5 km and the total area to about 20 km, and it caches the last Overpass response in `obs`. All of the third-party services are public and shared, so avoid adding extra requests. `onPos` throttles rerouting with `MIN_GAP`, `MOVE_M`, and `OFF_M`.

**Navigation.** `nav` holds the live session and is `null` when idle. `onPos` advances through `nav.targets` on arrival and decides when to reroute. `calcNav` allows one request at a time, using `nav.busy` and `nav.pending`. `planToken` discards stale plan results, and `nav !== n` does the same for navigation.

**Geodesy.** `destination` (Vincenty direct) and `inverse` (Vincenty inverse) use WGS-84. `hav` is a cheaper spherical distance for arrival checks. Code that handles longitude must account for the antimeridian; see `normLng`, `dlng`, and the unwrapping in `drawLines` and `birdRoute`.

**Rendering.** `select()` and the `render*()` functions rebuild their DOM from state rather than patching it. User-supplied names must go through `esc()` before being put into `innerHTML`.
