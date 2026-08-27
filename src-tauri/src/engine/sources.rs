// Network source adapters for arbitrary HTTP values and built-in crypto/FX
// providers. Crypto prices and display currencies stay deliberately separate:
// Jupiter supplies the live USD market while one shared FX table converts it.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};

use super::constants::{MAX_HTTP_RESPONSE_BYTES, REQUEST_TIMEOUT_MS};
use super::crypto_route::{
    currency_for, is_solana_mint, jupiter_currency_supported, known_solana_token,
    known_solana_token_by_mint, solana_mint_hint,
};
use super::format::{
    cap_display_value, format_gain, format_http_value, format_money, format_percent,
    parse_decimals, render_template, resolve_json_path, to_number,
};
use super::model::Request;
use super::price_history::PriceHistory;

pub struct Fetched {
    pub text: String,
    pub raw_log: String,
    // The request's display/graph series. Crypto holdings use their balance
    // here so card metrics remain in the same units as the configured view.
    pub numeric: Option<f64>,
    // Value-threshold alerts have their own operand and copy. For HTTP these
    // mirror the displayed number; for crypto they are always the unit price,
    // regardless of holdings or template variables.
    pub alert_numeric: Option<f64>,
    pub alert_text: String,
    pub pct_24h: Option<f64>,
}

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
            .user_agent("http-widgets/2.0")
            .build()
            .expect("reqwest client")
    })
}

fn describe_reqwest(err: &reqwest::Error, local: bool) -> String {
    if err.is_timeout() {
        return "Request timed out".into();
    }
    if err.is_status() {
        let status = err.status().map(|s| s.to_string()).unwrap_or_default();
        return format!("HTTP {status}").trim().to_string();
    }
    if err.is_connect() {
        if local {
            if cfg!(any(target_os = "macos", target_os = "ios")) {
                return "Could not reach this local address. Check the service is running and allow HTTP Widgets in Privacy & Security > Local Network.".into();
            }
            return "Could not reach this local address. Check the service is running, this device is on the same network, and no firewall is blocking it.".into();
        }
        return format!("Could not connect: {}", truncate_msg(&err.to_string(), 160));
    }
    truncate_msg(&err.to_string(), 200)
}

/// Local endpoints must be attempted even without public Internet access.
/// Besides private IP ranges, unqualified and `.local` host names are local
/// network destinations under Apple's privacy rules.
pub fn is_local_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
            IpAddr::V6(ip) => {
                ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
            }
        };
    }
    let domain = host.trim_end_matches('.').to_ascii_lowercase();
    domain == "localhost" || domain.ends_with(".local") || !domain.contains('.')
}

fn truncate_msg(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        s.chars().take(max).collect()
    } else {
        s.to_string()
    }
}

