param([switch]$BuildOnly)

# scripts/build-and-install-android.ps1
$ErrorActionPreference = "Stop"

$appDir = $PSScriptRoot | Split-Path
Set-Location $appDir

# 1. Setup Environment
$env:JAVA_HOME = "C:\Users\Atho\.jdks\jbr-21.0.11"
$env:ANDROID_HOME = "C:\Users\Atho\AppData\Local\Android\Sdk"
$env:NDK_HOME = "C:\Users\Atho\AppData\Local\Android\Sdk\ndk\27.3.13750724"
$env:ANDROID_NDK_HOME = $env:NDK_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

Write-Host "=== Step 0: Stopping Gradle daemons & cleaning build cache ===" -ForegroundColor Cyan
if (Test-Path "src-tauri/gen/android/gradlew.bat") {
    Push-Location "src-tauri/gen/android"
    try {
        & ".\gradlew.bat" --stop
    } catch {
        Write-Warning "Could not stop Gradle daemon gracefully: $_"
    }
    Pop-Location
}

# Remove any old APKs to prevent stale deployment
$apkOutputDir = "src-tauri/gen/android/app/build/outputs/apk"
if (Test-Path $apkOutputDir) {
    Write-Host "Removing old APK output directory: $apkOutputDir" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $apkOutputDir -ErrorAction SilentlyContinue
}

Write-Host "=== Step 1: Building frontend (tsc && vite build) ===" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    throw "Frontend build failed with exit code $LASTEXITCODE"
}

Write-Host "=== Step 2: Patching Android overlay ===" -ForegroundColor Cyan
node scripts/patch-android-overlay.mjs
if ($LASTEXITCODE -ne 0) {
    throw "Patch Android overlay failed with exit code $LASTEXITCODE"
}

Write-Host "=== Step 3: Building Android APK with Tauri (aarch64) ===" -ForegroundColor Cyan
npx tauri android build --target aarch64 --apk
if ($LASTEXITCODE -ne 0) {
    throw "Tauri Android build failed with exit code $LASTEXITCODE"
}

Write-Host "=== Step 4: Locating newly built APK ===" -ForegroundColor Cyan
$apkFiles = Get-ChildItem -Recurse -Path $apkOutputDir -Filter "*.apk" | Where-Object { $_.FullName -notmatch "-signed\.apk" -and $_.FullName -notmatch "-aligned\.apk" }
if (-not $apkFiles) {
    throw "APK tidak ditemukan di $apkOutputDir!"
}

$rawApk = $apkFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Found APK: $($rawApk.FullName)" -ForegroundColor Green

$zipalign = "C:\Users\Atho\AppData\Local\Android\Sdk\build-tools\35.0.0\zipalign.exe"
$apksigner = "C:\Users\Atho\AppData\Local\Android\Sdk\build-tools\35.0.0\apksigner.bat"
$credentialsFile = Join-Path $appDir "release-keystore-credentials.txt"
$keystore = Join-Path $appDir "release.jks"

$storePass = $env:ANDROID_KEYSTORE_PASSWORD
if (-not $storePass -and (Test-Path $credentialsFile)) {
    $content = Get-Content $credentialsFile -Raw
    if ($content -match 'storePassword\s*=\s*([^\r\n]+)') {
        $storePass = $matches[1].Trim()
    }
}
$keyAlias = "copastool"
$keyPass = if ($env:ANDROID_KEY_PASSWORD) { $env:ANDROID_KEY_PASSWORD } else { $storePass }

if (-not $storePass) {
    throw "Password keystore tidak ditemukan. Pastikan release-keystore-credentials.txt ada atau set env ANDROID_KEYSTORE_PASSWORD."
}

if (-not (Test-Path $keystore)) {
    throw "Keystore tidak ditemukan di $keystore!"
}

New-Item -ItemType Directory -Force -Path "signed-apk" | Out-Null
$alignedApk = Join-Path $appDir "signed-apk\app-release-aligned.apk"
$signedApk = Join-Path $appDir "signed-apk\CopasTool-release-signed.apk"

Remove-Item $alignedApk -ErrorAction SilentlyContinue
Remove-Item $signedApk -ErrorAction SilentlyContinue

Write-Host "=== Step 5: Running zipalign ===" -ForegroundColor Cyan
& $zipalign -v -p 4 $rawApk.FullName $alignedApk
if ($LASTEXITCODE -ne 0) {
    throw "zipalign failed with exit code $LASTEXITCODE"
}

Write-Host "=== Step 6: Signing with release.jks ($keyAlias) ===" -ForegroundColor Cyan
& $apksigner sign --ks $keystore --ks-pass "pass:$storePass" --ks-key-alias $keyAlias --key-pass "pass:$keyPass" --out $signedApk $alignedApk
if ($LASTEXITCODE -ne 0) {
    throw "apksigner failed with exit code $LASTEXITCODE"
}

Write-Host "=== Step 7: Verifying signature ===" -ForegroundColor Cyan
& $apksigner verify --verbose $signedApk
if ($LASTEXITCODE -ne 0) {
    throw "apksigner verify failed with exit code $LASTEXITCODE"
}

Remove-Item $alignedApk -ErrorAction SilentlyContinue
Write-Host "Signed APK created: $signedApk" -ForegroundColor Green

if ($BuildOnly) {
    Write-Host "BuildOnly selected; leaving the phone untouched." -ForegroundColor Cyan
    exit 0
}

Write-Host "=== Step 8: Installing to Android device via ADB ===" -ForegroundColor Cyan
$devs = @((adb devices) | Where-Object { $_ -match "`tdevice$" } | ForEach-Object { ($_ -split "`t")[0] })
$adbTarget = if ($devs.Count -gt 0) { $devs[0] } else { $null }

if ($adbTarget) {
    Write-Host "Target device: $adbTarget" -ForegroundColor Green
    adb -s $adbTarget install -r -d $signedApk
    if ($LASTEXITCODE -ne 0) {
        throw "adb install failed with exit code $LASTEXITCODE"
    }

    Write-Host "=== Step 9: Launching app on device ===" -ForegroundColor Cyan
    adb -s $adbTarget shell monkey -p com.copastool.app -c android.intent.category.LAUNCHER 1

    Write-Host "=== Success! CopasTool has been built, signed, installed, and launched successfully ===" -ForegroundColor Green
} else {
    Write-Warning "No connected ADB device found. APK was signed successfully at: $signedApk"
}
