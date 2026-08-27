// A request, its stored shape, and the alert rules that hang off it.

use super::constants::{
    default_refresh_for_provider, min_refresh_for_provider, min_refresh_seconds,
    LEGACY_CONFIG_COUNT, SETTINGS_SCHEMA_VERSION, UNTRIMMED_FIELDS,
};

pub use super::constants::MAX_REQUESTS;
use super::format::{parse_refresh_seconds_with_limits, to_number};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// All editable fields, in UI order. Values are kept as strings so a
/// hand-edited or half-written settings file can never crash a load.
pub const FIELDS: [&str; 15] = [
    "type",
    "label",
    "url",
    "headers",
    "json",
    "multiplier",
    "provider",
    "coin",
    "holdings",
    "currency",
    "template",
    "length",
    "prefix",
    "suffix",
    "timer",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertRule {
    #[serde(default)]
    pub id: String,
    // above | below | pct_up | pct_down | contains | regex
    pub kind: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_cooldown")]
    pub cooldown_secs: i64,
}

fn default_cooldown() -> i64 {
    300
}

impl AlertRule {
    pub fn sanitized(&self, index: usize) -> AlertRule {
        AlertRule {
            id: if self.id.trim().is_empty() {
                format!("a{}", index + 1)
            } else {
                self.id.trim().to_string()
            },
            kind: match self.kind.as_str() {
                "above" | "below" | "pct_up" | "pct_down" | "contains" | "regex" => {
                    self.kind.clone()
                }
                _ => "above".to_string(),
            },
            value: self.value.trim().to_string(),
            cooldown_secs: self.cooldown_secs.clamp(0, 24 * 3600),
        }
    }
}

/// Normalise rule ids as a collection. Sanitising each rule independently is
/// not enough: duplicated ids share one cooldown state and can make the
/// scheduler describe or deliver the wrong rule.
pub fn normalize_alert_rules(rules: impl IntoIterator<Item = AlertRule>) -> Vec<AlertRule> {
    let mut used = HashSet::new();
    rules
        .into_iter()
        .enumerate()
        .map(|(index, rule)| {
            let mut rule = rule.sanitized(index);
            if !used.insert(rule.id.clone()) {
                let mut suffix = index + 1;
                loop {
                    let candidate = format!("a{suffix}");
                    suffix += 1;
                    if used.insert(candidate.clone()) {
                        rule.id = candidate;
                        break;
                    }
                }
            }
            rule
        })
        .collect()
}

/// Read stored alerts independently so one damaged entry does not erase every
/// otherwise valid rule in the same request.
fn alerts_from_value(value: Option<&serde_json::Value>) -> Vec<AlertRule> {
    let rules = value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| serde_json::from_value::<AlertRule>(entry.clone()).ok());
    normalize_alert_rules(rules)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: String,
    #[serde(default)]
    pub json: String,
    #[serde(default)]
    pub multiplier: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub coin: String,
    #[serde(default)]
    pub holdings: String,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub template: String,
    #[serde(default)]
    pub length: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub timer: String,
    #[serde(default)]
    pub alerts: Vec<AlertRule>,
}

impl Request {
    pub fn crypto(&self) -> bool {
        self.kind == "crypto"
    }

    pub fn crypto_provider(&self) -> &str {
        match self.provider.as_str() {
            "jupiter" | "dexscreener" | "coingecko" => self.provider.as_str(),
            _ => "auto",
        }
    }

