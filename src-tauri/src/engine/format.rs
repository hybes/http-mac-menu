// Value formatting. Locale formatting is reimplemented rather than
// pulled from ICU: the shapes we need are currency, thousands separators and
// fixed decimals, and matching the Electron output closely is enough.

use super::constants::UNAVAILABLE;
use super::indicators::{MARK_FALL, MARK_RISE};

pub fn truncate(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count > max {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    } else {
        text.to_string()
    }
}

pub fn to_number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        serde_json::Value::String(s) if !s.trim().is_empty() => {
            s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
        }
        _ => None,
    }
}

pub fn parse_decimals(raw: &str) -> Option<u32> {
    let d = to_number(&serde_json::Value::String(raw.to_string()))?;
    Some(d.round().clamp(0.0, 20.0) as u32)
}

pub fn parse_refresh_seconds(raw: &str, crypto: bool) -> i64 {
    parse_refresh_seconds_with_limits(
        raw,
        super::constants::min_refresh_seconds(crypto),
        super::constants::default_refresh_seconds(crypto),
    )
}

pub fn parse_refresh_seconds_with_limits(raw: &str, minimum: i64, default: i64) -> i64 {
    match raw.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v > 0.0 => v
            .round()
            .clamp(minimum as f64, super::constants::MAX_REFRESH_SECONDS as f64)
            as i64,
        _ => default,
    }
}

/// One `Name: value` pair per line. Commas belong to ordinary header values
/// such as Accept, Cache-Control and signed Authorization parameters.
pub fn parse_headers(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for part in raw.lines() {
        if let Some((key, value)) = part.split_once(':') {
            let key = key.trim();
            if !key.is_empty() {
                out.push((key.to_string(), value.trim().to_string()));
            }
        }
    }
    out
}

pub fn cap_display_value(text: String) -> String {
    let maximum = super::constants::MAX_DISPLAY_VALUE_CHARS;
    if text.chars().count() <= maximum {
        return text;
    }
    let mut capped: String = text.chars().take(maximum.saturating_sub(1)).collect();
    capped.push('…');
    capped
}

/// Dot paths with numeric indexing: `data.price`, `items[0].value`.
pub fn resolve_json_path<'a>(
    data: &'a serde_json::Value,
    path: &str,
) -> Result<&'a serde_json::Value, String> {
    // JSON Pointer covers keys containing dots, brackets, slashes or spaces.
    if path.starts_with('/') {
        return data
            .pointer(path)
            .ok_or_else(|| format!("JSON path \"{path}\" not found in response"));
    }
    let cleaned = {
        // Turn items[0].value into items.0.value
        let mut s = String::new();
        let mut chars = path.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '[' {
                s.push('.');
                for inner in chars.by_ref() {
                    if inner == ']' {
                        break;
                    }
                    s.push(inner);
                }
            } else {
                s.push(c);
            }
        }
        s
    };

    let mut value = data;
    for token in cleaned.split('.').map(str::trim).filter(|t| !t.is_empty()) {
        let next = match value {
            serde_json::Value::Object(map) => map.get(token),
            serde_json::Value::Array(items) => {
                token.parse::<usize>().ok().and_then(|i| items.get(i))
            }
            _ => None,
        };
        match next {
            Some(v) => value = v,
            None => {
                return Err(format!(
                    "JSON path \"{path}\" not found in response (stopped at \"{token}\")"
                ))
            }
        }
    }
    Ok(value)
}

