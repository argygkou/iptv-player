# IPTV Player

A desktop IPTV player for providers that use **Xtream Codes** logins (server URL, username, password).
Live TV with now/next, a TV guide grid, movies and series, built with **Tauri 2** (Rust) and **Angular 22**.

Windows is the first target; Linux and iOS are planned (see [Roadmap](#roadmap)).

## Features

- Sign in with Xtream Codes credentials; server and username can be remembered.
- **Live TV**: categories, channel search, MPEG-TS playback through mpegts.js, now/next EPG with progress.
- **TV Guide**: a timeline grid per category (six hours around now); click a channel to watch it.
- **Movies**: category browser, poster grid with search and incremental rendering, details and playback.
- **Series**: category browser, seasons and episodes, playback.

## Architecture

```
src/                         Angular app (standalone components, signals, resource())
  app/core/xtream/           Typed models, XtreamApi facade over Tauri commands, EPG helpers
  app/core/session/          SessionStore (signals) and the auth guard
  app/shared/                Video player, category list, poster grid, utilities
  app/features/              login, shell, live, guide, movies, series (all lazy routes)
src-tauri/                   Rust backend
  src/xtream.rs              player_api.php client (allow-listed actions only)
  src/proxy.rs               Local stream relay on 127.0.0.1
  src/commands.rs            login / logout / xtream / stream_url commands
```

**Why the provider is called from Rust.** Xtream panels are usually plain `http://` and send no CORS headers,
so the webview cannot call them directly. Every API call goes through a Tauri command instead, and the
password never leaves the Rust process (it is kept in memory for the current run only).

**Why there is a local relay.** The same restrictions apply to media: mpegts.js needs to `fetch()` the
live stream, and an https app origin would block `http://` media entirely. The backend starts a small axum
server on a random `127.0.0.1` port that builds the upstream URL from the signed-in session, forwards `Range`
for seeking, and adds CORS headers. Each run gets a random token that every relay request must carry, so other
local processes or web pages cannot use it.

## Development

Prerequisites (Windows): [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Microsoft C++ Build
Tools and WebView2, which ships with Windows 10/11), Rust stable, and Node.js 24 (Angular 22 needs >= 22.22.3).

```bash
npm ci
npm run dev        # tauri dev: ng serve + the desktop window with hot reload
npm test           # Angular unit tests (Vitest)
npm run bundle     # release build: NSIS .exe and .msi under src-tauri/target/release/bundle
cd src-tauri && cargo test
```

### UI preview without a provider

`npm run start:mock` serves the Angular app with a fake backend (made-up channels, guide, movies and series;
playback uses a public sample video). Open http://localhost:4200 and sign in with any values. This works from
WSL too: run it there and open the URL in your Windows browser. The mock is never included in production builds.

### Running the desktop app on WSL

On Windows 11 (WSLg), the real Tauri window runs from WSL with the Linux webview:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sudo apt install build-essential libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
npm ci && npm run dev
```

WebKitGTK decodes video through GStreamer, so live and movie playback in WSL also need
`gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav`. Windows builds use WebView2 instead.

CI runs lint and tests on Ubuntu and builds the Windows installers on every pull request; the installers are
attached to the workflow run as an artifact.

## Microsoft Store

The Store accepts Win32 apps submitted as an `.msi` or `.exe` installer, which `npm run bundle` already
produces. Before submitting: reserve the app name in Partner Center, set `identifier` and `publisher` in
`src-tauri/tauri.conf.json`, replace the placeholder icons (`npx tauri icon path/to/icon.png`), and sign the
installer with a code-signing certificate. See the
[Tauri guide](https://v2.tauri.app/distribute/microsoft-store/).

## Known limitations

- Playback uses the webview's own decoders. MP4/H.264/AAC and live MPEG-TS work; many movie files are MKV with
  AC3/DTS audio or HEVC video, which WebView2 cannot decode. The player shows an error for those.
- The password is not persisted between runs.
- The guide loads short EPG for the first 60 channels of a category.

## Roadmap

1. Native playback through **libmpv** for full container and codec support (MKV, HEVC, AC3/DTS, subtitles).
2. Store credentials in the OS keychain (Windows Credential Manager) and support multiple profiles.
3. Favourites, recently watched, resume position for movies and episodes.
4. Full XMLTV EPG (`xmltv.php`) with a local cache, and catch-up for channels with `tv_archive`.
5. Microsoft Store submission and auto-updates for the direct download.
6. Linux packages (`.deb`, AppImage), then iOS through Tauri's mobile target.
