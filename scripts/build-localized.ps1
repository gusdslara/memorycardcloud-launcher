$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$tauriDir = Join-Path $projectRoot "src-tauri"
$baseConfigPath = Join-Path $tauriDir "tauri.conf.json"

Function Merge-Json {
    param (
        [string]$BasePath,
        [string]$OverridePath,
        [string]$OutputPath
    )

    Write-Host "Merging $OverridePath into $BasePath..."
    
    $baseContent = Get-Content $BasePath -Raw | ConvertFrom-Json
    $overrideContent = Get-Content $OverridePath -Raw | ConvertFrom-Json

    # Deep merge bundle.licenseFile
    if ($overrideContent.bundle.licenseFile) {
        $baseContent.bundle.licenseFile = $overrideContent.bundle.licenseFile
    }

    # Deep merge bundle.windows.nsis.languages
    if ($overrideContent.bundle.windows.nsis.languages) {
        $baseContent.bundle.windows.nsis.languages = $overrideContent.bundle.windows.nsis.languages
    }

    # Deep merge bundle.windows.wix.language
    if ($overrideContent.bundle.windows.wix.language) {
        $baseContent.bundle.windows.wix.language = $overrideContent.bundle.windows.wix.language
    }

    $baseContent | ConvertTo-Json -Depth 10 | Set-Content $OutputPath
}

Function Build-Language {
    param (
        [string]$LangCode,
        [string]$ConfigName
    )

    $overridePath = Join-Path $tauriDir $ConfigName
    $tempConfigPath = Join-Path $tauriDir "tauri.conf.build.json"

    Merge-Json -BasePath $baseConfigPath -OverridePath $overridePath -OutputPath $tempConfigPath

    Write-Host "Building for language: $LangCode..."
    
    # Run the build command
    # We use --config to point to our generated temporary config
    Push-Location $projectRoot
    try {
        cmd /c "npm run tauri build -- --config src-tauri/tauri.conf.build.json"
    }
    catch {
        Write-Error "Build failed for $LangCode"
        exit 1
    }
    finally {
        Pop-Location
    }

    # Rename artifacts to include language code
    $targetDir = Join-Path $tauriDir "target/release/bundle"
    
    # Rename NSIS installer
    $nsisDir = Join-Path $targetDir "nsis"
    if (Test-Path $nsisDir) {
        Get-ChildItem $nsisDir -Filter "*.exe" | ForEach-Object {
            if ($_.Name -notmatch "_(en-US|pt-BR)\.exe$") {
                $newName = $_.Name.Replace(".exe", "_$LangCode.exe")
                Rename-Item $_.FullName -NewName $newName -Force
                Write-Host "Renamed NSIS installer to $newName"
            }
        }
    }

    # Rename MSI installer
    $msiDir = Join-Path $targetDir "msi"
    if (Test-Path $msiDir) {
        Get-ChildItem $msiDir -Filter "*.msi" | ForEach-Object {
             if ($_.Name -notmatch "_(en-US|pt-BR)\.msi$") {
                $newName = $_.Name.Replace(".msi", "_$LangCode.msi")
                Rename-Item $_.FullName -NewName $newName -Force
                Write-Host "Renamed MSI installer to $newName"
            }
        }
    }
    
    Remove-Item $tempConfigPath -Force
}

# Build Portuguese
Build-Language -LangCode "pt-BR" -ConfigName "tauri.conf.pt.json"

# Build English
Build-Language -LangCode "en-US" -ConfigName "tauri.conf.en.json"

Write-Host "Localized builds completed successfully!"
