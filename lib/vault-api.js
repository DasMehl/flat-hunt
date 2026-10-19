// lib/vault-api.js — password-protected routes for the applicant profile, the document vault, document requests and shares.
const express = require("express");
const { validateApplicant } = require("./applicant");
const { summaryPdf, LANGS } = require("./pdf");

// ctx: { state, vault (null when VAULT_KEY is not set or does not open the vault), vaultStatus, persist, persistShares, now }
function vaultApi(ctx) {
  const { state, vault } = ctx;
  const router = express.Router();
  const nowIso = () => ctx.now().toISOString();

  router.get("/api/vault/status", (req, res) => res.json({ status: ctx.vaultStatus }));

  const requireVault = (req, res, next) => vault ? next() : res.status(503).json({ error: "vault not configured" });
  router.use(["/api/applicant", "/api/vault", "/api/shares"], requireVault);

  // ---------- applicant ----------
  router.get("/api/applicant", (req, res) => vault.applicant ? res.json({ applicant: vault.applicant }) : res.status(404).json({ error: "no applicant" }));

  router.put("/api/applicant", async (req, res) => {
    const { errors, value } = validateApplicant(req.body);
    if (errors.length) return res.status(400).json({ error: "invalid applicant", details: errors });
    const prev = vault.applicant;
    vault.applicant = value;
    try { await vault.saveApplicant(value); }
    catch (e) { if (vault.applicant === value) vault.applicant = prev; return res.status(500).json({ error: "save failed" }); }
    res.json({ ok: true, applicant: value });
  });

  // ---------- applicant summary ----------
  const summaryLang = q => q === undefined ? (state.profile && state.profile.outreach.language) || "en" : LANGS.includes(q) ? q : null;

  router.get("/api/applicant/summary.pdf", async (req, res) => {
    const lang = summaryLang(req.query.lang);
    if (!lang) return res.status(400).json({ error: "lang: one of en, de, pt expected" });
    if (!vault.applicant) return res.status(404).json({ error: "no applicant" });
    let bytes;
    try { bytes = await summaryPdf(vault.applicant, (state.profile && state.profile.money.netIncome) || 0, lang, ctx.now()); }
    catch (e) { return res.status(500).json({ error: "pdf failed" }); }
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="applicant-summary-${lang}.pdf"`);
    res.send(Buffer.from(bytes));
  });

  return router;
}

module.exports = { vaultApi };