    fn refresh_policy_provider(&self) -> &'static str {
        super::crypto_route::refresh_policy_provider(
            self.crypto_provider(),
            &self.coin,
            &self.currency,
        )
    }

    pub fn min_refresh_seconds(&self) -> i64 {
        min_refresh_for_provider(self.crypto(), self.refresh_policy_provider())
    }

    pub fn default_refresh_seconds(&self) -> i64 {
        default_refresh_for_provider(self.crypto(), self.refresh_policy_provider())
    }

    /// A request counts as set up once it has the one field its type needs.
    pub fn configured(&self) -> bool {
        let key = if self.crypto() { &self.coin } else { &self.url };
        !key.trim().is_empty()
    }

    /// Whether an edit still represents the same numeric time series. Names,
    /// display formatting and alert rules do not invalidate a graph; changing
    /// the source or the numeric transformation does.
    pub fn same_series_as(&self, other: &Request) -> bool {
        if self.kind != other.kind {
            return false;
        }
        if self.crypto() {
            self.crypto_provider() == other.crypto_provider()
                && self.coin == other.coin
                && self.holdings == other.holdings
                && self.currency == other.currency
        } else {
            self.url == other.url
                && self.headers == other.headers
                && self.json == other.json
                && self.multiplier == other.multiplier
        }
    }

    /// Validate values whose invalid form would otherwise change semantics or
    /// silently disable an alert. Blank holdings deliberately mean unit price.
    pub fn validate_for_save(&self) -> Result<(), String> {
        if self.crypto()
            && !self.holdings.trim().is_empty()
            && to_number(&serde_json::Value::String(self.holdings.clone())).is_none()
        {
            return Err(
                "Holdings must be a finite number (use a decimal point and no commas).".into(),
            );
        }

        if self.crypto()
            && self.crypto_provider() == "dexscreener"
            && !self.currency.trim().is_empty()
            && !self.currency.eq_ignore_ascii_case("usd")
        {
            return Err("DEX Screener quotes USD only.".into());
        }

        if self.crypto()
            && self.crypto_provider() == "jupiter"
            && !super::crypto_route::jupiter_currency_supported(&self.currency)
        {
            return Err(
                "Jupiter conversion needs a three-letter currency code such as GBP or EUR.".into(),
            );
        }

        for (index, rule) in self.alerts.iter().enumerate() {
            let label = format!("Alert {}", index + 1);
            if rule.value.trim().is_empty() {
                return Err(format!("{label} needs a value."));
            }
            match rule.kind.as_str() {
                "above" | "below" | "pct_up" | "pct_down" => {
                    if to_number(&serde_json::Value::String(rule.value.clone())).is_none() {
                        return Err(format!("{label} needs a finite numeric threshold."));
                    }
                }
                "regex" => {
                    regex::Regex::new(&rule.value)
                        .map_err(|error| format!("{label} has an invalid regex: {error}"))?;
                }
                "contains" => {}
                _ => return Err(format!("{label} has an unsupported condition.")),
            }
        }
        Ok(())
    }
}

