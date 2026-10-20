const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../public/outreach-ui.js");
const { TEMPLATE_IDS, TEMPLATE_LANGS } = require("../lib/templates");
const { INTENTS } = require("../lib/replies");

test("ids, languages and intents follow the server; every language has the same strings", () => {
  assert.deepEqual(ui.TEMPLATE_IDS, TEMPLATE_IDS);
  assert.deepEqual(ui.TEMPLATE_LANGS, TEMPLATE_LANGS);
  assert.deepEqual(ui.INTENTS, INTENTS);
  const keys = o => Object.entries(o).flatMap(([k, v]) => v && typeof v === "object" ? keys(v).map(s => k + "." + s) : [k]).sort();
  for (const lang of ["de", "pt"]) assert.deepEqual(keys(ui.L[lang]), keys(ui.L.en), lang);
  for (const lang of ["en", "de", "pt"]) {
    assert.deepEqual(Object.keys(ui.L[lang].names), TEMPLATE_IDS, lang);
    assert.deepEqual(Object.keys(ui.L[lang].intents), INTENTS, lang);
  }
});

test("the header switch shows the state and today's count; nothing when outreach is off", () => {
  const st = { enabled: true, paused: false, today: { used: 3, cap: 10 } };
  assert.deepEqual(ui.switchState(st, "en"), { paused: false, label: "Sending on · 3/10 today", title: ui.L.en.pauseTip });
  assert.equal(ui.switchState({ ...st, paused: true }, "de").label, "Senden pausiert · 3/10 heute");
  assert.equal(ui.switchState({ ...st, enabled: false }, "en"), null);
  assert.equal(ui.switchState(null, "en"), null);
});

test("message tags: template with version and language for outgoing, intent for incoming", () => {
  assert.equal(ui.messageTag({ dir: "out", templateId: "first-contact", templateVersion: 2, lang: "de" }, "en"), "Template: First contact · v2 · DE");
  assert.equal(ui.messageTag({ dir: "in", intent: "viewing-invite" }, "de"), "Besichtigungseinladung");
  assert.equal(ui.messageTag({ dir: "in", text: "by hand" }, "en"), null);
});

test("viewing texts in Berlin time", () => {
  assert.equal(ui.viewingText({ status: "confirmed", time: "2026-10-27T17:00:00.000Z", confirmationSentAt: null }, "en"), "Viewing confirmed: Tue 27 Oct, 18:00 " + ui.L.en.confirmationPending);
  assert.equal(ui.viewingText({ status: "pending", proposedTimes: [] }, "en"), ui.L.en.noTimes);
  assert.equal(ui.viewingText({ status: "cancelled" }, "pt"), ui.L.pt.cancelled);
});
