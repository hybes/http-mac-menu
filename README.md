# Show HTTP Response in System Tray

<img width="100%" alt="image" src="https://github.com/Hybes/http-mac-menu/assets/53020786/acb1e550-6970-4bbf-a882-de02333168a7">

## Download/Releases

If you don't know which option to select, choose the first one:<br><br>
[Mac OS - 64Bit/Intel](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0.dmg)<br>
[Mac OS - ARM64/Silicon](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0-arm64.dmg)

[Mac OS ZIP - 64Bit/Intel](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0-mac.zip)<br>
[Mac OS ZIP - ARM64/Silicon](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0-arm64-mac.zip)

I don't understand Apple's quarantine stuff, so you might need to run: `xattr -cr /Applications/HTTP\ Mac\ Menu.app` in terminal after you've moved the app to your Applications folder.

## Usage

The app lives in the menu bar. On first launch it shows **HTTP Menu** and opens the settings window for Request 1. Once a request is set up, its result replaces the label.

Click the menu bar item to:

- open the settings for **Request 1–3** (each line also shows the current value or error)
- **Refresh Now**
- toggle **Launch at Login**
- **Open Log**
- **Quit**

Closing the settings window (the red button, `⌘W` or `Esc`) keeps the app running. `⌘Q` quits it.

### Multiple requests

Up to 3 requests can be configured, each with its own settings. Their values are shown side by side, separated by `|`.

Each request is either an **HTTP request** (show something from any URL) or **Crypto** (track a coin or your holdings, no API key needed).

## Settings

### Crypto

| Field        | What it does                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Coin**     | Ticker or CoinGecko id, e.g. `SOL`, `BTC`, `solana`.                                                                              |
| **Holdings** | Optional. How many you own. Enables `{balance}` and the `{gain…}` placeholders.                                                   |
| **Currency** | `gbp` by default. Anything CoinGecko supports: `usd`, `eur`, `btc`, …                                                             |
| **Decimals** | Optional. Decimal places for prices and balances.                                                                                 |
| **Show**     | Optional template. Defaults to `{symbol} {balance} {change24h}` when you have holdings, otherwise `{symbol} {price} {change24h}`. |

Template placeholders:

- `{symbol}` `{name}` `{price}` `{holdings}` `{balance}`
- Percentage change: `{change1m}` `{change5m}` `{change15m}` `{change30m}` `{change1h}` `{change24h}` `{change7d}` `{change30d}`
- The same periods as money: `{gain1m}` … `{gain30d}` (based on your holdings, or one coin if you have none)

Examples: `SOL {price}` → `SOL £68.86`, `{balance} {change24h} ({gain24h})` → `£6,886.00 ▲7.10% (▲£456.49)`.

Hourly and longer changes come from CoinGecko. Minute changes are measured by the app from its own refreshes, so they show `–` until it has been running for that long (and need a refresh interval no longer than the period). CoinGecko's free API only updates about once a minute and allows a handful of requests per minute, so the refresh is at least 30 seconds (60 by default).

### HTTP request

| Field               | What it does                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **URL**             | The address to GET.                                                                                                                          |
| **Headers**         | Optional request headers, one per line or comma separated, as `Name: value`.                                                                 |
| **JSON path**       | Optional. Picks a value out of a JSON response, e.g. `data.price` or `items[0].value`. Leave blank if the response is plain text.            |
| **Multiplier**      | Optional. Multiplies a numeric value and formats it with thousands separators (`12000` → `12,000`). Use `1` if you only want the formatting. |
| **Decimals**        | Optional. Number of decimal places for numbers, or a maximum length for text.                                                                |
| **Prefix / Suffix** | Text added before/after the value, e.g. `$` or ` USD`.                                                                                       |
| **Refresh every**   | How often to fetch, in seconds. Minimum 5.                                                                                                   |

Use **Test** to see exactly what the menu bar will show before you save.

**⚠** in the menu bar means the last fetch failed. If there was a previous value it is still shown after the ⚠; hover the menu bar item or open the menu for the error, or use **Open Log** for the full history. While a request keeps failing its refresh interval doubles (up to 10 minutes) so a broken or rate-limited endpoint isn't hammered.

## Troubleshooting

What is there to go wrong?

If something does... contact me: help@cnnct.uk

## Building

If you wanna build it yourself, you can clone the repo: <br>
`git clone https://github.com/Hybes/http-mac-menu`
Fetch the node packages with <br>`npm i`
Build the installers with <br>`npm run dist`
Or test in dev with <br>`npm run start` (`npm run dev` skips error reporting)

To build and install it straight into `/Applications` on this Mac (and relaunch it): <br>`npm run install:local`

This also unregisters the Electron helper bundles from LaunchServices, otherwise Spotlight on recent macOS lists "HTTP Mac Menu Helper (GPU)" and friends as if they were apps.
