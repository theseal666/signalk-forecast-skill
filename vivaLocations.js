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

// slug -> { latitude, longitude, name }. Several ViVa stations can share a
// slug (four different "Stenungsund" sensors) — first in the list wins,
// they sit within a mile of each other.
async function fetchStationIndex() {
  const res = await fetch(STATION_LIST_URL, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ViVa station list`);
  const json = await res.json();
  const index = new Map();
  for (const s of json.GetStationsResult.Stations) {
    const slug = slugify(s.Name);
    if (!index.has(slug) && typeof s.Lat === "number" && typeof s.Lon === "number") {
      index.set(slug, { latitude: s.Lat, longitude: s.Lon, name: s.Name });
    }
  }
  return index;
}

module.exports = { slugify, fetchStationIndex };
