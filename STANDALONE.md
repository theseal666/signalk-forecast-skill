# Standalone mode

This branch adds `server.js`, a plain Node HTTP service that runs the same
fetch/archive/verify pipeline as the Signal K plugin, with no Signal K
runtime involved. `index.js` (the plugin) is left in place for anyone still
running it under Signal K — the two entry points share `store.js`,
`verify.js`, `providers/`, and `vivaLocations.js` unchanged.

## Run it

```
cp config.example.json config.json   # edit locations/models/etc.
npm start
```

Or with Docker:

```
docker compose up -d
```

Config comes from `config.json` (path override via `CONFIG_FILE`), with
`PORT` and `DATA_DIR` also settable as env vars. See `config.js` for the
full set of fields — same names as the old plugin's config schema
(`locations`, `models`, `vivaStationIds`, `autoDiscoverViva`,
`fetchIntervalHours`, `retentionDays`, `verifyWindowDays`), plus `port` and
`dataDir`.

## HTTP API

Same shapes as the plugin, mounted at `/api/*` instead of
`/plugins/forecast-skill/*`:

- `GET /api/status`
- `GET /api/stations` — ViVa station index (name/lat/lon), populated once
  `vivaStationIds` or `autoDiscoverViva` triggers a station-list fetch.
- `GET /api/scoreboard`
- `POST /api/observations` — new; see below.

The webapp (`public/`) is served as static files at `/`.

## Feeding it observations

The plugin used to read wind observations off the Signal K delta bus (paths
like `environment.observations.viva.<slug>.wind.directionTrue`), which were
put there by the separate `signalk-viva` plugin polling ViVa's live-data
service. Standalone, there is no delta bus, so observations need a direct
path in:

```
POST /api/observations
Content-Type: application/json

{ "location": "vinga", "dirDeg": 245, "speedMs": 8.2 }
```

`dirDeg` is degrees true, `speedMs` is optional. If `location` isn't already
known, include `latitude`/`longitude` to auto-register it (mirrors the old
auto-discovery behavior) — otherwise the request is rejected so a typo
doesn't silently create a bogus station.

This is deliberately generic: point any boat-instrument bridge, NMEA
gateway, or small forwarding script at it, once every few minutes per
location, and forecast verification works exactly as before.

**Open item — ViVa live data isn't wired up directly yet.**
`vivaLocations.js` only calls ViVa's *station list* endpoint (name/lat/lon);
the actual live wind readings came via `signalk-viva`, whose polling
endpoint isn't in this repo. Two ways to close that gap, neither done here:

1. Find `signalk-viva`'s live-data endpoint and add a
   `providers`-style poller that calls `POST /api/observations` internally
   on the same cadence — makes standalone mode fully self-sufficient for
   ViVa stations again.
2. If you still run Signal K (with `signalk-viva`) somewhere, bridge it: a
   ~20-line script that opens `ws://<signalk-host>/signalk/v1/stream`,
   subscribes to the wind paths, and forwards each value to
   `POST /api/observations`. Keeps Signal K only as one optional data
   *source*, not a runtime dependency of this service.

## What changed from the plugin

| Plugin (`index.js`) | Standalone (`server.js`) |
|---|---|
| `app.debug/error` | `console.log/error` |
| `app.setPluginStatus` | dropped (status is `GET /api/status`) |
| `app.getDataDirPath()` | `DATA_DIR` env var / `dataDir` config |
| `app.streambundle` delta subscription | `POST /api/observations` |
| `plugin.registerWithRouter` under `/plugins/forecast-skill/*` | built-in `http` server under `/api/*` + static `public/` |
| `plugin.schema` (Signal K admin UI form) | `config.json` |

`package.json`'s `main`/`bin` now point at `server.js` and the `signalk`
registry key was dropped, so this package.json is no longer directly
npm-installable as a Signal K plugin — `index.js` still works if required
directly by a Signal K server, it's just not what `npm start` runs anymore.