async fn read_http_body(mut response: reqwest::Response, local: bool) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES as u64)
    {
        return Err("Response is larger than the 2 MB limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| describe_reqwest(&error, local))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_HTTP_RESPONSE_BYTES {
            return Err("Response is larger than the 2 MB limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub async fn fetch_http_value(client: &reqwest::Client, cfg: &Request) -> Result<Fetched, String> {
    let url = cfg.url.trim().to_string();
    if url.is_empty() {
        return Err("No URL configured".into());
    }

    let mut req = client.get(&url);
    for (k, v) in super::format::parse_headers(&cfg.headers) {
        req = req.header(&k, &v);
    }
    let local = is_local_url(&url);
    let res = req.send().await.map_err(|e| describe_reqwest(&e, local))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!(
            "HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    let body = read_http_body(res, local).await?;

    let mut raw: Value;
    let trimmed = body.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        raw = serde_json::from_str::<Value>(&body).unwrap_or(Value::String(body.clone()));
    } else {
        raw = Value::String(body.clone());
    }

    let json_path = cfg.json.trim();
    if !json_path.is_empty() {
        raw = resolve_json_path(&raw, json_path)?.clone();
    }
    if raw.is_null() {
        return Err("Response value is empty".into());
    }

    let text = format_http_value(&raw, cfg);
    let numeric = to_number(&raw).map(|value| {
        to_number(&Value::String(cfg.multiplier.clone()))
            .map(|multiplier| value * multiplier)
            .unwrap_or(value)
    });
    Ok(Fetched {
        numeric,
        alert_numeric: numeric,
        alert_text: text.clone(),
        text,
        raw_log: truncate_msg(&raw.to_string(), 500),
        pct_24h: None,
    })
}

// ---------------------------------------------------------------------------
// Crypto sources
// ---------------------------------------------------------------------------

const COINGECKO_API: &str = "https://api.coingecko.com/api/v3";
const JUPITER_API: &str = "https://api.jup.ag";
const DEXSCREENER_API: &str = "https://api.dexscreener.com";
const COINBASE_FX_API: &str = "https://api.coinbase.com/v2/exchange-rates";
const FRANKFURTER_FX_API: &str = "https://api.frankfurter.dev/v2/rates";
const JUPITER_CACHE_MS: i64 = 5_000;
const JUPITER_REQUEST_GAP_MS: i64 = 2_100;
const LIVE_FX_CACHE_MS: i64 = 60_000;
const LIVE_FX_STALE_MS: i64 = 24 * 60 * 60 * 1_000;
const REFERENCE_FX_CACHE_MS: i64 = 6 * 60 * 60 * 1_000;
const REFERENCE_FX_STALE_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const FX_ERROR_BACKOFF_MS: i64 = 30_000;

/// Common tickers -> CoinGecko ids. Anything else is looked up via /search.
const COIN_IDS: &[(&str, &str)] = &[
    ("btc", "bitcoin"),
    ("eth", "ethereum"),
    ("sol", "solana"),
    ("xrp", "ripple"),
    ("ada", "cardano"),
    ("doge", "dogecoin"),
    ("dot", "polkadot"),
    ("ltc", "litecoin"),
    ("bnb", "binancecoin"),
    ("link", "chainlink"),
    ("avax", "avalanche-2"),
    ("matic", "matic-network"),
    ("pol", "polygon-ecosystem-token"),
    ("usdt", "tether"),
    ("usdc", "usd-coin"),
    ("trx", "tron"),
    ("shib", "shiba-inu"),
    ("uni", "uniswap"),
    ("atom", "cosmos"),
    ("xlm", "stellar"),
    ("ton", "the-open-network"),
    ("near", "near"),
    ("sui", "sui"),
    ("apt", "aptos"),
    ("arb", "arbitrum"),
    ("op", "optimism"),
    ("pepe", "pepe"),
    ("hbar", "hedera-hashgraph"),
    ("xmr", "monero"),
    ("bch", "bitcoin-cash"),
    ("etc", "ethereum-classic"),
    ("fil", "filecoin"),
    ("algo", "algorand"),
    ("vet", "vechain"),
    ("icp", "internet-computer"),
    ("inj", "injective-protocol"),
    ("aave", "aave"),
    ("mkr", "maker"),
    ("ldo", "lido-dao"),
    ("render", "render-token"),
    ("tao", "bittensor"),
    ("kas", "kaspa"),
];

/// Periods CoinGecko reports directly.
const COINGECKO_PERIODS: &[(&str, &str)] = &[
    ("1h", "price_change_percentage_1h_in_currency"),
    ("24h", "price_change_percentage_24h_in_currency"),
    ("7d", "price_change_percentage_7d_in_currency"),
    ("30d", "price_change_percentage_30d_in_currency"),
];
/// Periods worked out from our own price samples (minutes).
const LOCAL_PERIODS: &[(&str, i64)] = &[("1m", 1), ("5m", 5), ("15m", 15), ("30m", 30), ("1h", 60)];
const DISPLAY_PERIODS: &[&str] = &["1m", "5m", "15m", "30m", "1h", "24h", "7d", "30d"];

#[derive(Debug, Clone)]
struct CryptoMarket {
    source: &'static str,
    id: String,
    symbol: String,
    name: String,
    currency: String,
    price: f64,
    changes: HashMap<String, f64>,
    raw: Value,
}

#[derive(Debug, Clone)]
struct FxRate {
    rate: f64,
    source: &'static str,
    fetched_at: i64,
    reference_date: Option<String>,
}

#[derive(Debug)]
enum JupiterError {
    Temporary(String),
    Unreliable(String),
}

impl JupiterError {
    fn message(self) -> String {
        match self {
            Self::Temporary(message) | Self::Unreliable(message) => message,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn value_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
        .filter(|number| number.is_finite())
}

/// A synchronous hint lets the scheduler coalesce every due SOL/SPL widget
/// into one Jupiter call before any individual renderer formats its value.
pub fn jupiter_batch_mint(request: &Request) -> Option<String> {
    if !request.crypto()
        || !matches!(request.crypto_provider(), "auto" | "jupiter")
        || !jupiter_currency_supported(&request.currency)
    {
        return None;
    }
    solana_mint_hint(&request.coin)
}

/// Once an explicit Jupiter ticker has been resolved, include its cached mint
/// in later batch plans too. This keeps arbitrary SPL symbols on the same one
/// Price-v3 call path as raw mints instead of permanently serializing them.
pub fn jupiter_batch_mint_from_cache(
    request: &Request,
    cache: &HashMap<String, String>,
) -> Option<String> {
    if let Some(mint) = jupiter_batch_mint(request) {
        return Some(mint);
    }
    if !request.crypto()
        || request.crypto_provider() != "jupiter"
        || !jupiter_currency_supported(&request.currency)
    {
        return None;
    }
    let query = request.coin.trim().to_ascii_lowercase();
    let cached = cache.get(&format!("jupiter:token:{query}"))?;
    let value = serde_json::from_str::<Value>(cached).ok()?;
    value["id"]
        .as_str()
        .filter(|mint| is_solana_mint(mint))
        .map(str::to_string)
}

async fn coingecko(
    client: &reqwest::Client,
    endpoint: &str,
    params: &[(&str, &str)],
) -> Result<Value, String> {
    let url = format!("{COINGECKO_API}{endpoint}");
    let res = client
        .get(&url)
        .query(params)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| describe_reqwest(&e, false))?;
    let status = res.status();
    match status.as_u16() {
        429 => return Err("CoinGecko rate limit reached — use a longer refresh interval".into()),
        400 | 422 => return Err("__CURRENCY__".into()),
        _ => {}
    }
    if !status.is_success() {
        return Err(format!(
            "HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    res.json().await.map_err(|e| describe_reqwest(&e, false))
}

async fn fetch_market(
    client: &reqwest::Client,
    id: &str,
    currency: &str,
) -> Result<Option<Value>, String> {
    let data = coingecko(
        client,
        "/coins/markets",
        &[
            ("vs_currency", currency),
            ("ids", id),
            ("price_change_percentage", "1h,24h,7d,30d"),
        ],
    )
    .await?;
    Ok(data.as_array().and_then(|a| a.first().cloned()))
}

async fn search_coin_id(client: &reqwest::Client, query: &str) -> Result<Option<String>, String> {
    let res = coingecko(client, "/search", &[("query", query)]).await?;
    let coins = res["coins"].as_array().cloned().unwrap_or_default();
    let exact = coins.iter().find(|c| {
        ["symbol", "id", "name"]
            .iter()
            .any(|field| c[field].as_str().map(|s| s.to_lowercase()) == Some(query.to_string()))
    });
    let pick = exact.or_else(|| coins.first());
    Ok(pick.and_then(|c| c["id"].as_str()).map(str::to_string))
}

fn explain_coingecko_error(message: String, currency: &str) -> String {
    if message == "__CURRENCY__" {
        format!("Currency \"{currency}\" is not supported by CoinGecko")
    } else {
        message
    }
}

/// The final market lookup follows a successful search, so there is no other
/// candidate left to try. Preserve its real provider error instead of turning a
/// rate limit, bad currency or HTTP failure into the misleading "not found".
fn final_coingecko_market(
    result: Result<Option<Value>, String>,
    currency: &str,
) -> Result<Option<Value>, String> {
    result.map_err(|message| explain_coingecko_error(message, currency))
}

async fn resolve_coingecko_market(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    input: &str,
    currency: &str,
) -> Result<Value, String> {
    let query = input.trim().to_lowercase();
    if query.is_empty() {
        return Err("No coin set".into());
    }

    let mut candidates: Vec<String> = Vec::new();
    if let Some(cached) = cache.get(&query) {
        candidates.push(cached.clone());
    }
    if let Some((_, known)) = COIN_IDS.iter().find(|(t, _)| *t == query) {
        candidates.push(known.to_string());
    }
    candidates.push(query.clone());
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));

    for id in candidates {
        match fetch_market(client, &id, currency).await {
            Ok(Some(market)) => {
                cache.insert(query.clone(), id);
                return Ok(market);
            }
            Ok(None) => {}
            // Unknown ids are represented by a successful empty array. A
            // transport, timeout, 5xx, currency or rate-limit error applies to
            // the provider itself and retrying several alternate ids only
            // turns one outage into serial 15-second waits.
            Err(message) => return Err(explain_coingecko_error(message, currency)),
        }
    }

    let id = search_coin_id(client, &query).await?;
    if let Some(id) = id {
        if let Some(market) =
            final_coingecko_market(fetch_market(client, &id, currency).await, currency)?
        {
            cache.insert(query, id);
            return Ok(market);
        }
    }
    Err(format!(
        "Coin \"{input}\" not found on CoinGecko. Try its id, e.g. solana or bitcoin"
    ))
}

async fn fetch_coingecko_crypto(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    input: &str,
    currency: &str,
) -> Result<CryptoMarket, String> {
    let raw = resolve_coingecko_market(client, cache, input, currency).await?;
    let price = raw["current_price"]
        .as_f64()
        .ok_or("CoinGecko returned no price")?;
    let mut changes = HashMap::new();
    for (label, field) in COINGECKO_PERIODS {
        if let Some(change) = value_f64(&raw[*field]) {
            changes.insert((*label).to_string(), change);
        }
    }
    Ok(CryptoMarket {
        source: "CoinGecko",
        id: raw["id"].as_str().unwrap_or(input).to_string(),
        symbol: raw["symbol"].as_str().unwrap_or("").to_uppercase(),
        name: raw["name"].as_str().unwrap_or(input).to_string(),
        currency: currency.to_string(),
        price,
        changes,
        raw,
    })
}

fn cache_timestamp(cache: &HashMap<String, String>, key: &str) -> Option<i64> {
    cache.get(key)?.parse::<i64>().ok()
}

fn cache_is_fresh(now: i64, timestamp: i64, lifetime_ms: i64) -> bool {
    now.checked_sub(timestamp)
        .is_some_and(|age| (0..lifetime_ms).contains(&age))
}

fn normalize_fx_quote(currency: &str) -> Result<String, String> {
    let quote = currency.trim().to_ascii_uppercase();
    if quote.len() == 3 && quote.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        Ok(quote)
    } else {
        Err(format!(
            "Currency \"{}\" needs a three-letter code such as GBP, USD or EUR",
            currency.trim()
        ))
    }
}

fn validate_coinbase_fx_table(data: &Value) -> Result<(), String> {
    if data["data"]["currency"]
        .as_str()
        .is_none_or(|base| !base.eq_ignore_ascii_case("USD"))
    {
        return Err("Coinbase FX returned an invalid USD rate table".into());
    }
    data["data"]["rates"]
        .as_object()
        .filter(|rates| {
            !rates.is_empty()
                && rates
                    .values()
                    .all(|value| value_f64(value).is_some_and(|rate| rate > 0.0))
        })
        .map(|_| ())
        .ok_or_else(|| "Coinbase FX returned an invalid USD rate table".into())
}

fn parse_coinbase_fx_rate(data: &Value, quote: &str) -> Result<f64, String> {
    validate_coinbase_fx_table(data)?;
    data["data"]["rates"]
        .get(quote)
        .and_then(value_f64)
        .filter(|rate| *rate > 0.0)
        .ok_or_else(|| format!("Coinbase FX has no USD/{quote} rate"))
}

fn validate_frankfurter_fx_table(data: &Value) -> Result<(), String> {
    data.as_array()
        .filter(|rows| {
            !rows.is_empty()
                && rows.iter().all(|row| {
                    row["base"]
                        .as_str()
                        .is_some_and(|base| base.eq_ignore_ascii_case("USD"))
                        && row["quote"].as_str().is_some_and(|quote| !quote.is_empty())
                        && value_f64(&row["rate"]).is_some_and(|rate| rate > 0.0)
                })
        })
        .map(|_| ())
        .ok_or_else(|| "Frankfurter returned an invalid USD rate table".into())
}

fn parse_frankfurter_fx_rate(data: &Value, quote: &str) -> Result<(f64, Option<String>), String> {
    validate_frankfurter_fx_table(data)?;
    let row = data
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row["base"]
                    .as_str()
                    .is_some_and(|base| base.eq_ignore_ascii_case("USD"))
                    && row["quote"]
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(quote))
            })
        })
        .ok_or_else(|| format!("Frankfurter has no USD/{quote} reference rate"))?;
    let rate = value_f64(&row["rate"])
        .filter(|rate| *rate > 0.0)
        .ok_or_else(|| format!("Frankfurter returned an invalid USD/{quote} rate"))?;
    Ok((
        rate,
        row["date"].as_str().map(std::string::ToString::to_string),
    ))
}

