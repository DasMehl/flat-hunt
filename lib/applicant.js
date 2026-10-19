// lib/applicant.js — the applicant profile (who is applying): defaults and strict validation.
const { check: { isObj, str, bool, int, nullable, obj } } = require("./profile");

function defaultApplicant() {
  return {
    name: "", email: "", phone: "",
    household: { adults: 1, children: 0, pets: "" },
    job: { title: "", employer: "", since: null, permanent: false },
    schufaAvailable: false, landlordReferenceAvailable: false,
    about: ""
  };
}

const email = (v, p, e) => { if (typeof v !== "string" || (v !== "" && (v.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))) e.push(`${p}: email address expected`); };
const phone = (v, p, e) => { if (typeof v !== "string" || (v !== "" && !/^\+?[0-9 ()\/-]{5,30}$/.test(v))) e.push(`${p}: phone number expected`); };
const month = (v, p, e) => { if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) e.push(`${p}: month YYYY-MM expected`); };

const SCHEMA = obj({
  name: str(1, 120), email, phone,
  household: obj({ adults: int(1, 10), children: int(0, 10), pets: str(0, 100) }),
  job: obj({ title: str(0, 120), employer: str(0, 120), since: nullable(month), permanent: bool }),
  schufaAvailable: bool, landlordReferenceAvailable: bool,
  about: str(0, 1000)
});

function validateApplicant(input) {
  if (!isObj(input)) return { errors: ["applicant must be an object"], value: null };
  const errors = [];
  SCHEMA(input, "", errors);
  if (!errors.length && input.job.since && input.job.since > new Date().toISOString().slice(0, 7)) errors.push("job.since: must not be in the future");
  return { errors, value: errors.length ? null : { ...input, name: input.name.trim() } };
}

module.exports = { defaultApplicant, validateApplicant };
