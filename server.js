#!/usr/bin/env node
// Standalone HTTP service: fetches forecasts, archives them, verifies them
// against observations, and serves the scoreboard + webapp. No Signal K
// runtime required — see STANDALONE.md for ingestion options.

const http = require("http");
const fs = require("fs");
const path = require("path");

const { loadConfig, saveConfig } = require("./config.js");
const createStore = require("./store.js");
const openMeteo = require("./providers/openMeteo.js");
const { circularMeanFromSums, computeScoreboard } = require("./verify.js");
const { fetchStationIndex, fetchStationWind } = require("./vivaLocations.js");

const PROVIDERS = [openMeteo];
const OBS_BUCKET_MS = 10 * 60 * 1000;
const SCOREBOARD_CACHE_MS = 5 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");

const cfg = loadConfig();
cfg.models = cfg.models || openMeteo.defaultModels;

fs.mkdirSync(cfg.dataDir, { recursive: true });
const store = createStore(cfg.dataDir, (msg) => console.error("[store]", msg));
store.prune(cfg.retentionDays);

let dirPaths = new Map(); // label -> label (kept for parity with plugin's path-keyed lookup)
let knownSlugs = new Set(cfg.locations.map((l) => l.label));
let stationIndex = null; // slug -> { latitude, longitude, name } from ViVa
let scoreboardCache = null;
let buckets = new Map(); // label -> { start, sumSin, sumCos, nDir, sumSpeed, nSpeed }
let counters = {
  forecastRuns: 0,
  fetchErrors: 0,
  obsRecords: 0,
  lastFetchAt: null,
  lastError: null,
};

// Tracks where each active location came from, so unchecking a station in
// the settings panel actually stops it being fetched — 'manual' (config
// file locations[]) and 'api' (POST /api/observations) entries are never
// auto-removed, only 'viva' entries whose station id drops out of
// vivaStationIds.
let locationSource = new Map(); // label -> { type: 'manual'|'viva'|'api', stationId? }
for (const l of cfg.locations) locationSource.set(l.label, { type: "manual" });

function locationByLabel(label) {
  return cfg.locations.find((l) => l.label === label);
}

function addLocation(loc, source) {
  cfg.locations.push(loc);
  knownSlugs.add(loc.label);
  locationSource.set(loc.label, source || { type: "manual" });
  console.log(`[locations] added '${loc.label}' at ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`);
}

function removeLocation(label) {
  cfg.locations = cfg.locations.filter((l) => l.label !== label);
  knownSlugs.delete(label);
  locationSource.delete(label);
  buckets.delete(label);
  console.log(`[locations] removed '${label}' — no longer in vivaStationIds`);
}

function flushBucket(label, force) {
  const b = buckets.get(label);
  if (!b || b.nDir === 0) return;
  if (!force && Date.now() - b.start < OBS_BUCKET_MS) return;
  store.append("observations", {
    t: b.start + Math.round(OBS_BUCKET_MS / 2),
    location: label,
    dir: circularMeanFromSums(b.sumSin, b.sumCos),
    speed: b.nSpeed > 0 ? b.sumSpeed / b.nSpeed : null,
    n: b.nDir,
  });
  counters.obsRecords++;
  buckets.delete(label);
}

// value: radians. Mirrors index.js's bucketing so store.js/verify.js need no changes.
function addObservation(label, kind, value) {
  let b = buckets.get(label);
  if (b && Date.now() - b.start >= OBS_BUCKET_MS) {
    flushBucket(label, true);
    b = null;
  }
  if (!b) {
    b = { start: Date.now(), sumSin: 0, sumCos: 0, nDir: 0, sumSpeed: 0, nSpeed: 0 };
    buckets.set(label, b);
  }
  if (kind === "dir") {
    b.sumSin += Math.sin(value);
    b.sumCos += Math.cos(value);
    b.nDir++;
  } else {
    b.sumSpeed += value;
    b.nSpeed++;
  }
}

let unresolvedVivaStationIds = [];

async function refreshStationIndex() {
  try {
    stationIndex = await fetchStationIndex();
    console.log(`[viva] station index loaded: ${stationIndex.bySlug.size} slugs`);
    unresolvedVivaStationIds = [];
    const wantedIds = new Set(cfg.vivaStationIds.map(Number));
    for (const id of cfg.vivaStationIds) {
      const st = stationIndex.byId.get(Number(id));
      if (!st) {
        console.log(`[viva] station ID ${id} not found in index — check the number`);
        unresolvedVivaStationIds.push(Number(id));
        continue;
      }
      if (knownSlugs.has(st.slug)) continue;
      addLocation(
        { label: st.slug, latitude: st.latitude, longitude: st.longitude },
        { type: "viva", stationId: st.id }
      );
    }
    // vivaStationIds is authoritative for which viva-sourced stations stay
    // active — anything unchecked in the settings panel stops being fetched.
    for (const [label, src] of [...locationSource]) {
      if (src.type === "viva" && !wantedIds.has(Number(src.stationId))) {
        removeLocation(label);
      }
    }
  } catch (e) {
    console.error("[viva] station index fetch failed:", e.message);
  }
}

