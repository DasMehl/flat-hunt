// lib/noise.js — strategic noise maps (EU round 4, 2022), Lden at a point, per federal state. Only NRW and Berlin have
// adapters; elsewhere the answer is "no data". Mapped sources only (major roads, rail, airports, industry).
const { request, withRetry, qs } = require("./area-http");
const { checkCoords } = require("./coords");

// GetFeatureInfo on one pixel in the middle of a 101 × 101 image around the point (WMS 1.3.0: EPSG:4326 axis order lat,lon).
function featureInfoUrl(base, layer, la, lo, infoFormat) {
  const [lat, lon] = checkCoords(la, lo);
  const d = 0.001;
  return base + "?" + qs({
    SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetFeatureInfo", LAYERS: layer, QUERY_LAYERS: layer, STYLES: "", CRS: "EPSG:4326",
    BBOX: [lat - d, lon - d, lat + d, lon + d].map(v => v.toFixed(6)).join(","), WIDTH: 101, HEIGHT: 101, I: 50, J: 50, INFO_FORMAT: infoFormat
  });
}

// NRW (Esri text/xml): PixelValue "70111000" → class lower bound 70 dB; "NoData" or nothing → null.
function parseNrw(text) {
  const m = /Classify\.PixelValue="(\d{2})\d*"/.exec(String(text || ""));
  const v = m ? Number(m[1]) : null;
  return v != null && v >= 45 ? v : null;
}

// Berlin (GeoServer JSON): a property like "ab 75 dB(A)" or "55 - 59 dB(A)" → 75 / 55; no feature → null.
function parseBerlin(json) {
  const f = json && Array.isArray(json.features) ? json.features[0] : null;
  if (!f || !f.properties) return null;
  for (const v of Object.values(f.properties)) {
    const m = /(\d{2})(?:[.,]\d+)?\s*(?:-|–|bis|dB)/i.exec(String(v));
    if (m && Number(m[1]) >= 45) return Number(m[1]);
  }
  return null;
}

// Keyed by the first two digits of the Kreis AGS (= state).
const ADAPTERS = {
  "05": {
    state: "NW", source: "nrw-noise", base: "https://www.wms.nrw.de/umwelt/laerm_stufe4", infoFormat: "text/xml", as: "text", parse: parseNrw,
    layers: [["road", "STR_DEN"], ["rail", "SCB_DEN"], ["tram", "SCS_DEN"], ["air", "FLG_DEN"], ["industry", "IND_DEN"]]
  },
  "11": {
    state: "BE", source: "berlin-noise", base: "https://gdi.berlin.de/services/wms/ua_stratlaerm_2022", infoFormat: "application/json", as: "json", parse: parseBerlin,
    layers: [["road", "bb_strasse_gesamt_den2022"], ["tram", "bc_tram_ubahn_den2022"], ["air", "bd_flug_gesamt_den2022"], ["industry", "be_industrie_den2022"]]
  }
};

const adapterFor = ags => (typeof ags === "string" && ADAPTERS[ags.slice(0, 2)]) || null;
const band = lower => lower == null ? null : lower >= 75 ? "75+" : `${lower}–${lower + 4}`;

// → null when the state has no adapter, else { state, source, lden: { road: 70, rail: null, … }, max, band, dominant }.
// Layers are asked one after another; any failed layer fails the whole figure (a partial answer could hide the loudest source).
async function noiseAt(point, ags, fetchImpl, { delays = [2000], sleep, ms = 10000 } = {}) {
  const a = adapterFor(ags);
  if (!a) return null;
  const lden = {};
  for (const [kind, layer] of a.layers) {
    const body = await withRetry(() => request(fetchImpl, featureInfoUrl(a.base, layer, point.lat, point.lon, a.infoFormat), { ms, as: a.as }), { delays, sleep });
    lden[kind] = a.parse(body);
  }
  let max = null, dominant = null;
  for (const [kind, v] of Object.entries(lden)) if (v != null && (max == null || v > max)) { max = v; dominant = kind; }
  return { state: a.state, source: a.source, lden, max, band: band(max), dominant };
}

module.exports = { featureInfoUrl, parseNrw, parseBerlin, noiseAt, adapterFor, band, ADAPTERS };