fn get_str(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    match map.get(key) {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(v @ serde_json::Value::Number(_)) => Some(v.to_string()),
        Some(serde_json::Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

/// Port of sanitizeConfig: every field becomes a trimmed string, prefix and
/// suffix keep their whitespace, type snaps to http/crypto and timer is
/// normalised through parseRefreshSeconds.
pub fn sanitize_values(values: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    let empty = serde_json::Map::new();
    let src = values.as_object().unwrap_or(&empty);
    let mut clean = serde_json::Map::new();
    for field in FIELDS {
        let raw = get_str(src, field).unwrap_or_default();
        let trimmed = if UNTRIMMED_FIELDS.contains(&field) {
            raw
        } else {
            raw.trim().to_string()
        };
        clean.insert(field.to_string(), serde_json::Value::String(trimmed));
    }
    let kind = clean["type"].as_str().unwrap().to_string();
    clean.insert(
        "type".into(),
        serde_json::Value::String(if kind == "crypto" {
            "crypto".into()
        } else {
            "http".into()
        }),
    );
    let provider = clean["provider"].as_str().unwrap_or_default();
    clean.insert(
        "provider".into(),
        serde_json::Value::String(
            match provider {
                "jupiter" | "dexscreener" | "coingecko" => provider,
                _ => "auto",
            }
            .into(),
        ),
    );
    if !clean["timer"].as_str().unwrap().is_empty() {
        let crypto = kind == "crypto";
        let provider = clean["provider"].as_str().unwrap_or("auto");
        let refresh_provider = super::crypto_route::refresh_policy_provider(
            provider,
            clean["coin"].as_str().unwrap_or_default(),
            clean["currency"].as_str().unwrap_or_default(),
        );
        let secs = parse_refresh_seconds_with_limits(
            clean["timer"].as_str().unwrap(),
            min_refresh_for_provider(crypto, refresh_provider),
            default_refresh_for_provider(crypto, refresh_provider),
        );
        clean.insert("timer".into(), serde_json::Value::String(secs.to_string()));
    }
    clean
}

/// Build a request under a caller-chosen id from already-sanitized values.
pub fn request_from_clean(
    id: &str,
    values: &serde_json::Map<String, serde_json::Value>,
) -> Request {
    request_from_values(id.to_string(), values)
}

pub fn make_request_with_id(
    id: String,
    values: &serde_json::Map<String, serde_json::Value>,
) -> Request {
    request_from_values(id, values)
}

fn request_from_values(id: String, values: &serde_json::Map<String, serde_json::Value>) -> Request {
    let alerts = alerts_from_value(values.get("alerts"));
    let str_field = |name: &str| {
        values
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let kind = str_field("type");
    Request {
        id,
        kind: if kind == "crypto" {
            "crypto".into()
        } else {
            "http".into()
        },
        label: str_field("label"),
        url: str_field("url"),
        headers: str_field("headers"),
        json: str_field("json"),
        multiplier: str_field("multiplier"),
        provider: str_field("provider"),
        coin: str_field("coin"),
        holdings: str_field("holdings"),
        currency: str_field("currency"),
        template: str_field("template"),
        length: str_field("length"),
        prefix: str_field("prefix"),
        suffix: str_field("suffix"),
        timer: str_field("timer"),
        alerts,
    }
}

pub fn blank_request() -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    for field in FIELDS {
        m.insert(field.to_string(), serde_json::Value::String(String::new()));
    }
    m.insert("provider".into(), serde_json::Value::String("auto".into()));
    m.insert("alerts".into(), serde_json::Value::Array(vec![]));
    m
}

/// Ids only have to be unique and stable, so the lowest free one will do.
pub fn next_id(requests: &[Request]) -> String {
    let used: std::collections::HashSet<&str> = requests.iter().map(|r| r.id.as_str()).collect();
    for i in 1.. {
        let candidate = format!("r{i}");
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
    }
    unreachable!()
}

pub fn make_request(values: &serde_json::Value, existing: &[Request]) -> Request {
    let clean = sanitize_values(values);
    request_from_values(next_id(existing), &clean)
}

/// Anything read back from disk goes through here.
pub fn normalize_requests(raw: &serde_json::Value) -> Vec<Request> {
    let Some(entries) = raw.as_array() else {
        return vec![];
    };
    let mut requests: Vec<Request> = Vec::new();
    for entry in entries {
        if requests.len() >= MAX_REQUESTS {
            break;
        }
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let id = obj
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| next_id(&requests));
        if requests.iter().any(|r| r.id == id) {
            continue;
        }
        let mut clean = sanitize_values(entry);
        // Alerts are structured rather than string fields, so carry the raw
        // array into `request_from_values`, which sanitizes every rule.
        if let Some(alerts) = obj.get("alerts") {
            clean.insert("alerts".into(), alerts.clone());
        }
        requests.push(request_from_values(id, &clean));
    }
    requests
}

/// Before schema 1 the refresh interval was written in milliseconds.
fn convert_legacy_millisecond_timers(stored: &mut serde_json::Map<String, serde_json::Value>) {
    for n in 1..=LEGACY_CONFIG_COUNT {
        let key = format!("timer{n}");
        if let Some(raw) = stored.get(&key).and_then(to_number) {
            if raw >= 1000.0 {
                let secs = (raw / 1000.0).round() as i64;
                stored.insert(
                    key,
                    serde_json::Value::String(secs.max(min_refresh_seconds(false)).to_string()),
                );
            }
        }
    }
}

/// Schema 1 stored three fixed slots as flat `${field}${n}` keys.
pub fn migrate_numbered_settings(
    stored: &serde_json::Map<String, serde_json::Value>,
) -> Vec<Request> {
    let mut fixed = stored.clone();
    convert_legacy_millisecond_timers(&mut fixed);
    let mut requests: Vec<Request> = Vec::new();
    for n in 1..=LEGACY_CONFIG_COUNT {
        let mut values = super::model::blank_request();
        for field in FIELDS {
            if let Some(v) = fixed.get(&format!("{field}{n}")) {
                values.insert(field.to_string(), v.clone());
            }
        }
        let clean = sanitize_values(&serde_json::Value::Object(values));
        let probe = request_from_values("probe".into(), &clean);
        if probe.configured() {
            requests.push(make_request(&serde_json::Value::Object(clean), &requests));
        }
    }
    requests
}

pub fn display_name(request: &Request, index: usize) -> String {
    let label = request.label.trim();
    if label.is_empty() {
        format!("Request {}", index + 1)
    } else {
        label.to_string()
    }
}

pub fn settings_document(
    indicator: &str,
    show_in_dock: bool,
    tray_link: Option<&str>,
    requests: &[Request],
) -> serde_json::Value {
    let mut doc = serde_json::json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "indicator": indicator,
        "showInDock": show_in_dock,
        "requests": requests,
    });
    if let Some(link) = tray_link {
        doc["trayLink"] = serde_json::Value::String(link.to_string());
    }
    doc
}

