// lib/ratelimit.js — fixed-window request counter per key (in memory; resets on restart).
function createRateLimiter({ limit = 30, windowMs = 60000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    // true while the key is within its limit for the current window
    hit(key) {
      const t = now();
      if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      const h = hits.get(key);
      if (!h || t - h.start >= windowMs) { hits.set(key, { start: t, count: 1 }); return true; }
      h.count++;
      return h.count <= limit;
    }
  };
}

module.exports = { createRateLimiter };
