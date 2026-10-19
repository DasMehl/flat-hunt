const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../public/area-ui.js");

test("every language has the same area strings", () => {
  const keys = o => Object.entries(o).flatMap(([k, v]) => v && typeof v === "object" ? keys(v).map(s => k + "." + s) : [k]).sort();
  for (const lang of ["de", "pt"]) assert.deepEqual(keys(ui.L[lang]), keys(ui.L.en), lang);
});

const area = {
  computedAt: "2026-10-20T10:00:00.000Z",
  amenities: { status: "ok", items: { transit: { name: "Königsallee", minutes: 3 }, supermarket: { minutes: 4 }, pharmacy: { minutes: 5 }, doctors: { minutes: 5 }, school: { minutes: 2 }, park: { minutes: 4 } } },
  flood: { status: "ok", zones: ["low"], worst: "low" },
  noise: { status: "no-data" },
  crime: { status: "error", error: "Kreis unknown" }
};

test("rating tooltip: formula, this listing's numbers and the figures not counted", () => {
  const tip = ui.ratingTip({ area }, "en");
  assert.match(tip, /^Area estimate: /);
  assert.match(tip, /\nArea ≈ 10 = everyday places 10 − flood 0\.5\n/);
  assert.match(tip, /Not counted \(no data or could not be fetched\): noise, crime\.$/);
  assert.match(ui.ratingTip({ area }, "de"), /Umgebung ≈ 10 = Alltagsorte 10 − Hochwasser 0,5/);
  assert.equal(ui.ratingTip({}, "pt"), ui.L.pt.tip.unrated);
});

test("noise bands and signed percentages", () => {
  assert.equal(ui.bandOf(65), "65–69");
  assert.equal(ui.bandOf(75), "75+");
  assert.equal(ui.signed("en", 0.08), "+8");
  assert.equal(ui.signed("de", -0.12), "−12");
  assert.equal(ui.signed("en", 0), "0");
});
