<#
.SYNOPSIS
    Sets up the environment and runs the Tauri Android dev server inside Docker.
.DESCRIPTION
    1. Builds the Docker image (tauri-android-builder).
    2. Restarts ADB on the host in TCP mode (port 5555).
    3. Runs the Docker container with necessary port mappings and volume mounts.
#>

$ImageName = "tauri-android-builder"
$ContainerWorkDir = "/app"

Write-Host "----------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "Step 1: Restarting Host ADB in TCP mode" -ForegroundColor Cyan
Write-Host "----------------------------------------------------------------"

# Check for connected devices first
$devices = adb devices | Select-String -Pattern "\tdevice"
if (-not $devices) {
    Write-Error "No Android devices or emulators found!`n"
    Write-Host "Please:" -ForegroundColor Yellow
    Write-Host "  1. Start an Android Emulator (via Android Studio)" -ForegroundColor Yellow
    Write-Host "  2. OR Connect a physical device via USB (with USB Debugging enabled)" -ForegroundColor Yellow
    Write-Host "  3. Run this script again." -ForegroundColor Yellow
    exit 1
}

# Restart ADB in TCP mode so the container can connect to it
Write-Host "Stopping existing ADB server..."
adb kill-server

Write-Host "Starting ADB Server on all interfaces (for Docker access)..."
# Start adb with -a (listen on all interfaces) in the background
$adbProcess = Start-Process -FilePath "adb" -ArgumentList "-a", "-P", "5037", "nodaemon", "server" -PassThru -WindowStyle Hidden

# Wait and verify that ADB is actually listening on port 5037
Write-Host "Verifying ADB is listening on port 5037..."
$maxRetries = 10
$retryCount = 0
$adbListening = $false

while (-not $adbListening -and $retryCount -lt $maxRetries) {
    Start-Sleep -Seconds 1
    $netstat = netstat -an | Select-String "5037"
    if ($netstat) {
        $adbListening = $true
    } else {
        $retryCount++
        Write-Host "Waiting for ADB socket... ($retryCount/$maxRetries)"
    }
}

if (-not $adbListening) {
    Write-Error "ADB failed to start on port 5037."
    Write-Warning "Please check if another process is blocking port 5037 or if Windows Firewall is blocking adb.exe."
    exit 1
}

Write-Host "ADB Server is running and shared." -ForegroundColor Green




# ----------------------------------------------------------------
# Step 1.5: Host IP Configuration
# ----------------------------------------------------------------

Write-Host "Configuring Host IP..."

# Hardcoded IP as requested by user
$HostIP = "192.168.15.53"

Write-Host "Using Hardcoded Host IP: $HostIP" -ForegroundColor Green



Write-Host "`n----------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "Step 2: Building Docker Image ($ImageName)" -ForegroundColor Cyan
Write-Host "----------------------------------------------------------------"

# Build the image corresponding to Dockerfile.android
docker build -f Dockerfile.android -t $ImageName .
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed."
    exit $LASTEXITCODE
}
Write-Host "Docker image built successfully." -ForegroundColor Green

Write-Host "`n----------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "Step 3: Running Container" -ForegroundColor Cyan
Write-Host "----------------------------------------------------------------"

# Run the container
# -e ADB_SERVER_SOCKET: Tell container to use the host's ADB server
docker run -it --rm `
    -v "${PWD}:${ContainerWorkDir}" `
    -v "tauri_android_node_modules:${ContainerWorkDir}/node_modules" `
    -p 1420:1420 `
    -e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037 `
    -e TAURI_DEV_HOST=$HostIP `
    $ImageName `
    bash "${ContainerWorkDir}/scripts/entrypoint-android-dev.sh"