fn store_coinbase_fx_table(
    cache: &mut HashMap<String, String>,
    data: &Value,
    fetched_at: i64,
) -> Result<(), String> {
    validate_coinbase_fx_table(data)?;
    cache.insert("fx:coinbase:usd".into(), data.to_string());
    cache.insert("fx:coinbase:usd-at".into(), fetched_at.to_string());
    Ok(())
}

fn store_frankfurter_fx_table(
    cache: &mut HashMap<String, String>,
    data: &Value,
    fetched_at: i64,
) -> Result<(), String> {
    validate_frankfurter_fx_table(data)?;
    cache.insert("fx:frankfurter:usd".into(), data.to_string());
    cache.insert("fx:frankfurter:usd-at".into(), fetched_at.to_string());
    Ok(())
}

fn cached_fx_json(
    cache: &HashMap<String, String>,
    data_key: &str,
    timestamp_key: &str,
    lifetime_ms: i64,
) -> Option<(Value, i64)> {
    let timestamp = cache_timestamp(cache, timestamp_key)?;
    if !cache_is_fresh(now_ms(), timestamp, lifetime_ms) {
        return None;
    }
    let data = serde_json::from_str(cache.get(data_key)?).ok()?;
    Some((data, timestamp))
}

fn recent_fx_error(
    cache: &HashMap<String, String>,
    error_key: &str,
    timestamp_key: &str,
) -> Option<String> {
    cache_timestamp(cache, timestamp_key)
        .filter(|timestamp| cache_is_fresh(now_ms(), *timestamp, FX_ERROR_BACKOFF_MS))?;
    cache.get(error_key).cloned()
}

fn store_fx_error(
    cache: &mut HashMap<String, String>,
    error_key: &str,
    timestamp_key: &str,
    error: &str,
) {
    cache.insert(error_key.into(), error.into());
    cache.insert(timestamp_key.into(), now_ms().to_string());
}

