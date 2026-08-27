# HTTP Widgets

Little live values from any API, pinned to your surfaces — the macOS menu bar,
the iPhone lock screen, Android and Windows/Linux desktops. One Rust engine
(Tauri 2), no servers: fetching, formatting, alert rules and notifications all
run on your device.

<img width="100%" alt="menu bar" src="https://github.com/Hybes/http-mac-menu/assets/53020786/acb1e550-6970-4bbf-a882-de02333168a7">

## Using the app

- Pick a **Quick start** preset or add a custom request. Presets still open the
  editor before anything is saved, so you can check the source and wording.
- Open any live-value card for its larger graph, minimum/maximum/change and
  last-updated details. Copy, refresh, duplicate and edit are available there.
- The editor keeps the common choices clickable: currencies, refresh intervals,
  crypto template values and alert cooldowns. Headers, cURL import and detailed
  HTTP formatting stay under **Advanced HTTP** until they are needed.
- Notification controls appear beside alert rules and on the home screen only
  when they need attention. Use **Send test** to verify the installed app.

On desktop, closing the settings window, pressing Escape or using Command-W
hides the window and leaves HTTP Widgets running in the tray/menu bar. Quit from
the tray menu when you want to stop the engine.

## Requests

Each widget is a small request whose result is shown as text:

- **HTTP request** — any URL, optional headers (`Name: value` per line), a JSON
  path like `data.price`, a multiplier, decimals/max-length, prefix/suffix.
  **Paste a cURL command** to fill URL + headers for you.
- **Crypto** — automatic, Jupiter, DEX Screener or CoinGecko pricing; tickers,
  CoinGecko ids or Solana mints; optional holdings and a template with
  `{symbol} {price} {balance} {change1m…30d} {gain24h} {source}` etc.
- **Presets** — one-click starting points (London weather, Tauri GitHub stars,
  Hacker News points, live SOL, Bitcoin price and the GBP value of 1 ETH).

Up to 10 requests sit side by side in the menu bar, refreshed on their own
schedule (minimum 5 seconds for HTTP/Jupiter, 30 seconds for pool/CoinGecko
sources) with automatic backoff when an endpoint fails, short first-run retries
for local addresses, and a refresh shortly after your Mac wakes.

## SOL and price sources

