@echo off
set IMAGE_NAME=memorycard-android-builder

echo ==============================================
echo 1. Building Docker Image (This may take a while first time)...
echo ==============================================
docker build -t %IMAGE_NAME% -f Dockerfile.android .
if %ERRORLEVEL% NEQ 0 (
    echo Docker build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ==============================================
echo 2. Running Android Build in Container...
echo ==============================================
echo Note: We are using a separate node_modules volume to avoid Windows/Linux conflicts.
echo.

rem We map the current directory to /app
rem We use a volume for /app/node_modules to keep it Linux-native and separate from host
rem We run npm install (ci) then the tauri build
docker run --rm -it ^
    -v "%cd%":/app ^
    -v memorycard_node_modules:/app/node_modules ^
    -v memorycard_cargo_cache:/root/.cargo/registry ^
    -v memorycard_cargo_git:/root/.cargo/git ^
    -v memorycard_gradle_cache:/root/.gradle ^
    -v memorycard_target:/app/src-tauri/target ^
    -w /app ^
    %IMAGE_NAME% ^
    bash -c "echo 'Installing Dependencies...' && npm install --verbose && echo 'Building Debug APK...' && npx tauri android build --debug"

if %ERRORLEVEL% NEQ 0 (
    echo Build failed inside container!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ==============================================
echo Build Complete!
echo You can check src-tauri/gen/android/app/build/outputs/apk/universal/debug/
echo ==============================================

echo Verifying output...
if exist "src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk" (
    echo Found: src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
) else (
    echo Warning: APK not found in expected Windows path. Check inside the 'gen' folder.
)

pause
