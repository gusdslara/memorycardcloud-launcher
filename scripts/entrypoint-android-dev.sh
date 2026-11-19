#!/bin/bash
set -e

echo "----------------------------------------------------------------"
echo "Initializing Android Dev Environment inside Docker"
echo "----------------------------------------------------------------"

# 1. Check ADB Connection
# We are using the host's ADB server via ADB_SERVER_SOCKET, so no need to 'connect'.
echo "Checking for connected Android devices..."

# List devices (this queries the Windows ADB server)
adb devices

# Simple check if any device is found (excluding the header line)
if [ $(adb devices | wc -l) -le 2 ]; then
    echo "WARNING: No devices detected!"
    echo "Ensure your phone is connected via USB to Windows and USB Debugging is ON."
    # We don't exit here because sometimes it takes a second, or user might plug it in now.
else
    echo "Device detected successfully."
fi

echo "----------------------------------------------------------------"
echo "Installing/Updating Dependencies (Linux)"
echo "----------------------------------------------------------------"

# 2. Install Dependencies (into the isolated volume)
# This ensures we have Linux-specific binaries for @tauri-apps/cli
npm install

echo "----------------------------------------------------------------"
echo "Starting Tauri Android Development Server"
echo "----------------------------------------------------------------"

# 2. Run Tauri Dev
# --host 0.0.0.0 is required to expose the dev server outside the container
npm run tauri android dev -- "$@"