**Automatic** is the useful default. It sends SOL and recognised Solana mints
to [Jupiter Price v3](https://developers.jup.ag/docs/api-reference/price) in
GBP, EUR, JPY and other supported three-letter currency codes. Jupiter's USD
price is converted locally through one
shared [Coinbase exchange-rate](https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates)
table, refreshed at most once a minute; a cached
[Frankfurter](https://frankfurter.dev/) daily reference rate is the no-key
fallback. Every due Solana widget is coalesced into one request, so GBP, EUR and
other fiat widgets can still use the five-second **Live** schedule without
duplicating provider calls. No account, API key or app server is required.

- **Jupiter** — the freshest built-in SOL/SPL source. The displayed price and
  locally sampled graph use the selected currency. Jupiter's reported 24-hour
  percentage remains the token's USD move, so it deliberately excludes changes
  in the exchange rate. If Jupiter omits an unreliable token, Automatic shows
  that honestly instead of substituting a questionable quote.
- **DEX Screener** — an explicit, no-key Solana fallback. The engine selects
  the USD-priced base-token pool with the greatest reported liquidity. Pair
  data is slower and a pool price can be easier to manipulate, so it is not the
  primary source.
- **CoinGecko** — broad ticker, coin-id and currency coverage. It remains the
  automatic source for non-Solana assets such as BTC and ETH, at a gentler
  interval.

Birdeye is not built in because even its free plan needs each user to bring and
secure an API key, and its realtime WebSocket plans are paid. Pyth/Hermes is an
oracle rather than arbitrary-mint market coverage and requires authenticated,
licensed access from 26 August 2026. Phantom is a wallet/signing SDK, not a
general price API; Solana RPC exposes chain state, not a canonical fiat price.
Advanced users can still model any authorised service as a normal HTTP request
without changing this local-only architecture.

## Graphs

Every successful numeric response is sampled locally into a bounded seven-day
history. Fast endpoints keep one point every 15 seconds for the latest six
hours; older samples are compacted into five-minute buckets. Widget snapshots
contain at most 256 points from the latest 24 hours. The mobile request list
draws a sparkline, as do the iOS and Android widgets. Text responses keep
working exactly as before and simply omit the graph.

History lives in the app data directory and survives restarts. It is cleared
when the URL, JSON path, multiplier, provider, coin, holdings or currency
changes, so a new data source is never joined onto an old graph.

## Alerts

Add rules to any request — _value above/below_, _gained/dropped ≥ N%_, _text
contains_, _matches regex_ — each with its own cooldown. When a condition
becomes true you get a native notification. Everything is evaluated locally.
Crypto value alerts always compare the coin's unit price, even when holdings or
`{balance}` are shown; their notification also reports that price.
Crypto percentage rules use the selected provider's 24-hour change; HTTP rules
compare the current number with the oldest locally stored sample from the past
24 hours.
Notification permission is requested only when you press **Enable**, next to
the alert controls. **Send test** confirms the complete installed-app path;
desktop APIs cannot reliably tell whether the operating system has muted an
otherwise valid notification.

Desktop is instant: the engine ticks once a second for as long as the app is
running. **iOS suspends the app the moment it leaves the screen**, so there it
registers a `BGAppRefreshTask` (`com.hybes.http-widget.refresh`) and iOS wakes
it periodically to fetch, evaluate the rules and rewrite the widget snapshot.
iOS decides when — never sooner than 15 minutes, often longer, and it gives the
app a bigger budget the more it is opened. Background App Refresh has to be on
for the app in Settings. Alerts are prompt while the app is open and delayed
when it is not.

No server also means no push service. Desktop alerts are immediate while this
resident app is running. iOS background refresh is discretionary, and Android
does not yet run the Rust fetch engine after the process has been killed, so a
server-free mobile build cannot promise real-time closed-app alerts. Guaranteed
timing would require an optional APNs/FCM service outside this repository.

## Platforms

| Surface                               | Values                  | Alerts             |
| ------------------------------------- | ----------------------- | ------------------ |
| macOS menu bar                        | live                    | instant            |
| Windows / Linux tray                  | icon + tooltip          | instant            |
| iOS lock screen & home screen widgets | last snapshot (~15 min) | background refresh |
| Android home-screen widget            | last app snapshot       | while app is alive |

## Downloads

Grab desktop builds from [Releases](../../releases/latest): universal macOS,
Windows and Linux bundles are built in CI. iOS and Android are built manually
from the same repository for now; the release workflow does not claim to
publish mobile artifacts it has not compiled.

Builds are unsigned/ad-hoc — after moving to /Applications you may need:
`xattr -cr "/Applications/HTTP Widgets.app"`

## On macOS

It is a menu bar extra (`LSUIElement`), so it has no Dock icon and no menu bar
of its own while it is just showing values. Open the settings window and it
becomes a regular app for as long as that window is up — so it appears in the
app switcher and can be brought back to the front — then drops out again when
the window closes.

- **⌘W** and **⌘Q** both put the settings away and leave the app running in the
  menu bar, which is what a menu bar app is for. **⌘⇧Q** quits it outright, as
  does Quit in the menu bar menu.
- **Show in Dock** in the menu bar menu keeps it a regular app all the time.
- **Launch at Login** is there too, alongside **Notifications ▸ Send a Test
  Notification** and **Open Notification Settings…** — macOS only lists an app
  under Notifications once it has posted one.

## Settings import

First launch of 2.x imports everything from HTTP Mac Menu 1.x automatically
(requests, indicator preference, legacy numbered-slot schemas too). The
indicator preference is carried across and selects the menu bar's Unicode
rise/fall marks. The Tauri build renders those marks as text rather than the
template-image glyphs used by 1.x.

## Building

```
npm install
npm run dev                     # desktop, from source
npm run build                   # desktop bundle for this OS
npm run build:css               # ui/output.css alone, after a styles.css edit
npx tauri ios build             # Xcode required
npx tauri android build         # Android SDK + NDK required
cargo test --manifest-path src-tauri/Cargo.toml
npm test                        # frontend syntax + Rust unit tests
npm run check                   # formatting plus all tests
```

The shared product is a Rust engine plus a static HTML/JavaScript UI.
`src-tauri/src/engine/` fetches, formats, evaluates rules and maintains numeric
history; `src-tauri/src/` owns persistence, notifications, the tray, windows
and scheduler. `ui/` is deliberately framework-free and is styled by Tailwind
from `styles.css` into the committed `ui/output.css`. Thin SwiftUI and Kotlin
adapters render OS-native widgets because WidgetKit and Android `RemoteViews`
cannot be implemented by a Tauri webview. They consume the same versioned
`widget-snapshot.json`; no business logic or external application server is
duplicated there.

The UI contract is documented in `design.md`; its shared colour, type, spacing,
control and motion values live in `tokens.css`. Both pages consume the same
compiled stylesheet and adapt through platform classes rather than separate
desktop and phone interfaces.

There is no bundler and no frontend framework — `tauri.conf.json` points
`frontendDist` straight at `ui/`.

### iOS

```
npx tauri ios build --debug --target aarch64-sim
xcrun simctl install booted "src-tauri/gen/apple/build/arm64-sim/HTTP Widgets.app"
xcrun simctl launch booted com.hybes.http-widget
```

Two things bite:

- **Use the rustup toolchain.** A Homebrew `rust` earlier on `PATH` has no iOS
  targets, and the build fails with _can't find crate for `core`_. Put
  `~/.cargo/bin` first.
- **Clear the old bundle first.** `tauri ios build` renames its archive into
  `gen/apple/build/<target>/` and stops with _Directory not empty_ if the last
  build is still there: `rm -rf src-tauri/gen/apple/build/arm64-sim`.
- **A cold target links on the second pass.** `build.rs` patches the Swift
  archives the plugins build (see the comment there), and on a target triple
  that has never been built the first pass can finish before the last archive
  is written — the link then fails with _Undefined symbols: `_retain_object`_.
  Run the same command again; it succeeds and stays working.

### Working in Xcode

**Do not open the `.xcodeproj` on its own.** The "Build Rust Code" phase runs
`tauri ios xcode-script`, which is not a standalone command — it calls back to a
running Tauri CLI over local RPC to fetch its options. With no CLI running it
panics with `failed to read CLI options: ... ConnectionRefused` and Xcode
reports only `Command PhaseScriptExecution failed with a nonzero exit code`.

Start the CLI and let it open Xcode for you:

```
npx tauri ios dev --open              # simulator
npx tauri ios dev --open --host       # physical device: it needs to reach the
                                      # dev server on your Mac, so bind the LAN
                                      # address rather than localhost
```

Leave that running, then in Xcode pick scheme `http-widgets_iOS`, choose the
simulator or device, and Run. The scheme sets `RUST_BACKTRACE=full`, so a panic
in the Rust engine arrives in the Xcode console with a backtrace — which is the
only practical way to see why the app is misbehaving on a physical device.

The LAN server exists only for physical-device hot reload. Installed builds use
the files bundled under `ui/` and need no development server. The first local
network request can be rejected while Apple's permission prompt is still open;
the debug shell now retries Tauri's failed development page when the app becomes
active again, and configured LAN widgets get two short retries. If access was
denied, re-enable **HTTP Widgets** under **Settings → Privacy & Security → Local
Network**.

The project is generated from `project.yml`, so edit that rather than the
`.xcodeproj` and re-run `xcodegen generate` in `src-tauri/gen/apple/`. That is
also required after **adding or renaming a native source file** — `tauri ios
build` never regenerates the project, so a new `.swift` file links as an
undefined symbol until it does.

Xcode.app is launched by LaunchServices and so runs that phase with a bare
`PATH` — no rustup, no node, no Tauri CLI. The phase puts `~/.cargo/bin`, the
repo's `node_modules/.bin` and nvm's newest node back on it, and fails with a
readable message rather than a confusing compiler error if any are still
missing. `~/.cargo/bin` has to lead: a Homebrew `rustc` earlier on the path has
no iOS targets. (nvm's default alias is often `lts/*` rather than a version
number, so the phase takes the newest install instead of trusting the alias.)

Background refresh lives in `Sources/http-widgets/BackgroundRefresh.swift` and
`src/ios_background.rs`. It cannot be exercised in the Simulator, which answers
_BGTaskScheduler is not available on this platform_ to every `submit()`; test it
on a device, or call the Rust entry point directly under lldb.

The app adopts the UIScene life cycle, which iOS 26 made mandatory —
`UIApplicationSupportsMultipleScenes` in `gen/apple/project.yml` is what turns
tao's scene support on, and `src-tauri/src/ios_scene.rs` corrects the one bug
in it. Both go away once tauri-runtime-wry moves to tao 0.37.

CI (`.github/workflows/release-tauri.yml`) builds Windows/Linux/macOS bundles
on tags.

## Troubleshooting

Contact me: help@cnnct.uk
