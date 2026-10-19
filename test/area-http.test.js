const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../lib/area-http");
const S = require("../public/area-sources");

const answer = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => String(body) });

test("request sends the User-Agent, returns JSON or text and throws HttpError with Retry-After", async () => {
  let seen;
  const f = async (url, opts) => { seen = opts; return answer(200, { ok: 1 }); };
  assert.deepEqual(await H.request(f, "https://example.org/x"), { ok: 1 });
  assert.match(seen.headers["User-Agent"], /^flat-hunt\/.*github\.com\/DasMehl\/flat-hunt/);
  assert.equal(await H.request(async () => answer(200, "<xml/>"), "https://example.org/x", { as: "text" }), "<xml/>");
  await assert.rejects(H.request(async () => answer(429, {}, { "retry-after": "7" }), "https://example.org/x"), e => e instanceof H.HttpError && e.status === 429 && e.retryAfterMs === 7000);
});

test("request times out with Error('timeout')", async () => {
  const slow = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(H.request(slow, "https://example.org/x", { ms: 20 }), /timeout/);
});

test("withRetry backs off on 429/502/503/504 and timeouts, honours Retry-After, gives up after the last delay", async () => {
  const waits = [], sleep = async ms => { waits.push(ms); };
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new H.HttpError(502); if (n === 2) throw new H.HttpError(429, 90000); return "ok"; };
  assert.equal(await H.withRetry(flaky, { delays: [30000, 60000, 120000], sleep }), "ok");
  assert.deepEqual(waits, [30000, 90000]);
  waits.length = 0; n = 0;
  await assert.rejects(H.withRetry(async () => { n++; throw new Error("timeout"); }, { delays: [1, 2], sleep }), /timeout/);
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(H.withRetry(async () => { n++; throw new H.HttpError(400); }, { delays: [1, 2], sleep }), /HTTP 400/);
  assert.equal(n, 1, "a 400 is not retried");
});

test("createSpacer runs one call at a time with a minimum gap", async () => {
  let t = 0, active = 0, maxActive = 0;
  const waits = [], clock = () => t, sleep = async ms => { waits.push(ms); t += ms; };
  const gate = H.createSpacer(10000, { clock, sleep });
  const job = async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); t += 500; active--; return t; };
  const results = await Promise.all([gate(job), gate(job), gate(async () => { throw new Error("boom"); }).catch(e => e.message), gate(job)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(waits, [10000, 10000, 10000]);
  assert.equal(results[2], "boom");
});

test("qs encodes spaces as %20 and errorText never leaks details", () => {
  assert.equal(H.qs({ a: "1 2", b: "<x>" }), "a=1%202&b=%3Cx%3E");
  assert.equal(H.errorText(new H.HttpError(504)), "HTTP 504");
  assert.equal(H.errorText(new Error("timeout")), "timeout");
  assert.equal(H.errorText(new Error("ECONNREFUSED 10.0.0.1:443 /secret/path")), "request failed");
});

test("every area source has a name, licence, attribution and https link; dates are filled", () => {
  for (const id of S.ORDER) {
    const s = S.SOURCES[id];
    assert.ok(s && s.name && s.licence && s.attribution, id);
    assert.match(s.url, /^https:\/\//, id);
  }
  assert.deepEqual(Object.keys(S.SOURCES).sort(), [...S.ORDER].sort());
  assert.equal(S.attribution("bfg-nz", "2026-10-21T09:00:00Z"), "WasserBLIcK/BfG; Zuständige Behörden der Länder, 21.10.2026");
  assert.match(S.attribution("bkg-vg250", "2026-10-21T09:00:00Z"), /^© BKG \(2026\) dl-de\/by-2-0/);
  assert.equal(S.attribution("nope"), "");
});
