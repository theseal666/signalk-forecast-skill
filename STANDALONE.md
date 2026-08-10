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
- `GET /api/stations` — ViVa station index (name/id/lat/lon), populated once
  `vivaStationIds` or `autoDiscoverViva` triggers a station-list fetch.
- `GET /api/scoreboard`
- `GET /api/curves?location=&pastHours=&futureHours=` — new; per-model
  forecast track + observed track for the scroll charts. Defaults to 48h
  past / 48h future. Observed stops at "now"; each model's line continues
  into the future from its latest run.
- `GET /api/models` — new; available Open-Meteo models + currently selected.
- `GET /api/config` / `PUT /api/config` — new; read/update
  `vivaStationIds`, `models`, `fetchIntervalHours`, `retentionDays`,
  `verifyWindowDays` live, without restarting. Backs the ⚙ settings panel.
- `POST /api/fetch-now` — new; triggers an immediate station-index refresh +
  forecast fetch + ViVa observation poll instead of waiting for the
  schedule. Backs the ↻ force-update button.
- `POST /api/observations` — new; see below.

The webapp (`public/`) is served as static files at `/`.

## Feeding it observations

**ViVa stations (`vivaStationIds`) are self-sufficient — no Signal K
needed.** `vivaLocations.js`'s `fetchStationWind()` polls each ViVa-sourced
station's live endpoint directly (same host as the station list, one call
per station ID) every 60s, matching `signalk-viva`'s own conventions
exactly (`Medelvind` = average wind sample, direction from `Heading` in
degrees). This closed what used to be an open gap: the plugin got
observations for free off the Signal K delta bus via `signalk-viva`;
standalone, `pollVivaObservations()` in `server.js` does the equivalent
directly, feeding the same bucket/archive pipeline. Nothing to configure —
add a station via `vivaStationIds` (or the ⚙ settings panel) and its
observations start flowing automatically, alongside its forecasts.

For anything that *isn't* a ViVa station — boat instruments, an NMEA
gateway, a non-ViVa buoy — there's a generic push endpoint:

```
POST /api/observations
Content-Type: application/json

{ "location": "myboat", "dirDeg": 245, "speedMs": 8.2 }
```

`dirDeg` is degrees true, `speedMs` is optional. If `location` isn't already
known, include `latitude`/`longitude` to auto-register it — otherwise the
request is rejected so a typo doesn't silently create a bogus station.
Point any forwarding script at it, once every few minutes per location, and
forecast verification works exactly as before.

If you still run Signal K (e.g. with `signalk-viva`) somewhere and want to
use *that* as a source instead — for boat instruments already publishing to
a Signal K server — bridge it: a small script that opens
`ws://<signalk-host>/signalk/v1/stream`, subscribes to the wind paths, and
forwards each value to `POST /api/observations`. Keeps Signal K as one
optional data *source*, never a runtime dependency of this service.

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
