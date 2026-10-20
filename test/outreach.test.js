const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { outreachApp, keyOnly } = require("./outreach-fixtures");

test("templates: defaults on a fresh copy, editing makes a new unapproved version, approval names the version", async () => {
  const s = await outreachApp();
  try {
    const all = await (await s.call("GET", "/api/templates")).json();
    assert.deepEqual(all.ids, ["first-contact", "viewing-confirmation", "documents-follow", "decline"]);
    assert.deepEqual(all.langs, ["de", "en"]);
    assert.ok(all.placeholders["viewing-confirmation"].includes("viewingTime"));
    assert.equal(all.templates["first-contact"].de.approvedAt, null);
    assert.equal((await s.approve("first-contact")).status, 200);
    const approved = (await (await s.call("GET", "/api/templates")).json()).templates["first-contact"].de;
    assert.equal(approved.approvedAt, "2026-10-22T08:00:00.000Z");
    const r = await s.call("PUT", "/api/templates/first-contact/de", { body: "Guten Tag,\n\nwir möchten „{listingTitle}“ besichtigen.\n\n{name}" });
    assert.equal(r.status, 200);
    const t = (await r.json()).template;
    assert.equal(t.version, 2);
    assert.equal(t.approvedAt, null, "editing withdraws the approval");
    const stale = await s.call("POST", "/api/templates/first-contact/de/approve", { version: 1 });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "version-changed", version: 2 });
    assert.equal((await s.call("POST", "/api/templates/first-contact/de/approve", { version: 2 })).status, 200);
    assert.equal((await s.call("DELETE", "/api/templates/first-contact/de/approve")).status, 200);
    assert.equal((await (await s.call("GET", "/api/templates")).json()).templates["first-contact"].de.approvedAt, null);
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, "outreach.json"), "utf8"));
    assert.equal(onDisk.templates["first-contact"].de.version, 2);
  } finally { await s.close(); }
});

test("templates: unknown placeholders are rejected on save; unchanged text keeps the version; unknown template 404", async () => {
  const s = await outreachApp();
  try {
    const bad = await s.call("PUT", "/api/templates/decline/en", { body: "Hello {greeting}, see you at {viewingTime}. {name}" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).details[0], /unknown placeholder \{viewingTime\}/);
    const same = (await (await s.call("GET", "/api/templates")).json()).templates.decline.en.body;
    assert.equal((await (await s.call("PUT", "/api/templates/decline/en", { body: same })).json()).template.version, 1);
    assert.equal((await s.call("PUT", "/api/templates/decline/pt", { body: same })).status, 404);
    assert.equal((await s.call("PUT", "/api/templates/hello/de", { body: same })).status, 404);
    assert.equal((await s.call("PUT", "/api/templates/decline/en", { body: same, approvedAt: "x" })).status, 400);
  } finally { await s.close(); }
});

test("templates and approvals are owner-only: the sync key gets 403, with or without the password", async () => {
  const s = await outreachApp();
  try {
    for (const headers of [keyOnly, { ...keyOnly, Authorization: s.auth.Authorization }]) {
      for (const [method, p, body] of [["GET", "/api/templates"], ["PUT", "/api/templates/first-contact/de", { body: "Guten Tag, {name} schreibt Ihnen." }], ["POST", "/api/templates/first-contact/de/approve", { version: 1 }], ["DELETE", "/api/templates/first-contact/de/approve"], ["POST", "/api/templates/preview", { id: "decline", lang: "de", body: "Guten Tag, wir sagen ab. {name}" }], ["PUT", "/api/outreach/pause", { paused: false }]]) {
        assert.equal((await s.call(method, p, body, headers)).status, 403, `${method} ${p}`);
      }
    }
    assert.equal((await (await s.call("GET", "/api/templates")).json()).templates["first-contact"].de.approvedAt, null);
    assert.equal((await fetch(s.base + "/api/templates")).status, 401);
  } finally { await s.close(); }
});

