# Docker Android Development Guide

This guide explains how to develop the Android application using a Docker container, while connected to an emulator or physical device running on your Windows host.

## Prerequisites

1.  **Docker Desktop** installed and running.
2.  **Android Studio** installed.
3.  **ADB** (Android Debug Bridge) in your system PATH.
4.  **Emulator** running OR **Physical Device** connected via USB (with USB Debugging enabled).

## Usage

We have provided a PowerShell script to automate the setup process.

### 1. Run the Start Script

Open a PowerShell terminal in the project root and run:

```powershell
.\scripts\start-docker-android-dev.ps1
```

### What does this script do?

1.  **Restarts ADB in TCP Mode**: Runs `adb tcpip 5555` on your host machine. This allows the Docker container to connect to your emulator/device over the network.
2.  **Builds Docker Image**: Builds the `tauri-android-builder` image from `Dockerfile.android` (if needed).
3.  **Runs Container**: Starts the container with:
    -   Source code mounted to `/app`.
    -   Port `1420` forwarded (for the Tauri dev server).
    -   Connection to `host.docker.internal` configured.
4.  **Connects ADB**: Inside the container, it runs `adb connect host.docker.internal:5555`.
5.  **Starts Dev Server**: Runs `npm run tauri android dev -- --host 0.0.0.0`.

## Troubleshooting

### "Connection refused" to ADB
-   Ensure your firewall allows ADB connections.
-   Ensure the emulator/device is visible to the host (`adb devices`).
-   Try manually running `adb tcpip 5555` on the host before the script.

### Build Failures
-   If you see "TLS handshake" errors, ensure the project is using the downgraded Android Gradle Plugin (AGP) version 8.7.3 (already configured in `build.gradle.kts`).
