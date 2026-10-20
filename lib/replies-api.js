// lib/replies-api.js — the routine logs landlord replies (sync key); the owner confirms or declines proposed viewing times
// (password). A documents request only records the request: documents still leave only through a share the owner creates.
const express = require("express");
const { validateReply, isoTime } = require("./replies");
const { addDocRequest } = require("./doc-requests");
const { DECIDED, MAX_MESSAGES, newId } = require("./outreach");

// ctx: { state, persist, now, requireKey, limiter }
function repliesApi(ctx) {
  const { state } = ctx;
  const router = express.Router();
  const ownerOnly = (req, res, next) => req.viaSyncKey ? res.status(403).json({ error: "not allowed with the sync key" }) : next();
  const limited = (req, res, next) => ctx.limiter.hit("routine") ? next() : res.status(429).json({ error: "too many requests" });
  const findListing = (req, res) => {
    const l = Object.hasOwn(state.listings, req.params.id) ? state.listings[req.params.id] : null;
    if (!l) res.status(404).json({ error: "unknown listing" });
    return l;
  };
  // Saves listings and meta; on failure puts the listing snapshot and the log back.
  async function save(id, l, prev, entry, res) {
    try { await ctx.persist(); return true; }
    catch (e) {
      if (state.listings[id] === l) state.listings[id] = prev;
      const i = entry ? state.meta.log.indexOf(entry) : -1; if (i >= 0) state.meta.log.splice(i, 1);
      res.status(500).json({ error: "save failed" });
      return false;
    }
  }

  router.post("/api/listings/:id/replies", ctx.requireKey, limited, async (req, res) => {
    const l = findListing(req, res);
    if (!l) return;
    const now = ctx.now(), { errors, value: v } = validateReply(req.body, now);
    if (errors.length) return res.status(400).json({ error: "invalid reply", details: errors });
    const msgs = l.messages || [];
    // Logged once: the same portal or email id, or the same text at the same time, is a repeat.
    const dup = msgs.find(m => m.dir === "in" && ((v.externalId && m.externalId === v.externalId) || (m.date === v.date && m.text === v.text)));
    if (dup) return res.json({ ok: true, repeated: true });
    if (msgs.length >= MAX_MESSAGES) return res.status(409).json({ error: "too-many-messages", reason: "too-many-messages" });
    const prev = structuredClone(l), at = now.toISOString();
    const message = { date: v.date, dir: "in", from: v.from, via: v.via, text: v.text, intent: v.intent };
    if (v.externalId) message.externalId = v.externalId;
    l.messages = [...msgs, message];
    let viewingId = null;
    if (v.intent === "viewing-invite") {
      viewingId = newId();
      l.viewings = [...(l.viewings || []), { id: viewingId, createdAt: at, proposedTimes: v.proposedTimes, status: "pending", time: null, decidedAt: null, confirmationSentAt: null }].slice(-20);
      if (!DECIDED.includes(l.status)) l.status = "viewing-invited";
    } else if (v.intent === "documents-request") {
      addDocRequest(l, v.docTypes || ["summary"], at);
    } else if (v.intent === "rejection") {
      if (l.status !== "dropped") l.status = "rejected";
      for (const x of l.viewings || []) if (x.status === "pending" || (x.status === "confirmed" && !x.confirmationSentAt)) x.status = "cancelled";
    }
    // The log names the listing and the intent, never the message text.
    const entry = { date: at.slice(0, 10), type: "reply", id: req.params.id, text: l.title, intent: v.intent };
    state.meta.log.unshift(entry);
    if (!(await save(req.params.id, l, prev, entry, res))) return;
    res.status(201).json({ ok: true, repeated: false, status: l.status, viewingId });
  });

  const findViewing = (req, res) => {
    const l = findListing(req, res);
    if (!l) return [];
    const v = (l.viewings || []).find(x => x.id === req.params.vid);
    if (!v) { res.status(404).json({ error: "unknown viewing" }); return []; }
    return [l, v];
  };

  // The owner picks one of the proposed times; the routine may then send the viewing confirmation for it.
  router.post("/api/listings/:id/viewings/:vid/confirm", ownerOnly, async (req, res) => {
    const [l, v] = findViewing(req, res);
    if (!l) return;
    const time = req.body && isoTime(req.body.time);
    if (!time || !v.proposedTimes.includes(time)) return res.status(400).json({ error: "time: one of the proposed times expected" });
    if (v.status !== "pending") return res.status(409).json({ error: "viewing is not pending" });
    const prev = structuredClone(l);
    Object.assign(v, { status: "confirmed", time, decidedAt: ctx.now().toISOString() });
    if (!(await save(req.params.id, l, prev, null, res))) return;
    res.json({ ok: true, listing: l });
  });

  // Declined: nothing is sent; the owner answers the landlord personally if they want to.
  router.post("/api/listings/:id/viewings/:vid/decline", ownerOnly, async (req, res) => {
    const [l, v] = findViewing(req, res);
    if (!l) return;
    if (!(v.status === "pending" || (v.status === "confirmed" && !v.confirmationSentAt))) return res.status(409).json({ error: "viewing cannot be declined any more" });
    const prev = structuredClone(l);
    Object.assign(v, { status: "declined", decidedAt: ctx.now().toISOString() });
    if (!(await save(req.params.id, l, prev, null, res))) return;
    res.json({ ok: true, listing: l });
  });

  return router;
}

module.exports = { repliesApi };