test("preview fills the real applicant and an example listing (or a tracked one) and lists missing values", async () => {
  const s = await outreachApp();
  try {
    await s.addFlat("flat-1");
    const body = "{greeting},\n{name}: {household}, {job}, {income}, {moveIn} – {listingTitle}, {address} am {viewingTime}";
    const ex = await (await s.call("POST", "/api/templates/preview", { id: "viewing-confirmation", lang: "de", body })).json();
    assert.equal(ex.example, true);
    assert.deepEqual(ex.missing, []);
    assert.equal(ex.text, "Guten Tag,\nAlex Example: 2 Erwachsene, Engineer bei Example GmbH, unbefristet, 3.200 €, jederzeit – Helle 2-Zimmer-Wohnung, Beispielstraße 1, 40210 Düsseldorf am Sonntag, 25.10.2026, 09:00 Uhr", "08:00 UTC three days on, after the switch to winter time");
    const own = await (await s.call("POST", "/api/templates/preview", { id: "first-contact", lang: "en", body: "{greeting}, about {listingTitle} – {name}", listingId: "flat-1" })).json();
    assert.equal(own.example, false);
    assert.equal(own.text, "Hello, about Helle 2-Zimmer-Wohnung – Alex Example");
    const bad = await s.call("POST", "/api/templates/preview", { id: "first-contact", lang: "de", body: "Hallo {iban}, wie geht es Ihnen?" });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
  const n = await outreachApp({ applicant: false });
  try {
    const r = await (await n.call("POST", "/api/templates/preview", { id: "decline", lang: "de", body: "{greeting}, wir sagen ab. {name}" })).json();
    assert.deepEqual(r.missing, ["name"]);
  } finally { await n.close(); }
});

test("the pause switch is saved in the profile; status shows today's count, the cap and approvals", async () => {
  const s = await outreachApp();
  try {
    const r = await s.call("PUT", "/api/outreach/pause", { paused: true });
    assert.deepEqual(await r.json(), { ok: true, paused: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "profile.json"), "utf8")).outreach.paused, true);
    assert.equal((await s.call("PUT", "/api/outreach/pause", { paused: "yes" })).status, 400);
    await s.approve("first-contact");
    const st = await (await s.routine("GET", "/api/outreach/status")).json();
    assert.deepEqual(st, { enabled: true, paused: true, language: "de", minGapMin: 20, dailyCap: 3, today: { used: 0, cap: 3 }, nextAt: null, approved: { "first-contact": { de: true, en: false }, "viewing-confirmation": { de: false, en: false }, "documents-follow": { de: false, en: false }, decline: { de: false, en: false } } });
  } finally { await s.close(); }
});

test("a claim returns the filled text of the approved template; sent logs it once and marks the listing contacted", async () => {
  const s = await outreachApp();
  try {
    await s.addFlat("flat-1");
    await s.approve("first-contact");
    const r = await s.claim({ listingId: "flat-1", templateId: "first-contact" });
    assert.equal(r.status, 201);
    const { claim, text, repeated } = await r.json();
    assert.equal(repeated, false);
    assert.match(claim.id, /^[0-9a-f]{16}$/);
    assert.deepEqual({ ...claim, id: "x" }, { id: "x", listingId: "flat-1", templateId: "first-contact", lang: "de", version: 1, viewingId: null, via: "immowelt", claimedAt: "2026-10-22T08:00:00.000Z", status: "claimed", sentAt: null, releasedAt: null });
    assert.match(text, /^Guten Tag,\n\nwir interessieren uns sehr für Ihre Wohnung „Helle 2-Zimmer-Wohnung“ \(Beispielstraße 1, 40210 Düsseldorf\)\. Kurz zu uns: 2 Erwachsene, Engineer bei Example GmbH, unbefristet, Haushaltsnettoeinkommen 3\.200 € im Monat/);
    // A retry before "sent" gets the same slot and text, never a second one.
    const again = await (await s.claim({ listingId: "flat-1", templateId: "first-contact" })).json();
    assert.equal(again.repeated, true);
    assert.equal(again.claim.id, claim.id);
    assert.equal(again.text, text);
    const sent = await s.routine("POST", `/api/outreach/claims/${claim.id}/sent`);
    assert.deepEqual(await sent.json(), { ok: true, repeated: false });
    assert.deepEqual(await (await s.routine("POST", `/api/outreach/claims/${claim.id}/sent`)).json(), { ok: true, repeated: true });
    const l = s.app.locals.state.listings["flat-1"];
    assert.equal(l.status, "contacted");
    assert.equal(l.messages.length, 1);
    assert.deepEqual({ ...l.messages[0], text: "…" }, { date: "2026-10-22T08:00:00.000Z", dir: "out", from: "", via: "immowelt", text: "…", lang: "de", templateId: "first-contact", templateVersion: 1, claimId: claim.id });
    const after = await s.claim({ listingId: "flat-1", templateId: "first-contact" });
    assert.equal(after.status, 409);
    assert.equal((await after.json()).reason, "already-sent");
    const ledger = JSON.parse(fs.readFileSync(path.join(s.dir, "outreach.json"), "utf8")).claims;
    assert.equal(ledger[0].status, "sent");
    assert.equal(ledger[0].text, undefined, "the sent text lives on the listing only");
    // The log names the listing and the template, never the message or the applicant.
    const log = (await (await s.call("GET", "/api/meta")).json()).log;
    assert.deepEqual(log[0], { date: "2026-10-22", type: "sent", id: "flat-1", text: "Helle 2-Zimmer-Wohnung", template: "first-contact" });
    assert.ok(!JSON.stringify(log).includes("Alex Example"));
  } finally { await s.close(); }
});

