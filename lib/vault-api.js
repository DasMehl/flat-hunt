// lib/vault-api.js — password-protected routes for the applicant profile, the document vault, document requests and shares.
const express = require("express");

// ctx: { state, vault (null when VAULT_KEY is not set or does not open the vault), vaultStatus, persist, persistShares, now }
function vaultApi(ctx) {
  const { state, vault } = ctx;
  const router = express.Router();
  const nowIso = () => ctx.now().toISOString();

  router.get("/api/vault/status", (req, res) => res.json({ status: ctx.vaultStatus }));

  const requireVault = (req, res, next) => vault ? next() : res.status(503).json({ error: "vault not configured" });
  router.use(["/api/applicant", "/api/vault", "/api/shares"], requireVault);

  return router;
}

module.exports = { vaultApi };
