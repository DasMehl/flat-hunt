const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultApplicant, validateApplicant } = require("../lib/applicant");

const valid = () => ({ ...defaultApplicant(), name: "Alex Example", email: "alex@example.com", phone: "+49 211 000000", job: { title: "Engineer", employer: "Example GmbH", since: "2022-04", permanent: true }, about: "Quiet household, no smokers." });
const bad = (mutate, expected) => {
  const a = valid(); mutate(a);
  const { errors, value } = validateApplicant(a);
  assert.equal(value, null);
  assert.ok(errors.some(e => e.includes(expected)), `expected "${expected}" in ${JSON.stringify(errors)}`);
};

test("a filled applicant is valid; the default needs a name", () => {
  assert.deepEqual(validateApplicant(valid()).errors, []);
  assert.equal(validateApplicant(valid()).value.name, "Alex Example");
  assert.ok(validateApplicant(defaultApplicant()).errors.some(e => e.startsWith("name:")));
  assert.notEqual(defaultApplicant(), defaultApplicant());
});

test("shape: non-object, missing and unknown fields", () => {
  assert.deepEqual(validateApplicant(null).errors, ["applicant must be an object"]);
  assert.deepEqual(validateApplicant([]).errors, ["applicant must be an object"]);
  bad(a => { delete a.household; }, "household: missing");
  bad(a => { a.iban = "x"; }, "iban: unknown field");
  bad(a => { a.job.constructor = 1; }, "job.constructor: unknown field");
  bad(a => { a.household.cats = 1; }, "household.cats: unknown field");
});

test("field rules", () => {
  bad(a => { a.name = "x".repeat(121); }, "name");
  bad(a => { a.email = "not-an-email"; }, "email");
  bad(a => { a.phone = "call me"; }, "phone");
  bad(a => { a.household.adults = 0; }, "household.adults");
  bad(a => { a.household.children = 1.5; }, "household.children");
  bad(a => { a.household.pets = "x".repeat(101); }, "household.pets");
  bad(a => { a.job.since = "2022-13"; }, "job.since");
  bad(a => { a.job.since = "2999-01"; }, "job.since: must not be in the future");
  bad(a => { a.job.permanent = "yes"; }, "job.permanent");
  bad(a => { a.schufaAvailable = 1; }, "schufaAvailable");
  bad(a => { a.landlordReferenceAvailable = null; }, "landlordReferenceAvailable");
  bad(a => { a.about = "x".repeat(1001); }, "about");
  const ok = valid(); ok.email = ""; ok.phone = ""; ok.job.since = null; ok.about = "x".repeat(1000);
  assert.deepEqual(validateApplicant(ok).errors, []);
});
