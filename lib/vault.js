// lib/vault.js — the encrypted vault: AES-256-GCM per file, key check, encrypted JSON blobs and stored documents.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeFileAtomic } = require("./store");

const KEYCHECK = "keycheck.bin", INDEX = "index.json", APPLICANT = "applicant.json";
const CHECK_TEXT = "flat-hunt vault v1";
const KEY_HELP = "VAULT_KEY must be 32 random bytes in base64, e.g. from: openssl rand -base64 32";

// Base64 text → 32-byte key. Throws with a readable message on anything else.
function parseVaultKey(text) {
  const s = String(text || "").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) throw new Error(KEY_HELP);
  const key = Buffer.from(s, "base64");
  if (key.length !== 32) throw new Error(KEY_HELP);
  return key;
}

// iv (12) || tag (16) || ciphertext
function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

// Throws when the key is wrong or the data was changed.
function decrypt(key, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 28) throw new Error("vault blob too short");
  const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

const encryptJson = (key, value) => encrypt(key, Buffer.from(JSON.stringify(value), "utf8"));
const decryptJson = (key, blob) => JSON.parse(decrypt(key, blob).toString("utf8"));

const vaultDir = dataDir => path.join(dataDir, "vault");
const vaultFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => !f.endsWith(".tmp")) : [];

// "empty" (nothing stored yet), "ok" (key opens the vault), "missing-key" or "wrong-key". Never writes.
function vaultStatus(dataDir, key) {
  const dir = vaultDir(dataDir), files = vaultFiles(dir);
  if (!files.length) return "empty";
  if (!key) return "missing-key";
  if (!files.includes(KEYCHECK)) return "wrong-key"; // data without a key check cannot be verified
  try { return decrypt(key, fs.readFileSync(path.join(dir, KEYCHECK))).toString("utf8") === CHECK_TEXT ? "ok" : "wrong-key"; }
  catch (e) { return "wrong-key"; }
}

// Opens (and on first use creates) the vault. Throws unless vaultStatus is "empty" or "ok".
function openVault(dataDir, key) {
  const status = vaultStatus(dataDir, key);
  if (status !== "empty" && status !== "ok") throw new Error("vault: " + status);
  const dir = vaultDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  if (status === "empty") fs.writeFileSync(path.join(dir, KEYCHECK), encrypt(key, Buffer.from(CHECK_TEXT, "utf8")));
  const readBlob = (name, fallback) => { const f = path.join(dir, name); return fs.existsSync(f) ? decryptJson(key, fs.readFileSync(f)) : fallback; };
  const docFile = name => path.join(dir, name + ".bin");
  let writing = Promise.resolve();
  const queue = fn => (writing = writing.catch(() => {}).then(fn));
  const vault = {
    index: readBlob(INDEX, { docs: {} }),
    applicant: readBlob(APPLICANT, null),
    saveIndex: () => queue(() => writeFileAtomic(path.join(dir, INDEX), encryptJson(key, vault.index))),
    saveApplicant: value => queue(() => writeFileAtomic(path.join(dir, APPLICANT), encryptJson(key, value))),
    // Documents live in <name>.bin; the index maps document ids to file names, so a replacement is a new file.
    writeDoc: (name, buf) => writeFileAtomic(docFile(name), encrypt(key, buf)),
    readDoc: async name => decrypt(key, await fs.promises.readFile(docFile(name))),
    removeDoc: name => fs.promises.unlink(docFile(name)).catch(() => {}),
    newId: () => crypto.randomBytes(8).toString("hex")
  };
  return vault;
}

// Magic bytes → MIME type, or null.
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

module.exports = { parseVaultKey, encrypt, decrypt, encryptJson, decryptJson, vaultStatus, openVault, sniffMime, KEY_HELP };
