// Pure Solana routing facts shared by the fetch engine, scheduler and editor
// validation. Keeping this decision in one place prevents Automatic from using
// a fast Jupiter schedule when the request will actually go to CoinGecko.

pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const JUP_MINT: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
pub const USDC_SOL_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

pub fn known_solana_token(input: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match input.trim().to_ascii_lowercase().as_str() {
        "sol" | "solana" | "wsol" => Some((SOL_MINT, "SOL", "Solana")),
        "jup" | "jupiter" => Some((JUP_MINT, "JUP", "Jupiter")),
        "usdc" => Some((USDC_SOL_MINT, "USDC", "USD Coin")),
        _ => None,
    }
}

pub fn known_solana_token_by_mint(mint: &str) -> Option<(&'static str, &'static str)> {
    match mint {
        SOL_MINT => Some(("SOL", "Solana")),
        JUP_MINT => Some(("JUP", "Jupiter")),
        USDC_SOL_MINT => Some(("USDC", "USD Coin")),
        _ => None,
    }
}

pub fn is_solana_mint(input: &str) -> bool {
    let input = input.trim();
    (32..=44).contains(&input.len())
        && input
            .bytes()
            .all(|byte| matches!(byte, b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'a'..=b'k' | b'm'..=b'z'))
}

pub fn solana_mint_hint(input: &str) -> Option<String> {
    known_solana_token(input)
        .map(|token| token.0.to_string())
        .or_else(|| is_solana_mint(input).then(|| input.trim().to_string()))
}

pub fn currency_for(raw: &str) -> String {
    let currency = raw.trim().to_ascii_lowercase();
    if currency.is_empty() {
        "gbp".into()
    } else {
        currency
    }
}

/// Jupiter prices are denominated in USD. The built-in FX bridge deliberately
/// accepts ordinary three-letter currency codes; CoinGecko remains available
/// for its special quote units such as `bits` and `sats`.
pub fn jupiter_currency_supported(raw: &str) -> bool {
    let currency = currency_for(raw);
    currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_alphabetic())
}

/// Provider policy used only for refresh limits. Explicit provider choices keep
/// their own policy; Automatic is fast only when its fetch branch can go to
/// Jupiter. A supported display currency does not change that source:
/// Jupiter's USD quote is converted through the shared FX cache. Every other
/// Automatic shape gets CoinGecko's cautious cadence.
pub fn refresh_policy_provider(provider: &str, coin: &str, currency: &str) -> &'static str {
    match provider {
        "jupiter" => "jupiter",
        "dexscreener" => "dexscreener",
        "coingecko" => "coingecko",
        _ if solana_mint_hint(coin).is_some() && jupiter_currency_supported(currency) => "jupiter",
        _ => "coingecko",
    }
}

#[cfg(test)]
mod tests {
    use super::{jupiter_currency_supported, refresh_policy_provider, SOL_MINT};

    #[test]
    fn automatic_is_fast_for_recognised_solana_requests_in_supported_currencies() {
        assert_eq!(refresh_policy_provider("auto", "sol", "usd"), "jupiter");
        assert_eq!(refresh_policy_provider("auto", SOL_MINT, "USD"), "jupiter");
        assert_eq!(refresh_policy_provider("auto", "btc", "usd"), "coingecko");
        assert_eq!(refresh_policy_provider("auto", "sol", "gbp"), "jupiter");
        assert_eq!(refresh_policy_provider("auto", "sol", ""), "jupiter");
        assert_eq!(refresh_policy_provider("auto", "sol", "sats"), "coingecko");
        assert!(jupiter_currency_supported("GBP"));
        assert!(!jupiter_currency_supported("sats"));
    }

    #[test]
    fn explicit_provider_policy_does_not_depend_on_the_coin() {
        assert_eq!(
            refresh_policy_provider("jupiter", "unknown", "gbp"),
            "jupiter"
        );
        assert_eq!(
            refresh_policy_provider("dexscreener", "sol", "usd"),
            "dexscreener"
        );
        assert_eq!(
            refresh_policy_provider("coingecko", "sol", "usd"),
            "coingecko"
        );
    }
}