async fn fx_request(
    client: &reqwest::Client,
    provider: &str,
    url: &str,
    params: &[(&str, &str)],
) -> Result<Value, String> {
    let response = client
        .get(url)
        .query(params)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("{provider}: {}", describe_reqwest(&error, false)))?;
    let status = response.status();
    if status.as_u16() == 429 {
        return Err(format!("{provider} rate limit reached"));
    }
    if !status.is_success() {
        return Err(format!(
            "{provider} HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    let body = read_http_body(response, false).await?;
    serde_json::from_str(&body).map_err(|_| format!("{provider} returned invalid JSON"))
}

fn cached_coinbase_fx(
    cache: &HashMap<String, String>,
    quote: &str,
    lifetime_ms: i64,
    source: &'static str,
) -> Option<FxRate> {
    let (data, fetched_at) =
        cached_fx_json(cache, "fx:coinbase:usd", "fx:coinbase:usd-at", lifetime_ms)?;
    Some(FxRate {
        rate: parse_coinbase_fx_rate(&data, quote).ok()?,
        source,
        fetched_at,
        reference_date: None,
    })
}

fn cached_frankfurter_fx(
    cache: &HashMap<String, String>,
    quote: &str,
    lifetime_ms: i64,
    source: &'static str,
) -> Option<FxRate> {
    let (data, fetched_at) = cached_fx_json(
        cache,
        "fx:frankfurter:usd",
        "fx:frankfurter:usd-at",
        lifetime_ms,
    )?;
    let (rate, reference_date) = parse_frankfurter_fx_rate(&data, quote).ok()?;
    Some(FxRate {
        rate,
        source,
        fetched_at,
        reference_date,
    })
}

async fn fetch_usd_fx_rate(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    currency: &str,
) -> Result<FxRate, String> {
    let quote = normalize_fx_quote(currency)?;
    if quote == "USD" {
        return Ok(FxRate {
            rate: 1.0,
            source: "USD",
            fetched_at: now_ms(),
            reference_date: None,
        });
    }

    if let Some(rate) = cached_coinbase_fx(cache, &quote, LIVE_FX_CACHE_MS, "Coinbase FX") {
        return Ok(rate);
    }

    let mut live_error =
        recent_fx_error(cache, "fx:coinbase:last-error", "fx:coinbase:last-error-at");
    let live_table_is_fresh = cache_timestamp(cache, "fx:coinbase:usd-at")
        .is_some_and(|timestamp| cache_is_fresh(now_ms(), timestamp, LIVE_FX_CACHE_MS));
    if live_error.is_none() && !live_table_is_fresh {
        match fx_request(
            client,
            "Coinbase FX",
            COINBASE_FX_API,
            &[("currency", "USD")],
        )
        .await
        {
            Ok(data) => {
                let fetched_at = now_ms();
                match store_coinbase_fx_table(cache, &data, fetched_at) {
                    Ok(()) => {
                        cache.remove("fx:coinbase:last-error");
                        cache.remove("fx:coinbase:last-error-at");
                        match parse_coinbase_fx_rate(&data, &quote) {
                            Ok(rate) => {
                                return Ok(FxRate {
                                    rate,
                                    source: "Coinbase FX",
                                    fetched_at,
                                    reference_date: None,
                                })
                            }
                            Err(error) => live_error = Some(error),
                        }
                    }
                    Err(error) => {
                        store_fx_error(
                            cache,
                            "fx:coinbase:last-error",
                            "fx:coinbase:last-error-at",
                            &error,
                        );
                        live_error = Some(error);
                    }
                }
            }
            Err(error) => {
                store_fx_error(
                    cache,
                    "fx:coinbase:last-error",
                    "fx:coinbase:last-error-at",
                    &error,
                );
                live_error = Some(error);
            }
        }
    } else if live_error.is_none() {
        live_error = Some(format!("Coinbase FX has no USD/{quote} rate"));
    }

    if let Some(rate) = cached_frankfurter_fx(
        cache,
        &quote,
        REFERENCE_FX_CACHE_MS,
        "Frankfurter reference rate",
    ) {
        return Ok(rate);
    }

    let mut reference_error = recent_fx_error(
        cache,
        "fx:frankfurter:last-error",
        "fx:frankfurter:last-error-at",
    );
    let reference_table_is_fresh = cache_timestamp(cache, "fx:frankfurter:usd-at")
        .is_some_and(|timestamp| cache_is_fresh(now_ms(), timestamp, REFERENCE_FX_CACHE_MS));
    if reference_error.is_none() && !reference_table_is_fresh {
        match fx_request(
            client,
            "Frankfurter",
            FRANKFURTER_FX_API,
            &[("base", "USD")],
        )
        .await
        {
            Ok(data) => {
                let fetched_at = now_ms();
                match store_frankfurter_fx_table(cache, &data, fetched_at) {
                    Ok(()) => {
                        cache.remove("fx:frankfurter:last-error");
                        cache.remove("fx:frankfurter:last-error-at");
                        match parse_frankfurter_fx_rate(&data, &quote) {
                            Ok((rate, reference_date)) => {
                                return Ok(FxRate {
                                    rate,
                                    source: "Frankfurter reference rate",
                                    fetched_at,
                                    reference_date,
                                })
                            }
                            Err(error) => reference_error = Some(error),
                        }
                    }
                    Err(error) => {
                        store_fx_error(
                            cache,
                            "fx:frankfurter:last-error",
                            "fx:frankfurter:last-error-at",
                            &error,
                        );
                        reference_error = Some(error);
                    }
                }
            }
            Err(error) => {
                store_fx_error(
                    cache,
                    "fx:frankfurter:last-error",
                    "fx:frankfurter:last-error-at",
                    &error,
                );
                reference_error = Some(error);
            }
        }
    } else if reference_error.is_none() {
        reference_error = Some(format!("Frankfurter has no USD/{quote} reference rate"));
    }

    if let Some(rate) = cached_coinbase_fx(cache, &quote, LIVE_FX_STALE_MS, "Coinbase FX (cached)")
    {
        return Ok(rate);
    }

    if let Some(rate) = cached_frankfurter_fx(
        cache,
        &quote,
        REFERENCE_FX_STALE_MS,
        "Frankfurter reference rate (cached)",
    ) {
        return Ok(rate);
    }

    Err(format!(
        "Could not convert USD to {quote}. {}; {}",
        live_error.unwrap_or_else(|| "Coinbase FX unavailable".into()),
        reference_error.unwrap_or_else(|| "Frankfurter unavailable".into())
    ))
}

fn apply_fx_rate(
    mut market: CryptoMarket,
    currency: &str,
    fx: FxRate,
) -> Result<CryptoMarket, String> {
    let quote = normalize_fx_quote(currency)?;
    let converted = market.price * fx.rate;
    if !converted.is_finite() || converted <= 0.0 {
        return Err(format!("USD/{quote} conversion produced an invalid price"));
    }
    let provider_raw = std::mem::take(&mut market.raw);
    market.raw = json!({
        "market": provider_raw,
        "fx": {
            "base": "USD",
            "quote": quote,
            "rate": fx.rate,
            "source": fx.source,
            "fetchedAt": fx.fetched_at,
            "referenceDate": fx.reference_date,
            "providerChangeBasis": "USD; FX movement is not included"
        }
    });
    market.currency = quote.to_ascii_lowercase();
    market.price = converted;
    Ok(market)
}

async fn convert_usd_market(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    market: CryptoMarket,
    currency: &str,
) -> Result<CryptoMarket, String> {
    if currency.eq_ignore_ascii_case("usd") {
        return Ok(market);
    }
    let fx = fetch_usd_fx_rate(client, cache, currency).await?;
    apply_fx_rate(market, currency, fx)
}

fn jupiter_request_gate() -> &'static tokio::sync::Mutex<Option<std::time::Instant>> {
    static GATE: OnceLock<tokio::sync::Mutex<Option<std::time::Instant>>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(None))
}

async fn wait_for_request_slot(
    gate: &tokio::sync::Mutex<Option<std::time::Instant>>,
    gap: Duration,
) -> std::time::Instant {
    let mut last = gate.lock().await;
    if let Some(previous) = *last {
        if let Some(remaining) = gap.checked_sub(previous.elapsed()) {
            tokio::time::sleep(remaining).await;
        }
    }
    let reserved_at = std::time::Instant::now();
    *last = Some(reserved_at);
    reserved_at
}

