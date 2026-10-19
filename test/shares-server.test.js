const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument } = require("pdf-lib");
const { start, TEST_VAULT_KEY, TINY_JPEG, pdfPageStreams, hasPdfText } = require("./helpers");
const { defaultApplicant } = require("../lib/applicant");
const { defaultProfile } = require("../lib/profile");
const { hashToken } = require("../lib/shares");

const json = (h = {}) => ({ ...h, "Content-Type": "application/json" });
const flat = { title: "2 rooms with balcony", url: "https://example.com/flat/1", source: "manual", mode: "rent", warmRent: 900, rooms: 2, size: 60, address: "Beispielstraße 1", postcode: "40210", city: "Düsseldorf", status: "contacted" };

// A vault with an applicant, a two-page PDF payslip and a JPEG id, plus one listing "flat".
async function setup(o = {}) {
  let clock = new Date("2026-10-20T10:00:00Z");
  const s = await start({ vaultKey: TEST_VAULT_KEY, now: () => clock, ...o });
  s.setClock = d => { clock = new Date(d); };
  const profile = defaultProfile(); profile.outreach.language = o.lang || "en"; profile.money.netIncome = 3200;
  await fetch(s.base + "/api/profile", { method: "PUT", headers: json(s.auth), body: JSON.stringify(profile) });
  await fetch(s.base + "/api/applicant", { method: "PUT", headers: json(s.auth), body: JSON.stringify({ ...defaultApplicant(), name: "Alex Example" }) });
  await fetch(s.base + "/api/listings/flat", { method: "PUT", headers: s.sync, body: JSON.stringify(flat) });
  const d = await PDFDocument.create(); d.addPage(); d.addPage();
  const up = (body, type, q) => fetch(s.base + "/api/vault?" + q, { method: "POST", headers: { ...s.auth, "Content-Type": type }, body }).then(r => r.json()).then(j => j.doc.id);
  s.payslip = await up(Buffer.from(await d.save()), "application/pdf", "type=payslip&date=2026-09-30");
  s.idDoc = await up(TINY_JPEG, "image/jpeg", "type=id");
  s.share = async (body = { docIds: [s.payslip, s.idDoc, "summary"] }, id = "flat") => {
    const r = await fetch(s.base + `/api/listings/${id}/shares`, { method: "POST", headers: json(s.auth), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return s;
}
const get = (s, p) => fetch(s.base + p); // no password: share links are public

// ---------- Task 5: document requests and shares (owner side) ----------
test("logging a document request stores the types and sets docs-requested", async () => {
  const s = await setup();
  try {
    const r = await fetch(s.base + "/api/listings/flat/doc-requests", { method: "POST", headers: json(s.auth), body: JSON.stringify({ types: ["payslip", "schufa", "summary"] }) });
    assert.equal(r.status, 200);
    const { listing } = await r.json();
    assert.equal(listing.status, "docs-requested");
    assert.deepEqual(listing.docRequests, [{ at: "2026-10-20T10:00:00.000Z", types: ["payslip", "schufa", "summary"] }]);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, "listings.json"), "utf8"));
    assert.equal(saved.flat.status, "docs-requested");
    for (const body of [{ types: [] }, { types: ["passport"] }, { types: ["id", "id"] }, { types: ["id"], extra: 1 }, []])
      assert.equal((await fetch(s.base + "/api/listings/flat/doc-requests", { method: "POST", headers: json(s.auth), body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
    assert.equal((await fetch(s.base + "/api/listings/nope/doc-requests", { method: "POST", headers: json(s.auth), body: JSON.stringify({ types: ["id"] }) })).status, 404);
  } finally { await s.close(); }
});

test("creating a share returns the link once and stores only the token's hash", async () => {
  const s = await setup();
  try {
    const { status, body } = await s.share();
    assert.equal(status, 201);
    assert.match(body.url, /^\/s\/[A-Za-z0-9_-]{43}$/);
    const token = body.url.slice(3);
    assert.deepEqual([body.share.listingId, body.share.docIds, body.share.subject, body.share.expiresAt, body.share.revokedAt, body.share.opens, body.share.active], ["flat", [s.payslip, s.idDoc, "summary"], "Beispielstraße 1, 40210 Düsseldorf", "2026-10-27T10:00:00.000Z", null, [], true]);
    assert.equal(body.share.tokenHash, undefined);
    const disk = fs.readFileSync(path.join(s.dir, "shares.json"), "utf8");
    assert.ok(!disk.includes(token));
    assert.ok(disk.includes(hashToken(token)));
    const list = await (await fetch(s.base + "/api/listings/flat/shares", { headers: s.auth })).json();
    assert.equal(list.shares.length, 1);
    assert.ok(!JSON.stringify(list).includes(token) && !JSON.stringify(list).includes(hashToken(token)));
  } finally { await s.close(); }
});

test("share input: days 1–30, known documents only, the summary needs an applicant, unknown listing 404", async () => {
  const s = await setup();
  try {
    assert.equal((await s.share({ docIds: [s.payslip], days: 30 })).body.share.expiresAt, "2026-11-19T10:00:00.000Z");
    assert.equal((await s.share({ docIds: [s.payslip], days: 31 })).status, 400);
    assert.equal((await s.share({ docIds: [s.payslip], days: 0 })).status, 400);
    assert.equal((await s.share({ docIds: ["0123456789abcdef"] })).status, 400);
    assert.equal((await s.share({ docIds: [] })).status, 400);
    assert.equal((await s.share({ docIds: [s.payslip] }, "nope")).status, 404);
  } finally { await s.close(); }
  const t = await start({ vaultKey: TEST_VAULT_KEY });
  try {
    await fetch(t.base + "/api/listings/flat", { method: "PUT", headers: t.sync, body: JSON.stringify(flat) });
    const r = await fetch(t.base + "/api/listings/flat/shares", { method: "POST", headers: json(t.auth), body: JSON.stringify({ docIds: ["summary"] }) });
    assert.deepEqual([r.status, (await r.json()).details], [400, ["docIds: the summary needs the applicant profile first"]]);
  } finally { await t.close(); }
});

test("revoking a share; deleting the listing revokes its shares", async () => {
  const s = await setup();
  try {
    const a = (await s.share()).body.share, b = (await s.share()).body.share;
    const r = await fetch(s.base + "/api/shares/" + a.id, { method: "DELETE", headers: s.auth });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).share.revokedAt, "2026-10-20T10:00:00.000Z");
    assert.equal((await fetch(s.base + "/api/shares/" + a.id, { method: "DELETE", headers: s.auth })).status, 200);
    assert.equal((await fetch(s.base + "/api/shares/nope", { method: "DELETE", headers: s.auth })).status, 404);
    assert.equal((await fetch(s.base + "/api/listings/flat", { method: "DELETE", headers: s.auth })).status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, "shares.json"), "utf8")).shares;
    assert.ok(saved.find(x => x.id === b.id).revokedAt);
  } finally { await s.close(); }
});

test("share routes answer 503 without a vault", async () => {
  const s = await start();
  try {
    await fetch(s.base + "/api/listings/flat", { method: "PUT", headers: s.sync, body: JSON.stringify(flat) });
    assert.equal((await fetch(s.base + "/api/listings/flat/shares", { method: "POST", headers: json(s.auth), body: JSON.stringify({ docIds: ["summary"] }) })).status, 503);
    assert.equal((await fetch(s.base + "/api/listings/flat/shares", { headers: s.auth })).status, 503);
    assert.equal((await fetch(s.base + "/api/shares/x", { method: "DELETE", headers: s.auth })).status, 503);
  } finally { await s.close(); }
});
