// lib/vault-api.js — password-protected routes for the applicant profile, the document vault, document requests and shares.
const express = require("express");
const { validateApplicant } = require("./applicant");

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

  return router;
}

module.exports = { vaultApi };
