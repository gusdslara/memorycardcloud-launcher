# Build Guide for MemoryCard.cloud

This guide covers how to build the application for Windows, Linux, Android, macOS, and iOS.

## Prerequisites
- **Node.js** & **npm**
- **Rust** & **Cargo** (for Tauri)
- **Tauri CLI**: `npm install -g @tauri-apps/cli` (optional, or use `npx tauri`)

---

## 1. Windows Builds
Requires a Windows environment.

### Prerequisites (MSI Support)
To build `.msi` installers, you must install the [WiX Toolset v3](https://wixtoolset.org/releases/v3-11-2/stable).
1. Download and install WiX v3.11.
2. Add it to your PATH if not automatically added.

### Building
Run the following command to generate Windows artifacts:

```bash
npm run tauri build
```

By default, this will likely generate the `.exe` (NSIS Installer) and potentially the `.msi` if WiX is detected.
To explicitly target formats:

#### **Installable .exe (NSIS) & .msi**
```bash
# Builds specifically NSIS identifier and MSI
npm run tauri build -- --target nsis,msi
```
**Output Location:** `src-tauri/target/release/bundle/`
- **NSIS Installer**: `src-tauri/target/release/bundle/nsis/MemoryCard.cloud_0.1.0_x64-setup.exe`
- **MSI Installer**: `src-tauri/target/release/bundle/msi/MemoryCard.cloud_0.1.0_x64_en-US.msi`

**Installation Path**:
Both installers are configured to install to: `C:\Program Files\Unrender\MemoryCard.cloud` (Per-Machine).

#### **Portable .exe**
Tauri compiles a standalone executable by default.
1. Run `npm run tauri build`.
2. Locate the raw binary at: `src-tauri/target/release/memorycardcloud-launcher.exe` (name may vary based on `package.json` vs `tauri.conf.json` product name).
3. This single file can be distributed as a portable app.
   - *Note*: It depends on the 'WebView2 Runtime' being present on the user's machine (standard on Windows 10/11).

---

## 2. Linux Builds
Requires a Linux environment (or WSL2 with GUI support, though native is better).

### Prerequisites
Ensure build dependencies are installed (Ubuntu/Debian example):
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.0-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
```

### Building
```bash
npm run tauri build
```
This will typically generate `.deb` and `.AppImage` (if configured in `bundle` targets or default).

To be explicit:
```bash
npm run tauri build -- --target deb,appimage
```
**Output Location:** `src-tauri/target/release/bundle/deb/` and `.../appimage/`.

---

## 3. Android Builds
Requires the Android SDK and Java/Kotlin setup. Since you have the SDK and Android Studio/Emulator, you are ready.

### Initialization (First Time Only)
Initialize the Android project structure:
```bash
npx tauri android init
```
This creates the `src-tauri/gen/android` directory.

### Operations
- **Run on Emulator/Device**:
  ```bash
  npx tauri android dev
  ```
  This will build and deploy to a connected device or emulator.

- **Build APK (Debug)**:
  Useful for testing on a device without configuring signing keys.
  ```bash
  npx tauri android build --debug --apk
  ```
  **Output Location:** `src-tauri/gen/android/app/build/outputs/apk/universal/debug/`

- **Build APK/AAB (Release)**:
  1. Configure your keystore signing (see [Tauri Android Signing Docs](https://tauri.app/v1/guides/distribution/sign-android)).
  2. Run:
     ```bash
     npx tauri android build --apk
     ```
     (Use `--aab` for Play Store bundles).
  
  **Output Location:** `src-tauri/gen/android/app/build/outputs/apk/universal/release/` (path may vary).

---

## 4. macOS & iOS Builds
**CRITICAL:** These builds **MUST** be performed on a macOS machine with Xcode installed. You cannot build these on Windows or Linux.

### macOS (.dmg, .app)
```bash
npm run tauri build
```
**Output Location:** `src-tauri/target/release/bundle/dmg/` and `src-tauri/target/release/bundle/macos/`.

### iOS
1. Initialize iOS project:
   ```bash
   npx tauri ios init
   ```
2. Build/Run:
   ```bash
   npx tauri ios dev
   # or
   npx tauri ios build
   ```
   This effectively opens the project in Xcode, where you handle signing and distribution (TestFlight/App Store).

---

## Summary of Outputs
| Platform | Format | Method | Location Pattern |
|----------|--------|--------|------------------|
| **Windows** | `.exe` (Installer) | NSIS | `target/release/bundle/nsis/*.exe` |
| **Windows** | `.msi` (Installer) | WiX | `target/release/bundle/msi/*.msi` |
| **Windows** | `.exe` (Portable) | Raw | `target/release/*.exe` |
| **Linux** | `.deb`, `.AppImage` | Bundle | `target/release/bundle/deb/`, `.../appimage/` |
| **Android** | `.apk` | Gradle | `gen/android/app/build/outputs/apk/` |
| **macOS** | `.dmg` | Bundle | `target/release/bundle/dmg/` |
| **iOS** | `.ipa` | Xcode | Via Xcode Archive |
