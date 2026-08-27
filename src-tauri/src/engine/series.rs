// Persisted numeric observations shared by HTTP and crypto requests. This is
// deliberately independent of Tauri so retention/downsampling can be tested
// without an application runtime.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::constants::{
    SERIES_ARCHIVE_INTERVAL_MS, SERIES_GRAPH_WINDOW_MS, SERIES_HIGH_RESOLUTION_WINDOW_MS,
    SERIES_MAX_SNAPSHOT_POINTS, SERIES_MAX_STORED_POINTS, SERIES_RETENTION_MS,
    SERIES_SAMPLE_INTERVAL_MS,
};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SeriesPoint {
    pub timestamp: i64,
    pub value: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SeriesHistory {
    #[serde(default)]
    series: HashMap<String, Vec<SeriesPoint>>,
}

impl SeriesHistory {
    /// Records or updates the current high-resolution bucket. The bucket keeps
    /// the time of its first observation and the newest value seen within it;
    /// moving both forward on every fast refresh would create a sliding window
    /// that never becomes old enough for the next bucket. Returns true only
    /// when a new bucket was added, which is when durable history needs saving.
    pub fn record(&mut self, request_id: &str, timestamp: i64, value: f64) -> bool {
        if request_id.is_empty() || timestamp <= 0 || !value.is_finite() {
            return false;
        }

        let points = self.series.entry(request_id.to_string()).or_default();
        // A wall-clock correction must not pin the series to a timestamp in
        // the future for hours. Start a clean timeline; joining observations
        // from opposite sides of the clock jump would draw a false graph.
        if points
            .last()
            .is_some_and(|point| point.timestamp > timestamp)
        {
            points.clear();
        }

        if let Some(last) = points.last_mut() {
            if timestamp - last.timestamp < SERIES_SAMPLE_INTERVAL_MS {
                last.value = value;
                return false;
            }
        }

        points.push(SeriesPoint { timestamp, value });
        prune_points(points, timestamp);
        true
    }

    pub fn remove(&mut self, request_id: &str) -> bool {
        self.series.remove(request_id).is_some()
    }

    pub fn retain_request_ids<'a>(&mut self, ids: impl IntoIterator<Item = &'a str>) {
        let ids: HashSet<&str> = ids.into_iter().collect();
        self.series.retain(|id, _| ids.contains(id.as_str()));
    }

    pub fn prune(&mut self, now: i64) {
        self.series.retain(|_, points| {
            points.retain(|point| point.timestamp > 0 && point.value.is_finite());
            points.sort_by_key(|point| point.timestamp);
            points.dedup_by_key(|point| point.timestamp);
            prune_points(points, now);
            !points.is_empty()
        });
    }

    /// Returns a small, evenly sampled 24-hour series for UI/native widgets.
    /// The first and newest points are always retained.
    pub fn snapshot_points(&self, request_id: &str, now: i64) -> Vec<SeriesPoint> {
        let Some(all) = self.series.get(request_id) else {
            return Vec::new();
        };
        let cutoff = now.saturating_sub(SERIES_GRAPH_WINDOW_MS);
        let recent: Vec<SeriesPoint> = all
            .iter()
            .copied()
            .filter(|point| point.timestamp >= cutoff && point.value.is_finite())
            .collect();

        // A graph needs two points. If there is only one in the nominal
        // window, include the preceding retained observation as context.
        let points = if recent.len() == 1 && all.len() >= 2 {
            all[all.len() - 2..].to_vec()
        } else {
            recent
        };
        downsample(&points, SERIES_MAX_SNAPSHOT_POINTS)
    }

    pub fn is_empty(&self) -> bool {
        self.series.values().all(Vec::is_empty)
    }
}

fn prune_points(points: &mut Vec<SeriesPoint>, now: i64) {
    let cutoff = now.saturating_sub(SERIES_RETENTION_MS);
    let first_kept = points
        .iter()
        .position(|point| point.timestamp >= cutoff)
        .unwrap_or(points.len());
    if first_kept > 0 {
        points.drain(..first_kept);
    }
    compact_archived_points(points, now.saturating_sub(SERIES_HIGH_RESOLUTION_WINDOW_MS));
    if points.len() > SERIES_MAX_STORED_POINTS {
        let extra = points.len() - SERIES_MAX_STORED_POINTS;
        points.drain(..extra);
    }
}

/// Keeps recent observations dense while reducing older history to the newest
/// value in each absolute archive bucket. Absolute buckets make repeated prune
/// passes idempotent and retain the observation nearest the end of each period.
fn compact_archived_points(points: &mut Vec<SeriesPoint>, recent_cutoff: i64) {
    if points.len() < 2 {
        return;
    }

    let mut compacted: Vec<SeriesPoint> = Vec::with_capacity(points.len());
    for point in points.drain(..) {
        let archived = point.timestamp < recent_cutoff;
        let same_archive_bucket = archived
            && compacted.last().is_some_and(|previous| {
                previous.timestamp < recent_cutoff
                    && previous.timestamp.div_euclid(SERIES_ARCHIVE_INTERVAL_MS)
                        == point.timestamp.div_euclid(SERIES_ARCHIVE_INTERVAL_MS)
            });
        if same_archive_bucket {
            *compacted.last_mut().expect("archive bucket exists") = point;
        } else {
            compacted.push(point);
        }
    }
    *points = compacted;
}

