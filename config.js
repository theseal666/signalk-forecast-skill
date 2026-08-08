const fs = require("fs");
const path = require("path");

// Standalone config: a JSON file (CONFIG_FILE or ./config.json) with env-var
// overrides for the handful of settings you'd want to flip per-deployment
// without editing the file (PORT, DATA_DIR).
function configFilePath() {
  return process.env.CONFIG_FILE || path.join(__dirname, "config.json");
}

function loadConfig() {
  const configFile = configFilePath();
  let fileCfg = {};
  if (fs.existsSync(configFile)) {
    fileCfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }

  // manualLocations = exactly what's hand-written in the config file, kept
  // separate from cfg.locations (which also accumulates ViVa-resolved and
  // POST /api/observations-registered entries at runtime) so the web
  // settings panel can rewrite the file without clobbering those.
  const manualLocations = (fileCfg.locations || []).filter(
    (l) => l && l.label && typeof l.latitude === "number" && typeof l.longitude === "number"
  );

  const cfg = {
    port: Number(process.env.PORT) || fileCfg.port || 8080,
    dataDir: process.env.DATA_DIR || fileCfg.dataDir || path.join(__dirname, "data"),

    manualLocations,
    locations: [...manualLocations],
    models: fileCfg.models && fileCfg.models.length ? fileCfg.models : undefined, // provider default applied by caller
    autoDiscoverViva: fileCfg.autoDiscoverViva !== false,
    vivaStationIds: (fileCfg.vivaStationIds || []).map(Number).filter(Boolean),
    fetchIntervalHours: fileCfg.fetchIntervalHours || 3,
    retentionDays: fileCfg.retentionDays || 14,
    verifyWindowDays: fileCfg.verifyWindowDays || 7,

    // Optional: connect to a Signal K server as an ordinary WS client to
    // receive wind/position deltas (e.g. from signalk-viva or boat
    // instruments), without being a Signal K plugin. Leave unset to rely
    // solely on the POST /api/observations ingestion endpoint instead.
    signalkWsUrl: process.env.SIGNALK_WS_URL || fileCfg.signalkWsUrl || null,
  };

  return cfg;
}

// Persists the settings the web UI can edit back to the config file.
// port/dataDir/signalkWsUrl stay env/file-only (not exposed in the panel).
function saveConfig(cfg) {
  const configFile = configFilePath();
  const out = {
    port: cfg.port,
    dataDir: cfg.dataDir,
    vivaStationIds: cfg.vivaStationIds,
    autoDiscoverViva: cfg.autoDiscoverViva,
    locations: cfg.manualLocations,
    models: cfg.models,
    fetchIntervalHours: cfg.fetchIntervalHours,
    retentionDays: cfg.retentionDays,
    verifyWindowDays: cfg.verifyWindowDays,
  };
  if (cfg.signalkWsUrl) out.signalkWsUrl = cfg.signalkWsUrl;
  fs.writeFileSync(configFile, JSON.stringify(out, null, 2) + "\n");
}

module.exports = { loadConfig, saveConfig };