fn group_thousands(int_digits: &str) -> String {
    let bytes = int_digits.as_bytes();
    let mut out = String::with_capacity(bytes.len() + bytes.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

/// JS `toLocaleString()` for plain numbers: thousands separators, no decimals.
pub fn format_locale_thousands(value: f64) -> String {
    let neg = value < 0.0;
    let rounded = value.abs().round();
    let int_digits = format!("{}", rounded as u64);
    let body = group_thousands(&int_digits);
    if neg && rounded != 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

fn format_number_locale(value: f64, min_decimals: usize, max_decimals: usize) -> String {
    let neg = value < 0.0;
    let v = value.abs();
    let formatted = format!("{v:.*}", max_decimals);
    let (int_part, dec_part) = match formatted.split_once('.') {
        Some((i, d)) => (i.to_string(), Some(d.to_string())),
        None => (formatted.clone(), None),
    };
    let int_part = int_part.trim_start_matches('0');
    let int_part = if int_part.is_empty() { "0" } else { int_part };
    let mut out = String::new();
    if neg && v != 0.0 {
        out.push('-');
    }
    out.push_str(&group_thousands(int_part));
    if let Some(d) = dec_part {
        let trimmed = d.trim_end_matches('0');
        let keep = trimmed.len().max(min_decimals);
        if keep > 0 {
            out.push('.');
            let padded = format!("{:0<width$}", trimmed, width = keep);
            out.push_str(&padded);
        }
    }
    out
}

const CURRENCY_SYMBOLS: [(&str, &str); 12] = [
    ("GBP", "£"),
    ("USD", "$"),
    ("EUR", "€"),
    ("JPY", "¥"),
    ("CNY", "CN¥"),
    ("INR", "₹"),
    ("KRW", "₩"),
    ("RUB", "₽"),
    ("BRL", "R$"),
    ("AUD", "A$"),
    ("CAD", "C$"),
    ("CHF", "CHF"),
];

fn currency_symbol(code: &str) -> Option<&str> {
    CURRENCY_SYMBOLS
        .iter()
        .find(|(c, _)| c.eq_ignore_ascii_case(code))
        .map(|(_, s)| *s)
}

pub fn format_money(value: f64, currency: &str, decimals: Option<u32>) -> String {
    let code = if currency.is_empty() { "GBP" } else { currency }.to_uppercase();
    let abs = value.abs();
    let (min_d, max_d) = if abs > 0.0 && abs < 1.0 && decimals.is_none() {
        // maximumSignificantDigits: 4 approximation
        let magnitude = -abs.log10().ceil() as i32;
        let extra = (magnitude + 3).clamp(0, 6) as usize;
        (extra, extra)
    } else {
        let d = decimals.map(|d| d as usize).unwrap_or(2);
        (d, d)
    };
    let body = format_number_locale(value, min_d, max_d);
    match currency_symbol(&code) {
        Some(sym) => format!("{sym}{body}"),
        None => format!("{body} {code}"),
    }
}

pub fn direction_mark(value: f64) -> char {
    if value >= 0.0 {
        MARK_RISE
    } else {
        MARK_FALL
    }
}

/// Port of formatHttpValue: numbers honour multiplier/decimals, everything
/// else is shown as-is with "decimals" acting as a maximum length.
fn format_http_value(raw: &serde_json::Value, cfg: &super::model::Request) -> String {
    let multiplier = to_number(&serde_json::Value::String(cfg.multiplier.clone()));
    let decimals = parse_decimals(&cfg.length);
    let numeric = to_number(raw);

    if let Some(n) = numeric.filter(|_| multiplier.is_some() || decimals.is_some()) {
        match multiplier {
            Some(m) => {
                // A multiplier also switches on locale formatting (12000 -> 12,000).
                let (min_d, max_d) = match decimals {
                    Some(d) => (d as usize, d as usize),
                    None => (0, 3),
                };
                format_number_locale(n * m, min_d, max_d)
            }
            None => {
                let d = decimals.unwrap() as usize;
                format!("{n:.d$}", d = d)
            }
        }
    } else {
        let raw_text = match raw {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        match decimals {
            Some(d) if d > 0 => raw_text.chars().take(d as usize).collect(),
            _ => raw_text,
        }
    }
}

fn json_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        value => value.to_string(),
    }
}

fn display_rule_matches(
    rule: &super::model::DisplayRule,
    data: &serde_json::Value,
    now: i64,
) -> bool {
    let value = resolve_json_path(data, rule.path.trim())
        .ok()
        .filter(|value| !value.is_null());
    match rule.kind.as_str() {
        "empty" => value.is_none(),
        "present" => value.is_some(),
        "equals" => value.is_some_and(|value| json_text(value) == rule.value),
        "not_equals" => value.is_some_and(|value| json_text(value) != rule.value),
        "before_now" | "after_now" => value
            .and_then(serde_json::Value::as_str)
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .is_some_and(|date| {
                if rule.kind == "before_now" {
                    date.timestamp() < now
                } else {
                    date.timestamp() > now
                }
            }),
        "contains" => value
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| text.contains(&rule.value)),
        "above" | "below" => value
            .and_then(to_number)
            .zip(to_number(&serde_json::Value::String(rule.value.clone())))
            .is_some_and(|(value, threshold)| {
                if rule.kind == "above" {
                    value > threshold
                } else {
                    value < threshold
                }
            }),
        _ => false,
    }
}

fn format_http_date(value: &serde_json::Value, format: &str, now: i64) -> Result<String, String> {
    let date = value
        .as_str()
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .ok_or_else(|| {
            "Date formatting needs an ISO 8601 timestamp, such as 2026-10-05T12:00:00Z.".to_string()
        })?;
    if format == "relative" {
        let seconds = date.timestamp().saturating_sub(now);
        if seconds == 0 {
            return Ok("now".into());
        }
        let minutes = seconds.unsigned_abs() / 60;
        let duration = if minutes >= 1440 {
            format!("{}d {}h", minutes / 1440, minutes % 1440 / 60)
        } else if minutes >= 60 {
            format!("{}h {}m", minutes / 60, minutes % 60)
        } else if minutes > 0 {
            format!("{minutes}m")
        } else {
            "<1m".into()
        };
        return Ok(if seconds > 0 {
            format!("in {duration}")
        } else {
            format!("{duration} ago")
        });
    }
    let pattern = match format {
        "date" => "%d %b %Y",
        "time" => "%H:%M",
        "datetime" => "%d %b %Y, %H:%M",
        _ => {
            return Err(format!(
                "Unknown display format \"{format}\". Use date, time, datetime or relative."
            ))
        }
    };
    Ok(date
        .with_timezone(&chrono::Local)
        .format(pattern)
        .to_string())
}

fn render_http_template(
    template: &str,
    data: &serde_json::Value,
    cfg: &super::model::Request,
    now: i64,
) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..]
            .find('}')
            .map(|end| start + end)
            .ok_or_else(|| "Close each display placeholder with }.".to_string())?;
        let token = &rest[start + 1..end];
        let (path, format) = token.split_once('|').unwrap_or((token, ""));
        let path = path.trim();
        if path.is_empty() {
            return Err("A display placeholder needs a JSON path or value.".into());
        }
        let value = resolve_json_path(data, if path == "value" { &cfg.json } else { path })?;
        if value.is_null() {
            return Err(format!(
                "Display field \"{path}\" is null. Add a null condition or fallback text."
            ));
        }
        let text = if !format.trim().is_empty() {
            format_http_date(value, format.trim(), now)?
        } else if path == "value" {
            format_http_value(value, cfg)
        } else {
            json_text(value)
        };
        out.push_str(&text);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Whether the selected value is shown as the number one, which is what