test("claims honour enabled, pause, approval, shortlist, criteria, ImmoScout and missing values with a 409 reason", async () => {
  const s = await outreachApp({ applicant: false });
  try {
    await s.addFlat("flat-1");
    await s.addFlat("flat-2", { pick: false });
    await s.addFlat("too-dear", { warmRent: 1500, coldRent: 1350 });
    await s.addFlat("scout", { source: "immoscout", url: "https://www.immobilienscout24.de/expose/1" });
    const reason = async body => { const r = await s.claim(body); assert.equal(r.status, 409, JSON.stringify(body)); return r.json(); };
    assert.equal((await reason({ listingId: "flat-1", templateId: "first-contact" })).reason, "not-approved");
    await s.approve("first-contact");
    assert.equal((await reason({ listingId: "flat-2", templateId: "first-contact" })).reason, "not-shortlisted");
    assert.deepEqual(await reason({ listingId: "too-dear", templateId: "first-contact" }), { error: "criteria", reason: "criteria", failed: ["warm"] });
    assert.equal((await reason({ listingId: "scout", templateId: "first-contact" })).reason, "portal-not-allowed");
    assert.deepEqual(await reason({ listingId: "flat-1", templateId: "first-contact" }), { error: "missing-values", reason: "missing-values", missing: ["household", "job", "name"] });
    await s.call("PUT", "/api/outreach/pause", { paused: true });
    assert.equal((await reason({ listingId: "flat-1", templateId: "first-contact" })).reason, "paused");
    const p = s.app.locals.state.profile; await s.call("PUT", "/api/profile", { ...p, outreach: { ...p.outreach, enabled: false, paused: false } });
    assert.equal((await reason({ listingId: "flat-1", templateId: "first-contact" })).reason, "disabled");
    assert.equal(s.app.locals.state.outreach.claims.length, 0);
    assert.equal((await s.claim({ listingId: "nope", templateId: "first-contact" })).status, 404);
    for (const body of [{ listingId: "flat-1", templateId: "hello" }, { listingId: "flat-1", templateId: "first-contact", via: "immoscout" }, { listingId: "flat-1", templateId: "first-contact", lang: "pt" }, { listingId: "flat-1", templateId: "first-contact", viewingId: "0123456789abcdef" }, { listingId: "flat-1", templateId: "viewing-confirmation" }, { listingId: "flat-1", templateId: "first-contact", text: "free text" }]) {
      assert.equal((await s.claim(body)).status, 400, JSON.stringify(body));
    }
  } finally { await s.close(); }
});

test("claims keep the minimum gap and the daily cap (Berlin day), and a released slot frees the listing", async () => {
  const s = await outreachApp({ outreach: { minGapMin: 20, dailyCap: 2 } });
  try {
    await s.approve("first-contact");
    for (const id of ["a-1", "a-2", "a-3", "a-4"]) await s.addFlat(id);
    const first = await (await s.claim({ listingId: "a-1", templateId: "first-contact" })).json();
    const soon = await s.claim({ listingId: "a-2", templateId: "first-contact" });
    assert.equal(soon.status, 409);
    assert.deepEqual(await soon.json(), { error: "too-soon", reason: "too-soon", retryAt: "2026-10-22T08:20:00.000Z" });
    // Releasing a slot (nothing went out) frees the gap and the listing.
    assert.deepEqual(await (await s.routine("POST", `/api/outreach/claims/${first.claim.id}/release`)).json(), { ok: true, repeated: false, status: "released" });
    assert.equal((await s.routine("POST", `/api/outreach/claims/${first.claim.id}/sent`)).status, 409);
    const a1 = await s.claim({ listingId: "a-1", templateId: "first-contact" });
    assert.equal(a1.status, 201);
    assert.notEqual((await a1.json()).claim.id, first.claim.id);
    s.advance(20);
    assert.equal((await s.claim({ listingId: "a-2", templateId: "first-contact" })).status, 201);
    s.advance(20);
    const cap = await s.claim({ listingId: "a-3", templateId: "first-contact" });
    assert.deepEqual(await cap.json(), { error: "daily-cap", reason: "daily-cap", used: 2, cap: 2 });
    const st = await (await s.call("GET", "/api/outreach/status")).json();
    assert.deepEqual(st.today, { used: 2, cap: 2 });
    // 22:00 UTC is midnight in Berlin (CEST): a new day.
    s.clock.t = new Date("2026-10-22T22:00:00Z").getTime();
    assert.equal((await s.claim({ listingId: "a-3", templateId: "first-contact" })).status, 201);
  } finally { await s.close(); }
});

