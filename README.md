# Show HTTP Response in System Tray

<img width="100%" alt="image" src="https://github.com/Hybes/http-mac-menu/assets/53020786/acb1e550-6970-4bbf-a882-de02333168a7">

## Download/Releases

Every push to `main` publishes a new build: **[latest release](https://github.com/hybes/http-mac-menu/releases/latest)**.

If you don't know which option to select, choose the first one:<br><br>
[Mac OS - 64Bit/Intel](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0.dmg)<br>
[Mac OS - ARM64/Silicon](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0-arm64.dmg)

[Mac OS ZIP - 64Bit/Intel](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0-mac.zip)<br>
[Mac OS ZIP - ARM64/Silicon](https://store.brth.uk/hybes/HTTP%20Mac%20Menu-1.6.0-arm64-mac.zip)

I don't understand Apple's quarantine stuff, so you might need to run: `xattr -cr /Applications/HTTP\ Mac\ Menu.app` in terminal after you've moved the app to your Applications folder.

## Usage

The app lives in the menu bar. On first launch it shows **HTTP Menu** and opens the settings window for Request 1. Once a request is set up, its result replaces the label.

Click the menu bar item to:

- open the settings for any request (each line also shows the current value or error)
- **Add Request…**
- **Refresh Now**
- **Copy Value** — copy any request's current value, or all of them at once
- **Rise / Fall Icon** — pick how up and down are drawn: chevron, arrow, triangle, or plain text
- **Pause Updates** — stop refreshing until you resume (handy on a slow connection or on battery)
- toggle **Launch at Login**
- **Open Log**
- **Quit**

Closing the settings window (the red button, `⌘W` or `Esc`) keeps the app running. `⌘Q` quits it. If you have edited something without saving it asks before discarding.

The settings window follows the system: light or dark to match macOS, your own accent colour, the system font, and it sizes itself to its contents so there is nothing to scroll.

### Multiple requests

Add as many requests as you like with **Add Request…**, up to 10 — beyond that the menu bar stops being readable. Remove one with the **Remove** button in its settings. Their values are shown side by side, separated by `|`, in the order you added them.

Each request is either an **HTTP request** (show something from any URL) or **Crypto** (track a coin or your holdings, no API key needed).

Give a request a **Name** and the menu and tooltip use it instead of `Request 1`.

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

Examples: `SOL {price}` → `SOL £68.86`, `{balance} {change24h} ({gain24h})` → `£6,886.00 ▴7.10% (▴£456.49)`, where each `▴` is drawn as your chosen icon.

Rise and fall are drawn as real icons rather than text characters. The menu bar contents are rendered into a template image, so the icon is a crisp vector that macOS recolours for light and dark by itself. Choose the shape under **Rise / Fall Icon** in the menu; **Text** goes back to plain `▴`/`▾` characters. If drawing the image ever fails the app falls back to text on its own, so the menu bar is never left blank.

Values sit side by side with plain spacing — there is no separator character to fight with. Inside a single crypto request the layout is yours: `{price} {change24h}` puts a space between them.

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
| **Name**            | Optional. What to call this request in the menu, e.g. `Server` or `BTC`. Defaults to `Request 1`.                                            |
| **Refresh every**   | How often to fetch, in seconds. Minimum 5.                                                                                                   |

Use **Test** to see exactly what the menu bar will show before you save.

**⚠** in the menu bar means the last fetch failed. If there was a previous value it is still shown after the ⚠; hover the menu bar item or open the menu for the error, or use **Open Log** for the full history. While a request keeps failing its refresh interval doubles (up to 10 minutes) so a broken or rate-limited endpoint isn't hammered.

Losing the network is treated separately from an endpoint being broken: the menu says _No network connection_, nothing is logged or backed off, and the request picks up again within a few seconds of the connection returning. The app also refreshes everything shortly after the Mac wakes from sleep, so what you see is never left over from before the lid closed.

A single very long response can't take over the whole menu bar — each value is capped at 40 characters on screen (the full value is still in the tooltip and in **Copy Value**).

## Troubleshooting

What is there to go wrong?

If something does... contact me: help@cnnct.uk

## Building

If you wanna build it yourself, you can clone the repo: <br>
`git clone https://github.com/Hybes/http-mac-menu`
Fetch the node packages with <br>`npm i`
Build the installers with <br>`npm run dist`
Or test in dev with <br>`npm run start` (`npm run dev` skips error reporting)

### Releases

Pushing to `main` runs [`.github/workflows/release.yml`](.github/workflows/release.yml): it bumps the patch version, builds both Mac architectures and publishes them to GitHub Releases. Changes to `.md` files alone don't trigger it, and the version-bump commit is marked `[skip ci]` so it doesn't trigger itself.

For a minor or major bump, run the workflow by hand from the Actions tab and pick the bump type.

Builds from CI are **unsigned** (there's no Developer ID certificate on the runner), so the `xattr -cr` step above applies to them.

To build and install it straight into `/Applications` on this Mac (and relaunch it): <br>`npm run install:local`

This also unregisters the Electron helper bundles from LaunchServices, otherwise Spotlight on recent macOS lists "HTTP Mac Menu Helper (GPU)" and friends as if they were apps.