#[cfg(test)]
mod tests {
    use super::{normalize_requests, request_from_clean, sanitize_values, AlertRule};
    use std::collections::HashSet;

    #[test]
    fn crypto_provider_controls_the_saved_refresh_floor() {
        let automatic = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "sol",
            "currency": "usd",
            "timer": "1"
        }));
        assert_eq!(automatic["provider"], "auto");
        assert_eq!(automatic["timer"], "5");

        for provider in ["dexscreener", "coingecko"] {
            let slower = sanitize_values(&serde_json::json!({
                "type": "crypto",
                "provider": provider,
                "timer": "5"
            }));
            assert_eq!(slower["timer"], "30");
        }
    }

    #[test]
    fn automatic_routes_save_the_floor_of_their_effective_provider() {
        let bitcoin = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "btc",
            "currency": "usd",
            "timer": "5"
        }));
        assert_eq!(bitcoin["timer"], "30");

        let solana_gbp = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "sol",
            "currency": "gbp",
            "timer": "1"
        }));
        assert_eq!(solana_gbp["timer"], "5");

        let solana_sats = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "sol",
            "currency": "sats",
            "timer": "5"
        }));
        assert_eq!(solana_sats["timer"], "30");
    }

    #[test]
    fn automatic_runtime_defaults_follow_the_effective_route() {
        let bitcoin = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "btc",
            "currency": "usd"
        }));
        let bitcoin = request_from_clean("btc", &bitcoin);
        assert_eq!(bitcoin.min_refresh_seconds(), 30);
        assert_eq!(bitcoin.default_refresh_seconds(), 60);

        let solana = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "sol",
            "currency": "gbp"
        }));
        let solana = request_from_clean("sol", &solana);
        assert_eq!(solana.min_refresh_seconds(), 5);
        assert_eq!(solana.default_refresh_seconds(), 5);
    }

    #[test]
    fn unknown_crypto_provider_becomes_automatic() {
        let clean = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "mystery"
        }));
        assert_eq!(clean["provider"], "auto");
    }

    #[test]
    fn invalid_holdings_and_regex_are_rejected_before_saving() {
        let mut clean = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "coin": "SOL",
            "holdings": "10O",
        }));
        let mut request = request_from_clean("r1", &clean);
        assert!(request
            .validate_for_save()
            .unwrap_err()
            .contains("Holdings"));

        clean.insert("holdings".into(), serde_json::json!("10.5"));
        request = request_from_clean("r1", &clean);
        request.alerts = vec![AlertRule {
            id: "a1".into(),
            kind: "regex".into(),
            value: "(".into(),
            cooldown_secs: 300,
        }];
        assert!(request
            .validate_for_save()
            .unwrap_err()
            .contains("invalid regex"));
    }

    #[test]
    fn jupiter_accepts_fiat_conversion_but_dex_screener_remains_usd_only() {
        let jupiter = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "jupiter",
            "coin": "SOL",
            "currency": "gbp"
        }));
        assert!(request_from_clean("jupiter", &jupiter)
            .validate_for_save()
            .is_ok());

        let dex = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "dexscreener",
            "coin": "SOL",
            "currency": "gbp"
        }));
        assert_eq!(
            request_from_clean("dex", &dex).validate_for_save(),
            Err("DEX Screener quotes USD only.".into())
        );

        let invalid_jupiter = sanitize_values(&serde_json::json!({
            "type": "crypto",
            "provider": "jupiter",
            "coin": "SOL",
            "currency": "sats"
        }));
        assert_eq!(
            request_from_clean("jupiter", &invalid_jupiter).validate_for_save(),
            Err("Jupiter conversion needs a three-letter currency code such as GBP or EUR.".into())
        );
    }

    #[test]
    fn stored_alerts_keep_valid_entries_and_receive_unique_ids() {
        let requests = normalize_requests(&serde_json::json!([{
            "id": "r1",
            "type": "http",
            "url": "https://example.com",
            "alerts": [
                {"id": "same", "kind": "above", "value": "1"},
                "damaged",
                {"id": "same", "kind": "below", "value": "2"},
                {"id": "", "kind": "contains", "value": "ready"}
            ]
        }]));

        let ids: Vec<&str> = requests[0]
            .alerts
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(requests[0].alerts.len(), 3);
        assert_eq!(ids.iter().copied().collect::<HashSet<_>>().len(), 3);
    }
}
