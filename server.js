// server.js — Flat Hunt: static page + JSON API. Data lives in DATA_DIR.
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readJson, writeJsonAtomic } = require("./lib/store");
const { validateProfile } = require("./lib/profile");
const { geocode } = require("./lib/geo");
const { commuteFor } = require("./lib/commute");
const { validateListingInput, requiredErrors } = require("./lib/listing");
const { warmRent } = require("./public/money");
const { parseVaultKey, vaultStatus, openVault } = require("./lib/vault");
const { vaultApi } = require("./lib/vault-api");

const STATUSES = ["new", "contacted", "viewing-invited", "viewing-done", "applied", "docs-requested", "accepted", "rejected", "dropped", "gone"];
// Fields the routine may write with the sync key (PUT /api/listings/:id). Owner fields stay page-only.
const LISTING_FIELDS = ["title", "url", "source", "mode", "coldRent", "utilities", "warmRent", "deposit", "takeover", "price", "rooms", "size", "floor", "lift", "outdoor", "kitchen", "petsAllowed", "availableFrom", "wbsRequired", "address", "postcode", "city", "district", "description", "lat", "lon", "mapsUrl", "commute", "commuteStale", "area", "contact", "photos", "rating", "redFlags", "verdict", "pros", "cons", "questions", "i18n", "addedAt", "lastSeenAt", "priceHistory", "gone"];
const LINK_FIELDS = ["url", "mapsUrl"];
const isHttpUrl = v => typeof v === "string" && /^https?:\/\//i.test(v);
const today = () => new Date().toISOString().slice(0, 10);

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  const pauseMs = options.pauseMs ?? 1000;
  const sleep = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
  const password = options.password ?? process.env.SITE_PASSWORD ?? "";
  const syncKey = options.syncKey ?? process.env.SYNC_KEY ?? "";
  const seedFile = options.seedFile || path.join(__dirname, "seed.json");
  const files = { listings: path.join(dataDir, "listings.json"), meta: path.join(dataDir, "meta.json"), profile: path.join(dataDir, "profile.json"), shares: path.join(dataDir, "shares.json") };
  fs.mkdirSync(path.join(dataDir, "img"), { recursive: true });
  const now = options.now || (() => new Date());
  // The vault opens only with the right key; otherwise its routes answer 503 (the start-up check refuses to run in that case).
  const vaultText = options.vaultKey ?? process.env.VAULT_KEY ?? "";
  const vaultKey = vaultText ? parseVaultKey(vaultText) : null;
  const vStatus = vaultStatus(dataDir, vaultKey);
  const vault = vaultKey && (vStatus === "ok" || vStatus === "empty") ? openVault(dataDir, vaultKey) : null;

  const state = {
    listings: readJson(files.listings, null),
    meta: readJson(files.meta, { lastCheck: null, log: [] }),
    profile: readJson(files.profile, null),
    shares: (readJson(files.shares, { shares: [] }).shares) || []
  };
  if (!state.listings) {
    state.listings = {};
    if (process.env.SEED === "1") {
      const seed = readJson(seedFile, { listings: {} });
      state.listings = seed.listings || {};
      state.meta.lastCheck = seed.snapshotAt || null;
    }
    fs.writeFileSync(files.listings, JSON.stringify(state.listings));
  }

  let writing = Promise.resolve();
  const persist = () => (writing = writing.catch(() => {}).then(() => Promise.all([writeJsonAtomic(files.listings, state.listings), writeJsonAtomic(files.meta, state.meta)])));

  let writingShares = Promise.resolve();
  const persistShares = () => (writingShares = writingShares.catch(() => {}).then(() => writeJsonAtomic(files.shares, { shares: state.shares })));

  const app = express();
  app.locals.state = state;
  app.locals.files = files;
  app.locals.persist = persist;
  app.locals.fetchImpl = options.fetchImpl || globalThis.fetch;
  app.locals.vault = vault;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff"); res.set("X-Frame-Options", "DENY"); res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/healthz", (req, res) => res.type("text").send("ok"));

  if (password) {
    app.use((req, res, next) => {
      const [scheme, b64] = (req.headers.authorization || "").split(" ");
      const pass = scheme === "Basic" && b64 ? Buffer.from(b64, "base64").toString().split(":").slice(1).join(":") : "";
      const a = Buffer.from(pass), b = Buffer.from(password);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
      // Header values must be Latin-1; keep printable ASCII only so any profile name is safe.
      const realm = String(state.profile && state.profile.name || "").replace(/[^\x20-\x7e]/g, "").replace(/"/g, "").trim() || "Flat Hunt";
      res.set("WWW-Authenticate", `Basic realm="${realm}"`);
      res.status(401).send("Password required");
    });
  }

  const requireKey = (req, res, next) => {
    if (!syncKey) return res.status(503).json({ error: "SYNC_KEY not configured" });
    if (req.headers["x-sync-key"] !== syncKey) return res.status(401).json({ error: "bad sync key" });
    next();
  };
  app.locals.requireKey = requireKey;
  app.use(vaultApi({ state, vault, vaultStatus: vault ? "ready" : vStatus === "empty" ? "off" : vStatus, persist, persistShares, now }));

  app.get("/api/listings", (req, res) => res.json({ listings: state.listings, updatedAt: new Date().toISOString() }));

  // Registered before every /api/listings/:id route so it is never read as an id.
  app.post("/api/listings/recalc-commute", async (req, res) => {
    const places = (state.profile && state.profile.places) || [];
    const results = new Map();
    let first = true;
    for (const [id, c] of Object.entries(state.listings)) {
      if (typeof c.lat !== "number" || typeof c.lon !== "number") continue;
      if (places.length) { if (!first) await sleep(pauseMs); first = false; }
      results.set(id, await commuteFor({ lat: c.lat, lon: c.lon }, places, app.locals.fetchImpl, { pauseMs }));
    }
    // Applied without awaiting, so a concurrent edit or delete cannot interleave.
    const before = [];
    for (const [id, c] of Object.entries(state.listings)) {
      before.push([c, c.commute, c.commuteStale, c.mapsUrl]);
      if (results.has(id)) {
        c.commute = results.get(id);
        if (places.length) c.mapsUrl = "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(places[0].address) + `&destination=${c.lat},${c.lon}`;
      }
      else if (c.commute !== undefined) c.commute = places.map(() => null);
      delete c.commuteStale;
    }
    try { await persist(); }
    catch (e) {
      for (const [c, commute, stale, maps] of before) {
        if (maps === undefined) delete c.mapsUrl; else c.mapsUrl = maps;
        if (commute === undefined) delete c.commute; else c.commute = commute;
        if (stale === undefined) delete c.commuteStale; else c.commuteStale = stale;
      }
      return res.status(500).json({ error: "save failed" });
    }
    res.json({ ok: true, updated: results.size });
  });

  app.get("/api/meta", (req, res) => res.json(state.meta));

  app.get("/api/profile", (req, res) => state.profile ? res.json(state.profile) : res.status(404).json({ error: "no profile" }));

  app.put("/api/profile", async (req, res) => {
    const { errors, value } = validateProfile(req.body);
    if (errors.length) return res.status(400).json({ error: "invalid profile", details: errors });
    const prev = state.profile, flagged = [];
    const placesChanged = JSON.stringify((prev && prev.places) || []) !== JSON.stringify(value.places);
    if (placesChanged) for (const c of Object.values(state.listings)) if (!c.commuteStale) { c.commuteStale = true; flagged.push(c); }
    state.profile = value;
    try {
      if (flagged.length) await persist();
      await writeJsonAtomic(files.profile, value);
      res.json({ ok: true, profile: value });
    } catch (e) {
      state.profile = prev;
      for (const c of flagged) delete c.commuteStale;
      res.status(500).json({ error: "save failed" });
    }
  });

  // Coordinates, commute to each of the profile's places and a route link for an address; fields stay absent when lookup fails.
  async function locate(query) {
    const out = {};
    try {
      const where = await geocode(query, app.locals.fetchImpl);
      if (where) {
        out.lat = where.lat; out.lon = where.lon;
        const places = (state.profile && state.profile.places) || [];
        out.commute = await commuteFor(where, places, app.locals.fetchImpl);
        if (places.length) out.mapsUrl = "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(places[0].address) + `&destination=${where.lat},${where.lon}`;
      }
    } catch (e) { /* commute stays empty */ }
    return out;
  }

  // Geocoding query from the address fields: "street, postcode city", any part may be missing.
  const placeQuery = l => [l.address, [l.postcode, l.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  // The amount a listing is tracked by: purchase price when buying, warm (else cold) rent when renting.
  const headline = l => l.mode === "buy" ? l.price ?? null : warmRent(l) ?? l.coldRent ?? null;
  // Copies validated input onto a listing; null clears a field. Contact name and type live in listing.contact.
  function applyInput(l, v) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "contactName" || k === "contactType") {
        const c = { ...(l.contact || {}) }, key = k === "contactName" ? "name" : "type";
        if (x === null) delete c[key]; else c[key] = x;
        if (Object.keys(c).length) l.contact = c; else delete l.contact;
      } else if (x === null) delete l[k];
      else l[k] = x;
    }
  }

  // An edit plus its derived warm rent: with cold rent and utilities both known, warm = cold + utilities. Otherwise the
  // warm rent stays, unless it was itself derived from the old cold rent and utilities. A warm rent in the edit wins.
  function applyEdit(l, v) {
    const oldWarm = l.warmRent, oldSum = l.coldRent != null && l.utilities != null ? l.coldRent + l.utilities : null;
    applyInput(l, v);
    if (("coldRent" in v || "utilities" in v) && !("warmRent" in v)) {
      if (l.coldRent != null && l.utilities != null) l.warmRent = l.coldRent + l.utilities;
      else if (oldWarm != null && oldWarm === oldSum) delete l.warmRent;
    }
  }
  // A price-history entry; rent entries also keep the cold rent.
  const historyEntry = (l, date) => l.mode === "rent" && l.coldRent != null ? { date, price: headline(l), coldRent: l.coldRent } : { date, price: headline(l) };

  const slug = s => String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

  app.get("/api/geocode", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q || q.length > 200) return res.status(400).json({ error: "query expected" });
    try { const g = await geocode(q, app.locals.fetchImpl); g ? res.json(g) : res.status(404).json({ error: "not found" }); }
    catch (e) { res.status(502).json({ error: "geocoding failed" }); }
  });

  app.post("/api/listings", async (req, res) => {
    const { errors, value: v } = validateListingInput(req.body);
    if (errors.length) return res.status(400).json({ error: "invalid listing", details: errors });

    const d = today();
    const listing = { photos: [], source: "manual", status: "new", pick: false, notes: "", nextStep: "", messages: [], addedAt: d, lastSeenAt: d };
    applyInput(listing, v);
    if (listing.mode === "rent" && listing.warmRent == null && warmRent(listing) != null) listing.warmRent = warmRent(listing);
    listing.priceHistory = [historyEntry(listing, d)];
    Object.assign(listing, await locate(placeQuery(listing)));
    // Id is chosen and stored synchronously, after the last await, so concurrent adds cannot share one.
    let id = slug(listing.title + " " + (listing.city || listing.address || "")) || "listing";
    if (state.listings[id]) { let i = 2; while (state.listings[`${id}-${i}`]) i++; id = `${id}-${i}`; }
    state.listings[id] = listing;
    const entry = { date: d, type: "new", id, text: listing.title, price: headline(listing) };
    state.meta.log.unshift(entry);
    try { await persist(); }
    catch (e) {
      delete state.listings[id];
      const at = state.meta.log.indexOf(entry);
      if (at >= 0) state.meta.log.splice(at, 1);
      return res.status(500).json({ error: "save failed" });
    }
    res.status(201).json({ ok: true, id, listing });
  });

  app.put("/api/img/:name", requireKey, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }), async (req, res) => {
    const name = req.params.name;
    if (!/^[a-z0-9][a-z0-9-]{0,80}\.(jpg|png|webp)$/.test(name)) return res.status(400).json({ error: "invalid name" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "image body expected" });
    const file = path.join(dataDir, "img", name);
    const tmp = file + ".tmp";
    try { await fs.promises.writeFile(tmp, req.body); await fs.promises.rename(tmp, file); res.json({ ok: true, path: "img/" + name }); }
    catch (e) { res.status(500).json({ error: "save failed" }); }
  });

  app.patch("/api/listings/:id", async (req, res) => {
    const c = state.listings[req.params.id];
    if (!c) return res.status(404).json({ error: "unknown listing" });
    const p = req.body;
    if (!p || typeof p !== "object" || Array.isArray(p)) return res.status(400).json({ error: "invalid update" });
    const allowed = ["status", "nextStep", "notes", "pick", "messages"];
    if (Object.keys(p).some(k => !allowed.includes(k))) return res.status(400).json({ error: "unsupported field" });
    if ("status" in p && !STATUSES.includes(p.status)) return res.status(400).json({ error: "invalid status" });
    if (["nextStep", "notes"].some(k => k in p && (typeof p[k] !== "string" || p[k].length > 10000))) return res.status(400).json({ error: "invalid text" });
    if ("pick" in p && typeof p.pick !== "boolean") return res.status(400).json({ error: "invalid pick" });
    if ("messages" in p && (!Array.isArray(p.messages) || p.messages.length > 200 || p.messages.some(m => !m || typeof m !== "object" || typeof m.text !== "string" || m.text.length > 10000))) return res.status(400).json({ error: "invalid messages" });
    const prev = structuredClone(c);
    for (const k of allowed) if (k in p) c[k] = p[k];
    try { await persist(); } catch (e) {
      if (state.listings[req.params.id] === c) state.listings[req.params.id] = prev;
      return res.status(500).json({ error: "save failed" });
    }
    res.json({ ok: true, listing: c });
  });

  // Fields that describe where the listing is; a new address makes all of them stale.
  const PLACE_FIELDS = ["lat", "lon", "commute", "commuteStale", "mapsUrl"];
  const ADDRESS_FIELDS = ["address", "postcode", "city"];

  app.patch("/api/listings/:id/listing", async (req, res) => {
    const id = req.params.id;
    if (!state.listings[id]) return res.status(404).json({ error: "unknown listing" });
    const { errors, value: v } = validateListingInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: "invalid listing", details: errors });
    const merged = { ...state.listings[id] };
    applyEdit(merged, v);
    const amountTouched = ["mode", "coldRent", "utilities", "warmRent", "price", ...ADDRESS_FIELDS].some(k => k in v);
    const mergedErrors = amountTouched ? requiredErrors(merged) : [];
    if (mergedErrors.length) return res.status(400).json({ error: "invalid listing", details: mergedErrors });
    const moved = ADDRESS_FIELDS.some(k => k in v && v[k] !== state.listings[id][k]);
    const place = moved ? await locate(placeQuery(merged)) : null;
    // Everything below runs without awaiting, so a concurrent delete or edit cannot interleave.
    const c = state.listings[id];
    if (!c) return res.status(404).json({ error: "unknown listing" });
    const prev = structuredClone(c), d = today(), before = headline(c);
    const coldBefore = c.mode === "rent" ? c.coldRent ?? null : null;
    applyEdit(c, v);
    const after = headline(c), coldAfter = c.mode === "rent" ? c.coldRent ?? null : null;
    // The headline (price, else warm rent, else cold rent) is logged when it changes; otherwise a cold-rent change.
    const field = c.mode === "buy" ? "price" : c.warmRent != null ? "warmRent" : "coldRent";
    // A derived warm rent that disappears (utilities cleared) changes the basis, not the price.
    const warmDropped = before != null && c.mode === "rent" && prev.warmRent != null && c.warmRent == null;
    let entry = null;
    if (after != null && after !== before && !warmDropped) entry = { date: d, type: "price", field, id, text: c.title, from: before, to: after };
    else if (coldAfter != null && coldBefore != null && coldAfter !== coldBefore) entry = { date: d, type: "price", field: "coldRent", id, text: c.title, from: coldBefore, to: coldAfter };
    if (entry) {
      c.priceHistory = [...(c.priceHistory || []), historyEntry(c, d)];
      state.meta.log.unshift(entry);
    }
    if (place) {
      for (const k of PLACE_FIELDS) delete c[k];
      Object.assign(c, place);
    }
    try { await persist(); }
    catch (e) {
      if (state.listings[id] === c) state.listings[id] = prev;
      const at = entry ? state.meta.log.indexOf(entry) : -1;
      if (at >= 0) state.meta.log.splice(at, 1);
      return res.status(500).json({ error: "save failed" });
    }
    res.json({ ok: true, listing: c });
  });

  app.delete("/api/listings/:id", async (req, res) => {
    const id = req.params.id, c = state.listings[id];
    if (!c) return res.status(404).json({ error: "unknown listing" });
    const log = state.meta.log;
    delete state.listings[id];
    state.meta.log = log.filter(e => e.id !== id);
    // Its share links stop working with it.
    const revoked = state.shares.filter(s => s.listingId === id && !s.revokedAt);
    const at = now().toISOString();
    for (const s of revoked) s.revokedAt = at;
    const restoreListing = () => {
      if (!state.listings[id]) state.listings[id] = c;
      if (state.meta.log.every(e => e.id !== id)) state.meta.log = [...state.meta.log, ...log.filter(e => e.id === id)].sort((a, b) => log.indexOf(a) - log.indexOf(b));
    };
    // Shares first: if only the listing write fails afterwards, the links stay revoked (fail closed).
    if (revoked.length) {
      try { await persistShares(); }
      catch (e) {
        for (const s of revoked) if (s.revokedAt === at) s.revokedAt = null;
        restoreListing();
        return res.status(500).json({ error: "save failed" });
      }
    }
    try { await persist(); }
    catch (e) { restoreListing(); return res.status(500).json({ error: "save failed" }); }
    // Photos are named <id>-N; skip files of another listing whose id itself starts with "<id>-".
    const img = path.join(dataDir, "img"), others = Object.keys(state.listings).filter(o => o.startsWith(id + "-"));
    try {
      for (const f of await fs.promises.readdir(img)) {
        if (!f.startsWith(id + "-") || others.some(o => f.startsWith(o + "-"))) continue;
        await fs.promises.unlink(path.join(img, f)).catch(() => {});
      }
    } catch (e) { /* photos stay behind; the listing is gone */ }
    res.json({ ok: true });
  });

  app.put("/api/listings/:id", requireKey, async (req, res) => {
    const id = req.params.id, incoming = req.body || {};
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const listing = Object.fromEntries(Object.entries(incoming).filter(([k, v]) => LISTING_FIELDS.includes(k) && (!LINK_FIELDS.includes(k) || isHttpUrl(v))));
    const prev = state.listings[id], snap = prev ? structuredClone(prev) : null;
    state.listings[id] = prev ? { ...prev, ...listing } : { status: "new", pick: false, notes: "", nextStep: "", messages: [], addedAt: today(), ...listing };
    if (!prev && typeof incoming.pick === "boolean") state.listings[id].pick = incoming.pick;
    const entry = prev ? null : { date: today(), type: "new", id, text: state.listings[id].title, price: headline(state.listings[id]) };
    if (entry) state.meta.log.unshift(entry);
    const written = state.listings[id];
    try { await persist(); } catch (e) {
      if (state.listings[id] === written) { if (snap) state.listings[id] = snap; else delete state.listings[id]; }
      const at = entry ? state.meta.log.indexOf(entry) : -1;
      if (at >= 0) state.meta.log.splice(at, 1);
      return res.status(500).json({ error: "save failed" });
    }
    res.json({ ok: true, created: !prev });
  });

  app.put("/api/meta", requireKey, async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some(k => k !== "lastCheck")) return res.status(400).json({ error: "unsupported field" });
    const prevCheck = state.meta.lastCheck;
    if ("lastCheck" in b) {
      if (b.lastCheck !== null && (typeof b.lastCheck !== "string" || b.lastCheck.length > 40)) return res.status(400).json({ error: "invalid lastCheck" });
      state.meta.lastCheck = b.lastCheck;
    }
    try { await persist(); } catch (e) {
      if (state.meta.lastCheck === b.lastCheck) state.meta.lastCheck = prevCheck;
      return res.status(500).json({ error: "save failed" });
    }
    res.json({ ok: true, meta: state.meta });
  });

  app.post("/api/sync", requireKey, async (req, res) => {
    const seen = (req.body && req.body.seen) || {}, d = today(), changes = [];
    const snaps = new Map(), prevCheck = state.meta.lastCheck, prevLog = state.meta.log;
    for (const [id, c] of Object.entries(state.listings)) {
      const s = seen[id];
      snaps.set(id, [c, structuredClone(c)]);
      if (s) {
        c.lastSeenAt = d;
        if (c.gone) { c.gone = false; changes.push({ date: d, type: "back", id, text: c.title }); }
        if (s.price && s.price !== c.price) { c.priceHistory = [...(c.priceHistory || []), { date: d, price: s.price }]; changes.push({ date: d, type: "price", id, text: c.title, from: c.price, to: s.price }); c.price = s.price; }
      } else if (req.body.complete && c.source !== "manual" && !c.gone && !["rejected", "dropped", "accepted", "gone"].includes(c.status)) {
        c.gone = true; c.goneAt = d; changes.push({ date: d, type: "gone", id, text: c.title });
      }
    }
    state.meta.lastCheck = req.body.checkedAt || new Date().toISOString();
    state.meta.log = [...changes, ...state.meta.log].slice(0, 200);
    const log = state.meta.log;
    try { await persist(); } catch (e) {
      for (const [id, [c, snap]] of snaps) if (state.listings[id] === c) state.listings[id] = snap;
      if (state.meta.log === log) { state.meta.lastCheck = prevCheck; state.meta.log = prevLog; }
      return res.status(500).json({ error: "save failed" });
    }
    res.json({ ok: true, changes });
  });

  app.use("/img", express.static(path.join(dataDir, "img"), { maxAge: "1d" }));
  app.use(express.static(path.join(__dirname, "public"), { index: "index.html", setHeaders: (res, p) => res.set("Cache-Control", /\.(html|json|js)$/.test(p) ? "no-cache" : "public, max-age=86400") }));
  // Body-parser errors as JSON: too large -> 413, broken JSON -> 400.
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "file too large" });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid json" });
    next(err);
  });
  return app;
}

