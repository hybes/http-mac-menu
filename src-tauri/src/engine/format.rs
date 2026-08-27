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
pub fn format_http_value(raw: &serde_json::Value, cfg: &super::model::Request) -> String {
    let multiplier = to_number(&serde_json::Value::String(cfg.multiplier.clone()));
    let decimals = parse_decimals(&cfg.length);
    let numeric = to_number(raw);

    let text = if let Some(n) = numeric.filter(|_| multiplier.is_some() || decimals.is_some()) {
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
    };

    cap_display_value(format!("{}{}{}", cfg.prefix, text, cfg.suffix))
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
