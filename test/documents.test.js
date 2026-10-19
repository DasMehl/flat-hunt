const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../lib/documents");

test("constants", () => {
  assert.deepEqual(D.DOC_TYPES, ["payslip", "contract", "schufa", "id", "rent-confirmation", "landlord-reference", "other"]);
  assert.deepEqual(D.MIMES, ["application/pdf", "image/jpeg", "image/png"]);
  assert.equal(D.MAX_BYTES, 10485760);
});

test("upload metadata: type required, label and date optional", () => {
  assert.deepEqual(D.validateDocMeta({ type: "payslip", label: " September ", date: "2026-09-30" }), { errors: [], value: { type: "payslip", label: "September", date: "2026-09-30" } });
  assert.deepEqual(D.validateDocMeta({ type: "id" }).value, { type: "id", label: "", date: null });
  assert.deepEqual(D.validateDocMeta({ type: "id", date: "" }).value, { type: "id", label: "", date: null });
  assert.deepEqual(D.validateDocMeta({}).errors, ["type: missing"]);
  assert.match(D.validateDocMeta({ type: "passport" }).errors[0], /^type: one of/);
  assert.match(D.validateDocMeta({ type: "id", date: "2026-02-30" }).errors[0], /^date:/);
  assert.match(D.validateDocMeta({ type: "id", label: "x".repeat(121) }).errors[0], /^label:/);
  assert.deepEqual(D.validateDocMeta({ type: "id", size: 1 }).errors, ["size: unknown field"]);
  assert.deepEqual(D.validateDocMeta(null).errors, ["metadata must be an object"]);
});

test("edit metadata: any subset, null clears the date, empty edits are refused", () => {
  assert.deepEqual(D.validateDocMeta({ label: "Contract" }, { partial: true }).value, { label: "Contract" });
  assert.deepEqual(D.validateDocMeta({ date: null }, { partial: true }).value, { date: null });
  assert.deepEqual(D.validateDocMeta({}, { partial: true }).errors, ["nothing to change"]);
  assert.deepEqual(D.validateDocMeta({ redactedAt: "x" }, { partial: true }).errors, ["redactedAt: unknown field"]);
});

test("payslips older than three months are outdated; other types and undated payslips never", () => {
  const now = "2026-10-20";
  assert.equal(D.isOutdated({ type: "payslip", date: "2026-07-20" }, now), false);
  assert.equal(D.isOutdated({ type: "payslip", date: "2026-07-19" }, now), true);
  assert.equal(D.isOutdated({ type: "payslip", date: null }, now), false);
  assert.equal(D.isOutdated({ type: "contract", date: "2020-01-01" }, now), false);
});

test("listDocs sorts newest first, adds the outdated flag and hides the file name", () => {
  const index = { docs: {
    a: { id: "a", file: "f1", type: "payslip", date: "2026-01-31", uploadedAt: "2026-02-01T10:00:00.000Z" },
    b: { id: "b", type: "contract", date: null, uploadedAt: "2026-10-01T10:00:00.000Z" }
  } };
  assert.deepEqual(D.listDocs(index, "2026-10-20").map(d => [d.id, d.outdated]), [["b", false], ["a", true]]);
  assert.equal(D.listDocs(index, "2026-10-20")[1].file, undefined);
});
