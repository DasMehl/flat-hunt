const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { start, TEST_VAULT_KEY, OTHER_VAULT_KEY, pdfPageStreams, hasPdfText } = require("./helpers");

const json = (h = {}) => ({ ...h, "Content-Type": "application/json" });
const withVault = (o = {}) => start({ vaultKey: TEST_VAULT_KEY, ...o });
const runServer = env => spawnSync(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { PATH: process.env.PATH, PORT: "0", SITE_PASSWORD: "pw", ...env }, timeout: 1500, encoding: "utf8" });
const { defaultApplicant } = require("../lib/applicant");
const applicant = () => ({ ...defaultApplicant(), name: "Alex Example", email: "alex@example.com", job: { title: "Engineer", employer: "Example GmbH", since: "2022-04", permanent: true } });

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

// ---------- Task 2: applicant ----------
test("applicant: 404 first, validated PUT, stored encrypted, survives a restart", async () => {
  const s = await withVault();
  try {
    assert.equal((await fetch(s.base + "/api/applicant", { headers: s.auth })).status, 404);
    const badPut = await fetch(s.base + "/api/applicant", { method: "PUT", headers: json(s.auth), body: JSON.stringify({ ...applicant(), iban: "x" }) });
    assert.equal(badPut.status, 400);
    assert.deepEqual((await badPut.json()).details, ["iban: unknown field"]);
    const put = await fetch(s.base + "/api/applicant", { method: "PUT", headers: json(s.auth), body: JSON.stringify(applicant()) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).applicant.name, "Alex Example");
    const raw = fs.readFileSync(path.join(s.dir, "vault", "applicant.json"));
    assert.ok(!raw.includes("Alex Example"));
  } finally { await s.close(); }
  const again = await withVault({ dataDir: s.dir });
  try { assert.equal((await (await fetch(again.base + "/api/applicant", { headers: again.auth })).json()).applicant.job.employer, "Example GmbH"); }
  finally { await again.close(); }
});

test("applicant: a failed save answers 500 and keeps the previous applicant", async () => {
  const s = await withVault();
  try {
    await fetch(s.base + "/api/applicant", { method: "PUT", headers: json(s.auth), body: JSON.stringify(applicant()) });
    fs.rmSync(path.join(s.dir, "vault", "applicant.json"));
    fs.mkdirSync(path.join(s.dir, "vault", "applicant.json"));
    const r = await fetch(s.base + "/api/applicant", { method: "PUT", headers: json(s.auth), body: JSON.stringify({ ...applicant(), name: "Someone Else" }) });
    assert.equal(r.status, 500);
    assert.equal((await (await fetch(s.base + "/api/applicant", { headers: s.auth })).json()).applicant.name, "Alex Example");
  } finally { await s.close(); }
});

test("vault and applicant routes need the password", async () => {
  const s = await withVault();
  try {
    for (const [m, p] of [["GET", "/api/applicant"], ["PUT", "/api/applicant"], ["GET", "/api/vault"], ["POST", "/api/vault"], ["GET", "/api/vault/status"], ["GET", "/api/applicant/summary.pdf"], ["DELETE", "/api/shares/x"], ["POST", "/api/listings/x/doc-requests"], ["POST", "/api/listings/x/shares"], ["GET", "/api/listings/x/shares"]])
      assert.equal((await fetch(s.base + p, { method: m })).status, 401, m + " " + p);
  } finally { await s.close(); }
});

// ---------- Task 3: applicant summary ----------
test("summary.pdf: 404 without applicant, 400 for an unknown language, one page with the name otherwise", async () => {
  const s = await withVault();
  try {
    assert.equal((await fetch(s.base + "/api/applicant/summary.pdf", { headers: s.auth })).status, 404);
    await fetch(s.base + "/api/applicant", { method: "PUT", headers: json(s.auth), body: JSON.stringify(applicant()) });
    assert.equal((await fetch(s.base + "/api/applicant/summary.pdf?lang=fr", { headers: s.auth })).status, 400);
    const r = await fetch(s.base + "/api/applicant/summary.pdf?lang=de", { headers: s.auth });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    const pages = await pdfPageStreams(Buffer.from(await r.arrayBuffer()));
    assert.equal(pages.length, 1);
    assert.ok(hasPdfText(pages[0], "Alex Example"));
    assert.ok(hasPdfText(pages[0], "Selbstauskunft (Kurzfassung)"));
  } finally { await s.close(); }
});