// Poll live wind for every ViVa-sourced location and feed it into the same
// bucketing pipeline POST /api/observations uses — makes standalone mode
// self-sufficient for ViVa stations without any external bridge.
async function pollVivaObservations() {
  const vivaLocations = [...locationSource].filter(([, src]) => src.type === "viva");
  for (const [label, src] of vivaLocations) {
    try {
      const wind = await fetchStationWind(src.stationId);
      if (!wind) continue;
      addObservation(label, "dir", (wind.dirDeg * Math.PI) / 180);
      addObservation(label, "speed", wind.speedMs);
    } catch (e) {
      console.error(`[viva] wind poll failed for '${label}' (#${src.stationId}):`, e.message);
    }
  }
}

let fetchInProgress = false;

async function fetchAll() {
  if (fetchInProgress) {
    console.log("[fetch] cycle already running — skipped");
    return;
  }
  fetchInProgress = true;
  counters.lastFetchAt = Date.now();
  try {
    for (const provider of PROVIDERS) {
      for (const model of cfg.models) {
        if (!provider.models.includes(model)) {
          console.log(`[fetch] unknown model '${model}' for provider ${provider.name} — skipped`);
          continue;
        }
        for (const loc of [...cfg.locations]) {
          try {
            const run = await provider.fetchRun(model, loc);
            run.location = loc.label;
            store.append("forecasts", run);
            counters.forecastRuns++;
          } catch (e) {
            counters.fetchErrors++;
            counters.lastError = `${model}@${loc.label}: ${e.message}`;
            console.error(`[fetch] failed for ${model} at ${loc.label}: ${e.message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    console.log(`[fetch] cycle done — ${counters.forecastRuns} runs archived total, ${counters.fetchErrors} errors`);
  } finally {
    fetchInProgress = false;
  }
}

function buildScoreboard() {
  const now = Date.now();
  if (scoreboardCache && now - scoreboardCache.generatedAt < SCOREBOARD_CACHE_MS) {
    return scoreboardCache;
  }
  const forecasts = store.readSince("forecasts", now - (cfg.verifyWindowDays + 8) * 86400000);
  const observations = store.readSince("observations", now - cfg.verifyWindowDays * 86400000 - 3600000);
  const sb = computeScoreboard({ forecasts, observations, now, windowDays: cfg.verifyWindowDays });
  const byLabel = new Map(cfg.locations.map((l) => [l.label, l]));
  for (const loc of sb.locations) {
    const known = byLabel.get(loc.label);
    if (known) {
      loc.latitude = known.latitude;
      loc.longitude = known.longitude;
    }
  }
  sb.modelLabels = openMeteo.modelLabels;
  scoreboardCache = sb;
  return sb;
}

// ---- ingestion: generic HTTP push, e.g. from NMEA/boat-instrument bridges ----
// POST /api/observations  { location, latitude?, longitude?, dirDeg, speedMs?, t? }
// If `location` is unknown and latitude/longitude are given, it is
// auto-registered (same behavior as ViVa auto-discovery had in the plugin).
function handleObservationPost(body) {
  const { location, latitude, longitude, dirDeg, speedMs } = body;
  if (!location || typeof dirDeg !== "number") {
    throw new Error("required: location (string), dirDeg (number)");
  }
  if (!knownSlugs.has(location)) {
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      throw new Error(`unknown location '${location}' — include latitude/longitude to register it`);
    }
    addLocation({ label: location, latitude, longitude }, { type: "api" });
  }
  addObservation(location, "dir", (dirDeg * Math.PI) / 180);
  if (typeof speedMs === "number") addObservation(location, "speed", speedMs);
}

// ---- PUT /api/config: settings-panel edits ----
function applyConfigUpdate(body) {
  if (body.vivaStationIds !== undefined) {
    if (!Array.isArray(body.vivaStationIds)) throw new Error("vivaStationIds must be an array of numbers");
    const ids = body.vivaStationIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    cfg.vivaStationIds = [...new Set(ids)];
  }
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length === 0) {
      throw new Error("models must be a non-empty array");
    }
    const valid = new Set(openMeteo.models);
    for (const m of body.models) {
      if (!valid.has(m)) throw new Error(`unknown model '${m}'`);
    }
    cfg.models = [...new Set(body.models)];
  }
  for (const [key, min] of [
    ["fetchIntervalHours", 1],
    ["retentionDays", 1],
    ["verifyWindowDays", 1],
  ]) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min}`);
    cfg[key] = n;
  }
  rescheduleFetchTimer();
}

// ---- minimal static file server for public/ ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (pathname === "/api/status" && req.method === "GET") {
      return json(res, 200, {
        config: {
          locations: cfg.locations.map((l) => l.label),
          models: cfg.models,
          autoDiscoverViva: cfg.autoDiscoverViva,
          fetchIntervalHours: cfg.fetchIntervalHours,
        },
        counters,
        pendingBuckets: [...buckets.keys()],
      });
    }

    if (pathname === "/api/stations" && req.method === "GET") {
      if (!stationIndex) return json(res, 503, { error: "station index not yet loaded" });
      const list = [];
      for (const [slug, st] of stationIndex.bySlug) {
        list.push({ id: st.id, slug, name: st.name || slug, latitude: st.latitude, longitude: st.longitude });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }

    if (pathname === "/api/scoreboard" && req.method === "GET") {
      return json(res, 200, buildScoreboard());
    }

    if (pathname === "/api/fetch-now" && req.method === "POST") {
      if (fetchInProgress) {
        return json(res, 409, { error: "a fetch cycle is already running" });
      }
      await refreshStationIndex();
      await Promise.all([fetchAll(), pollVivaObservations()]);
      for (const label of [...buckets.keys()]) flushBucket(label, true);
      scoreboardCache = null; // force the next /api/scoreboard to recompute
      return json(res, 200, { ok: true, counters, locations: cfg.locations.map((l) => l.label) });
    }

    if (pathname === "/api/models" && req.method === "GET") {
      return json(res, 200, {
        available: openMeteo.models.map((id) => ({ id, label: openMeteo.modelLabels[id] || id })),
        selected: cfg.models,
      });
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return json(res, 200, {
        vivaStationIds: cfg.vivaStationIds,
        unresolvedVivaStationIds,
        models: cfg.models,
        fetchIntervalHours: cfg.fetchIntervalHours,
        retentionDays: cfg.retentionDays,
        verifyWindowDays: cfg.verifyWindowDays,
      });
    }

    if (pathname === "/api/config" && req.method === "PUT") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return json(res, 400, { error: "invalid JSON" });
      }
      try {
        applyConfigUpdate(body);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      await refreshStationIndex();
      if (!stationTimer) stationTimer = setInterval(refreshStationIndex, 24 * 3600 * 1000);
      saveConfig(cfg);
      return json(res, 200, {
        vivaStationIds: cfg.vivaStationIds,
        unresolvedVivaStationIds,
        models: cfg.models,
        fetchIntervalHours: cfg.fetchIntervalHours,
        retentionDays: cfg.retentionDays,
        verifyWindowDays: cfg.verifyWindowDays,
      });
    }

    if (pathname === "/api/observations" && req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return json(res, 400, { error: "invalid JSON" });
      }
      try {
        handleObservationPost(body);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      return json(res, 202, { ok: true });
    }

    if (req.method === "GET") {
      return serveStatic(req, res, pathname);
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[http] unhandled error:", e);
    json(res, 500, { error: "internal error" });
  }
});

const VIVA_POLL_INTERVAL_MS = 60 * 1000; // matches signalk-viva's default pollInterval

let stationTimer = null;
let flushTimer = null;
let pruneTimer = null;
let fetchTimer = null;
let vivaPollTimer = null;

// Re-armed whenever fetchIntervalHours changes via PUT /api/config.
function rescheduleFetchTimer() {
  if (fetchTimer) clearInterval(fetchTimer);
  fetchTimer = setInterval(fetchAll, cfg.fetchIntervalHours * 3600 * 1000);
}

function start() {
  if (cfg.autoDiscoverViva || cfg.vivaStationIds.length > 0) {
    refreshStationIndex();
    stationTimer = setInterval(refreshStationIndex, 24 * 3600 * 1000);
  } else if (cfg.locations.length === 0) {
    console.log("[start] no locations configured and auto-discovery is off — waiting for POST /api/observations to register one");
  }

  flushTimer = setInterval(() => {
    for (const label of [...buckets.keys()]) flushBucket(label, false);
  }, 60 * 1000);
  pruneTimer = setInterval(() => store.prune(cfg.retentionDays), 24 * 3600 * 1000);

  setTimeout(fetchAll, 60 * 1000);
  rescheduleFetchTimer();

  // Give station discovery a head start so the first poll has something to poll.
  setTimeout(pollVivaObservations, 15 * 1000);
  vivaPollTimer = setInterval(pollVivaObservations, VIVA_POLL_INTERVAL_MS);

  server.listen(cfg.port, () => {
    console.log(`forecast-skill standalone listening on :${cfg.port} (data dir: ${cfg.dataDir})`);
  });
}

function shutdown() {
  console.log("shutting down...");
  for (const t of [stationTimer, flushTimer, pruneTimer, fetchTimer, vivaPollTimer]) {
    if (t) clearInterval(t);
  }
  for (const label of [...buckets.keys()]) flushBucket(label, true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
