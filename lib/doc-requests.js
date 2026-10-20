// lib/doc-requests.js — a landlord asked for documents: record which and move the listing to "docs-requested".
// Shared by the owner's route (lib/vault-api.js) and the routine's reply log (lib/replies-api.js). Documents still leave
// only through a share the owner creates.
const { DOC_TYPES } = require("./documents");
const { SUMMARY_ID } = require("./shares");

const REQUEST_TYPES = [...DOC_TYPES, SUMMARY_ID];
const DECIDED = ["accepted", "rejected", "dropped", "gone"];

// Applies the request and returns a function that undoes it (for a failed save).
function addDocRequest(l, types, at) {
  const prev = { docRequests: l.docRequests, status: l.status };
  l.docRequests = [...(l.docRequests || []), { at, types }].slice(-50);
  if (!DECIDED.includes(l.status)) l.status = "docs-requested";
  return () => {
    if (prev.docRequests === undefined) delete l.docRequests; else l.docRequests = prev.docRequests;
    l.status = prev.status;
  };
}

module.exports = { REQUEST_TYPES, addDocRequest };
