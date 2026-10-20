// lib/outreach.js — the outreach ledger (DATA_DIR/outreach.json): templates with their approvals and the routine's send
// slots ("claims"). Pure functions; lib/outreach-api.js holds the routes.
const crypto = require("crypto");
const { checkCriteria } = require("../public/criteria");
const { TEMPLATE_IDS, TEMPLATE_LANGS, defaultTemplates, isoDay } = require("./templates");

const VIAS = ["immowelt", "kleinanzeigen", "wg-gesucht", "email"];
const DECIDED = ["accepted", "rejected", "dropped", "gone"];
const MAX_MESSAGES = 200;
const KEEP_RELEASED_DAYS = 30;
const CLAIM_TTL_H = 24;
const RETRY_LIMIT = 3;

const newId = () => crypto.randomBytes(8).toString("hex");

// A missing or older file becomes a complete one: every template in both languages, an empty claim list.
function normaliseOutreach(data, now = new Date()) {
  const d = data && typeof data === "object" ? data : {};
  const fresh = defaultTemplates(now), templates = {};
  for (const id of TEMPLATE_IDS) {
    templates[id] = {};
    for (const lang of TEMPLATE_LANGS) templates[id][lang] = (d.templates && d.templates[id] && d.templates[id][lang]) || fresh[id][lang];
  }
  return { version: 1, templates, claims: Array.isArray(d.claims) ? d.claims : [] };
}

// One send slot per listing and template; a viewing confirmation once per viewing.
const claimKey = (listingId, templateId, viewingId) => [listingId, templateId, viewingId].filter(Boolean).join(":");

// Claims that count against the daily cap and the spacing: reserved or sent, not released.
const counted = claims => claims.filter(c => c.status === "claimed" || c.status === "sent");
const usedToday = (claims, now) => counted(claims).filter(c => isoDay(new Date(c.claimedAt)) === isoDay(now)).length;
// The earliest time the next slot may be claimed (null = now).
function nextSlotAt(claims, minGapMin, now) {
  const last = counted(claims).reduce((m, c) => Math.max(m, Date.parse(c.claimedAt)), -Infinity);
  const at = last + minGapMin * 60000;
  return at > now.getTime() ? new Date(at).toISOString() : null;
}

const hasMessage = (l, claimId) => (l.messages || []).some(m => m.claimId === claimId);
function isScoutUrl(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return h === "immobilienscout24.de" || h.endsWith(".immobilienscout24.de"); }
  catch (e) { return false; }
}

const hasOutgoing = l => (l.messages || []).some(m => m.dir === "out");

// Why this template may not go to this listing now, or null. Called after the pause and approval checks.
function ineligible({ templateId, listing: l, viewing, profile, catalogue, others }) {
  if (l.source === "immoscout" || isScoutUrl(l.url)) return { reason: "portal-not-allowed" };
  if (l.gone) return { reason: "gone" };
  if ((l.messages || []).length >= MAX_MESSAGES) return { reason: "too-many-messages" };
  if (templateId === "first-contact") {
    if (hasOutgoing(l) || l.status !== "new") return { reason: "already-contacted" };
    if (l.pick !== true) return { reason: "not-shortlisted" };
    const failed = checkCriteria(l, profile, catalogue, others);
    if (failed.length) return { reason: "criteria", failed: [...new Set(failed.map(f => f.key === "flag" ? "flag:" + f.value : f.key))] };
    return null;
  }
  if (templateId === "viewing-confirmation") {
    if (!viewing || viewing.status !== "confirmed" || !viewing.time) return { reason: "no-confirmed-viewing" };
    if (viewing.confirmationSentAt) return { reason: "already-sent" };
    return null;
  }
  if (templateId === "documents-follow") return l.status === "docs-requested" ? null : { reason: "no-doc-request" };
  if (templateId === "decline") return l.status === "dropped" && hasOutgoing(l) ? null : { reason: "not-dropped" };
  return { reason: "unknown-template" };
}

// Drops released claims after 30 days and releases claims nobody reported on within 24 hours; neither keeps its text.
// Sent claims stay (they keep "never twice" true) but without their text. Returns a new list; changed claims are new objects.
function prune(claims, now) {
  const limit = now.getTime() - KEEP_RELEASED_DAYS * 86400000, stale = now.getTime() - CLAIM_TTL_H * 3600000;
  const out = [];
  for (const c of claims) {
    if (c.status === "claimed" && Date.parse(c.claimedAt) < stale) {
      const { text, ...rest } = c;
      out.push({ ...rest, status: "released", releasedAt: now.toISOString(), releaseReason: "expired" });
    } else if (c.status !== "released" || Date.parse(c.releasedAt || c.claimedAt) >= limit) out.push(c);
  }
  return out;
}

module.exports = { VIAS, DECIDED, MAX_MESSAGES, newId, normaliseOutreach, claimKey, counted, usedToday, nextSlotAt, hasOutgoing, ineligible, prune, hasMessage, RETRY_LIMIT };
