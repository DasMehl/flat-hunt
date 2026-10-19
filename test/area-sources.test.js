const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { kreisUrl, parseKreis, lookupKreis } = require("../lib/kreis");
const { crimeFor } = require("../lib/crime");
const { toLaea, createRentGrid, loadRentGrid } = require("../lib/rent-grid");
const { floodUrl, parseFlood, floodAt } = require("../lib/flood");

const KOE = { lat: 51.2254, lon: 6.7787 };
const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const recorder = body => { const urls = []; const f = async url => { urls.push(url); return ok(body); }; f.urls = urls; return f; };
const noWait = { delays: [], sleep: async () => {} };

test("kreisUrl asks the VG250 WFS for the Kreis polygon under the point", () => {
  const u = new URL(kreisUrl(51.2254, 6.7787));
  assert.equal(u.origin + u.pathname, "https://sgx.geodatenzentrum.de/wfs_vg250");
  assert.equal(u.searchParams.get("TYPENAMES"), "vg250:vg250_krs");
  assert.equal(u.searchParams.get("OUTPUTFORMAT"), "application/json");
  assert.match(u.searchParams.get("FILTER"), /<fes:Intersects>.*<gml:pos>51\.2254 6\.7787<\/gml:pos>/);
  assert.ok(!kreisUrl(51.2254, 6.7787).includes("+"), "spaces are %20");
});

test("parseKreis and lookupKreis read ags, name and type", async () => {
  const body = { type: "FeatureCollection", features: [{ properties: { ags: "05111", gen: "Düsseldorf", bez: "Kreisfreie Stadt" } }] };
  assert.deepEqual(parseKreis(body), { ags: "05111", name: "Düsseldorf", type: "Kreisfreie Stadt" });
  assert.equal(parseKreis({ features: [] }), null);
  assert.equal(parseKreis({ features: [{ properties: { ags: "DE" } }] }), null);
  const f = recorder(body);
  assert.equal((await lookupKreis(KOE, f, noWait)).ags, "05111");
  assert.equal(f.urls.length, 1);
});

const TABLE = { year: 2025, columns: ["name", "kind", "total", "violent", "street", "burglary"], national: { total: 6485, violent: 250, street: 1500, burglary: 95 },
  kreise: { "05111": ["Düsseldorf", "Kreisfreie Stadt", 12999, 499, 3106, 249], "99999": ["Example-Land", "Landkreis", 3243, null, 750, 48] } };

test("crimeFor compares the Kreis rates with the national rates", () => {
  const c = crimeFor({ ags: "05111", name: "Düsseldorf" }, TABLE);
  assert.equal(c.kreis, "Düsseldorf");
  assert.equal(c.year, 2025);
  assert.deepEqual(c.hz, { total: 12999, violent: 499, street: 3106, burglary: 249 });
  assert.equal(c.ratio.total, 2);
  assert.equal(c.ratio.burglary, 2.62);
  assert.equal(crimeFor({ ags: "99999" }, TABLE).ratio.violent, null);
  assert.equal(crimeFor({ ags: "01001" }, TABLE), null);
  assert.throws(() => crimeFor({ ags: "05111" }, null), /crime table missing/);
});

test("toLaea matches the EPSG guidance example and the projection origin", () => {
  const p = toLaea(50, 5);
  assert.ok(Math.abs(p.x - 3962799.45) < 0.01 && Math.abs(p.y - 2999718.85) < 0.01, JSON.stringify(p));
  const o = toLaea(52, 10);
  assert.ok(Math.abs(o.x - 4321000) < 1e-6 && Math.abs(o.y - 3210000) < 1e-6);
});

test("the rent grid returns the cell value in euros, null for empty or outside cells", () => {
  const { x, y } = toLaea(KOE.lat, KOE.lon), cx = Math.floor(x / 1000), cy = Math.floor(y / 1000);
  const meta = { x0: cx - 1, y0: cy - 1, width: 3, height: 3 };
  const data = Buffer.alloc(18); data.writeUInt16LE(1115, (1 * 3 + 1) * 2);
  const g = createRentGrid(meta, data);
  assert.deepEqual(g.at(KOE.lat, KOE.lon), { cell: `CRS3035RES1000mN${cy * 1000}E${cx * 1000}`, eurPerSqm: 11.15 });
  assert.equal(g.at(KOE.lat + 0.012, KOE.lon), null, "the cell to the north is empty");
  assert.equal(g.at(52.52, 13.405), null, "outside the grid");
  assert.throws(() => createRentGrid(meta, Buffer.alloc(4)), /size/);
  assert.equal(loadRentGrid("/nonexistent/zensus.json"), null);
});

test("floodUrl identifies on the NZ hazard layer at the point", () => {
  const u = new URL(floodUrl(51.233, 6.765));
  assert.equal(u.origin + u.pathname, "https://geoportal.bafg.de/arcgis1/rest/services/INSPIRE/NZ/MapServer/identify");
  assert.equal(u.searchParams.get("geometry"), "6.765,51.233");
  assert.equal(u.searchParams.get("layers"), "all:1");
  assert.equal(u.searchParams.get("f"), "json");
});

test("parseFlood lists the scenarios the point lies in, worst first; an empty answer lists none", async () => {
  const hit = l => ({ layerName: "NZ.HazardArea", attributes: { LikelihoodOfOccurrence: l, NaturalHazardCategory: "flood", SpecificHazardType: "fluvial" } });
  assert.deepEqual(parseFlood({ results: [hit("low/extrem"), hit("high"), hit("medium")] }).zones, ["high", "medium", "low"]);
  assert.deepEqual(parseFlood({ results: [hit("low/extrem")] }).zones, ["low"]);
  assert.deepEqual(parseFlood({ results: [] }).zones, []);
  assert.deepEqual(parseFlood({ results: [{ attributes: { LikelihoodOfOccurrence: "high", NaturalHazardCategory: "earthquake" } }] }).zones, []);
  assert.throws(() => parseFlood({ error: { code: 500 } }), /unexpected/);
  assert.deepEqual((await floodAt(KOE, recorder({ results: [hit("medium")] }), noWait)).zones, ["medium"]);
});
