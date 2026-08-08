const fs = require("fs");
const path = require("path");

// Standalone config: a JSON file (CONFIG_FILE or ./config.json) with env-var
// overrides for the handful of settings you'd want to flip per-deployment
// without editing the file (PORT, DATA_DIR).
function loadConfig() {
  const configFile = process.env.CONFIG_FILE || path.join(__dirname, "config.json");
  let fileCfg = {};
  if (fs.existsSync(configFile)) {
    fileCfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }

  const cfg = {
    port: Number(process.env.PORT) || fileCfg.port || 8080,
    dataDir: process.env.DATA_DIR || fileCfg.dataDir || path.join(__dirname, "data"),

    locations: (fileCfg.locations || []).filter(
      (l) => l && l.label && typeof l.latitude === "number" && typeof l.longitude === "number"
    ),
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

module.exports = { loadConfig };
