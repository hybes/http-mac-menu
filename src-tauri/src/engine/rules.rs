// On-device alert rules, evaluated after each successful fetch. Edge
// triggered: a rule fires when its condition becomes true and re-arms after a
// cooldown (or when the condition clears for crossing rules).

use super::model::AlertRule;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RuleState {
    // ms timestamp of the last notification sent for this rule
    #[serde(default)]
    pub last_fired_ms: i64,
    // ms timestamp of the last delivery attempt that failed. This is separate
    // from `last_fired_ms`: a denied or failed notification remains eligible,
    // but is retried at a humane cadence rather than on every endpoint poll.
    #[serde(default)]
    pub last_failed_ms: i64,
    // true after a matching condition was successfully delivered; it is reset
    // when the condition clears. Failed delivery must not advance this edge.
    #[serde(default)]
    pub holding: bool,
}

const FAILED_DELIVERY_RETRY_MS: i64 = 60_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Evaluation {
    pub numeric: Option<f64>,
    pub text: String,
}

/// What a rule should be compared against. Crossing/percent rules need the
/// numeric value; text rules use the rendered value.
fn rule_operand(rule: &AlertRule, ev: &Evaluation, pct_24h: Option<f64>) -> Option<RuleValue> {
    match rule.kind.as_str() {
        "above" | "below" => ev.numeric.map(RuleValue::Number),
        "pct_up" | "pct_down" => pct_24h.map(RuleValue::Number),
        _ => Some(RuleValue::Text(ev.text.clone())),
    }
}

enum RuleValue {
    Number(f64),
    Text(String),
}

fn condition_holds(rule: &AlertRule, operand: RuleValue) -> bool {
    match operand {
        RuleValue::Number(n) => {
            let threshold =
                super::format::to_number(&serde_json::Value::String(rule.value.trim().to_string()));
            let Some(t) = threshold else { return false };
            match rule.kind.as_str() {
                "above" => n > t,
                "below" => n < t,
                "pct_up" => n >= t.abs(),
                "pct_down" => n <= -t.abs(),
                _ => false,
            }
        }
        RuleValue::Text(text) => match rule.kind.as_str() {
            "contains" => !rule.value.is_empty() && text.contains(&rule.value),
            "regex" => std::panic::catch_unwind(|| {
                regex::Regex::new(&rule.value)
                    .map(|re| re.is_match(&text))
                    .unwrap_or(false)
            })
            .unwrap_or(false),
            _ => false,
        },
    }
}

/// Returns delivery candidates without committing their cooldown or active
/// edge. The caller records the outcome with [`record_delivery_result`] after
/// the notification API accepts or rejects the delivery.
pub fn evaluate(
    rules: &[AlertRule],
    states: &mut std::collections::HashMap<String, RuleState>,
    ev: &Evaluation,
    pct_24h: Option<f64>,
) -> Vec<String> {
    evaluate_at(rules, states, ev, pct_24h, now_ms())
}

fn evaluate_at(
    rules: &[AlertRule],
    states: &mut std::collections::HashMap<String, RuleState>,
    ev: &Evaluation,
    pct_24h: Option<f64>,
    now: i64,
) -> Vec<String> {
    let mut candidates = Vec::new();
    for rule in rules {
        if rule.value.trim().is_empty() {
            continue;
        }
        let state = states.entry(rule.id.clone()).or_default();
        // Persisted wall-clock values can land in the future after a device
        // time correction. Anchor them to the new present so cooldowns remain
        // intact without suppressing the rule until the old clock catches up.
        if state.last_fired_ms > now {
            state.last_fired_ms = now;
        }
        if state.last_failed_ms > now {
            state.last_failed_ms = now;
        }
        let holds = match rule_operand(rule, ev, pct_24h) {
            Some(operand) => condition_holds(rule, operand),
            None => false,
        };
        if !holds {
            state.holding = false;
            continue;
        }

        let cooldown_ms = rule.cooldown_secs.saturating_mul(1000);
        let cooled = now.saturating_sub(state.last_fired_ms) >= cooldown_ms;
        let retry_ready = state.last_failed_ms <= 0
            || now.saturating_sub(state.last_failed_ms) >= FAILED_DELIVERY_RETRY_MS;
        // A clear-and-reenter cycle still respects cooldown, so a value
        // flapping around a threshold cannot produce a notification storm.
        // Cooldown 0 intentionally means every matching refresh.
        if cooled && retry_ready {
            candidates.push(rule.id.clone());
        }
    }
    candidates
}

/// Commits only what actually happened. A failed attempt advances the retry
/// throttle but leaves both the successful-delivery cooldown and edge intact.
pub fn record_delivery_result(
    states: &mut std::collections::HashMap<String, RuleState>,
    rule_id: &str,
    delivered: bool,
) -> bool {
    record_delivery_result_at(states, rule_id, delivered, now_ms())
}

