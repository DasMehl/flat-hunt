const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { start, TEST_VAULT_KEY, OTHER_VAULT_KEY } = require("./helpers");

const json = (h = {}) => ({ ...h, "Content-Type": "application/json" });
const withVault = (o = {}) => start({ vaultKey: TEST_VAULT_KEY, ...o });
const runServer = env => spawnSync(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { PATH: process.env.PATH, PORT: "0", SITE_PASSWORD: "pw", ...env }, timeout: 1500, encoding: "utf8" });

// ---------- Task 1: key and start-up ----------
test("without VAULT_KEY the vault routes answer 503 and the status says off", async () => {
  const s = await start();
  try {
    assert.deepEqual(await (await fetch(s.base + "/api/vault/status", { headers: s.auth })).json(), { status: "off" });
    for (const p of ["/api/vault", "/api/applicant", "/api/vault/0123456789abcdef"]) {
      const r = await fetch(s.base + p, { headers: s.auth });
      assert.equal(r.status, 503, p);
      assert.deepEqual(await r.json(), { error: "vault not configured" });
    }
    assert.ok(!fs.existsSync(path.join(s.dir, "vault")));
  } finally { await s.close(); }
});

test("with VAULT_KEY the vault is created with a key check and reported ready", async () => {
  const s = await withVault();
  try {
    assert.deepEqual(await (await fetch(s.base + "/api/vault/status", { headers: s.auth })).json(), { status: "ready" });
    assert.ok(fs.existsSync(path.join(s.dir, "vault", "keycheck.bin")));
  } finally { await s.close(); }
});

test("createApp with a wrong key keeps the vault closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-hunt-test-"));
  await (await withVault({ dataDir: dir })).close();
  const s = await start({ dataDir: dir, vaultKey: OTHER_VAULT_KEY });
  try {
    assert.deepEqual(await (await fetch(s.base + "/api/vault/status", { headers: s.auth })).json(), { status: "wrong-key" });
    assert.equal((await fetch(s.base + "/api/vault", { headers: s.auth })).status, 503);
  } finally { await s.close(); }
});

test("the server refuses to start with vault data and a missing, wrong or malformed VAULT_KEY", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-hunt-start-"));
  await (await withVault({ dataDir: dir })).close();
  const missing = runServer({ DATA_DIR: dir });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /holds data but VAULT_KEY is not set/);
  const wrong = runServer({ DATA_DIR: dir, VAULT_KEY: OTHER_VAULT_KEY });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /VAULT_KEY does not open the document vault/);
  const malformed = runServer({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "flat-hunt-start-")), VAULT_KEY: "short" });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /openssl rand -base64 32/);
  const right = runServer({ DATA_DIR: dir, VAULT_KEY: TEST_VAULT_KEY });
  assert.equal(right.status, null); // still running when the timeout kills it
  assert.match(right.stdout, /Flat Hunt on/);
  const empty = runServer({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "flat-hunt-start-")) });
  assert.equal(empty.status, null);
  assert.match(empty.stderr, /VAULT_KEY is not set/);
});

test("the server refuses a VAULT_KEY without SITE_PASSWORD, even with ALLOW_OPEN=1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-hunt-start-"));
  const r = runServer({ DATA_DIR: dir, SITE_PASSWORD: "", ALLOW_OPEN: "1", VAULT_KEY: TEST_VAULT_KEY });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /document vault needs SITE_PASSWORD/);
  const open = runServer({ DATA_DIR: dir, SITE_PASSWORD: "", ALLOW_OPEN: "1" });
  assert.equal(open.status, null);
  assert.match(open.stderr, /vault is disabled/);
});

test("the server refuses to start when the vault cannot be read", { skip: process.getuid && process.getuid() === 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-hunt-start-"));
  await (await withVault({ dataDir: dir })).close();
  const f = path.join(dir, "vault", "keycheck.bin");
  fs.chmodSync(f, 0);
  try {
    const r = runServer({ DATA_DIR: dir, VAULT_KEY: TEST_VAULT_KEY });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be read/);
  } finally { fs.chmodSync(f, 0o600); }
});