async fn wait_for_jupiter_slot() {
    wait_for_request_slot(
        jupiter_request_gate(),
        Duration::from_millis(JUPITER_REQUEST_GAP_MS as u64),
    )
    .await;
}

async fn jupiter_request(
    client: &reqwest::Client,
    endpoint: &str,
    params: &[(&str, &str)],
) -> Result<Value, String> {
    // This process-wide slot is intentionally independent from response/token
    // caches. Live refreshes and the editor's isolated Test request therefore
    // obey the same keyless Jupiter rate limit.
    wait_for_jupiter_slot().await;
    let response = client
        .get(format!("{JUPITER_API}{endpoint}"))
        .query(params)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| describe_reqwest(&error, false))?;
    let status = response.status();
    match status.as_u16() {
        401 | 403 => {
            return Err("Jupiter keyless access was refused. Try Automatic or DEX Screener.".into())
        }
        429 => return Err("Jupiter free limit reached — the app will retry with backoff.".into()),
        _ => {}
    }
    if !status.is_success() {
        return Err(format!(
            "Jupiter HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    response
        .json()
        .await
        .map_err(|error| describe_reqwest(&error, false))
}

fn shortened_mint(mint: &str) -> String {
    if mint.len() > 10 {
        format!("{}…{}", &mint[..4], &mint[mint.len() - 4..])
    } else {
        mint.to_string()
    }
}

async fn resolve_jupiter_token(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    input: &str,
) -> Result<(String, String, String), JupiterError> {
    if let Some((mint, symbol, name)) = known_solana_token(input) {
        return Ok((mint.into(), symbol.into(), name.into()));
    }
    if is_solana_mint(input) {
        let mint = input.trim().to_string();
        let (symbol, name) = known_solana_token_by_mint(&mint)
            .map(|(symbol, name)| (symbol.to_string(), name.to_string()))
            .unwrap_or_else(|| (shortened_mint(&mint), "Solana token".into()));
        return Ok((mint, symbol, name));
    }

    let query = input.trim().to_ascii_lowercase();
    if query.is_empty() {
        return Err(JupiterError::Unreliable("No coin set".into()));
    }
    let cache_key = format!("jupiter:token:{query}");
    if let Some(cached) = cache.get(&cache_key) {
        if let Ok(value) = serde_json::from_str::<Value>(cached) {
            if let (Some(mint), Some(symbol), Some(name)) = (
                value["id"].as_str(),
                value["symbol"].as_str(),
                value["name"].as_str(),
            ) {
                return Ok((mint.into(), symbol.into(), name.into()));
            }
        }
    }

    let shared_error_key = "jupiter:last-token-error";
    let shared_error_at_key = "jupiter:last-token-error-at";
    if cache_timestamp(cache, shared_error_at_key)
        .is_some_and(|timestamp| cache_is_fresh(now_ms(), timestamp, JUPITER_CACHE_MS))
    {
        if let Some(message) = cache.get(shared_error_key) {
            return Err(JupiterError::Temporary(message.clone()));
        }
    }

    let data = match jupiter_request(client, "/tokens/v2/search", &[("query", input)]).await {
        Ok(data) => {
            cache.remove(shared_error_key);
            cache.remove(shared_error_at_key);
            data
        }
        Err(error) => {
            cache.insert(shared_error_key.into(), error.clone());
            cache.insert(shared_error_at_key.into(), now_ms().to_string());
            return Err(JupiterError::Temporary(error));
        }
    };
    let tokens = data.as_array().cloned().unwrap_or_default();
    let exact = tokens.iter().find(|token| {
        ["id", "symbol", "name"].iter().any(|field| {
            token[*field]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(input.trim()))
        })
    });
    let Some(token) = exact.or_else(|| tokens.first()) else {
        return Err(JupiterError::Unreliable(format!(
            "Token \"{input}\" was not found on Solana. Try its mint address."
        )));
    };
    let Some(mint) = token["id"].as_str().filter(|mint| is_solana_mint(mint)) else {
        return Err(JupiterError::Unreliable(
            "Jupiter returned an invalid token address".into(),
        ));
    };
    let symbol = token["symbol"].as_str().unwrap_or(input).to_uppercase();
    let name = token["name"].as_str().unwrap_or(&symbol).to_string();
    cache.insert(
        cache_key,
        json!({"id": mint, "symbol": symbol, "name": name}).to_string(),
    );
    Ok((mint.to_string(), symbol, name))
}

async fn fetch_jupiter_batch(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    mints: &[String],
) -> Result<(), String> {
    let current_time = now_ms();
    let shared_error_key = "jupiter:last-batch-error";
    let shared_error_at_key = "jupiter:last-batch-error-at";
    if cache_timestamp(cache, shared_error_at_key)
        .is_some_and(|timestamp| cache_is_fresh(current_time, timestamp, JUPITER_CACHE_MS))
    {
        if let Some(message) = cache.get(shared_error_key) {
            return Err(message.clone());
        }
    }
    let mut stale: Vec<String> = Vec::new();
    for mint in mints {
        let timestamp_key = format!("jupiter:price-at:{mint}");
        let fresh = cache_timestamp(cache, &timestamp_key)
            .is_some_and(|at| cache_is_fresh(current_time, at, JUPITER_CACHE_MS));
        if !fresh && !stale.contains(mint) {
            stale.push(mint.clone());
        }
        if stale.len() == 50 {
            break;
        }
    }
    if stale.is_empty() {
        return Ok(());
    }

    let ids = stale.join(",");
    let data = match jupiter_request(client, "/price/v3", &[("ids", ids.as_str())]).await {
        Ok(data) => data,
        Err(error) => {
            cache.insert(shared_error_key.into(), error.clone());
            cache.insert(shared_error_at_key.into(), now_ms().to_string());
            return Err(error);
        }
    };
    cache.remove(shared_error_key);
    cache.remove(shared_error_at_key);
    let fetched_at = now_ms().to_string();
    for mint in stale {
        let market = data.get(&mint).cloned().unwrap_or(Value::Null);
        cache.insert(format!("jupiter:price:{mint}"), market.to_string());
        cache.insert(format!("jupiter:price-at:{mint}"), fetched_at.clone());
    }
    Ok(())
}

fn parse_jupiter_market(
    raw: Value,
    mint: String,
    symbol: String,
    name: String,
) -> Result<CryptoMarket, JupiterError> {
    let Some(price) = value_f64(&raw["usdPrice"]) else {
        return Err(JupiterError::Unreliable(format!(
            "Jupiter has no reliable price for {symbol}. Choose DEX Screener to use a pool quote."
        )));
    };
    let mut changes = HashMap::new();
    if let Some(change) = value_f64(&raw["priceChange24h"]) {
        changes.insert("24h".into(), change);
    }
    Ok(CryptoMarket {
        source: "Jupiter",
        id: mint,
        symbol,
        name,
        currency: "usd".into(),
        price,
        changes,
        raw,
    })
}

async fn fetch_jupiter_crypto(
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
    input: &str,
    batch_mints: &[String],
) -> Result<CryptoMarket, JupiterError> {
    let (mint, symbol, name) = resolve_jupiter_token(client, cache, input).await?;
    let mut mints = Vec::with_capacity(batch_mints.len() + 1);
    mints.push(mint.clone());
    mints.extend(batch_mints.iter().cloned());
    fetch_jupiter_batch(client, cache, &mints)
        .await
        .map_err(JupiterError::Temporary)?;
    let raw = cache
        .get(&format!("jupiter:price:{mint}"))
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(Value::Null);
    parse_jupiter_market(raw, mint, symbol, name)
}

fn parse_dexscreener_market(data: &Value, mint: &str) -> Result<CryptoMarket, String> {
    let pairs = data
        .as_array()
        .ok_or("DEX Screener returned an invalid response")?;
    let mut best: Option<(f64, &Value)> = None;
    for pair in pairs {
        if pair["chainId"].as_str() != Some("solana")
            || pair["baseToken"]["address"].as_str() != Some(mint)
            || value_f64(&pair["priceUsd"]).is_none()
        {
            continue;
        }
        let liquidity = value_f64(&pair["liquidity"]["usd"]).unwrap_or(0.0);
        if best.is_none_or(|(current, _)| liquidity > current) {
            best = Some((liquidity, pair));
        }
    }
    let Some((_liquidity, pair)) = best else {
        return Err("DEX Screener found no USD-priced Solana pool for this token".into());
    };
    let mut changes = HashMap::new();
    for (field, label) in [("m5", "5m"), ("h1", "1h"), ("h24", "24h")] {
        if let Some(change) = value_f64(&pair["priceChange"][field]) {
            changes.insert(label.into(), change);
        }
    }
    Ok(CryptoMarket {
        source: "DEX Screener",
        id: mint.into(),
        symbol: pair["baseToken"]["symbol"]
            .as_str()
            .map(str::to_uppercase)
            .unwrap_or_else(|| shortened_mint(mint)),
        name: pair["baseToken"]["name"]
            .as_str()
            .unwrap_or("Solana token")
            .to_string(),
        currency: "usd".into(),
        price: value_f64(&pair["priceUsd"]).expect("filtered price"),
        changes,
        raw: json!({
            "pairAddress": pair["pairAddress"],
            "dexId": pair["dexId"],
            "liquidityUsd": pair["liquidity"]["usd"],
        }),
    })
}

async fn fetch_dexscreener_crypto(
    client: &reqwest::Client,
    input: &str,
) -> Result<CryptoMarket, String> {
    let Some(mint) = solana_mint_hint(input) else {
        return Err("DEX Screener needs SOL, JUP, USDC or a Solana mint address".into());
    };
    let response = client
        .get(format!("{DEXSCREENER_API}/token-pairs/v1/solana/{mint}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| describe_reqwest(&error, false))?;
    let status = response.status();
    if status.as_u16() == 429 {
        return Err("DEX Screener rate limit reached — the app will retry with backoff".into());
    }
    if !status.is_success() {
        return Err(format!(
            "DEX Screener HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    let data = response
        .json::<Value>()
        .await
        .map_err(|error| describe_reqwest(&error, false))?;
    parse_dexscreener_market(&data, &mint)
}

fn format_crypto_market(
    cfg: &Request,
    market: CryptoMarket,
    history: &mut PriceHistory,
    record: bool,
) -> Fetched {
    let holdings = to_number(&json!(cfg.holdings));
    let balance = holdings
        .map(|amount| amount * market.price)
        .unwrap_or(market.price);
    let decimals = parse_decimals(&cfg.length);
    let history_key = format!("{}:{}:{}", market.source, market.id, market.currency);
    if record {
        history.record(&history_key, market.price);
    }

    let mut values = serde_json::Map::new();
    values.insert("symbol".into(), json!(market.symbol));
    values.insert("name".into(), json!(market.name));
    values.insert("source".into(), json!(market.source));
    let price_text = format_money(market.price, &market.currency, decimals);
    values.insert("price".into(), json!(price_text.clone()));
    values.insert(
        "holdings".into(),
        json!(holdings
            .map(super::format::format_locale_thousands)
            .unwrap_or_default()),
    );
    values.insert(
        "balance".into(),
        json!(format_money(balance, &market.currency, decimals)),
    );

    for label in DISPLAY_PERIODS {
        values.insert(format!("change{label}"), json!(format_percent(None)));
        values.insert(
            format!("gain{label}"),
            json!(format_gain(None, balance, &market.currency, decimals)),
        );
    }
    for (label, minutes) in LOCAL_PERIODS {
        let change = history.change_since(&history_key, *minutes, market.price);
        values.insert(format!("change{label}"), json!(format_percent(change)));
        values.insert(
            format!("gain{label}"),
            json!(format_gain(change, balance, &market.currency, decimals)),
        );
    }
    for (label, change) in &market.changes {
        values.insert(
            format!("change{label}"),
            json!(format_percent(Some(*change))),
        );
        values.insert(
            format!("gain{label}"),
            json!(format_gain(
                Some(*change),
                balance,
                &market.currency,
                decimals
            )),
        );
    }

    let fallback = if holdings.is_some() {
        "{symbol} {balance} {change24h}"
    } else {
        "{symbol} {price} {change24h}"
    };
    let template = if cfg.template.trim().is_empty() {
        fallback
    } else {
        cfg.template.trim()
    };
    let rendered = render_template(template, &values);
    let pct_24h = market.changes.get("24h").copied();
    Fetched {
        text: cap_display_value(format!("{}{}{}", cfg.prefix, rendered, cfg.suffix)),
        raw_log: truncate_msg(
            &json!({
                "provider": market.source,
                "id": market.id,
                "currency": market.currency,
                "price": market.price,
                "market": market.raw,
            })
            .to_string(),
            500,
        ),
        numeric: Some(balance),
        alert_numeric: Some(market.price),
        alert_text: price_text,
        pct_24h,
    }
}

pub async fn fetch_crypto_value(
    client: &reqwest::Client,
    cfg: &Request,
    cache: &mut HashMap<String, String>,
    history: &mut PriceHistory,
    jupiter_batch: &[String],
    record: bool,
) -> Result<Fetched, String> {
    cfg.validate_for_save()?;
    let currency = currency_for(&cfg.currency);
    let market = match cfg.crypto_provider() {
        "jupiter" => {
            let market = fetch_jupiter_crypto(client, cache, &cfg.coin, jupiter_batch)
                .await
                .map_err(JupiterError::message)?;
            convert_usd_market(client, cache, market, &currency).await?
        }
        "dexscreener" => {
            if currency != "usd" {
                return Err("DEX Screener quotes USD only. Choose USD or Automatic.".into());
            }
            fetch_dexscreener_crypto(client, &cfg.coin).await?
        }
        "coingecko" => fetch_coingecko_crypto(client, cache, &cfg.coin, &currency).await?,
        _ if solana_mint_hint(&cfg.coin).is_some() && jupiter_currency_supported(&currency) => {
            match fetch_jupiter_crypto(client, cache, &cfg.coin, jupiter_batch).await {
                Ok(market) => convert_usd_market(client, cache, market, &currency).await?,
                Err(JupiterError::Unreliable(message)) => return Err(message),
                Err(JupiterError::Temporary(primary)) => {
                    match fetch_dexscreener_crypto(client, &cfg.coin).await {
                        Ok(market) => {
                            convert_usd_market(client, cache, market, &currency).await?
                        }
                        Err(fallback)
                            if currency == "usd"
                                && known_solana_token(&cfg.coin).is_some() =>
                        {
                            fetch_coingecko_crypto(client, cache, &cfg.coin, &currency)
                                .await
                                .map_err(|final_error| {
                                    format!(
                                        "Jupiter unavailable ({primary}); DEX Screener fallback failed ({fallback}); CoinGecko fallback failed ({final_error})"
                                    )
                                })?
                        }
                        Err(fallback) => {
                            return Err(format!(
                                "Jupiter unavailable ({primary}); DEX Screener fallback failed ({fallback})"
                            ))
                        }
                    }
                }
            }
        }
        _ => fetch_coingecko_crypto(client, cache, &cfg.coin, &currency).await?,
    };
    Ok(format_crypto_market(cfg, market, history, record))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_fx_rate, cache_is_fresh, client, final_coingecko_market, format_crypto_market,
        is_local_url, jupiter_batch_mint, jupiter_batch_mint_from_cache, now_ms,
        parse_coinbase_fx_rate, parse_dexscreener_market, parse_frankfurter_fx_rate,
        parse_jupiter_market, resolve_jupiter_token, solana_mint_hint, store_coinbase_fx_table,
        store_frankfurter_fx_table, wait_for_request_slot, CryptoMarket, FxRate, JupiterError,
    };
    use crate::engine::crypto_route::SOL_MINT;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn recognises_local_network_destinations() {
        for url in [
            "http://192.168.1.170:1430/",
            "http://10.0.0.2/",
            "http://172.16.4.8/",
            "http://127.0.0.1/",
            "http://server.local/status",
            "http://nas/status",
            "http://[fd00::1]/",
        ] {
            assert!(is_local_url(url), "expected local URL: {url}");
        }
        assert!(!is_local_url("https://api.example.com/value"));
        assert!(!is_local_url("not a URL"));
    }

    #[test]
    fn recognises_sol_and_raw_solana_mints_for_batching() {
        assert_eq!(solana_mint_hint("SOL").as_deref(), Some(SOL_MINT));
        assert_eq!(solana_mint_hint(SOL_MINT).as_deref(), Some(SOL_MINT));
        assert!(solana_mint_hint("bitcoin").is_none());
        assert!(solana_mint_hint("not-a-mint-000000000000000000000000000").is_none());
    }

    #[test]
    fn crypto_threshold_alerts_use_price_instead_of_zero_holdings() {
        let values = serde_json::json!({
            "type": "crypto",
            "coin": "SOL",
            "holdings": "0",
            "currency": "usd",
            "template": "{price}",
            "length": "3"
        });
        let request = crate::engine::model::request_from_clean("sol", values.as_object().unwrap());
        let market = CryptoMarket {
            source: "Jupiter",
            id: SOL_MINT.into(),
            symbol: "SOL".into(),
            name: "Solana".into(),
            currency: "usd".into(),
            price: 104.299,
            changes: HashMap::new(),
            raw: serde_json::Value::Null,
        };

        let fetched = format_crypto_market(
            &request,
            market,
            &mut crate::engine::price_history::PriceHistory::default(),
            false,
        );

        assert_eq!(fetched.text, "$104.299");
        assert_eq!(fetched.numeric, Some(0.0));
        assert_eq!(fetched.alert_numeric, Some(104.299));
        assert_eq!(fetched.alert_text, "$104.299");
    }

    #[test]
    fn crypto_threshold_alerts_ignore_balance_first_templates() {
        let values = serde_json::json!({
            "type": "crypto",
            "coin": "SOL",
            "holdings": "2",
            "currency": "usd",
            "template": "{balance} at {price} each"
        });
        let request = crate::engine::model::request_from_clean("sol", values.as_object().unwrap());
        let market = CryptoMarket {
            source: "Jupiter",
            id: SOL_MINT.into(),
            symbol: "SOL".into(),
            name: "Solana".into(),
            currency: "usd".into(),
            price: 50.0,
            changes: HashMap::new(),
            raw: serde_json::Value::Null,
        };

        let fetched = format_crypto_market(
            &request,
            market,
            &mut crate::engine::price_history::PriceHistory::default(),
            false,
        );

        assert_eq!(fetched.numeric, Some(100.0));
        assert_eq!(fetched.alert_numeric, Some(50.0));
        assert_eq!(fetched.alert_text, "$50.00");
    }

    #[test]
    fn automatic_solana_batches_jupiter_prices_in_fiat_currencies() {
        let values = serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "SOL",
            "currency": "gbp"
        });
        let request = crate::engine::model::request_from_clean("sol", values.as_object().unwrap());
        assert_eq!(jupiter_batch_mint(&request).as_deref(), Some(SOL_MINT));

        let special_quote = serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "SOL",
            "currency": "sats"
        });
        let request = crate::engine::model::request_from_clean(
            "sol-sats",
            special_quote.as_object().unwrap(),
        );
        assert!(jupiter_batch_mint(&request).is_none());
    }

    #[test]
    fn resolved_explicit_jupiter_tickers_join_later_price_batches() {
        let values = serde_json::json!({
            "type": "crypto",
            "provider": "jupiter",
            "coin": "bonk",
            "currency": "gbp"
        });
        let request = crate::engine::model::request_from_clean("bonk", values.as_object().unwrap());
        let mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6jWABWKvr1pPB263";
        let cache = HashMap::from([(
            "jupiter:token:bonk".into(),
            serde_json::json!({"id": mint, "symbol": "BONK", "name": "Bonk"}).to_string(),
        )]);
        assert_eq!(
            jupiter_batch_mint_from_cache(&request, &cache).as_deref(),
            Some(mint)
        );

        let automatic_values = serde_json::json!({
            "type": "crypto",
            "provider": "auto",
            "coin": "bonk",
            "currency": "usd"
        });
        let automatic = crate::engine::model::request_from_clean(
            "automatic",
            automatic_values.as_object().unwrap(),
        );
        assert!(jupiter_batch_mint_from_cache(&automatic, &cache).is_none());
    }

    #[tokio::test]
    async fn token_lookup_provider_errors_are_shared_for_the_short_cache_window() {
        let mut cache = HashMap::from([
            (
                "jupiter:last-token-error".into(),
                "temporary provider failure".into(),
            ),
            ("jupiter:last-token-error-at".into(), now_ms().to_string()),
        ]);
        let error = resolve_jupiter_token(client(), &mut cache, "bonk")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            JupiterError::Temporary(message) if message == "temporary provider failure"
        ));
    }

    #[test]
    fn jupiter_omission_is_not_silently_treated_as_a_price() {
        let error = parse_jupiter_market(
            serde_json::Value::Null,
            SOL_MINT.into(),
            "SOL".into(),
            "Solana".into(),
        )
        .unwrap_err();
        assert!(matches!(error, JupiterError::Unreliable(_)));
    }

    #[test]
    fn parses_live_and_reference_usd_fx_tables() {
        let coinbase = serde_json::json!({
            "data": {
                "currency": "USD",
                "rates": {"GBP": "0.75", "EUR": "0.86"}
            }
        });
        assert_eq!(parse_coinbase_fx_rate(&coinbase, "GBP").unwrap(), 0.75);
        assert!(parse_coinbase_fx_rate(&coinbase, "AUD").is_err());

        let frankfurter = serde_json::json!([
            {"date": "2026-08-21", "base": "USD", "quote": "GBP", "rate": 0.7485},
            {"date": "2026-08-21", "base": "USD", "quote": "EUR", "rate": 0.8602}
        ]);
        assert_eq!(
            parse_frankfurter_fx_rate(&frankfurter, "GBP").unwrap(),
            (0.7485, Some("2026-08-21".into()))
        );
        assert!(parse_frankfurter_fx_rate(&frankfurter, "AUD").is_err());
    }

    #[test]
    fn malformed_fx_tables_do_not_replace_the_last_good_cache() {
        let mut coinbase_cache = HashMap::from([
            ("fx:coinbase:usd".into(), "last-good-coinbase".into()),
            ("fx:coinbase:usd-at".into(), "123".into()),
        ]);
        let bad_coinbase = serde_json::json!({
            "data": {"currency": "USD", "rates": {"GBP": "not-a-rate"}}
        });
        assert!(store_coinbase_fx_table(&mut coinbase_cache, &bad_coinbase, 456).is_err());
        assert_eq!(
            coinbase_cache.get("fx:coinbase:usd").map(String::as_str),
            Some("last-good-coinbase")
        );
        assert_eq!(
            coinbase_cache.get("fx:coinbase:usd-at").map(String::as_str),
            Some("123")
        );

        let mut reference_cache = HashMap::from([
            ("fx:frankfurter:usd".into(), "last-good-reference".into()),
            ("fx:frankfurter:usd-at".into(), "789".into()),
        ]);
        let bad_reference = serde_json::json!([
            {"date": "2026-08-21", "base": "EUR", "quote": "GBP", "rate": 0.7485}
        ]);
        assert!(store_frankfurter_fx_table(&mut reference_cache, &bad_reference, 999).is_err());
        assert_eq!(
            reference_cache
                .get("fx:frankfurter:usd")
                .map(String::as_str),
            Some("last-good-reference")
        );
        assert_eq!(
            reference_cache
                .get("fx:frankfurter:usd-at")
                .map(String::as_str),
            Some("789")
        );
    }

    #[test]
    fn converts_jupiter_price_without_relabelling_its_usd_change() {
        let market = parse_jupiter_market(
            serde_json::json!({"usdPrice": 100, "priceChange24h": 2.5}),
            SOL_MINT.into(),
            "SOL".into(),
            "Solana".into(),
        )
        .unwrap();
        let converted = apply_fx_rate(
            market,
            "gbp",
            FxRate {
                rate: 0.75,
                source: "Coinbase FX",
                fetched_at: 1_777_777_777_000,
                reference_date: None,
            },
        )
        .unwrap();

        assert_eq!(converted.source, "Jupiter");
        assert_eq!(converted.currency, "gbp");
        assert_eq!(converted.price, 75.0);
        assert_eq!(converted.changes.get("24h"), Some(&2.5));
        assert_eq!(converted.raw["fx"]["rate"], 0.75);
        assert_eq!(converted.raw["fx"]["source"], "Coinbase FX");
        assert_eq!(
            converted.raw["fx"]["providerChangeBasis"],
            "USD; FX movement is not included"
        );
    }

    #[test]
    fn a_future_wall_clock_timestamp_is_never_a_fresh_cache_entry() {
        assert!(cache_is_fresh(10_000, 9_500, 1_000));
        assert!(!cache_is_fresh(10_000, 10_001, 1_000));
        assert!(!cache_is_fresh(10_000, 9_000, 1_000));
    }

    #[test]
    fn dexscreener_chooses_the_highest_liquidity_base_pool() {
        let data = serde_json::json!([
            {
                "chainId": "solana",
                "baseToken": {"address": SOL_MINT, "symbol": "SOL", "name": "Solana"},
                "priceUsd": "120.5",
                "liquidity": {"usd": 10},
                "priceChange": {"h24": 1.0}
            },
            {
                "chainId": "solana",
                "baseToken": {"address": SOL_MINT, "symbol": "SOL", "name": "Solana"},
                "priceUsd": "121.75",
                "liquidity": {"usd": 1000},
                "priceChange": {"m5": 0.1, "h1": 0.5, "h24": 2.5}
            },
            {
                "chainId": "solana",
                "baseToken": {"address": "Other1111111111111111111111111111111111"},
                "quoteToken": {"address": SOL_MINT},
                "priceUsd": "999",
                "liquidity": {"usd": 999999}
            }
        ]);
        let market = parse_dexscreener_market(&data, SOL_MINT).unwrap();
        assert_eq!(market.price, 121.75);
        assert_eq!(market.changes.get("24h"), Some(&2.5));
    }

    #[test]
    fn final_coingecko_lookup_preserves_provider_errors() {
        let limited = final_coingecko_market(
            Err("CoinGecko rate limit reached — use a longer refresh interval".into()),
            "usd",
        )
        .unwrap_err();
        assert!(limited.contains("rate limit"));

        let currency = final_coingecko_market(Err("__CURRENCY__".into()), "xyz").unwrap_err();
        assert_eq!(currency, "Currency \"xyz\" is not supported by CoinGecko");
    }

    #[tokio::test]
    async fn request_gate_serializes_independent_callers() {
        let gate = Arc::new(tokio::sync::Mutex::new(None));
        let gap = Duration::from_millis(20);
        let (a, b) = tokio::join!(
            wait_for_request_slot(&gate, gap),
            wait_for_request_slot(&gate, gap)
        );
        let separation = if a >= b {
            a.duration_since(b)
        } else {
            b.duration_since(a)
        };
        assert!(separation >= gap);
    }
}