module.exports = { createApp, LISTING_FIELDS, STATUSES };

if (require.main === module) {
  if (!process.env.SITE_PASSWORD) {
    if (process.env.ALLOW_OPEN !== "1") {
      console.error("SITE_PASSWORD is not set. Set it, or set ALLOW_OPEN=1 to run without a password (local use only).");
      process.exit(1);
    }
    if (process.env.VAULT_KEY) { console.error("The document vault needs SITE_PASSWORD. Set it; ALLOW_OPEN=1 cannot be combined with VAULT_KEY."); process.exit(1); }
    console.warn("Warning: ALLOW_OPEN=1 and no SITE_PASSWORD: anyone who can reach this server can see and edit the hunt. The document vault is disabled.");
  }
  let vaultKey = null;
  try { vaultKey = process.env.VAULT_KEY ? parseVaultKey(process.env.VAULT_KEY) : null; }
  catch (e) { console.error(e.message); process.exit(1); }
  const vs = vaultStatus(process.env.DATA_DIR || path.join(__dirname, "data"), vaultKey);
  if (vs === "missing-key") { console.error("The document vault (DATA_DIR/vault) holds data but VAULT_KEY is not set. Set the VAULT_KEY it was created with; without it the documents cannot be read."); process.exit(1); }
  if (vs === "unreadable") { console.error("The document vault (DATA_DIR/vault) cannot be read (I/O or permission error). Check the folder's permissions."); process.exit(1); }
  if (vs === "wrong-key") { console.error("VAULT_KEY does not open the document vault (DATA_DIR/vault). Set the VAULT_KEY it was created with."); process.exit(1); }
  if (!vaultKey) console.warn("VAULT_KEY is not set: the applicant profile, documents and share links are off.");
  const port = process.env.PORT || 3000;
  const app = createApp();
  const profile = app.locals.state.profile;
  app.listen(port, () => console.log(`Flat Hunt on :${port}${profile ? ` (${profile.name})` : ""}`));
}
