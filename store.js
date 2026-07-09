const fs = require("fs");
const path = require("path");

// Append-only ndjson archive, one file per day per kind
// (<baseDir>/forecasts/YYYY-MM-DD.ndjson, <baseDir>/observations/...).
// Records must carry a millisecond timestamp in `t` (observations) or
// `runTime` (forecast runs).
function createStore(baseDir, logError) {
  const KINDS = ["forecasts", "observations"];
  for (const kind of KINDS) {
    fs.mkdirSync(path.join(baseDir, kind), { recursive: true });
  }

  const dayFile = (kind, t) =>
    path.join(baseDir, kind, new Date(t).toISOString().slice(0, 10) + ".ndjson");

  function append(kind, record) {
    const t = record.t || record.runTime || Date.now();
    try {
      fs.appendFileSync(dayFile(kind, t), JSON.stringify(record) + "\n");
    } catch (e) {
      logError(`forecast-skill store append failed: ${e.message}`);
    }
  }

  function readSince(kind, sinceMs) {
    const out = [];
    try {
      const dir = path.join(baseDir, kind);
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".ndjson"))
        .sort();
      for (const f of files) {
        const day = Date.parse(f.slice(0, 10));
        if (isNaN(day) || day + 86400000 < sinceMs) continue;
        for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
          if (!line) continue;
          try {
            out.push(JSON.parse(line));
          } catch (e) {
            // a torn line from a crash mid-append is not worth dying over
          }
        }
      }
    } catch (e) {
      logError(`forecast-skill store read failed: ${e.message}`);
    }
    return out;
  }

  function prune(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const kind of KINDS) {
      try {
        const dir = path.join(baseDir, kind);
        for (const f of fs.readdirSync(dir)) {
          const day = Date.parse(f.slice(0, 10));
          if (!isNaN(day) && day + 86400000 < cutoff) {
            fs.unlinkSync(path.join(dir, f));
          }
        }
      } catch (e) {
        logError(`forecast-skill store prune failed: ${e.message}`);
      }
    }
  }

  return { append, readSince, prune };
}

module.exports = createStore;
