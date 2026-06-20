// A tiny per-key token bucket (one bucket per IP) for registration throttling. In-memory
// is fine: limits are best-effort abuse friction, not security, and reset on restart.

export function makeRateLimit({ perHour }) {
  const buckets = new Map(); // key -> { count, resetAt }

  return {
    /** Consume one token for `key`; false once the per-hour allowance is exhausted. */
    allow(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now > b.resetAt) {
        b = { count: 0, resetAt: now + 3_600_000 };
        buckets.set(key, b);
      }
      if (b.count >= perHour) return false;
      b.count++;
      return true;
    },
  };
}