/// separates "1 order" from "2 orders".
fn shows_one(value: &serde_json::Value, cfg: &super::model::Request) -> bool {
    to_number(value).is_some()
        && format_http_value(value, cfg)
            .replace(',', "")
            .trim()
            .parse::<f64>()
            == Ok(1.0)
}

/// A plural ending in brackets straight after a letter, as in `order(s)` or
/// `box(es)`, is dropped beside the number one and kept beside anything else.
/// Other brackets, such as " (GBP)", are left as typed.
fn plural_affix(affix: &str, one: bool) -> String {
    let mut out = String::with_capacity(affix.len());
    let mut rest = affix;
    while let Some(open) = rest.find('(') {
        let (word, bracket) = rest.split_at(open);
        out.push_str(word);
        let ending = bracket[1..]
            .split_once(')')
            .map(|(ending, _)| ending)
            .filter(|ending| {
                word.chars().next_back().is_some_and(char::is_alphabetic)
                    && !ending.is_empty()
                    && ending.chars().all(char::is_alphabetic)
            });
        match ending {
            Some(ending) => {
                if !one {
                    out.push_str(ending);
                }
                rest = &bracket[ending.len() + 2..];
            }
            None => {
                out.push('(');
                rest = &bracket[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The editor preview and every scheduled HTTP refresh share this formatter.
/// Conditions see the whole response, even when the selected field is absent.
pub fn format_http_response(
    data: &serde_json::Value,
    cfg: &super::model::Request,
    now: i64,
) -> Result<String, String> {
    let selected = resolve_json_path(data, cfg.json.trim());
    let one = selected.as_ref().is_ok_and(|value| shows_one(value, cfg));
    let text = if let Some(rule) = cfg
        .display_rules
        .iter()
        .find(|rule| display_rule_matches(rule, data, now))
    {
        render_http_template(&rule.template, data, cfg, now)?
    } else if selected.as_ref().map_or(true, |value| value.is_null()) && !cfg.empty_text.is_empty()
    {
        render_http_template(&cfg.empty_text, data, cfg, now)?
    } else if !cfg.http_template.is_empty() {
        render_http_template(&cfg.http_template, data, cfg, now)?
    } else {
        let value = selected?;
        if value.is_null() {
            return Err("Response value is null. Set text for null or missing values.".into());
        }
        format_http_value(value, cfg)
    };
    Ok(cap_display_value(format!(
        "{}{}{}",
        plural_affix(&cfg.prefix, one),
        text,
        plural_affix(&cfg.suffix, one)
    )))
}

pub fn format_percent(pct: Option<f64>) -> String {
    match pct {
        Some(p) if p.is_finite() => format!("{}{:.2}%", direction_mark(p), p.abs()),
        _ => UNAVAILABLE.to_string(),
    }
}

/// Money gained/lost over a period, given the percentage move and today's value.
pub fn format_gain(
    pct: Option<f64>,
    current: f64,
    currency: &str,
    decimals: Option<u32>,
) -> String {
    let Some(p) = pct else {
        return UNAVAILABLE.to_string();
    };
    if !p.is_finite() {
        return UNAVAILABLE.to_string();
    }
    let previous = if p <= -100.0 {
        0.0
    } else {
        current / (1.0 + p / 100.0)
    };
    let delta = current - previous;
    format!(
        "{}{}",
        direction_mark(delta),
        format_money(delta.abs(), currency, decimals)
    )
}

/// Replaces {placeholders} that exist and leaves the rest alone.
pub fn render_template(
    template: &str,
    values: &serde_json::Map<String, serde_json::Value>,
) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        if let Some(len) = rest[start..].find('}') {
            let name = &rest[start + 1..start + len];
            if name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                out.push_str(&rest[..start]);
                let rendered = match values.get(name) {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    // Unknown placeholder: emit it literally so a typo shows
                    // up in the menu bar rather than silently vanishing.
                    None => rest[start..start + len + 1].to_string(),
                };
                out.push_str(&rendered);
                rest = &rest[start + len + 1..];
                continue;
            }
        }
        // No closing brace (or odd name): emit the brace literally.
        out.push_str(&rest[..=start]);
        rest = &rest[start + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::{cap_display_value, parse_headers, parse_refresh_seconds};
    use crate::engine::constants::{
        MAX_DISPLAY_VALUE_CHARS, MAX_REFRESH_SECONDS, MIN_REFRESH_CRYPTO, MIN_REFRESH_HTTP,
    };
    use crate::engine::model::{normalize_requests, request_from_clean, sanitize_values};
    use serde_json::json;

    #[test]
    fn http_fallbacks_distinguish_null_and_missing_from_false_zero_and_blank() {
        let cfg = request_from_clean(
            "test",
            &sanitize_values(&json!({
                "json": "data.value", "empty_text": "Not available", "length": "2", "prefix": "[", "suffix": "]"
            })),
        );
        for data in [
            json!({"data": {"value": null}}),
            json!({"data": {}}),
            json!({"data": null}),
        ] {
            assert_eq!(
                super::format_http_response(&data, &cfg, 0).unwrap(),
                "[Not available]"
            );
        }
        assert_eq!(
            super::format_http_response(&json!({"data": {"value": 0}}), &cfg, 0).unwrap(),
            "[0.00]"
        );
        let mut plain = cfg.clone();
        plain.length.clear();
        for (value, text) in [
            (json!(false), "[false]"),
            (json!(""), "[]"),
            (json!("null"), "[null]"),
        ] {
            assert_eq!(
                super::format_http_response(&json!({"data": {"value": value}}), &plain, 0).unwrap(),
                text
            );
        }
        plain.empty_text.clear();
        assert!(super::format_http_response(&json!({"data": {"value": null}}), &plain, 0).is_err());
        assert!(super::format_http_response(&json!({"data": {}}), &plain, 0).is_err());
    }

    #[test]
    fn bracketed_plural_endings_follow_the_number_that_is_shown() {
        let mut cfg = request_from_clean(
            "test",
            &sanitize_values(&json!({"json": "count", "suffix": " order(s)"})),
        );
        for (count, expected) in [
            (json!(0), "0 orders"),
            (json!(1), "1 order"),
            (json!("1"), "1 order"),
            (json!(2), "2 orders"),
            (json!(1.5), "1.5 orders"),
            (json!(-1), "-1 orders"),
            (json!("one"), "one orders"),
            (json!(true), "true orders"),
        ] {
            assert_eq!(
                super::format_http_response(&json!({"count": count}), &cfg, 0).unwrap(),
                expected
            );
        }

        // The number as shown decides, after the multiplier and rounding.
        cfg.multiplier = "0.001".into();
        cfg.length = "0".into();
        cfg.prefix = "Box(es): ".into();
        cfg.suffix = " (GBP) match(es)(s) ms (s) a(1) b()".into();
        for (count, expected) in [
            (1000, "Box: 1 (GBP) match(s) ms (s) a(1) b()"),
            (1400, "Box: 1 (GBP) match(s) ms (s) a(1) b()"),
            (12000, "Boxes: 12 (GBP) matches(s) ms (s) a(1) b()"),
        ] {
            assert_eq!(
                super::format_http_response(&json!({"count": count}), &cfg, 0).unwrap(),
                expected
            );
        }

        // Fallback text has no number beside it, so the plural stands.
        cfg.prefix.clear();
        cfg.suffix = " order(s)".into();
        cfg.empty_text = "No".into();
        assert_eq!(
            super::format_http_response(&json!({}), &cfg, 0).unwrap(),
            "No orders"
        );
        assert_eq!(super::plural_affix("naïve(s) café(s", true), "naïve café(s");
    }

    #[test]
    fn http_conditions_are_ordered_and_survive_settings_round_trips() {
        let cfg = json!({
            "id": "r1", "type": "http", "json": "items[0].count", "multiplier": "2", "length": "1",
            "http_template": "{value} items · {data.status}", "empty_text": "No data",
            "display_rules": [
                {"path": "data.status", "kind": "equals", "value": "offline", "template": "Offline"},
                {"path": "items[0].count", "kind": "above", "value": "10", "template": "Busy: {value}"}
            ]
        });
        let request = request_from_clean("r1", &sanitize_values(&cfg));
        request.validate_for_save().unwrap();
        let reloaded = normalize_requests(&json!([serde_json::to_value(&request).unwrap()]));
        assert_eq!(reloaded[0].display_rules, request.display_rules);
        assert_eq!(reloaded[0].http_template, request.http_template);
        assert_eq!(reloaded[0].empty_text, request.empty_text);
        for (data, expected) in [
            (
                json!({"data": {"status": "offline"}, "items": [{"count": 12}]}),
                "Offline",
            ),
            (
                json!({"data": {"status": "online"}, "items": [{"count": 12}]}),
                "Busy: 24.0",
            ),
            (
                json!({"data": {"status": "online"}, "items": [{"count": 3}]}),
                "6.0 items · online",
            ),
            (json!({"data": {"status": "offline"}}), "Offline"),
        ] {
            assert_eq!(
                super::format_http_response(&data, &reloaded[0], 0).unwrap(),
                expected
            );
        }
        let mut invalid = request.clone();
        invalid.display_rules[1].value = "NaN".into();
        assert!(invalid.validate_for_save().is_err());
        invalid.display_rules[1].kind = "run_script".into();
        assert!(invalid.validate_for_save().is_err());
        assert!(
            crate::engine::model::parse_display_rules(Some(&json!([{"path": "data"}]))).is_err()
        );
    }

    #[test]
    fn display_conditions_cover_presence_text_numbers_and_dates() {
        let data = json!({"null": null, "zero": 0, "bool": false, "text": "All systems ready", "number": "12.5", "time": "2026-10-05T12:00:00Z"});
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-05T10:00:00Z")
            .unwrap()
            .timestamp();
        for (path, kind, value, expected) in [
            ("null", "empty", "", true),
            ("missing", "empty", "", true),
            ("zero", "empty", "", false),
            ("bool", "present", "", true),
            ("text", "contains", "systems", true),
            ("text", "contains", "SYSTEMS", false),
            ("bool", "equals", "false", true),
            ("number", "not_equals", "0", true),
            ("missing", "not_equals", "0", false),
            ("number", "above", "12", true),
            ("number", "below", "13", true),
            ("null", "below", "1", false),
            ("time", "after_now", "", true),
            ("time", "before_now", "", false),
        ] {
            let rule = crate::engine::model::DisplayRule {
                path: path.into(),
                kind: kind.into(),
                value: value.into(),
                template: "match".into(),
            };
            assert_eq!(
                super::display_rule_matches(&rule, &data, now),
                expected,
                "{path} {kind}"
            );
        }
    }

    #[test]
    fn scheduled_dates_handle_unknown_times_future_and_overdue_without_claiming_completion() {
        let cfg = request_from_clean(
            "reset",
            &sanitize_values(&json!({
                "json": "data.scheduled_reset.scheduled_for", "empty_text": "No reset scheduled",
                "display_rules": [
                    {"path": "data.scheduled_reset.scheduled_for", "kind": "before_now", "template": "Scheduled {value|relative}; awaiting confirmation"},
                    {"path": "data.scheduled_reset.scheduled_for", "kind": "present", "template": "Reset {value|relative}"},
                    {"path": "data.scheduled_reset", "kind": "present", "template": "Reset scheduled; time TBC"}
                ]
            })),
        );
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-05T10:00:00Z")
            .unwrap()
            .timestamp();
        for (scheduled, expected) in [
            (json!(null), "No reset scheduled"),
            (json!({"scheduled_for": null}), "Reset scheduled; time TBC"),
            (
                json!({"scheduled_for": "2026-10-05T12:30:00Z"}),
                "Reset in 2h 30m",
            ),
            (
                json!({"scheduled_for": "2026-10-05T09:00:00Z"}),
                "Scheduled 1h 0m ago; awaiting confirmation",
            ),
        ] {
            assert_eq!(
                super::format_http_response(
                    &json!({"data": {"scheduled_reset": scheduled}}),
                    &cfg,
                    now
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn templates_support_pointer_keys_and_report_bad_fields_dates_and_syntax() {
        let data = json!({"a.b": {"x/y~": ["ok"]}, "when": "2026-10-05T12:30:00Z"});
        let mut cfg = request_from_clean(
            "test",
            &sanitize_values(&json!({"http_template": "{/a.b/x~1y~0/0}"})),
        );
        assert_eq!(super::format_http_response(&data, &cfg, 0).unwrap(), "ok");
        for template in [
            "{missing}",
            "{value|datetime}",
            "{when|typo}",
            "{when",
            "{}",
        ] {
            cfg.http_template = template.into();
            assert!(
                super::format_http_response(&data, &cfg, 0).is_err(),
                "{template}"
            );
        }
        let date = chrono::DateTime::parse_from_rfc3339(data["when"].as_str().unwrap())
            .unwrap()
            .with_timezone(&chrono::Local);
        for (filter, pattern) in [
            ("date", "%d %b %Y"),
            ("time", "%H:%M"),
            ("datetime", "%d %b %Y, %H:%M"),
        ] {
            cfg.http_template = format!("{{when|{filter}}}");
            assert_eq!(
                super::format_http_response(&data, &cfg, 0).unwrap(),
                date.format(pattern).to_string()
            );
        }
    }

    #[test]
    fn refresh_intervals_are_bounded_before_becoming_durations() {
        assert_eq!(parse_refresh_seconds("0.1", false), MIN_REFRESH_HTTP);
        assert_eq!(parse_refresh_seconds("1", true), MIN_REFRESH_CRYPTO);
        assert_eq!(parse_refresh_seconds("1e100", false), MAX_REFRESH_SECONDS);
        assert_eq!(parse_refresh_seconds("inf", false), 5);
    }

    #[test]
    fn headers_keep_commas_inside_each_line_value() {
        assert_eq!(
            parse_headers(
                "Accept: application/json, text/plain\nCache-Control: max-age=0, no-cache\nAuthorization: Signature key=one,headers=two"
            ),
            vec![
                ("Accept".into(), "application/json, text/plain".into()),
                ("Cache-Control".into(), "max-age=0, no-cache".into()),
                (
                    "Authorization".into(),
                    "Signature key=one,headers=two".into()
                ),
            ]
        );
    }

    #[test]
    fn display_values_are_bounded_with_a_visible_marker() {
        let value = cap_display_value("x".repeat(MAX_DISPLAY_VALUE_CHARS + 100));
        assert_eq!(value.chars().count(), MAX_DISPLAY_VALUE_CHARS);
        assert!(value.ends_with('…'));
    }
}
