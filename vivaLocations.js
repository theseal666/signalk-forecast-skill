// Auto-discovery of ViVa station coordinates. Independent of the viva
// plugin's code — this uses the same public Sjöfartsverket API and the same
// slug convention, so labels line up with the paths viva publishes.

const STATION_LIST_URL =
  "https://services.viva.sjofartsverket.se:8080/output/vivaoutputservice.svc/vivastation/";

// Must produce the same slugs as the signalk-viva plugin
function slugify(name) {
  return (
    name
      .replace(/\(.*?\)/g, "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "")
      .toLowerCase() || "station"
  );
}

// Returns { bySlug, byId } where:
//   bySlug: slug -> { latitude, longitude, name, slug }  (first match wins for duplicate slugs)
//   byId:   stationNumber -> same entry  (keyed by the integer station ID from the ViVa API)
async function fetchStationIndex() {
  const res = await fetch(STATION_LIST_URL, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ViVa station list`);
  const json = await res.json();
  const bySlug = new Map();
  const byId = new Map();
  for (const s of json.GetStationsResult.Stations) {
    if (typeof s.Lat !== "number" || typeof s.Lon !== "number") continue;
    const slug = slugify(s.Name);
    // ViVa API field name for station number: try ID then StationID
    const id = s.ID ?? s.StationID;
    const entry = { latitude: s.Lat, longitude: s.Lon, name: s.Name, slug, id: id != null ? Number(id) : null };
    if (!bySlug.has(slug)) bySlug.set(slug, entry);
    if (id != null) byId.set(Number(id), entry);
  }
  return { bySlug, byId };
}

// Live per-station samples — same base URL as the station list, with the
// station ID appended. Conventions (Medelvind = average wind, direction
// from Heading in degrees, numeric value extraction) match signalk-viva
// so the two report identically for the same station.
function parseWindValue(sample) {
  const match = String(sample.Value).replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!match) return sample.Calm ? 0 : null;
  return parseFloat(match[0]); // ViVa wind samples are already m/s
}

// Returns { speedMs, dirDeg, updated } from the station's Medelvind
// (average wind) sample, or null if the station has no current wind sample.
async function fetchStationWind(stationId) {
  const res = await fetch(`${STATION_LIST_URL}${stationId}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ViVa station ${stationId}`);
  const json = await res.json();
  const result = json.GetSingleStationResult;
  if (!result) throw new Error(`no data for ViVa station ${stationId}`);
  const sample = (result.Samples || []).find((s) => /^medelvind/i.test(s.Name));
  if (!sample) return null;
  const speedMs = parseWindValue(sample);
  if (speedMs == null || typeof sample.Heading !== "number") return null;
  return { speedMs, dirDeg: sample.Heading, updated: sample.Updated };
}

module.exports = { slugify, fetchStationIndex, fetchStationWind };
