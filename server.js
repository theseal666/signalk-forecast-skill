#!/usr/bin/env node
// Standalone HTTP service: fetches forecasts, archives them, verifies them
// against observations, and serves the scoreboard + webapp. No Signal K
// runtime required — see STANDALONE.md for ingestion options.

const http = require("http");
const fs = require("fs");
const path = require("path");

const { loadConfig } = require("./config.js");
const createStore = require("./store.js");
const openMeteo = require("./providers/openMeteo.js");
const { circularMeanFromSums, computeScoreboard } = require("./verify.js");
const { fetchStationIndex } = require("./vivaLocations.js");

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

function locationByLabel(label) {
  return cfg.locations.find((l) => l.label === label);
}

function addLocation(loc) {
  cfg.locations.push(loc);
  knownSlugs.add(loc.label);
  console.log(`[locations] added '${loc.label}' at ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`);
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

async function refreshStationIndex() {
  try {
    stationIndex = await fetchStationIndex();
    console.log(`[viva] station index loaded: ${stationIndex.bySlug.size} slugs`);
    for (const id of cfg.vivaStationIds) {
      const st = stationIndex.byId.get(Number(id));
      if (!st) {
        console.log(`[viva] station ID ${id} not found in index — check the number`);
        continue;
      }
      if (knownSlugs.has(st.slug)) continue;
      addLocation({
        label: st.slug,
        latitude: st.latitude,
        longitude: st.longitude,
      });
    }
  } catch (e) {
    console.error("[viva] station index fetch failed:", e.message);
  }
}

async function fetchAll() {
  counters.lastFetchAt = Date.now();
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
    addLocation({ label: location, latitude, longitude });
  }
  addObservation(location, "dir", (dirDeg * Math.PI) / 180);
  if (typeof speedMs === "number") addObservation(location, "speed", speedMs);
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
        list.push({ slug, name: st.name || slug, latitude: st.latitude, longitude: st.longitude });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }

    if (pathname === "/api/scoreboard" && req.method === "GET") {
      return json(res, 200, buildScoreboard());
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

let timers = [];

function start() {
  if (cfg.autoDiscoverViva || cfg.vivaStationIds.length > 0) {
    refreshStationIndex();
    timers.push(setInterval(refreshStationIndex, 24 * 3600 * 1000));
  } else if (cfg.locations.length === 0) {
    console.log("[start] no locations configured and auto-discovery is off — waiting for POST /api/observations to register one");
  }

  timers.push(
    setInterval(() => {
      for (const label of [...buckets.keys()]) flushBucket(label, false);
    }, 60 * 1000)
  );
  timers.push(setInterval(() => store.prune(cfg.retentionDays), 24 * 3600 * 1000));

  setTimeout(fetchAll, 60 * 1000);
  timers.push(setInterval(fetchAll, cfg.fetchIntervalHours * 3600 * 1000));

  server.listen(cfg.port, () => {
    console.log(`forecast-skill standalone listening on :${cfg.port} (data dir: ${cfg.dataDir})`);
  });
}

function shutdown() {
  console.log("shutting down...");
  for (const t of timers) clearInterval(t);
  for (const label of [...buckets.keys()]) flushBucket(label, true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
