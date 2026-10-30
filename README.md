# Infinite IPTV

A desktop IPTV player for providers that use **Xtream Codes** logins (server URL, username, password).
Live TV with now/next, a TV guide grid, movies and series, built with **Tauri 2** (Rust) and **Angular 22**.

Windows is the first target; Linux and iOS are planned (see [Roadmap](#roadmap)).

## Features

- Sign in with Xtream Codes credentials. "Keep me signed in" saves the account as a profile, so the next launch
  opens straight on Live TV. Several accounts can be saved and picked on the sign-in screen.
- **Native playback** through libmpv: MKV, HEVC, AC3/DTS, subtitles and audio tracks all play. mpv's on-screen
  controller handles seeking and track selection; double-click or press `F` for fullscreen, `Esc` to leave it.
- **Live TV**: categories, channel search, now/next EPG with progress.
- **TV Guide**: a timeline grid per category (six hours around now); click a channel to watch it.
- **Movies**: category browser, poster grid with search and incremental rendering, details and playback.
- **Series**: category browser, seasons and episodes, playback.

## Architecture

```
src/                         Angular app (standalone components, signals, resource())
  app/core/xtream/           Typed models, XtreamApi facade over Tauri commands, EPG helpers
  app/core/session/          SessionStore (signals) and the auth guard
  app/shared/player/         Video player: native (libmpv) with a webview fallback
  app/shared/                Category list, poster grid, utilities
  app/features/              login, shell, live, guide, movies, series (all lazy routes)
src-tauri/                   Rust backend
  src/xtream.rs              player_api.php client (allow-listed actions only)
  src/proxy.rs               Local stream relay on 127.0.0.1
  src/player/                libmpv binding and the native video window (Windows)
  src/commands.rs            login / logout / xtream / stream_url commands
```

**Why the provider is called from Rust.** Xtream panels are usually plain `http://` and send no CORS headers,
so the webview cannot call them directly. Every API call goes through a Tauri command instead, and the
password never reaches the webview.

**Saved profiles.** `profiles.json` in the app data directory lists saved accounts (no passwords) and which one
to restore on launch. Passwords go to Windows Credential Manager. Signing out keeps the profile for one-click
sign-in but stops auto sign-in; the ✕ on the sign-in screen deletes it and its password.

**Why there is a local relay.** The same restrictions apply to media: mpegts.js needs to `fetch()` the
live stream, and an https app origin would block `http://` media entirely. The backend starts a small axum
server on a random `127.0.0.1` port that builds the upstream URL from the signed-in session, forwards `Range`
for seeking, and adds CORS headers. Each run gets a random token that every relay request must carry, so other
local processes or web pages cannot use it.

**How native playback works.** WebView2 cannot decode most movie files, so on Windows the app loads
`libmpv-2.dll` at runtime and lets mpv render into a native child window placed over the player's box in the
page. The Angular player measures that box every frame (clipped to its scroll container) and the backend moves
the window to match. mpv plays the same relay URLs, and its fullscreen toggle drives the app window. The DLL is
bundled next to the executable; without it (mock mode, other platforms) the app falls back to the webview player
(mpegts.js for live TV). One limitation of the native window: HTML cannot be drawn on top of the video.

## Development

Development happens on Windows, in PowerShell. No WSL is needed.

### One-time setup

Install the tools below, then open a new terminal so they are on `PATH`:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e        # Node.js 24 (Angular 22 needs >= 22.22.3)
winget install --id Rustlang.Rustup -e      # Rust stable, MSVC toolchain
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

The last line installs the Microsoft C++ Build Tools ("Desktop development with C++"), which Rust needs to link.
WebView2 already ships with Windows 10/11. See the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for details.

### Everyday commands

Run these from the repository root:

```powershell
npm ci             # install dependencies (first time, and after package-lock.json changes)
npm run fetch-libmpv  # download libmpv-2.dll into src-tauri\lib (dev and bundle also do this when it's missing)
npm run dev        # the desktop window with hot reload (first run compiles Rust and takes a few minutes)
npm test           # Angular unit tests (Vitest)
npm run bundle     # release build: NSIS .exe and .msi under src-tauri\target\release\bundle
cargo test --manifest-path src-tauri\Cargo.toml
```

`npm run dev` starts `ng serve` and opens the app window. Changes under `src/` reload instantly; changes under
`src-tauri/` rebuild and restart the app.

### UI preview without a provider

`npm run start:mock` serves the Angular app with a fake backend (made-up channels, guide, movies and series;
playback uses a public sample video). Open http://localhost:4200 and sign in with any values. The mock is never
included in production builds.

CI runs lint and tests on Ubuntu and builds the Windows installers on every pull request; the installers are
attached to the workflow run as an artifact.

## Microsoft Store

The Store accepts Win32 apps submitted as an `.msi` or `.exe` installer, which `npm run bundle` already
produces. Before submitting: reserve the app name in Partner Center, set `identifier` and `publisher` in
`src-tauri/tauri.conf.json`, replace the placeholder icons (`npx tauri icon path/to/icon.png`), and sign the
installer with a code-signing certificate. See the
[Tauri guide](https://v2.tauri.app/distribute/microsoft-store/).

## Known limitations

- `libmpv-2.dll` comes from the [mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases)
  builds (latest release unless `MPV_RELEASE` names a tag). Those builds are GPL-licensed, which matters if the
  app is ever distributed.
- Native playback is Windows-only for now; elsewhere the webview player is used, with its codec limits.
- The guide loads short EPG for the first 60 channels of a category.

## Roadmap

1. Per-profile settings (favourites, history).
2. Favourites, recently watched, resume position for movies and episodes.
3. Full XMLTV EPG (`xmltv.php`) with a local cache, and catch-up for channels with `tv_archive`.
4. Microsoft Store submission and auto-updates for the direct download.
5. Linux packages (`.deb`, AppImage) with native playback, then iOS through Tauri's mobile target.
