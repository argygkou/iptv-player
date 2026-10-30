# Infinite IPTV

A desktop IPTV player for providers that use **Xtream Codes** logins (server URL, username, password).
Live TV with now/next, a TV guide grid, movies and series, built with **Tauri 2** (Rust) and **Angular 22**.

Windows is the first target; Linux and iOS are planned (see [Roadmap](#roadmap)).

## Features

- Sign in with Xtream Codes credentials. "Keep me signed in" saves the account as a profile, so the next launch
  opens straight on Live TV. Several accounts can be saved and picked on the sign-in screen.
- **Native playback** through libmpv: MKV, HEVC, AC3/DTS, subtitles and audio tracks all play. mpv's on-screen
  controller ([ModernZ](https://github.com/Samillion/ModernZ)) handles seeking, volume and track selection; double-click or press `F` for fullscreen, `Esc` to leave it.
  On Live TV, the controller's title names the programme, and a now/next banner appears on entering fullscreen and on `I`.
- **Live TV**: categories, channel search, the channel's programmes with progress. In a window wider than 2:1, the
  programmes sit beside the player, in fullscreen too.
- **TV Guide**: the provider's full XMLTV guide as a timeline grid per category, six hours at a time, with
  Earlier/Later to move up to a week either way. Click a channel or what is on now to watch it.
- **Catch-up**: on channels the provider records (`tv_archive`), past programmes are marked ⟲ in the guide and
  have a Watch button on Live TV; the programme on now can start over.
- **Movies**: category browser, poster grid with search and incremental rendering, details and playback.
- **Series**: category browser, seasons and episodes, playback.
- **My List**: favourite channels, movies and series (☆ on a channel, movie or series), recently watched
  channels, and "Continue watching" for movies and episodes. Movies and episodes resume where they were left;
  each saved profile has its own lists.

## Architecture

```
src/                         Angular app (standalone components, signals, resource())
  app/core/xtream/           Typed models, XtreamApi facade over Tauri commands, CatalogueStore, EPG helpers
  app/core/session/          SessionStore (signals) and the auth guard
  app/core/library/          LibraryStore: favourites, history and resume positions
  app/shared/player/         Video player: native (libmpv) with a webview fallback
  app/shared/                Category list, poster grid, utilities
  app/features/              login, shell, library, live, guide, movies, series (all lazy routes)
src-tauri/                   Rust backend
  src/xtream.rs              player_api.php client (allow-listed actions only)
  src/proxy.rs               Local stream relay on 127.0.0.1
  src/player/                libmpv binding and the native video window (Windows)
  src/library.rs             Per-profile favourites and watch history
  src/catalogue.rs           Per-account cache of the category and stream lists
  src/epg.rs                 XMLTV guide download, cache and parser
  src/commands.rs            login / logout / xtream / stream_url / catchup_url / epg_guide / library commands
```

**Why the provider is called from Rust.** Xtream panels are usually plain `http://` and send no CORS headers,
so the webview cannot call them directly. Every API call goes through a Tauri command instead, and the
password never reaches the webview.

**Saved profiles.** `profiles.json` in the app data directory lists saved accounts (no passwords) and which one
to restore on launch. Passwords go to Windows Credential Manager. Signing out keeps the profile for one-click
sign-in but stops auto sign-in; the ✕ on the sign-in screen deletes it and its password.

**Favourites and history.** Each saved profile's lists live in `library/<profile id>.json` in the app data
directory, opened on sign-in; a one-off sign-in keeps them in memory only. The player saves the position of a
movie or episode every 10 seconds and when it closes (mpv's `time-pos`, or the `<video>` element's
`currentTime`), and reopens it with mpv's per-file `start` option. Near the end counts as watched.

**Channel and catalogue cache.** The category and stream lists are kept byte for byte in
`catalogue/<account hash>/<list>.json` in the app data directory, so the app shows them at once on launch.
Xtream Codes has no way to ask what changed, so a list older than 6 hours (live) or 24 hours (movies and
series) is shown anyway and downloaded again in the background; the UI only updates if the download differs.
"Update list" on each page forces a download. Pages load each full list once and filter by category locally.

**TV guide.** The backend downloads `xmltv.php` once (streamed to `epg/<account hash>.xml` in the app data
directory, gzipped or not), parses it into memory, and answers the webview with just the programmes of the
channels and hours on screen. The file is used for 12 hours, then downloaded again; "Update guide" forces it,
and a failed download keeps using the older file. Channels are matched by `epg_channel_id`. Channels the
guide does not cover, and panels without `xmltv.php`, fall back to `get_short_epg` (now and next only).

**Catch-up.** Recordings play through the relay from the panel's
`timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.ts` URL. The start time is written in the panel's
own time zone (`server_info.timezone`), so the guide's absolute times are converted with `Intl` first.

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
npm run fetch-libmpv  # download libmpv-2.dll into src-tauri\lib (dev and bundle also do this when it's missing;
                      # plain cargo commands need it too, and fail to copy it while the app is running)
npm run dev        # the desktop window with hot reload (first run compiles Rust and takes a few minutes)
npm test           # Angular unit tests (Vitest)
npm run bundle     # release build: NSIS installer under src-tauri\target\release\bundle\nsis
cargo test --manifest-path src-tauri\Cargo.toml
```

`npm run dev` starts `ng serve` and opens the app window. Changes under `src/` reload instantly; changes under
`src-tauri/` rebuild and restart the app.

### UI preview without a provider

`npm run start:mock` serves the Angular app with a fake backend (made-up channels, guide, movies and series;
playback uses a public sample video). Open http://localhost:4200 and sign in with any values. The mock is never
included in production builds.

CI runs lint and tests on Ubuntu and Windows for every pull request. It does not build installers.

## Releases

Versions follow [semver](https://semver.org/). `package.json` is the single source of the version:
`tauri.conf.json` reads it from there, and release-please keeps `src-tauri/Cargo.toml` and `Cargo.lock` in step.
Never bump a version by hand.

1. Pull requests are squash-merged, and their titles must be [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat: …`, `fix: …`, `chore: …`); a check enforces this. `feat` bumps the minor version, `fix` the patch.
2. [release-please](https://github.com/googleapis/release-please-action) keeps a release PR open that bumps the
   version and updates `CHANGELOG.md`.
3. Merging the release PR tags `vX.Y.Z`, publishes a GitHub Release and builds the Windows NSIS installer into it.

Installed copies update themselves: the app checks
`https://github.com/argygkou/iptv-player/releases/latest/download/latest.json` shortly after startup and every
6 hours, and offers **Update and restart** in the sidebar. Updates are signed with the Tauri updater key; the
public key is in `tauri.conf.json`, the private key and its password are the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. Losing that key means installed copies can no longer
update.

To try an installer from a branch without releasing, run the **Release** workflow manually from the Actions tab;
the installer is attached to the run as an artifact.

## Microsoft Store

The Store accepts Win32 apps submitted as an `.msi` or `.exe` installer, which `npm run bundle` already
produces. Before submitting: reserve the app name in Partner Center, set `identifier` and `publisher` in
`src-tauri/tauri.conf.json`, replace the placeholder icons (`npx tauri icon path/to/icon.png`), and sign the
installer with a code-signing certificate. See the
[Tauri guide](https://v2.tauri.app/distribute/microsoft-store/).

## Known limitations

- The player controls are [ModernZ](https://github.com/Samillion/ModernZ) (LGPL-2.1), bundled in `mpv/` next to the
  executable; without it, mpv's built-in controller is used.
- `libmpv-2.dll` comes from the [mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases)
  builds (pinned to release `20261021` and checked by SHA-256 in `scripts/fetch-libmpv.mjs`). Those builds are GPL-licensed, which matters if the
  app is ever distributed.
- Native playback is Windows-only for now; elsewhere the webview player is used, with its codec limits.
- If a panel expects catch-up start times in UTC rather than its own time zone, recordings start at the wrong
  hour; none seen so far.

## Roadmap

1. Microsoft Store submission.
2. Linux packages (`.deb`, AppImage) with native playback, then iOS through Tauri's mobile target.
