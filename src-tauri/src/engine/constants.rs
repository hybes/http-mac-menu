// Limits and defaults shared by the engine, the tray and the settings form.

pub const MAX_REQUESTS: usize = 10;
pub const LEGACY_CONFIG_COUNT: usize = 3;

// Prefix and suffix keep their whitespace on purpose (" USD", "$ ").
pub const UNTRIMMED_FIELDS: [&str; 2] = ["prefix", "suffix"];

pub const MIN_REFRESH_HTTP: i64 = 5;
// Jupiter's keyless edge is cached for five seconds. Solana-aware sources can
// therefore refresh at that cadence, while CoinGecko keeps its more cautious
// public-API floor below.
pub const MIN_REFRESH_CRYPTO: i64 = 5;
pub const MIN_REFRESH_SLOW_CRYPTO: i64 = 30;
pub const DEFAULT_REFRESH_HTTP: i64 = 5;
pub const DEFAULT_REFRESH_CRYPTO: i64 = 5;
pub const DEFAULT_REFRESH_DEXSCREENER: i64 = 30;
pub const DEFAULT_REFRESH_COINGECKO: i64 = 60;
/// User-entered schedules are bounded both for usability and so adding them
/// to a monotonic `Instant` can never overflow.
pub const MAX_REFRESH_SECONDS: i64 = 24 * 60 * 60;

pub const MAX_BACKOFF_MULTIPLIER: f64 = 8.0;
pub const MAX_BACKOFF_SECONDS: i64 = 10 * 60;
pub const OFFLINE_RETRY_SECONDS: i64 = 15;
pub const REQUEST_TIMEOUT_MS: u64 = 15_000;
pub const MAX_HTTP_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Responses may be large enough to parse, but values cross IPC and are copied
/// into native widget snapshots. Keep the rendered surface safely bounded.
pub const MAX_DISPLAY_VALUE_CHARS: usize = 4_096;
pub const MAX_CONCURRENT_REQUESTS: usize = 4;
pub const LOCAL_FIRST_RETRY_SECONDS: i64 = 3;

// Graph samples are kept locally at two resolutions. Recent values retain a
// 15-second cadence so a five-second Jupiter feed draws a useful curve instead
// of only a handful of vertices. Once samples are six hours old they are
// compacted into five-minute buckets, keeping a bounded seven-day trend without
// repeatedly writing an ever-growing high-resolution document.
pub const SERIES_SAMPLE_INTERVAL_MS: i64 = 15_000;
pub const SERIES_HIGH_RESOLUTION_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;
pub const SERIES_ARCHIVE_INTERVAL_MS: i64 = 5 * 60 * 1000;
pub const SERIES_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const SERIES_GRAPH_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
pub const SERIES_MAX_STORED_POINTS: usize = 4_096;
pub const SERIES_MAX_SNAPSHOT_POINTS: usize = 256;

pub const TITLE_SEPARATOR: &str = " | ";
pub const PLACEHOLDER_TITLE: &str = "HTTP Widgets";
pub const PENDING_TITLE: &str = "…";
pub const UNAVAILABLE: &str = "–";
pub const MAX_ITEM_TITLE_CHARS: usize = 40;
pub const MAX_TITLE_CHARS: usize = 100;

// 1: tidied junk keys and millisecond refresh values.
// 2: three numbered slots became a list of requests the user controls.
// 3: alerts added per request (absent = none, so no data migration needed).
// 4: crypto provider preference added (absent = automatic).
pub const SETTINGS_SCHEMA_VERSION: u32 = 4;

pub fn min_refresh_seconds(crypto: bool) -> i64 {
    if crypto {
        MIN_REFRESH_CRYPTO
    } else {
        MIN_REFRESH_HTTP
    }
}

pub fn default_refresh_seconds(crypto: bool) -> i64 {
    if crypto {
        DEFAULT_REFRESH_CRYPTO
    } else {
        DEFAULT_REFRESH_HTTP
    }
}

pub fn min_refresh_for_provider(crypto: bool, provider: &str) -> i64 {
    if crypto && matches!(provider, "dexscreener" | "coingecko") {
        MIN_REFRESH_SLOW_CRYPTO
    } else {
        min_refresh_seconds(crypto)
    }
}

pub fn default_refresh_for_provider(crypto: bool, provider: &str) -> i64 {
    if crypto {
        match provider {
            "dexscreener" => DEFAULT_REFRESH_DEXSCREENER,
            "coingecko" => DEFAULT_REFRESH_COINGECKO,
            _ => default_refresh_seconds(true),
        }
    } else {
        default_refresh_seconds(false)
    }
}
