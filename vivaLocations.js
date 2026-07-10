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
    const entry = { latitude: s.Lat, longitude: s.Lon, name: s.Name, slug };
    if (!bySlug.has(slug)) bySlug.set(slug, entry);
    // ViVa API field name for station number: try ID then StationID
    const id = s.ID ?? s.StationID;
    if (id != null) byId.set(Number(id), entry);
  }
  return { bySlug, byId };
}

module.exports = { slugify, fetchStationIndex };
