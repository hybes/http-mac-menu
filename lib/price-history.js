'use strict';

// Keeps a short rolling window of prices we have seen so the app can work out
// minute-scale changes that CoinGecko does not report. Pure apart from the
// clock, which is injectable for tests.

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

class PriceHistory {
  constructor({ now = () => Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.samples = new Map(); // key -> [{ t, p }]
  }

  record(key, price) {
    if (!Number.isFinite(price)) return;
    const now = this.now();
    const kept = (this.samples.get(key) || []).filter(
      (sample) => now - sample.t <= this.maxAgeMs
    );
    kept.push({ t: now, p: price });
    this.samples.set(key, kept);
  }

  // Percentage change against the newest sample that is at least `minutes` old
  // (and no more than twice that), or null when we have not been running long
  // enough / refreshing often enough to have one.
  changeSince(key, minutes, price) {
    const window = minutes * 60000;
    const target = this.now() - window;
    const sample = (this.samples.get(key) || [])
      .filter((s) => s.t <= target && s.t >= target - window)
      .pop();
    if (!sample || !sample.p) return null;
    return ((price - sample.p) / sample.p) * 100;
  }
}

module.exports = { PriceHistory, DEFAULT_MAX_AGE_MS };
