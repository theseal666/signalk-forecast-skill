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

### Keeping it running across reboots — systemd

`npm start` in a terminal or background shell dies on logout/reboot. For a
box that should just run (e.g. on the boat, or an always-on server), use
the included user-level systemd unit — no root required, survives reboot:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/forecast-skill.service ~/.config/systemd/user/
# edit WorkingDirectory/ExecStart in that file if your paths differ
loginctl enable-linger "$USER"   # starts the service even before you log in
systemctl --user daemon-reload
systemctl --user enable --now forecast-skill.service
```

Useful commands:

```bash
systemctl --user status forecast-skill    # check it's running
systemctl --user restart forecast-skill   # restart (config.json is only read at startup)
journalctl --user -u forecast-skill -f    # tail live logs
systemctl --user stop forecast-skill      # stop it
```

Config comes from `config.json` (path override via `CONFIG_FILE`), with
`PORT` and `DATA_DIR` also settable as env vars. See `config.js` for the
full set of fields — same names as the old plugin's config schema
(`locations`, `models`, `vivaStationIds`, `autoDiscoverViva`,
`fetchIntervalHours`, `retentionDays`, `verifyWindowDays`), plus `port` and
`dataDir`.

### Remote access from the boat — Cloudflare Tunnel + Access

**There is no authentication built into the app itself** — the settings
panel, `POST /api/observations`, and `POST /api/fetch-now` are all open on
the local network. Never expose port 8080 directly to the internet.
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
gives a public HTTPS hostname with no port-forwarding, and
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
puts a login wall in front of it — set both up together, never the tunnel
alone.

```bash
# 1. Install (user-space, no root)
mkdir -p ~/.local/bin
curl -L -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared

# 2. Authorize against your Cloudflare account (opens a browser link)
cloudflared tunnel login

# 3. Create the tunnel and DNS route
cloudflared tunnel create forecast-skill
cloudflared tunnel route dns forecast-skill forecast.yourdomain.example

# 4. Configure — copy the template and fill in your tunnel ID/hostname
mkdir -p ~/.cloudflared
cp deploy/cloudflared-config.yml.example ~/.cloudflared/config.yml
# edit ~/.cloudflared/config.yml: tunnel id, credentials-file path, hostname

# 5. Run it as a systemd user service (survives reboot, same pattern as forecast-skill)
cp deploy/cloudflared-forecast-skill.service.example ~/.config/systemd/user/cloudflared-forecast-skill.service
# edit that file if your username/paths differ from the %h defaults
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-forecast-skill.service
```

**Before leaving it running**, go to the
[Zero Trust dashboard](https://one.dash.cloudflare.com/) → **Access →
Applications → Add an application → Self-hosted**, set the domain to your
tunnel hostname, and add a policy (e.g. "Include → Emails" → your own
email — gates it behind a one-time-PIN, no password to manage). Verify it's
actually gated before trusting it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://forecast.yourdomain.example/api/status
# should redirect through a Cloudflare Access login page, not return your data directly
```

If you ever need to take it offline quickly: `systemctl --user stop cloudflared-forecast-skill`.

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
