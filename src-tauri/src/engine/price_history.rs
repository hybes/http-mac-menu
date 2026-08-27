// A short rolling window of prices so
// minute-scale changes can be measured locally.

use std::collections::HashMap;

const DEFAULT_MAX_AGE_MS: i64 = 2 * 60 * 60 * 1000;

#[derive(Clone, Copy)]
struct Sample {
    t: i64,
    p: f64,
}

#[derive(Clone, Default)]
pub struct PriceHistory {
    samples: HashMap<String, Vec<Sample>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl PriceHistory {
    pub fn record(&mut self, key: &str, price: f64) {
        if !price.is_finite() {
            return;
        }
        let now = now_ms();
        let kept: Vec<Sample> = self
            .samples
            .entry(key.to_string())
            .or_default()
            .iter()
            .copied()
            .filter(|s| now - s.t <= DEFAULT_MAX_AGE_MS)
            .collect();
        let mut kept = kept;
        kept.push(Sample { t: now, p: price });
        self.samples.insert(key.to_string(), kept);
    }

    /// Percentage change against the newest sample that is at least `minutes`
    /// old (and no more than twice that), or None when we have not been
    /// running long enough to have one.
    pub fn change_since(&self, key: &str, minutes: i64, price: f64) -> Option<f64> {
        let window = minutes * 60_000;
        let target = now_ms() - window;
        let sample = self
            .samples
            .get(key)?
            .iter()
            .rfind(|s| s.t <= target && s.t >= target - window)
            .copied()?;
        if sample.p == 0.0 {
            return None;
        }
        Some(((price - sample.p) / sample.p) * 100.0)
    }
}