fn record_delivery_result_at(
    states: &mut std::collections::HashMap<String, RuleState>,
    rule_id: &str,
    delivered: bool,
    now: i64,
) -> bool {
    let state = states.entry(rule_id.to_string()).or_default();
    let before = state.clone();
    if delivered {
        state.last_fired_ms = now;
        state.last_failed_ms = 0;
        state.holding = true;
    } else {
        state.last_failed_ms = now;
    }
    *state != before
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 2_000_000_000_000;

    fn above_rule(cooldown_secs: i64) -> AlertRule {
        AlertRule {
            id: "a1".into(),
            kind: "above".into(),
            value: "10".into(),
            cooldown_secs,
        }
    }

    fn numeric(value: f64) -> Evaluation {
        Evaluation {
            numeric: Some(value),
            text: value.to_string(),
        }
    }

    #[test]
    fn a_flapping_rule_still_respects_its_cooldown() {
        let rule = above_rule(3600);
        let mut states = std::collections::HashMap::new();
        assert_eq!(
            evaluate_at(
                std::slice::from_ref(&rule),
                &mut states,
                &numeric(11.0),
                None,
                NOW,
            ),
            ["a1"]
        );
        assert!(record_delivery_result_at(&mut states, "a1", true, NOW));
        assert!(evaluate_at(
            std::slice::from_ref(&rule),
            &mut states,
            &numeric(9.0),
            None,
            NOW + 1,
        )
        .is_empty());
        assert!(evaluate_at(
            std::slice::from_ref(&rule),
            &mut states,
            &numeric(11.0),
            None,
            NOW + 2,
        )
        .is_empty());
    }

    #[test]
    fn zero_cooldown_can_fire_on_every_matching_refresh() {
        let rule = above_rule(0);
        let mut states = std::collections::HashMap::new();
        assert_eq!(
            evaluate_at(
                std::slice::from_ref(&rule),
                &mut states,
                &numeric(11.0),
                None,
                NOW,
            ),
            ["a1"]
        );
        assert!(record_delivery_result_at(&mut states, "a1", true, NOW));
        assert_eq!(
            evaluate_at(
                std::slice::from_ref(&rule),
                &mut states,
                &numeric(12.0),
                None,
                NOW + 1,
            ),
            ["a1"]
        );
    }

    #[test]
    fn failed_delivery_stays_eligible_without_retrying_every_poll() {
        let rule = above_rule(300);
        let mut states = std::collections::HashMap::new();

        assert_eq!(
            evaluate_at(
                std::slice::from_ref(&rule),
                &mut states,
                &numeric(11.0),
                None,
                NOW,
            ),
            ["a1"]
        );
        assert!(record_delivery_result_at(&mut states, "a1", false, NOW,));
        let state = states.get("a1").unwrap();
        assert_eq!(state.last_fired_ms, 0);
        assert!(!state.holding);

        assert!(evaluate_at(
            std::slice::from_ref(&rule),
            &mut states,
            &numeric(11.0),
            None,
            NOW + FAILED_DELIVERY_RETRY_MS - 1,
        )
        .is_empty());
        assert_eq!(
            evaluate_at(
                std::slice::from_ref(&rule),
                &mut states,
                &numeric(11.0),
                None,
                NOW + FAILED_DELIVERY_RETRY_MS,
            ),
            ["a1"]
        );
    }

    #[test]
    fn future_persisted_timestamps_are_clamped_to_the_current_clock() {
        let rule = above_rule(300);
        let mut states = std::collections::HashMap::from([(
            "a1".to_string(),
            RuleState {
                last_fired_ms: NOW + 60_000,
                last_failed_ms: NOW + 60_000,
                holding: true,
            },
        )]);

        assert!(evaluate_at(
            std::slice::from_ref(&rule),
            &mut states,
            &numeric(11.0),
            None,
            NOW,
        )
        .is_empty());
        let state = states.get("a1").unwrap();
        assert_eq!(state.last_fired_ms, NOW);
        assert_eq!(state.last_failed_ms, NOW);
    }

    #[test]
    fn successful_retry_is_the_only_result_that_commits_delivery_state() {
        let mut states = std::collections::HashMap::new();
        assert!(record_delivery_result_at(&mut states, "a1", false, NOW,));
        assert!(record_delivery_result_at(
            &mut states,
            "a1",
            true,
            NOW + FAILED_DELIVERY_RETRY_MS,
        ));
        let state = states.get("a1").unwrap();
        assert_eq!(state.last_fired_ms, NOW + FAILED_DELIVERY_RETRY_MS);
        assert_eq!(state.last_failed_ms, 0);
        assert!(state.holding);
    }

    #[test]
    fn percent_gain_uses_the_absolute_threshold() {
        let rule = AlertRule {
            id: "gain".into(),
            kind: "pct_up".into(),
            value: "-5".into(),
            cooldown_secs: 0,
        };
        let mut states = std::collections::HashMap::new();

        assert!(evaluate_at(
            std::slice::from_ref(&rule),
            &mut states,
            &numeric(-1.0),
            Some(-1.0),
            NOW,
        )
        .is_empty());
        assert_eq!(
            evaluate_at(
                std::slice::from_ref(&rule),
                &mut states,
                &numeric(5.0),
                Some(5.0),
                NOW,
            ),
            ["gain"]
        );
    }
}