test("two claims at once never both pass the cap, the gap or once-per-listing", async () => {
  const s = await outreachApp({ outreach: { minGapMin: 5, dailyCap: 5 } });
  try {
    await s.approve("first-contact");
    await s.addFlat("b-1"); await s.addFlat("b-2");
    const rs = await Promise.all([s.claim({ listingId: "b-1", templateId: "first-contact" }), s.claim({ listingId: "b-2", templateId: "first-contact" }), s.claim({ listingId: "b-1", templateId: "first-contact" })]);
    const codes = rs.map(r => r.status).sort();
    assert.equal(codes.filter(c => c === 201).length, 1);
    assert.equal(s.app.locals.state.outreach.claims.length, 1);
  } finally { await s.close(); }
});

test("a failed save of a claim answers 500 and reserves nothing; a failed 'sent' save can be retried without a second message", async () => {
  const s = await outreachApp();
  try {
    await s.approve("first-contact");
    await s.addFlat("flat-1");
    const file = path.join(s.dir, "outreach.json");
    fs.rmSync(file); fs.mkdirSync(file);
    assert.equal((await s.claim({ listingId: "flat-1", templateId: "first-contact" })).status, 500);
    assert.equal(s.app.locals.state.outreach.claims.length, 0);
    fs.rmdirSync(file);
    const { claim } = await (await s.claim({ listingId: "flat-1", templateId: "first-contact" })).json();
    fs.rmSync(file); fs.mkdirSync(file);
    assert.equal((await s.routine("POST", `/api/outreach/claims/${claim.id}/sent`)).status, 500);
    assert.equal(s.app.locals.state.listings["flat-1"].messages.length, 1, "the message is logged on the listing");
    assert.equal(s.app.locals.state.outreach.claims[0].status, "claimed");
    fs.rmdirSync(file);
    assert.deepEqual(await (await s.routine("POST", `/api/outreach/claims/${claim.id}/sent`)).json(), { ok: true, repeated: false });
    assert.equal(s.app.locals.state.listings["flat-1"].messages.length, 1, "the retry adds no second message");
  } finally { await s.close(); }
});

test("routine calls are rate limited and oversized bodies are refused", async () => {
  const s = await outreachApp({ options: { routineRateLimit: { limit: 2 } } });
  try {
    await s.addFlat("flat-1");
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await s.claim({ listingId: "flat-1", templateId: "first-contact" })).status);
    assert.deepEqual(codes, [409, 409, 429]);
    const big = await s.call("PUT", "/api/templates/decline/de", { body: "x".repeat(70 * 1024) });
    assert.equal(big.status, 413);
  } finally { await s.close(); }
});

test("a claim released as already-contacted closes the listing for good without using the cap or the gap", async () => {
  const s = await outreachApp({ outreach: { minGapMin: 20, dailyCap: 1 } });
  try {
    await s.approve("first-contact");
    await s.addFlat("c-1"); await s.addFlat("c-2");
    const { claim } = await (await s.claim({ listingId: "c-1", templateId: "first-contact" })).json();
    assert.equal((await s.routine("POST", `/api/outreach/claims/${claim.id}/release`, { reason: "maybe" })).status, 400);
    assert.deepEqual(await (await s.routine("POST", `/api/outreach/claims/${claim.id}/release`, { reason: "already-contacted" })).json(), { ok: true, repeated: false, status: "skipped" });
    assert.equal((await (await s.claim({ listingId: "c-1", templateId: "first-contact" })).json()).reason, "already-contacted");
    assert.equal((await s.routine("POST", `/api/outreach/claims/${claim.id}/sent`)).status, 409);
    assert.equal((await s.claim({ listingId: "c-2", templateId: "first-contact" })).status, 201, "no gap and no cap used by the skipped claim");
    const log = (await (await s.call("GET", "/api/meta")).json()).log;
    assert.deepEqual(log[0], { date: "2026-10-22", type: "skipped", id: "c-1", text: "Helle 2-Zimmer-Wohnung", template: "first-contact" });
  } finally { await s.close(); }
});
