const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultApplicant } = require("../lib/applicant");
const { DOC_TYPES } = require("../lib/documents");
const browser = require("../public/vault-ui.js");

test("the applicant form starts from the same defaults as the server", () => {
  assert.deepEqual(browser.defaultApplicant(), defaultApplicant());
});

test("document types follow the server order and are named in every language", () => {
  assert.deepEqual(browser.TYPES, DOC_TYPES);
  for (const lang of ["en", "de", "pt"]) for (const t of DOC_TYPES) assert.ok(browser.L[lang].types[t], `${lang} ${t}`);
});

test("every language has the same strings", () => {
  const keys = Object.keys(browser.L.en).sort();
  for (const lang of ["de", "pt"]) assert.deepEqual(Object.keys(browser.L[lang]).sort(), keys, lang);
});