fn downsample(points: &[SeriesPoint], limit: usize) -> Vec<SeriesPoint> {
    if points.len() <= limit || limit < 2 {
        return points.to_vec();
    }
    (0..limit)
        .map(|slot| {
            let index = slot * (points.len() - 1) / (limit - 1);
            points[index]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_samples_within_the_high_resolution_bucket() {
        let mut history = SeriesHistory::default();
        assert!(history.record("r1", 1_000_000, 10.0));
        assert!(!history.record("r1", 1_010_000, 11.0));
        let points = history.snapshot_points("r1", 1_010_000);
        assert_eq!(points.len(), 1);
        assert_eq!(
            points[0],
            SeriesPoint {
                timestamp: 1_000_000,
                value: 11.0,
            }
        );
    }

    #[test]
    fn a_backward_clock_correction_starts_a_fresh_series() {
        let mut history = SeriesHistory::default();
        assert!(history.record("r1", 2_000_000, 10.0));
        assert!(history.record("r1", 1_000_000, 11.0));
        assert_eq!(
            history.snapshot_points("r1", 1_000_000),
            vec![SeriesPoint {
                timestamp: 1_000_000,
                value: 11.0,
            }]
        );
    }

    #[test]
    fn five_second_refreshes_eventually_create_new_buckets() {
        let mut history = SeriesHistory::default();
        let start = 1_000_000;
        let added: Vec<i64> = (0..=120_000)
            .step_by(5_000)
            .filter(|offset| history.record("r1", start + *offset, *offset as f64))
            .collect();

        assert_eq!(
            added,
            vec![0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000]
        );
        let points = history.snapshot_points("r1", start + 120_000);
        assert_eq!(points.len(), 9);
        assert_eq!(points.first().unwrap().timestamp, start);
        assert_eq!(points.first().unwrap().value, 10_000.0);
        assert_eq!(points.last().unwrap().timestamp, start + 120_000);
        assert_eq!(points.last().unwrap().value, 120_000.0);
    }

    #[test]
    fn thirty_second_refreshes_eventually_create_new_buckets() {
        let mut history = SeriesHistory::default();
        let start = 2_000_000;

        assert!(history.record("r1", start, 1.0));
        assert!(history.record("r1", start + 30_000, 2.0));
        assert!(history.record("r1", start + 60_000, 3.0));
        assert!(history.record("r1", start + 90_000, 4.0));
        assert!(history.record("r1", start + 120_000, 5.0));

        assert_eq!(
            history.snapshot_points("r1", start + 120_000),
            vec![
                SeriesPoint {
                    timestamp: start,
                    value: 1.0,
                },
                SeriesPoint {
                    timestamp: start + 30_000,
                    value: 2.0,
                },
                SeriesPoint {
                    timestamp: start + 60_000,
                    value: 3.0,
                },
                SeriesPoint {
                    timestamp: start + 90_000,
                    value: 4.0,
                },
                SeriesPoint {
                    timestamp: start + 120_000,
                    value: 5.0,
                },
            ]
        );
    }

    #[test]
    fn rejects_invalid_observations() {
        let mut history = SeriesHistory::default();
        assert!(!history.record("", 1, 1.0));
        assert!(!history.record("r1", 0, 1.0));
        assert!(!history.record("r1", 1, f64::NAN));
        assert!(history.is_empty());
    }

    #[test]
    fn downsampling_keeps_both_ends() {
        let points: Vec<SeriesPoint> = (0..100)
            .map(|n| SeriesPoint {
                timestamp: n,
                value: n as f64,
            })
            .collect();
        let sampled = downsample(&points, 8);
        assert_eq!(sampled.len(), 8);
        assert_eq!(sampled.first(), points.first());
        assert_eq!(sampled.last(), points.last());
    }

    #[test]
    fn older_samples_compact_but_recent_samples_keep_their_cadence() {
        let now = SERIES_RETENTION_MS + SERIES_HIGH_RESOLUTION_WINDOW_MS;
        let start = now - SERIES_HIGH_RESOLUTION_WINDOW_MS - 10 * 60_000;
        let end = now;
        let mut history = SeriesHistory::default();
        for timestamp in (start..=end).step_by(SERIES_SAMPLE_INTERVAL_MS as usize) {
            assert!(history.record("r1", timestamp, timestamp as f64));
        }

        history.prune(now);
        let points = history.series.get("r1").unwrap();
        let archived: Vec<_> = points
            .iter()
            .filter(|point| point.timestamp < now - SERIES_HIGH_RESOLUTION_WINDOW_MS)
            .collect();
        let recent: Vec<_> = points
            .iter()
            .filter(|point| point.timestamp >= now - SERIES_HIGH_RESOLUTION_WINDOW_MS)
            .collect();

        assert!(archived.len() <= 3);
        assert_eq!(
            recent.len(),
            (SERIES_HIGH_RESOLUTION_WINDOW_MS / SERIES_SAMPLE_INTERVAL_MS + 1) as usize
        );
        assert!(recent
            .windows(2)
            .all(|pair| pair[1].timestamp - pair[0].timestamp == SERIES_SAMPLE_INTERVAL_MS));
    }

    #[test]
    fn snapshot_omits_series_with_no_points_in_the_graph_window() {
        let mut history = SeriesHistory::default();
        let start = 1_000_000;
        history.record("r1", start, 10.0);
        history.record("r1", start + SERIES_SAMPLE_INTERVAL_MS, 11.0);

        let after_graph_window = start + SERIES_GRAPH_WINDOW_MS + SERIES_SAMPLE_INTERVAL_MS + 1;
        assert!(history.snapshot_points("r1", after_graph_window).is_empty());
    }

    #[test]
    fn removing_and_retaining_drop_orphaned_series() {
        let mut history = SeriesHistory::default();
        history.record("r1", 1, 1.0);
        history.record("r2", 1, 2.0);
        history.retain_request_ids(["r2"]);
        assert!(history.snapshot_points("r1", 1).is_empty());
        assert!(history.remove("r2"));
        assert!(history.is_empty());
    }
}
