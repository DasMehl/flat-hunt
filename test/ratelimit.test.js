const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../lib/ratelimit");

test("rate limiter: 30 per window per key, then a fresh window", () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 30, windowMs: 60000, now: () => t });
  for (let i = 0; i < 30; i++) assert.equal(rl.hit("a"), true);
  assert.equal(rl.hit("a"), false);
  assert.equal(rl.hit("b"), true);
  t = 60000;
  assert.equal(rl.hit("a"), true);
});
