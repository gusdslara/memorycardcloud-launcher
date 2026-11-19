# MemoryCard.cloud Launcher

[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-Svelte%205-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Go](https://img.shields.io/badge/Go-Fiber-00ADD8?logo=go&logoColor=white)](https://gofiber.io/)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Android-informational)](#platforms)
[![Website](https://img.shields.io/badge/site-memorycard.cloud-6b7280)](https://memorycard.cloud)

**MemoryCard.cloud** is a cross-platform game launcher for **PC ports, recompilations and decompilations** of classic console games, plus the **emulators** to run everything else, with **automatic save backups and cloud sync** across your devices.

One app on Windows, Linux, macOS and Android: browse a de-duplicated catalog of community ports, install the right build for your device with one click (including Android APK ports), keep your saves backed up, and pick up on another device where you left off.

- Website and downloads: <https://memorycard.cloud>
- Landing page and backend repository: <https://github.com/gusdslara/memorycardcloud-fe-be>

> The app UI ships in Brazilian Portuguese and English (`src/lib/i18n/locales`). Code comments are mostly in Portuguese.

---

## Features

### Ports, recomps and decomps hub
- **One entry per game, best port per platform.** `npm run catalog:build` merges the curated catalog (`src/lib/data/curatedPorts.ts`) with RecompLauncher, Ports Launcher (PC and Android forks), Quiver, Recompendium, awesome-unofficial-pc-ports and GitHub search, then writes `src/lib/data/ports.generated.ts` and the report [`docs/CATALOGO_PORTS.md`](docs/CATALOGO_PORTS.md). The current report lists **1,764 games** (about 1,680 with a Windows build, 949 Linux, 632 macOS, **368 Android** and 54 iOS).
- **Duplicate resolution:** for each platform the port with the most GitHub stars wins, with small bonuses for curated picks, launcher quality flags and player reports. Old ids keep working through `PORT_ID_ALIASES` (deep links, mods, scanner).
- **Always the latest release:** catalog items store a filename pattern per platform instead of fixed URLs; the app resolves the newest GitHub release at install time. `npm run verify:catalog` checks the patterns against live releases and `npm test` checks them offline against a snapshot (`tests/fixtures`).
- **Each device only sees what runs on it:** Windows shows Windows builds, Android shows Android builds, and so on.
- **Custom ports:** add your own port through a form, or import/export catalogs as JSON (Quiver-compatible).
- **Reviews:** per-port ratings and "runs well" reports, aggregated from MemoryCard users and RecompLauncher, with the reviewer's hardware (CPU, GPU, RAM, OS) attached.

### One-click installs on every platform
| Platform | How it installs |
|---|---|
| Windows / Linux / macOS | Downloads, extracts (zip, tar.gz, tar.xz, 7z, dmg, AppImage), flattens folders, marks executables and sets up portable mode. Projects that only ship `.msi`/`.exe` use their official installer. |
| Android | Play Store when available; otherwise the **official APK is downloaded inside the app** and handed to the system installer (`tauri-plugin-apk-installer`), then registered so the card shows "Play". |
| iOS | App Store when available; otherwise IPA via AltStore/SideStore. |

- Real download progress (size, speed, ETA, cancel) and SHA-256 verification before installing; falls back to the server mirror when the official source fails.
- Updates merge into the install folder, so saves and ROMs are preserved.
- **Existing installs:** a scan of the usual folders (Downloads, Desktop, Program Files, `/Applications`, `/opt`...) finds ports and emulators installed before MemoryCard and links them after you confirm. Nothing is moved.
- **Deep links:** `memorycard://install/<port|emulator|native>/<id>` lets the website start an install in the app.

### Emulators
- Recommended emulator per console and platform (`src/lib/data/emulatorPicks.ts`), with alternatives listed next to it: PCSX2, DuckStation, RPCS3, shadPS4, xemu, PPSSPP, Vita3K, Dolphin, Cemu, Azahar, Eden, melonDS, mGBA, Flycast and more, including Android builds (ARMSX2, NetherSX2, Lemuroid).
- Emulator save folders are detected and added to the backup list automatically.

### Saves, backups and cloud sync
- **Automatic backups** on desktop and Android: every save folder is watched; on change it becomes a local zip (only when the content changed). With a cloud plan, the same zip is uploaded.
- **Newest save wins:** on launch, when returning to the app, every 3 minutes and before starting a game, the local save is compared with the latest cloud backup; if the cloud is ahead, the local copy is kept aside and the cloud one is restored.
- Portable zips with the same content hash on every OS; restore is protected against `..` path traversal.
- Save history with per-version restore, game scanner to find save folders, and plan-based storage quotas.
- Server side, backups can be stored on Google Drive with resumable uploads, deduplication and per-plan quotas (see [`docs/BACKUPS_GOOGLE_DRIVE.md`](docs/BACKUPS_GOOGLE_DRIVE.md)).

### More
- **Organize games:** finds game files in Downloads, Desktop, removable drives and Android shared storage, identifies platform, region and serial from file headers (`src-tauri/src/rom_identify.rs`), and moves them into a tidy library with an undo log. Includes format conversion tools.
- **Web ports:** WebAssembly/WebGL ports playable in the browser or in an app window; on Android they open in a Custom Tab (`tauri-plugin-web-tab`) for cross-origin isolation.
- **VR ports:** VR rebuilds of classic games for Meta Quest and Steam Frame, installed on the headset directly or over ADB from a desktop.
- **Mods** catalog for supported games, native (abandonware) game packages served by the backend, and a ROM vault backed by the server.
- **Auto-update:** desktop uses the Tauri updater with minisign signatures; Android checks `/api/app/releases` and installs the new APK.
- **Ads:** AdMob banner on Android only (`tauri-plugin-admob`), a dismissible house banner on desktop, and none at all for supporters and cloud subscribers.

---

## Tech stack

| Layer | Technology |
|---|---|
| App shell | [Tauri 2](https://v2.tauri.app/) (Rust): installers, archive extraction, file watching, save sync, ROM identification, ADB |
| UI | Svelte 5, SvelteKit (static adapter), Tailwind CSS, Lucide icons, `svelte-i18n` |
| Android plugins | Local Tauri plugins in `src-tauri/plugins/`: APK installer, AdMob, browser Custom Tab |
| Backend | Go + Fiber, GORM (SQLite/PostgreSQL), JWT auth, Asaas payments, Google Drive storage, catalog scraper and release mirror |
| Website | Separate SvelteKit static site in `landing/`, sharing the same catalog data |
| Deploy | Docker Compose on a VPS behind Caddy; a builder container produces Windows, Linux and Android releases |

---

## Repository layout

```
memorycardcloud-launcher/
├── src/                     # Tauri app frontend (SvelteKit + Svelte 5)
│   ├── lib/components/      # Views: ports, emulators, games, saves, organizer, VR, web ports, mods...
│   ├── lib/data/            # Catalog sources (curated + generated ports, emulators, VR, web ports)
│   ├── lib/services/        # Install planner, save sync, Android APK, reviews, ads, API clients
│   └── lib/i18n/            # pt-BR and en-US strings
├── src-tauri/               # Rust side of the app
│   ├── src/                 # ports/emulators/mods managers, save_sync, rom_identify, vr_devices...
│   ├── plugins/             # tauri-plugin-apk-installer, tauri-plugin-admob, tauri-plugin-web-tab
│   └── tauri.conf*.json     # App config (default, en, pt bundles)
├── landing/                 # Public website (SvelteKit, static)
├── go-backend/              # REST API, catalog service, backups, payments, app releases
├── scripts/                 # Catalog generators, art/metadata fetchers, release scripts
├── tests/                   # Node test runner suites for catalog, installs, deep links, sync...
├── deploy/                  # Dockerfiles and scripts for the VPS deploy and app builder
└── docs/                    # Build, signing, catalog, public API and backup docs
```

---

## Getting started

### Prerequisites
- Node.js 22+ (the test and catalog scripts use `--experimental-strip-types`)
- Rust stable and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
- Go 1.24+ for the backend
- Android SDK/NDK for Android builds (or Docker, see `build-android.bat`)

### App
```bash
npm install
npm run tauri dev          # desktop app with hot reload
npm run dev                # frontend only, in the browser (http://localhost:1420)
npm run check              # svelte-check
npm test                   # Node test suites
npm run build              # static frontend build
npm run tauri build        # desktop installers (NSIS/MSI on Windows)
npm run tauri android build
```

### Website
```bash
npm run landing:dev        # landing/ dev server on :5174
npm run landing:build      # exports the catalog and builds landing/
```

### Backend
```bash
cd go-backend
cp .env.example .env       # fill in JWT_SECRET and the optional integrations
go run .
```
The API listens on port 8000 by default. Point the app or the site at it with `VITE_API_URL`, for example `VITE_API_URL=http://127.0.0.1:8000/api npm run dev`.

### Catalog and media
| Command | What it does |
|---|---|
| `npm run catalog:build` | Rebuilds `ports.generated.ts` and `docs/CATALOGO_PORTS.md` from all sources (`catalog:build:offline` uses the cache) |
| `npm run verify:catalog` | Checks every download pattern against the real GitHub releases |
| `npm run export:catalog` | Writes `go-backend/internal/catalog/catalog.json`, embedded in the API binary |
| `npm run media:build` | Rebuilds cover art and game metadata |

### Releases
```bash
npm run release:app -- --bump patch --publish --notes "..."
npm run publish:app -- --platform android --file app.apk
```
Releases are signed with the updater key in `src-tauri/.updater/` (the private key is not in the repo). On the VPS, the deploy builds and publishes Windows, Linux and Android automatically. See [`docs/BUILD_GUIDE.md`](docs/BUILD_GUIDE.md) and [`docs/signing_guide.md`](docs/signing_guide.md).

---

## Platforms

| Platform | Status |
|---|---|
| Windows | Supported (NSIS and MSI installers) |
| Linux | Supported (AppImage) |
| Android | Supported (universal APK) |
| macOS | Builds on a Mac (`--platforms macos`) |
| iOS | Planned; the API already accepts iOS builds |

---

## Disclaimer

MemoryCard.cloud does not distribute games, ROMs or BIOS files. Ports and recompilations downloaded through the app come from their official project releases and most require game data you own.

## License

Declared as MIT in `package.json`.
